//! The file explorer: list a folder on a server (with sudo when it needs
//! it), download a file to ~/Downloads and upload files into a folder, both
//! with `scp` (so it uses your ssh config, keys and the shared connection).
//! Viewing and editing go through `remote_files` (Target::Path).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::actions::render::shell_quote;
use crate::error::{AppError, AppResult};
use crate::remote_files::{errors, lookup, saved_sudo, sudo_prelude, NO_SUDO};
use crate::AppState;

/// More than this many entries in a folder: the rest are left out.
const MAX_ENTRIES: usize = 5000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// "dir", "file", "link" (and "other" for sockets, devices…).
    pub kind: String,
    /// A link that points at a folder.
    pub to_dir: bool,
    pub size: u64,
    /// Seconds since the epoch.
    pub mtime: f64,
    /// `-rw-r--r--`
    pub mode: String,
    pub owner: String,
    pub group: String,
    /// Where a link points.
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The folder (`~` expanded; symlinked folders keep the name you used).
    pub dir: String,
    pub entries: Vec<Entry>,
    /// Read with sudo (not readable as the ssh user).
    pub sudo: bool,
    /// More entries than were listed.
    pub truncated: bool,
}

fn safe_dir(d: &str) -> bool {
    (d == "~" || d.starts_with('/')) && !d.contains(['\n', '\r', '\0'])
}

fn list_script(dir: &str, password: Option<&str>) -> String {
    format!(
        r#"{prelude}d={d}
[ "$d" = "~" ] && d="$HOME"
R=""
if [ ! -d "$d" ] && ! {{ [ -n "$SU" ] && $SU test -d "$d"; }}; then echo "@@err $d isn't a folder (or doesn't exist)"; exit 0; fi
if ! {{ [ -r "$d" ] && [ -x "$d" ]; }}; then
  if [ -n "$SU" ]; then R="$SU"; else echo "@@err can't open $d: {NO_SUDO}"; exit 0; fi
fi
# The path as typed (links kept), so it still matches the app's path.
x=$($R sh -c 'cd "$1" && pwd' _ "$d")
echo "@@dir $x"
[ -n "$R" ] && echo "@@sudo"
echo "@@list"
$R find "$x" -mindepth 1 -maxdepth 1 -printf '%y\t%Y\t%s\t%T@\t%M\t%u\t%g\t%l\t%f\0' 2>/dev/null
"#,
        prelude = sudo_prelude(password),
        d = shell_quote(dir),
    )
}

fn parse_list(out: &str) -> AppResult<Listing> {
    errors(out)?;
    let (head, list) = out
        .split_once("@@list\n")
        .ok_or_else(|| AppError::Invalid("no answer listing the folder".into()))?;
    let dir = head
        .lines()
        .find_map(|l| l.strip_prefix("@@dir "))
        .unwrap_or("/")
        .to_string();
    let mut entries: Vec<Entry> = Vec::new();
    let mut truncated = false;
    for rec in list.split('\0') {
        if rec.trim().is_empty() {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let f: Vec<&str> = rec.splitn(9, '\t').collect();
        if f.len() < 9 {
            continue;
        }
        let kind = match f[0] {
            "d" => "dir",
            "f" => "file",
            "l" => "link",
            _ => "other",
        };
        entries.push(Entry {
            name: f[8].to_string(),
            kind: kind.to_string(),
            to_dir: f[0] == "l" && f[1] == "d",
            size: f[2].parse().unwrap_or(0),
            mtime: f[3].parse().unwrap_or(0.0),
            mode: f[4].to_string(),
            owner: f[5].to_string(),
            group: f[6].to_string(),
            target: (!f[7].is_empty()).then(|| f[7].to_string()),
        });
    }
    // Folders first, then by name (case-insensitive).
    entries.sort_by(|a, b| {
        let d = |e: &Entry| e.kind == "dir" || e.to_dir;
        d(b).cmp(&d(a))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing {
        dir,
        entries,
        sudo: head.lines().any(|l| l == "@@sudo"),
        truncated,
    })
}

/// A folder's contents (`~`: the ssh user's home).
#[tauri::command]
pub async fn files_list(
    state: State<'_, AppState>,
    server_id: String,
    dir: String,
) -> AppResult<Listing> {
    lookup(&state, &server_id)?;
    if !safe_dir(&dir) {
        return Err(AppError::Invalid(format!("{dir} isn't a full path")));
    }
    let password = saved_sudo(&server_id).await;
    let out =
        crate::monitor::run(&state, &server_id, &list_script(&dir, password.as_deref())).await?;
    parse_list(&out)
}

/// `scp` with the host's options: the shared connection, and no
/// RemoteCommand (a `sudo -i` one would break the file transfer).
async fn scp(state: &AppState, host: &str, args: &[String]) -> AppResult<()> {
    let env = state.env_ready().await;
    let hc = crate::ssh::host_config(host, env);
    let out = tokio::process::Command::new("scp")
        .args(&hc.connect_opts)
        .args([
            "-o",
            "RemoteCommand=none",
            "-o",
            "RequestTTY=no",
            "-o",
            "BatchMode=yes",
            "-q",
        ])
        .args(args)
        .env_clear()
        .envs(&env.vars)
        .stdin(std::process::Stdio::null())
        .output()
        .await?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(AppError::Invalid(crate::ssh_hosts::explain(err.trim())))
    }
}

/// `~/Downloads/<name>`, or `name (2).ext` … if that's taken.
fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..1000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn file_name_of(path: &str) -> AppResult<String> {
    let name = path.rsplit('/').next().unwrap_or("").to_string();
    if name.is_empty() || name == "." || name == ".." {
        return Err(AppError::Invalid(format!("{path} isn't a file")));
    }
    Ok(name)
}

/// Copy a file to ~/Downloads (or the folder picked). One only root can
/// read goes through a temporary copy made with sudo; a folder comes down
/// as `name.tar.gz` (`lean`: without vendor, node_modules and .git).
#[tauri::command]
pub async fn files_download(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    to: Option<String>,
    folder: Option<bool>,
    lean: Option<bool>,
) -> AppResult<String> {
    let server = lookup(&state, &server_id)?;
    if !path.starts_with('/') || path.contains(['\n', '\r', '\0']) {
        return Err(AppError::Invalid(format!("{path} isn't a full path")));
    }
    let lean = lean.unwrap_or(false);
    // A folder comes down packed: name.tar.gz.
    let name = if folder.unwrap_or(false) {
        format!("{}.tar.gz", file_name_of(path.trim_end_matches('/'))?)
    } else {
        file_name_of(&path)?
    };
    let downloads = match to.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        // A folder you picked (Settings ▸ Files, or Download to…).
        Some(t) => {
            let p = expand_home(t);
            if !p.is_dir() {
                return Err(AppError::Invalid(format!("{t} isn't a folder on this Mac")));
            }
            p
        }
        None => {
            let d = default_downloads()?;
            std::fs::create_dir_all(&d)?;
            d
        }
    };
    let dest = free_name(&downloads, &name);
    let password = saved_sudo(&server_id).await;
    // Readable as the ssh user? Else make a readable copy with sudo.
    let check = format!(
        r#"{prelude}f={f}
if [ -d "$f" ]; then
  t=$(mktemp /tmp/kemudi-dl-XXXXXX) || {{ echo "@@err no room in /tmp to pack $f"; exit 0; }}
  p=$(dirname -- "$f"); n=$(basename -- "$f")
  tar czf "$t" {excl}-C "$p" -- "$n" 2>/dev/null; rc=$?
  if [ "$rc" -gt 1 ]; then
    [ -n "$SU" ] || {{ rm -f "$t"; echo "@@err can't read all of $f: {NO_SUDO}"; exit 0; }}
    $SU tar czf "$t" {excl}-C "$p" -- "$n" 2>/dev/null; rc=$?
    $SU chown "$(id -un)" "$t"
  fi
  [ "$rc" -le 1 ] || {{ rm -f "$t"; echo "@@err couldn't pack $f (tar exit $rc)"; exit 0; }}
  chmod 600 "$t"; echo "@@copy $t"; exit 0
fi
if [ -r "$f" ]; then echo "@@direct"; exit 0; fi
if [ -z "$SU" ]; then echo "@@err can't read $f: {NO_SUDO}"; exit 0; fi
t=$(mktemp /tmp/kemudi-dl-XXXXXX) && $SU cp "$f" "$t" && $SU chown "$(id -un)" "$t" && chmod 600 "$t" && echo "@@copy $t" || echo "@@err couldn't copy $f to download it"
"#,
        prelude = sudo_prelude(password.as_deref()),
        f = shell_quote(path.trim_end_matches('/')),
        excl = if lean {
            // Top-level only: resources/views/vendor holds published views.
            r#"--anchored --exclude="$n/vendor" --exclude="$n/node_modules" --no-anchored --exclude=.git "#
        } else {
            ""
        },
    );
    let out = crate::monitor::run_for(&state, &server_id, &check, 900).await?;
    errors(&out)?;
    let copy = out
        .lines()
        .find_map(|l| l.strip_prefix("@@copy "))
        .map(str::to_string);
    let source = copy.clone().unwrap_or_else(|| path.clone());
    let result = scp(
        &state,
        &server.host,
        &[
            format!("{}:{source}", server.host),
            dest.display().to_string(),
        ],
    )
    .await;
    if let Some(t) = copy {
        let _ =
            crate::monitor::run(&state, &server_id, &format!("rm -f {}\n", shell_quote(&t))).await;
    }
    result?;
    Ok(dest.display().to_string())
}

