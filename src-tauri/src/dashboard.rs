//! The server dashboard: each app's switches. Laravel maintenance mode
//! (`artisan down` / `up`) and nginx basic auth, on or off.
//!
//! Basic auth goes where the vhost already keeps it:
//! - `auth_basic $var` with a `map $host $var { … }` (one vhost, a line per
//!   host): the app's host line is added to / taken out of that map (the one
//!   nginx uses: the last one loaded), and the login file's map likewise.
//! - Nothing yet: Kemudi's own lines in the app's server block, between
//!   `# kemudi:auth begin` / `end`. A vhost shared by many apps (a wildcard
//!   root like /opt/www/$app/public) gets one block that picks per app with
//!   `if ($app = "x")`.
//! - A literal `auth_basic` written by hand: left alone.
//!
//! Logins are htpasswd files: Kemudi's own (/etc/nginx/kemudi-auth/<app id>)
//! or one already on the server. Every change is `nginx -t`-checked and put
//! back if that fails; nginx is reloaded only when it passes. Passwords are
//! hashed here (apr1, by the Mac's openssl) and never leave this Mac.

use std::io::{Read, Write};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::actions::render::shell_quote;
use crate::config::schema::{App, Server};
use crate::error::{AppError, AppResult};
use crate::remote_files::{base64_body, errors, lookup, saved_sudo, sha_hex, sudo_prelude, NO_SUDO};
use crate::AppState;

const AUTH_DIR: &str = "/etc/nginx/kemudi-auth";
const BEGIN: &str = "# kemudi:auth begin";
const END: &str = "# kemudi:auth end";
const REALM: &str = "Restricted";

// ------------------------------------------------------------------ results

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    /// How Kemudi gets root: "root", "ok", "none", "badpw" or "needpw".
    pub sudo: String,
    pub nginx: bool,
    pub apps: Vec<AppSwitches>,
    /// The username of the default basic auth login (Passwords), if set.
    pub default_user: Option<String>,
    /// htpasswd files on the server (Kemudi's and ones the vhosts name).
    pub logins: Vec<LoginFile>,
    /// Config files only root can read (and sudo isn't available).
    pub denied: Vec<String>,
    /// About the vhosts themselves (once, not per app): a map defined twice,
    /// basic auth only in a location.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginFile {
    pub path: String,
    /// Its first few users.
    pub users: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSwitches {
    pub app_id: String,
    /// There's an `artisan` (in the path, or its `current/`).
    pub laravel: bool,
    /// In maintenance mode (`storage/framework/down`).
    pub down: bool,
    /// `artisan down --secret`: visiting <url>/<secret> lets you in.
    pub secret: Option<String>,
    pub auth: Auth,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Auth {
    /// "on", "off", "partial" (some of its server blocks), "manual" (an
    /// `auth_basic` Kemudi can't switch), "novhost", or "nourl" (its vhost
    /// switches by host, and the app has no URL).
    pub state: String,
    /// "map" (the vhost's `map $host`) or "kemudi" (Kemudi's own lines).
    pub mode: String,
    /// The login file in use (on), or Kemudi's file for it (off, if any).
    pub file: Option<String>,
    /// The login file is set in the vhost itself (can't be picked).
    pub fixed_file: bool,
    /// The vhost files that serve the app.
    pub files: Vec<String>,
    /// A vhost shared with other apps (wildcard root): per app still.
    pub shared: bool,
    /// The app's host (the map key).
    pub host: Option<String>,
    /// Where the switch is: "map $auth_required in staging.example.com".
    pub via: Option<String>,
    /// Things worth knowing about this app's switch.
    pub notes: Vec<String>,
    /// About its vhost (the dashboard shows these once).
    #[serde(skip)]
    vhost_notes: Vec<String>,
}

// ------------------------------------------------------------ nginx parsing

/// A `server { … }` block: line numbers (0-based) of its `{` and `}`.
#[derive(Debug, Clone, Default, PartialEq)]
struct Block {
    open: usize,
    close: usize,
    root: Option<String>,
    /// A literal `auth_basic` (not `off`) outside Kemudi's lines.
    manual: bool,
    /// `auth_basic $var` (outside Kemudi's lines): the variable.
    realm_var: Option<String>,
    /// `auth_basic_user_file $var` / a path, next to it.
    file_var: Option<String>,
    file_path: Option<String>,
    /// That `auth_basic` is in a location, not on the server itself.
    in_location: bool,
    /// Kemudi's begin / end marker lines in it.
    region: Option<(usize, usize)>,
    /// Its `server_name`s.
    names: Vec<String>,
}

/// A `map <source> $var { key value; … }`.
#[derive(Debug, Clone, PartialEq)]
struct MapDef {
    source: String,
    var: String,
    open: usize,
    close: usize,
    /// (key, value, line); `default` is a key too.
    entries: Vec<(String, String, usize)>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Parsed {
    blocks: Vec<Block>,
    maps: Vec<MapDef>,
}

fn is_begin(l: &str) -> bool {
    l.trim_start().starts_with(BEGIN)
}

fn is_end(l: &str) -> bool {
    l.trim_start().starts_with(END)
}

/// `$name` / `${name}` → name.
fn var_name(w: &str) -> Option<String> {
    let v = w.strip_prefix('$')?;
    let v = v.strip_prefix('{').and_then(|v| v.strip_suffix('}')).unwrap_or(v);
    (!v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).then(|| v.to_string())
}

/// The server blocks and maps of an nginx file (comments and quotes
/// understood).
fn parse(text: &str) -> Parsed {
    // Kemudi's own lines: their auth_basic isn't the vhost's.
    let mut regions = Vec::new();
    let mut begin = None;
    for (i, l) in text.split('\n').enumerate() {
        if is_begin(l) {
            begin = Some(i);
        } else if is_end(l) {
            if let Some(b) = begin.take() {
                regions.push((b, i));
            }
        }
    }
    let managed = |line: usize| regions.iter().any(|&(b, e)| line > b && line < e);

    #[derive(Clone, Copy, PartialEq)]
    enum Frame {
        Server(usize),
        Map(usize),
        Other,
    }
    let mut out = Parsed::default();
    let mut stack: Vec<Frame> = Vec::new();
    let mut words: Vec<(String, usize)> = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut comment = false;
    let mut escaped = false;
    let mut line = 0usize;

    let flush = |word: &mut String, words: &mut Vec<(String, usize)>, line: usize| {
        if !word.is_empty() {
            words.push((std::mem::take(word), line));
        }
    };

    for c in text.chars() {
        if c == '\n' {
            comment = false;
        }
        if comment {
            continue;
        }
        if let Some(q) = quote {
            if escaped {
                escaped = false;
                word.push(c);
            } else if c == '\\' {
                escaped = true;
            } else if c == q {
                quote = None;
                // An empty "" is still a word.
                if word.is_empty() {
                    words.push((String::new(), line));
                }
            } else {
                word.push(c);
            }
            if c == '\n' {
                line += 1;
            }
            continue;
        }
        match c {
            '#' if word.is_empty() => comment = true,
            '"' | '\'' if word.is_empty() => quote = Some(c),
            '{' => {
                flush(&mut word, &mut words, line);
                let w: Vec<&str> = words.iter().map(|(w, _)| w.as_str()).collect();
                let frame = match w.as_slice() {
                    ["server"] => {
                        out.blocks.push(Block {
                            open: line,
                            close: line,
                            ..Block::default()
                        });
                        Frame::Server(out.blocks.len() - 1)
                    }
                    ["map", source, var] => match var_name(var) {
                        Some(var) => {
                            out.maps.push(MapDef {
                                source: source.to_string(),
                                var,
                                open: line,
                                close: line,
                                entries: Vec::new(),
                            });
                            Frame::Map(out.maps.len() - 1)
                        }
                        None => Frame::Other,
                    },
                    _ => Frame::Other,
                };
                stack.push(frame);
                words.clear();
            }
            ';' => {
                flush(&mut word, &mut words, line);
                let at = words.first().map(|(_, l)| *l).unwrap_or(line);
                let w: Vec<&str> = words.iter().map(|(w, _)| w.as_str()).collect();
                match stack.last() {
                    Some(Frame::Map(mi)) => {
                        if let [key, rest @ ..] = w.as_slice() {
                            out.maps[*mi].entries.push((key.to_string(), rest.join(" "), at));
                        }
                    }
                    _ => {
                        let server = stack.iter().rev().find_map(|f| match f {
                            Frame::Server(si) => Some(*si),
                            _ => None,
                        });
                        if let Some(si) = server {
                            let direct = stack.last() == Some(&Frame::Server(si));
                            let b = &mut out.blocks[si];
                            match w.as_slice() {
                                ["root", r, ..] if direct => b.root = Some(r.to_string()),
                                ["server_name", names @ ..] if direct => {
                                    b.names.extend(names.iter().map(|n| n.to_string()))
                                }
                                ["auth_basic", v, ..] if !managed(at) && *v != "off" => {
                                    match var_name(v) {
                                        Some(var) => b.realm_var = Some(var),
                                        None => b.manual = true,
                                    }
                                    b.in_location |= !direct;
                                }
                                ["auth_basic_user_file", v, ..] if !managed(at) => match var_name(v) {
                                    Some(var) => b.file_var = Some(var),
                                    None => b.file_path = Some(v.to_string()),
                                },
                                _ => {}
                            }
                        }
                    }
                }
                words.clear();
            }
            '}' => {
                flush(&mut word, &mut words, line);
                words.clear();
                match stack.pop() {
                    Some(Frame::Server(si)) => out.blocks[si].close = line,
                    Some(Frame::Map(mi)) => out.maps[mi].close = line,
                    _ => {}
                }
            }
            c if c.is_whitespace() => flush(&mut word, &mut words, line),
            c => word.push(c),
        }
        if c == '\n' {
            line += 1;
        }
    }
    for b in &mut out.blocks {
        b.region = regions
            .iter()
            .copied()
            .find(|&(s, e)| s > b.open && e < b.close);
    }
    out
}

/// How a server block's root serves an app.
#[derive(Debug, Clone, PartialEq)]
enum Serves {
    /// `root /opt/www/shop/public`
    Plain,
    /// `root /opt/www/$app/public`: this app when `$app` is `value`.
    Wild { var: String, value: String },
}

/// `$name` / `${name}` in a root: (start, end, name), if there's exactly one.
fn one_var(root: &str) -> Option<(usize, usize, String)> {
    if root.matches('$').count() != 1 {
        return None;
    }
    let start = root.find('$')?;
    let rest = &root[start + 1..];
    let (braced, body) = match rest.strip_prefix('{') {
        Some(b) => (true, b),
        None => (false, rest),
    };
    let name: String = body
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        return None;
    }
    let mut end = start + 1 + name.len();
    if braced {
        if !body[name.len()..].starts_with('}') {
            return None;
        }
        end += 2;
    }
    Some((start, end, name))
}

fn serves(root: &str, app_path: &str) -> Option<Serves> {
    let root = root.trim_end_matches('/');
    let path = app_path.trim().trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    let candidates = [
        format!("{path}/public"),
        format!("{path}/current/public"),
        path.to_string(),
    ];
    if !root.contains('$') {
        return candidates.iter().any(|c| c == root).then_some(Serves::Plain);
    }
    let (start, end, var) = one_var(root)?;
    let (prefix, suffix) = (&root[..start], &root[end..]);
    candidates.iter().find_map(|c| {
        let value = c.strip_prefix(prefix)?.strip_suffix(suffix)?;
        let ok = !value.is_empty()
            && value
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch));
        ok.then(|| Serves::Wild {
            var: var.clone(),
            value: value.to_string(),
        })
    })
}

