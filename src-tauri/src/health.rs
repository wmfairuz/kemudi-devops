//! Health checks for a server, read-only. **SSL**: every name the web
//! server's vhosts serve, checked against what nginx/Apache actually hands
//! out (`openssl s_client` to 127.0.0.1 on the server, so no call from this
//! Mac) and the certificate files on disk (renewed but not reloaded?), plus
//! whether something renews them. **System**: OS, pending (security)
//! updates, reboot needed, the usual services and any failed unit. **Apps**:
//! PHP and Laravel versions, APP_ENV / APP_DEBUG. `composer audit` runs on
//! request (it asks packagist, from the server).

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::State;

use crate::actions::render::shell_quote;
use crate::error::{AppError, AppResult};
use crate::remote_files::{lookup, saved_sudo, sudo_prelude};
use crate::AppState;

/// More names than this aren't checked (one openssl each).
const MAX_NAMES: usize = 60;

const SSL: &str = r#"echo "@@now $(date +%s)"
VH="/etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf /etc/apache2/sites-enabled/* /etc/httpd/conf.d/*.conf"
rd() { cat -- "$1" 2>/dev/null || { [ -n "$SU" ] && $SU cat -- "$1" 2>/dev/null; }; }
names=""
for f in $VH; do
  [ -f "$f" ] || continue
  t=$(rd "$f") || continue
  case "$t" in *443*|*ssl_certificate*|*SSLEngine*) ;; *) continue ;; esac
  echo "@@vhost $f"
  printf '%s\n' "$t" | sed 's/#.*//' | tr ';{}' '\n\n\n' | sed -n 's/^[[:space:]]*\(server_name\|ServerName\|ServerAlias\)[[:space:]]\{1,\}\(.*\)/name \2/p;s/^[[:space:]]*\(root\|DocumentRoot\)[[:space:]]\{1,\}\([^[:space:]]*\).*/root \2/p;s/^[[:space:]]*\(ssl_certificate\|SSLCertificateFile\)[[:space:]]\{1,\}\([^[:space:]]*\).*/crt \2/p'
done
"#;