/// Copy a file from this Mac into a folder on the server. Refuses to
/// replace a file unless `replace`; a folder only root can write goes
/// through /tmp and `sudo mv` (owned like the folder).
#[tauri::command]
pub async fn files_upload(
    state: State<'_, AppState>,
    server_id: String,
    local: String,
    dir: String,
    replace: bool,
    app_id: Option<String>,
) -> AppResult<String> {
    let server = lookup(&state, &server_id)?;
    let src = PathBuf::from(&local);
    if !src.is_file() {
        return Err(AppError::Invalid(format!(
            "{local} isn't a file (folders can't be uploaded yet)"
        )));
    }
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.contains(['\n', '\r', '\0']))
        .ok_or_else(|| AppError::Invalid(format!("{local} has a name that can't be used")))?
        .to_string();
    if !dir.starts_with('/') || dir.contains(['\n', '\r', '\0']) {
        return Err(AppError::Invalid(format!("{dir} isn't a full path")));
    }
    let target = format!("{}/{name}", dir.trim_end_matches('/'));
    // A fresh temp file name on the server for scp to write to.
    let tmp = format!(
        "/tmp/kemudi-up-{}-{}",
        std::process::id(),
        crate::audit::now_ms()
    );
    scp(
        &state,
        &server.host,
        &[local.clone(), format!("{}:{tmp}", server.host)],
    )
    .await?;
    let password = saved_sudo(&server_id).await;
    let place = place_script(&tmp, &target, replace, password.as_deref());
    let out = crate::monitor::run(&state, &server_id, &place).await?;
    errors(&out)?;
    if out.lines().any(|l| l == "@@exists") {
        return Err(AppError::Invalid(format!("{target} already exists")));
    }
    if !out.lines().any(|l| l == "@@uploaded") {
        return Err(AppError::Invalid(
            "no answer from the server; the upload may not have finished".into(),
        ));
    }
    // History (writes are recorded; downloads aren't).
    if let Ok(log) = state.audit.as_ref() {
        let app = app_id.as_deref().and_then(|id| server.app(id));
        let label = format!("Upload {name}");
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: app.map(|a| a.id.as_str()),
            action_id: "files:upload",
            label: &label,
            env: app.map_or(server.env, |a| a.env).as_str(),
            kind: "edit",
            command: &format!("{local} → {target}"),
            edited: false,
        }) {
            let _ = log.finish(row, Some(0));
        }
    }
    Ok(target)
}

