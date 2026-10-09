//! Queue health for a Laravel app: its workers (Supervisor programs that
//! run it, or plain processes), pending jobs per queue, failed jobs (with
//! retry / forget / flush) and whether the scheduler runs. Laravel itself
//! is asked (a short PHP script that boots the app), so any queue and
//! failed-job driver works. Artisan always runs as the owner of the app's
//! `storage/`, never as root: files it writes stay the app's.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::actions::render::shell_quote;
use crate::error::{AppError, AppResult};
use crate::remote_files::{lookup, saved_sudo, sudo_prelude, NO_SUDO};
use crate::AppState;

/// Boots the app and prints `@@json {…}`. argv: mode (status | detail),
/// then the queue names (status) or a failed job's id (detail).
const PHP: &str = r#"<?php
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
ini_set('display_errors', 'stderr');
$mode = $argv[1] ?? 'status';
$arg = $argv[2] ?? '';
try {
    require getcwd() . '/vendor/autoload.php';
    $app = require getcwd() . '/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
} catch (Throwable $e) {
    echo "@@err Laravel didn't start: " . str_replace("\n", ' ', $e->getMessage()) . "\n";
    exit(0);
}
$cfg = $app['config'];
$first = function ($s) {
    $s = trim((string) $s);
    $l = strtok($s, "\n");
    return mb_substr($l === false ? $s : $l, 0, 500);
};
$J = JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
if ($mode === 'detail') {
    $j = $app['queue.failer']->find($arg);
    if (!$j) { echo "@@err that failed job isn't there any more\n"; exit(0); }
    $j = (array) $j;
    $p = json_decode((string) ($j['payload'] ?? ''), true);
    echo '@@json ' . json_encode([
        'exception' => mb_substr((string) ($j['exception'] ?? ''), 0, 200000),
        'payload' => $p === null ? (string) ($j['payload'] ?? '') : mb_substr(json_encode($p, JSON_PRETTY_PRINT | $J), 0, 100000),
    ], $J) . "\n";
    exit(0);
}
$out = ['queues' => [], 'failed' => [], 'failedTotal' => 0];
$default = $cfg->get('queue.default');
$conn = $cfg->get("queue.connections.$default", []);
$out['connection'] = (string) $default;
$out['driver'] = (string) ($conn['driver'] ?? '');
$queues = [];
if (($conn['driver'] ?? '') === 'database') {
    try {
        $now = time();
        $rows = $app['db']->connection($conn['connection'] ?? null)->table($conn['table'] ?? 'jobs')
            ->selectRaw('queue, count(*) as n, sum(case when reserved_at is not null then 1 else 0 end) as r, sum(case when reserved_at is null and available_at > ? then 1 else 0 end) as d', [$now])
            ->groupBy('queue')->get();
        foreach ($rows as $r) {
            $queues[$r->queue] = ['name' => (string) $r->queue, 'size' => (int) $r->n, 'reserved' => (int) $r->r, 'delayed' => (int) $r->d];
        }
    } catch (Throwable $e) { $out['queueError'] = $first($e->getMessage()); }
}
foreach (array_merge([$conn['queue'] ?? 'default'], explode(',', $arg)) as $q) {
    $q = trim((string) $q);
    if ($q === '' || isset($queues[$q])) continue;
    try { $queues[$q] = ['name' => $q, 'size' => (int) $app['queue']->connection($default)->size($q)]; }
    catch (Throwable $e) { $queues[$q] = ['name' => $q, 'size' => null]; $out['queueError'] = $out['queueError'] ?? $first($e->getMessage()); }
}
$out['queues'] = array_values($queues);
$fc = $cfg->get('queue.failed', []);
$fd = (string) ($fc['driver'] ?? 'database');
$out['failedDriver'] = $fd;
try {
    $rows = [];
    if ($fd === 'database' || $fd === 'database-uuids') {
        $t = $app['db']->connection($fc['database'] ?? null)->table($fc['table'] ?? 'failed_jobs');
        $out['failedTotal'] = (clone $t)->count();
        $rows = $t->orderByDesc('id')->limit(200)->get();
    } elseif ($fd !== 'null') {
        $rows = $app['queue.failer']->all();
        $out['failedTotal'] = count($rows);
        $rows = array_slice($rows, 0, 200);
    }
    foreach ($rows as $r) {
        $r = (array) $r;
        $p = json_decode((string) ($r['payload'] ?? ''), true);
        $out['failed'][] = [
            'id' => (string) ($r['uuid'] ?? $r['id'] ?? ''),
            'connection' => (string) ($r['connection'] ?? ''),
            'queue' => (string) ($r['queue'] ?? ''),
            'failedAt' => (string) ($r['failed_at'] ?? ''),
            'job' => (string) ($p['displayName'] ?? $p['job'] ?? '?'),
            'error' => $first($r['exception'] ?? ''),
        ];
    }
} catch (Throwable $e) { $out['failedError'] = $first($e->getMessage()); }
$out['horizon'] = class_exists('Laravel\Horizon\Horizon');
echo '@@json ' . json_encode($out, $J) . "\n";
"#;