/// Checks the names Rust picked (one per line on stdin of this part).
const SSL_CHECK: &str = r#"pem() { echo | timeout 6 openssl s_client -connect "$1" -servername "$2" 2>/dev/null | sed -n '/BEGIN CERT/,/END CERT/p'; }
show() {
  e=$(printf '%s\n' "$1" | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
  [ -n "$e" ] || { echo none; return; }
  echo "end $(date -u -d "$e" +%s 2>/dev/null)"
  echo "issuer $(printf '%s\n' "$1" | openssl x509 -noout -issuer 2>/dev/null | sed 's/^issuer=[[:space:]]*//')"
  echo "subject $(printf '%s\n' "$1" | openssl x509 -noout -subject 2>/dev/null | sed 's/^subject=[[:space:]]*//')"
  echo "dns $(printf '%s\n' "$1" | openssl x509 -noout -text 2>/dev/null | grep -o 'DNS:[^,[:space:]]*' | sed 's/^DNS://' | tr '\n' ' ')"
}
command -v openssl >/dev/null 2>&1 || { echo "@@nossl openssl isn't installed"; }
for n in $NAMES; do
  echo "@@cert $n"
  c=$(pem 127.0.0.1:443 "$n"); v=local
  [ -n "$c" ] || { c=$(pem "$n:443" "$n"); v=public; }
  [ -n "$c" ] || { echo none; continue; }
  echo "via $v"
  show "$c"
done
for p in $CRTS; do
  echo "@@file $p"
  c=$(cat -- "$p" 2>/dev/null || { [ -n "$SU" ] && $SU cat -- "$p" 2>/dev/null; })
  [ -n "$c" ] || { echo unreadable; continue; }
  show "$(printf '%s\n' "$c" | sed -n '1,/END CERT/p')"
done
echo @@renew
{ systemctl is-active certbot.timer 2>/dev/null | grep -qx active && echo "certbot.timer"; } || true
{ systemctl is-active snap.certbot.renew.timer 2>/dev/null | grep -qx active && echo "certbot (snap) timer"; } || true
[ -f /etc/cron.d/certbot ] && grep -qv '^[[:space:]]*#' /etc/cron.d/certbot && echo "cron: /etc/cron.d/certbot"
(crontab -l 2>/dev/null; [ -n "$SU" ] && $SU crontab -l 2>/dev/null) | grep -v '^[[:space:]]*#' | grep -E 'certbot|acme\.sh|letsencrypt' | head -2 | sed 's/^/cron: /'
echo @@renewerr
if systemctl is-failed --quiet certbot.service 2>/dev/null; then
  echo "certbot.service failed"
  j=$(journalctl -u certbot -n 80 --no-pager 2>/dev/null | grep -E 'Failed to renew|The error was|Challenge failed|Detail:')
  [ -n "$j" ] || { [ -n "$SU" ] && j=$($SU journalctl -u certbot -n 80 --no-pager 2>/dev/null | grep -E 'Failed to renew|The error was|Challenge failed|Detail:'); }
  printf '%s\n' "$j" | sed 's/^.*certbot\[[0-9]*\]: //' | tail -8
fi
"#;

const SYSTEM: &str = r#"echo @@os
(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"); uname -r; cut -d' ' -f1 /proc/uptime
echo @@updates
if [ -x /usr/lib/update-notifier/apt-check ]; then /usr/lib/update-notifier/apt-check 2>&1 | tail -1; fi
echo @@reboot
[ -f /var/run/reboot-required ] && { echo yes; cat /var/run/reboot-required.pkgs 2>/dev/null | head -20; }
echo @@services
systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1, $3, $4}' | grep -E '^(nginx|apache2|httpd|php[0-9.]*-fpm|mysql|mariadb|postgresql(@[^ ]*)?|redis(-server)?|supervisor|supervisord|cron|memcached|docker|fail2ban|meilisearch|horizon[^ ]*)\.service '
echo @@failed
systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}'
"#;