/// Move an uploaded temp file into place (as the user, or with sudo owned
/// like the folder); refuses to replace unless `replace`.
fn place_script(tmp: &str, target: &str, replace: bool, password: Option<&str>) -> String {
    format!(
        r#"{prelude}t={tmp}
f={f}
d=$(dirname "$f")
# (a folder only root can read hides its files from a plain test -e)
if [ "{replace}" != yes ] && {{ [ -e "$f" ] || {{ [ -n "$SU" ] && $SU test -e "$f"; }}; }}; then rm -f "$t"; echo "@@exists"; exit 0; fi
if [ -w "$d" ] && {{ [ ! -e "$f" ] || [ -w "$f" ]; }}; then
  chmod 644 "$t" && mv -f "$t" "$f" && echo "@@uploaded" && exit 0
fi
if [ -z "$SU" ]; then rm -f "$t"; echo "@@err can't write to $d: {NO_SUDO}"; exit 0; fi
o=$($SU stat -c '%U:%G' "$d")
$SU chown "$o" "$t" && $SU chmod 644 "$t" && $SU mv -f "$t" "$f" && echo "@@uploaded" || {{ rm -f "$t"; echo "@@err couldn't move it into $d"; }}
"#,
        prelude = sudo_prelude(password),
        tmp = shell_quote(tmp),
        f = shell_quote(target),
        replace = if replace { "yes" } else { "no" },
    )
}

/// Users and groups worth offering for Change owner: root, the ones with a
/// login (uid/gid ≥ 1000) and the usual web/service accounts.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Principals {
    pub users: Vec<String>,
    pub groups: Vec<String>,
}

const SERVICE_NAMES: [&str; 6] = ["www-data", "nginx", "apache", "nobody", "deploy", "forge"];

fn parse_principals(out: &str) -> Principals {
    let pick = |section: &str| -> Vec<String> {
        let mut names: Vec<String> = out
            .split_once(&format!("@@{section}\n"))
            .map(|(_, rest)| rest.split("\n@@").next().unwrap_or(""))
            .unwrap_or("")
            .lines()
            .filter_map(|l| {
                let mut f = l.split(':');
                let name = f.next()?.to_string();
                let id: u32 = f.nth(1)?.parse().ok()?;
                let keep = id == 0
                    || (1000..60000).contains(&id)
                    || SERVICE_NAMES.contains(&name.as_str());
                keep.then_some(name)
            })
            .collect();
        names.sort();
        names.dedup();
        names
    };
    Principals {
        users: pick("users"),
        groups: pick("groups"),
    }
}

/// Users and groups on the server (from `getent`; read-only).
#[tauri::command]
pub async fn files_principals(
    state: State<'_, AppState>,
    server_id: String,
) -> AppResult<Principals> {
    lookup(&state, &server_id)?;
    let out = crate::monitor::run(
        &state,
        &server_id,
        "echo @@users\ngetent passwd 2>/dev/null || cat /etc/passwd\necho @@groups\ngetent group 2>/dev/null || cat /etc/group\necho @@end\n",
    )
    .await?;
    Ok(parse_principals(&out))
}

/// A user or group name chown accepts (no options, no shell).
fn valid_principal(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_.-".contains(c))
}

fn chown_script(
    path: &str,
    owner: &str,
    group: &str,
    recursive: bool,
    password: Option<&str>,
) -> String {
    format!(
        r#"{prelude}f={f}
if [ ! -e "$f" ] && ! {{ [ -n "$SU" ] && $SU test -e "$f"; }}; then echo "@@err $f doesn't exist"; exit 0; fi
id -u {owner} >/dev/null 2>&1 || {{ echo "@@err there's no user {owner} on this server"; exit 0; }}
getent group {group} >/dev/null 2>&1 || grep -q "^{group}:" /etc/group || {{ echo "@@err there's no group {group} on this server"; exit 0; }}
S=""
[ "$(id -u)" = 0 ] || S="$SU"
if [ -z "$S" ] && [ "$(id -u)" != 0 ]; then echo "@@err changing the owner needs root: {NO_SUDO}"; exit 0; fi
out=$($S chown {r}-h -- {owner}:{group} "$f" 2>&1) || {{ echo "@@err $(printf '%s' "$out" | head -3 | tr '\n' ' ')"; exit 0; }}
echo "@@done $($S stat -c '%U:%G' "$f")"
"#,
        prelude = sudo_prelude(password),
        f = shell_quote(path),
        owner = owner,
        group = group,
        r = if recursive { "-R " } else { "" },
    )
}

/// `chown [-R] owner:group` a file or folder (with sudo), recorded in History.
#[tauri::command]
pub async fn files_chown(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    owner: String,
    group: String,
    recursive: bool,
    app_id: Option<String>,
) -> AppResult<String> {
    let server = lookup(&state, &server_id)?;
    if !path.starts_with('/')
        || path.contains(['\n', '\r', '\0'])
        || path.trim_end_matches('/').is_empty()
    {
        return Err(AppError::Invalid(format!(
            "{path} isn't a path Kemudi changes"
        )));
    }
    if !valid_principal(&owner) || !valid_principal(&group) {
        return Err(AppError::Invalid(
            "user and group names are lowercase letters, digits, _ . -".into(),
        ));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &chown_script(&path, &owner, &group, recursive, password.as_deref()),
    )
    .await?;
    let result = errors(&out).and_then(|()| {
        out.lines()
            .find_map(|l| l.strip_prefix("@@done "))
            .map(str::to_string)
            .ok_or_else(|| AppError::Invalid("no answer from the server".into()))
    });
    if let Ok(log) = state.audit.as_ref() {
        let app = app_id.as_deref().and_then(|id| server.app(id));
        let what = format!(
            "chown {}{owner}:{group} {path}",
            if recursive { "-R " } else { "" }
        );
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: app.map(|a| a.id.as_str()),
            action_id: "files:chown",
            label: "Change owner",
            env: app.map_or(server.env, |a| a.env).as_str(),
            kind: "edit",
            command: &what,
            edited: false,
        }) {
            let _ = log.finish(row, Some(i32::from(result.is_err())));
        }
    }
    result
}

fn valid_mode(mode: &str) -> bool {
    (3..=4).contains(&mode.len()) && mode.chars().all(|c| ('0'..='7').contains(&c))
}