// ------------------------------------------------- Kemudi's own auth lines

/// What Kemudi's lines in a block say.
#[derive(Debug, Clone, PartialEq)]
enum Region {
    /// Basic auth with this login file.
    Plain(String),
    /// Per app on a shared vhost: (value of the variable, login file).
    Wild(String, Vec<(String, String)>),
}

fn parse_region(lines: &[&str]) -> Option<Region> {
    let after = |l: &str, pat: &str| {
        l.split_once(pat)
            .map(|(_, r)| r.split(';').next().unwrap_or("").trim().to_string())
            .filter(|s| s.starts_with('/'))
    };
    let ifs: Vec<(String, String, String)> = lines
        .iter()
        .filter_map(|l| {
            // if ($app = "shop") { set … ; set $kemudi_auth_file /path; }
            let r = l.trim().strip_prefix("if ($")?;
            let (var, r) = r.split_once(" = \"")?;
            let (value, _) = r.split_once("\")")?;
            Some((var.to_string(), value.to_string(), after(l, "set $kemudi_auth_file ")?))
        })
        .collect();
    if let Some((var, _, _)) = ifs.first() {
        let var = var.clone();
        return Some(Region::Wild(
            var,
            ifs.into_iter().map(|(_, v, f)| (v, f)).collect(),
        ));
    }
    if lines.iter().any(|l| l.contains("$kemudi_auth")) {
        return Some(Region::Wild(String::new(), Vec::new()));
    }
    lines
        .iter()
        .find_map(|l| after(l, "auth_basic_user_file "))
        .map(Region::Plain)
}

fn render_region(indent: &str, region: &Region) -> Vec<String> {
    let mut out = Vec::new();
    match region {
        Region::Plain(file) => {
            out.push(format!("{indent}{BEGIN} · basic auth, set by Kemudi Devops"));
            out.push(format!("{indent}auth_basic \"{REALM}\";"));
            out.push(format!("{indent}auth_basic_user_file {file};"));
        }
        Region::Wild(var, entries) => {
            out.push(format!(
                "{indent}{BEGIN} · basic auth per app, set by Kemudi Devops"
            ));
            out.push(format!("{indent}set $kemudi_auth off;"));
            out.push(format!("{indent}set $kemudi_auth_file /dev/null;"));
            for (value, file) in entries {
                out.push(format!(
                    "{indent}if (${var} = \"{value}\") {{ set $kemudi_auth \"{REALM}\"; set $kemudi_auth_file {file}; }}"
                ));
            }
            out.push(format!("{indent}auth_basic $kemudi_auth;"));
            out.push(format!("{indent}auth_basic_user_file $kemudi_auth_file;"));
        }
    }
    out.push(format!("{indent}{END}"));
    out
}

/// The indent of the first line inside `open`..`close` (else 4 spaces).
fn indent_between(lines: &[&str], open: usize, close: usize) -> String {
    lines
        .iter()
        .take(close)
        .skip(open + 1)
        .find(|l| !l.trim().is_empty())
        .map(|l| l[..l.len() - l.trim_start().len()].to_string())
        .unwrap_or_else(|| "    ".into())
}

/// The login file if Kemudi's lines turn basic auth on for the app here.
fn block_on(lines: &[&str], b: &Block, how: &Serves) -> Option<String> {
    let (s, e) = b.region?;
    match (parse_region(&lines[s..=e])?, how) {
        (Region::Plain(file), Serves::Plain) => Some(file),
        (Region::Wild(_, entries), Serves::Wild { value, .. }) => entries
            .into_iter()
            .find(|(v, _)| v == value)
            .map(|(_, f)| f),
        _ => None,
    }
}

/// The app's blocks in a file: (block, how it serves the app).
fn app_blocks(parsed: &Parsed, app_path: &str) -> Vec<(Block, Serves)> {
    parsed
        .blocks
        .iter()
        .filter_map(|b| {
            let how = serves(b.root.as_deref()?, app_path)?;
            Some((b.clone(), how))
        })
        .collect()
}

/// The file with Kemudi's basic auth for the app on (with this login file)
/// or off; `None`: no change.
fn set_auth(text: &str, app_path: &str, file: Option<&str>) -> Result<Option<String>, String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut found = app_blocks(&parse(text), app_path);
    if found.iter().any(|(b, _)| b.manual || b.realm_var.is_some()) {
        return Err(
            "its vhost already has an auth_basic of its own: change that in the vhost (Inspect)"
                .into(),
        );
    }
    // Bottom up, so earlier line numbers stay right.
    found.sort_by_key(|(b, _)| std::cmp::Reverse(b.open));
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    let mut changed = false;
    for (b, how) in found {
        if b.close == b.open {
            return Err(format!(
                "its server block is on one line (line {}): split it over lines first",
                b.open + 1
            ));
        }
        let indent = indent_between(&lines, b.open, b.close);
        let old = b.region.and_then(|(s, e)| parse_region(&lines[s..=e]));
        let new = match how {
            Serves::Plain => file.map(|f| Region::Plain(f.to_string())),
            Serves::Wild { var, value } => {
                let mut entries = match old.clone() {
                    Some(Region::Wild(_, e)) => e,
                    _ => Vec::new(),
                };
                entries.retain(|(v, _)| *v != value);
                if let Some(f) = file {
                    entries.push((value, f.to_string()));
                    entries.sort();
                }
                (!entries.is_empty()).then_some(Region::Wild(var, entries))
            }
        };
        if new == old {
            continue;
        }
        changed = true;
        let rendered = new.map(|r| render_region(&indent, &r)).unwrap_or_default();
        match b.region {
            Some((s, e)) => {
                out.splice(s..=e, rendered);
            }
            None => {
                out.splice(b.open + 1..b.open + 1, rendered);
            }
        }
    }
    Ok(changed.then(|| out.join("\n")))
}

// ------------------------------------------------------- the vhost's maps

/// `https://App.example.com:8443/x` → `app.example.com`.
fn host_of(url: &str) -> Option<String> {
    let rest = url.trim().split_once("://").map_or(url.trim(), |(_, r)| r);
    let host = rest
        .split(['/', '?', '#'])
        .next()?
        .rsplit('@')
        .next()?
        .split(':')
        .next()?
        .to_ascii_lowercase();
    (!host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c)))
    .then_some(host)
}

/// The value for a host: its own line, else `default`.
fn map_value<'a>(m: &'a MapDef, host: &str) -> Option<&'a str> {
    let get = |k: &str| {
        m.entries
            .iter()
            .rev()
            .find(|(key, _, _)| key.eq_ignore_ascii_case(k))
            .map(|(_, v, _)| v.as_str())
    };
    get(host).or_else(|| get("default"))
}

fn quote_value(v: &str) -> String {
    if v.is_empty() || v.chars().any(|c| c.is_whitespace() || "\";{}'#".contains(c)) {
        format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        v.to_string()
    }
}