fn apps_part(apps: &[(String, String, String)]) -> String {
    let mut s = String::from("echo @@apps\n");
    for (id, path, php) in apps {
        s.push_str(&format!(
            r#"P={p}; PHP={php}
echo "@app {id}"
if cd "$P" 2>/dev/null; then
  command -v "$PHP" >/dev/null 2>&1 || PHP=php
  echo "php $($PHP -r 'echo PHP_VERSION;' 2>/dev/null)"
  OWN=$(stat -c %U storage 2>/dev/null || stat -c %U .); ME=$(id -un); RU=""
  if [ "$ME" != "$OWN" ]; then
    if [ "$ME" = root ]; then RU="runuser -u $OWN --"; elif [ -n "$SU" ]; then RU="$SU -u $OWN"; fi
  fi
  [ -f artisan ] && echo "laravel $($RU timeout 10 "$PHP" artisan --version --no-ansi 2>/dev/null | head -1)"
  e=$(grep -E '^(APP_ENV|APP_DEBUG)=' .env 2>/dev/null || {{ [ -n "$SU" ] && $SU grep -E '^(APP_ENV|APP_DEBUG)=' .env 2>/dev/null; }})
  [ -e .env ] || echo "noenv"
  printf '%s\n' "$e" | sed -n 's/^/env /p'
  cd / 2>/dev/null
else
  echo "missing"
fi
"#,
            p = shell_quote(path),
            php = shell_quote(php),
            id = id,
        ));
    }
    s
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cert {
    /// The name checked (`app.example.com`).
    pub name: String,
    /// The vhost file it's in.
    pub file: String,
    /// The app whose folder the vhost serves, if known.
    pub app_id: Option<String>,
    /// No certificate came back for it.
    pub missing: bool,
    /// Asked over 127.0.0.1 ("local") or the name itself ("public").
    pub via: String,
    pub not_after: Option<i64>,
    pub days_left: Option<i64>,
    pub issuer: String,
    pub subject: String,
    pub sans: Vec<String>,
    /// The certificate is for this name (CN/SAN, wildcards too).
    pub covers: bool,
    /// The file on disk for it is newer than what's served: reload.
    pub newer_on_disk: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub name: String,
    pub active: String,
    pub sub: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppHealth {
    pub id: String,
    pub missing: bool,
    pub php: Option<String>,
    pub laravel: Option<String>,
    pub app_env: Option<String>,
    pub app_debug: Option<bool>,
    pub no_env: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    /// The server's clock when checked (epoch seconds).
    pub now: i64,
    pub certs: Vec<Cert>,
    /// Names left out (too many).
    pub more_names: usize,
    /// What renews certificates (certbot timer, cron…); empty: nothing found.
    pub renew: Vec<String>,
    /// certbot's last run failed: "certbot.service failed" and why (its log).
    pub renew_errors: Vec<String>,
    pub ssl_error: Option<String>,
    pub os: String,
    pub kernel: String,
    pub uptime_s: u64,
    /// Pending updates, of which security (Ubuntu's apt-check).
    pub updates: Option<u32>,
    pub security_updates: Option<u32>,
    pub reboot_required: bool,
    pub reboot_pkgs: Vec<String>,
    pub services: Vec<Service>,
    pub failed_units: Vec<String>,
    pub apps: Vec<AppHealth>,
    /// Only SSL was checked.
    pub ssl_only: bool,
}

fn sections(out: &str) -> BTreeMap<String, Vec<String>> {
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut cur = String::new();
    for l in out.lines() {
        if let Some(n) = l.strip_prefix("@@") {
            let n = n.split(' ').next().unwrap_or("");
            if [
                "os", "updates", "reboot", "services", "failed", "apps", "renew", "renewerr",
            ]
            .contains(&n)
            {
                cur = n.to_string();
                continue;
            }
            cur.clear();
            continue;
        }
        if !cur.is_empty() {
            map.entry(cur.clone()).or_default().push(l.to_string());
        }
    }
    map
}

/// A name a certificate can be checked for: no `_`, regex or wildcard.
fn checkable(n: &str) -> bool {
    !n.is_empty()
        && n != "_"
        && !n.starts_with('~')
        && !n.contains(['*', '$', '"', '\'', '\\', '/'])
        && n.contains('.')
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:".contains(&b))
        && n.parse::<std::net::IpAddr>().is_err()
}

/// Does a certificate for `cn` / `sans` cover `name`?
fn covers(name: &str, cn: &str, sans: &[String]) -> bool {
    let name = name.to_ascii_lowercase();
    let cn = cn
        .split(',')
        .find_map(|p| {
            p.trim()
                .strip_prefix("CN")
                .map(|v| v.trim_start_matches([' ', '=']).trim().to_string())
        })
        .unwrap_or_default();
    sans.iter()
        .map(String::as_str)
        .chain(std::iter::once(cn.as_str()))
        .any(|p| {
            let p = p.to_ascii_lowercase();
            p == name
                || p.strip_prefix("*.").is_some_and(|base| {
                    name.strip_suffix(base).is_some_and(|head| {
                        head.ends_with('.') && !head[..head.len() - 1].contains('.')
                    })
                })
        })
}

struct Vhosts {
    /// name → (file, root)
    names: Vec<(String, String, Option<String>)>,
    crts: Vec<String>,
}

fn parse_vhosts(out: &str) -> Vhosts {
    let mut v = Vhosts {
        names: Vec::new(),
        crts: Vec::new(),
    };
    let mut file = String::new();
    let mut roots: BTreeMap<String, String> = BTreeMap::new();
    let mut pending: Vec<(String, String)> = Vec::new();
    for l in out.lines() {
        if let Some(f) = l.strip_prefix("@@vhost ") {
            file = f.trim().to_string();
        } else if let Some(n) = l.strip_prefix("name ") {
            for n in n.split_whitespace() {
                if checkable(n) && !pending.iter().any(|(x, _)| x == n) {
                    pending.push((n.to_ascii_lowercase(), file.clone()));
                }
            }
        } else if let Some(r) = l.strip_prefix("root ") {
            roots
                .entry(file.clone())
                .or_insert_with(|| r.trim().trim_matches('"').to_string());
        } else if let Some(c) = l.strip_prefix("crt ") {
            let c = c.trim().trim_matches('"').to_string();
            if c.starts_with('/') && !c.contains('$') && !v.crts.contains(&c) {
                v.crts.push(c);
            }
        }
    }
    v.names = pending
        .into_iter()
        .map(|(n, f)| {
            let root = roots.get(&f).cloned();
            (n, f, root)
        })
        .collect();
    v
}

fn read_cert_lines(lines: &[&str], c: &mut Cert) {
    for l in lines {
        if *l == "none" {
            c.missing = true;
        } else if let Some(x) = l.strip_prefix("via ") {
            c.via = x.trim().to_string();
        } else if let Some(x) = l.strip_prefix("end ") {
            c.not_after = x.trim().parse().ok();
        } else if let Some(x) = l.strip_prefix("issuer ") {
            c.issuer = x.trim().to_string();
        } else if let Some(x) = l.strip_prefix("subject ") {
            c.subject = x.trim().to_string();
        } else if let Some(x) = l.strip_prefix("dns ") {
            c.sans = x.split_whitespace().map(str::to_string).collect();
        }
    }
}

/// Blocks of lines after `@@<tag> <key>` markers.
fn blocks<'a>(out: &'a str, tag: &str) -> Vec<(String, Vec<&'a str>)> {
    let mut list: Vec<(String, Vec<&str>)> = Vec::new();
    let mut on = false;
    let marker = format!("@@{tag} ");
    for l in out.lines() {
        if let Some(k) = l.strip_prefix(&marker) {
            list.push((k.trim().to_string(), Vec::new()));
            on = true;
        } else if l.starts_with("@@") {
            on = false;
        } else if on {
            if let Some((_, b)) = list.last_mut() {
                b.push(l);
            }
        }
    }
    list
}

fn parse_ssl(
    out: &str,
    names: &[(String, String, Option<String>)],
    apps: &[(String, String, String)],
    h: &mut Health,
) {
    if let Some(e) = out.lines().find_map(|l| l.strip_prefix("@@nossl ")) {
        h.ssl_error = Some(e.to_string());
    }
    // Certificate files on disk: subject → newest expiry.
    let mut disk: Vec<(Cert, i64)> = Vec::new();
    for (_, lines) in blocks(out, "file") {
        let mut c = Cert::default();
        read_cert_lines(&lines, &mut c);
        if let Some(end) = c.not_after {
            disk.push((c, end));
        }
    }
    for (name, lines) in blocks(out, "cert") {
        let Some((_, file, root)) = names.iter().find(|(n, _, _)| *n == name) else {
            continue;
        };
        let mut c = Cert {
            name: name.clone(),
            file: file.clone(),
            ..Cert::default()
        };
        read_cert_lines(&lines, &mut c);
        c.app_id = root.as_deref().and_then(|r| {
            apps.iter()
                .find(|(_, p, _)| {
                    let p = p.trim_end_matches('/');
                    r == p || r.starts_with(&format!("{p}/"))
                })
                .map(|(id, _, _)| id.clone())
        });
        if !c.missing {
            c.covers = covers(&c.name, &c.subject, &c.sans);
            c.days_left = c.not_after.map(|e| (e - h.now).div_euclid(86400));
            // The same certificate on disk, renewed since nginx loaded it.
            c.newer_on_disk = disk
                .iter()
                .filter(|(d, _)| covers(&c.name, &d.subject, &d.sans))
                .map(|(_, end)| *end)
                .max()
                .filter(|end| c.not_after.is_some_and(|s| *end > s + 86400));
        }
        h.certs.push(c);
    }
    h.certs.sort_by(|a, b| {
        let key = |c: &Cert| {
            if c.missing || !c.covers {
                i64::MIN
            } else {
                c.days_left.unwrap_or(i64::MAX)
            }
        };
        key(a).cmp(&key(b)).then_with(|| a.name.cmp(&b.name))
    });
    let mut sec = sections(out);
    let mut lines = |k: &str| -> Vec<String> {
        sec.remove(k)
            .unwrap_or_default()
            .into_iter()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    };
    h.renew = lines("renew");
    h.renew_errors = lines("renewerr");
}

fn parse_system(out: &str, h: &mut Health) {
    let mut sec = sections(out);
    let os = sec.remove("os").unwrap_or_default();
    h.os = os.first().map(|s| s.trim().to_string()).unwrap_or_default();
    h.kernel = os.get(1).map(|s| s.trim().to_string()).unwrap_or_default();
    h.uptime_s = os
        .get(2)
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map_or(0, |f| f as u64);
    if let Some(u) = sec
        .remove("updates")
        .and_then(|u| u.into_iter().find(|l| l.contains(';')))
    {
        let mut it = u.trim().split(';');
        h.updates = it.next().and_then(|x| x.parse().ok());
        h.security_updates = it.next().and_then(|x| x.parse().ok());
    }
    let reboot = sec.remove("reboot").unwrap_or_default();
    h.reboot_required = reboot.first().is_some_and(|l| l.trim() == "yes");
    h.reboot_pkgs = reboot
        .iter()
        .skip(1)
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    h.services = sec
        .remove("services")
        .unwrap_or_default()
        .iter()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some(Service {
                name: it.next()?.trim_end_matches(".service").to_string(),
                active: it.next()?.to_string(),
                sub: it.next().unwrap_or("").to_string(),
            })
        })
        .collect();
    h.failed_units = sec
        .remove("failed")
        .unwrap_or_default()
        .into_iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && l != "●")
        .collect();
    let mut cur: Option<AppHealth> = None;
    for l in sec.remove("apps").unwrap_or_default() {
        if let Some(id) = l.strip_prefix("@app ") {
            if let Some(a) = cur.take() {
                h.apps.push(a);
            }
            cur = Some(AppHealth {
                id: id.trim().to_string(),
                ..AppHealth::default()
            });
            continue;
        }
        let Some(a) = cur.as_mut() else { continue };
        if l == "missing" {
            a.missing = true;
        } else if l == "noenv" {
            a.no_env = true;
        } else if let Some(v) = l.strip_prefix("php ") {
            a.php = Some(v.trim().to_string()).filter(|v| !v.is_empty());
        } else if let Some(v) = l.strip_prefix("laravel ") {
            a.laravel = Some(
                v.trim()
                    .trim_start_matches("Laravel Framework")
                    .trim()
                    .to_string(),
            )
            .filter(|v| !v.is_empty());
        } else if let Some(v) = l.strip_prefix("env APP_ENV=") {
            a.app_env = Some(v.trim().trim_matches(['"', '\'']).to_string());
        } else if let Some(v) = l.strip_prefix("env APP_DEBUG=") {
            let v = v.trim().trim_matches(['"', '\'']).to_ascii_lowercase();
            a.app_debug = Some(v == "true" || v == "1" || v == "(true)");
        }
    }
    if let Some(a) = cur {
        h.apps.push(a);
    }
}