/// chmod a file or folder; with `files_mode`, everything inside too
/// (folders get `mode`, files `files_mode`; links are left alone). As the
/// user when they own it, else with sudo. Partly failed recursive runs say
/// so (chmod changes what it can).
fn chmod_script(
    path: &str,
    mode: &str,
    files_mode: Option<&str>,
    password: Option<&str>,
) -> String {
    let run = match files_mode {
        None => r#"out=$($S chmod MODE -- "$f" 2>&1) || { echo "@@err $(printf '%s' "$out" | head -3 | tr '\n' ' ')"; exit 0; }"#.replace("MODE", mode),
        Some(fm) => r#"out=$( { $S find "$f" -type d -exec chmod MODE {} + ; } 2>&1 ); a=$?
out2=$( { $S find "$f" -type f -exec chmod FMODE {} + ; } 2>&1 ); b=$?
if [ $a -ne 0 ] || [ $b -ne 0 ]; then echo "@@err some of it couldn't be changed: $(printf '%s\n%s' "$out" "$out2" | grep -v '^$' | head -3 | tr '\n' ' ')"; exit 0; fi"#
            .replace("FMODE", fm)
            .replace("MODE", mode),
    };
    format!(
        r#"{prelude}f={f}
if [ ! -e "$f" ] && ! {{ [ -n "$SU" ] && $SU test -e "$f"; }}; then echo "@@err $f doesn't exist"; exit 0; fi
S=""
if [ "$(id -u)" != 0 ] && {{ [ "{recursive}" = yes ] || [ ! -O "$f" ]; }}; then
  S="$SU"
  if [ -z "$S" ] && [ ! -O "$f" ]; then echo "@@err only its owner or root can change it: {NO_SUDO}"; exit 0; fi
fi
{run}
echo "@@done $($S stat -c '%a' "$f")"
"#,
        prelude = sudo_prelude(password),
        f = shell_quote(path),
        recursive = if files_mode.is_some() { "yes" } else { "no" },
    )
}

/// `chmod` a file or folder (and optionally everything inside), recorded in
/// History.
#[tauri::command]
pub async fn files_chmod(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    mode: String,
    files_mode: Option<String>,
    app_id: Option<String>,
) -> AppResult<String> {
    let server = lookup(&state, &server_id)?;
    if !path.starts_with('/')
        || path.contains(['\n', '\r', '\0'])
        || path.trim_end_matches('/').is_empty()
    {
        return Err(AppError::Invalid(format!(
            "{path} isn't a path Kemudi changes"
        )));
    }
    if !valid_mode(&mode) || files_mode.as_deref().is_some_and(|m| !valid_mode(m)) {
        return Err(AppError::Invalid(
            "a mode is 3 or 4 octal digits, like 644 or 2775".into(),
        ));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &chmod_script(&path, &mode, files_mode.as_deref(), password.as_deref()),
    )
    .await?;
    let result = errors(&out).and_then(|()| {
        out.lines()
            .find_map(|l| l.strip_prefix("@@done "))
            .map(str::to_string)
            .ok_or_else(|| AppError::Invalid("no answer from the server".into()))
    });
    if let Ok(log) = state.audit.as_ref() {
        let app = app_id.as_deref().and_then(|id| server.app(id));
        let what = match &files_mode {
            Some(fm) => format!("chmod folders {mode}, files {fm} (recursive) {path}"),
            None => format!("chmod {mode} {path}"),
        };
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: app.map(|a| a.id.as_str()),
            action_id: "files:chmod",
            label: "Change permissions",
            env: app.map_or(server.env, |a| a.env).as_str(),
            kind: "edit",
            command: &what,
            edited: false,
        }) {
            let _ = log.finish(row, Some(i32::from(result.is_err())));
        }
    }
    result
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 255
        && !name.contains(['/', '\n', '\r', '\0'])
}

/// Paths Delete refuses: the top two levels (/etc, /opt/www, /home/x…),
/// and an app's own folder.
fn protected(path: &str, server: &crate::config::schema::Server) -> Option<String> {
    let p = path.trim_end_matches('/');
    let depth = p.split('/').filter(|s| !s.is_empty()).count();
    if depth < 3 {
        return Some(format!(
            "{p} is too close to the top of the file system to delete from here"
        ));
    }
    server
        .apps
        .iter()
        .find(|a| a.path.trim_end_matches('/') == p)
        .map(|a| {
            format!(
                "{p} is {}'s folder; delete the app first if you really mean it",
                a.name
            )
        })
}

fn rename_script(path: &str, name: &str, password: Option<&str>) -> String {
    format!(
        r#"{prelude}f={f}
n={n}
d=$(dirname "$f")
t="$d/$n"
seen() {{ [ -e "$1" ] || [ -L "$1" ] || {{ [ -n "$SU" ] && $SU test -e "$1"; }}; }}
seen "$f" || {{ echo "@@err $f doesn't exist"; exit 0; }}
if seen "$t"; then echo "@@err $t already exists"; exit 0; fi
S=""
if [ ! -w "$d" ]; then S="$SU"; [ -n "$S" ] || {{ echo "@@err can't rename in $d: {NO_SUDO}"; exit 0; }}; fi
out=$($S mv -n -- "$f" "$t" 2>&1) || {{ echo "@@err $(printf '%s' "$out" | head -3 | tr '\n' ' ')"; exit 0; }}
if [ -e "$f" ] || [ -L "$f" ] || {{ [ -n "$S" ] && $S test -e "$f"; }}; then echo "@@err it couldn't be renamed"; exit 0; fi
echo "@@done $t"
"#,
        prelude = sudo_prelude(password),
        f = shell_quote(path),
        n = shell_quote(name),
    )
}