/// The file with the last `map … $var` in it given a line for `host` (its
/// old lines taken out first); `None`: only take them out.
fn set_map_entry(text: &str, var: &str, host: &str, value: Option<&str>) -> Result<String, String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let parsed = parse(text);
    let m = parsed
        .maps
        .iter()
        .rev()
        .find(|m| m.var == var)
        .ok_or_else(|| format!("no map for ${var} here"))?;
    if m.close == m.open {
        return Err(format!("the ${var} map is on one line (line {}): split it over lines first", m.open + 1));
    }
    let mut drop = Vec::new();
    for (key, _, line) in &m.entries {
        if key.eq_ignore_ascii_case(host) {
            let l = lines[*line].trim_start();
            let starts = l.starts_with(key.as_str()) || l.starts_with(&format!("\"{key}\""));
            let only = starts && lines[*line].matches(';').count() == 1;
            if !only || *line == m.open || *line == m.close {
                return Err(format!(
                    "line {} of the ${var} map has more than {host} on it: change that one by hand",
                    line + 1
                ));
            }
            drop.push(*line);
        }
    }
    let indent = indent_between(&lines, m.open, m.close);
    // Before `default` when it has a line of its own, else before the `}`.
    let default_line = m
        .entries
        .iter()
        .find(|(k, _, l)| k == "default" && *l > m.open && *l < m.close)
        .map(|(_, _, l)| *l);
    let at = default_line.unwrap_or(m.close);
    let mut out: Vec<String> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if i == at {
            if let Some(v) = value {
                out.push(format!("{indent}{host} {};", quote_value(v)));
            }
        }
        if !drop.contains(&i) {
            out.push(l.to_string());
        }
    }
    Ok(out.join("\n"))
}

/// A host from a `server_name`: a plain name, or a regex with the app's
/// value put in its named group (`~^(?<sub>[^.]+)\.staging\.example\.com$`).
fn host_from_name(name: &str, wild: Option<(&str, &str)>) -> Option<String> {
    let host = match name.strip_prefix('~') {
        None => name.to_string(),
        Some(re) => {
            let (var, value) = wild?;
            let re = re.trim_start_matches('^').trim_end_matches('$');
            let start = re
                .find(&format!("(?<{var}>"))
                .or_else(|| re.find(&format!("(?P<{var}>")))?;
            // The group's end: its matching `)`.
            let mut depth = 0;
            let mut end = None;
            for (i, c) in re[start..].char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = Some(start + i + 1);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let rest = format!("{}{value}{}", &re[..start], &re[end?..]);
            rest.replace("\\.", ".")
        }
    };
    host_of(&host).filter(|h| h.contains('.') && !h.starts_with('.'))
}

/// The app's host: from its URL, else its vhost's server_name.
fn app_host(vh: &Vhosts, app: &App) -> Option<String> {
    if let Some(h) = app.url.as_deref().and_then(host_of) {
        return Some(h);
    }
    vh.iter()
        .flat_map(|(_, _, p)| app_blocks(p, &app.path))
        .find_map(|(b, how)| {
            let wild = match &how {
                Serves::Wild { var, value } => Some((var.as_str(), value.as_str())),
                Serves::Plain => None,
            };
            b.names
                .iter()
                .filter(|n| *n != "_")
                .find_map(|n| host_from_name(n, wild))
        })
}

// ------------------------------------------------------------------ status

/// A config file as read: (listed path, content), or denied.
#[derive(Debug, Clone, PartialEq)]
enum Conf {
    File(String, String),
    Denied(String),
}

