//! Editing config files on a server: read one (with its sha256), then write
//! it back only if it hasn't changed since, keeping a timestamped backup and
//! the owner/mode of the original. The new content travels inside the script
//! on ssh's stdin (base64), never on a command line, so it isn't visible in
//! `ps` on either side. Each write is recorded in History by file and (for
//! .env) key names only, never values.
//!
//! Only files Kemudi can name itself are editable: an app's `.env` (its path
//! comes from servers.yaml), Supervisor configs, /etc/crontab and
//! /etc/cron.d files, and a user's crontab.

use std::collections::BTreeMap;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::actions::render::shell_quote;
use crate::config::schema::Server;
use crate::error::{AppError, AppResult};
use crate::AppState;

/// How many backups to keep per file (oldest removed first).
const KEEP_BACKUPS: usize = 5;
const MAX_SIZE: usize = 512 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// `<app.path>/.env`
    Env {
        #[serde(rename = "appId")]
        app_id: String,
    },
    /// A Supervisor program config (`/etc/supervisor/conf.d/*.conf`, …).
    Supervisor { file: String },
    /// `/etc/crontab` or a file in `/etc/cron.d`.
    CronFile { file: String },
    /// A user's crontab (`crontab -l` / `crontab -`); none = the ssh user.
    Crontab { user: Option<String> },
    /// An nginx / Apache vhost (`/etc/nginx/…`, `/etc/apache2/…`,
    /// `/etc/httpd/…` or a file pinned on an app).
    Vhost { file: String, web: Web },
    /// Any file, opened from the file explorer.
    Path { path: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Web {
    Nginx,
    Apache,
}

/// How a file kind is saved.
#[derive(Debug, Clone, Copy, Default)]
struct Plan {
    /// Backups go to ~/.kemudi-backups, not next to the file: nginx and
    /// Apache load every file in sites-enabled, a copy there included.
    home_backups: bool,
    /// Run after a save / restore; its output comes back as `check`.
    after: Option<&'static str>,
    /// A config test run before and after a save: if the change makes it
    /// fail, the old file goes straight back.
    test: Option<&'static str>,
}

/// What a target points at on the server.
enum Resolved {
    File {
        path: String,
        /// The Laravel app folder (.env: to see whether config is cached).
        app_dir: Option<String>,
    },
    Crontab {
        user: Option<String>,
    },
}

const WEB_DIRS: [&str; 3] = ["/etc/nginx/", "/etc/apache2/", "/etc/httpd/"];

const SUPERVISOR_DIRS: [&str; 3] = [
    "/etc/supervisor/",
    "/etc/supervisord.d/",
    "/etc/supervisor.d/",
];

fn safe_path(p: &str) -> bool {
    p.starts_with('/') && !p.contains(['\n', '\r', '\0']) && !p.split('/').any(|seg| seg == "..")
}

impl Target {
    fn resolve(&self, server: &Server) -> AppResult<Resolved> {
        match self {
            Target::Env { app_id } => {
                let app = server.app(app_id).ok_or_else(|| {
                    AppError::NotFound(format!("app `{app_id}` is not on {}", server.id))
                })?;
                let dir = app.path.trim().trim_end_matches('/');
                if !safe_path(dir) {
                    return Err(AppError::Invalid(format!(
                        "{}: set the app's full path first (e.g. /var/www/app)",
                        app.name
                    )));
                }
                Ok(Resolved::File {
                    path: format!("{dir}/.env"),
                    app_dir: Some(dir.to_string()),
                })
            }
            Target::Supervisor { file } => {
                let pinned = server
                    .apps
                    .iter()
                    .any(|a| a.supervisor_files.iter().any(|f| f == file));
                let known = file == "/etc/supervisord.conf"
                    || SUPERVISOR_DIRS.iter().any(|d| file.starts_with(d));
                let conf = file.ends_with(".conf") || file.ends_with(".ini");
                if !safe_path(file) || !conf || !(known || pinned) {
                    return Err(AppError::Invalid(format!(
                        "{file} isn't a Supervisor config Kemudi edits (/etc/supervisor/…, /etc/supervisord.d/… or a pinned file)"
                    )));
                }
                Ok(Resolved::File {
                    path: file.clone(),
                    app_dir: None,
                })
            }
            Target::CronFile { file } => {
                let ok = file == "/etc/crontab"
                    || file.strip_prefix("/etc/cron.d/").is_some_and(|name| {
                        !name.is_empty()
                            && name
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                    });
                if !ok {
                    return Err(AppError::Invalid(format!(
                        "{file} isn't /etc/crontab or a file in /etc/cron.d"
                    )));
                }
                Ok(Resolved::File {
                    path: file.clone(),
                    app_dir: None,
                })
            }
            Target::Vhost { file, .. } => {
                let pinned = server
                    .apps
                    .iter()
                    .any(|a| a.vhost_files.iter().any(|f| f == file));
                if !safe_path(file) || !(WEB_DIRS.iter().any(|d| file.starts_with(d)) || pinned) {
                    return Err(AppError::Invalid(format!(
                        "{file} isn't a web server config Kemudi edits (/etc/nginx/…, /etc/apache2/…, /etc/httpd/… or a pinned file)"
                    )));
                }
                Ok(Resolved::File {
                    path: file.clone(),
                    app_dir: None,
                })
            }
            Target::Path { path } => {
                if !safe_path(path) || path.ends_with('/') {
                    return Err(AppError::Invalid(format!("{path} isn't a full file path")));
                }
                Ok(Resolved::File {
                    path: path.clone(),
                    app_dir: None,
                })
            }
            Target::Crontab { user } => {
                if let Some(u) = user {
                    let ok = !u.is_empty()
                        && u.len() <= 32
                        && u.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
                        && u.chars().all(|c| {
                            c.is_ascii_lowercase() || c.is_ascii_digit() || "_.-".contains(c)
                        });
                    if !ok {
                        return Err(AppError::Invalid(format!("`{u}` isn't a user name")));
                    }
                }
                Ok(Resolved::Crontab { user: user.clone() })
            }
        }
    }

    fn label(&self) -> String {
        let base = |f: &str| f.rsplit('/').next().unwrap_or(f).to_string();
        match self {
            Target::Env { .. } => ".env".into(),
            Target::Supervisor { file } => format!("Supervisor {}", base(file)),
            Target::CronFile { file } => format!("cron {}", base(file)),
            Target::Vhost { file, .. } => format!("vhost {}", base(file)),
            Target::Path { path } => base(path),
            Target::Crontab { user } => match user {
                Some(u) => format!("crontab of {u}"),
                None => "crontab".into(),
            },
        }
    }

    fn action_id(&self) -> &'static str {
        match self {
            Target::Env { .. } => "edit:env",
            Target::Supervisor { .. } => "edit:supervisor",
            Target::CronFile { .. } | Target::Crontab { .. } => "edit:cron",
            Target::Vhost { .. } => "edit:vhost",
            Target::Path { .. } => "edit:file",
        }
    }

    fn plan(&self) -> Plan {
        match self {
            // Reads the configs again and says what changed (or the error);
            // nothing restarts until `supervisorctl update`.
            Target::Supervisor { .. } => Plan {
                after: Some(
                    r#"if [ -n "$SU" ]; then $SU supervisorctl reread; else supervisorctl reread; fi 2>&1 | head -40"#,
                ),
                ..Plan::default()
            },
            Target::Vhost { web, .. } => Plan {
                home_backups: true,
                after: None,
                test: Some(match web {
                    Web::Nginx => "nginx -t",
                    Web::Apache => "apachectl configtest",
                }),
            },
            // Any file: backups out of the way (it could be in a folder that
            // loads everything in it, like sites-enabled or conf.d).
            Target::Path { .. } => Plan {
                home_backups: true,
                ..Plan::default()
            },
            _ => Plan::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    /// The file, or "crontab · <user>".
    pub path: String,
    pub content: String,
    /// sha256 of `content`: a write is refused if the file no longer has it.
    pub sha: String,
    /// "direct" (as the ssh user), "sudo" or "none" (can't write).
    pub access: String,
    /// .env: Laravel's config is cached (bootstrap/cache/config.php), so
    /// .env changes do nothing until `artisan config:cache`.
    pub config_cached: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum WriteResult {
    #[serde(rename_all = "camelCase")]
    Saved {
        backup: String,
        /// What changed: key names for .env, line counts otherwise.
        summary: String,
        /// The post-save check's output (`supervisorctl reread`, `nginx -t`).
        check: Option<String>,
        /// The config test already failed before this change (so it
        /// wasn't undone).
        was_failing: bool,
    },
    /// The config test failed with the change, so the old file was put
    /// back: nothing changed on the server.
    Rejected { check: String },
    /// The file changed on the server since it was read.
    Conflict,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub check: Option<String>,
}

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(crate) fn base64_body(content: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    b64.as_bytes()
        .chunks(76)
        .map(|c| std::str::from_utf8(c).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `S` = how to touch the file: as the ssh user, or sudo.
const ACCESS: &str = r#"d=$(dirname "$f")
if [ -w "$f" ] && [ -w "$d" ]; then S=""; A=direct
elif [ -n "$SU" ]; then S="$SU"; A=sudo
else S=""; A=none; fi
"#;

/// Sets `SU` to a working sudo (`sudo -n`; else `suq`, root through a
/// passwordless `sudo su` when sudoers allows only that; else `sudo -A` with
/// the server's saved password through an askpass helper that reads it from
/// the environment), or "" when there's none. `$SU -u user cmd…` works with
/// each. The password arrives in this
/// script on ssh's stdin and is never on a command line.
pub(crate) fn sudo_prelude(password: Option<&str>) -> String {
    // NOSUDO: sudo is missing, or this user isn't allowed it (sudoers says
    // so once a password checks out); BADPW: the saved password was refused.
    let mut s = String::from(
        r#"SU=""; BADPW=""; NOSUDO=""
# `suq [-u user] cmd args…`: the command through `sudo su` (each argument
# quoted for su's shell), for sudoers like `NOPASSWD: /bin/su`.
suq() {
  _ku=root; if [ "$1" = -u ]; then _ku=$2; shift 2; fi
  _kq=""; for _ka in "$@"; do _kq="$_kq '$(printf '%s' "$_ka" | sed "s/'/'\\''/g")'"; done
  sudo -n su "$_ku" -s /bin/sh -c "$_kq"
}
if ! command -v sudo >/dev/null 2>&1; then NOSUDO=1
elif sudo -n true 2>/dev/null; then SU="sudo -n"
elif sudo -n su root -s /bin/sh -c true </dev/null >/dev/null 2>&1; then SU="suq"
"#,
    );
    if let Some(pw) = password {
        s.push_str("else\n");
        s.push_str(&askpass(pw));
        s.push_str(
            r#"if o=$(sudo -A true 2>&1); then SU="sudo -A"
else case "$o" in *sudoers*|*"may not run"*|*"not allowed"*) NOSUDO=1;; *) BADPW=1;; esac; fi
"#,
        );
    }
    s.push_str("fi\n");
    s
}

/// Makes `sudo -A` answer with the saved password: an askpass helper (in a
/// private temp folder removed on exit) that reads it from the environment.
pub(crate) fn askpass(pw: &str) -> String {
    format!(
        r#"KEMUDI_PW=$(cat <<'KEMUDI_PW_END'
{pw}
KEMUDI_PW_END
)
export KEMUDI_PW
K=$(mktemp -d) && chmod 700 "$K"
trap 'rm -rf "$K"' EXIT
printf '#!/bin/sh\nprintf "%%s\\n" "$KEMUDI_PW"\n' > "$K/askpass" && chmod 700 "$K/askpass"
export SUDO_ASKPASS="$K/askpass"
"#
    )
}

/// Why sudo isn't available, for an error line.
pub(crate) const NO_SUDO: &str = r#"$( if [ -n "$NOSUDO" ]; then echo "this ssh user can't use sudo on this server"; elif [ -n "$BADPW" ]; then echo "sudo refused the saved password"; else echo "sudo needs a password here: save it in Passwords (⇧⌘K) as this server's sudo password"; fi )"#;

/// Edit the file a symlink points to (sites-enabled → sites-available,
/// current/.env → shared/.env), so the link stays a link.
const FOLLOW: &str = r#"x=$(readlink -f -- "$f" 2>/dev/null) && [ -n "$x" ] && f="$x"
"#;

/// The config test, as the user or with sudo; `2>&1`.
fn test_cmd(test: &str) -> String {
    format!(r#"if [ -n "$SU" ]; then $SU {test} 2>&1; else {test} 2>&1; fi"#)
}

fn check_block(plan: Plan) -> String {
    if let Some(test) = plan.test {
        return format!(
            r#"echo "@@check"
out=$({cmd}); rc=$?
printf '%s\n' "$out" | head -40
if [ $rc -ne 0 ]; then
  if [ "$pre" -eq 0 ]; then
    if $S cp -p "$bak" "$f"; then $S rm -f "$bak"; echo "@@rolledback"; else echo "@@err the test failed and the old file couldn't be put back; it's at $bak"; fi
  else echo "@@wasfailing"; fi
fi
"#,
            cmd = test_cmd(test)
        );
    }
    plan.after
        .map(|cmd| format!("echo \"@@check\"\n{cmd}\n"))
        .unwrap_or_default()
}

/// Where `bak` goes (next to the file, or ~/.kemudi-backups).
fn backup_line(plan: Plan) -> &'static str {
    if plan.home_backups {
        r#"B="$HOME/.kemudi-backups"
mkdir -p "$B" && chmod 700 "$B" || { echo "@@err couldn't make $B"; exit 0; }
bak="$B/$(basename "$f").kemudi-$(date +%Y%m%d-%H%M%S)"
while [ -e "$bak" ]; do sleep 1; bak="$B/$(basename "$f").kemudi-$(date +%Y%m%d-%H%M%S)"; done
"#
    } else {
        "bak=\"$f.kemudi-$(date +%Y%m%d-%H%M%S)\"\nwhile [ -e \"$bak\" ]; do sleep 1; bak=\"$f.kemudi-$(date +%Y%m%d-%H%M%S)\"; done\n"
    }
}

fn read_script(path: &str, app_dir: Option<&str>, password: Option<&str>) -> String {
    let cache = app_dir.map_or_else(
        || "c=0".to_string(),
        |dir| {
            format!(
                "c=0; [ -e {} ] && c=1",
                shell_quote(&format!("{dir}/bootstrap/cache/config.php"))
            )
        },
    );
    format!(
        r#"{prelude}f={f}
{FOLLOW}{ACCESS}if [ ! -e "$f" ]; then echo "@@err $f doesn't exist"; exit 0; fi
R=""
if [ ! -r "$f" ]; then
  if [ -n "$SU" ]; then R="$SU"; else echo "@@err can't read $f: {NO_SUDO}"; exit 0; fi
fi
{cache}
echo "@@real $f"
echo "@@meta $A $c"
echo "@@content"
$R cat "$f"
"#,
        prelude = sudo_prelude(password),
        f = shell_quote(path),
    )
}

fn write_script(
    path: &str,
    expected_sha: &str,
    content: &str,
    password: Option<&str>,
    plan: Plan,
) -> String {
    let pre = plan.test.map_or_else(
        || "pre=0\n".to_string(),
        |t| format!("pre=0; out=$({}) || pre=1\n", test_cmd(t)),
    );
    format!(
        r#"{prelude}f={f}
{FOLLOW}{ACCESS}if [ "$A" = none ]; then echo "@@err can't write $f: {NO_SUDO}"; exit 0; fi
cur=$($S sha256sum "$f" 2>/dev/null | cut -d' ' -f1)
if [ "$cur" != {sha} ]; then echo "@@conflict"; exit 0; fi
{pre}{backup}tmp="$d/.$(basename "$f").kemudi-tmp-$$"
$S cp -p "$f" "$bak" || {{ echo "@@err couldn't back up $f"; exit 0; }}
base64 -d <<'KEMUDI_B64' | $S tee "$tmp" >/dev/null
{body}
KEMUDI_B64
if [ "$($S sha256sum "$tmp" | cut -d' ' -f1)" != {new_sha} ]; then $S rm -f "$tmp"; echo "@@err the upload arrived damaged; nothing changed"; exit 0; fi
$S chown --reference="$f" "$tmp" 2>/dev/null
$S chmod --reference="$f" "$tmp"
$S mv -f "$tmp" "$f" || {{ $S rm -f "$tmp"; echo "@@err couldn't replace $f"; exit 0; }}
$S sh -c 'ls -1t "$1".kemudi-2* 2>/dev/null | tail -n +{keep} | while IFS= read -r o; do rm -f "$o"; done' _ "${{bak%.kemudi-*}}"
echo "@@saved $bak"
{check}"#,
        prelude = sudo_prelude(password),
        f = shell_quote(path),
        sha = shell_quote(expected_sha),
        new_sha = shell_quote(&sha_hex(content.as_bytes())),
        body = base64_body(content),
        keep = KEEP_BACKUPS + 1,
        backup = backup_line(plan),
        check = check_block(plan),
    )
}

/// Put a backup made by `write_script` back (it kept the owner and mode).
/// Afterwards the check / config test runs again (no rollback: this is the
/// old version).
fn restore_script(path: &str, backup: &str, password: Option<&str>, plan: Plan) -> String {
    let after = match plan.test {
        Some(t) => format!("echo \"@@check\"\n{} | head -40\n", test_cmd(t)),
        None => check_block(plan),
    };
    format!(
        r#"{prelude}f={f}
bak={bak}
{FOLLOW}{ACCESS}if [ "$A" = none ]; then echo "@@err can't write $f: {NO_SUDO}"; exit 0; fi
case "$bak" in "$f".kemudi-2*|"$HOME/.kemudi-backups/$(basename "$f")".kemudi-2*) ;; *) echo "@@err that isn't one of Kemudi's backups of $f"; exit 0;; esac
if [ ! -e "$bak" ]; then echo "@@err the backup $bak is gone"; exit 0; fi
$S cp -p "$bak" "$f" || {{ echo "@@err couldn't restore $f"; exit 0; }}
echo "@@restored"
{after}"#,
        prelude = sudo_prelude(password),
        f = shell_quote(path),
        bak = shell_quote(backup),
    )
}

