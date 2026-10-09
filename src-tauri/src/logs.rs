//! The log viewer: find a server's logs (an app's storage/logs, nginx,
//! PHP-FPM, queue workers, system) and read or follow one. A log is a
//! *family*: `laravel.log` with its daily files (`laravel-2026-10-09.log`)
//! and rotations (`error.log.1`, `syslog-20261009`); following always reads
//! the newest one, so a new day's file is picked up on its own. Reads are by
//! byte offset over the shared ssh connection; logs only root can read go
//! through sudo (one sudo per read).

use std::collections::BTreeMap;

use base64::Engine;
use serde::Serialize;
use tauri::State;

use crate::actions::render::shell_quote;
use crate::error::{AppError, AppResult};
use crate::remote_files::{askpass, errors, lookup, saved_sudo, sudo_prelude, NO_SUDO};
use crate::AppState;

/// First read and "Load earlier": this much from the end (or before).
const TAIL: u64 = 256 * 1024;
/// Following: at most this much new data per read (the rest is skipped).
const FOLLOW_MAX: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub size: u64,
    pub mtime: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogSource {
    /// `app:<id>`, `web`, `php`, `workers`, `system`.
    pub group: String,
    pub dir: String,
    /// The family's name: `laravel.log`, `error.log`, `syslog`.
    pub base: String,
    /// Its files, newest first (the first is what following reads).
    pub files: Vec<LogFile>,
}

/// `laravel-2026-10-09.log` → `laravel.log`, `error.log.1` → `error.log`,
/// `syslog-20261009` → `syslog`; compressed rotations are left out.
pub fn family_of(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    if [".gz", ".xz", ".bz2", ".zip", ".zst"]
        .iter()
        .any(|e| lower.ends_with(e))
    {
        return None;
    }
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    // laravel-2026-10-09.log
    if let Some(stem) = name.strip_suffix(".log") {
        if stem.len() > 11 {
            let (head, date) = stem.split_at(stem.len() - 11);
            let d = date.as_bytes();
            if d[0] == b'-'
                && d[5] == b'-'
                && d[8] == b'-'
                && digits(&date[1..5])
                && digits(&date[6..8])
                && digits(&date[9..11])
            {
                return Some(format!("{head}.log"));
            }
        }
    }
    // error.log.1
    if let Some((head, n)) = name.rsplit_once('.') {
        if digits(n) && !head.is_empty() {
            return Some(head.to_string());
        }
    }
    // syslog-20261009
    if let Some((head, n)) = name.rsplit_once('-') {
        if n.len() >= 8 && digits(n) && !head.is_empty() {
            return Some(head.to_string());
        }
    }
    Some(name.to_string())
}