/// Sets `SU` lazily (`getsu`), finds the app, and `RU`: how to run as the
/// owner of its storage/ (nothing when that's us; never root's files).
fn prelude(path: &str, php: &str, password: Option<&str>) -> String {
    format!(
        r#"export LC_ALL=C
getsu() {{ [ -n "$SUDONE" ] && return 0; SUDONE=1
{prelude}}}
P={p}
PHP={php}
cd "$P" 2>/dev/null || {{ echo "@@err $P doesn't exist"; exit 0; }}
[ -f artisan ] || {{ echo "@@err $P isn't a Laravel app (no artisan)"; exit 0; }}
command -v "$PHP" >/dev/null 2>&1 || PHP=php
OWN=$(stat -c %U storage 2>/dev/null || stat -c %U .)
ME=$(id -un)
RU=""
if [ "$ME" != "$OWN" ]; then
  if [ "$ME" = root ]; then
    if command -v runuser >/dev/null 2>&1; then RU="runuser -u $OWN --"; else RU="sudo -n -u $OWN"; fi
  else
    getsu
    if [ -n "$SU" ]; then RU="$SU -u $OWN"; fi
  fi
fi
"#,
        prelude = sudo_prelude(password),
        p = shell_quote(path),
        php = shell_quote(php),
    )
}

fn status_script(path: &str, php: &str, password: Option<&str>) -> String {
    format!(
        r#"{pre}if [ -n "$RU" ]; then echo "@@user $OWN"; else echo "@@user $ME"; fi
TAB=$(printf '\t')
echo @@programs
{sup}for c in $(supconfs); do
  [ -f "$c" ] || continue
  t=$(cat -- "$c" 2>/dev/null) || {{ getsu; [ -n "$SU" ] && t=$($SU cat -- "$c"); }} || continue
  case "$t" in *"$P"*) ;; *) continue ;; esac
  printf '%s\n' "$t" | awk -v f="$c" '/^\[program:/{{p=$0; sub(/^\[program:/,"",p); sub(/\].*$/,"",p)}} /^[ \t]*command[ \t]*=/{{c=$0; sub(/^[^=]*=[ \t]*/,"",c); print p "\t" f "\t" c}}'
done
echo @@status
st=$(supervisorctl status 2>/dev/null)
case "$st" in ""|*"refused"*|*"ermission"*|*"no such file"*|[Ee]rror:*) getsu; st=""; [ -n "$SU" ] && st=$($SU supervisorctl status 2>/dev/null) ;; esac
case "$st" in *"ermission"*|[Ee]rror:*|*"refused"*|*"no such file"*) st="" ;; esac
printf '%s\n' "$st"
echo @@ps
{{ ps -eo pid=,etimes=,user=,unit=,args= 2>/dev/null || ps -eo pid=,etimes=,user=,args= 2>/dev/null | sed 's/^\( *[0-9][0-9]* *[0-9][0-9]* *[^ ]*\)/\1 -/'; }} | grep -E 'queue:(work|listen)|horizon|schedule:work' | grep -F -- "$P" | grep -v -e grep -e supervisord
echo @@cron
(cat /etc/crontab /etc/cron.d/* 2>/dev/null; crontab -l 2>/dev/null; [ "$ME" = root ] && crontab -l -u "$OWN" 2>/dev/null) | grep -F -- "$P" | grep -F schedule | grep -v '^[[:space:]]*#' | head -5
QN=$(for c in $(supconfs); do grep -F -- "$P" "$c" 2>/dev/null; done | sed -n 's/.*--queue[= ]\([^ ]*\).*/\1/p' | tr '\n' ',')
echo @@php
$RU "$PHP" -- status "$QN" 2>&1 <<'KEMUDI_PHP'
{php}KEMUDI_PHP
"#,
        pre = prelude(path, php, password),
        sup = crate::app_inspect::SUPCONFS,
        php = PHP,
    )
}