/// Picks `C`, the crontab command for user `u` (empty: the ssh user).
const CRONTAB_ACCESS: &str = r#"me=$(id -un)
if [ -z "$u" ] || [ "$u" = "$me" ]; then C="crontab"; A=direct; u="$me"
elif [ -n "$SU" ]; then C="$SU crontab -u $u"; A=sudo
else echo "@@err can't open $u's crontab: {NO_SUDO}"; exit 0; fi
"#;

fn crontab_access() -> String {
    CRONTAB_ACCESS.replace("{NO_SUDO}", NO_SUDO)
}

fn crontab_read_script(user: Option<&str>, password: Option<&str>) -> String {
    format!(
        r#"{prelude}u={u}
{access}echo "@@meta $A 0 $u"
echo "@@content"
$C -l 2>/dev/null
exit 0
"#,
        prelude = sudo_prelude(password),
        u = shell_quote(user.unwrap_or("")),
        access = crontab_access(),
    )
}

/// `crontab -` checks the whole file and installs it or nothing; the old
/// one is kept in ~/.kemudi-backups (mode 600) first.
fn crontab_write_script(
    user: Option<&str>,
    expected_sha: &str,
    content: &str,
    password: Option<&str>,
) -> String {
    format!(
        r#"{prelude}u={u}
{access}cur=$($C -l 2>/dev/null | sha256sum | cut -d' ' -f1)
if [ "$cur" != {sha} ]; then echo "@@conflict"; exit 0; fi
B="$HOME/.kemudi-backups"
mkdir -p "$B" && chmod 700 "$B" || {{ echo "@@err couldn't make $B"; exit 0; }}
bak="$B/crontab-$u-$(date +%Y%m%d-%H%M%S)"
while [ -e "$bak" ]; do sleep 1; bak="$B/crontab-$u-$(date +%Y%m%d-%H%M%S)"; done
( umask 077; $C -l > "$bak" 2>/dev/null || : > "$bak" )
out=$(base64 -d <<'KEMUDI_B64' | $C - 2>&1
{body}
KEMUDI_B64
)
if [ $? -ne 0 ]; then echo "@@err crontab refused it, nothing changed: $(printf '%s' "$out" | tr '\n' ' ')"; exit 0; fi
ls -1t "$B"/crontab-"$u"-2* 2>/dev/null | tail -n +{keep} | while IFS= read -r o; do rm -f "$o"; done
echo "@@saved $bak"
"#,
        prelude = sudo_prelude(password),
        u = shell_quote(user.unwrap_or("")),
        access = crontab_access(),
        sha = shell_quote(expected_sha),
        body = base64_body(content),
        keep = KEEP_BACKUPS + 1,
    )
}