fn delete_script(path: &str, password: Option<&str>) -> String {
    format!(
        r#"{prelude}f={f}
d=$(dirname "$f")
seen() {{ [ -e "$1" ] || [ -L "$1" ] || {{ [ -n "$SU" ] && $SU test -e "$1"; }}; }}
seen "$f" || {{ echo "@@err $f doesn't exist"; exit 0; }}
S=""
if [ ! -w "$d" ] || {{ [ -d "$f" ] && [ ! -L "$f" ]; }}; then S="$SU"; fi
if [ -z "$S" ] && [ ! -w "$d" ]; then echo "@@err can't delete in $d: {NO_SUDO}"; exit 0; fi
out=$($S rm -rf --one-file-system -- "$f" 2>&1)
if seen "$f"; then echo "@@err some of it couldn't be deleted: $(printf '%s' "$out" | head -3 | tr '\n' ' ')"; exit 0; fi
echo "@@done"
"#,
        prelude = sudo_prelude(password),
        f = shell_quote(path),
    )
}

fn record(
    state: &AppState,
    server: &crate::config::schema::Server,
    app_id: Option<&str>,
    action: &str,
    label: &str,
    what: &str,
    ok: bool,
) {
    if let Ok(log) = state.audit.as_ref() {
        let app = app_id.and_then(|id| server.app(id));
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: app.map(|a| a.id.as_str()),
            action_id: action,
            label,
            env: app.map_or(server.env, |a| a.env).as_str(),
            kind: "edit",
            command: what,
            edited: false,
        }) {
            let _ = log.finish(row, Some(i32::from(!ok)));
        }
    }
}

fn check_path(path: &str) -> AppResult<()> {
    if !path.starts_with('/')
        || path.contains(['\n', '\r', '\0'])
        || path.trim_end_matches('/').is_empty()
    {
        return Err(AppError::Invalid(format!(
            "{path} isn't a path Kemudi changes"
        )));
    }
    Ok(())
}

fn done_line(out: &str) -> AppResult<String> {
    errors(out)?;
    out.lines()
        .find_map(|l| l.strip_prefix("@@done").map(|r| r.trim().to_string()))
        .ok_or_else(|| AppError::Invalid("no answer from the server".into()))
}

/// Rename a file or folder in place (never over an existing one).
#[tauri::command]
pub async fn files_rename(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    name: String,
    app_id: Option<String>,
) -> AppResult<String> {
    let server = lookup(&state, &server_id)?;
    check_path(&path)?;
    let name = name.trim().to_string();
    if !valid_name(&name) {
        return Err(AppError::Invalid(
            "a name can't be empty, . or .., or contain /".into(),
        ));
    }
    if let Some(why) =
        protected(&path, &server).filter(|_| path.split('/').filter(|s| !s.is_empty()).count() < 3)
    {
        return Err(AppError::Invalid(why.replace("delete", "rename")));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &rename_script(&path, &name, password.as_deref()),
    )
    .await?;
    let result = done_line(&out);
    record(
        &state,
        &server,
        app_id.as_deref(),
        "files:rename",
        "Rename",
        &format!("mv {path} → {name}"),
        result.is_ok(),
    );
    result
}

/// Delete a file or a folder with everything in it (never the top levels or
/// an app's own folder). Recorded in History.
#[tauri::command]
pub async fn files_delete(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    app_id: Option<String>,
) -> AppResult<()> {
    let server = lookup(&state, &server_id)?;
    check_path(&path)?;
    if let Some(why) = protected(&path, &server) {
        return Err(AppError::Invalid(why));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &delete_script(&path, password.as_deref()),
    )
    .await?;
    let result = done_line(&out).map(|_| ());
    record(
        &state,
        &server,
        app_id.as_deref(),
        "files:delete",
        "Delete",
        &format!("rm -rf {path}"),
        result.is_ok(),
    );
    result
}

/// mkdir / an empty file in `dir`; never over an existing name. Made
/// with sudo, it's owned like the folder it's in (not by root).
fn create_script(dir: &str, name: &str, folder: bool, password: Option<&str>) -> String {
    format!(
        r#"{prelude}d={d}
t="$d/"{n}
seen() {{ [ -e "$1" ] || [ -L "$1" ] || {{ [ -n "$SU" ] && $SU test -e "$1"; }}; }}
seen "$d" || {{ echo "@@err $d doesn't exist"; exit 0; }}
if seen "$t"; then echo "@@err $t already exists"; exit 0; fi
S=""
if [ ! -w "$d" ]; then S="$SU"; [ -n "$S" ] || {{ echo "@@err can't create in $d: {NO_SUDO}"; exit 0; }}; fi
out=$({make} 2>&1) || {{ echo "@@err $(printf '%s' "$out" | head -3 | tr '\n' ' ')"; exit 0; }}
if [ -n "$S" ]; then $S chown "$($S stat -c '%U:%G' "$d")" "$t" 2>/dev/null; fi
echo "@@done $t"
"#,
        prelude = sudo_prelude(password),
        d = shell_quote(dir.trim_end_matches('/')),
        n = shell_quote(name),
        make = if folder {
            r#"$S mkdir -m 755 -- "$t""#
        } else {
            r#"$S sh -c 'umask 022 && set -C && : > "$1"' _ "$t""#
        },
    )
}

/// A new folder or empty file in `dir`; returns its path.
#[tauri::command]
pub async fn files_create(
    state: State<'_, AppState>,
    server_id: String,
    dir: String,
    name: String,
    folder: bool,
    app_id: Option<String>,
) -> AppResult<String> {
    let server = lookup(&state, &server_id)?;
    check_path(&dir)?;
    let name = name.trim().to_string();
    if !valid_name(&name) {
        return Err(AppError::Invalid(
            "a name can't be empty, . or .., or contain /".into(),
        ));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &create_script(&dir, &name, folder, password.as_deref()),
    )
    .await?;
    let result = done_line(&out);
    let what = format!(
        "{} {}/{name}",
        if folder { "mkdir" } else { "new file" },
        dir.trim_end_matches('/')
    );
    record(
        &state,
        &server,
        app_id.as_deref(),
        "files:create",
        if folder { "New folder" } else { "New file" },
        &what,
        result.is_ok(),
    );
    result
}

