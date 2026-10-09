//! "Inspect" on an app's page: what the server says about the app's folder.
//! Nginx/Apache vhosts and Supervisor programs that mention the path, its
//! .env, git branch and last commit, Laravel version and cron lines. One
//! read-only script over the shared ssh connection; a file only root can
//! read is retried with `sudo -n` (no password prompt, read-only). Nothing
//! is saved here except .env secret values, which go to the encrypted
//! `secret_cache`; the UI masks them and its own cache leaves them out.

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vhost {
    pub file: String,
    /// nginx | apache
    pub kind: String,
    pub server_names: Vec<String>,
    pub listens: Vec<String>,
    pub root: Option<String>,
    pub ssl: bool,
    /// e.g. unix:/run/php/php8.2-fpm.sock
    pub php_socket: Option<String>,
    /// From the socket name, e.g. 8.2.
    pub php_version: Option<String>,
    /// The whole file, for copying.
    pub config: String,
    /// Its root uses a variable (`root /opt/www/$app/public`): one vhost
    /// serving many apps.
    pub wildcard: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    pub file: String,
    pub name: String,
    pub command: Option<String>,
    pub numprocs: Option<String>,
    pub user: Option<String>,
    /// From `supervisorctl status`, e.g. "RUNNING pid 123, uptime 3 days".
    pub status: Vec<String>,
    /// The whole file it's defined in, for copying.
    pub config: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
    /// Looks like a password/key/token: the UI hides it until clicked.
    pub secret: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub branch: Option<String>,
    pub last_commit: Option<String>,
    pub laravel: Option<String>,
    pub vhosts: Vec<Vhost>,
    pub programs: Vec<Program>,
    pub cron: Vec<String>,
    /// Where the app's cron lines live (to edit them): "user:<name>" for a
    /// crontab, "file:<path>" for /etc/crontab or /etc/cron.d.
    pub cron_sources: Vec<String>,
    pub env: Option<Vec<EnvVar>>,
    /// Why the .env couldn't be read (missing, permission denied).
    pub env_error: Option<String>,
    /// Every vhost / Supervisor config file on the server, to pin from.
    pub vhost_candidates: Vec<String>,
    pub supervisor_candidates: Vec<String>,
    /// Pinned files that couldn't be read.
    pub missing: Vec<String>,
    /// Why the .env secrets couldn't be kept (encrypted) for next launch.
    pub secret_cache_error: Option<String>,
}