fn crontab_restore_script(user: Option<&str>, backup: &str, password: Option<&str>) -> String {
    format!(
        r#"{prelude}u={u}
bak={bak}
{access}case "$bak" in "$HOME/.kemudi-backups/crontab-$u-"2*) ;; *) echo "@@err that isn't one of Kemudi's crontab backups"; exit 0;; esac
[ -e "$bak" ] || {{ echo "@@err the backup $bak is gone"; exit 0; }}
out=$($C - < "$bak" 2>&1) || {{ echo "@@err crontab refused it: $(printf '%s' "$out" | tr '\n' ' ')"; exit 0; }}
echo "@@restored"
"#,
        prelude = sudo_prelude(password),
        u = shell_quote(user.unwrap_or("")),
        bak = shell_quote(backup),
        access = crontab_access(),
    )
}

pub(crate) fn errors(out: &str) -> AppResult<()> {
    match out.lines().find_map(|l| l.strip_prefix("@@err ")) {
        Some(err) => Err(AppError::Invalid(err.to_string())),
        None => Ok(()),
    }
}

fn parse_read(path: &str, out: &str) -> AppResult<RemoteFile> {
    errors(out)?;
    let (head, content) = out
        .split_once("@@content\n")
        .ok_or_else(|| AppError::Invalid(format!("no answer reading {path}")))?;
    let meta = head
        .lines()
        .find_map(|l| l.strip_prefix("@@meta "))
        .unwrap_or("none 0");
    let mut parts = meta.split_whitespace();
    let access = parts.next().unwrap_or("none").to_string();
    let config_cached = parts.next() == Some("1");
    // A crontab says whose it is; a symlink shows where it points.
    let real = head.lines().find_map(|l| l.strip_prefix("@@real "));
    let path = match (parts.next(), real) {
        (Some(user), _) => format!("crontab · {user}"),
        (None, Some(r)) if r != path => format!("{path} → {r}"),
        _ => path.to_string(),
    };
    if content.len() > MAX_SIZE {
        return Err(AppError::Invalid(format!(
            "{path} is too big to open here (over 512 KB): download it instead"
        )));
    }
    if content.contains('\0') {
        return Err(AppError::Invalid(format!(
            "{path} isn't a text file: download it instead"
        )));
    }
    Ok(RemoteFile {
        path,
        sha: sha_hex(content.as_bytes()),
        content: content.to_string(),
        access,
        config_cached,
    })
}