/// Copy or move `src` into folder `dir` (as `name`, or its own name).
/// Never over something that exists; `dup` (a copy into its own folder)
/// picks "name copy", "name copy 2"… With sudo when we can't write there
/// (`cp -a` keeps owners and modes).
fn paste_script(src: &str, dir: &str, cut: bool, dup: bool, password: Option<&str>) -> String {
    format!(
        r#"{prelude}s={s}
d={d}
seen() {{ [ -e "$1" ] || [ -L "$1" ] || {{ [ -n "$SU" ] && $SU test -e "$1"; }}; }}
seen "$s" || {{ echo "@@err $s doesn't exist any more"; exit 0; }}
[ -d "$d" ] || {{ [ -n "$SU" ] && $SU test -d "$d"; }} || {{ echo "@@err $d isn't a folder"; exit 0; }}
n=${{s##*/}}
case "$d/" in "$s/"*) echo "@@err can't put $s inside itself"; exit 0 ;; esac
t="$d/$n"
if [ {dup} = 1 ]; then
  b=$n; e=""
  if [ ! -d "$s" ]; then case "$n" in ?*.*) b=${{n%.*}}; e=".${{n##*.}}" ;; esac; fi
  t="$d/$b copy$e"; i=2
  while seen "$t"; do t="$d/$b copy $i$e"; i=$((i + 1)); done
fi
if seen "$t"; then echo "@@err $t already exists"; exit 0; fi
S=""
if [ ! -w "$d" ] || {{ [ {cut} = 1 ] && [ ! -w "${{s%/*}}/" ]; }} || {{ [ {cut} = 0 ] && [ ! -r "$s" ]; }}; then
  S="$SU"; [ -n "$S" ] || {{ echo "@@err can't {verb} there: {NO_SUDO}"; exit 0; }}
fi
if [ {cut} = 1 ]; then out=$($S mv -- "$s" "$t" 2>&1); else out=$($S cp -a -- "$s" "$t" 2>&1); fi
[ $? = 0 ] || {{ echo "@@err $(printf '%s' "$out" | head -3 | tr '\n' ' ')"; exit 0; }}
echo "@@done $t"
"#,
        prelude = sudo_prelude(password),
        s = shell_quote(src.trim_end_matches('/')),
        d = shell_quote(if dir == "/" {
            ""
        } else {
            dir.trim_end_matches('/')
        }),
        dup = u8::from(dup),
        cut = u8::from(cut),
        verb = if cut { "move it" } else { "copy it" },
    )
}

/// Paste: copy (or, `cut`, move) a file or folder into `dir`. A copy into
/// its own folder becomes "name copy". Moving never takes the top levels
/// or an app's folder. Recorded in History.
#[tauri::command]
pub async fn files_paste(
    state: State<'_, AppState>,
    server_id: String,
    src: String,
    dir: String,
    cut: bool,
    app_id: Option<String>,
) -> AppResult<String> {
    let server = lookup(&state, &server_id)?;
    check_path(&src)?;
    if !dir.starts_with('/') || dir.contains(['\n', '\r', '\0']) {
        return Err(AppError::Invalid(format!("{dir} isn't a full path")));
    }
    if cut {
        if let Some(why) = protected(&src, &server) {
            return Err(AppError::Invalid(
                why.replace("delete", "move")
                    .replace("delete the app first", "remove the app first"),
            ));
        }
    }
    let parent = src
        .trim_end_matches('/')
        .rsplit_once('/')
        .map_or("/", |(p, _)| if p.is_empty() { "/" } else { p });
    let same =
        parent.trim_end_matches('/') == dir.trim_end_matches('/') || (parent == "/" && dir == "/");
    if cut && same {
        return Err(AppError::Invalid("it's already in this folder".into()));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_for(
        &state,
        &server_id,
        &paste_script(&src, &dir, cut, same, password.as_deref()),
        900,
    )
    .await?;
    let result = done_line(&out);
    let target = result.as_deref().unwrap_or(dir.as_str()).to_string();
    record(
        &state,
        &server,
        app_id.as_deref(),
        if cut { "files:move" } else { "files:copy" },
        if cut { "Move" } else { "Copy" },
        &format!("{} {src} → {target}", if cut { "mv" } else { "cp -a" }),
        result.is_ok(),
    );
    result
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub path: String,
    /// "dir", "file", "link"…
    pub kind: String,
    /// Contents search: the line number and the line.
    pub line: Option<u64>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub found: Vec<Found>,
    /// More matches than were listed.
    pub more: bool,
    /// Stopped after the time limit.
    pub timed_out: bool,
    pub sudo: bool,
}

const FIND_MAX: usize = 500;

fn find_script(
    dir: &str,
    query: &str,
    contents: bool,
    skip_deps: bool,
    password: Option<&str>,
) -> String {
    let prune = if skip_deps {
        r#"\( -name vendor -o -name node_modules -o -name .git \) -prune -o"#
    } else {
        ""
    };
    let excl = if skip_deps {
        "--exclude-dir=vendor --exclude-dir=node_modules --exclude-dir=.git"
    } else {
        ""
    };
    let search = if contents {
        format!(
            r#"$R timeout 25 grep -rIniZ -m 5 {excl} -F -- "$q" "$d" 2>/dev/null | head -n {max} | cut -c1-600"#,
            max = FIND_MAX * 2 + 1
        )
    } else {
        format!(
            r#"$R timeout 25 find "$d" -mindepth 1 {prune} -iname "*$q*" -printf '%y\t%p\n' 2>/dev/null | head -n {max}"#,
            max = FIND_MAX + 1
        )
    };
    format!(
        r#"{prelude}d={d}
q={q}
R=""
if ! {{ [ -r "$d" ] && [ -x "$d" ]; }}; then
  [ -n "$SU" ] || {{ echo "@@err can't search $d: {NO_SUDO}"; exit 0; }}
  R="$SU"; echo "@@sudo"
fi
echo "@@found"
{search}
echo "@@rc $?"
"#,
        prelude = sudo_prelude(password),
        d = shell_quote(dir.trim_end_matches('/')),
        q = shell_quote(query),
    )
}

fn parse_find(out: &str, contents: bool) -> AppResult<FindResult> {
    errors(out)?;
    let body = out.split_once("@@found\n").map_or("", |(_, b)| b);
    let (body, rc) = match body.rsplit_once("@@rc ") {
        Some((b, rc)) => (b, rc.trim().parse::<i32>().unwrap_or(0)),
        None => (body, 0),
    };
    let mut found = Vec::new();
    let mut more = false;
    for l in body.lines() {
        if l.is_empty() {
            continue;
        }
        if found.len() >= FIND_MAX {
            more = true;
            break;
        }
        if contents {
            // path\0line:text
            let Some((path, rest)) = l.split_once('\0') else {
                continue;
            };
            let (n, text) = rest.split_once(':').unwrap_or(("", rest));
            found.push(Found {
                path: path.to_string(),
                kind: "file".into(),
                line: n.parse().ok(),
                text: Some(text.trim().to_string()),
            });
        } else {
            let Some((y, path)) = l.split_once('\t') else {
                continue;
            };
            found.push(Found {
                path: path.to_string(),
                kind: match y {
                    "d" => "dir",
                    "f" => "file",
                    "l" => "link",
                    _ => "other",
                }
                .into(),
                line: None,
                text: None,
            });
        }
    }
    Ok(FindResult {
        found,
        more,
        // `timeout` exits 124 (the pipeline's last command is head/cut, so
        // this only shows when nothing came out at all).
        timed_out: rc == 124,
        sudo: out.lines().any(|l| l == "@@sudo"),
    })
}

/// Find files under `dir` by name (`*query*`, any case) or by what's in
/// them (`contents`; text files, first 5 matches each). `skip_deps` leaves
/// out vendor, node_modules and .git. At most 500 results, ~25 s.
#[tauri::command]
pub async fn files_find(
    state: State<'_, AppState>,
    server_id: String,
    dir: String,
    query: String,
    contents: bool,
    skip_deps: bool,
) -> AppResult<FindResult> {
    lookup(&state, &server_id)?;
    if !safe_dir(&dir) || dir == "~" {
        return Err(AppError::Invalid(format!("{dir} isn't a full path")));
    }
    let query = query.trim().to_string();
    if query.is_empty() || query.contains(['\n', '\r', '\0']) {
        return Err(AppError::Invalid("type something to find".into()));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_for(
        &state,
        &server_id,
        &find_script(&dir, &query, contents, skip_deps, password.as_deref()),
        45,
    )
    .await?;
    parse_find(&out, contents)
}

fn default_downloads() -> AppResult<PathBuf> {
    dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .ok_or_else(|| AppError::Invalid("no Downloads folder".into()))
}

fn expand_home(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(h)) => h.join(rest),
        _ if p == "~" => dirs::home_dir().unwrap_or_else(|| PathBuf::from(p)),
        _ => PathBuf::from(p),
    }
}