fn detail_script(path: &str, php: &str, id: &str, password: Option<&str>) -> String {
    format!(
        r#"{pre}$RU "$PHP" -- detail {id} 2>&1 <<'KEMUDI_PHP'
{php}KEMUDI_PHP
"#,
        pre = prelude(path, php, password),
        id = shell_quote(id),
        php = PHP,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Act {
    /// queue:retry <ids>
    Retry,
    /// queue:retry all
    RetryAll,
    /// queue:forget <id>
    Forget,
    /// queue:flush
    Flush,
    /// queue:restart (workers finish their job, then restart)
    Restart,
    /// supervisorctl restart <program>:*
    RestartProgram,
}

fn act_script(path: &str, php: &str, act: Act, args: &[String], password: Option<&str>) -> String {
    let ids = args
        .iter()
        .map(|a| shell_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    let cmd = match act {
        Act::Retry => format!(r#"$RU "$PHP" artisan queue:retry --no-interaction -- {ids}"#),
        Act::RetryAll => r#"$RU "$PHP" artisan queue:retry --no-interaction all"#.to_string(),
        Act::Forget => format!(r#"$RU "$PHP" artisan queue:forget --no-interaction -- {ids}"#),
        Act::Flush => r#"$RU "$PHP" artisan queue:flush --no-interaction"#.to_string(),
        Act::Restart => r#"$RU "$PHP" artisan queue:restart --no-interaction"#.to_string(),
        Act::RestartProgram => format!(
            r#"if [ "$ME" = root ]; then S=""; else getsu; S="$SU"; [ -n "$S" ] || {{ echo "@@err can't restart it: {NO_SUDO}"; exit 0; }}; fi
$S supervisorctl restart {prog}"#,
            prog = shell_quote(&format!(
                "{}:*",
                args.first().map(String::as_str).unwrap_or("")
            )),
        ),
    };
    format!(
        "{pre}out=$({cmd} 2>&1); rc=$?\necho \"@@rc $rc\"\nprintf '%s\\n' \"$out\" | tail -n 40\n",
        pre = prelude(path, php, password),
    )
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueueSize {
    pub name: String,
    pub size: Option<u64>,
    pub reserved: Option<u64>,
    pub delayed: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FailedJob {
    pub id: String,
    pub connection: String,
    pub queue: String,
    pub failed_at: String,
    pub job: String,
    pub error: String,
}

/// What the app's Laravel said (absent when it didn't start).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Laravel {
    pub connection: String,
    pub driver: String,
    pub queues: Vec<QueueSize>,
    pub queue_error: Option<String>,
    pub failed_driver: String,
    pub failed_total: u64,
    pub failed: Vec<FailedJob>,
    pub failed_error: Option<String>,
    pub horizon: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    /// Supervisor program (`billing-worker`).
    pub program: String,
    /// Its process (`billing-worker:billing-worker_00`), when running.
    pub process: Option<String>,
    /// RUNNING, STARTING, BACKOFF, FATAL, EXITED, STOPPED…; "UNKNOWN" when
    /// supervisorctl couldn't say.
    pub state: String,
    pub info: String,
    pub command: String,
    pub file: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub seconds: u64,
    pub user: String,
    /// The systemd service running it (`billing-worker.service`), if any.
    pub unit: Option<String>,
    pub command: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    /// Who artisan ran as.
    pub user: String,
    pub workers: Vec<Worker>,
    /// Worker / scheduler processes for this app (Supervisor or not).
    pub processes: Vec<Process>,
    /// Cron lines running `schedule:run` for this app.
    pub scheduler: Vec<String>,
    pub laravel: Option<Laravel>,
    /// Why Laravel couldn't be asked.
    pub laravel_error: Option<String>,
}

fn section<'a>(out: &'a str, name: &str) -> Vec<&'a str> {
    let mut lines = Vec::new();
    let mut on = false;
    for l in out.lines() {
        if let Some(n) = l.strip_prefix("@@") {
            let n = n.split(' ').next().unwrap_or("");
            on = n == name;
            continue;
        }
        if on {
            lines.push(l);
        }
    }
    lines
}

/// The PHP part's answer: its JSON, or why it didn't come.
fn php_json(out: &str) -> Result<&str, String> {
    if let Some(j) = out.lines().find_map(|l| l.strip_prefix("@@json ")) {
        return Ok(j);
    }
    if let Some(e) = out.lines().find_map(|l| l.strip_prefix("@@err ")) {
        return Err(e.to_string());
    }
    let tail: Vec<&str> = out
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with("@@"))
        .collect();
    let tail = tail[tail.len().saturating_sub(3)..].join(" ");
    Err(if tail.is_empty() {
        "Laravel didn't answer".into()
    } else {
        tail
    })
}

fn parse_status(out: &str) -> AppResult<QueueStatus> {
    // Errors before the PHP part (no app, no artisan) are the whole answer.
    let head = out.split("\n@@php").next().unwrap_or(out);
    crate::remote_files::errors(head)?;
    let mut s = QueueStatus {
        user: out
            .lines()
            .find_map(|l| l.strip_prefix("@@user "))
            .unwrap_or_default()
            .trim()
            .to_string(),
        ..QueueStatus::default()
    };
    let status: Vec<(String, String, String)> = section(out, "status")
        .iter()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let name = it.next()?.to_string();
            let state = it.next()?.to_string();
            Some((name, state, it.collect::<Vec<_>>().join(" ")))
        })
        .collect();
    for l in section(out, "programs") {
        let f: Vec<&str> = l.splitn(3, '\t').collect();
        let [program, file, command] = f[..] else {
            continue;
        };
        let procs: Vec<&(String, String, String)> = status
            .iter()
            .filter(|(n, _, _)| n == program || n.starts_with(&format!("{program}:")))
            .collect();
        if procs.is_empty() {
            s.workers.push(Worker {
                program: program.to_string(),
                process: None,
                state: if status.is_empty() {
                    "UNKNOWN".into()
                } else {
                    "NOT LOADED".into()
                },
                info: if status.is_empty() {
                    "supervisorctl didn't answer".into()
                } else {
                    "not loaded: run supervisorctl update".into()
                },
                command: command.to_string(),
                file: file.to_string(),
            });
        }
        for (n, state, info) in procs {
            s.workers.push(Worker {
                program: program.to_string(),
                process: Some(n.clone()),
                state: state.clone(),
                info: info.clone(),
                command: command.to_string(),
                file: file.to_string(),
            });
        }
    }
    for l in section(out, "ps") {
        let mut it = l.split_whitespace();
        let (Some(pid), Some(secs), Some(user), Some(unit)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let Ok(pid) = pid.parse() else { continue };
        // Only services: not cron, ssh sessions or Supervisor itself.
        let unit = (unit.ends_with(".service")
            && !["cron.service", "supervisor.service", "ssh.service"].contains(&unit))
        .then(|| unit.to_string());
        s.processes.push(Process {
            pid,
            seconds: secs.parse().unwrap_or(0),
            user: user.to_string(),
            unit,
            command: it.collect::<Vec<_>>().join(" "),
        });
    }
    s.scheduler = section(out, "cron")
        .iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let php = out.split_once("\n@@php\n").map_or("", |(_, p)| p);
    match php_json(php) {
        Ok(j) => match serde_json::from_str::<Laravel>(j) {
            Ok(l) => s.laravel = Some(l),
            Err(e) => s.laravel_error = Some(format!("an odd answer from Laravel ({e})")),
        },
        Err(e) => s.laravel_error = Some(e),
    }
    Ok(s)
}

/// The app's `php:` as a command: a version (`8.4`) means `php8.4`, as in
/// actions (`php{{ app.php }}`); a name or path is used as it is.
pub(crate) fn php_binary(p: &str) -> Option<String> {
    let p = p.trim();
    if p.is_empty()
        || !p
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
    {
        return None;
    }
    Some(if p.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        format!("php{p}")
    } else {
        p.to_string()
    })
}

fn app_of(
    state: &AppState,
    server_id: &str,
    app_id: &str,
) -> AppResult<(crate::config::schema::Server, String, String)> {
    let server = lookup(state, server_id)?;
    let app = server
        .app(app_id)
        .ok_or_else(|| AppError::NotFound(format!("app `{app_id}` isn't on {server_id}")))?;
    let php = app
        .php
        .clone()
        .as_deref()
        .and_then(crate::queues::php_binary)
        .unwrap_or_else(|| "php".into());
    let path = app.path.clone();
    Ok((server, path, php))
}

/// Workers, queue sizes, failed jobs and the scheduler of an app.
#[tauri::command]
pub async fn queues_status(
    state: State<'_, AppState>,
    server_id: String,
    app_id: String,
) -> AppResult<QueueStatus> {
    let (_, path, php) = app_of(&state, &server_id, &app_id)?;
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &status_script(&path, &php, password.as_deref()),
    )
    .await?;
    parse_status(&out)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FailedDetail {
    pub exception: String,
    pub payload: String,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A failed job's whole exception and payload.
#[tauri::command]
pub async fn queues_failed_detail(
    state: State<'_, AppState>,
    server_id: String,
    app_id: String,
    id: String,
) -> AppResult<FailedDetail> {
    if !valid_id(&id) {
        return Err(AppError::Invalid("that isn't a failed job id".into()));
    }
    let (_, path, php) = app_of(&state, &server_id, &app_id)?;
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run(
        &state,
        &server_id,
        &detail_script(&path, &php, &id, password.as_deref()),
    )
    .await?;
    crate::remote_files::errors(&out)?;
    let j = php_json(&out).map_err(AppError::Invalid)?;
    serde_json::from_str(j)
        .map_err(|e| AppError::Invalid(format!("an odd answer from Laravel ({e})")))
}

/// Retry / forget / flush failed jobs, restart workers. Recorded in History.
#[tauri::command]
pub async fn queues_act(
    state: State<'_, AppState>,
    server_id: String,
    app_id: String,
    act: Act,
    args: Vec<String>,
) -> AppResult<String> {
    let ok_args = match act {
        Act::Retry | Act::Forget => {
            !args.is_empty() && args.len() <= 200 && args.iter().all(|a| valid_id(a))
        }
        Act::RestartProgram => {
            args.len() == 1
                && args[0]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                && !args[0].is_empty()
        }
        _ => args.is_empty(),
    };
    if !ok_args {
        return Err(AppError::Invalid(
            "that isn't something Kemudi does to a queue".into(),
        ));
    }
    let (server, path, php) = app_of(&state, &server_id, &app_id)?;
    let password = saved_sudo(&server_id).await;
    let (label, what) = match act {
        Act::Retry => (
            "Retry failed jobs",
            format!("artisan queue:retry {}", args.join(" ")),
        ),
        Act::RetryAll => ("Retry all failed jobs", "artisan queue:retry all".into()),
        Act::Forget => (
            "Forget failed jobs",
            format!("artisan queue:forget {}", args.join(" ")),
        ),
        Act::Flush => ("Flush failed jobs", "artisan queue:flush".into()),
        Act::Restart => ("Restart queue workers", "artisan queue:restart".into()),
        Act::RestartProgram => (
            "Restart Supervisor program",
            format!("supervisorctl restart {}:*", args[0]),
        ),
    };
    let out = crate::monitor::run(
        &state,
        &server_id,
        &act_script(&path, &php, act, &args, password.as_deref()),
    )
    .await;
    let result = out.and_then(|out| {
        crate::remote_files::errors(&out)?;
        let rc = out
            .lines()
            .find_map(|l| l.strip_prefix("@@rc "))
            .and_then(|c| c.trim().parse::<i32>().ok())
            .ok_or_else(|| AppError::Invalid("no answer".into()))?;
        let text: String = out
            .lines()
            .filter(|l| !l.starts_with("@@"))
            .map(str::trim_end)
            .filter(|l| !l.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if rc == 0 {
            Ok(text)
        } else {
            Err(AppError::Invalid(if text.is_empty() {
                format!("it failed (exit {rc})")
            } else {
                text
            }))
        }
    });
    if let Ok(log) = state.audit.as_ref() {
        let app = server.app(&app_id);
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: Some(&app_id),
            action_id: "queue",
            label,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status() {
        let out = "@@user www-data\n@@programs\n\
billing-worker\t/etc/supervisor/conf.d/m.conf\tphp /opt/m/artisan queue:work --queue=high,default\n\
billing-old\t/etc/supervisor/conf.d/m.conf\tphp /opt/m/artisan queue:work\n\
@@status\n\
billing-worker:billing-worker_00   RUNNING   pid 12, uptime 3 days, 1:02:03\n\
billing-worker:billing-worker_01   FATAL     Exited too quickly (process log may have details)\n\
other                              RUNNING   pid 13, uptime 1:00:00\n\
@@ps\n  12  9000 www-data supervisor.service php /opt/m/artisan queue:work --queue=high,default\n\
@@cron\n* * * * * cd /opt/m && php artisan schedule:run >> /dev/null 2>&1\n\
@@php\nsome warning\n@@json {\"connection\":\"redis\",\"driver\":\"redis\",\"queues\":[{\"name\":\"default\",\"size\":3}],\"failedDriver\":\"database-uuids\",\"failedTotal\":1,\"failed\":[{\"id\":\"9a1-b\",\"connection\":\"redis\",\"queue\":\"default\",\"failedAt\":\"2026-10-09 10:00:00\",\"job\":\"App\\\\Jobs\\\\Send\",\"error\":\"Exception: boom\"}],\"horizon\":false}\n";
        let s = parse_status(out).unwrap();
        assert_eq!(s.user, "www-data");
        assert_eq!(s.workers.len(), 3);
        assert_eq!(s.workers[1].state, "FATAL");
        assert_eq!(s.workers[2].state, "NOT LOADED");
        assert_eq!(s.processes[0].pid, 12);
        assert_eq!(s.processes[0].unit, None);
        assert_eq!(s.scheduler.len(), 1);
        let l = s.laravel.unwrap();
        assert_eq!(l.failed[0].job, "App\\Jobs\\Send");
        assert_eq!(l.queues[0].size, Some(3));

        let s = parse_status(
            "@@user root\n@@programs\n@@status\n@@ps\n@@cron\n@@php\nPHP Fatal error: x\n",
        )
        .unwrap();
        assert_eq!(s.laravel_error.as_deref(), Some("PHP Fatal error: x"));
        assert!(parse_status("@@err /x doesn't exist\n").is_err());
    }

    #[test]
    fn php_binaries() {
        assert_eq!(php_binary("8.4").as_deref(), Some("php8.4"));
        assert_eq!(php_binary("php8.3").as_deref(), Some("php8.3"));
        assert_eq!(php_binary("/usr/bin/php").as_deref(), Some("/usr/bin/php"));
        assert_eq!(php_binary("8.4; rm"), None);
    }

    #[test]
    fn ids() {
        assert!(valid_id("9a1b-22"));
        assert!(valid_id("42"));
        assert!(!valid_id("all; rm"));
        assert!(!valid_id(""));
    }

    /// KEMUDI_QUEUES_OUT=/tmp/x cargo test dump_queues -- --ignored
    #[test]
    #[ignore]
    fn dump_queues_scripts() {
        if let Ok(out) = std::env::var("KEMUDI_QUEUES_OUT") {
            let pw = std::env::var("KEMUDI_RF_PW").ok();
            std::fs::write(&out, status_script("/opt/www/app", "php", pw.as_deref()))
                .expect("write");
            std::fs::write(
                format!("{out}.detail"),
                detail_script("/opt/www/app", "php", "1", pw.as_deref()),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.retry"),
                act_script(
                    "/opt/www/app",
                    "php",
                    Act::Retry,
                    &["1".into()],
                    pw.as_deref(),
                ),
            )
            .expect("write");
            std::fs::write(
                format!("{out}.restartprog"),
                act_script(
                    "/opt/www/app",
                    "php",
                    Act::RestartProgram,
                    &["app-worker".into()],
                    pw.as_deref(),
                ),
            )
            .expect("write");
        }
    }
}