/// Lines after `@@check` (without the script's own @@ markers).
fn check_output(out: &str) -> Option<String> {
    out.split_once("@@check\n").map(|(_, rest)| {
        rest.lines()
            .filter(|l| !l.starts_with("@@"))
            .collect::<Vec<_>>()
            .join("\n")
            .trim_end()
            .to_string()
    })
}

#[derive(Debug, PartialEq)]
enum Written {
    Saved {
        backup: String,
        check: Option<String>,
        was_failing: bool,
    },
    /// The config test failed with the change; the old file is back.
    Rejected {
        check: String,
    },
    Conflict,
}

fn parse_write(out: &str) -> AppResult<Written> {
    errors(out)?;
    let has = |m: &str| out.lines().any(|l| l == m);
    if has("@@conflict") {
        return Ok(Written::Conflict);
    }
    if has("@@rolledback") {
        return Ok(Written::Rejected {
            check: check_output(out).unwrap_or_default(),
        });
    }
    match out.lines().find_map(|l| l.strip_prefix("@@saved ")) {
        Some(bak) => Ok(Written::Saved {
            backup: bak.to_string(),
            check: check_output(out),
            was_failing: has("@@wasfailing"),
        }),
        None => Err(AppError::Invalid(
            "no answer from the server; the file may not have changed".into(),
        )),
    }
}

/// .env changes by key name: "changed A, B · added C · removed D".
pub fn env_summary(old: &str, new: &str) -> String {
    let map = |text: &str| -> BTreeMap<String, String> {
        let lines: Vec<String> = text.lines().map(str::to_string).collect();
        crate::app_inspect::parse_env(&lines)
            .into_iter()
            .map(|e| (e.key, e.value))
            .collect()
    };
    let (a, b) = (map(old), map(new));
    let changed: Vec<&str> = b
        .iter()
        .filter(|(k, v)| a.get(*k).is_some_and(|old| old != *v))
        .map(|(k, _)| k.as_str())
        .collect();
    let added: Vec<&str> = b
        .keys()
        .filter(|k| !a.contains_key(*k))
        .map(String::as_str)
        .collect();
    let removed: Vec<&str> = a
        .keys()
        .filter(|k| !b.contains_key(*k))
        .map(String::as_str)
        .collect();
    let mut parts = Vec::new();
    for (word, list) in [("changed", changed), ("added", added), ("removed", removed)] {
        if !list.is_empty() {
            parts.push(format!("{word} {}", list.join(", ")));
        }
    }
    if parts.is_empty() {
        "comments or layout only".into()
    } else {
        parts.join(" · ")
    }
}

/// Other files: "+2 −1 lines" (lines only in the new / old version).
pub fn lines_summary(old: &str, new: &str) -> String {
    let mut counts: BTreeMap<&str, i64> = BTreeMap::new();
    for l in old.lines() {
        *counts.entry(l).or_default() -= 1;
    }
    for l in new.lines() {
        *counts.entry(l).or_default() += 1;
    }
    let added: i64 = counts.values().filter(|n| **n > 0).sum();
    let removed: i64 = -counts.values().filter(|n| **n < 0).sum::<i64>();
    match (added, removed) {
        (0, 0) => "no line changes".into(),
        (a, r) => format!("+{a} −{r} lines"),
    }
}