fn apps_of(server: &crate::config::schema::Server) -> Vec<(String, String, String)> {
    server
        .apps
        .iter()
        .map(|a| {
            let php = a
                .php
                .clone()
                .as_deref()
                .and_then(crate::queues::php_binary)
                .unwrap_or_else(|| "php".into());
            (a.id.clone(), a.path.clone(), php)
        })
        .collect()
}

/// Check a server: SSL (always), and unless `ssl_only` the system and its
/// apps.
#[tauri::command]
pub async fn health_check(
    state: State<'_, AppState>,
    server_id: String,
    ssl_only: Option<bool>,
) -> AppResult<Health> {
    let server = lookup(&state, &server_id)?;
    let apps = apps_of(&server);
    let ssl_only = ssl_only.unwrap_or(false);
    let password = saved_sudo(&server_id).await;
    let prelude = format!("export LC_ALL=C\n{}", sudo_prelude(password.as_deref()));
    // 1: the vhosts' names (and the system and apps, in the same trip).
    let mut first = format!("{prelude}{SSL}");
    if !ssl_only {
        first.push_str(SYSTEM);
        first.push_str(&apps_part(&apps));
    }
    let out = crate::monitor::run_for(&state, &server_id, &first, 60).await?;
    crate::remote_files::errors(&out)?;
    let mut h = Health {
        ssl_only,
        ..Health::default()
    };
    h.now = out
        .lines()
        .find_map(|l| l.strip_prefix("@@now "))
        .and_then(|n| n.trim().parse().ok())
        .ok_or_else(|| AppError::Invalid("no answer from the server".into()))?;
    if !ssl_only {
        parse_system(&out, &mut h);
    }
    let vh = parse_vhosts(&out);
    h.more_names = vh.names.len().saturating_sub(MAX_NAMES);
    let names: Vec<_> = vh.names.into_iter().take(MAX_NAMES).collect();
    if names.is_empty() && vh.crts.is_empty() {
        return Ok(h);
    }
    // 2: what's served for each name, and the files on disk.
    let list = |v: Vec<String>| {
        v.iter()
            .map(|x| shell_quote(x))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let second = format!(
        "{prelude}NAMES={n}\nCRTS={c}\n{SSL_CHECK}",
        n = shell_quote(&list(names.iter().map(|(n, _, _)| n.clone()).collect())),
        c = shell_quote(&list(vh.crts.clone())),
    )
    // The lists are quoted words inside one quoted string: unpack them.
    .replace(
        "for n in $NAMES; do",
        "eval \"set -- $NAMES\"\nfor n in \"$@\"; do",
    )
    .replace(
        "for p in $CRTS; do",
        "eval \"set -- $CRTS\"\nfor p in \"$@\"; do",
    );
    let out2 = crate::monitor::run_for(&state, &server_id, &second, 90).await?;
    parse_ssl(&out2, &names, &apps, &mut h);
    Ok(h)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advisory {
    pub package: String,
    pub title: String,
    pub cve: Option<String>,
    pub link: Option<String>,
    pub severity: Option<String>,
    pub affected: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Audit {
    pub advisories: Vec<Advisory>,
    /// Abandoned packages (and what to use instead, if any).
    pub abandoned: Vec<(String, Option<String>)>,
}

fn parse_audit(json: &str) -> AppResult<Audit> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| {
        AppError::Invalid(format!(
            "composer audit said: {}",
            json.lines().take(3).collect::<Vec<_>>().join(" ")
        ))
    })?;
    let mut a = Audit::default();
    if let Some(m) = v.get("advisories").and_then(|x| x.as_object()) {
        for (pkg, list) in m {
            // An object keyed by index in some versions, an array in others.
            let items: Vec<&serde_json::Value> = match list {
                serde_json::Value::Array(x) => x.iter().collect(),
                serde_json::Value::Object(x) => x.values().collect(),
                _ => Vec::new(),
            };
            for i in items {
                let s = |k: &str| i.get(k).and_then(|x| x.as_str()).map(str::to_string);
                a.advisories.push(Advisory {
                    package: pkg.clone(),
                    title: s("title").unwrap_or_default(),
                    cve: s("cve"),
                    link: s("link"),
                    severity: s("severity"),
                    affected: s("affectedVersions").unwrap_or_default(),
                });
            }
        }
    }
    if let Some(m) = v.get("abandoned").and_then(|x| x.as_object()) {
        for (pkg, repl) in m {
            a.abandoned
                .push((pkg.clone(), repl.as_str().map(str::to_string)));
        }
    }
    Ok(a)
}

/// `composer audit` for an app's composer.lock (as the app's owner).
#[tauri::command]
pub async fn health_composer_audit(
    state: State<'_, AppState>,
    server_id: String,
    app_id: String,
) -> AppResult<Audit> {
    let server = lookup(&state, &server_id)?;
    let (_, path, php) = apps_of(&server)
        .into_iter()
        .find(|(id, _, _)| *id == app_id)
        .ok_or_else(|| AppError::NotFound(format!("app `{app_id}` isn't on {server_id}")))?;
    let password = saved_sudo(&server_id).await;
    let script = format!(
        r#"export LC_ALL=C
{prelude}P={p}; PHP={php}
cd "$P" 2>/dev/null || {{ echo "@@err $P doesn't exist"; exit 0; }}
[ -f composer.lock ] || {{ echo "@@err there's no composer.lock in $P"; exit 0; }}
C=$(command -v composer 2>/dev/null) || {{ [ -f composer.phar ] && C=composer.phar; }} || {{ echo "@@err composer isn't installed on the server"; exit 0; }}
command -v "$PHP" >/dev/null 2>&1 || PHP=php
OWN=$(stat -c %U storage 2>/dev/null || stat -c %U .); ME=$(id -un); RU=""
if [ "$ME" != "$OWN" ]; then
  if [ "$ME" = root ]; then RU="runuser -u $OWN --"; elif [ -n "$SU" ]; then RU="$SU -u $OWN"; fi
fi
echo @@json
HOME=/tmp COMPOSER_HOME=/tmp/kemudi-composer-$OWN $RU env HOME=/tmp COMPOSER_HOME=/tmp/kemudi-composer-$OWN timeout 100 "$PHP" "$C" audit --locked --format=json --no-interaction --no-ansi 2>/dev/null
"#,
        prelude = sudo_prelude(password.as_deref()),
        p = shell_quote(&path),
        php = shell_quote(&php),
    );
    let out = crate::monitor::run_for(&state, &server_id, &script, 120).await?;
    crate::remote_files::errors(&out)?;
    let json = out.split_once("@@json\n").map_or("", |(_, j)| j).trim();
    if json.is_empty() {
        return Err(AppError::Invalid(
            "composer audit gave no answer (no network from the server to packagist?)".into(),
        ));
    }
    parse_audit(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_cover() {
        assert!(checkable("app.example.com"));
        assert!(!checkable("_"));
        assert!(!checkable("*.example.com"));
        assert!(!checkable("~^(?<app>.+)\\.x\\.com$"));
        assert!(!checkable("localhost"));
        assert!(!checkable("10.0.0.1"));
        assert!(covers("a.x.com", "CN = a.x.com", &[]));
        assert!(covers("a.x.com", "CN=other", &["*.x.com".into()]));
        assert!(!covers("b.a.x.com", "CN=other", &["*.x.com".into()]));
        assert!(!covers("a.y.com", "CN = a.x.com", &["a.x.com".into()]));
    }

    #[test]
    fn parses_ssl() {
        let first = "@@now 1000000\n@@vhost /etc/nginx/sites-enabled/app\nname app.x.com www.app.x.com _\nroot /opt/www/app/public\ncrt /etc/letsencrypt/live/app.x.com/fullchain.pem\n@@vhost /etc/nginx/sites-enabled/wild\nname ~^(?<a>.+)\\.y\\.com$\n";
        let vh = parse_vhosts(first);
        assert_eq!(vh.names.len(), 2);
        assert_eq!(vh.names[0].2.as_deref(), Some("/opt/www/app/public"));
        assert_eq!(vh.crts, ["/etc/letsencrypt/live/app.x.com/fullchain.pem"]);
        let second = "@@cert app.x.com\nvia local\nend 1864000\nissuer C = US, O = Let's Encrypt, CN = R11\nsubject CN = app.x.com\ndns app.x.com www.app.x.com \n@@cert www.app.x.com\nnone\n@@file /etc/letsencrypt/live/app.x.com/fullchain.pem\nend 9000000\nsubject CN = app.x.com\ndns app.x.com www.app.x.com\n@@renew\ncertbot.timer\n@@renewerr\ncertbot.service failed\nFailed to renew certificate x.com with error: The manual plugin is not working\n";
        let apps = vec![(
            "web".to_string(),
            "/opt/www/app".to_string(),
            "php".to_string(),
        )];
        let mut h = Health {
            now: 1_000_000,
            ..Health::default()
        };
        parse_ssl(second, &vh.names, &apps, &mut h);
        assert_eq!(h.certs[0].name, "www.app.x.com");
        assert!(h.certs[0].missing);
        let c = &h.certs[1];
        assert_eq!(
            (c.days_left, c.covers, c.app_id.as_deref()),
            (Some(10), true, Some("web"))
        );
        assert_eq!(c.newer_on_disk, Some(9_000_000));
        assert_eq!(h.renew, ["certbot.timer"]);
        assert_eq!(h.renew_errors.len(), 2);
    }

    #[test]
    fn parses_system() {
        let out = "@@os\nUbuntu 24.04.1 LTS\n6.8.0-45-generic\n12345.67 999.0\n@@updates\n12;3\n@@reboot\nyes\nlinux-image-6.8.0-47\n@@services\nnginx.service active running\nphp8.3-fpm.service failed failed\n@@failed\nphp8.3-fpm.service\n@@apps\n@app web\nphp 8.3.12\nlaravel Laravel Framework 11.9.2\nenv APP_ENV=production\nenv APP_DEBUG=true\n@app gone\nmissing\n";
        let mut h = Health::default();
        parse_system(out, &mut h);
        assert_eq!(
            (h.updates, h.security_updates, h.reboot_required),
            (Some(12), Some(3), true)
        );
        assert_eq!(h.reboot_pkgs, ["linux-image-6.8.0-47"]);
        assert_eq!(h.services[1].active, "failed");
        assert_eq!(h.failed_units, ["php8.3-fpm.service"]);
        assert_eq!(h.apps[0].laravel.as_deref(), Some("11.9.2"));
        assert_eq!(h.apps[0].app_debug, Some(true));
        assert!(h.apps[1].missing);
    }

    #[test]
    fn parses_audit() {
        let j = r#"{"advisories":{"guzzlehttp/psr7":[{"advisoryId":"x","title":"Improper header validation","cve":"CVE-2023-29197","link":"https://x","affectedVersions":">=2,<2.4.5","severity":"high"}]},"abandoned":{"fruitcake/laravel-cors":null}}"#;
        let a = parse_audit(j).unwrap();
        assert_eq!(a.advisories[0].cve.as_deref(), Some("CVE-2023-29197"));
        assert_eq!(a.abandoned[0].0, "fruitcake/laravel-cors");
        assert!(parse_audit("Composer could not find").is_err());
    }

    /// KEMUDI_HEALTH_OUT=/tmp/x cargo test dump_health -- --ignored
    #[test]
    #[ignore]
    fn dump_health() {
        if let Ok(out) = std::env::var("KEMUDI_HEALTH_OUT") {
            let apps = vec![(
                "web".to_string(),
                "/opt/www/app".to_string(),
                "php".to_string(),
            )];
            std::fs::write(
                &out,
                format!(
                    "export LC_ALL=C\n{}{SSL}{SYSTEM}{}",
                    sudo_prelude(None),
                    apps_part(&apps)
                ),
            )
            .expect("write");
            let names = shell_quote("app.test www.app.test");
            let crts = shell_quote("/etc/ssl/app.pem");
            std::fs::write(
                format!("{out}.check"),
                format!(
                    "export LC_ALL=C\n{}NAMES={names}\nCRTS={crts}\n{SSL_CHECK}",
                    sudo_prelude(None)
                )
                .replace(
                    "for n in $NAMES; do",
                    "eval \"set -- $NAMES\"\nfor n in \"$@\"; do",
                )
                .replace(
                    "for p in $CRTS; do",
                    "eval \"set -- $CRTS\"\nfor p in \"$@\"; do",
                ),
            )
            .expect("write");
        }
    }
}