/// Shell function `supconfs`: Supervisor's program files, one per line,
/// from the `[include] files =` globs in supervisord.conf (so subfolders
/// like conf.d/<site>/*.conf count), else the usual folders.
pub(crate) const SUPCONFS: &str = r#"supconfs() {
  F=""
  set -f
  for m in /etc/supervisor/supervisord.conf /etc/supervisord.conf; do
    [ -f "$m" ] || continue
    for p in $(sed -n '/^\[include\]/,/^\[/s/^[[:space:]]*files[[:space:]]*=[[:space:]]*//p' "$m" 2>/dev/null); do
      case "$p" in /*) ;; *) p="${m%/*}/$p" ;; esac
      F="$F $p"
    done
  done
  set +f
  [ -n "$F" ] || F="/etc/supervisor/conf.d/*.conf /etc/supervisor/conf.d/*.ini /etc/supervisord.d/*.ini /etc/supervisord.d/*.conf"
  for f in $F; do [ -f "$f" ] && echo "$f"; done
}
"#;

fn script(path: &str, vhost_files: &[String], supervisor_files: &[String]) -> String {
    let q = crate::actions::render::shell_quote;
    let p = q(path);
    // One `pin '<file>'` line per pinned file (each shell-quoted).
    let pins = |files: &[String]| {
        files
            .iter()
            .map(|f| format!("pin {}\n", q(f)))
            .collect::<String>()
    };
    let (vf, sf) = (pins(vhost_files), pins(supervisor_files));
    // `rd f`: print a file, falling back to passwordless sudo when only root
    // can read it. `scan`: pinned files always, then candidates that mention
    // the path, or (wildcard vhosts) its parent folder followed by `$`.
    format!(
        r#"export LC_ALL=C
P={p}
D=$(dirname "$P")
rd() {{ cat -- "$1" 2>/dev/null || sudo -n cat -- "$1" 2>/dev/null; }}
seen=" "
pin() {{
  c=$(rd "$1") || {{ echo "@missing $1"; return; }}
  echo "@file $1"; printf '%s\n' "$c"; seen="$seen$1 "
}}
scan() {{
  for f in "$@"; do
    [ -f "$f" ] || continue
    case "$seen" in *" $f "*) continue ;; esac
    c=$(rd "$f") || continue
    case "$c" in *"$P"*|*"$D/\$"*) echo "@file $f"; printf '%s\n' "$c" ;; esac
  done
}}
VHOSTS="/etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf /etc/apache2/sites-enabled/* /etc/httpd/conf.d/*.conf"
{SUPCONFS}SUPS=$(supconfs)
echo @@git
git -c safe.directory='*' -C "$P" rev-parse --abbrev-ref HEAD 2>/dev/null
git -c safe.directory='*' -C "$P" log -1 --format='%h · %cr · %s' 2>/dev/null
echo @@laravel
[ -f "$P/artisan" ] && cd "$P" 2>/dev/null && timeout 8 php artisan --version 2>/dev/null | head -1
cd / 2>/dev/null
echo @@vhosts
seen=" "
{vf}scan $VHOSTS
echo @@vhostfiles
for f in $VHOSTS; do [ -f "$f" ] && echo "$f"; done
echo @@supervisor
seen=" "
{sf}scan $SUPS
echo @@supfiles
for f in $SUPS; do echo "$f"; done
echo @@status
(supervisorctl status 2>/dev/null || sudo -n supervisorctl status 2>/dev/null) | head -200
echo @@cron
(cat /etc/crontab /etc/cron.d/* 2>/dev/null; crontab -l 2>/dev/null; sudo -n crontab -l -u www-data 2>/dev/null) | grep -F -- "$P" | grep -v '^[[:space:]]*#' | head -20
echo @@cronsrc
for f in /etc/crontab /etc/cron.d/*; do [ -f "$f" ] && grep -qF -- "$P" "$f" 2>/dev/null && echo "file:$f"; done
crontab -l 2>/dev/null | grep -qF -- "$P" && echo "user:$(id -un)"
[ "$(id -un)" != www-data ] && sudo -n crontab -l -u www-data 2>/dev/null | grep -qF -- "$P" && echo "user:www-data"
echo @@env
if [ -e "$P/.env" ]; then rd "$P/.env" || echo "@error permission denied (and sudo needs a password)"; else echo "@error no .env in $P"; fi
"#
    )
}

fn sections(out: &str) -> std::collections::HashMap<String, Vec<String>> {
    let mut map: std::collections::HashMap<String, Vec<String>> = Default::default();
    let mut cur = String::new();
    for line in out.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            cur = name.trim().to_string();
            map.entry(cur.clone()).or_default();
        } else if !cur.is_empty() {
            map.entry(cur.clone()).or_default().push(line.to_string());
        }
    }
    map
}

/// `key value;` / `Key value` → value without the trailing `;`.
fn directive<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let t = line.trim();
    let rest = t.strip_prefix(key)?;
    if !rest.starts_with([' ', '\t']) {
        return None;
    }
    Some(rest.trim().trim_end_matches(';').trim())
}

fn php_version(socket: &str) -> Option<String> {
    // The `php` that's followed by a version: /run/php/php8.2-fpm.sock → 8.2.
    socket.match_indices("php").find_map(|(i, _)| {
        let v: String = socket[i + 3..]
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let v = v.trim_end_matches('.').to_string();
        v.contains('.').then_some(v)
    })
}

pub fn is_secret(key: &str, value: &str) -> bool {
    let k = key.to_ascii_uppercase();
    let words = [
        "PASS",
        "SECRET",
        "KEY",
        "TOKEN",
        "PRIVATE",
        "CREDENTIAL",
        "SALT",
        "AUTH",
        "DSN",
        "SIGNATURE",
    ];
    words.iter().any(|w| k.contains(w))
        // user:password@ in a URL value
        || value.split_once("://").is_some_and(|(_, rest)| rest.split('/').next().is_some_and(|h| h.contains(':') && h.contains('@')))
}

pub(crate) fn parse_env(lines: &[String]) -> Vec<EnvVar> {
    lines
        .iter()
        .filter_map(|l| {
            let t = l.trim();
            if t.is_empty() || t.starts_with('#') {
                return None;
            }
            let t = t.strip_prefix("export ").unwrap_or(t);
            let (k, v) = t.split_once('=')?;
            let key = k.trim().to_string();
            if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return None;
            }
            let mut value = v.trim().to_string();
            if value.len() >= 2
                && ((value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\'')))
            {
                value = value[1..value.len() - 1].to_string();
            } else if let Some(i) = value.find(" #") {
                value.truncate(i);
                value = value.trim_end().to_string();
            }
            let secret = is_secret(&key, &value);
            Some(EnvVar { key, value, secret })
        })
        .collect()
}

pub fn parse(out: &str) -> Inspection {
    let sec = sections(out);
    let get = |n: &str| sec.get(n).cloned().unwrap_or_default();
    let mut ins = Inspection::default();

    let git: Vec<String> = get("git")
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .collect();
    ins.branch = git
        .first()
        .map(|b| b.trim().to_string())
        .filter(|b| b != "HEAD");
    ins.last_commit = git.get(1).map(|c| c.trim().to_string());
    ins.laravel = get("laravel")
        .into_iter()
        .map(|l| l.trim().to_string())
        .find(|l| !l.is_empty());

    for l in get("vhosts").iter().chain(get("supervisor").iter()) {
        if let Some(f) = l.strip_prefix("@missing ") {
            ins.missing.push(f.trim().to_string());
        }
    }
    ins.vhost_candidates = get("vhostfiles")
        .into_iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    ins.supervisor_candidates = get("supfiles")
        .into_iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    for l in get("vhosts") {
        if l.starts_with("@missing ") {
            continue;
        }
        if let Some(f) = l.strip_prefix("@file ") {
            let kind = if f.contains("apache") || f.contains("httpd") {
                "apache"
            } else {
                "nginx"
            };
            ins.vhosts.push(Vhost {
                file: f.trim().to_string(),
                kind: kind.into(),
                ..Default::default()
            });
            continue;
        }
        let Some(v) = ins.vhosts.last_mut() else {
            continue;
        };
        v.config.push_str(&l);
        v.config.push('\n');
        if let Some(x) = directive(&l, "server_name")
            .or_else(|| directive(&l, "ServerName"))
            .or_else(|| directive(&l, "ServerAlias"))
        {
            for n in x.split_whitespace().filter(|n| *n != "_") {
                if !v.server_names.iter().any(|e| e == n) {
                    v.server_names.push(n.to_string());
                }
            }
        } else if let Some(x) = directive(&l, "listen") {
            if x.contains("ssl") || x.starts_with("443") || x.contains(":443") {
                v.ssl = true;
            }
            v.listens.push(x.to_string());
        } else if let Some(x) = l.trim().strip_prefix("<VirtualHost") {
            let x = x.trim().trim_end_matches('>').trim();
            if x.ends_with(":443") {
                v.ssl = true;
            }
            v.listens.push(x.to_string());
        } else if let Some(x) = directive(&l, "root").or_else(|| directive(&l, "DocumentRoot")) {
            v.root
                .get_or_insert_with(|| x.trim_matches('"').to_string());
        } else if directive(&l, "ssl_certificate").is_some()
            || directive(&l, "SSLEngine").is_some_and(|x| x.eq_ignore_ascii_case("on"))
        {
            v.ssl = true;
        } else if let Some(x) = directive(&l, "fastcgi_pass") {
            if v.php_socket.is_none() {
                v.php_version = php_version(x);
                v.php_socket = Some(x.to_string());
            }
        }
    }

    // Each matching file in full, for copying.
    let mut files: std::collections::HashMap<String, String> = Default::default();
    let mut current = String::new();
    for l in get("supervisor") {
        if let Some(f) = l.strip_prefix("@file ") {
            current = f.trim().to_string();
        } else if l.starts_with("@missing ") {
            current.clear();
        } else if !current.is_empty() {
            let c = files.entry(current.clone()).or_default();
            c.push_str(&l);
            c.push('\n');
        }
    }
    for l in get("supervisor") {
        if let Some(f) = l.strip_prefix("@file ") {
            ins.programs.push(Program {
                file: f.trim().to_string(),
                name: String::new(),
                ..Default::default()
            });
            continue;
        }
        let t = l.trim();
        if let Some(name) = t
            .strip_prefix("[program:")
            .and_then(|n| n.strip_suffix(']'))
        {
            // A second program in the same file.
            if ins.programs.last().is_some_and(|p| !p.name.is_empty()) {
                let file = ins
                    .programs
                    .last()
                    .map(|p| p.file.clone())
                    .unwrap_or_default();
                ins.programs.push(Program {
                    file,
                    ..Default::default()
                });
            }
            if let Some(p) = ins.programs.last_mut() {
                p.name = name.to_string();
            }
            continue;
        }
        let Some(p) = ins.programs.last_mut() else {
            continue;
        };
        let kv = |k: &str| {
            t.strip_prefix(k)
                .map(str::trim_start)
                .and_then(|r| r.strip_prefix('='))
                .map(|v| v.trim().to_string())
        };
        if let Some(v) = kv("command") {
            p.command = Some(v);
        } else if let Some(v) = kv("numprocs") {
            p.numprocs = Some(v);
        } else if let Some(v) = kv("user") {
            p.user = Some(v);
        }
    }
    let status = get("status");
    for p in &mut ins.programs {
        // `name` or `name:name_00` lines.
        p.status = status
            .iter()
            .filter(|s| {
                s.split_whitespace()
                    .next()
                    .is_some_and(|n| n == p.name || n.starts_with(&format!("{}:", p.name)))
            })
            .map(|s| s.split_whitespace().skip(1).collect::<Vec<_>>().join(" "))
            .collect();
    }
    ins.programs.retain(|p| !p.name.is_empty());
    for p in &mut ins.programs {
        p.config = files.get(&p.file).cloned().unwrap_or_default();
    }

    for v in &mut ins.vhosts {
        v.wildcard = v.root.as_deref().is_some_and(|r| r.contains('$'));
    }
    ins.cron_sources = get("cronsrc")
        .into_iter()
        .map(|l| l.trim().to_string())
        .filter(|l| l.starts_with("user:") || l.starts_with("file:"))
        .collect();
    ins.cron = get("cron")
        .into_iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let env = get("env");
    match env.iter().find_map(|l| l.strip_prefix("@error ")) {
        Some(e) => ins.env_error = Some(e.to_string()),
        None => ins.env = Some(parse_env(&env)),
    }
    ins
}

#[tauri::command]
pub async fn app_inspect(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    vhost_files: Vec<String>,
    supervisor_files: Vec<String>,
) -> AppResult<Inspection> {
    let ok = |f: &String| f.starts_with('/') && !f.contains(['\n', '\r', '\0']);
    let vhost_files: Vec<String> = vhost_files
        .into_iter()
        .map(|f| f.trim().to_string())
        .filter(ok)
        .collect();
    let supervisor_files: Vec<String> = supervisor_files
        .into_iter()
        .map(|f| f.trim().to_string())
        .filter(ok)
        .collect();
    let path = path.trim().trim_end_matches('/');
    if path.is_empty() || !path.starts_with('/') {
        return Err(AppError::Invalid(
            "set the app's full path first (e.g. /var/www/app)".into(),
        ));
    }
    let out = crate::monitor::run(
        &state,
        &server_id,
        &script(path, &vhost_files, &supervisor_files),
    )
    .await?;
    let mut ins = parse(&out);
    // Keep the secrets encrypted for next launch (or forget them when the
    // .env no longer has any). A Keychain refusal only means they aren't kept.
    if ins.env.is_some() {
        let secrets = ins
            .env
            .iter()
            .flatten()
            .filter(|e| e.secret)
            .map(|e| (e.key.clone(), e.value.clone()))
            .collect();
        let entry = crate::secret_cache::entry(&server_id, path);
        ins.secret_cache_error =
            tauri::async_runtime::spawn_blocking(move || crate::secret_cache::put(&entry, secrets))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
                .err();
    }
    Ok(ins)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: &str = "@@git
main
a1b2c3d · 2 days ago · Fix invoice totals
@@laravel
Laravel Framework 11.9.2
@@vhosts
@file /etc/nginx/sites-enabled/core-v2
    listen 80;
    listen 443 ssl http2;
    server_name core.example.com www.core.example.com;
    root /opt/www/app/public;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
    ssl_certificate /etc/letsencrypt/live/core.example.com/fullchain.pem;
@@supervisor
@file /etc/supervisor/conf.d/core-worker.conf
[program:core-worker]
command=php /opt/www/app/artisan queue:work --sleep=3 --tries=3
numprocs=4
user=www-data
[program:core-horizon]
command=php /opt/www/app/artisan horizon
@@status
core-worker:core-worker_00     RUNNING   pid 1234, uptime 3 days, 4:05:06
core-worker:core-worker_01     RUNNING   pid 1235, uptime 3 days, 4:05:06
core-horizon                   FATAL     Exited too quickly
other                          RUNNING   pid 9, uptime 1 day
@@cron
* * * * * www-data cd /opt/www/app && php artisan schedule:run >> /dev/null 2>&1
@@env
APP_NAME=\"Core V2\"
APP_ENV=production
APP_KEY=base64:abc123=
APP_DEBUG=false
# comment
DB_HOST=10.0.0.5
DB_PASSWORD='s3cr3t'
REDIS_URL=redis://default:hunter2@10.0.0.6:6379
MAIL_FROM_ADDRESS=noreply@example.com # note
";

    #[test]
    fn parses_an_inspection() {
        let i = parse(OUT);
        assert_eq!(i.branch.as_deref(), Some("main"));
        assert_eq!(
            i.last_commit.as_deref(),
            Some("a1b2c3d · 2 days ago · Fix invoice totals")
        );
        assert_eq!(i.laravel.as_deref(), Some("Laravel Framework 11.9.2"));

        let v = &i.vhosts[0];
        assert_eq!(v.server_names, ["core.example.com", "www.core.example.com"]);
        assert!(v.ssl);
        assert_eq!(v.root.as_deref(), Some("/opt/www/app/public"));
        assert_eq!(v.php_version.as_deref(), Some("8.2"));
        assert!(
            v.config.starts_with("    listen 80;\n") && v.config.contains("ssl_certificate"),
            "{}",
            v.config
        );

        assert_eq!(i.programs.len(), 2);
        assert_eq!(i.programs[0].name, "core-worker");
        assert_eq!(i.programs[0].numprocs.as_deref(), Some("4"));
        assert_eq!(i.programs[0].status.len(), 2);
        assert!(i.programs[0].status[0].starts_with("RUNNING"));
        assert_eq!(i.programs[1].name, "core-horizon");
        assert_eq!(i.programs[1].status, ["FATAL Exited too quickly"]);
        assert!(
            i.programs[0].config.contains("[program:core-horizon]")
                && i.programs[1].config == i.programs[0].config
        );
        assert_eq!(i.cron.len(), 1);

        let env = i.env.expect("env");
        let get = |k: &str| env.iter().find(|e| e.key == k).expect(k);
        assert_eq!(get("APP_NAME").value, "Core V2");
        assert!(!get("APP_NAME").secret && !get("DB_HOST").secret && !get("APP_DEBUG").secret);
        assert!(get("APP_KEY").secret && get("DB_PASSWORD").secret && get("REDIS_URL").secret);
        assert_eq!(get("DB_PASSWORD").value, "s3cr3t");
        assert_eq!(get("MAIL_FROM_ADDRESS").value, "noreply@example.com");
    }

    #[test]
    fn env_errors_and_apache() {
        let i = parse("@@vhosts\n@file /etc/apache2/sites-enabled/x.conf\n<VirtualHost *:443>\n  ServerName x.my\n  ServerAlias www.x.my\n  DocumentRoot \"/var/www/x/public\"\n  SSLEngine on\n@@env\n@error no .env in /var/www/x\n");
        assert_eq!(i.vhosts[0].kind, "apache");
        assert_eq!(i.vhosts[0].server_names, ["x.my", "www.x.my"]);
        assert_eq!(i.vhosts[0].root.as_deref(), Some("/var/www/x/public"));
        assert!(i.vhosts[0].ssl);
        assert!(i.env.is_none());
        assert_eq!(i.env_error.as_deref(), Some("no .env in /var/www/x"));
    }

    #[test]
    fn wildcard_pinned_and_candidates() {
        let out = "@@vhosts\n@missing /etc/nginx/sites-enabled/gone\n@file /etc/nginx/sites-enabled/staging-wild\nserver {\n  server_name ~^(?<app>.+)\\.staging\\.northwindech\\.com$;\n  root /opt/www/staging.example.com/$app/public;\n}\n@@vhostfiles\n/etc/nginx/sites-enabled/default\n/etc/nginx/sites-enabled/staging-wild\n@@supervisor\n@@supfiles\n/etc/supervisor/conf.d/a.conf\n";
        let i = parse(out);
        assert_eq!(i.vhosts.len(), 1);
        assert!(i.vhosts[0].wildcard);
        assert!(i.vhosts[0].config.contains("$app"));
        assert_eq!(i.missing, ["/etc/nginx/sites-enabled/gone"]);
        assert_eq!(i.vhost_candidates.len(), 2);
        assert_eq!(i.supervisor_candidates, ["/etc/supervisor/conf.d/a.conf"]);
    }

    /// Writes a generated script to $KEMUDI_SCRIPT_OUT (for a local sh run).
    #[test]
    #[ignore]
    fn dump_script() {
        if let Ok(out) = std::env::var("KEMUDI_SCRIPT_OUT") {
            let pinned = std::env::var("KEMUDI_PIN").unwrap_or_default();
            std::fs::write(
                out,
                script("/opt/www/staging.example.com/billing", &[pinned], &[]),
            )
            .expect("write");
        }
    }

    #[test]
    fn script_only_reads() {
        let s = script(
            "/opt/www/app",
            &["/etc/nginx/sites-enabled/wild app".into()],
            &[],
        );
        assert!(
            s.contains("pin '/etc/nginx/sites-enabled/wild app'\nscan $VHOSTS"),
            "{s}"
        );
        for bad in [
            " > ", ">>", "rm ", "tee ", "sed -i", "chmod", "restart", "stop ", "start ",
        ] {
            assert!(!s.contains(bad), "{bad}");
        }
        assert!(
            s.contains("P='/opt/www/app'") || s.contains("P=/opt/www/app"),
            "{s}"
        );
    }
}