/// The server's saved sudo password, if any (none if the vault can't be
/// read: then only passwordless sudo is tried).
pub(crate) async fn saved_sudo(server_id: &str) -> Option<String> {
    let id = server_id.to_string();
    tauri::async_runtime::spawn_blocking(move || crate::vault::sudo_for(&id))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
}

pub(crate) fn lookup(state: &AppState, server_id: &str) -> AppResult<Server> {
    let config = state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))?;
    config
        .server(server_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("server `{server_id}` isn't in Kemudi")))
}

/// Start a History row for an edit; finish it with the outcome.
fn audit_start(
    state: &AppState,
    server: &Server,
    app_id: Option<&str>,
    target: &Target,
    what: &str,
) -> Option<(std::sync::Arc<crate::audit::AuditLog>, i64)> {
    let log = state.audit.as_ref().ok()?;
    let app = app_id.and_then(|id| server.app(id));
    // Server-wide files (vhosts, Supervisor) count as the server's.
    let env = match (target, app) {
        (
            Target::Env { .. }
            | Target::Crontab { .. }
            | Target::CronFile { .. }
            | Target::Path { .. },
            Some(a),
        ) => a.env,
        _ => server.env,
    };
    let label = format!("Edit {}", target.label());
    log.start(&crate::audit::NewRun {
        server_id: &server.id,
        app_id: app.map(|a| a.id.as_str()),
        action_id: target.action_id(),
        label: &label,
        env: env.as_str(),
        kind: "edit",
        command: what,
        edited: false,
    })
    .ok()
    .map(|id| (log.clone(), id))
}

#[tauri::command]
pub async fn remote_file_read(
    state: State<'_, AppState>,
    server_id: String,
    target: Target,
) -> AppResult<RemoteFile> {
    let server = lookup(&state, &server_id)?;
    let password = saved_sudo(&server_id).await;
    let (label, script) = match target.resolve(&server)? {
        Resolved::File { path, app_dir } => {
            let s = read_script(&path, app_dir.as_deref(), password.as_deref());
            (path, s)
        }
        Resolved::Crontab { user } => (
            "crontab".to_string(),
            crontab_read_script(user.as_deref(), password.as_deref()),
        ),
    };
    let out = crate::monitor::run(&state, &server_id, &script).await?;
    parse_read(&label, &out)
}

#[tauri::command]
pub async fn remote_file_write(
    state: State<'_, AppState>,
    server_id: String,
    target: Target,
    original: String,
    content: String,
    app_id: Option<String>,
) -> AppResult<WriteResult> {
    let server = lookup(&state, &server_id)?;
    let resolved = target.resolve(&server)?;
    if content.len() > MAX_SIZE {
        return Err(AppError::Invalid("that's too big to save".into()));
    }
    let summary = match &target {
        Target::Env { .. } => env_summary(&original, &content),
        _ => lines_summary(&original, &content),
    };
    let app_id = match &target {
        Target::Env { app_id } => Some(app_id.clone()),
        _ => app_id,
    };
    let password = saved_sudo(&server_id).await;
    let sha = sha_hex(original.as_bytes());
    let (where_, script) = match &resolved {
        Resolved::File { path, .. } => (
            path.clone(),
            write_script(path, &sha, &content, password.as_deref(), target.plan()),
        ),
        Resolved::Crontab { user } => (
            target.label(),
            crontab_write_script(user.as_deref(), &sha, &content, password.as_deref()),
        ),
    };
    let audit = audit_start(
        &state,
        &server,
        app_id.as_deref(),
        &target,
        &format!("{where_}: {summary}"),
    );
    let result = match crate::monitor::run(&state, &server_id, &script).await {
        Ok(out) => parse_write(&out),
        Err(e) => Err(e),
    };
    if let Some((log, id)) = audit {
        let code = i32::from(!matches!(result, Ok(Written::Saved { .. })));
        let _ = log.finish(id, Some(code));
    }
    Ok(match result? {
        Written::Saved {
            backup,
            check,
            was_failing,
        } => WriteResult::Saved {
            backup,
            summary,
            check,
            was_failing,
        },
        Written::Rejected { check } => WriteResult::Rejected { check },
        Written::Conflict => WriteResult::Conflict,
    })
}

/// Put back the backup a save just made (Undo after a failed check).
#[tauri::command]
pub async fn remote_file_restore(
    state: State<'_, AppState>,
    server_id: String,
    target: Target,
    backup: String,
    app_id: Option<String>,
) -> AppResult<Restored> {
    let server = lookup(&state, &server_id)?;
    let resolved = target.resolve(&server)?;
    let stamp_ok = |s: &str| {
        s.len() == 15
            && s.char_indices()
                .all(|(i, c)| if i == 8 { c == '-' } else { c.is_ascii_digit() })
    };
    let password = saved_sudo(&server_id).await;
    let script = match &resolved {
        Resolved::File { path, .. } => {
            let ok = safe_path(&backup)
                && backup
                    .rsplit_once(".kemudi-")
                    .is_some_and(|(_, stamp)| stamp_ok(stamp));
            if !ok {
                return Err(AppError::Invalid(format!(
                    "{backup} isn't a Kemudi backup of {path}"
                )));
            }
            restore_script(path, &backup, password.as_deref(), target.plan())
        }
        Resolved::Crontab { user } => {
            let ok = !backup.contains(['\n', '\r', '\0'])
                && backup
                    .rsplit_once("/.kemudi-backups/crontab-")
                    .and_then(|(_, rest)| rest.rsplit_once('-').map(|(_, t)| t.to_string()))
                    .is_some();
            if !ok {
                return Err(AppError::Invalid(format!(
                    "{backup} isn't a Kemudi crontab backup"
                )));
            }
            crontab_restore_script(user.as_deref(), &backup, password.as_deref())
        }
    };
    let audit = audit_start(
        &state,
        &server,
        app_id.as_deref(),
        &target,
        &format!("restored {backup}"),
    );
    let out = crate::monitor::run(&state, &server_id, &script).await;
    let result = out.and_then(|out| {
        errors(&out)?;
        if out.lines().any(|l| l == "@@restored") {
            Ok(Restored {
                check: check_output(&out),
            })
        } else {
            Err(AppError::Invalid(
                "no answer from the server; it may not have been restored".into(),
            ))
        }
    });
    if let Some((log, id)) = audit {
        let _ = log.finish(id, Some(i32::from(result.is_err())));
    }
    result
}

