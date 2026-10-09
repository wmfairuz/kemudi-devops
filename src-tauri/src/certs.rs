//! Let's Encrypt certificates managed by certbot on a server, and a guided
//! renewal for ones issued with a manual DNS challenge (wildcards), which
//! certbot's timer can't renew by itself. Kemudi starts certbot in the
//! background on the server with a small auth hook that writes each
//! challenge to a session folder and waits; the UI shows the TXT record to
//! add, checks the domain's own nameservers for it, and lets the hook go on.
//! When done, the hook is taken back out of the renewal config, the web
//! server reloaded and the session folder removed.

use serde::Serialize;
use tauri::State;

use crate::actions::render::shell_quote;
use crate::error::{AppError, AppResult};
use crate::remote_files::{errors, lookup, saved_sudo, sudo_prelude, NO_SUDO};
use crate::AppState;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertbotCert {
    /// certbot's name for it (`apps.example.net`).
    pub name: String,
    pub domains: Vec<String>,
    pub not_after: Option<i64>,
    pub days_left: Option<i64>,
    /// `manual`, `nginx`, `webroot`, `dns-cloudflare`…
    pub authenticator: String,
    /// Manual, with no hook that does it: needs you each time.
    pub needs_you: bool,
}

/// Root (or sudo) is needed for /etc/letsencrypt.
fn root(password: Option<&str>) -> String {
    format!(
        r#"export LC_ALL=C
{prelude}if [ "$(id -u)" = 0 ]; then S=""; elif [ -n "$SU" ]; then S="$SU"; else echo "@@err certbot's files need root: {NO_SUDO}"; exit 0; fi
"#,
        prelude = sudo_prelude(password),
    )
}