fn status_script(server: &Server, password: Option<&str>) -> String {
    let mut apps = String::new();
    for a in &server.apps {
        apps.push_str(&format!(
            "app {} {}\n",
            shell_quote(&a.id),
            shell_quote(a.path.trim().trim_end_matches('/'))
        ));
    }
    let pins: Vec<String> = server
        .apps
        .iter()
        .flat_map(|a| a.vhost_files.iter())
        .map(|f| shell_quote(f))
        .collect();
    // Files in nginx's load order (conf.d, then sites-enabled): the last
    // `map` of a variable is the one that counts.
    format!(
        r#"export LC_ALL=C
{prelude}[ "$(id -u)" = 0 ] && SU=""
rd() {{ cat -- "$1" 2>/dev/null || {{ [ -n "$SU" ] && $SU cat -- "$1" 2>/dev/null; }}; }}
ex() {{ [ -e "$1" ] || {{ [ -n "$SU" ] && $SU test -e "$1"; }}; }}
if [ "$(id -u)" = 0 ]; then echo "@@sudo root"; elif [ -n "$SU" ]; then echo "@@sudo ok"; elif [ -n "$NOSUDO" ]; then echo "@@sudo none"; elif [ -n "$BADPW" ]; then echo "@@sudo badpw"; else echo "@@sudo needpw"; fi
[ -d /etc/nginx ] && echo "@@nginx"
app() {{
  echo "@@app $1"
  P=$2; [ -f "$P/artisan" ] || {{ [ -f "$P/current/artisan" ] && P="$P/current"; }}
  [ -f "$P/artisan" ] && echo "laravel"
  if ex "$P/storage/framework/down"; then echo "down $(rd "$P/storage/framework/down" | tr -d '\n' | head -c 4000)"; fi
}}
{apps}echo "@@vhosts"
seen=" "
for f in /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* {pins}; do
  [ -f "$f" ] || continue
  case "$seen" in *" $f "*) continue ;; esac
  seen="$seen$f "
  if rd "$f" >/dev/null; then echo "@file $f"; rd "$f"; echo; echo "@@eof"; else echo "@denied $f"; fi
done
echo "@@logins"
PW=$( (for f in {auth}/*; do [ -e "$f" ] && echo "$f"; done; for f in $seen; do rd "$f"; done | grep -oE '/[^[:space:];"$]*passw[^[:space:];"$]*') | grep -vx /etc/passwd | sort -u)
for p in $PW; do ex "$p" && echo "@pw $p $(rd "$p" | grep -v '^#' | cut -d: -f1 | grep . | head -5 | paste -sd, -)"; done
echo "@@end"
"#,
        prelude = sudo_prelude(password),
        auth = AUTH_DIR,
        pins = pins.join(" "),
    )
}

struct Status {
    sudo: String,
    nginx: bool,
    /// (app id, laravel, down file's JSON)
    apps: Vec<(String, bool, Option<String>)>,
    files: Vec<Conf>,
    logins: Vec<LoginFile>,
}

fn parse_status(out: &str) -> AppResult<Status> {
    errors(out.split("\n@@vhosts").next().unwrap_or(out))?;
    if !out.lines().any(|l| l == "@@end") {
        return Err(AppError::Invalid("no answer from the server".into()));
    }
    let (head, rest) = out.split_once("\n@@vhosts\n").unwrap_or((out, ""));
    let (vhosts, logins) = rest.rsplit_once("@@logins\n").unwrap_or((rest, ""));
    let mut s = Status {
        sudo: String::new(),
        nginx: false,
        apps: Vec::new(),
        files: Vec::new(),
        logins: Vec::new(),
    };
    for l in head.lines() {
        if let Some(v) = l.strip_prefix("@@sudo ") {
            s.sudo = v.trim().to_string();
        } else if l == "@@nginx" {
            s.nginx = true;
        } else if let Some(id) = l.strip_prefix("@@app ") {
            s.apps.push((id.to_string(), false, None));
        } else if let Some(a) = s.apps.last_mut() {
            if l == "laravel" {
                a.1 = true;
            } else if let Some(j) = l.strip_prefix("down") {
                a.2 = Some(j.trim().to_string());
            }
        }
    }
    let mut rest = vhosts;
    while !rest.is_empty() {
        let (line, after) = rest.split_once('\n').unwrap_or((rest, ""));
        if let Some(f) = line.strip_prefix("@file ") {
            // Content, then the newline `echo` added, then @@eof.
            let (body, next) = after.split_once("\n@@eof\n").unwrap_or((after, ""));
            s.files.push(Conf::File(f.to_string(), body.to_string()));
            rest = next;
        } else {
            if let Some(f) = line.strip_prefix("@denied ") {
                s.files.push(Conf::Denied(f.to_string()));
            }
            rest = after;
        }
    }
    for l in logins.lines() {
        if let Some(r) = l.strip_prefix("@pw ") {
            let (path, users) = r.split_once(' ').unwrap_or((r, ""));
            s.logins.push(LoginFile {
                path: path.to_string(),
                users: users
                    .split(',')
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty())
                    .collect(),
            });
        }
    }
    Ok(s)
}

/// `{"secret": "…"}` from Laravel's down file.
fn secret_of(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("secret")?.as_str().map(str::to_string).filter(|s| !s.is_empty())
}

fn base(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn own_file(app_id: &str) -> String {
    format!("{AUTH_DIR}/{app_id}")
}

/// Parsed vhosts, in load order: (path, text, parsed).
type Vhosts = Vec<(String, String, Parsed)>;

fn vhosts(files: &[Conf]) -> Vhosts {
    files
        .iter()
        .filter_map(|r| match r {
            Conf::File(p, t) => Some((p.clone(), t.clone(), parse(t))),
            Conf::Denied(_) => None,
        })
        .collect()
}

/// The map nginx uses for `$var`: the last one loaded. (file index, map,
/// how many files define it).
fn effective_map<'a>(vh: &'a Vhosts, var: &str) -> Option<(usize, &'a MapDef, usize)> {
    let defs: Vec<(usize, &MapDef)> = vh
        .iter()
        .enumerate()
        .flat_map(|(i, (_, _, p))| p.maps.iter().filter(|m| m.var == var).map(move |m| (i, m)))
        .collect();
    let n = defs.iter().map(|(i, _)| *i).collect::<std::collections::BTreeSet<_>>().len();
    defs.last().map(|(i, m)| (*i, *m, n))
}

/// How the app's basic auth is switched, worked out from its vhosts.
#[derive(Debug, Clone, PartialEq)]
enum Plan {
    /// `auth_basic $realm` from a `map $host`: (realm var, file var or the
    /// fixed file path).
    Map {
        realm: String,
        file: Result<String, String>,
    },
    Kemudi,
    Manual(String),
    NoVhost,
}

fn plan_of(vh: &Vhosts, app: &App) -> Plan {
    let found: Vec<(Block, Serves)> = vh
        .iter()
        .flat_map(|(_, _, p)| app_blocks(p, &app.path))
        .collect();
    if found.is_empty() {
        return Plan::NoVhost;
    }
    if found.iter().any(|(b, _)| b.manual) {
        return Plan::Manual("its vhost has an auth_basic written by hand: change it there (Inspect)".into());
    }
    let Some((b, _)) = found.iter().find(|(b, _)| b.realm_var.is_some()) else {
        return Plan::Kemudi;
    };
    let realm = b.realm_var.clone().unwrap_or_default();
    let by_host = |var: &str| {
        effective_map(vh, var).is_some_and(|(_, m, _)| m.source == "$host" || m.source == "$http_host")
    };
    if !by_host(&realm) {
        return Plan::Manual(format!(
            "its vhost uses auth_basic ${realm}, which isn't a map by $host: change it there (Inspect)"
        ));
    }
    let file = match (&b.file_var, &b.file_path) {
        (Some(v), _) if by_host(v) => Ok(v.clone()),
        (Some(v), _) => {
            return Plan::Manual(format!(
                "its vhost uses auth_basic_user_file ${v}, which isn't a map by $host"
            ))
        }
        (None, Some(p)) => Err(p.clone()),
        (None, None) => return Plan::Manual("its vhost has auth_basic without a user file".into()),
    };
    Plan::Map { realm, file }
}

fn auth_of(vh: &Vhosts, app: &App) -> Auth {
    let mut auth = Auth::default();
    for (path, _, p) in vh {
        let found = app_blocks(p, &app.path);
        if !found.is_empty() {
            auth.files.push(path.clone());
        }
        auth.shared |= found.iter().any(|(_, how)| matches!(how, Serves::Wild { .. }));
    }
    match plan_of(vh, app) {
        Plan::NoVhost => auth.state = "novhost".into(),
        Plan::Manual(why) => {
            auth.state = "manual".into();
            auth.notes.push(why);
        }
        Plan::Map { realm, file } => {
            auth.mode = "map".into();
            let Some((fi, m, n)) = effective_map(vh, &realm) else {
                auth.state = "manual".into();
                return auth;
            };
            auth.via = Some(format!("map ${realm} in {}", base(&vh[fi].0)));
            if n > 1 {
                auth.vhost_notes.push(format!(
                    "${realm} is mapped in {n} files; nginx uses only the last one loaded ({}), so the others' lines do nothing",
                    base(&vh[fi].0)
                ));
            }
            let in_location = vh
                .iter()
                .flat_map(|(_, _, p)| app_blocks(p, &app.path))
                .any(|(b, _)| b.realm_var.is_some() && b.in_location);
            if in_location {
                auth.vhost_notes.push(
                    format!("{}: basic auth is set in a location (like location /), so other locations (like /index.php) skip the login", base(&vh[fi].0)),
                );
            }
            let Some(host) = app_host(vh, app) else {
                auth.state = "nourl".into();
                auth.notes.push(format!("set the app's URL: its host is the key in the ${realm} map"));
                return auth;
            };
            let on = map_value(m, &host).is_some_and(|v| v != "off" && !v.is_empty());
            auth.state = if on { "on" } else { "off" }.into();
            auth.file = match &file {
                Ok(fv) => effective_map(vh, fv)
                    .and_then(|(_, fm, _)| map_value(fm, &host))
                    .filter(|v| v.starts_with('/'))
                    .map(str::to_string),
                Err(p) => Some(p.clone()),
            };
            auth.fixed_file = file.is_err();
            auth.host = Some(host);
        }
        Plan::Kemudi => {
            auth.mode = "kemudi".into();
            let (mut on, mut off) = (0, 0);
            for (_, text, p) in vh {
                let lines: Vec<&str> = text.split('\n').collect();
                for (b, how) in app_blocks(p, &app.path) {
                    match block_on(&lines, &b, &how) {
                        Some(f) => {
                            on += 1;
                            auth.file = Some(f);
                        }
                        None => off += 1,
                    }
                }
            }
            auth.state = match (on, off) {
                (0, _) => "off",
                (_, 0) => "on",
                _ => "partial",
            }
            .into();
        }
    }
    auth
}

fn dashboard_of(server: &Server, s: Status, default_user: Option<String>) -> Dashboard {
    let vh = vhosts(&s.files);
    let mut notes: Vec<String> = Vec::new();
    let apps = server
        .apps
        .iter()
        .map(|a| {
            let (_, laravel, down) = s
                .apps
                .iter()
                .find(|x| x.0 == a.id)
                .cloned()
                .unwrap_or_default();
            let mut auth = auth_of(&vh, a);
            for n in std::mem::take(&mut auth.vhost_notes) {
                if !notes.contains(&n) {
                    notes.push(n);
                }
            }
            // Off: Kemudi's file from before (for "Keep").
            if auth.file.is_none() && s.logins.iter().any(|l| l.path == own_file(&a.id)) {
                auth.file = Some(own_file(&a.id));
            }
            AppSwitches {
                app_id: a.id.clone(),
                laravel,
                down: down.is_some(),
                secret: down.as_deref().and_then(secret_of),
                auth,
            }
        })
        .collect();
    Dashboard {
        sudo: s.sudo,
        nginx: s.nginx,
        apps,
        default_user,
        logins: s.logins,
        notes,
        denied: s
            .files
            .iter()
            .filter_map(|r| match r {
                Conf::Denied(f) => Some(f.clone()),
                Conf::File(..) => None,
            })
            .collect(),
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?
        .map_err(AppError::Invalid)
}

async fn read_status(state: &AppState, server: &Server) -> AppResult<Status> {
    let password = saved_sudo(&server.id).await;
    let out = crate::monitor::run(state, &server.id, &status_script(server, password.as_deref())).await?;
    parse_status(&out)
}

/// Every app's switches on a server (read-only).
#[tauri::command]
pub async fn dashboard_status(state: State<'_, AppState>, server_id: String) -> AppResult<Dashboard> {
    let server = lookup(&state, &server_id)?;
    let status = read_status(&state, &server).await?;
    let default_user = blocking(crate::vault::basic_auth_default)
        .await
        .ok()
        .flatten()
        .map(|(u, _)| u);
    Ok(dashboard_of(&server, status, default_user))
}

// ------------------------------------------------------------- maintenance

fn app_of<'a>(server: &'a Server, app_id: &str) -> AppResult<&'a App> {
    server
        .app(app_id)
        .ok_or_else(|| AppError::NotFound(format!("app `{app_id}` isn't on {}", server.id)))
}

fn valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        && !id.starts_with('.')
}

/// `artisan down` / `up` as the owner of storage/ (like Queues).
fn maintenance_script(path: &str, php: &str, down: bool, secret: Option<&str>, password: Option<&str>) -> String {
    let cmd = match (down, secret) {
        (true, Some(s)) => format!(
            r#"out=$($RU "$PHP" artisan down --no-interaction --secret={s} 2>&1); rc=$?
case "$out" in *secret*"does not exist"*) echo "@@nosecret"; out=$($RU "$PHP" artisan down --no-interaction 2>&1); rc=$? ;; esac"#,
            s = shell_quote(s)
        ),
        (true, None) => r#"out=$($RU "$PHP" artisan down --no-interaction 2>&1); rc=$?"#.to_string(),
        (false, _) => r#"out=$($RU "$PHP" artisan up --no-interaction 2>&1); rc=$?"#.to_string(),
    };
    format!(
        r#"export LC_ALL=C
{prelude}P={p}
[ -f "$P/artisan" ] || {{ [ -f "$P/current/artisan" ] && P="$P/current"; }}
cd "$P" 2>/dev/null || {{ echo "@@err $P doesn't exist"; exit 0; }}
[ -f artisan ] || {{ echo "@@err $P isn't a Laravel app (no artisan)"; exit 0; }}
PHP={php}
command -v "$PHP" >/dev/null 2>&1 || PHP=php
OWN=$(stat -c %U storage 2>/dev/null || stat -c %U .)
ME=$(id -un)
RU=""
if [ "$ME" != "$OWN" ]; then
  if [ "$ME" = root ]; then
    if command -v runuser >/dev/null 2>&1; then RU="runuser -u $OWN --"; else RU="sudo -n -u $OWN"; fi
  elif [ -n "$SU" ]; then RU="$SU -u $OWN"
  fi
fi
{cmd}
printf '%s\n' "$out" | tail -20
echo "@@rc $rc"
"#,
        prelude = sudo_prelude(password),
        p = shell_quote(path.trim().trim_end_matches('/')),
        php = shell_quote(php),
    )
}

/// A random hex string from the system's random source.
fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("no random source: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn audit<T>(
    state: &AppState,
    server: &Server,
    app: &App,
    action_id: &str,
    label: &str,
    result: &AppResult<T>,
) {
    if let Ok(log) = state.audit.as_ref() {
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: Some(&app.id),
            action_id,
            label,
            env: app.env.as_str(),
            kind: "edit",
            command: label,
            edited: false,
        }) {
            let _ = log.finish(row, Some(i32::from(result.is_err())));
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Maintenance {
    /// artisan's output.
    pub output: String,
    /// The bypass secret (when going down with one).
    pub secret: Option<String>,
}

fn parse_maintenance(out: &str, secret: Option<String>) -> AppResult<Maintenance> {
    errors(out)?;
    let rc = out
        .lines()
        .find_map(|l| l.strip_prefix("@@rc "))
        .ok_or_else(|| AppError::Invalid("no answer from the server".into()))?;
    let output = out
        .lines()
        .filter(|l| !l.starts_with("@@"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if rc.trim() != "0" {
        return Err(AppError::Invalid(if output.is_empty() {
            format!("artisan failed (exit {rc})")
        } else {
            output
        }));
    }
    let secret = secret.filter(|_| !out.lines().any(|l| l == "@@nosecret"));
    Ok(Maintenance { output, secret })
}

/// Maintenance mode on (`artisan down`, optionally with a bypass secret) or
/// off (`artisan up`).
#[tauri::command]
pub async fn dashboard_maintenance(
    state: State<'_, AppState>,
    server_id: String,
    app_id: String,
    down: bool,
    with_secret: bool,
) -> AppResult<Maintenance> {
    let server = lookup(&state, &server_id)?;
    let app = app_of(&server, &app_id)?.clone();
    let php = app
        .php
        .as_deref()
        .and_then(crate::queues::php_binary)
        .unwrap_or_else(|| "php".into());
    let secret = if down && with_secret {
        Some(random_hex(12).map_err(AppError::Invalid)?)
    } else {
        None
    };
    let password = saved_sudo(&server_id).await;
    let script = maintenance_script(&app.path, &php, down, secret.as_deref(), password.as_deref());
    let result = crate::monitor::run_all(&state, &server_id, &script)
        .await
        .and_then(|out| parse_maintenance(&out, secret));
    let label = if down { "Maintenance mode on (artisan down)" } else { "Maintenance mode off (artisan up)" };
    audit(&state, &server, &app, "dash:maintenance", label, &result);
    result
}

// --------------------------------------------------------------- basic auth

/// Which login turning basic auth on uses.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Login {
    /// Kemudi's file for the app, as it is (from before).
    Keep,
    /// The default login in Passwords.
    Default,
    /// Typed now; `save` also keeps it in Passwords.
    #[serde(rename_all = "camelCase")]
    Own {
        username: String,
        password: String,
        save: bool,
    },
    /// An htpasswd file already on the server (one the dashboard listed).
    File { path: String },
}

fn valid_user(u: &str) -> bool {
    !u.is_empty()
        && u.len() <= 64
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._@-".contains(c))
}

/// An apr1 hash (what `htpasswd -m` writes), by the Mac's openssl, the
/// password on its stdin.
fn apr1(password: &str) -> Result<String, String> {
    if password.is_empty() || password.contains(['\n', '\r', '\0']) {
        return Err("a password can't be empty or have line breaks".into());
    }
    let bin = if std::path::Path::new("/usr/bin/openssl").exists() {
        "/usr/bin/openssl"
    } else {
        "openssl"
    };
    let mut child = Command::new(bin)
        .args(["passwd", "-apr1", "-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run openssl: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("couldn't talk to openssl")?
        .write_all(format!("{password}\n").as_bytes())
        .map_err(|e| format!("couldn't talk to openssl: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("openssl failed: {e}"))?;
    let hash = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || !hash.starts_with("$apr1$") || hash.contains(char::is_whitespace) {
        return Err(format!(
            "openssl couldn't hash the password: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(hash)
}

/// One changed vhost: (listed path, sha of what was read, new content).
type Change = (String, String, String);

/// Write the login file (if any) and the vhosts, `nginx -t`, and reload; put
/// everything back if the test fails.
fn apply_script(app_id: &str, htpasswd: Option<&str>, changes: &[Change], password: Option<&str>) -> String {
    let mut s = format!(
        r#"export LC_ALL=C
{prelude}if [ "$(id -u)" = 0 ]; then S=""; elif [ -n "$SU" ]; then S="$SU"; else echo "@@err can't change nginx: {NO_SUDO}"; exit 0; fi
if ! $S nginx -t >/dev/null 2>&1; then echo "@@err nginx -t already fails on this server: fix that first (Health, or the vhost in Inspect)"; exit 0; fi
B="$HOME/.kemudi-backups"
mkdir -p "$B" && chmod 700 "$B" || {{ echo "@@err couldn't make $B"; exit 0; }}
T=$(printf '\t')
L="$B/.dashboard-$$"; : > "$L"
undo() {{ while IFS="$T" read -r f b; do if [ -n "$b" ]; then $S cp -p "$b" "$f"; else $S rm -f "$f"; fi; done < "$L"; rm -f "$L"; }}
stamp=$(date +%Y%m%d-%H%M%S)
"#,
        prelude = sudo_prelude(password),
    );
    if let Some(line) = htpasswd {
        s.push_str(&format!(
            r#"H={auth}/{id}
$S mkdir -p {auth} && $S chmod 755 {auth} || {{ undo; echo "@@err couldn't make {auth}"; exit 0; }}
hb=""
if $S test -e "$H"; then hb="$B/kemudi-auth-{id}.$stamp"; $S cp -p "$H" "$hb" || {{ undo; echo "@@err couldn't back up $H"; exit 0; }}; fi
printf '%s\t%s\n' "$H" "$hb" >> "$L"
printf '%s\n' {line} | $S tee "$H.tmp" >/dev/null || {{ undo; echo "@@err couldn't write $H"; exit 0; }}
# nginx's workers read it: their user from nginx.conf, else ps, else www-data.
W=$(sed -n 's/^[[:space:]]*user[[:space:]][[:space:]]*\([^;[:space:]]*\).*/\1/p' /etc/nginx/nginx.conf 2>/dev/null | head -1)
[ -n "$W" ] || W=$(ps -o user= -C nginx 2>/dev/null | grep -v '^root$' | head -1); [ -n "$W" ] || W=www-data
if g=$(id -gn "$W" 2>/dev/null); then $S chown "root:$g" "$H.tmp" && $S chmod 640 "$H.tmp"; else $S chmod 644 "$H.tmp"; fi
$S mv -f "$H.tmp" "$H" || {{ undo; echo "@@err couldn't write $H"; exit 0; }}
"#,
            auth = AUTH_DIR,
            id = app_id,
            line = shell_quote(line),
        ));
    }
    for (path, sha, content) in changes {
        s.push_str(&format!(
            r#"f={f}
x=$(readlink -f -- "$f" 2>/dev/null) && [ -n "$x" ] && f="$x"
if [ "$($S sha256sum "$f" 2>/dev/null | cut -d' ' -f1)" != {sha} ]; then undo; echo "@@err $f changed since Kemudi read it: check again"; exit 0; fi
bak="$B/$(basename "$f").kemudi-$stamp"
while [ -e "$bak" ]; do sleep 1; stamp=$(date +%Y%m%d-%H%M%S); bak="$B/$(basename "$f").kemudi-$stamp"; done
$S cp -p "$f" "$bak" || {{ undo; echo "@@err couldn't back up $f"; exit 0; }}
printf '%s\t%s\n' "$f" "$bak" >> "$L"
tmp="$(dirname "$f")/.$(basename "$f").kemudi-tmp-$$"
base64 -d <<'KEMUDI_B64' | $S tee "$tmp" >/dev/null
{body}
KEMUDI_B64
if [ "$($S sha256sum "$tmp" | cut -d' ' -f1)" != {new_sha} ]; then $S rm -f "$tmp"; undo; echo "@@err the upload arrived damaged; nothing changed"; exit 0; fi
$S chown --reference="$f" "$tmp" 2>/dev/null
$S chmod --reference="$f" "$tmp"
$S mv -f "$tmp" "$f" || {{ $S rm -f "$tmp"; undo; echo "@@err couldn't replace $f"; exit 0; }}
echo "@@wrote $f"
"#,
            f = shell_quote(path),
            sha = shell_quote(sha),
            body = base64_body(content),
            new_sha = shell_quote(&sha_hex(content.as_bytes())),
        ));
    }
    s.push_str(
        r#"echo "@@check"
out=$($S nginx -t 2>&1); rc=$?
printf '%s\n' "$out" | head -40
if [ $rc -ne 0 ]; then undo; echo "@@rolledback"; exit 0; fi
rm -f "$L"
if $S systemctl reload nginx 2>/dev/null || $S nginx -s reload 2>/dev/null; then echo "@@reloaded"; else echo "@@err nginx -t passed but nginx didn't reload: reload it by hand"; fi
"#,
    );
    s
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthResult {
    /// `nginx -t`'s output.
    pub check: String,
    /// The vhosts changed.
    pub files: Vec<String>,
    /// The login user now in use (on).
    pub user: Option<String>,
}