// ------------------------------------------------------------ new nginx vhost

/// What the server offers for a new vhost.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VhostProbe {
    /// nginx is installed with Debian-style sites-available / sites-enabled.
    pub nginx: bool,
    /// PHP-FPM sockets (`/run/php/php8.4-fpm.sock`, …).
    pub php_sockets: Vec<String>,
    /// Names already in sites-available.
    pub sites: Vec<String>,
    /// Let's Encrypt certificate names (`/etc/letsencrypt/live/<name>`).
    pub certs: Vec<String>,
    pub certbot: bool,
    /// certbot's shared SSL settings exist (options-ssl-nginx.conf, dhparams).
    pub certbot_options: bool,
}

pub(crate) fn probe_script(password: Option<&str>) -> String {
    format!(
        r#"{prelude}if [ -d /etc/nginx/sites-available ] && {{ command -v nginx >/dev/null 2>&1 || [ -x /usr/sbin/nginx ]; }}; then echo "@@nginx yes"; else echo "@@nginx no"; fi
command -v certbot >/dev/null 2>&1 && echo "@@certbot yes"
[ -e /etc/letsencrypt/options-ssl-nginx.conf ] && [ -e /etc/letsencrypt/ssl-dhparams.pem ] && echo "@@options yes"
echo "@@sockets"
ls -1 /run/php/*.sock /var/run/php/*.sock 2>/dev/null | sort -u
echo "@@sites"
ls -1 /etc/nginx/sites-available 2>/dev/null
echo "@@certs"
if [ -r /etc/letsencrypt/live ]; then ls -1 /etc/letsencrypt/live; elif [ -n "$SU" ]; then $SU ls -1 /etc/letsencrypt/live; fi 2>/dev/null | grep -v '^README$'
echo "@@end"
"#,
        prelude = sudo_prelude(password)
    )
}

pub(crate) fn parse_probe(out: &str) -> VhostProbe {
    let mut p = VhostProbe {
        nginx: out.lines().any(|l| l == "@@nginx yes"),
        certbot: out.lines().any(|l| l == "@@certbot yes"),
        certbot_options: out.lines().any(|l| l == "@@options yes"),
        ..VhostProbe::default()
    };
    let mut section = "";
    for line in out.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            section = name;
            continue;
        }
        let v = line.trim().to_string();
        if v.is_empty() {
            continue;
        }
        match section {
            "sockets" => {
                // /run/php and /var/run/php are often the same place.
                let base = v.rsplit('/').next().unwrap_or(&v).to_string();
                if !p
                    .php_sockets
                    .iter()
                    .any(|s| s.ends_with(&format!("/{base}")))
                {
                    p.php_sockets.push(v);
                }
            }
            "sites" => p.sites.push(v),
            "certs" => p.certs.push(v),
            _ => {}
        }
    }
    p
}

/// Sockets, existing sites and certificates on a server (read-only).
#[tauri::command]
pub async fn vhost_probe(state: State<'_, AppState>, server_id: String) -> AppResult<VhostProbe> {
    lookup(&state, &server_id)?;
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(&state, &server_id, &probe_script(password.as_deref())).await?;
    Ok(parse_probe(&out))
}

pub(crate) fn valid_site_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// Write sites-available/<name>, link it into sites-enabled, then `nginx -t`:
/// if that fails (and passed before), both are removed again.
fn create_script(name: &str, content: &str, password: Option<&str>) -> String {
    format!(
        r#"{prelude}f=/etc/nginx/sites-available/{name}
l=/etc/nginx/sites-enabled/{name}
[ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ] || {{ echo "@@err this nginx has no sites-available / sites-enabled"; exit 0; }}
if [ -e "$f" ] || [ -L "$l" ] || [ -e "$l" ]; then echo "@@err $f already exists: edit it from Inspect instead"; exit 0; fi
if [ -w /etc/nginx/sites-available ] && [ -w /etc/nginx/sites-enabled ]; then S=""
elif [ -n "$SU" ]; then S="$SU"
else echo "@@err can't write to /etc/nginx: {NO_SUDO}"; exit 0; fi
pre=0; out=$({test}) || pre=1
base64 -d <<'KEMUDI_B64' | $S tee "$f" >/dev/null
{body}
KEMUDI_B64
if [ "$($S sha256sum "$f" | cut -d' ' -f1)" != {sha} ]; then $S rm -f "$f"; echo "@@err the upload arrived damaged; nothing changed"; exit 0; fi
$S chmod 644 "$f"
$S ln -s "$f" "$l" || {{ $S rm -f "$f"; echo "@@err couldn't link it into sites-enabled"; exit 0; }}
echo "@@created $f"
echo "@@check"
out=$({test}); rc=$?
printf '%s\n' "$out" | head -40
if [ $rc -ne 0 ]; then
  if [ "$pre" -eq 0 ]; then $S rm -f "$l" "$f"; echo "@@rolledback"; else echo "@@wasfailing"; fi
fi
"#,
        prelude = sudo_prelude(password),
        name = shell_quote(name),
        test = test_cmd("nginx -t"),
        body = base64_body(content),
        sha = shell_quote(&sha_hex(content.as_bytes())),
    )
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Created {
    /// Written and enabled; `check` is `nginx -t`.
    #[serde(rename_all = "camelCase")]
    Created {
        path: String,
        check: String,
        was_failing: bool,
    },
    /// `nginx -t` failed with it, so it was removed again.
    Rejected { check: String },
}

fn parse_create(out: &str) -> AppResult<Created> {
    errors(out)?;
    let check = check_output(out).unwrap_or_default();
    if out.lines().any(|l| l == "@@rolledback") {
        return Ok(Created::Rejected { check });
    }
    match out.lines().find_map(|l| l.strip_prefix("@@created ")) {
        Some(path) => Ok(Created::Created {
            path: path.to_string(),
            check,
            was_failing: out.lines().any(|l| l == "@@wasfailing"),
        }),
        None => Err(AppError::Invalid(
            "no answer from the server; check /etc/nginx/sites-available".into(),
        )),
    }
}

/// A new nginx vhost for an app (never replaces an existing file).
#[tauri::command]
pub async fn vhost_create(
    state: State<'_, AppState>,
    server_id: String,
    app_id: Option<String>,
    name: String,
    content: String,
) -> AppResult<Created> {
    let server = lookup(&state, &server_id)?;
    if !valid_site_name(&name) {
        return Err(AppError::Invalid(
            "the file name can use letters, digits, . _ - (e.g. app.example.com)".into(),
        ));
    }
    if content.trim().is_empty() || content.len() > MAX_SIZE {
        return Err(AppError::Invalid("that config is empty or too big".into()));
    }
    let password = saved_sudo(&server_id).await;
    let audit = state.audit.as_ref().ok().and_then(|log| {
        let label = format!("New vhost {name}");
        log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: app_id.as_deref().filter(|id| server.app(id).is_some()),
            action_id: "vhost:new",
            label: &label,
            env: server.env.as_str(),
            kind: "edit",
            command: &format!("/etc/nginx/sites-available/{name} (+ sites-enabled link)"),
            edited: false,
        })
        .ok()
        .map(|id| (log.clone(), id))
    });
    let result = match crate::monitor::run(
        &state,
        &server_id,
        &create_script(&name, &content, password.as_deref()),
    )
    .await
    {
        Ok(out) => parse_create(&out),
        Err(e) => Err(e),
    };
    if let Some((log, id)) = audit {
        let _ = log.finish(
            id,
            Some(i32::from(!matches!(result, Ok(Created::Created { .. })))),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vhost_probe_and_create_outputs() {
        let out = "@@nginx yes
@@certbot yes
@@sockets
/run/php/php8.4-fpm.sock
/var/run/php/php8.4-fpm.sock
/run/php/php8.2-fpm.sock
@@sites
default
shop.example.com
@@certs
shop.example.com
@@end
";
        let p = parse_probe(out);
        assert!(p.nginx && p.certbot && !p.certbot_options);
        assert_eq!(
            p.php_sockets,
            ["/run/php/php8.4-fpm.sock", "/run/php/php8.2-fpm.sock"]
        );
        assert_eq!(p.sites, ["default", "shop.example.com"]);
        assert_eq!(p.certs, ["shop.example.com"]);
        assert!(valid_site_name("app.example.com"));
        assert!(
            !valid_site_name("../passwd") && !valid_site_name("a b") && !valid_site_name(".hidden")
        );
        assert!(matches!(
            parse_create("@@created /etc/nginx/sites-available/x\n@@check\nok\n").unwrap(),
            Created::Created {
                was_failing: false,
                ..
            }
        ));
        assert!(matches!(
            parse_create("@@created /x\n@@check\nemerg\n@@rolledback\n").unwrap(),
            Created::Rejected { .. }
        ));
        assert!(parse_create("@@err /x already exists\n").is_err());
    }

    #[test]
    fn summary_names_keys_only() {
        let old = "APP_NAME=App\nDB_PASSWORD=old\nMAIL_HOST=x\n# note\n";
        let new = "APP_NAME=App\nDB_PASSWORD=new\nQUEUE=redis\n";
        let s = env_summary(old, new);
        assert_eq!(s, "changed DB_PASSWORD · added QUEUE · removed MAIL_HOST");
        assert_eq!(
            env_summary(old, &format!("{old}\n# more\n")),
            "comments or layout only"
        );
        assert_eq!(lines_summary("a\nb\n", "a\nc\nd\n"), "+2 −1 lines");
        assert_eq!(lines_summary("a\n", "a\n"), "no line changes");
    }

    #[test]
    fn parse_outputs() {
        let f = parse_read("/x/.env", "@@meta sudo 1\n@@content\nA=1\n").unwrap();
        assert_eq!(
            (f.content.as_str(), f.access.as_str(), f.config_cached),
            ("A=1\n", "sudo", true)
        );
        assert_eq!(f.sha, sha_hex(b"A=1\n"));
        assert!(parse_read("/x/.env", "@@err /x/.env doesn't exist\n").is_err());
        assert_eq!(
            parse_read("/x", "@@meta direct 0\n@@content\nA=1")
                .unwrap()
                .content,
            "A=1"
        );
        let c = parse_read(
            "crontab",
            "@@meta direct 0 deploy\n@@content\n* * * * * x\n",
        )
        .unwrap();
        assert_eq!(c.path, "crontab · deploy");

        assert_eq!(
            parse_write("@@saved /x.kemudi-1\n").unwrap(),
            Written::Saved {
                backup: "/x.kemudi-1".into(),
                check: None,
                was_failing: false
            }
        );
        assert_eq!(
            parse_write("@@saved /x.kemudi-1\n@@check\nworker: changed\n").unwrap(),
            Written::Saved {
                backup: "/x.kemudi-1".into(),
                check: Some("worker: changed".into()),
                was_failing: false
            }
        );
        assert_eq!(parse_write("@@conflict\n").unwrap(), Written::Conflict);
        assert_eq!(
            parse_write("@@saved /b\n@@check\nnginx: [emerg] unknown directive\n@@rolledback\n")
                .unwrap(),
            Written::Rejected {
                check: "nginx: [emerg] unknown directive".into()
            }
        );
        assert!(matches!(
            parse_write("@@saved /b\n@@check\nfailed\n@@wasfailing\n").unwrap(),
            Written::Saved {
                was_failing: true,
                ..
            }
        ));
        let r = parse_read(
            "/etc/nginx/sites-enabled/x",
            "@@real /etc/nginx/sites-available/x\n@@meta sudo 0\n@@content\n",
        )
        .unwrap();
        assert_eq!(
            r.path,
            "/etc/nginx/sites-enabled/x → /etc/nginx/sites-available/x"
        );
        assert!(parse_write("@@err nope\n").is_err());
        assert!(parse_write("").is_err());
    }

    fn server() -> Server {
        let mut app = crate::config::schema::App {
            id: "core".into(),
            name: "Core".into(),
            path: "/opt/www/app".into(),
            branch: None,
            php: None,
            color: None,
            env: crate::config::schema::Env::Staging,
            env_set: false,
            repo: None,
            url: None,
            vhost_files: vec![],
            supervisor_files: vec!["/opt/conf/worker.conf".into()],
            vars: BTreeMap::new(),
            actions: vec![],
            hidden: vec![],
        };
        app.path = "/opt/www/app/".into();
        Server {
            id: "stg".into(),
            name: "stg".into(),
            team: None,
            host: "stg".into(),
            env: crate::config::schema::Env::Staging,
            vpn: crate::config::schema::Vpn::None,
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
    fn targets_are_limited() {
        let s = server();
        let file = |t: Target| match t.resolve(&s) {
            Ok(Resolved::File { path, .. }) => Ok(path),
            Ok(Resolved::Crontab { .. }) => Ok("crontab".into()),
            Err(e) => Err(e.to_string()),
        };
        assert_eq!(
            file(Target::Env {
                app_id: "core".into()
            })
            .unwrap(),
            "/opt/www/app/.env"
        );
        let sup = |f: &str| file(Target::Supervisor { file: f.into() });
        assert!(sup("/etc/supervisor/conf.d/worker.conf").is_ok());
        assert!(sup("/etc/supervisord.d/x.ini").is_ok());
        assert!(sup("/opt/conf/worker.conf").is_ok(), "pinned on an app");
        assert!(sup("/etc/passwd").is_err());
        assert!(sup("/etc/supervisor/conf.d/../../shadow.conf").is_err());
        assert!(sup("/home/x/evil.conf").is_err());
        let cron = |f: &str| file(Target::CronFile { file: f.into() });
        assert!(cron("/etc/crontab").is_ok());
        assert!(cron("/etc/cron.d/laravel-core").is_ok());
        assert!(
            cron("/etc/cron.d/x.conf").is_err(),
            "cron ignores names with dots"
        );
        assert!(cron("/etc/cron.d/../passwd").is_err());
        let tab = |u: Option<&str>| {
            file(Target::Crontab {
                user: u.map(str::to_string),
            })
        };
        assert!(tab(None).is_ok());
        assert!(tab(Some("www-data")).is_ok());
        assert!(tab(Some("root; rm -rf /")).is_err());
    }

    /// The real scripts, run with sh against a temp dir (GNU coreutils
    /// only: on macOS see `dump_scripts` + Docker in the README).
    #[test]
    fn scripts_against_a_real_file() {
        let gnu = std::process::Command::new("chmod")
            .arg("--version")
            .output();
        if !gnu.is_ok_and(|o| o.status.success()) {
            return;
        }
        let dir = std::env::temp_dir().join(format!("kemudi-rf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join(".env");
        std::fs::write(&f, "A=1\n").unwrap();
        let path = f.display().to_string();
        let sh = |script: String| {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let read = parse_read(&path, &sh(read_script(&path, None, None))).unwrap();
        assert_eq!(read.content, "A=1\n");
        let saved = parse_write(&sh(write_script(
            &path,
            &read.sha,
            "B=2\n",
            None,
            Plan::default(),
        )))
        .unwrap();
        assert!(matches!(saved, Written::Saved { .. }));
        assert_eq!(
            parse_write(&sh(write_script(
                &path,
                &read.sha,
                "C=3\n",
                None,
                Plan::default()
            )))
            .unwrap(),
            Written::Conflict
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Writes the real scripts for a run on Linux (see README: Checks):
    /// KEMUDI_RF_OUT=dir cargo test dump_scripts -- --ignored
    #[test]
    #[ignore]
    fn dump_scripts() {
        let Ok(out) = std::env::var("KEMUDI_RF_OUT") else {
            return;
        };
        let dir = std::path::Path::new(&out);
        let pw = std::env::var("KEMUDI_RF_PW").ok();
        let pw = pw.as_deref();
        let old = "A=1\nSECRET=x\n";
        let new = "A=1\nSECRET=\"new value with 'quotes' & $dollar\"\n# café\nB=2\n";
        let w = |name: &str, text: String| std::fs::write(dir.join(name), text).expect("write");
        w(
            "read.sh",
            read_script("/srv/app/.env", Some("/srv/app"), pw),
        );
        w(
            "write.sh",
            write_script(
                "/srv/app/.env",
                &sha_hex(old.as_bytes()),
                new,
                pw,
                Plan::default(),
            ),
        );
        w(
            "stale.sh",
            write_script(
                "/srv/app/.env",
                &sha_hex(b"other"),
                "X=1\n",
                pw,
                Plan::default(),
            ),
        );
        w("expected.env", new.to_string());
        // Supervisor: save, reread, restore.
        let sup = Target::Supervisor {
            file: "/etc/supervisor/conf.d/w.conf".into(),
        };
        let sup_old = "[program:w]\ncommand=sleep 1000\n";
        let sup_new = "[program:w]\ncommand=sleep 2000\n";
        w(
            "sup-write.sh",
            write_script(
                "/etc/supervisor/conf.d/w.conf",
                &sha_hex(sup_old.as_bytes()),
                sup_new,
                pw,
                sup.plan(),
            ),
        );
        w(
            "sup-restore.sh",
            restore_script("/etc/supervisor/conf.d/w.conf", "BACKUP", pw, sup.plan()),
        );
        // nginx vhost behind a sites-enabled symlink: a good change, a
        // breaking one (rolled back), and a restore.
        let vh = Target::Vhost {
            file: "/etc/nginx/sites-enabled/app".into(),
            web: Web::Nginx,
        };
        let vh_old =
            "server {\n  listen 80;\n  server_name app.test;\n  root /srv/app/public;\n}\n";
        let vh_new = "server {\n  listen 80;\n  server_name app.test www.app.test;\n  root /srv/app/public;\n}\n";
        let vh_bad = "server {\n  listen 80;\n  server_nam app.test;\n}\n";
        w(
            "vh-read.sh",
            read_script("/etc/nginx/sites-enabled/app", None, pw),
        );
        w(
            "vh-write.sh",
            write_script(
                "/etc/nginx/sites-enabled/app",
                &sha_hex(vh_old.as_bytes()),
                vh_new,
                pw,
                vh.plan(),
            ),
        );
        w(
            "vh-bad.sh",
            write_script(
                "/etc/nginx/sites-enabled/app",
                &sha_hex(vh_new.as_bytes()),
                vh_bad,
                pw,
                vh.plan(),
            ),
        );
        w(
            "vh-restore.sh",
            restore_script("/etc/nginx/sites-enabled/app", "BACKUP", pw, vh.plan()),
        );
        w("vh-expected", vh_new.to_string());
        let good =
            "server {\n    listen 80;\n    server_name new.test;\n    root /srv/app/public;\n}\n";
        let bad = "server {\n    listen 80;\n    server_nam new.test;\n}\n";
        w("new-probe.sh", probe_script(pw));
        w("new-bad.sh", create_script("bad.test", bad, pw));
        w("new-good.sh", create_script("new.test", good, pw));
        // Crontab of www-data (via sudo), a bad one and a good one.
        let tab_old = "* * * * * cd /srv/app && php artisan schedule:run\n";
        w("cron-read.sh", crontab_read_script(Some("www-data"), pw));
        w(
            "cron-bad.sh",
            crontab_write_script(
                Some("www-data"),
                &sha_hex(tab_old.as_bytes()),
                "not a cron line\n",
                pw,
            ),
        );
        w(
            "cron-write.sh",
            crontab_write_script(
                Some("www-data"),
                &sha_hex(tab_old.as_bytes()),
                "*/5 * * * * cd /srv/app && php artisan schedule:run\n",
                pw,
            ),
        );
        w(
            "cron-restore.sh",
            crontab_restore_script(Some("www-data"), "BACKUP", pw),
        );
    }
}
