//! What runs a Laravel app besides the web: its scheduler (a cron line for
//! `artisan schedule:run` every minute) and its queue worker (a Supervisor
//! program running `artisan queue:work`). When an app has neither, its tab
//! proposes them, written the way New app writes them:
//! `/etc/cron.d/laravel-<id>` and `<Supervisor's include folder>/<id>-worker.conf`,
//! run as the owner of the app's `storage/`, with the app's PHP.
//!
//! `runners_plan` only reads; `runners_add` writes the one file (never over
//! a different one), then `supervisorctl reread` / `update` for a worker.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::actions::render::shell_quote;
use crate::error::{AppError, AppResult};
use crate::remote_files::{base64_body, errors, lookup, saved_sudo, sudo_prelude, NO_SUDO};
use crate::AppState;

/// Finds where artisan is (`$A`: the path, or its `current/`), its owner and
/// the PHP binary; `getsu` gets sudo only when asked for.
fn prelude(path: &str, php: &str, password: Option<&str>) -> String {
    format!(
        r#"export LC_ALL=C
getsu() {{ [ -n "$SUDONE" ] && return 0; SUDONE=1
{prelude}}}
P={p}
[ -d "$P" ] || {{ echo "@@err $P doesn't exist"; exit 0; }}
A="$P"
[ -f "$A/artisan" ] || {{ [ -f "$A/current/artisan" ] && A="$A/current"; }}
[ -f "$A/artisan" ] || {{ echo "@@err $P isn't a Laravel app (no artisan)"; exit 0; }}
ME=$(id -un)
OWN=$(stat -c %U "$A/storage" 2>/dev/null || stat -c %U "$A")
PHPB=$(command -v {php} 2>/dev/null || command -v php 2>/dev/null)
[ -n "$PHPB" ] || {{ echo "@@err no {php} (or php) on this server"; exit 0; }}
# Supervisor's include folder and extension: the first `files =` glob.
SUPDIR=""; SUPEXT=".conf"
for m in /etc/supervisor/supervisord.conf /etc/supervisord.conf; do
  [ -f "$m" ] || continue
  g=$(sed -n '/^\[include\]/,/^\[/s/^[[:space:]]*files[[:space:]]*=[[:space:]]*//p' "$m" 2>/dev/null | awk '{{print $1}}' | head -n1)
  [ -n "$g" ] || continue
  case "$g" in /*) ;; *) g="${{m%/*}}/$g" ;; esac
  SUPDIR="${{g%/*}}"; e="${{g##*\*}}"; case "$e" in .conf|.ini) SUPEXT="$e" ;; esac
  break
done
[ -n "$SUPDIR" ] || {{ [ -d /etc/supervisor/conf.d ] && SUPDIR=/etc/supervisor/conf.d; }}
"#,
        prelude = sudo_prelude(password),
        p = shell_quote(path.trim().trim_end_matches('/')),
        php = shell_quote(php),
    )
}

fn plan_script(path: &str, php: &str, password: Option<&str>) -> String {
    format!(
        r#"{pre}echo "@@dir $A"
echo "@@owner $OWN"
echo "@@php $PHPB"
echo "@@supdir $SUPDIR"
echo "@@supext $SUPEXT"
command -v supervisorctl >/dev/null 2>&1 && echo "@@supervisorctl"
if [ "$ME" = root ]; then echo "@@sudo root"; else getsu; if [ -n "$SU" ]; then echo "@@sudo ok"; else echo "@@sudo none"; fi; fi
"#,
        pre = prelude(path, php, password),
    )
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunnersPlan {
    /// Where artisan is (the path, or its `current/`).
    pub dir: String,
    /// Who runs them: the owner of `storage/`.
    pub owner: String,
    /// The PHP binary (`/usr/bin/php8.4`).
    pub php: String,
    pub cron_file: String,
    pub cron: String,
    /// None when Supervisor isn't there.
    pub worker_file: Option<String>,
    pub worker: String,
    pub supervisor: bool,
    /// "root", "ok" (sudo works) or "none".
    pub sudo: String,
}

/// cron.d file names: letters, digits, - and _ (no dots: cron skips them).
fn cron_file(app_id: &str) -> String {
    let id: String = app_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '-' })
        .collect();
    format!("/etc/cron.d/laravel-{id}")
}

fn program(app_id: &str) -> String {
    let id: String = app_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "_-.".contains(c) { c } else { '-' })
        .collect();
    format!("{id}-worker")
}

fn cron_conf(app_id: &str, dir: &str, owner: &str, php: &str) -> String {
    format!(
        "# Laravel scheduler for {app_id} (added by Kemudi)\nSHELL=/bin/sh\n* * * * * {owner} cd {dir} && {php} artisan schedule:run >> /dev/null 2>&1\n"
    )
}

fn worker_conf(app_id: &str, dir: &str, owner: &str, php: &str) -> String {
    format!(
        "[program:{name}]
process_name=%(program_name)s_%(process_num)02d
command={php} {dir}/artisan queue:work --sleep=3 --tries=3 --max-time=3600
directory={dir}
autostart=true
autorestart=true
stopasgroup=true
killasgroup=true
user={owner}
numprocs=1
redirect_stderr=true
stdout_logfile={dir}/storage/logs/worker.log
stopwaitsecs=3600
",
        name = program(app_id),
    )
}

fn value<'a>(out: &'a str, key: &str) -> &'a str {
    out.lines()
        .find_map(|l| l.strip_prefix(&format!("@@{key} ")))
        .unwrap_or("")
        .trim()
}

fn parse_plan(app_id: &str, out: &str) -> AppResult<RunnersPlan> {
    errors(out)?;
    let (dir, owner, php) = (value(out, "dir"), value(out, "owner"), value(out, "php"));
    if dir.is_empty() || owner.is_empty() || php.is_empty() {
        return Err(AppError::Invalid("no answer from the server".into()));
    }
    let supdir = value(out, "supdir");
    let ext = match value(out, "supext") {
        ".ini" => ".ini",
        _ => ".conf",
    };
    let supervisor = out.lines().any(|l| l == "@@supervisorctl");
    Ok(RunnersPlan {
        dir: dir.into(),
        owner: owner.into(),
        php: php.into(),
        cron_file: cron_file(app_id),
        cron: cron_conf(app_id, dir, owner, php),
        worker_file: (supervisor && !supdir.is_empty()).then(|| format!("{supdir}/{}{ext}", program(app_id))),
        worker: worker_conf(app_id, dir, owner, php),
        supervisor,
        sudo: value(out, "sudo").to_string(),
    })
}

fn app_and_php(state: &AppState, server_id: &str, app_id: &str) -> AppResult<(crate::config::schema::Server, String, String)> {
    let server = lookup(state, server_id)?;
    let app = server
        .app(app_id)
        .ok_or_else(|| AppError::NotFound(format!("app `{app_id}` isn't on {server_id}")))?;
    let php = app
        .php
        .as_deref()
        .and_then(crate::queues::php_binary)
        .unwrap_or_else(|| "php".into());
    let path = app.path.clone();
    Ok((server, path, php))
}

/// The scheduler cron line and queue worker Kemudi would add (read-only).
#[tauri::command]
pub async fn runners_plan(state: State<'_, AppState>, server_id: String, app_id: String) -> AppResult<RunnersPlan> {
    let (_, path, php) = app_and_php(&state, &server_id, &app_id)?;
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_all(&state, &server_id, &plan_script(&path, &php, password.as_deref())).await?;
    parse_plan(&app_id, &out)
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Runner {
    Cron,
    Worker,
}

/// Writes the file (not over a different one), then for a worker has
/// Supervisor read it. The file name is worked out here, never taken from
/// the UI; the content is what the dialog showed (and you may have edited).
fn add_script(path: &str, php: &str, app_id: &str, kind: Runner, content: &str, password: Option<&str>) -> String {
    let write = r#"new=$(mktemp) || { echo "@@err mktemp failed"; exit 0; }
base64 -d > "$new" <<'KEMUDI_B64'
__BODY__
KEMUDI_B64
if [ -e "$F" ]; then
  if $S cmp -s "$new" "$F"; then rm -f "$new"; echo "@@note $F is already there"; else rm -f "$new"; echo "@@err $F already exists and is different: edit it instead"; exit 0; fi
else
  $S install -m 644 "$new" "$F" || { rm -f "$new"; echo "@@err couldn't write $F"; exit 0; }
  rm -f "$new"
  echo "@@ok wrote $F"
fi
"#
    .replace("__BODY__", &base64_body(content));
    let body = match kind {
        Runner::Cron => format!(
            r#"F={file}
others=$(grep -rlsF -- "$P" /etc/crontab /etc/cron.d 2>/dev/null | grep -vx "$F" | xargs -r grep -ls schedule:run)
if [ -n "$others" ] || $S crontab -l -u "$OWN" 2>/dev/null | grep -F -- "$P" | grep -q schedule:run; then
  echo "@@err a cron line already runs its scheduler ($others): not adding another"; exit 0
fi
{write}"#,
            file = shell_quote(&cron_file(app_id)),
        ),
        Runner::Worker => format!(
            r#"[ -n "$SUPDIR" ] || {{ echo "@@err can't tell where Supervisor reads programs from"; exit 0; }}
command -v supervisorctl >/dev/null 2>&1 || {{ echo "@@err Supervisor isn't installed"; exit 0; }}
F="$SUPDIR/"{name}"$SUPEXT"
{write}o=$($S supervisorctl reread 2>&1) || {{ printf '%s\n' "$o"; echo "@@err supervisorctl reread failed (is Supervisor running?)"; exit 0; }}
o=$($S supervisorctl update 2>&1) || {{ printf '%s\n' "$o"; echo "@@err supervisorctl update failed"; exit 0; }}
[ -n "$o" ] && printf '%s\n' "$o"
sleep 2; $S supervisorctl status {group} 2>&1 | head -10
"#,
            name = shell_quote(&program(app_id)),
            group = shell_quote(&format!("{}:*", program(app_id))),
        ),
    };
    format!(
        r#"{pre}if [ "$ME" = root ]; then S=""; else getsu; S="$SU"; [ -n "$S" ] || {{ echo "@@err can't write it: {NO_SUDO}"; exit 0; }}; fi
{body}"#,
        pre = prelude(path, php, password),
    )
}

fn parse_add(out: &str) -> AppResult<String> {
    errors(out)?;
    Ok(out
        .lines()
        .filter_map(|l| {
            l.strip_prefix("@@ok ")
                .or_else(|| l.strip_prefix("@@note "))
                .map(str::to_string)
                .or_else(|| (!l.starts_with("@@") && !l.trim().is_empty()).then(|| l.trim().to_string()))
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Adds the app's scheduler cron line or its queue worker.
#[tauri::command]
pub async fn runners_add(
    state: State<'_, AppState>,
    server_id: String,
    app_id: String,
    kind: Runner,
    content: String,
) -> AppResult<String> {
    let (server, path, php) = app_and_php(&state, &server_id, &app_id)?;
    if content.trim().is_empty() || content.len() > 16 * 1024 || content.contains('\0') {
        return Err(AppError::Invalid("that file content can't be written".into()));
    }
    let content = if content.ends_with('\n') { content } else { format!("{content}\n") };
    let password = saved_sudo(&server_id).await;
    let script = add_script(&path, &php, &app_id, kind, &content, password.as_deref());
    let result = crate::monitor::run_all(&state, &server_id, &script)
        .await
        .and_then(|out| parse_add(&out));
    let label = match kind {
        Runner::Cron => format!("Scheduler added ({})", cron_file(&app_id)),
        Runner::Worker => format!("Queue worker added ({})", program(&app_id)),
    };
    if let (Ok(log), Some(app)) = (state.audit.as_ref(), server.app(&app_id)) {
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: Some(&app.id),
            action_id: "app:runners",
            label: &label,
            env: app.env.as_str(),
            kind: "edit",
            command: &label,
            edited: false,
        }) {
            let _ = log.finish(row, Some(i32::from(result.is_err())));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans() {
        let out = "@@dir /var/www/shop/current\n@@owner deploy\n@@php /usr/bin/php8.4\n@@supdir /etc/supervisor/conf.d\n@@supext .conf\n@@supervisorctl\n@@sudo ok\n";
        let p = parse_plan("shop.v2", out).unwrap();
        assert_eq!(p.cron_file, "/etc/cron.d/laravel-shop-v2");
        assert!(p.cron.contains("* * * * * deploy cd /var/www/shop/current && /usr/bin/php8.4 artisan schedule:run"));
        assert_eq!(p.worker_file.as_deref(), Some("/etc/supervisor/conf.d/shop.v2-worker.conf"));
        assert!(p.worker.contains("[program:shop.v2-worker]") && p.worker.contains("user=deploy"));
        assert!(p.worker.contains("command=/usr/bin/php8.4 /var/www/shop/current/artisan queue:work"));
        let no_sup = parse_plan("shop", "@@dir /a\n@@owner u\n@@php /usr/bin/php\n@@supdir \n@@sudo none\n").unwrap();
        assert!(no_sup.worker_file.is_none() && !no_sup.supervisor);
        assert!(parse_plan("shop", "@@err /x isn't a Laravel app (no artisan)\n").is_err());
    }

    #[test]
    fn scripts_are_valid_bash() {
        for s in [
            plan_script("/var/www/shop", "php8.4", Some("pw")),
            add_script("/var/www/shop", "php8.4", "shop", Runner::Cron, "* * * * * a b\n", None),
            add_script("/var/www/shop", "php", "shop", Runner::Worker, "[program:x]\n", Some("pw")),
        ] {
            let out = std::process::Command::new("bash").args(["-n", "-c", &s]).output().expect("bash");
            assert!(out.status.success(), "{}\n{s}", String::from_utf8_lossy(&out.stderr));
        }
    }

    #[test]
    fn answers() {
        assert_eq!(parse_add("@@ok wrote /etc/cron.d/laravel-shop\n").unwrap(), "wrote /etc/cron.d/laravel-shop");
        assert!(parse_add("@@err a cron line already runs its scheduler\n").is_err());
    }
}