fn parse_apply(out: &str) -> AppResult<String> {
    let check = out
        .split_once("@@check\n")
        .map(|(_, c)| {
            c.lines()
                .filter(|l| !l.starts_with("@@"))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    if out.lines().any(|l| l == "@@rolledback") {
        return Err(AppError::Invalid(format!(
            "nginx -t failed with the change, so it was put back (nothing changed):\n{check}"
        )));
    }
    errors(out)?;
    if !out.lines().any(|l| l == "@@reloaded") {
        return Err(AppError::Invalid(
            "no answer from the server; check the vhost".into(),
        ));
    }
    Ok(check)
}

/// The login file to use, and the htpasswd line to write to Kemudi's file
/// for the app first (if any).
async fn resolve_login(
    login: Login,
    server: &Server,
    app: &App,
    logins: &[LoginFile],
) -> AppResult<(String, Option<String>)> {
    let own = own_file(&app.id);
    match login {
        Login::Keep => {
            if logins.iter().any(|l| l.path == own) {
                Ok((own, None))
            } else {
                Err(AppError::Invalid("there's no earlier login for this app: pick one".into()))
            }
        }
        Login::File { path } => {
            if logins.iter().any(|l| l.path == path) {
                Ok((path, None))
            } else {
                Err(AppError::Invalid(format!("{path} isn't a login file on {}", server.name)))
            }
        }
        Login::Default => {
            let (u, p) = blocking(crate::vault::basic_auth_default)
                .await?
                .ok_or_else(|| AppError::Invalid("no default basic auth login yet: set one first".into()))?;
            if !valid_user(&u) {
                return Err(AppError::Invalid(format!(
                    "the default login's username `{u}` won't do: letters, digits and . _ @ - only"
                )));
            }
            let hash = blocking(move || apr1(&p)).await?;
            Ok((own, Some(format!("{u}:{hash}"))))
        }
        Login::Own { username, password, save } => {
            let u = username.trim().to_string();
            if !valid_user(&u) {
                return Err(AppError::Invalid(
                    "the username: letters, digits and . _ @ - only".into(),
                ));
            }
            let pw = password.clone();
            let hash = blocking(move || apr1(&pw)).await?;
            if save {
                let entry = crate::vault::EntryInput {
                    id: None,
                    name: format!("Basic auth · {} ({})", app.name, server.name),
                    username: u.clone(),
                    notes: app.url.clone().unwrap_or_default(),
                    sudo_for: Vec::new(),
                    basic_auth: false,
                    password: Some(password),
                };
                blocking(move || crate::vault::save_entry(entry)).await?;
            }
            Ok((own, Some(format!("{u}:{hash}"))))
        }
    }
}

/// The vhost changes for turning the app's basic auth on (with this login
/// file) or off.
fn changes_for(vh: &Vhosts, app: &App, file: Option<&str>) -> AppResult<Vec<Change>> {
    let invalid = |e: String| AppError::Invalid(e);
    let mut changes: Vec<Change> = Vec::new();
    match plan_of(vh, app) {
        Plan::NoVhost => {
            return Err(AppError::Invalid(format!(
                "no nginx server block has its root at {}/public",
                app.path.trim_end_matches('/')
            )))
        }
        Plan::Manual(why) => return Err(AppError::Invalid(why)),
        Plan::Kemudi => {
            for (path, text, _) in vh {
                if let Some(new) = set_auth(text, &app.path, file).map_err(invalid)? {
                    changes.push((path.clone(), sha_hex(text.as_bytes()), new));
                }
            }
        }
        Plan::Map { realm, file: file_map } => {
            let host = app_host(vh, app).ok_or_else(|| {
                AppError::Invalid(format!("set {}'s URL first: its host is the key in the ${realm} map", app.name))
            })?;
            let (ri, rm, _) = effective_map(vh, &realm).ok_or_else(|| AppError::Invalid(format!("no ${realm} map")))?;
            // The realm the other hosts use ("Restricted Area").
            let realm_text = rm
                .entries
                .iter()
                .find(|(k, v, _)| k != "default" && v != "off" && !v.is_empty())
                .map_or(REALM.to_string(), |(_, v, _)| v.clone());
            let default_off = rm
                .entries
                .iter()
                .find(|(k, _, _)| k == "default")
                .is_none_or(|(_, v, _)| v == "off" || v.is_empty());
            // Edits to the same file build on each other.
            let mut texts: Vec<Option<String>> = vec![None; vh.len()];
            let mut edit = |i: usize, var: &str, value: Option<&str>| -> AppResult<()> {
                let cur = texts[i].clone().unwrap_or_else(|| vh[i].1.clone());
                texts[i] = Some(set_map_entry(&cur, var, &host, value).map_err(invalid)?);
                Ok(())
            };
            match file {
                Some(_) => edit(ri, &realm, Some(&realm_text))?,
                // Off: out of the map, or "off" when the default is on.
                None => edit(ri, &realm, if default_off { None } else { Some("off") })?,
            }
            if let Ok(fv) = &file_map {
                let (fi, _, _) = effective_map(vh, fv).ok_or_else(|| AppError::Invalid(format!("no ${fv} map")))?;
                edit(fi, fv, file)?;
            }
            for (i, t) in texts.into_iter().enumerate() {
                if let Some(t) = t.filter(|t| *t != vh[i].1) {
                    changes.push((vh[i].0.clone(), sha_hex(vh[i].1.as_bytes()), t));
                }
            }
        }
    }
    Ok(changes)
}

/// Basic auth on (with a login) or off for an app.
#[tauri::command]
pub async fn dashboard_auth(
    state: State<'_, AppState>,
    server_id: String,
    app_id: String,
    on: bool,
    login: Option<Login>,
) -> AppResult<AuthResult> {
    let server = lookup(&state, &server_id)?;
    let app = app_of(&server, &app_id)?.clone();
    if !valid_app_id(&app.id) {
        return Err(AppError::Invalid(format!(
            "the app id `{}` can't be a file name: rename the app first",
            app.id
        )));
    }
    let status = read_status(&state, &server).await?;
    if !status.nginx {
        return Err(AppError::Invalid(format!(
            "{} has no nginx (/etc/nginx): basic auth here is nginx only",
            server.name
        )));
    }
    let vh = vhosts(&status.files);
    // A login file the vhost names itself: nothing to pick or write.
    let fixed = match plan_of(&vh, &app) {
        Plan::Map { file: Err(p), .. } => Some(p),
        _ => None,
    };
    let (file, htpasswd) = match (on, fixed) {
        (false, _) => (None, None),
        (true, Some(p)) => (Some(p), None),
        (true, None) => {
            let (f, line) = resolve_login(login.unwrap_or(Login::Default), &server, &app, &status.logins).await?;
            (Some(f), line)
        }
    };
    let changes = changes_for(&vh, &app, file.as_deref())?;
    let user_of = |f: &str| {
        status
            .logins
            .iter()
            .find(|l| l.path == f)
            .and_then(|l| l.users.first().cloned())
    };
    let user = match (&htpasswd, &file) {
        (Some(line), _) => line.split(':').next().map(str::to_string),
        (None, Some(f)) => user_of(f),
        _ => None,
    };
    if changes.is_empty() && htpasswd.is_none() {
        return Ok(AuthResult {
            check: String::new(),
            files: Vec::new(),
            user,
        });
    }
    let denied = status.files.iter().any(|r| matches!(r, Conf::Denied(_)));
    if denied && changes.is_empty() && !on {
        return Err(AppError::Invalid("some vhosts only root can read: save the sudo password in Passwords".into()));
    }
    let password = saved_sudo(&server_id).await;
    let script = apply_script(&app.id, htpasswd.as_deref(), &changes, password.as_deref());
    let result = crate::monitor::run_all(&state, &server_id, &script)
        .await
        .and_then(|out| parse_apply(&out))
        .map(|check| AuthResult {
            check,
            files: changes.iter().map(|c| c.0.clone()).collect(),
            user: user.clone(),
        });
    let label = match (&user, &file) {
        (Some(u), Some(_)) => format!("Basic auth on (user {u})"),
        (None, Some(f)) => format!("Basic auth on ({f})"),
        _ => "Basic auth off".to_string(),
    };
    audit(&state, &server, &app, "dash:auth", &label, &result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocks(text: &str) -> Vec<Block> {
        parse(text).blocks
    }

    const PLAIN: &str = "server {\n    listen 80;\n    server_name shop.example.com;\n    return 301 https://$host$request_uri;\n}\n\nserver {\n    listen 443 ssl;\n    server_name shop.example.com;\n    root /var/www/shop/public; # the app\n\n    location / {\n        try_files $uri $uri/ /index.php?$query_string;\n    }\n}\n";

    const WILD: &str = "server {\n\tlisten 443 ssl;\n\tserver_name ~^(?<app>.+)\\.staging\\.example\\.com$;\n\troot /opt/www/staging/$app/public;\n\tlocation ~ \\.php$ { include fastcgi.conf; }\n}\n";

    /// Like a staging box: maps by host at the top, auth in location /.
    const MAPPED: &str = "map $host $auth_required {\n    crm.staging.example.com \"Restricted Area\";\n    default \"off\";\n}\n\nmap $host $auth_user_file {\n    crm.staging.example.com /etc/nginx/.htpasswd;\n    default \"off\";\n}\n\nserver {\n    listen 443 ssl;\n    server_name ~^(?<subdomain>[^.]+).staging.example.com;\n    root /opt/www/staging/$subdomain/public;\n    location / {\n\tauth_basic           $auth_required;\n        auth_basic_user_file $auth_user_file;\n        try_files $uri $uri/ /index.php$is_args$args;\n    }\n    location = /index.php {\n        include fastcgi_params;\n    }\n}\n";

    /// An older file mapping the same variable (loaded first).
    const OTHER: &str = "map $host $auth_required {\n    erp.example.com \"Restricted Area\";\n    default \"off\";\n}\n";

    fn config(apps: &str) -> crate::config::schema::Config {
        crate::config::validate::parse(&format!(
            "servers:\n  - id: web\n    host: web.example.com\n    env: dev\n    apps:\n{apps}"
        ))
        .config
        .expect("config")
    }

    fn app(id: &str, path: &str, url: Option<&str>) -> App {
        let url = url.map(|u| format!(", url: {u}")).unwrap_or_default();
        config(&format!("      - {{ id: {id}, path: {path}{url} }}\n")).server("web").unwrap().apps[0].clone()
    }

    fn vh(files: &[(&str, &str)]) -> Vhosts {
        vhosts(&files.iter().map(|(p, t)| Conf::File(p.to_string(), t.to_string())).collect::<Vec<_>>())
    }

    #[test]
    fn finds_server_blocks_and_maps() {
        let b = blocks(PLAIN);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].root, None);
        assert_eq!(b[1].root.as_deref(), Some("/var/www/shop/public"));
        assert_eq!((b[1].open, b[1].close), (6, 14));
        // `upstream { server …; }` isn't a server block; a quoted { isn't one.
        let u = blocks("upstream x {\n  server 127.0.0.1:9000;\n}\nserver {\n  return 200 \"{ok}\";\n  root '/a b/public';\n}\n");
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].root.as_deref(), Some("/a b/public"));

        let p = parse(MAPPED);
        assert_eq!(p.maps.len(), 2);
        assert_eq!((p.maps[0].source.as_str(), p.maps[0].var.as_str()), ("$host", "auth_required"));
        assert_eq!(p.maps[0].entries[0], ("crm.staging.example.com".into(), "Restricted Area".into(), 1));
        assert_eq!(p.maps[0].entries[1], ("default".into(), "off".into(), 2));
        let b = &p.blocks[0];
        assert_eq!(b.realm_var.as_deref(), Some("auth_required"));
        assert_eq!(b.file_var.as_deref(), Some("auth_user_file"));
        assert!(b.in_location && !b.manual);
    }

    #[test]
    fn roots_and_hosts() {
        assert_eq!(serves("/var/www/shop/public/", "/var/www/shop"), Some(Serves::Plain));
        assert_eq!(serves("/var/www/shop/current/public", "/var/www/shop/"), Some(Serves::Plain));
        assert_eq!(serves("/var/www/shopx/public", "/var/www/shop"), None);
        assert_eq!(
            serves("/opt/www/staging/$app/public", "/opt/www/staging/crm"),
            Some(Serves::Wild { var: "app".into(), value: "crm".into() })
        );
        assert_eq!(
            serves("/opt/www/${1}/public", "/opt/www/crm"),
            Some(Serves::Wild { var: "1".into(), value: "crm".into() })
        );
        assert_eq!(serves("/opt/www/$a/$b/public", "/opt/www/x/y"), None);
        assert_eq!(serves("/opt/www/staging/$app/public", "/opt/www/staging/a/b"), None);
        assert_eq!(host_of("https://CRM.staging.example.com:8443/x?y").as_deref(), Some("crm.staging.example.com"));
        assert_eq!(host_of("crm.example.com").as_deref(), Some("crm.example.com"));
        assert_eq!(host_of("https://"), None);
        let w = Some(("sub", "crm"));
        assert_eq!(host_from_name("~^(?<sub>[^.]+)\\.staging\\.example\\.com$", w).as_deref(), Some("crm.staging.example.com"));
        assert_eq!(host_from_name("~^(?P<sub>(a|b)+).x.example.com", w).as_deref(), Some("crm.x.example.com"));
        assert_eq!(host_from_name("~^(?<sub>.+)\\.(dev|stg)\\.example\\.com$", w), None);
        assert_eq!(host_from_name("shop.example.com", None).as_deref(), Some("shop.example.com"));
        assert_eq!(host_from_name("~^(?<other>.+)\\.x\\.com$", w), None);
    }

    #[test]
    fn kemudi_lines_on_and_off() {
        let f = "/etc/nginx/kemudi-auth/shop";
        let on = set_auth(PLAIN, "/var/www/shop", Some(f)).unwrap().unwrap();
        assert!(on.contains("server {\n    # kemudi:auth begin · basic auth, set by Kemudi Devops\n    auth_basic \"Restricted\";\n    auth_basic_user_file /etc/nginx/kemudi-auth/shop;\n    # kemudi:auth end\n    listen 443 ssl;"));
        // Only the block with the root; the redirect block is left alone.
        assert_eq!(on.matches("kemudi:auth begin").count(), 1);
        let b = blocks(&on);
        assert!(!b[1].manual && b[1].realm_var.is_none() && b[1].region.is_some());
        // Again: no change. Another file: swapped. Off: exactly the original.
        assert_eq!(set_auth(&on, "/var/www/shop", Some(f)).unwrap(), None);
        let other = set_auth(&on, "/var/www/shop", Some("/etc/nginx/.htpasswd")).unwrap().unwrap();
        assert!(other.contains("auth_basic_user_file /etc/nginx/.htpasswd;") && !other.contains(f));
        assert_eq!(set_auth(&on, "/var/www/shop", None).unwrap().as_deref(), Some(PLAIN));
        assert_eq!(set_auth(PLAIN, "/var/www/shop", None).unwrap(), None);

        let a = app("shop", "/var/www/shop", None);
        let auth = auth_of(&vh(&[("/etc/nginx/sites-enabled/shop", &on)]), &a);
        assert_eq!((auth.state.as_str(), auth.mode.as_str(), auth.file.as_deref()), ("on", "kemudi", Some(f)));
    }

    #[test]
    fn kemudi_lines_per_app_on_a_shared_vhost() {
        let a = set_auth(WILD, "/opt/www/staging/crm", Some("/etc/nginx/kemudi-auth/crm")).unwrap().unwrap();
        let b = set_auth(&a, "/opt/www/staging/hr", Some("/etc/nginx/kemudi-auth/hr-stg")).unwrap().unwrap();
        assert!(b.contains("\tif ($app = \"crm\") { set $kemudi_auth \"Restricted\"; set $kemudi_auth_file /etc/nginx/kemudi-auth/crm; }\n\tif ($app = \"hr\") { set $kemudi_auth \"Restricted\"; set $kemudi_auth_file /etc/nginx/kemudi-auth/hr-stg; }"));
        assert_eq!(b.matches("kemudi:auth begin").count(), 1);
        let v = vh(&[("/etc/nginx/sites-enabled/wild", &b)]);
        assert_eq!(auth_of(&v, &app("hr-stg", "/opt/www/staging/hr", None)).state, "on");
        let other = auth_of(&v, &app("other", "/opt/www/staging/other", None));
        assert_eq!((other.state.as_str(), other.shared), ("off", true));
        // One off leaves the other; both off is the original again.
        let c = set_auth(&b, "/opt/www/staging/crm", None).unwrap().unwrap();
        assert!(!c.contains("\"crm\"") && c.contains("\"hr\""));
        assert_eq!(set_auth(&c, "/opt/www/staging/hr", None).unwrap().unwrap(), WILD);
    }

    #[test]
    fn leaves_hand_written_auth_alone() {
        let manual = PLAIN.replace("root /var/www/shop/public;", "root /var/www/shop/public;\n    auth_basic \"Team\";");
        assert!(set_auth(&manual, "/var/www/shop", Some("/x")).is_err());
        let a = app("shop", "/var/www/shop", None);
        let auth = auth_of(&vh(&[("/etc/nginx/sites-enabled/shop", &manual)]), &a);
        assert_eq!(auth.state, "manual");
        assert!(changes_for(&vh(&[("/etc/nginx/sites-enabled/shop", &manual)]), &a, Some("/x")).is_err());
        // `auth_basic off;` isn't auth; a variable without a map is by hand.
        let off = PLAIN.replace("root /var/www/shop/public;", "root /var/www/shop/public;\n    auth_basic off;");
        assert!(!blocks(&off)[1].manual);
        let var = PLAIN.replace("root /var/www/shop/public;", "root /var/www/shop/public;\n    auth_basic $x;\n    auth_basic_user_file /f;");
        assert_eq!(auth_of(&vh(&[("/s", &var)]), &a).state, "manual");
    }

    #[test]
    fn mapped_vhosts() {
        let files = [("/etc/nginx/sites-enabled/erp.example.com", OTHER), ("/etc/nginx/sites-enabled/staging.example.com", MAPPED)];
        let v = vh(&files);
        let crm = app("crm", "/opt/www/staging/crm", Some("https://crm.staging.example.com"));
        let hr = app("hr", "/opt/www/staging/hr", Some("https://hr.staging.example.com/"));
        let a = auth_of(&v, &crm);
        assert_eq!((a.state.as_str(), a.mode.as_str()), ("on", "map"));
        assert_eq!(a.file.as_deref(), Some("/etc/nginx/.htpasswd"));
        assert_eq!(a.via.as_deref(), Some("map $auth_required in staging.example.com"));
        assert_eq!(a.host.as_deref(), Some("crm.staging.example.com"));
        assert!(a.vhost_notes.iter().any(|n| n.contains("mapped in 2 files")));
        assert!(a.vhost_notes.iter().any(|n| n.contains("/index.php")));
        assert_eq!(auth_of(&v, &hr).state, "off");
        // No URL: the host comes from the server_name regex.
        let x = auth_of(&v, &app("x", "/opt/www/staging/x", None));
        assert_eq!((x.state.as_str(), x.host.as_deref()), ("off", Some("x.staging.example.com")));
        let unnamed = MAPPED.replace("server_name ~^(?<subdomain>[^.]+).staging.example.com;", "server_name _;");
        assert_eq!(auth_of(&vh(&[("/s", &unnamed)]), &app("x", "/opt/www/staging/x", None)).state, "nourl");

        // On for hr: a line in each map of the file nginx uses, before default.
        let ch = changes_for(&v, &hr, Some("/etc/nginx/kemudi-auth/hr")).unwrap();
        assert_eq!(ch.len(), 1);
        assert_eq!(ch[0].0, "/etc/nginx/sites-enabled/staging.example.com");
        assert_eq!(ch[0].1, sha_hex(MAPPED.as_bytes()));
        let on = &ch[0].2;
        assert!(on.contains("    crm.staging.example.com \"Restricted Area\";\n    hr.staging.example.com \"Restricted Area\";\n    default \"off\";"));
        assert!(on.contains("    hr.staging.example.com /etc/nginx/kemudi-auth/hr;\n    default \"off\";"));
        let v2 = vh(&[files[0], ("/etc/nginx/sites-enabled/staging.example.com", on)]);
        let a = auth_of(&v2, &hr);
        assert_eq!((a.state.as_str(), a.file.as_deref()), ("on", Some("/etc/nginx/kemudi-auth/hr")));
        // Off again: exactly as it was.
        let off = changes_for(&v2, &hr, None).unwrap();
        assert_eq!(off[0].2, MAPPED);
        // Off for crm leaves hr; nothing to do when already off.
        let crm_off = changes_for(&v, &crm, None).unwrap();
        assert!(!crm_off[0].2.contains("crm.staging") && crm_off[0].2.contains("default \"off\""));
        assert!(changes_for(&v, &hr, None).unwrap().is_empty());
    }

    #[test]
    fn map_with_a_default_that_is_on() {
        let t = MAPPED.replacen("default \"off\";", "default \"Team\";", 1);
        let v = vh(&[("/s", &t)]);
        let hr = app("hr", "/opt/www/staging/hr", Some("https://hr.staging.example.com"));
        assert_eq!(auth_of(&v, &hr).state, "on");
        // Off: an explicit "off" line (taking the line out wouldn't do).
        let off = changes_for(&v, &hr, None).unwrap();
        assert!(off[0].2.contains("    hr.staging.example.com off;\n    default \"Team\";"));
        assert_eq!(auth_of(&vh(&[("/s", &off[0].2)]), &hr).state, "off");
    }

    #[test]
    fn status_parses() {
        let out = "@@sudo ok\n@@nginx\n@@app shop\nlaravel\ndown {\"except\":[],\"secret\":\"abc\"}\n@@app api\n\n@@vhosts\n@file /etc/nginx/sites-enabled/shop\nserver {\n  root /var/www/shop/public;\n}\n\n@@eof\n@denied /etc/nginx/conf.d/x.conf\n@file /etc/nginx/sites-enabled/raw\nserver { }\n@@eof\n@@logins\n@pw /etc/nginx/.htpasswd team,qa\n@pw /etc/nginx/kemudi-auth/shop \n@@end\n";
        let s = parse_status(out).unwrap();
        assert_eq!(s.sudo, "ok");
        assert!(s.nginx);
        assert_eq!(s.apps[0], ("shop".into(), true, Some("{\"except\":[],\"secret\":\"abc\"}".into())));
        assert_eq!(s.apps[1], ("api".into(), false, None));
        assert_eq!(
            s.files,
            [
                Conf::File("/etc/nginx/sites-enabled/shop".into(), "server {\n  root /var/www/shop/public;\n}\n".into()),
                Conf::Denied("/etc/nginx/conf.d/x.conf".into()),
                Conf::File("/etc/nginx/sites-enabled/raw".into(), "server { }".into()),
            ]
        );
        assert_eq!(s.logins[0], LoginFile { path: "/etc/nginx/.htpasswd".into(), users: vec!["team".into(), "qa".into()] });
        assert_eq!(s.logins[1].users, Vec::<String>::new());
        assert_eq!(secret_of("{\"secret\":null}"), None);
        let c = config("      - { id: shop, path: /var/www/shop }\n");
        let d = dashboard_of(c.server("web").unwrap(), s, None);
        assert!(d.apps[0].down);
        assert_eq!(d.apps[0].secret.as_deref(), Some("abc"));
        assert_eq!(d.apps[0].auth.state, "off");
        // Off, but Kemudi's file from before is there (for "Keep").
        assert_eq!(d.apps[0].auth.file.as_deref(), Some("/etc/nginx/kemudi-auth/shop"));
        assert_eq!(d.denied, ["/etc/nginx/conf.d/x.conf"]);
        assert_eq!(d.logins.len(), 2);
    }

    #[test]
    fn scripts_are_valid_bash() {
        let c = config("      - { id: shop, path: /var/www/shop, vhost_files: [/etc/nginx/x] }\n");
        let server = c.server("web").expect("server");
        let change = ("/etc/nginx/sites-enabled/shop".to_string(), "abc".to_string(), "server {}\n".to_string());
        for s in [
            status_script(server, Some("pw")),
            maintenance_script("/var/www/shop", "php8.4", true, Some("ab12"), None),
            maintenance_script("/var/www/shop", "php", false, None, Some("pw")),
            apply_script("shop", Some("team:$apr1$x$y"), &[change], None),
            apply_script("shop", None, &[], Some("pw")),
        ] {
            let out = Command::new("bash").args(["-n", "-c", &s]).output().expect("bash");
            assert!(out.status.success(), "{}\n{s}", String::from_utf8_lossy(&out.stderr));
        }
    }

    #[test]
    fn hashes_and_names() {
        let h = apr1("s3cret pass").unwrap();
        assert!(h.starts_with("$apr1$"));
        assert!(apr1("a\nb").is_err());
        assert!(valid_user("team.lead@acme") && !valid_user("a:b") && !valid_user(""));
        assert!(valid_app_id("hr-stg") && !valid_app_id("../x") && !valid_app_id("a/b"));
        assert_eq!(random_hex(12).unwrap().len(), 24);
    }

    #[test]
    fn maintenance_answers() {
        let m = parse_maintenance("INFO  Application is now in maintenance mode.\n@@rc 0\n", Some("s".into())).unwrap();
        assert_eq!(m.output, "INFO  Application is now in maintenance mode.");
        assert_eq!(m.secret.as_deref(), Some("s"));
        let old = parse_maintenance("@@nosecret\nApplication is now in maintenance mode.\n@@rc 0\n", Some("s".into())).unwrap();
        assert_eq!(old.secret, None);
        assert!(parse_maintenance("Permission denied\n@@rc 1\n", None).is_err());
    }
}