/// Lines of `@@f <group>\t<dir>\t<name>\t<size>\t<mtime>`.
fn sources_script(apps: &[(String, String)], all: bool, password: Option<&str>) -> String {
    let mut app_lines = String::new();
    for (id, path) in apps {
        // An app deployed with releases keeps its logs under current/ or shared/.
        app_lines.push_str(&format!(
            "for d in {p}/storage/logs {p}/current/storage/logs {p}/shared/storage/logs; do if seen \"$d\"; then L {g} \"$d\" '*.log*'; break; fi; done\n",
            p = shell_quote(path),
            g = shell_quote(&format!("app:{id}")),
        ));
    }
    let paths = apps
        .iter()
        .map(|(_, p)| shell_quote(p))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"export LC_ALL=C
{prelude}seen() {{ [ -d "$1" ] || {{ [ -n "$SU" ] && $SU test -d "$1"; }}; }}
# L <group> <dir> <pattern>: the dir's matching files (sudo when only root can list it).
L() {{
  seen "$2" || return 0
  R=""
  if ! {{ [ -r "$2" ] && [ -x "$2" ]; }}; then [ -n "$SU" ] || return 0; R="$SU"; fi
  $R find "$2" -maxdepth 1 -type f -name "$3" ! -name '*.gz' ! -name '*.xz' ! -name '*.bz2' ! -name '*.zst' -printf '%h\t%f\t%s\t%T@\n' 2>/dev/null | while IFS= read -r l; do printf '@@f %s\t%s\n' "$1" "$l"; done
}}
{app_lines}for d in /var/log/nginx /var/log/apache2 /var/log/httpd; do L web "$d" '*'; done
L php /var/log 'php*fpm*.log*'
L php /var/log/php 'php*fpm*.log*'
# Queue workers: the logs named in Supervisor programs (for these apps, or all).
{sup}for c in $(supconfs); do
  [ -f "$c" ] || continue
  t=$(cat -- "$c" 2>/dev/null || {{ [ -n "$SU" ] && $SU cat -- "$c"; }}) || continue
  m=""
  for p in {paths}; do case "$t" in *"$p"*) m=1 ;; esac; done
  [ -n "$m" ] || [ -z "{all}" ] || m=1
  [ -n "$m" ] || continue
  printf '%s\n' "$t" | sed -n 's/^[[:space:]]*std\(out\|err\)_logfile[[:space:]]*=[[:space:]]*\([^[:space:]]*\).*/\2/p' | while read -r f; do
    case "$f" in /*) ;; *) continue ;; esac
    case "$f" in *"%("*) continue ;; esac
    L workers "$(dirname -- "$f")" "$(basename -- "$f")*"
  done
done
L workers /var/log/supervisor 'supervisord.log*'
for n in syslog 'auth.log' 'kern.log'; do L system /var/log "$n*"; done
L system /var/log/mysql 'error.log*'
L system /var/log/redis '*.log*'
L system /var/log/letsencrypt 'letsencrypt.log*'
"#,
        prelude = sudo_prelude(password),
        sup = crate::app_inspect::SUPCONFS,
        all = if all { "1" } else { "" },
    )
}

fn parse_sources(out: &str) -> AppResult<Vec<LogSource>> {
    errors(out)?;
    let mut fams: BTreeMap<(String, String, String), Vec<LogFile>> = BTreeMap::new();
    let mut order: Vec<(String, String, String)> = Vec::new();
    for line in out.lines() {
        let Some(rest) = line.strip_prefix("@@f ") else {
            continue;
        };
        let f: Vec<&str> = rest.splitn(5, '\t').collect();
        if f.len() < 5 {
            continue;
        }
        let Some(base) = family_of(f[2]) else {
            continue;
        };
        // Only things that look like logs in an app's folder.
        if f[0].starts_with("app:") && !f[2].contains(".log") {
            continue;
        }
        let key = (f[0].to_string(), f[1].to_string(), base);
        let files = fams.entry(key.clone()).or_default();
        if files.is_empty() {
            order.push(key);
        }
        if !files.iter().any(|x| x.name == f[2]) {
            files.push(LogFile {
                name: f[2].to_string(),
                size: f[3].parse().unwrap_or(0),
                mtime: f[4].parse().unwrap_or(0.0),
            });
        }
    }
    let mut sources: Vec<LogSource> = order
        .into_iter()
        .filter_map(|key| {
            let mut files = fams.remove(&key)?;
            files.sort_by(|a, b| {
                b.mtime
                    .total_cmp(&a.mtime)
                    .then_with(|| b.name.cmp(&a.name))
            });
            Some(LogSource {
                group: key.0,
                dir: key.1,
                base: key.2,
                files,
            })
        })
        .collect();
    // A worker log inside an app's logs folder shows there only.
    let in_app: Vec<(String, String)> = sources
        .iter()
        .filter(|s| s.group.starts_with("app:"))
        .map(|s| (s.dir.clone(), s.base.clone()))
        .collect();
    sources.retain(|s| s.group != "workers" || !in_app.contains(&(s.dir.clone(), s.base.clone())));
    // Within a group: laravel.log first, then the most recently written.
    let rank = |g: &str| match g {
        g if g.starts_with("app:") => 0,
        "workers" => 1,
        "web" => 2,
        "php" => 3,
        _ => 4,
    };
    let newest = |s: &LogSource| s.files.first().map_or(0.0, |f| f.mtime);
    sources.sort_by(|a, b| {
        rank(&a.group)
            .cmp(&rank(&b.group))
            .then_with(|| (b.base == "laravel.log").cmp(&(a.base == "laravel.log")))
            .then_with(|| newest(b).total_cmp(&newest(a)))
    });
    Ok(sources)
}

/// The logs on a server: an app's (or, for a server, every app's) and the
/// server's own.
#[tauri::command]
pub async fn logs_sources(
    state: State<'_, AppState>,
    server_id: String,
    app_id: Option<String>,
) -> AppResult<Vec<LogSource>> {
    let server = lookup(&state, &server_id)?;
    let apps: Vec<(String, String)> = server
        .apps
        .iter()
        .filter(|a| app_id.as_deref().is_none_or(|id| a.id == id))
        .map(|a| (a.id.clone(), a.path.clone()))
        .collect();
    if let Some(id) = &app_id {
        if apps.is_empty() {
            return Err(AppError::NotFound(format!(
                "app `{id}` isn't on {server_id}"
            )));
        }
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &sources_script(&apps, app_id.is_none(), password.as_deref()),
    )
    .await?;
    parse_sources(&out)
}

/// Runs as the ssh user, or under sudo: exits 3 when that user can't list
/// the folder or read the file. Picks the family's newest file (or the
/// pinned one) and prints the byte range asked for, base64.
const READ: &str = r#"d=$1 B=$2 stem=$3 daily=$4 pin=$5 from=$6 ino0=$7 max=$8 before=$9
{ [ -r "$d" ] && [ -x "$d" ]; } || exit 3
TAB=$(printf "\t")
if [ -n "$pin" ]; then n=$pin
else
n=$(find "$d" -maxdepth 1 -type f -name "$stem*" -printf "%Ts\t%f\n" 2>/dev/null | while IFS="$TAB" read -r t x; do
  case "$x" in *.gz|*.xz|*.bz2|*.zip|*.zst) continue ;; esac
  case "$x" in
    "$B"|"$B".[0-9]*|"$B"-[0-9]*) ;;
    "$stem"-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].log) [ "$daily" = 1 ] || continue ;;
    *) continue ;;
  esac
  printf "%s\t%s\n" "$t" "$x"
done | sort -n | tail -n 1 | cut -f2)
fi
[ -n "$n" ] || { echo "@@err there's no $B in $d any more"; exit 0; }
f="$d/$n"
[ -f "$f" ] || { echo "@@err $f is gone"; exit 0; }
[ -r "$f" ] || exit 3
set -- $(stat -c "%s %i %Y" -- "$f")
sz=$1 ino=$2 mt=$3
if [ "$before" -ge 0 ]; then
  [ "$before" -le "$sz" ] || before=$sz
  start=$(( before > max ? before - max : 0 )); len=$(( before - start ))
elif [ "$ino" = "$ino0" ] && [ "$sz" -ge "$from" ]; then
  start=$from; len=$(( sz - from ))
  if [ "$len" -gt "$max" ]; then start=$(( sz - max )); len=$max; fi
else
  start=$(( sz > max ? sz - max : 0 )); len=$(( sz - start ))
fi
printf "@@file %s %s %s %s %s %s\n" "$sz" "$ino" "$mt" "$start" "$len" "$(date +%s)"
printf "@@path %s\n" "$f"
echo @@data
if [ "$len" -gt 0 ]; then tail -c +$(( start + 1 )) -- "$f" | head -c "$len" | base64 -w 0; fi
echo
echo @@end
"#;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    /// The last TAIL bytes.
    Tail,
    /// New bytes after `from` in the file with this inode.
    Follow { from: u64, inode: u64 },
    /// TAIL bytes before `before` (Load earlier).
    Before { before: u64, inode: u64 },
}

fn read_script(
    dir: &str,
    base: &str,
    pin: Option<&str>,
    mode: Mode,
    password: Option<&str>,
) -> String {
    let stem = base.strip_suffix(".log").unwrap_or(base);
    let daily = if base.ends_with(".log") { "1" } else { "0" };
    let (from, inode, max, before) = match mode {
        Mode::Tail => (0, 0, TAIL, -1i64),
        Mode::Follow { from, inode } => (from, inode, FOLLOW_MAX, -1),
        Mode::Before { before, inode } => (0, inode, TAIL, i64::try_from(before).unwrap_or(0)),
    };
    let args = [
        shell_quote(dir),
        shell_quote(base),
        shell_quote(stem),
        daily.to_string(),
        shell_quote(pin.unwrap_or("")),
        from.to_string(),
        inode.to_string(),
        max.to_string(),
        before.to_string(),
    ]
    .join(" ");
    let su = if password.is_some() {
        "sudo -A"
    } else {
        "sudo -n"
    };
    format!(
        r#"export LC_ALL=C
READ={read}
out=$(sh -c "$READ" _ {args}); rc=$?
if [ "$rc" = 3 ]; then
{askpass}  if out=$({su} sh -c "$READ" _ {args}); then echo @@sudo
  else
{prelude}    echo "@@err can't read {what}: {NO_SUDO}"; exit 0
  fi
fi
printf '%s\n' "$out"
"#,
        read = shell_quote(READ),
        askpass = password.map(askpass).unwrap_or_default(),
        prelude = sudo_prelude(password),
        what = format!("{}/{}", dir.trim_end_matches('/'), pin.unwrap_or(base))
            .replace(['"', '$', '`', '\\'], "?"),
    )
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    /// The file read (the family's newest, or the pinned one).
    pub path: String,
    pub size: u64,
    pub inode: u64,
    pub mtime: f64,
    /// Byte range of `text` in the file.
    pub start: u64,
    pub end: u64,
    pub text: String,
    /// Not a continuation of what was shown: a first read, a different file
    /// (a new day's, or rotated) or the file was cut short.
    pub reset: bool,
    /// Following: new bytes jumped over (too much at once).
    pub skipped: u64,
    /// Read with sudo.
    pub sudo: bool,
}

fn parse_read(out: &str, mode: Mode) -> AppResult<LogChunk> {
    errors(out)?;
    let head = out
        .lines()
        .find_map(|l| l.strip_prefix("@@file "))
        .ok_or_else(|| AppError::Invalid("no answer reading the log".into()))?;
    let n: Vec<u64> = head.split(' ').map(|x| x.parse().unwrap_or(0)).collect();
    let [size, inode, mtime, start, _len, now] = n[..] else {
        return Err(AppError::Invalid("an odd answer reading the log".into()));
    };
    let path = out
        .lines()
        .find_map(|l| l.strip_prefix("@@path "))
        .unwrap_or_default()
        .to_string();
    let data = out
        .split_once("@@data\n")
        .and_then(|(_, rest)| rest.split_once("\n@@end"))
        .map(|(d, _)| d.trim())
        .ok_or_else(|| AppError::Invalid("the log's contents didn't arrive".into()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| AppError::Invalid(format!("the log's contents came garbled ({e})")))?;
    let mut start = start;
    let mut body: &[u8] = &bytes;
    let (reset, skipped) = match mode {
        Mode::Tail => (true, 0),
        Mode::Follow { from, inode: i } if i == inode && size >= from => {
            (false, start.saturating_sub(from))
        }
        Mode::Follow { .. } => (true, 0),
        Mode::Before { .. } => (false, 0),
    };
    // Starting mid-file: drop the cut-off first line.
    let cut_head = start > 0 && (reset || skipped > 0 || matches!(mode, Mode::Before { .. }));
    if cut_head {
        if let Some(i) = body.iter().position(|&b| b == b'\n') {
            body = &body[i + 1..];
            start += i as u64 + 1;
        }
    }
    // Reading to the end: hold back a line still being written (unless the
    // file has been quiet a few seconds, or it's one huge line).
    let mut end = start + body.len() as u64;
    if !matches!(mode, Mode::Before { .. })
        && !body.ends_with(b"\n")
        && now.saturating_sub(mtime) < 3
    {
        if let Some(i) = body.iter().rposition(|&b| b == b'\n') {
            body = &body[..=i];
            end = start + body.len() as u64;
        } else if (body.len() as u64) < TAIL {
            body = &[];
            end = start;
        }
    }
    Ok(LogChunk {
        path,
        size,
        inode,
        mtime: mtime as f64,
        start,
        end,
        text: String::from_utf8_lossy(body).into_owned(),
        reset,
        skipped,
        sudo: out.lines().any(|l| l == "@@sudo"),
    })
}

fn check(dir: &str, base: &str, pin: Option<&str>) -> AppResult<()> {
    let bad =
        |s: &str| s.is_empty() || s.contains(['/', '\n', '\r', '\0']) || s == "." || s == "..";
    if !dir.starts_with('/') || dir.contains(['\n', '\r', '\0']) {
        return Err(AppError::Invalid(format!("{dir} isn't a full path")));
    }
    if bad(base) || pin.is_some_and(bad) {
        return Err(AppError::Invalid("that isn't a log file name".into()));
    }
    Ok(())
}

/// Read a log: the last part (no `from`/`before`), what's new since `from`
/// (following), or the part before `before` (Load earlier). `pin` reads
/// that file of the family instead of its newest.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn logs_read(
    state: State<'_, AppState>,
    server_id: String,
    dir: String,
    base: String,
    pin: Option<String>,
    from: Option<u64>,
    before: Option<u64>,
    inode: Option<u64>,
) -> AppResult<LogChunk> {
    lookup(&state, &server_id)?;
    check(&dir, &base, pin.as_deref())?;
    let mode = match (from, before) {
        (_, Some(before)) => Mode::Before {
            before,
            inode: inode.unwrap_or(0),
        },
        (Some(from), None) => Mode::Follow {
            from,
            inode: inode.unwrap_or(0),
        },
        (None, None) => Mode::Tail,
    };
    let password = saved_sudo(&server_id).await;
    let script = read_script(&dir, &base, pin.as_deref(), mode, password.as_deref());
    let out = crate::monitor::run(&state, &server_id, &script).await?;
    parse_read(&out, mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families() {
        assert_eq!(family_of("laravel.log").as_deref(), Some("laravel.log"));
        assert_eq!(
            family_of("laravel-2026-10-09.log").as_deref(),
            Some("laravel.log")
        );
        assert_eq!(
            family_of("horizon-2026-10-09.log").as_deref(),
            Some("horizon.log")
        );
        assert_eq!(family_of("error.log.1").as_deref(), Some("error.log"));
        assert_eq!(family_of("error.log.2.gz"), None);
        assert_eq!(family_of("syslog.1").as_deref(), Some("syslog"));
        assert_eq!(family_of("syslog-20261009").as_deref(), Some("syslog"));
        assert_eq!(
            family_of("php8.3-fpm.log").as_deref(),
            Some("php8.3-fpm.log")
        );
        assert_eq!(family_of("worker.log").as_deref(), Some("worker.log"));
        assert_eq!(
            family_of("2026-10-09.log").as_deref(),
            Some("2026-10-09.log")
        );
    }

    #[test]
    fn groups_sources() {
        let out = "junk\n\
@@f app:web\t/opt/app/storage/logs\tlaravel-2026-10-08.log\t10\t100.0\n\
@@f app:web\t/opt/app/storage/logs\tlaravel-2026-10-09.log\t20\t200.0\n\
@@f app:web\t/opt/app/storage/logs\tlaravel.log\t5\t50.0\n\
@@f app:web\t/opt/app/storage/logs\tworker.log\t5\t300.0\n\
@@f app:web\t/opt/app/storage/logs\t.gitignore\t14\t1.0\n\
@@f web\t/var/log/nginx\terror.log\t1\t90.0\n\
@@f web\t/var/log/nginx\terror.log.1\t1\t80.0\n\
@@f web\t/var/log/nginx\terror.log.2.gz\t1\t70.0\n\
@@f workers\t/opt/app/storage/logs\tworker.log\t5\t300.0\n";
        let s = parse_sources(out).unwrap();
        let names: Vec<_> = s
            .iter()
            .map(|x| (x.group.as_str(), x.base.as_str(), x.files[0].name.as_str()))
            .collect();
        assert_eq!(
            names,
            [
                ("app:web", "laravel.log", "laravel-2026-10-09.log"),
                ("app:web", "worker.log", "worker.log"),
                ("web", "error.log", "error.log"),
            ]
        );
        assert_eq!(s[0].files.len(), 3);
        assert_eq!(s[2].files.len(), 2);
    }

    fn reply(size: u64, inode: u64, mtime: u64, start: u64, now: u64, data: &[u8]) -> String {
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        format!(
            "@@file {size} {inode} {mtime} {start} {} {now}\n@@path /l/laravel.log\n@@data\n{b64}\n@@end\n",
            data.len()
        )
    }

    #[test]
    fn reads_whole_lines() {
        // Tail from mid-file: the cut first line goes, a half-written last one waits.
        let c = parse_read(
            &reply(100, 7, 1000, 80, 1000, b"tail\nline one\nline tw"),
            Mode::Tail,
        )
        .unwrap();
        assert_eq!(c.text, "line one\n");
        assert_eq!((c.start, c.end), (85, 94));
        assert!(c.reset);
        // Quiet for a while: the last line is shown even without its newline.
        let c = parse_read(
            &reply(100, 7, 1000, 94, 1010, b"line two"),
            Mode::Follow { from: 94, inode: 7 },
        )
        .unwrap();
        assert_eq!((c.text.as_str(), c.end, c.reset), ("line two", 102, false));
        // A new file (rotated / new day): reset.
        let c = parse_read(
            &reply(3, 8, 1000, 0, 1010, b"a\nb"),
            Mode::Follow { from: 94, inode: 7 },
        )
        .unwrap();
        assert!(c.reset);
        assert_eq!(c.text, "a\nb");
        // Too much new data: skipped, from a whole line.
        let c = parse_read(
            &reply(5000, 7, 1000, 4000, 1000, b"xx\nnew\n"),
            Mode::Follow { from: 10, inode: 7 },
        )
        .unwrap();
        assert_eq!((c.text.as_str(), c.start, c.skipped), ("new\n", 4003, 3990));
        // Earlier part: drop the cut first line, keep the end as is.
        let c = parse_read(
            &reply(5000, 7, 1000, 10, 1000, b"ut\nwhole\npart"),
            Mode::Before {
                before: 23,
                inode: 7,
            },
        )
        .unwrap();
        assert_eq!((c.text.as_str(), c.start, c.end), ("whole\npart", 13, 23));
        assert!(parse_read("@@err nope\n", Mode::Tail).is_err());
    }

    #[test]
    fn guards() {
        assert!(check("/var/log", "laravel.log", None).is_ok());
        assert!(check("var/log", "laravel.log", None).is_err());
        assert!(check("/var/log", "../x", None).is_err());
        assert!(check("/var/log", "x.log", Some("..")).is_err());
    }

    /// Writes the scripts for a shell test (KEMUDI_LOGS_OUT=/tmp/x cargo test dump_logs -- --ignored).
    #[test]
    #[ignore]
    fn dump_logs_scripts() {
        if let Ok(out) = std::env::var("KEMUDI_LOGS_OUT") {
            let pw = std::env::var("KEMUDI_RF_PW").ok();
            let apps = [("web".to_string(), "/opt/www/app".to_string())];
            std::fs::write(
                format!("{out}.sources"),
                sources_script(&apps, false, pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.tail"),
                read_script(
                    "/opt/www/app/storage/logs",
                    "laravel.log",
                    None,
                    Mode::Tail,
                    pw.as_deref(),
                ),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.root"),
                read_script(
                    "/var/log/nginx",
                    "error.log",
                    None,
                    Mode::Tail,
                    pw.as_deref(),
                ),
            )
            .expect("write");
        }
    }
}
