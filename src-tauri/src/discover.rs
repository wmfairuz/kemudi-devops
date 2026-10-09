//! Discover: look around a server for Laravel apps and propose them, filled
//! in (name, id, path, branch, git remote, PHP version, environment, vhost
//! and Supervisor files). Read-only. Apps are found by their `artisan` under
//! the usual folders (following links: /opt/www → /mnt/…, Deployer's
//! `current`), and from what the web server, Supervisor and cron point at.
//! The PHP version an app runs with is worked out the same way for an app
//! already in Kemudi (its page ▸ PHP ▸ Detect).

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::State;

use crate::actions::render::shell_quote;
use crate::config::schema::Env;
use crate::error::{AppError, AppResult};
use crate::remote_files::{lookup, saved_sudo, sudo_prelude};
use crate::AppState;

/// More candidates than this aren't looked at.
const MAX_APPS: usize = 200;

/// Sets R (sudo when needed), `rd` (read a file, with sudo if need be) and
/// `info <path>`: what an app folder says about itself.
const COMMON: &str = r#"R=""; [ "$(id -u)" != 0 ] && [ -n "$SU" ] && R="$SU"
rd() { cat -- "$1" 2>/dev/null || { [ -n "$R" ] && $R cat -- "$1" 2>/dev/null; }; }
info() {
  p=$1
  real=$(cd -P "$p" 2>/dev/null && pwd || $R sh -c 'cd -P "$1" && pwd' _ "$p" 2>/dev/null)
  echo "@@app $p"
  echo "real $real"
  echo "owner $(stat -c %U "$p" 2>/dev/null)"
  lock=$(rd "$p/composer.lock" | grep -A4 '"name": "laravel/framework"' | sed -n 's/.*"version": "v\{0,1\}\([^"]*\)".*/\1/p' | head -1)
  [ -n "$lock" ] && echo "laravel $lock"
  cp=$(rd "$p/composer.json" | tr -d '\n' | grep -o '"require"[[:space:]]*:[[:space:]]*{[^}]*' | grep -o '"php"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "$cp" ] && echo "composerphp $cp"
  rd "$p/.env" | grep -E '^(APP_NAME|APP_ENV|APP_URL)=' | sed 's/^/env /'
  b=$(git -c safe.directory='*' -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null || { [ -n "$R" ] && $R git -c safe.directory='*' -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null; })
  [ -n "$b" ] && echo "branch $b"
  o=$(git -c safe.directory='*' -C "$p" config --get remote.origin.url 2>/dev/null || { [ -n "$R" ] && $R git -c safe.directory='*' -C "$p" config --get remote.origin.url 2>/dev/null; })
  [ -n "$o" ] && echo "repo $o"
}
"#;

/// What the web server, Supervisor and cron point at, nginx `map`s (for
/// `php$phpversion-fpm` sockets) and the PHP versions installed. Paths
/// they mention go to "$C" (candidates).
const CONTEXT: &str = r#"VH="/etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf /etc/apache2/sites-enabled/* /etc/httpd/conf.d/*.conf"
for f in $VH; do
  [ -f "$f" ] || continue
  t=$(rd "$f") || continue
  echo "@@vh $f"
  printf '%s\n' "$t" | sed 's/#.*//' | grep -qE 'listen[^;]*(443|ssl)|ssl_certificate|SSLEngine[[:space:]]+on' && echo ssl
  printf '%s\n' "$t" | sed 's/#.*//' | tr ';{}' '\n\n\n' | sed -n 's/^[[:space:]]*\(root\|DocumentRoot\)[[:space:]]\{1,\}\([^[:space:]]*\).*/root \2/p;s/^[[:space:]]*fastcgi_pass[[:space:]]\{1,\}\([^[:space:]]*\).*/fpm \1/p;s/.*\(php[0-9.]*-fpm\).*/fpm \1/p;s/^[[:space:]]*\(server_name\|ServerName\)[[:space:]]\{1,\}\(.*\)/name \2/p' | sort -u
  printf '%s\n' "$t" | sed 's/#.*//' | tr ';{}' '\n\n\n' | sed -n 's/^[[:space:]]*\(root\|DocumentRoot\)[[:space:]]\{1,\}\([^[:space:]"]*\).*/\2/p' | sed 's|/public/*$||' >> "$C"
  # `set $var …` and `if (…)` statements, its own and its includes' (in order).
  printf '%s\n' "$t" | sed 's/#.*//' | tr ';{}' '\n\n\n' | grep -E '^[[:space:]]*(set|if)[[:space:]]' | sed "s|^[[:space:]]*|st $f	|"
  for i in $(printf '%s\n' "$t" | sed 's/#.*//' | tr ';{}' '\n\n\n' | sed -n 's/^[[:space:]]*include[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p'); do
    case "$i" in /*) ;; *) i="/etc/nginx/$i" ;; esac
    case "$i" in *'*'*|*snippets/*|*fastcgi*|*mime.types|*letsencrypt*) continue ;; esac
    [ -f "$i" ] || continue
    rd "$i" | sed 's/#.*//' | tr ';{}' '\n\n\n' | grep -E '^[[:space:]]*(set|if)[[:space:]]' | sed "s|^[[:space:]]*|st $i	|"
  done
done
for f in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
  [ -f "$f" ] || continue
  rd "$f" | sed 's/#.*//' | awk -v f="$f" '/^[[:space:]]*map[[:space:]]/ {m=1; print "@@map " f " " $2 " " $3; next} m && /}/ {m=0; next} m {gsub(/;/, ""); gsub(/[{}]/, ""); if (NF >= 2) print "mk " $1 " " $2; else if (NF == 1) print "mf " $1}'
done
for c in $(supconfs); do
  t=$(rd "$c") || continue
  echo "@@sup $c"
  printf '%s\n' "$t" | grep -oE '/[^[:space:]"]*/artisan' | sed 's|/artisan$||' | sort -u | sed 's/^/path /'
  printf '%s\n' "$t" | grep -oE '/[^[:space:]"]*/artisan' | sed 's|/artisan$||' >> "$C"
  printf '%s\n' "$t" | sed -n 's/^[[:space:]]*directory[[:space:]]*=[[:space:]]*\([^[:space:]]*\).*/\1/p' | sed 's/^/path /'
  printf '%s\n' "$t" | grep -E '^[[:space:]]*command[[:space:]]*=.*artisan' | sed 's/^[^=]*=[[:space:]]*/cmd /'
done
echo "@@cron"
CR=$( (cat /etc/crontab /etc/cron.d/* 2>/dev/null; crontab -l 2>/dev/null; [ -n "$R" ] && $R sh -c 'for u in $(cut -d: -f1 /etc/passwd); do crontab -l -u "$u" 2>/dev/null; done') | grep -v '^[[:space:]]*#' | grep artisan)
printf '%s\n' "$CR" | cut -c1-400 | grep . | sed 's/^/cmd /'
printf '%s\n' "$CR" | grep -oE 'cd +[^ &;]+|/[^[:space:]]*/artisan' | sed 's|^cd *||;s|/artisan$||' >> "$C"
echo "@@phpbins $(ls /usr/bin/php[0-9]* 2>/dev/null | sed 's|^/usr/bin/php||' | grep -E '^[0-9]+\.[0-9]+$' | sort -V | tr '\n' ' ')"
"#;

fn script(known: &[String], password: Option<&str>) -> String {
    let known = known
        .iter()
        .map(|k| shell_quote(k))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"export LC_ALL=C
{prelude}{sup}{common}C=$(mktemp) || exit 0
trap 'rm -f "$C"' EXIT
# 1. artisan under the usual folders, following links (/opt/www is often
# one, and Deployer's `current` is); loops are skipped by find.
for top in /var/www /opt /srv /home /usr/share/nginx; do
  [ -d "$top" ] || continue
  $R timeout 30 find -L "$top" -maxdepth 6 \( -name vendor -o -name node_modules -o -name .git -o -name storage -o -name releases -o -name .cache -o -name .npm -o -name proc \) -prune -o -type f -name artisan -print 2>/dev/null | sed 's|/artisan$||' >> "$C"
done
# 2. What the web server, Supervisor and cron point at.
{context}# 3. Each Laravel app found (artisan in it).
n=0
for p in $(sort -u "$C"); do
  case "$p" in /*) ;; *) continue ;; esac
  p=${{p%/}}
  case "$p" in */releases/*|*/vendor/*) continue ;; esac
  [ -f "$p/artisan" ] || {{ [ -n "$R" ] && $R test -f "$p/artisan"; }} || continue
  info "$p"
  n=$((n + 1)); [ "$n" -ge {max} ] && break
done
# 4. Real paths of the apps Kemudi already has.
for k in {known}; do echo "@@known $k $(cd -P "$k" 2>/dev/null && pwd)"; done
"#,
        prelude = sudo_prelude(password),
        sup = crate::app_inspect::SUPCONFS,
        common = COMMON,
        context = CONTEXT,
        max = MAX_APPS,
        known = if known.is_empty() { "''".into() } else { known },
    )
}

fn detect_script(path: &str, password: Option<&str>) -> String {
    format!(
        "export LC_ALL=C\n{prelude}{sup}{common}C=/dev/null\n{context}info {p}\n",
        prelude = sudo_prelude(password),
        sup = crate::app_inspect::SUPCONFS,
        common = COMMON,
        context = CONTEXT,
        p = shell_quote(path.trim_end_matches('/')),
    )
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub path: String,
    /// Where it really is (links resolved).
    pub real: String,
    /// Proposed name and id (the id is free on the server).
    pub name: String,
    pub id: String,
    pub laravel: Option<String>,
    pub app_name: Option<String>,
    pub app_env: Option<String>,
    pub app_url: Option<String>,
    pub branch: Option<String>,
    /// The git remote, without any credentials in it.
    pub repo: Option<String>,
    /// e.g. "8.4": what the web server runs it with (else its workers / cron).
    pub php: Option<String>,
    /// Where the PHP version comes from, and a warning if things disagree.
    pub php_source: Option<String>,
    pub php_note: Option<String>,
    /// composer.json's require.php, e.g. "^8.2".
    pub composer_php: Option<String>,
    /// Where it is on the web, and other addresses it answers on.
    pub url: Option<String>,
    pub url_source: Option<String>,
    pub urls: Vec<String>,
    /// From APP_ENV, when it differs from the server's.
    pub env: Option<Env>,
    pub vhost_files: Vec<String>,
    pub supervisor_files: Vec<String>,
    /// The site names its vhosts serve.
    pub domains: Vec<String>,
    pub owner: Option<String>,
    /// Already in Kemudi as this app.
    pub existing: Option<String>,
}

#[derive(Default)]
struct Vh {
    roots: Vec<String>,
    /// fastcgi_pass targets / php-fpm names as written (`…/php$phpversion-fpm.sock`).
    sockets: Vec<String>,
    names: Vec<String>,
    /// Regex names (`~^(?<sub>[^.]+).example.com`): the variable and the rest.
    patterns: Vec<(String, String)>,
    /// `set` / `if` statements (file, statement), its own then its includes'.
    stmts: Vec<(String, String)>,
    /// Serves HTTPS (listen 443 / ssl_certificate).
    ssl: bool,
}

/// Is an `if (…)` condition true for one of these host names? Only
/// `$host` / `$http_host` / `$server_name` `=` "name" (others: no).
fn if_true(cond: &str, domains: &[String]) -> bool {
    let c = cond
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .trim();
    let w: Vec<&str> = c.split_whitespace().collect();
    match w.as_slice() {
        [lhs, "=", rhs] if ["$host", "$http_host", "$server_name"].contains(lhs) => {
            let rhs = rhs.trim_matches(['"', '\'']);
            domains.iter().any(|d| d.eq_ignore_ascii_case(rhs))
        }
        _ => false,
    }
}

/// What `set $var …` statements make `var`, in order (an `if` applies to
/// the `set` right after it; the last one that applies wins).
fn set_lookup(v: &Vh, var: &str, domains: &[String]) -> Option<(String, String)> {
    let want = format!("${var}");
    let mut val: Option<(String, String)> = None;
    let mut cond: Option<(bool, String)> = None;
    for (file, s) in &v.stmts {
        let s = s.trim();
        if let Some(c) = s.strip_prefix("if") {
            cond = Some((if_true(c, domains), c.trim().to_string()));
            continue;
        }
        let Some(rest) = s.strip_prefix("set") else {
            continue;
        };
        let w: Vec<&str> = rest.split_whitespace().collect();
        let c = cond.take();
        if w.len() < 2 || w[0] != want {
            continue;
        }
        let value = w[1].trim_matches(['"', '\'']).to_string();
        match c {
            None => val = Some((value, format!("{file} (default)"))),
            Some((true, c)) => val = Some((value, format!("{file}: if {c}"))),
            Some((false, _)) => {}
        }
    }
    val
}

/// An nginx `map $src $dst { … }`.
#[derive(Default)]
struct Map {
    file: String,
    src: String,
    dst: String,
    hostnames: bool,
    entries: Vec<(String, String)>,
}

#[derive(Default)]
struct Ctx {
    vhosts: BTreeMap<String, Vh>,
    sups: BTreeMap<String, Vec<String>>,
    maps: Vec<Map>,
    /// Supervisor `command=` and cron lines that run artisan.
    cmds: Vec<String>,
    /// PHP versions installed (/usr/bin/phpX.Y).
    php_bins: Vec<String>,
}

/// Does a vhost root (maybe with `$var` segments) serve `path`? Returns the
/// values the variables take (`$subdomain` → `pekemall`).
fn root_matches(root: &str, path: &str) -> Option<Vec<(String, String)>> {
    let root = root.trim_end_matches('/');
    let root = root.strip_suffix("/public").unwrap_or(root);
    let path = path.trim_end_matches('/');
    if !root.contains('$') {
        return (root == path).then(Vec::new);
    }
    let rs: Vec<&str> = root.split('/').collect();
    let ps: Vec<&str> = path.split('/').collect();
    if rs.len() != ps.len() {
        return None;
    }
    let mut vars = Vec::new();
    for (r, p) in rs.iter().zip(&ps) {
        if let Some(v) = r.strip_prefix('$') {
            if p.is_empty() || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                return None;
            }
            vars.push((v.to_string(), (*p).to_string()));
        } else if r != p {
            return None;
        }
    }
    Some(vars)
}

/// `~^(?<sub>[^.]+)\.example\.com$` → ("sub", ".example.com").
fn name_pattern(n: &str) -> Option<(String, String)> {
    let rest = n
        .strip_prefix("~^(?<")
        .or_else(|| n.strip_prefix("~^(?P<"))?;
    let (var, rest) = rest.split_once('>')?;
    let rest = rest
        .strip_prefix("[^.]+)")
        .or_else(|| rest.strip_prefix(".+)"))?;
    let tail = rest.replace('\\', "").trim_end_matches('$').to_string();
    (tail.starts_with('.')
        && tail
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b)))
    .then(|| (var.to_string(), tail))
}

/// How a wildcard vhost picks PHP for a site.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WildPhp {
    /// One socket for every site (`php8.3-fpm.sock`).
    Fixed { version: String },
    /// `fastcgi_pass …php$var-fpm.sock` with `set $var "8.1"` and
    /// `if ($http_host = "…") { set $var "8.4"; }` blocks in an included
    /// `file`; `hosts` are the sites it names.
    Ifs {
        file: String,
        var: String,
        default: Option<String>,
        hosts: Vec<(String, String)>,
    },
    /// Anything else (a `map`, sets in the vhost itself): set it by hand.
    Other { note: String },
}

/// A vhost that serves many sites from one folder per subdomain:
/// `server_name ~^(?<sub>[^.]+).example.com` + `root /x/$sub/public`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wildcard {
    pub file: String,
    /// The app folder with the variable in it: `/opt/www/x/$sub`.
    pub root: String,
    pub var: String,
    /// `.example.com`
    pub suffix: String,
    pub ssl: bool,
    pub php: WildPhp,
    /// A New app `after` hook that sets a site's PHP here (filled in by
    /// New app's probe).
    pub hook: Option<String>,
}

fn wild_php(file: &str, v: &Vh, maps: &[Map]) -> WildPhp {
    let Some(socket) = v.sockets.iter().find(|s| socket_var(s).is_some()) else {
        return match v.sockets.iter().find_map(|s| php_of(s)) {
            Some(version) => WildPhp::Fixed { version },
            None => WildPhp::Other {
                note: "no PHP-FPM socket found in it".into(),
            },
        };
    };
    let var = socket_var(socket).unwrap_or_default();
    let want = format!("${var}");
    let sets: Vec<&(String, String)> = v
        .stmts
        .iter()
        .filter(|(_, st)| {
            st.trim()
                .strip_prefix("set")
                .is_some_and(|r| r.split_whitespace().next() == Some(want.as_str()))
        })
        .collect();
    let Some((set_file, _)) = sets.last() else {
        return match maps.iter().find(|m| m.dst == want) {
            Some(m) => WildPhp::Other {
                note: format!("PHP comes from `map {} {}` in {}", m.src, m.dst, m.file),
            },
            None => WildPhp::Other {
                note: format!("couldn't tell where ${var} is set"),
            },
        };
    };
    if set_file == file {
        return WildPhp::Other {
            note: format!("${var} is set in the vhost itself"),
        };
    }
    // `if (…)` then the `set` right after it.
    let mut default = None;
    let mut hosts = Vec::new();
    let mut cond: Option<String> = None;
    for (f, st) in v.stmts.iter().filter(|(f, _)| f == set_file) {
        let st = st.trim();
        if let Some(c) = st.strip_prefix("if") {
            let c = c.trim().trim_start_matches('(').trim_end_matches(')');
            let w: Vec<&str> = c.split_whitespace().collect();
            cond = match w.as_slice() {
                [lhs, "=", rhs] if ["$host", "$http_host", "$server_name"].contains(lhs) => {
                    Some(rhs.trim_matches(['"', '\'']).to_string())
                }
                _ => Some(String::new()),
            };
            continue;
        }
        let Some(rest) = st.strip_prefix("set") else {
            continue;
        };
        let w: Vec<&str> = rest.split_whitespace().collect();
        let c = cond.take();
        if w.len() < 2 || w[0] != want || f != set_file {
            continue;
        }
        let value = w[1].trim_matches(['"', '\'']).to_string();
        match c {
            None => default = Some(value),
            Some(h) if !h.is_empty() => hosts.push((h, value)),
            Some(_) => {}
        }
    }
    WildPhp::Ifs {
        file: set_file.clone(),
        var,
        default,
        hosts,
    }
}

fn wildcards_of(ctx: &Ctx) -> Vec<Wildcard> {
    let mut out: Vec<Wildcard> = Vec::new();
    for (file, v) in &ctx.vhosts {
        for root in &v.roots {
            let root = root.strip_suffix("/public").unwrap_or(root);
            let Some(var) = root
                .split('/')
                .find_map(|seg| seg.strip_prefix('$'))
                .filter(|var| var.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
            else {
                continue;
            };
            let Some((_, suffix)) = v.patterns.iter().find(|(pv, _)| pv == var) else {
                continue;
            };
            if out.iter().any(|w| w.root == root && &w.suffix == suffix) {
                continue;
            }
            out.push(Wildcard {
                file: file.clone(),
                root: root.to_string(),
                var: var.to_string(),
                suffix: suffix.clone(),
                ssl: v.ssl,
                php: wild_php(file, v, &ctx.maps),
                hook: None,
            });
        }
    }
    out
}

/// The server's wildcard vhosts (read-only).
pub(crate) async fn wildcards(state: &AppState, server_id: &str) -> AppResult<Vec<Wildcard>> {
    let password = saved_sudo(server_id).await;
    let script = format!(
        "export LC_ALL=C\n{prelude}{sup}{common}C=/dev/null\n{context}",
        prelude = sudo_prelude(password.as_deref()),
        sup = crate::app_inspect::SUPCONFS,
        common = COMMON,
        context = CONTEXT,
    );
    let out = crate::monitor::run_for(state, server_id, &script, 30).await?;
    let (ctx, _, _) = parse_ctx(&out);
    Ok(wildcards_of(&ctx))
}

fn php_of(socket: &str) -> Option<String> {
    let i = socket.rfind("php")?;
    let v: String = socket[i + 3..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let v = v.trim_end_matches('.');
    (!v.is_empty() && v.contains('.')).then(|| v.to_string())
}

/// `php$phpversion-fpm.sock` → "phpversion".
fn socket_var(socket: &str) -> Option<String> {
    let i = socket.find("php$")?;
    let v: String = socket[i + 4..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    (!v.is_empty()).then_some(v)
}

/// A version-looking map value or binary: "8.4".
fn version_like(v: &str) -> Option<String> {
    let v = v.trim().trim_matches(['"', '\'']);
    (v.contains('.') && v.bytes().all(|b| b.is_ascii_digit() || b == b'.')).then(|| v.to_string())
}

/// Look up keys in a map: exact first, then (with `hostnames`) `*.x`, `.x`
/// and `x.*` forms, then `default`. Returns the value and what matched.
fn map_lookup(m: &Map, keys: &[String]) -> Option<(String, String)> {
    for k in keys {
        if let Some((key, v)) = m.entries.iter().find(|(e, _)| e.eq_ignore_ascii_case(k)) {
            return Some((v.clone(), key.clone()));
        }
    }
    if m.hostnames {
        for k in keys {
            let k = k.to_ascii_lowercase();
            for (pat, v) in &m.entries {
                let p = pat.to_ascii_lowercase();
                let hit = if let Some(s) = p.strip_prefix("*.") {
                    k.ends_with(&format!(".{s}"))
                } else if let Some(s) = p.strip_prefix('.') {
                    k == s || k.ends_with(&p)
                } else if let Some(pre) = p.strip_suffix(".*") {
                    k.starts_with(&format!("{pre}."))
                } else {
                    false
                };
                if hit {
                    return Some((v.clone(), pat.clone()));
                }
            }
        }
    }
    m.entries
        .iter()
        .find(|(e, _)| e == "default")
        .map(|(_, v)| (v.clone(), "default".into()))
}

/// The lowest PHP a composer constraint allows: `^8.2` → (8, 2),
/// `^7.4|^8.0` → (7, 4).
fn composer_min(c: &str) -> Option<(u32, u32)> {
    c.split('|')
        .filter_map(|alt| {
            let s: String = alt
                .trim()
                .trim_start_matches(['^', '~', '>', '=', 'v', ' '])
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            let mut it = s.split('.');
            let major = it.next()?.parse().ok()?;
            Some((major, it.next().and_then(|m| m.parse().ok()).unwrap_or(0)))
        })
        .min()
}

fn ver(v: &str) -> Option<(u32, u32)> {
    let mut it = v.split('.');
    Some((
        it.next()?.parse().ok()?,
        it.next().and_then(|m| m.parse().ok()).unwrap_or(0),
    ))
}

fn parse_ctx(out: &str) -> (Ctx, Vec<Found>, Vec<(String, String)>) {
    let mut ctx = Ctx::default();
    let mut found: Vec<Found> = Vec::new();
    let mut known: Vec<(String, String)> = Vec::new();
    enum Cur {
        None,
        Vh(String),
        Sup(String),
        Map,
        App,
    }
    let mut cur = Cur::None;
    for l in out.lines() {
        if let Some(c) = l.strip_prefix("cmd ") {
            if !matches!(cur, Cur::App) {
                ctx.cmds.push(c.trim().to_string());
                continue;
            }
        }
        if let Some(f) = l.strip_prefix("@@vh ") {
            ctx.vhosts.entry(f.trim().to_string()).or_default();
            cur = Cur::Vh(f.trim().to_string());
        } else if let Some(f) = l.strip_prefix("@@sup ") {
            ctx.sups.entry(f.trim().to_string()).or_default();
            cur = Cur::Sup(f.trim().to_string());
        } else if let Some(m) = l.strip_prefix("@@map ") {
            let w: Vec<&str> = m.split_whitespace().collect();
            if let [file, src, dst, ..] = w.as_slice() {
                ctx.maps.push(Map {
                    file: (*file).to_string(),
                    src: (*src).to_string(),
                    dst: (*dst).to_string(),
                    ..Map::default()
                });
            }
            cur = Cur::Map;
        } else if let Some(b) = l.strip_prefix("@@phpbins") {
            ctx.php_bins = b.split_whitespace().map(str::to_string).collect();
            cur = Cur::None;
        } else if let Some(p) = l.strip_prefix("@@app ") {
            found.push(Found {
                path: p.trim().trim_end_matches('/').to_string(),
                ..Found::default()
            });
            cur = Cur::App;
        } else if let Some(k) = l.strip_prefix("@@known ") {
            let mut it = k.split(' ');
            let p = it.next().unwrap_or("").trim_end_matches('/').to_string();
            let r = it.next().unwrap_or("").trim_end_matches('/').to_string();
            known.push((p, r));
            cur = Cur::None;
        } else if l.starts_with("@@") {
            cur = Cur::None;
        } else {
            match &cur {
                Cur::Vh(f) => {
                    let Some(v) = ctx.vhosts.get_mut(f) else {
                        continue;
                    };
                    if l == "ssl" {
                        v.ssl = true;
                    } else if let Some(r) = l.strip_prefix("root ") {
                        v.roots
                            .push(r.trim().trim_matches('"').trim_end_matches('/').to_string());
                    } else if let Some(s) = l.strip_prefix("fpm ") {
                        v.sockets.push(s.trim().to_string());
                    } else if let Some(st) = l.strip_prefix("st ") {
                        if let Some((file, stmt)) = st.split_once('\t') {
                            v.stmts.push((file.to_string(), stmt.to_string()));
                        }
                    } else if let Some(n) = l.strip_prefix("name ") {
                        for n in n.split_whitespace() {
                            if let Some(p) = name_pattern(n) {
                                v.patterns.push(p);
                            } else if n != "_"
                                && !n.starts_with('~')
                                && !v.names.iter().any(|x| x == n)
                            {
                                v.names.push(n.to_string());
                            }
                        }
                    }
                }
                Cur::Sup(f) => {
                    if let Some(p) = l.strip_prefix("path ") {
                        if let Some(s) = ctx.sups.get_mut(f) {
                            s.push(p.trim().trim_end_matches('/').to_string());
                        }
                    }
                }
                Cur::Map => {
                    let Some(m) = ctx.maps.last_mut() else {
                        continue;
                    };
                    let w: Vec<&str> = l.split_whitespace().collect();
                    match w.as_slice() {
                        ["mk", k, v, ..] => m.entries.push(((*k).to_string(), (*v).to_string())),
                        ["mf", "hostnames"] => m.hostnames = true,
                        _ => {}
                    }
                }
                Cur::App => {
                    let Some(a) = found.last_mut() else { continue };
                    if let Some(r) = l.strip_prefix("real ") {
                        a.real = r.trim().trim_end_matches('/').to_string();
                    } else if let Some(o) = l.strip_prefix("owner ") {
                        a.owner = Some(o.trim().to_string()).filter(|o| !o.is_empty());
                    } else if let Some(v) = l.strip_prefix("laravel ") {
                        a.laravel = Some(v.trim().to_string());
                    } else if let Some(c) = l.strip_prefix("composerphp ") {
                        a.composer_php = Some(c.trim().to_string()).filter(|c| !c.is_empty());
                    } else if let Some(b) = l.strip_prefix("branch ") {
                        a.branch = Some(b.trim().to_string()).filter(|b| b != "HEAD");
                    } else if let Some(r) = l.strip_prefix("repo ") {
                        a.repo = Some(crate::monitor::strip_credentials(r.trim()));
                    } else if let Some(e) = l.strip_prefix("env ") {
                        let (k, v) = e.split_once('=').unwrap_or((e, ""));
                        let v = v.trim().trim_matches(['"', '\'']).to_string();
                        match k {
                            "APP_NAME" => a.app_name = Some(v).filter(|v| !v.is_empty()),
                            "APP_ENV" => a.app_env = Some(v).filter(|v| !v.is_empty()),
                            "APP_URL" => a.app_url = Some(v).filter(|v| !v.is_empty()),
                            _ => {}
                        }
                    }
                }
                Cur::None => {}
            }
        }
    }
    (ctx, found, known)
}

/// Fill in what the context says about an app: its vhosts (and domains),
/// Supervisor files and PHP version.
fn enrich(ctx: &Ctx, a: &mut Found) {
    let path = a.path.clone();
    let real = a.real.clone();
    let here = |p: &str| {
        let p = p.trim_end_matches('/');
        p == path || (!real.is_empty() && p == real)
    };
    // Its vhosts: root is the app or its public/ (`$var` segments match one
    // folder, as in one vhost for a folder of apps).
    let paths = [path.clone(), real.clone()];
    // (vhost file, vhost, the values its `$var` segments take)
    type Hit<'a> = (&'a String, &'a Vh, Vec<(String, String)>);
    let mut hits: Vec<Hit> = Vec::new();
    for (file, v) in &ctx.vhosts {
        let hit = v.roots.iter().find_map(|r| {
            paths
                .iter()
                .filter(|p| !p.is_empty())
                .find_map(|p| root_matches(r, p))
        });
        let Some(vars) = hit else { continue };
        if !a.vhost_files.contains(file) {
            a.vhost_files.push(file.clone());
        }
        let mut names: Vec<String> = Vec::new();
        if vars.is_empty() {
            names.extend(v.names.iter().cloned());
        } else {
            // Its own name from the pattern; plain names only if they say so.
            for (var, tail) in &v.patterns {
                if let Some((_, val)) = vars.iter().find(|(k, _)| k == var) {
                    names.push(format!("{val}{tail}"));
                }
            }
            let folder = vars.last().map(|(_, v)| v.as_str()).unwrap_or("");
            names.extend(
                v.names
                    .iter()
                    .filter(|n| n.split('.').next() == Some(folder))
                    .cloned(),
            );
        }
        for n in names {
            if !a.domains.contains(&n) {
                a.domains.push(n);
            }
        }
        hits.push((file, v, vars));
    }
    for (file, ps) in &ctx.sups {
        if ps.iter().any(|p| here(p)) && !a.supervisor_files.contains(file) {
            a.supervisor_files.push(file.clone());
        }
    }

    // Its URL: APP_URL when the web server serves that name (or nothing
    // else says), else the vhost's own name; https when the vhost has TLS.
    let ssl = hits.iter().any(|(_, v, _)| v.ssl);
    let scheme = if ssl { "https" } else { "http" };
    let host_of = |u: &str| {
        u.split("://")
            .nth(1)
            .unwrap_or(u)
            .split(['/', ':'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    let app_url = a
        .app_url
        .clone()
        .map(|u| u.trim_end_matches('/').to_string())
        .filter(|u| {
            let h = host_of(u);
            u.starts_with("http")
                && !h.is_empty()
                && h != "localhost"
                && !h.starts_with("127.")
                && !h.ends_with(".test")
                && !h.ends_with(".local")
        });
    let mut urls: Vec<String> = a
        .domains
        .iter()
        .map(|d| format!("{scheme}://{d}"))
        .collect();
    let (url, source) = match &app_url {
        Some(u)
            if a.domains
                .iter()
                .any(|d| d.eq_ignore_ascii_case(&host_of(u))) =>
        {
            // Same name as the vhost: its scheme from the vhost.
            let fixed = format!("{scheme}://{}", u.split("://").nth(1).unwrap_or(u));
            (
                Some(fixed),
                Some("APP_URL, served by its vhost".to_string()),
            )
        }
        _ if !a.domains.is_empty() => (
            Some(format!("{scheme}://{}", a.domains[0])),
            Some("the name its vhost serves".to_string()),
        ),
        Some(u) => (
            Some(u.clone()),
            Some("APP_URL in its .env (no vhost found for it)".to_string()),
        ),
        None => (None, None),
    };
    if let Some(u) = &app_url {
        if !urls.contains(u) {
            urls.push(u.clone());
        }
    }
    a.url = url;
    a.url_source = source;
    a.urls = urls;

    // PHP for the web: the vhost's socket, through an nginx map if it's a variable.
    let mut web: Option<(String, String)> = None;
    'web: for (file, v, vars) in &hits {
        for s in &v.sockets {
            if let Some(x) = php_of(s) {
                web = Some((x, format!("nginx: {file}")));
                break 'web;
            }
            let Some(var) = socket_var(s) else { continue };
            // `set $phpversion …` (maybe in an included file, per host with `if`).
            if let Some((val, how)) = set_lookup(v, &var, &a.domains) {
                if let Some(x) = version_like(&val) {
                    web = Some((x, format!("nginx: ${var} from {how}")));
                    break 'web;
                }
            }
            for m in ctx.maps.iter().filter(|m| m.dst == format!("${var}")) {
                let keys: Vec<String> =
                    if ["$host", "$http_host", "$server_name"].contains(&m.src.as_str()) {
                        a.domains.clone()
                    } else {
                        let src = m.src.trim_start_matches('$');
                        vars.iter()
                            .filter(|(k, _)| k == src)
                            .map(|(_, v)| v.clone())
                            .collect()
                    };
                if let Some((val, key)) = map_lookup(m, &keys) {
                    if let Some(x) = version_like(&val) {
                        let how = if key == "default" {
                            "its default".to_string()
                        } else {
                            format!("entry {key}")
                        };
                        web = Some((x, format!("nginx map {} in {} ({how})", m.dst, m.file)));
                        break 'web;
                    }
                }
            }
        }
    }
    // PHP for its workers and cron: `php8.4 /path/artisan …` or `cd /path && php8.4 artisan …`.
    let mut cli: Option<(String, String)> = None;
    for c in &ctx.cmds {
        let toks: Vec<&str> = c.split_whitespace().collect();
        let mut cd: Option<String> = None;
        let mut target: Option<String> = None;
        let mut php: Option<String> = None;
        for (i, t) in toks.iter().enumerate() {
            let t = t.trim_end_matches([';', '&']);
            if t == "cd" {
                cd = toks
                    .get(i + 1)
                    .map(|x| x.trim_end_matches([';', '&']).to_string());
            } else if let Some(p) = t.strip_suffix("/artisan") {
                target = Some(p.to_string());
            } else if t == "artisan" {
                target = cd.clone();
            } else if let Some(x) = t
                .rsplit('/')
                .next()
                .and_then(|b| b.strip_prefix("php"))
                .and_then(version_like)
            {
                php = Some(x);
            }
        }
        if let (Some(t), Some(x)) = (target, php) {
            if here(&t) {
                cli = Some((x, "its queue workers / cron".into()));
                break;
            }
        }
    }

    let need = a.composer_php.as_deref().and_then(composer_min);
    let (mut version, mut source) = match (&web, &cli) {
        (Some((v, s)), _) => (Some(v.clone()), Some(s.clone())),
        (None, Some((v, s))) => (Some(v.clone()), Some(s.clone())),
        _ => (None, None),
    };
    let mut note: Option<String> = None;
    if let (Some((w, _)), Some((c, _))) = (&web, &cli) {
        if w != c {
            note = Some(format!(
                "nginx runs it with PHP {w}, but its queue workers / cron use PHP {c}."
            ));
        }
    }
    if let (Some(v), Some(min), Some(c)) = (&version, need, &a.composer_php) {
        if ver(v).is_some_and(|x| x < min) {
            note = Some(format!(
                "composer.json needs PHP {c}, but {} gives it PHP {v}: it won't run like that. Is it missing from the map, or does the vhost need a fixed version?",
                source.as_deref().unwrap_or("the server")
            ));
        }
    }
    if version.is_none() {
        // Nothing points at a PHP for it: the lowest installed one composer.json allows.
        if let (Some(min), Some(c)) = (need, &a.composer_php) {
            if let Some(b) = ctx
                .php_bins
                .iter()
                .find(|b| ver(b).is_some_and(|x| x >= min))
            {
                version = Some(b.clone());
                source = Some(format!(
                    "the lowest installed PHP that composer.json allows ({c})"
                ));
            }
        }
    }
    a.php = version;
    a.php_source = source;
    a.php_note = note;
}

fn env_of(app_env: &str) -> Option<Env> {
    match app_env
        .trim()
        .trim_matches(['"', '\''])
        .to_ascii_lowercase()
        .as_str()
    {
        "production" | "prod" | "live" => Some(Env::Prod),
        "staging" | "stage" | "stg" | "preprod" => Some(Env::Staging),
        "qa" | "uat" => Some(Env::Qa),
        // `local` is often left as it was on a server: not a reason to lower
        // the guardrails, so those follow the server.
        _ => None,
    }
}

/// A folder name worth using: not `current`, `public`, `html`…
fn meaningful_name(path: &str) -> String {
    let parts: Vec<&str> = path
        .trim_end_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    for p in parts.iter().rev() {
        if ![
            "current",
            "public",
            "html",
            "htdocs",
            "httpdocs",
            "public_html",
        ]
        .contains(p)
        {
            return (*p).to_string();
        }
    }
    parts
        .last()
        .map_or_else(|| "app".into(), |p| (*p).to_string())
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "app".into()
    } else {
        out.chars().take(48).collect()
    }
}

fn title(s: &str) -> String {
    s.split(['-', '_', '.', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse(out: &str, server: &crate::config::schema::Server) -> Vec<Found> {
    let (ctx, mut found, known) = parse_ctx(out);

    // One per real folder: prefer the path through a `current` link, else the shortest.
    found.sort_by_key(|a| (!a.path.ends_with("/current"), a.path.len()));
    let mut seen: Vec<String> = Vec::new();
    found.retain(|a| {
        let key = if a.real.is_empty() {
            a.path.clone()
        } else {
            a.real.clone()
        };
        if seen.contains(&key) {
            return false;
        }
        seen.push(key);
        true
    });

    let mut taken: Vec<String> = server.apps.iter().map(|a| a.id.clone()).collect();
    for a in &mut found {
        enrich(&ctx, a);
        let here = |p: &str| {
            let p = p.trim_end_matches('/');
            p == a.path || (!a.real.is_empty() && p == a.real)
        };
        // Already in Kemudi?
        a.existing = server
            .apps
            .iter()
            .find(|x| {
                let xp = x.path.trim_end_matches('/');
                here(xp)
                    || known
                        .iter()
                        .any(|(p, r)| p == xp && !r.is_empty() && here(r))
            })
            .map(|x| x.id.clone());
        a.env = a
            .app_env
            .as_deref()
            .and_then(env_of)
            .filter(|e| *e != server.env);
        let folder = meaningful_name(&a.path);
        a.name = a
            .app_name
            .clone()
            .filter(|n| !n.eq_ignore_ascii_case("laravel") && !n.contains("${"))
            .unwrap_or_else(|| title(&folder));
        if a.existing.is_none() {
            let base = slug(&folder);
            let mut id = base.clone();
            let mut i = 2;
            while taken.contains(&id) {
                id = format!("{base}-{i}");
                i += 1;
            }
            taken.push(id.clone());
            a.id = id;
        } else {
            a.id = a.existing.clone().unwrap_or_default();
        }
    }
    found.sort_by(|a, b| {
        a.existing
            .is_some()
            .cmp(&b.existing.is_some())
            .then_with(|| a.path.cmp(&b.path))
    });
    found
}

/// Look for Laravel apps on a server; already-added ones are marked.
#[tauri::command]
pub async fn discover_apps(state: State<'_, AppState>, server_id: String) -> AppResult<Vec<Found>> {
    let server = lookup(&state, &server_id)?;
    let known: Vec<String> = server
        .apps
        .iter()
        .map(|a| a.path.trim_end_matches('/').to_string())
        .filter(|p| p.starts_with('/') && !p.contains(['\n', '\r', '\0', ' ']))
        .collect();
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_for(
        &state,
        &server_id,
        &script(&known, password.as_deref()),
        120,
    )
    .await?;
    crate::remote_files::errors(&out)?;
    Ok(parse(&out, &server))
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhpDetect {
    pub version: Option<String>,
    pub source: Option<String>,
    pub note: Option<String>,
    pub composer: Option<String>,
    /// PHP versions installed on the server.
    pub installed: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlDetect {
    pub url: Option<String>,
    pub source: Option<String>,
    /// Other addresses it answers on (its vhost's names, APP_URL).
    pub urls: Vec<String>,
}

/// Where an app is on the web (app page ▸ URL ▸ Detect).
#[tauri::command]
pub async fn app_detect_url(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
) -> AppResult<UrlDetect> {
    lookup(&state, &server_id)?;
    let path = path.trim();
    if !path.starts_with('/') || path.contains(['\n', '\r', '\0']) {
        return Err(AppError::Invalid("set the app's path first".into()));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_for(
        &state,
        &server_id,
        &detect_script(path, password.as_deref()),
        40,
    )
    .await?;
    crate::remote_files::errors(&out)?;
    let (ctx, mut found, _) = parse_ctx(&out);
    let mut a = found
        .pop()
        .ok_or_else(|| AppError::Invalid("no answer from the server".into()))?;
    enrich(&ctx, &mut a);
    Ok(UrlDetect {
        url: a.url,
        source: a.url_source,
        urls: a.urls,
    })
}

/// The PHP version an app runs with (app page ▸ PHP ▸ Detect).
#[tauri::command]
pub async fn app_detect_php(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
) -> AppResult<PhpDetect> {
    lookup(&state, &server_id)?;
    let path = path.trim();
    if !path.starts_with('/') || path.contains(['\n', '\r', '\0']) {
        return Err(AppError::Invalid("set the app's path first".into()));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_for(
        &state,
        &server_id,
        &detect_script(path, password.as_deref()),
        40,
    )
    .await?;
    crate::remote_files::errors(&out)?;
    let (ctx, mut found, _) = parse_ctx(&out);
    let mut a = found
        .pop()
        .ok_or_else(|| AppError::Invalid("no answer from the server".into()))?;
    enrich(&ctx, &mut a);
    Ok(PhpDetect {
        version: a.php,
        source: a.php_source,
        note: a.php_note,
        composer: a.composer_php,
        installed: ctx.php_bins,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::schema::{App, Server, Vpn};

    fn server() -> Server {
        let app = App {
            id: "billing".into(),
            name: "Billing".into(),
            path: "/opt/www/staging/billing".into(),
            branch: None,
            php: None,
            color: None,
            env: Env::Staging,
            env_set: false,
            repo: None,
            url: None,
            vhost_files: vec![],
            supervisor_files: vec![],
            vars: Default::default(),
            actions: vec![],
            hidden: vec![],
        };
        Server {
            id: "s".into(),
            name: "S".into(),
            team: None,
            host: "s".into(),
            env: Env::Staging,
            vpn: Vpn::None,
            vpn_check: None,
            vpn_connect: None,
            check: None,
            color: None,
            new_app: Default::default(),
            apps: vec![app],
            actions: vec![],
            hidden: vec![],
        }
    }

    #[test]
    fn names() {
        assert_eq!(meaningful_name("/var/www/shop/current"), "shop");
        assert_eq!(meaningful_name("/opt/www/app-dev"), "app-dev");
        assert_eq!(meaningful_name("/opt/www/app"), "app");
        assert_eq!(
            meaningful_name("/home/forge/shop.com/public_html"),
            "shop.com"
        );
        assert_eq!(slug("Back Office (Prod)"), "back-office-prod");
        assert_eq!(title("app-dev"), "App Dev");
        assert_eq!(
            php_of("unix:/run/php/php8.4-fpm.sock").as_deref(),
            Some("8.4")
        );
        assert_eq!(php_of("127.0.0.1:9000"), None);
        assert_eq!(php_of("unix:/run/php/php$phpversion-fpm.sock"), None);
        assert_eq!(
            socket_var("unix:/run/php/php$phpversion-fpm.sock").as_deref(),
            Some("phpversion")
        );
        assert_eq!(env_of("production"), Some(Env::Prod));
        assert_eq!(env_of("local"), None);
        assert_eq!(
            root_matches("/opt/www/es/$subdomain/public", "/opt/www/es/pekemall"),
            Some(vec![("subdomain".into(), "pekemall".into())])
        );
        assert_eq!(
            root_matches("/opt/www/es/$subdomain/public", "/opt/www/es/a/b"),
            None
        );
        assert_eq!(
            root_matches("/opt/www/x/public", "/opt/www/x"),
            Some(vec![])
        );
        assert_eq!(
            name_pattern("~^(?<subdomain>[^.]+).apps.example.net"),
            Some(("subdomain".into(), ".apps.example.net".into()))
        );
        assert_eq!(
            name_pattern("~^(?<s>[^.]+)\\.x\\.com$"),
            Some(("s".into(), ".x.com".into()))
        );
        assert_eq!(composer_min("^8.2"), Some((8, 2)));
        assert_eq!(composer_min("^7.4|^8.0"), Some((7, 4)));
        assert_eq!(composer_min(">=8.1"), Some((8, 1)));
    }

    #[test]
    fn parses() {
        let out = "@@vh /etc/nginx/sites-enabled/shop\nname shop.test www.shop.test\nroot /var/www/shop/current/public\nfpm unix:/run/php/php8.3-fpm.sock\n\
@@vh /etc/nginx/sites-enabled/my\nroot /opt/www/staging/billing/public\n\
@@vh /etc/nginx/sites-enabled/wild\nssl\nname ~^(?<sub>[^.]+).w.test other.w.test\nroot /srv/$sub/public\nfpm unix:/run/php/php$phpversion-fpm.sock\n\
@@map /etc/nginx/nginx.conf $http_host $phpversion\nmf hostnames\nmk kopeja.w.test 8.4\nmk *.old.test 7.4\nmk default 8.1\n\
@@sup /etc/supervisor/conf.d/shop.conf\npath /var/www/shop/current\ncmd /usr/bin/php8.2 /var/www/shop/current/artisan queue:work\n\
@@cron\ncmd * * * * * cd /srv/kopeja && php8.4 artisan schedule:run\n\
@@phpbins 8.1 8.2 8.3 8.4\n\
@@app /var/www/shop/releases/5\nreal /var/www/shop/releases/5\n\
@@app /var/www/shop/current\nreal /var/www/shop/releases/5\nowner deploy\nlaravel 11.9.2\nenv APP_NAME=Laravel\nenv APP_ENV=production\nbranch main\nrepo https://user:tok@github.com/acme/shop.git\n\
@@app /opt/www/staging/billing\nreal /opt/www/staging/billing\nenv APP_NAME=\"Acme Billing\"\nenv APP_ENV=staging\ncomposerphp ^8.2\n\
@@app /srv/billing\nreal /srv/billing\ncomposerphp ^8.2\n\
@@app /srv/kopeja\nreal /srv/kopeja\n\
@@known /opt/www/staging/billing /opt/www/staging/billing\n";
        let f = parse(out, &server());
        assert_eq!(f.len(), 4);
        let shop = f
            .iter()
            .find(|a| a.path == "/var/www/shop/current")
            .unwrap();
        assert_eq!((shop.name.as_str(), shop.id.as_str()), ("Shop", "shop"));
        assert_eq!(shop.php.as_deref(), Some("8.3"));
        // Workers on another PHP than the site: said.
        assert!(shop.php_note.as_deref().is_some_and(|n| n.contains("8.2")));
        assert_eq!(shop.env, Some(Env::Prod));
        assert_eq!(shop.vhost_files, ["/etc/nginx/sites-enabled/shop"]);
        assert_eq!(shop.supervisor_files, ["/etc/supervisor/conf.d/shop.conf"]);
        assert_eq!(shop.domains, ["shop.test", "www.shop.test"]);
        assert_eq!(
            shop.repo.as_deref(),
            Some("https://github.com/acme/shop.git")
        );
        // Through the map: an entry, and the default (which composer.json rules out).
        let kopeja = f.iter().find(|a| a.path == "/srv/kopeja").unwrap();
        assert_eq!(kopeja.php.as_deref(), Some("8.4"));
        assert!(kopeja
            .php_source
            .as_deref()
            .is_some_and(|s| s.contains("entry kopeja.w.test")));
        assert!(kopeja.php_note.is_none());
        let my = f.iter().find(|a| a.path == "/srv/billing").unwrap();
        assert_eq!(my.id, "billing-2");
        assert_eq!(my.php.as_deref(), Some("8.1"));
        assert!(my
            .php_source
            .as_deref()
            .is_some_and(|s| s.contains("default")));
        assert!(my.php_note.as_deref().is_some_and(|n| n.contains("^8.2")));
        assert_eq!(my.vhost_files, ["/etc/nginx/sites-enabled/wild"]);
        assert_eq!(my.domains, ["billing.w.test"]);
        assert_eq!(my.url.as_deref(), Some("https://billing.w.test"));
        assert_eq!(shop.url.as_deref(), Some("http://shop.test"));
        // No vhost or worker: the lowest installed PHP composer.json allows.
        let known = f.iter().find(|a| a.existing.is_some()).unwrap();
        assert_eq!(known.existing.as_deref(), Some("billing"));
        assert_eq!(known.name, "Acme Billing");
        assert_eq!(known.php.as_deref(), Some("8.2"));
        assert!(known
            .php_source
            .as_deref()
            .is_some_and(|s| s.contains("composer.json")));
    }

    #[test]
    fn finds_wildcard_vhosts() {
        let out = "@@vh /etc/nginx/sites-enabled/staging.x-it.com
ssl
root /opt/www/staging.x.com/$subdomain/public
fpm unix:/run/php/php$phpversion-fpm.sock
name ~^(?<subdomain>[^.]+).staging.x-it.com
st /etc/nginx/php-versions.conf\tset $phpversion \"8.1\"
st /etc/nginx/php-versions.conf\tif ($http_host = \"billing.staging.x-it.com\") 
st /etc/nginx/php-versions.conf\tset $phpversion \"8.4\"
@@vh /etc/nginx/sites-enabled/plain
root /var/www/shop/public
fpm unix:/run/php/php8.3-fpm.sock
name shop.example.com
@@vh /etc/nginx/sites-enabled/fixed
root /srv/$s/public
fpm unix:/run/php/php8.3-fpm.sock
name ~^(?<s>.+)\\.apps\\.example\\.com$
";
        let (ctx, _, _) = parse_ctx(out);
        let w = wildcards_of(&ctx);
        assert_eq!(w.len(), 2, "{w:?}");
        let fixed = w.iter().find(|x| x.root == "/srv/$s").expect("fixed");
        assert_eq!(fixed.suffix, ".apps.example.com");
        assert_eq!(
            fixed.php,
            WildPhp::Fixed {
                version: "8.3".into()
            }
        );
        let stg = w.iter().find(|x| x.var == "subdomain").expect("ifs");
        assert_eq!(stg.root, "/opt/www/staging.x.com/$subdomain");
        assert_eq!(stg.suffix, ".staging.x-it.com");
        assert!(stg.ssl);
        assert_eq!(
            stg.php,
            WildPhp::Ifs {
                file: "/etc/nginx/php-versions.conf".into(),
                var: "phpversion".into(),
                default: Some("8.1".into()),
                hosts: vec![("billing.staging.x-it.com".into(), "8.4".into())],
            }
        );
    }

    #[test]
    fn set_and_if() {
        let v = Vh {
            stmts: vec![
                (
                    "/etc/nginx/php-versions.conf".into(),
                    "set $phpversion \"8.1\"".into(),
                ),
                (
                    "/etc/nginx/php-versions.conf".into(),
                    "if ($http_host = \"a.test\") ".into(),
                ),
                (
                    "/etc/nginx/php-versions.conf".into(),
                    "set $phpversion \"8.4\"".into(),
                ),
                (
                    "/etc/nginx/php-versions.conf".into(),
                    "if ($http_host = \"b.test\") ".into(),
                ),
                (
                    "/etc/nginx/php-versions.conf".into(),
                    "set $phpversion \"8.2\"".into(),
                ),
                (
                    "/etc/nginx/php-versions.conf".into(),
                    "if ($http_host = \"a.test\") ".into(),
                ),
                (
                    "/etc/nginx/php-versions.conf".into(),
                    "set $phpversion \"8.3\"".into(),
                ),
            ],
            ..Vh::default()
        };
        // The last `if` that applies wins; others get the default.
        assert_eq!(
            set_lookup(&v, "phpversion", &["a.test".into()])
                .map(|x| x.0)
                .as_deref(),
            Some("8.3")
        );
        assert_eq!(
            set_lookup(&v, "phpversion", &["b.test".into()])
                .map(|x| x.0)
                .as_deref(),
            Some("8.2")
        );
        let (val, how) = set_lookup(&v, "phpversion", &["c.test".into()]).unwrap();
        assert_eq!(val, "8.1");
        assert!(how.contains("default"));
        assert!(set_lookup(&v, "other", &["a.test".into()]).is_none());
    }

    #[test]
    fn hostname_maps() {
        let m = Map {
            hostnames: true,
            entries: vec![
                ("*.old.test".into(), "7.4".into()),
                (".x.test".into(), "8.0".into()),
                ("default".into(), "8.1".into()),
            ],
            ..Map::default()
        };
        assert_eq!(
            map_lookup(&m, &["a.old.test".into()])
                .map(|x| x.0)
                .as_deref(),
            Some("7.4")
        );
        assert_eq!(
            map_lookup(&m, &["x.test".into()]).map(|x| x.0).as_deref(),
            Some("8.0")
        );
        assert_eq!(
            map_lookup(&m, &["b.x.test".into()]).map(|x| x.0).as_deref(),
            Some("8.0")
        );
        assert_eq!(
            map_lookup(&m, &["new.test".into()]).map(|x| x.1).as_deref(),
            Some("default")
        );
    }

    /// KEMUDI_DISCOVER_IN=/tmp/out.txt cargo test explain_php -- --ignored --nocapture
    #[test]
    #[ignore]
    fn explain_php() {
        if let Ok(f) = std::env::var("KEMUDI_DISCOVER_IN") {
            let out = std::fs::read_to_string(f).expect("read");
            let (ctx, mut found, _) = parse_ctx(&out);
            let mut a = found.pop().expect("an app");
            enrich(&ctx, &mut a);
            println!(
                "{} → {:?}\n  source {:?}\n  note {:?}\n  domains {:?}",
                a.path, a.php, a.php_source, a.php_note, a.domains
            );
        }
    }

    /// KEMUDI_DISCOVER_OUT=/tmp/x cargo test dump_discover -- --ignored
    #[test]
    #[ignore]
    fn dump_discover() {
        if let Ok(out) = std::env::var("KEMUDI_DISCOVER_OUT") {
            std::fs::write(&out, script(&["/opt/www/app".into()], None)).expect("write");
            std::fs::write(
                format!("{out}.php"),
                detect_script("/opt/www/staging.example.com/census", None),
            )
            .expect("write");
        }
    }
}