/// Writes the scripts for a by-hand run against a real nginx (Docker):
/// `KEMUDI_DASH_OUT=<dir> cargo test dashboard::live -- --ignored`, with the
/// status script's output in <dir>/status.out.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn write_scripts() {
        let Ok(dir) = std::env::var("KEMUDI_DASH_OUT") else { return };
        let dir = std::path::Path::new(&dir);
        let config = crate::config::validate::parse(
            "servers:\n  - id: web\n    host: web.example.com\n    env: dev\n    apps:\n      - { id: shop, path: /var/www/shop }\n      - { id: crm, path: /opt/www/staging/crm }\n      - { id: hr-stg, path: /opt/www/staging/hr }\n      - { id: blog, path: /opt/www/mapped/blog, url: https://blog.mapped.test }\n      - { id: pos, path: /opt/www/mapped/pos, url: https://pos.mapped.test }\n",
        )
        .config
        .expect("config");
        let server = config.server("web").expect("server");
        std::fs::write(dir.join("status.sh"), status_script(server, None)).unwrap();
        std::fs::write(dir.join("down.sh"), maintenance_script("/var/www/shop", "php8.4", true, Some("ab12"), None)).unwrap();
        std::fs::write(dir.join("up.sh"), maintenance_script("/var/www/shop/", "php8.4", false, None, None)).unwrap();
        let out = std::fs::read_to_string(dir.join("status.out")).unwrap_or_default();
        let Ok(s) = parse_status(&out) else { return };
        let vh = vhosts(&s.files);
        let hash = apr1("pw1").unwrap();
        let shared = "/etc/nginx/.htpasswd";
        // (step, app, login file: own = write Kemudi's, else that file; off = None)
        for (name, app, file) in [
            ("crm-on", "crm", Some("own")),
            ("shop-on", "shop", Some(shared)),
            ("pos-on", "pos", Some("own")),
            ("blog-off", "blog", None),
            ("crm-off", "crm", None),
        ] {
            let a = server.app(app).unwrap();
            let own = own_file(&a.id);
            let path = file.map(|f| if f == "own" { own.as_str() } else { f });
            let changes = match changes_for(&vh, a, path) {
                Ok(c) => c,
                Err(e) => {
                    std::fs::write(dir.join(format!("{name}.sh")), format!("echo '{e}'\n")).unwrap();
                    continue;
                }
            };
            let line = format!("team:{hash}");
            let write = (file == Some("own")).then_some(line.as_str());
            std::fs::write(dir.join(format!("{name}.sh")), apply_script(&a.id, write, &changes, None)).unwrap();
        }
        // A change nginx -t refuses (put back).
        if let Some((p, t, _)) = vh.iter().find(|(p, _, _)| p.ends_with("/shop")) {
            let bad = vec![(p.clone(), sha_hex(t.as_bytes()), format!("{t}\nnonsense;\n"))];
            std::fs::write(dir.join("bad.sh"), apply_script("shop", None, &bad, None)).unwrap();
        }
    }
}