fn list_script(password: Option<&str>) -> String {
    format!(
        r#"{root}echo "@@now $(date +%s)"
command -v certbot >/dev/null 2>&1 || {{ echo "@@none certbot isn't installed"; exit 0; }}
$S sh -c '
for f in /etc/letsencrypt/renewal/*.conf; do
  [ -f "$f" ] || continue
  n=$(basename "$f" .conf)
  echo "@@cert $n"
  sed -n "s/^authenticator *= *\(.*\)/auth \1/p;s/^manual_auth_hook *= *\(.*\)/hook \1/p" "$f"
  c=/etc/letsencrypt/live/$n/cert.pem
  [ -f "$c" ] || continue
  e=$(openssl x509 -noout -enddate -in "$c" 2>/dev/null | sed "s/^notAfter=//")
  [ -n "$e" ] && echo "end $(date -u -d "$e" +%s)"
  echo "dns $(openssl x509 -noout -text -in "$c" 2>/dev/null | grep -o "DNS:[^,[:space:]]*" | sed "s/^DNS://" | tr "\n" " ")"
done'
"#,
        root = root(password),
    )
}

fn parse_list(out: &str) -> AppResult<(Vec<CertbotCert>, Option<String>)> {
    errors(out)?;
    if let Some(n) = out.lines().find_map(|l| l.strip_prefix("@@none ")) {
        return Ok((Vec::new(), Some(n.to_string())));
    }
    let now: i64 = out
        .lines()
        .find_map(|l| l.strip_prefix("@@now "))
        .and_then(|n| n.trim().parse().ok())
        .unwrap_or(0);
    let mut list: Vec<CertbotCert> = Vec::new();
    let mut hook = false;
    for l in out.lines() {
        if let Some(n) = l.strip_prefix("@@cert ") {
            if let Some(c) = list.last_mut() {
                c.needs_you = c.authenticator == "manual" && !hook;
            }
            hook = false;
            list.push(CertbotCert {
                name: n.trim().to_string(),
                ..CertbotCert::default()
            });
            continue;
        }
        let Some(c) = list.last_mut() else { continue };
        if let Some(a) = l.strip_prefix("auth ") {
            c.authenticator = a.trim().to_string();
        } else if let Some(h) = l.strip_prefix("hook ") {
            // Our own leftover temporary hook doesn't count.
            hook = !h.contains("/tmp/kemudi-certbot-");
        } else if let Some(e) = l.strip_prefix("end ") {
            c.not_after = e.trim().parse().ok();
            c.days_left = c.not_after.map(|e| (e - now).div_euclid(86400));
        } else if let Some(d) = l.strip_prefix("dns ") {
            c.domains = d.split_whitespace().map(str::to_string).collect();
        }
    }
    if let Some(c) = list.last_mut() {
        c.needs_you = c.authenticator == "manual" && !hook;
    }
    list.sort_by_key(|c| c.days_left.unwrap_or(i64::MAX));
    Ok((list, None))
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertbotList {
    pub certs: Vec<CertbotCert>,
    /// Why there are none (certbot not installed).
    pub note: Option<String>,
}

/// certbot's certificates on a server.
#[tauri::command]
pub async fn certs_list(state: State<'_, AppState>, server_id: String) -> AppResult<CertbotList> {
    lookup(&state, &server_id)?;
    let password = saved_sudo(&server_id).await;
    let out =
        crate::monitor::run_for(&state, &server_id, &list_script(password.as_deref()), 40).await?;
    let (certs, note) = parse_list(&out)?;
    Ok(CertbotList { certs, note })
}

fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 253
        && !n.starts_with(['.', '-'])
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
}

fn valid_domain(d: &str) -> bool {
    let d = d.strip_prefix("*.").unwrap_or(d);
    valid_name(d) && d.contains('.') && !d.contains('_')
}

fn valid_session(dir: &str) -> bool {
    dir.strip_prefix("/tmp/kemudi-certbot-").is_some_and(|r| {
        !r.is_empty() && r.len() <= 16 && r.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// The auth hook: writes the challenge, waits (up to 2 h) for `go.N`.
const HOOK: &str = r#"#!/bin/sh
D=$(dirname "$0")
n=$(ls "$D" | grep -c '^challenge\.[0-9]*$'); n=$((n + 1))
printf '%s\n%s\n' "$CERTBOT_DOMAIN" "$CERTBOT_VALIDATION" > "$D/challenge.$n.tmp" && mv "$D/challenge.$n.tmp" "$D/challenge.$n"
chmod 644 "$D/challenge.$n"
i=0
while [ ! -e "$D/go.$n" ] && [ ! -e "$D/cancel" ] && [ "$i" -lt 7200 ]; do sleep 2; i=$((i + 2)); done
[ -e "$D/cancel" ] && exit 1
[ -e "$D/go.$n" ] || exit 1
exit 0
"#;

fn start_script(name: &str, domains: &[String], password: Option<&str>) -> String {
    let ds = domains
        .iter()
        .map(|d| format!("-d {}", shell_quote(d)))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"{root}command -v certbot >/dev/null 2>&1 || {{ echo "@@err certbot isn't installed"; exit 0; }}
D=$($S mktemp -d /tmp/kemudi-certbot-XXXXXX) || {{ echo "@@err couldn't make a folder in /tmp"; exit 0; }}
$S chmod 755 "$D"
printf '%s' {hook} | $S tee "$D/hook.sh" >/dev/null
$S chmod 755 "$D/hook.sh"
$S sh -c 'cd / && nohup setsid sh -c "certbot certonly --non-interactive --agree-tos --manual --preferred-challenges dns --manual-auth-hook \"$1/hook.sh\" --cert-name \"$2\" --force-renewal $3 > \"$1/log\" 2>&1; echo \$? > \"$1/rc\"; chmod 644 \"$1/log\" \"$1/rc\"" _ "$1" "$2" "$3" < /dev/null > /dev/null 2>&1 &' _ "$D" {name} {ds}
echo "@@session $D"
"#,
        root = root(password),
        hook = shell_quote(HOOK),
        name = shell_quote(name),
        ds = shell_quote(&ds),
    )
}

/// Start renewing `name` (for these domains) in the background.
#[tauri::command]
pub async fn certs_renew_start(
    state: State<'_, AppState>,
    server_id: String,
    name: String,
    domains: Vec<String>,
) -> AppResult<String> {
    let server = lookup(&state, &server_id)?;
    if !valid_name(&name)
        || domains.is_empty()
        || domains.len() > 50
        || !domains.iter().all(|d| valid_domain(d))
    {
        return Err(AppError::Invalid(
            "that isn't a certificate Kemudi renews".into(),
        ));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &start_script(&name, &domains, password.as_deref()),
    )
    .await?;
    errors(&out)?;
    let dir = out
        .lines()
        .find_map(|l| l.strip_prefix("@@session "))
        .map(|d| d.trim().to_string())
        .filter(|d| valid_session(d))
        .ok_or_else(|| AppError::Invalid("certbot didn't start".into()))?;
    record(
        &state,
        &server,
        "Renew certificate",
        &format!(
            "certbot certonly --manual --cert-name {name} {}",
            domains.join(" ")
        ),
        true,
    );
    Ok(dir)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub n: u32,
    /// The domain being validated (`apps.example.net` for `*.apps.example.net`).
    pub domain: String,
    /// The TXT record's name and value.
    pub record: String,
    pub value: String,
    /// Continue was pressed for it.
    pub released: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewStatus {
    pub challenges: Vec<Challenge>,
    /// certbot's exit code, once it's finished.
    pub rc: Option<i32>,
    /// The end of certbot's output.
    pub log: String,
    /// certbot is still running.
    pub running: bool,
}

fn status_script(dir: &str) -> String {
    format!(
        r#"D={d}
[ -d "$D" ] || {{ echo "@@err that renewal isn't running any more"; exit 0; }}
for f in "$D"/challenge.*; do
  case "$f" in *.tmp) continue ;; esac
  [ -f "$f" ] || continue
  n=${{f##*.}}
  echo "@@ch $n $( [ -e "$D/go.$n" ] && echo go )"
  cat "$f"
done
[ -f "$D/rc" ] && echo "@@rc $(cat "$D/rc")"
pgrep -f -- "--manual-auth-hook $D/hook.sh" >/dev/null 2>&1 && echo "@@running"
echo "@@log"
tail -n 25 "$D/log" 2>/dev/null
"#,
        d = shell_quote(dir),
    )
}

fn parse_status(out: &str) -> AppResult<RenewStatus> {
    errors(out)?;
    let mut s = RenewStatus::default();
    let mut lines = out.lines().peekable();
    while let Some(l) = lines.next() {
        if let Some(rest) = l.strip_prefix("@@ch ") {
            let mut it = rest.split_whitespace();
            let n: u32 = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            let released = it.next() == Some("go");
            let domain = lines.next().unwrap_or("").trim().to_string();
            let value = lines.next().unwrap_or("").trim().to_string();
            s.challenges.push(Challenge {
                n,
                record: format!("_acme-challenge.{domain}"),
                domain,
                value,
                released,
            });
        } else if let Some(rc) = l.strip_prefix("@@rc ") {
            s.rc = rc.trim().parse().ok();
        } else if l == "@@running" {
            s.running = true;
        } else if l == "@@log" {
            s.log = lines.by_ref().collect::<Vec<_>>().join("\n");
            break;
        }
    }
    s.challenges.sort_by_key(|c| c.n);
    Ok(s)
}

/// Where a renewal is: the challenges so far, certbot's output, done or not.
#[tauri::command]
pub async fn certs_renew_status(
    state: State<'_, AppState>,
    server_id: String,
    dir: String,
) -> AppResult<RenewStatus> {
    lookup(&state, &server_id)?;
    if !valid_session(&dir) {
        return Err(AppError::Invalid("that isn't a Kemudi renewal".into()));
    }
    let out = crate::monitor::run(&state, &server_id, &status_script(&dir)).await?;
    parse_status(&out)
}

/// The TXT record is in place: let certbot go on with challenge `n`.
#[tauri::command]
pub async fn certs_renew_continue(
    state: State<'_, AppState>,
    server_id: String,
    dir: String,
    n: u32,
) -> AppResult<()> {
    lookup(&state, &server_id)?;
    if !valid_session(&dir) || n == 0 || n > 100 {
        return Err(AppError::Invalid("that isn't a Kemudi renewal".into()));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &format!(
            "{root}$S touch {d}/go.{n} && echo @@ok\n",
            root = root(password.as_deref()),
            d = shell_quote(&dir)
        ),
    )
    .await?;
    errors(&out)?;
    if out.lines().any(|l| l == "@@ok") {
        Ok(())
    } else {
        Err(AppError::Invalid("couldn't tell certbot to go on".into()))
    }
}

fn finish_script(dir: &str, name: &str, reload: bool, password: Option<&str>) -> String {
    format!(
        r#"{root}D={d}; N={n}
# Stop certbot if it's still waiting (cancel), then take our hook back out.
$S touch "$D/cancel" 2>/dev/null
i=0; while pgrep -f -- "--manual-auth-hook $D/hook.sh" >/dev/null 2>&1 && [ $i -lt 10 ]; do sleep 1; i=$((i + 1)); done
pkill -f -- "--manual-auth-hook $D/hook.sh" 2>/dev/null
C=/etc/letsencrypt/renewal/$N.conf
[ -f "$C" ] && $S sed -i "\#^manual_auth_hook = $D/hook.sh\$#d" "$C"
{reload}$S rm -rf -- "$D"
echo "@@done"
"#,
        root = root(password),
        d = shell_quote(dir),
        n = shell_quote(name),
        reload = if reload {
            r#"if command -v nginx >/dev/null 2>&1 && pgrep -x nginx >/dev/null 2>&1; then
  if out=$($S nginx -t 2>&1); then $S systemctl reload nginx 2>&1 || $S nginx -s reload 2>&1; echo "@@reloaded nginx"; else echo "@@reloadfail $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"; fi
elif command -v apache2ctl >/dev/null 2>&1 && pgrep -x apache2 >/dev/null 2>&1; then
  if out=$($S apache2ctl -t 2>&1); then $S systemctl reload apache2 2>&1; echo "@@reloaded apache2"; else echo "@@reloadfail $(printf '%s' "$out" | tail -2 | tr '\n' ' ')"; fi
fi
"#
        } else {
            ""
        },
    )
}

/// End a renewal: stop certbot if it's still waiting (Cancel), take the
/// temporary hook out of the renewal config, reload the web server (after
/// a renewal that worked) and remove the session folder. Returns what was
/// reloaded, if anything.
#[tauri::command]
pub async fn certs_renew_finish(
    state: State<'_, AppState>,
    server_id: String,
    dir: String,
    name: String,
    reload: bool,
) -> AppResult<Option<String>> {
    let server = lookup(&state, &server_id)?;
    if !valid_session(&dir) || !valid_name(&name) {
        return Err(AppError::Invalid("that isn't a Kemudi renewal".into()));
    }
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_for(
        &state,
        &server_id,
        &finish_script(&dir, &name, reload, password.as_deref()),
        40,
    )
    .await?;
    errors(&out)?;
    if let Some(f) = out.lines().find_map(|l| l.strip_prefix("@@reloadfail ")) {
        return Err(AppError::Invalid(format!(
            "renewed, but the web server's config test failed, so it wasn't reloaded: {f}"
        )));
    }
    let reloaded = out
        .lines()
        .find_map(|l| l.strip_prefix("@@reloaded "))
        .map(str::to_string);
    if let Some(r) = &reloaded {
        record(
            &state,
            &server,
            &format!("Reload {r}"),
            &format!("{r} -t && systemctl reload {r} (renewed {name})"),
            true,
        );
    }
    Ok(reloaded)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsCheck {
    /// The zone's nameservers and whether each has the value.
    pub nameservers: Vec<(String, bool)>,
    /// Google's public resolver (may be cached for a while).
    pub google: bool,
    /// The zone the record lives in.
    pub zone: String,
}

fn dns_script(record: &str, value: &str) -> String {
    format!(
        r#"R={r}; V={v}
command -v dig >/dev/null 2>&1 || {{ echo "@@err dig isn't installed on the server (apt install dnsutils)"; exit 0; }}
z=${{R#_acme-challenge.}}
while [ -n "$z" ]; do
  ns=$(dig +short NS "$z" 2>/dev/null | grep '\.$')
  [ -n "$ns" ] && break
  case "$z" in *.*) z=${{z#*.}} ;; *) z="" ;; esac
done
echo "@@zone $z"
for n in $ns; do
  if dig +short +time=3 +tries=1 TXT "$R" @"$n" 2>/dev/null | tr -d '"' | grep -qxF -- "$V"; then echo "@@ns $n yes"; else echo "@@ns $n no"; fi
done
if dig +short +time=3 +tries=1 TXT "$R" @8.8.8.8 2>/dev/null | tr -d '"' | grep -qxF -- "$V"; then echo "@@google yes"; else echo "@@google no"; fi
"#,
        r = shell_quote(record),
        v = shell_quote(value),
    )
}

/// Is the TXT record live on the domain's own nameservers (what Let's
/// Encrypt asks)? Checked from the server with dig.
#[tauri::command]
pub async fn certs_dns_check(
    state: State<'_, AppState>,
    server_id: String,
    record: String,
    value: String,
) -> AppResult<DnsCheck> {
    lookup(&state, &server_id)?;
    let rec_ok = record
        .strip_prefix("_acme-challenge.")
        .is_some_and(valid_domain);
    let val_ok = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b));
    if !rec_ok || !val_ok {
        return Err(AppError::Invalid(
            "that isn't an ACME challenge record".into(),
        ));
    }
    let out = crate::monitor::run_for(&state, &server_id, &dns_script(&record, &value), 40).await?;
    errors(&out)?;
    let mut c = DnsCheck::default();
    for l in out.lines() {
        if let Some(z) = l.strip_prefix("@@zone ") {
            c.zone = z.trim().to_string();
        } else if let Some(r) = l.strip_prefix("@@ns ") {
            let mut it = r.split_whitespace();
            if let (Some(n), Some(y)) = (it.next(), it.next()) {
                c.nameservers
                    .push((n.trim_end_matches('.').to_string(), y == "yes"));
            }
        } else if let Some(g) = l.strip_prefix("@@google ") {
            c.google = g.trim() == "yes";
        }
    }
    Ok(c)
}

fn record(
    state: &AppState,
    server: &crate::config::schema::Server,
    label: &str,
    what: &str,
    ok: bool,
) {
    if let Ok(log) = state.audit.as_ref() {
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: None,
            action_id: "certs",
            label,
            env: server.env.as_str(),
            kind: "edit",
            command: what,
            edited: false,
        }) {
            let _ = log.finish(row, Some(i32::from(!ok)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists() {
        let out = "@@now 1000000\n@@cert apps.example.net\nauth manual\nend 1691200\ndns *.apps.example.net \n@@cert a.com\nauth nginx\nend 3000000\ndns a.com www.a.com\n@@cert hooked\nauth manual\nhook /etc/letsencrypt/cf.sh\n@@cert leftover\nauth manual\nhook /tmp/kemudi-certbot-abc/hook.sh\n";
        let (l, note) = parse_list(out).unwrap();
        assert!(note.is_none());
        assert_eq!(l[0].name, "apps.example.net");
        assert_eq!(l[0].days_left, Some(8));
        assert_eq!(l[0].domains, ["*.apps.example.net"]);
        assert!(l[0].needs_you);
        assert!(!l.iter().find(|c| c.name == "a.com").unwrap().needs_you);
        assert!(!l.iter().find(|c| c.name == "hooked").unwrap().needs_you);
        assert!(l.iter().find(|c| c.name == "leftover").unwrap().needs_you);
        assert_eq!(
            parse_list("@@none certbot isn't installed\n")
                .unwrap()
                .1
                .as_deref(),
            Some("certbot isn't installed")
        );
    }

    #[test]
    fn statuses() {
        let out = "@@ch 1 go\nx.com\nAAA\n@@ch 2\nx.com\nBBB\n@@running\n@@log\nline1\nline2\n";
        let s = parse_status(out).unwrap();
        assert_eq!(s.challenges.len(), 2);
        assert!(s.challenges[0].released && !s.challenges[1].released);
        assert_eq!(s.challenges[1].record, "_acme-challenge.x.com");
        assert!(s.running && s.rc.is_none());
        assert_eq!(s.log, "line1\nline2");
    }

    #[test]
    fn guards() {
        assert!(valid_domain("*.apps.example.net"));
        assert!(valid_domain("a.b.com"));
        assert!(!valid_domain("a b.com"));
        assert!(!valid_domain("-x.com"));
        assert!(valid_session("/tmp/kemudi-certbot-AbC123"));
        assert!(!valid_session("/tmp/kemudi-certbot-../etc"));
        assert!(!valid_session("/etc/letsencrypt"));
    }

    /// KEMUDI_CERTS_OUT=/tmp/x cargo test dump_certs -- --ignored
    #[test]
    #[ignore]
    fn dump_certs() {
        if let Ok(out) = std::env::var("KEMUDI_CERTS_OUT") {
            let w = |n: &str, s: String| std::fs::write(format!("{out}.{n}"), s).expect("write");
            w("list", list_script(None));
            w(
                "start",
                start_script("x.test", &["*.x.test".into(), "x.test".into()], None),
            );
            w("status", status_script("/tmp/kemudi-certbot-SESSION"));
            w(
                "finish",
                finish_script("/tmp/kemudi-certbot-SESSION", "x.test", true, None),
            );
            w(
                "dns",
                dns_script(
                    "_acme-challenge.apps.example.net",
                    "yVJaPJGee6ornXz1AwZL8CVVuE07uSiHXMnuyJILjwk",
                ),
            );
        }
    }
}