/// The macOS folder picker (via osascript: no extra plugin). None when
/// cancelled.
#[tauri::command]
pub async fn files_choose_folder(start: Option<String>) -> AppResult<Option<String>> {
    let start = start
        .map(|s| expand_home(&s))
        .filter(|p| p.is_dir())
        .or_else(|| default_downloads().ok())
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let script = if start.is_empty() {
        "POSIX path of (choose folder with prompt \"Download to\")".to_string()
    } else {
        format!(
            "POSIX path of (choose folder with prompt \"Download to\" default location (POSIX file \"{}\"))",
            start.replace('\\', "\\\\").replace('"', "\\\"")
        )
    };
    let out = tokio::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .await?;
    if !out.status.success() {
        return Ok(None); // cancelled (error -128) or no dialog
    }
    let path = String::from_utf8_lossy(&out.stdout)
        .trim()
        .trim_end_matches('/')
        .to_string();
    Ok((!path.is_empty()).then_some(path))
}

/// Show a downloaded file in Finder (only inside your home folder).
#[tauri::command]
pub async fn files_reveal(path: String) -> AppResult<()> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Invalid("no home folder".into()))?;
    let p = PathBuf::from(&path);
    if !p.starts_with(&home) || path.contains("..") {
        return Err(AppError::Invalid("only files in your home folder".into()));
    }
    std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&p)
        .spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_listing() {
        let out = "@@dir /opt/www/app\n@@list\nf\tf\t120\t1700000000.5\t-rw-r--r--\twww-data\twww-data\t\t.env\0d\td\t4096\t1700000001\tdrwxr-xr-x\twww-data\twww-data\t\tapp\0l\td\t7\t1700000002\tlrwxrwxrwx\troot\troot\t/srv/shared\tstorage\0l\tf\t4\t1\tlrwxrwxrwx\troot\troot\tx.txt\tAlpha link\0";
        let l = parse_list(out).unwrap();
        assert_eq!(l.dir, "/opt/www/app");
        assert!(!l.sudo && !l.truncated);
        let names: Vec<&str> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            ["app", "storage", ".env", "Alpha link"],
            "folders (and links to them) first"
        );
        let link = &l.entries[1];
        assert_eq!(
            (link.kind.as_str(), link.to_dir, link.target.as_deref()),
            ("link", true, Some("/srv/shared"))
        );
        assert_eq!(l.entries[2].size, 120);
        assert!(parse_list("@@err /x isn't a folder\n").is_err());
        assert!(parse_list("@@dir /root\n@@sudo\n@@list\n").unwrap().sudo);
    }

    #[test]
    fn principals_and_names() {
        let out = "@@users\nroot:x:0:0::/root:/bin/bash\ndaemon:x:1:1::/:/usr/sbin/nologin\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\ndeploy:x:1000:1000::/home/deploy:/bin/bash\nnobody:x:65534:65534::/:/usr/sbin/nologin\n@@groups\nroot:x:0:\nwww-data:x:33:deploy\ndeploy:x:1000:\nsudo:x:27:deploy\n@@end\n";
        let p = parse_principals(out);
        assert_eq!(p.users, ["deploy", "nobody", "root", "www-data"]);
        assert_eq!(p.groups, ["deploy", "root", "www-data"]);
        assert!(valid_principal("www-data") && valid_principal("_apt"));
        assert!(
            !valid_principal("root:wheel")
                && !valid_principal("-R")
                && !valid_principal("a b")
                && !valid_principal("Root")
        );
    }

    #[test]
    fn modes() {
        assert!(valid_mode("644") && valid_mode("2775") && valid_mode("0755"));
        assert!(
            !valid_mode("888") && !valid_mode("64") && !valid_mode("u+x") && !valid_mode("12345")
        );
    }

    #[test]
    fn delete_and_rename_guards() {
        let mut app = crate::config::schema::App {
            id: "core".into(),
            name: "Core".into(),
            path: "/opt/www/app/".into(),
            branch: None,
            php: None,
            color: None,
            env: crate::config::schema::Env::Prod,
            env_set: false,
            repo: None,
            url: None,
            vhost_files: vec![],
            supervisor_files: vec![],
            vars: Default::default(),
            actions: vec![],
            hidden: vec![],
        };
        app.path = "/opt/www/app/".into();
        let server = crate::config::schema::Server {
            id: "acme".into(),
            name: "Acme".into(),
            team: None,
            host: "acme-host".into(),
            env: crate::config::schema::Env::Prod,
            vpn: crate::config::schema::Vpn::None,
            vpn_check: None,
            vpn_connect: None,
            check: None,
            color: None,
            new_app: Default::default(),
            apps: vec![app],
            actions: vec![],
            hidden: vec![],
        };
        for p in ["/", "/etc", "/opt/www", "/home/deploy/", "/root"] {
            assert!(protected(p, &server).is_some(), "{p}");
        }
        assert!(
            protected("/opt/www/app", &server).is_some(),
            "the app's own folder"
        );
        assert!(protected("/opt/www/app/storage/logs/old.log", &server).is_none());
        assert!(protected("/etc/nginx/sites-available/x", &server).is_none());
        assert!(valid_name("laravel-2026.log") && valid_name(".env.backup"));
        assert!(!valid_name("a/b") && !valid_name("..") && !valid_name(""));
    }

    #[test]
    fn download_names_dont_clobber() {
        let dir = std::env::temp_dir().join(format!("kemudi-dl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_name(&dir, "laravel.log"), dir.join("laravel.log"));
        std::fs::write(dir.join("laravel.log"), "x").unwrap();
        assert_eq!(free_name(&dir, "laravel.log"), dir.join("laravel (2).log"));
        std::fs::write(dir.join(".env"), "x").unwrap();
        assert_eq!(free_name(&dir, ".env"), dir.join(".env (2)"));
        let _ = std::fs::remove_dir_all(dir);
        assert!(file_name_of("/opt/www/").is_err());
        assert_eq!(file_name_of("/opt/www/app/.env").unwrap(), ".env");
    }

    /// The listing script, for a run on Linux (GNU find):
    /// KEMUDI_FILES_OUT=file cargo test dump_list -- --ignored
    #[test]
    fn finds() {
        let r = parse_find("@@sudo\n@@found\nf\t/a/b.php\nd\t/a/c\n@@rc 0\n", false).unwrap();
        assert_eq!(r.found.len(), 2);
        assert_eq!(r.found[1].kind, "dir");
        assert!(r.sudo);
        let r = parse_find("@@found\n/a/b.php\x0012:  $x = 1;\n@@rc 0\n", true).unwrap();
        assert_eq!(r.found[0].line, Some(12));
        assert_eq!(r.found[0].text.as_deref(), Some("$x = 1;"));
        assert!(parse_find("@@found\n@@rc 124\n", true).unwrap().timed_out);
    }

    /// KEMUDI_OPS_OUT=/tmp/x cargo test dump_file_ops -- --ignored
    #[test]
    #[ignore]
    fn dump_file_ops() {
        if let Ok(out) = std::env::var("KEMUDI_OPS_OUT") {
            let pw = std::env::var("KEMUDI_RF_PW").ok();
            let pw = pw.as_deref();
            let w = |n: &str, s: String| std::fs::write(format!("{out}.{n}"), s).expect("write");
            w(
                "dup",
                paste_script("/srv/secret/a.txt", "/srv/secret", false, true, pw),
            );
            w(
                "dupdir",
                paste_script("/srv/secret/sub", "/srv/secret", false, true, pw),
            );
            w(
                "copy",
                paste_script("/srv/secret/a.txt", "/srv/pub", false, false, pw),
            );
            w(
                "move",
                paste_script("/srv/pub/a.txt", "/srv/secret/sub", true, false, pw),
            );
            w(
                "inside",
                paste_script("/srv/secret", "/srv/secret/sub", true, false, pw),
            );
            w("findname", find_script("/srv/secret", "A", false, true, pw));
            w(
                "findtext",
                find_script("/srv/secret", "needle", true, true, pw),
            );
        }
    }

    #[test]
    #[ignore]
    fn dump_list_script() {
        if let Ok(out) = std::env::var("KEMUDI_FILES_OUT") {
            let pw = std::env::var("KEMUDI_RF_PW").ok();
            std::fs::write(&out, list_script("/srv/secret", pw.as_deref())).expect("write");
            std::fs::write(
                format!("{out}.chown"),
                chown_script("/srv/secret", "www-data", "deploy", true, pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.chmod"),
                chmod_script("/srv/secret/sub/a.txt", "640", None, pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.chmodr"),
                chmod_script("/srv/secret", "2775", Some("664"), pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.rename"),
                rename_script("/srv/secret/sub/a.txt", "b 2.txt", pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.renameclash"),
                rename_script("/srv/secret/sub/b 2.txt", "c.txt", pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.mkdir"),
                create_script("/srv/secret", "new dir", true, pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.touch"),
                create_script("/srv/secret", ".env.example", false, pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.delete"),
                delete_script("/srv/secret/sub", pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.badchown"),
                chown_script("/srv/secret", "nosuchuser", "deploy", false, pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.place"),
                place_script(
                    "/tmp/kemudi-up-test",
                    "/srv/secret/up.txt",
                    false,
                    pw.as_deref(),
                ),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.replace"),
                place_script(
                    "/tmp/kemudi-up-test",
                    "/srv/secret/up.txt",
                    true,
                    pw.as_deref(),
                ),
            )
            .expect("write");
        }
    }
}