/// A real server, read-only: `KEMUDI_DASH_CONFIG=<servers.yaml>
/// KEMUDI_DASH_SERVER=<id> KEMUDI_DASH_OUT=<dir>` writes <dir>/real.sh; run
/// it there (`ssh host bash -s < real.sh > real.out`) and run this again to
/// print the dashboard.
#[cfg(test)]
mod real {
    use super::*;

    #[test]
    #[ignore]
    fn real_server() {
        let (Ok(cfg), Ok(id), Ok(dir)) = (
            std::env::var("KEMUDI_DASH_CONFIG"),
            std::env::var("KEMUDI_DASH_SERVER"),
            std::env::var("KEMUDI_DASH_OUT"),
        ) else {
            return;
        };
        let dir = std::path::Path::new(&dir);
        let text = std::fs::read_to_string(cfg).unwrap();
        let config = crate::config::validate::parse(&text).config.expect("config");
        let server = config.server(&id).expect("server");
        std::fs::write(dir.join("real.sh"), status_script(server, None)).unwrap();
        if let Ok(out) = std::fs::read_to_string(dir.join("real.out")) {
            let d = dashboard_of(server, parse_status(&out).unwrap(), None);
            println!("{}", serde_json::to_string_pretty(&d).unwrap());
        }
    }
}
