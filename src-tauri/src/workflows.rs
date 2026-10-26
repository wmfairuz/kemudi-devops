//! Workflows: a named list of steps (a command on this Mac, a command on a
//! server, an existing action, a pause, a parallel group, a watch pane) run
//! one after another in one terminal tab, so prompts (git credentials, "run
//! the migrations?") are answered right there. The first failing step stops
//! the run; the tab's exit code is 100 + that step's number, so the UI can
//! offer "run from step N".
//!
//! A parallel group: the main script marks it and waits; Kemudi opens a pane
//! per branch (each its own script and PTY, so each can ask its own
//! questions), and each branch writes its exit code into the run's private
//! temp folder, which the main script reads. A watch step: the main script
//! marks it and goes on; Kemudi opens the pane.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use crate::actions::commands::{render_action, ActionRef};
use crate::actions::invocation;
use crate::actions::render::shell_quote;
use crate::config::schema::{ActionKind, Asg, Config, Env, FleetMode, Step, StepKind, Workflow};
use crate::error::{AppError, AppResult};
use crate::pty::commands::pty_size;
use crate::pty::session::ExitHooks;
use crate::pty::{Launch, PtyEvent, PtyId};
use crate::AppState;

/// `rootsh '<command>'` on the server: as root it runs; else `sudo` (which
/// may prompt), or `sudo su -c` when only `su` is passwordless.
const ROOT_SH: &str = r#"rootsh(){ if [ "$(id -u)" = 0 ]; then sh -c "$1"; elif sudo -n true 2>/dev/null || ! sudo -n su -c true 2>/dev/null; then sudo sh -c "$1"; else sudo su -c "$1"; fi; }"#;

/// `\e]6973;…\a` markers (the terminal ignores them) tell Kemudi's Steps
/// view where each step starts, ends, fails or pauses, and when to open a
/// parallel group's or a watch's panes.
const HELPERS: &str = r#"set -o pipefail
mark(){ printf '\033]6973;%s\007' "$*"; }
hdr(){ mark "start;$1"; printf '\n\033[1;35m━━ %s/%s · %s\033[0m\n' "$1" "$N" "$2"; }
fail(){ mark "fail;$1;$2"; printf '\n\033[1;31m✗ step %s failed (exit %s); later steps did not run\033[0m\n' "$1" "$2"; exit $((100 + $1)); }
done_(){ mark "done;$1"; printf '\033[32m✓ step %s\033[0m\n' "$1"; }
"#;

/// `cd` into a folder: `~/…` stays expandable, the rest is quoted.
fn cd(dir: &str) -> String {
    let d = dir.trim();
    if d == "~" {
        "cd ~".into()
    } else if let Some(rest) = d.strip_prefix("~/") {
        format!("cd ~/{}", shell_quote(rest))
    } else {
        format!("cd {}", shell_quote(d))
    }
}

/// How each server is reached: `ssh <options> <host>` pieces, from the
/// user's ssh config (computed by the caller; tests pass plain hosts).
pub type SshFor<'a> = dyn Fn(&str, &str) -> String + 'a;

fn short(s: &str) -> String {
    let one = s.lines().next().unwrap_or("").trim();
    if one.chars().count() > 60 {
        format!("{}…", one.chars().take(60).collect::<String>())
    } else {
        one.to_string()
    }
}

/// A short title for a step.
pub fn step_title(config: &Config, kind: &StepKind) -> String {
    let server = |id: &str| config.server(id).map_or(id.to_string(), |s| s.name.clone());
    match kind {
        StepKind::Local { run, .. } => format!("this Mac · {}", short(run)),
        StepKind::Server {
            server: s,
            run,
            root,
            ..
        } => {
            format!(
                "{}{} · {}",
                server(s),
                if *root { " (root)" } else { "" },
                short(run)
            )
        }
        StepKind::Action {
            server: s,
            app,
            action,
        } => {
            let label = config
                .server(s)
                .and_then(|srv| match app {
                    Some(a) => srv
                        .app(a)
                        .and_then(|x| x.actions.iter().find(|y| &y.id == action)),
                    None => srv.actions.iter().find(|y| &y.id == action),
                })
                .map_or(action.clone(), |a| a.label.clone());
            match app
                .as_ref()
                .and_then(|a| config.server(s).and_then(|srv| srv.app(a)))
            {
                Some(a) => format!("{} · {label}", a.name),
                None => format!("{} · {label}", server(s)),
            }
        }
        StepKind::Pause { text } => format!("pause · {}", short(text)),
        StepKind::Parallel { branches } => format!("{} at once", branches.len()),
        StepKind::Watch { server: s, run, .. } => format!(
            "watch on {} · {}",
            s.as_deref().map_or("this Mac".to_string(), server),
            short(run)
        ),
    }
}

pub(crate) fn title_of(config: &Config, step: &Step) -> String {
    step.label
        .clone()
        .unwrap_or_else(|| step_title(config, &step.kind))
}

/// Watches and steps inside "at once" can't run on an Auto Scaling group
/// (a plain server or action step can: on each instance).
fn asg_step(n: &str, server: &str) -> String {
    format!("step {n}: {server} is an AWS Auto Scaling group; a watch or a step inside \"at once\" can't run on one (a plain server or action step can: it runs on each instance)")
}

/// An action as a workflow step runs it: rendered, with no values to ask.
fn rendered(config: &Config, server: &str, app: &Option<String>, action: &str, n: &str) -> Result<crate::actions::commands::RenderedAction, String> {
    let r = render_action(
        config,
        &ActionRef {
            server_id: server.to_string(),
            app_id: app.clone(),
            action_id: action.to_string(),
            values: BTreeMap::new(),
        },
        None,
    )
    .map_err(|e| format!("step {n}: {e}"))?;
    if !r.missing.is_empty() {
        return Err(format!(
            "step {n}: {} asks for values ({}), which a workflow can't give",
            r.label,
            r.missing.join(", ")
        ));
    }
    Ok(r)
}

/// A command step on an AWS Auto Scaling group: what runs on each
/// instance, and how to reach them.
struct FleetTarget {
    asg: Asg,
    name: String,
    /// The command (in its folder), run by an interactive login bash.
    inner: String,
}

/// The Auto Scaling group a server or action step runs on, if any.
fn fleet_target(config: &Config, kind: &StepKind, n: &str) -> Result<Option<FleetTarget>, String> {
    let with_dir = |dir: &Option<String>, run: &str| match dir {
        Some(d) if !d.trim().is_empty() => format!("{} && {run}", cd(d)),
        _ => run.to_string(),
    };
    let asg_of = |server: &str| config.server(server).and_then(|s| s.asg.clone().map(|a| (a, s.name.clone())));
    match kind {
        StepKind::Server { server, run, root, dir } => Ok(asg_of(server).map(|(mut asg, name)| {
            // As root: the step asks for it, or the server runs as root.
            asg.root = asg.root || *root;
            FleetTarget { asg, name, inner: with_dir(dir, run) }
        })),
        StepKind::Action { server, app, action } => {
            let Some((asg, name)) = asg_of(server) else { return Ok(None) };
            let r = rendered(config, server, app, action, n)?;
            Ok((r.kind == ActionKind::Ssh).then_some(FleetTarget { asg, name, inner: r.command }))
        }
        _ => Ok(None),
    }
}

/// `aws … describe-instances` printing the group's running instance ids,
/// oldest first.
fn fleet_lookup(asg: &Asg) -> String {
    let mut w: Vec<String> = vec!["aws".into(), "ec2".into(), "describe-instances".into(), "--filters".into()];
    if asg.instances.is_empty() {
        w.push(format!("Name=tag:aws:autoscaling:groupName,Values={}", asg.name));
    }
    w.push("Name=instance-state-name,Values=running".into());
    if !asg.instances.is_empty() {
        w.push("--instance-ids".into());
        w.extend(asg.instances.iter().cloned());
    }
    w.extend([
        "--query".into(),
        "sort_by(Reservations[].Instances[], &LaunchTime)[].InstanceId".into(),
        "--output".into(),
        "text".into(),
    ]);
    w.extend(crate::fleet::aws_opts(asg));
    w.iter().map(|x| shell_quote(x)).collect::<Vec<_>>().join(" ")
}

/// A Session Manager session to instance `$i` running the step, its output
/// also kept in `log`; then `r` = the step's exit code on that instance
/// (from a marker the instance prints, since Session Manager doesn't hand
/// it back; none: the session broke, counted as a failure).
fn fleet_session(t: &FleetTarget, log: &str) -> String {
    let script = format!(
        "bash -lic {}\nprintf '\\033]6974;%s\\007' \"$?\"",
        shell_quote(&t.inner)
    );
    let params = serde_json::json!({ "command": [crate::fleet::remote(&t.asg, Some(&script))] }).to_string();
    let mut rest: Vec<String> = crate::fleet::aws_opts(&t.asg);
    rest.extend([
        "--document-name".into(),
        "AWS-StartInteractiveCommand".into(),
        "--parameters".into(),
        params,
    ]);
    let rest = rest.iter().map(|x| shell_quote(x)).collect::<Vec<_>>().join(" ");
    format!(
        r#"rm -f {log}; aws ssm start-session --target "$i" {rest} | tee {log}
r=$(LC_ALL=C grep -ao $'\033]6974;[0-9]*' {log} | tail -n1 | sed 's/.*;//')
if [ -z "$r" ]; then printf "\n\033[31mcouldn't tell whether it worked on %s: the session ended without its exit code\033[0m\n" "$i"; r=1; fi"#
    )
}

/// The ids of the group's running instances into `ids`, or a failure.
fn fleet_ids(t: &FleetTarget) -> String {
    format!(
        r#"ids=$({lookup}); if [ $? -ne 0 ]; then printf '\033[31mcould not list the instances of %s (the AWS CLI failed; an expired SSO login? aws sso login)\033[0m\n' {name}; false
elif [ -z "$ids" ]; then printf '\033[31m%s has no running instances\033[0m\n' {name}; false
else"#,
        lookup = fleet_lookup(&t.asg),
        name = shell_quote(&t.name),
    )
}

/// One after another: each instance in turn, in the run's own terminal
/// (prompts answered there); the first failure stops it.
fn fleet_rolling(t: &FleetTarget, n: usize) -> String {
    format!(
        r#"{ids}
set -- $ids; tot=$#; k=0; r=0
for i in "$@"; do k=$((k+1)); printf '\n\033[1;36m── instance %s/%s · %s\033[0m\n' "$k" "$tot" "$i"
{session}
if [ "$r" != 0 ]; then printf '\033[31m✗ failed on %s (exit %s); the instances after it were not touched\033[0m\n' "$i" "$r"; break; fi
done
(exit "$r"); fi"#,
        ids = fleet_ids(t),
        session = fleet_session(t, &format!("\"$T/{n}-ssm\"")),
    )
}

/// All at once: Kemudi opens a pane per instance (like a parallel step);
/// each writes its exit code into the run's folder, which this waits for.
fn fleet_at_once(t: &FleetTarget, n: usize) -> String {
    format!(
        r#"{ids}
rm -f "$T"/{n}-[0-9]*; printf '%s\n' $ids > "$T/{n}-ids"; m=$(wc -l < "$T/{n}-ids" | tr -d ' ')
mark "group;{n};$m"
printf '\033[2m· on %s instances at once, each in its own pane; waiting for all of them…\033[0m\n' "$m"
while :; do c=0; for b in $(seq 1 $m); do [ -f "$T/{n}-$b" ] && c=$((c+1)); done; [ $c -ge $m ] && break; sleep 0.5; done
rc=0; b=0; for i in $(cat "$T/{n}-ids"); do b=$((b+1)); r=$(cat "$T/{n}-$b" 2>/dev/null || echo 1); if [ "$r" != 0 ]; then printf '\033[31m✗ %s failed (exit %s)\033[0m\n' "$i" "$r"; [ $rc -eq 0 ] && rc=$r; else printf '\033[32m✓ %s\033[0m\n' "$i"; fi; done
(exit $rc); fi"#,
        ids = fleet_ids(t),
    )
}

/// The shell line for a command step (this Mac, a server, an action), or a
/// watch's command. `n` names the step in errors.
fn command_line(config: &Config, kind: &StepKind, n: &str, ssh: &SshFor) -> Result<String, String> {
    let with_dir = |dir: &Option<String>, run: &str| match dir {
        Some(d) if !d.trim().is_empty() => format!("{} && {run}", cd(d)),
        _ => run.to_string(),
    };
    // Your own shell, interactive, so your aliases work.
    let local = |inner: &str| format!("\"${{SHELL:-/bin/zsh}}\" -lic {}", shell_quote(inner));
    let remote = |server: &str, inner: &str, root: bool| -> Result<String, String> {
        let srv = config
            .server(server)
            .ok_or_else(|| format!("step {n}: `{server}` isn't a server in Kemudi"))?;
        if srv.asg.is_some() {
            return Err(asg_step(n, &srv.name));
        }
        // An interactive login bash, so aliases (e.g. `deploy`) work.
        let shell = format!("bash -lic {}", shell_quote(inner));
        let cmd = if root {
            format!("{ROOT_SH}; rootsh {}", shell_quote(&shell))
        } else {
            shell
        };
        Ok(ssh(&srv.host, &cmd))
    };
    match kind {
        StepKind::Local { run, dir } => Ok(local(&with_dir(dir, run))),
        StepKind::Server {
            server,
            run,
            root,
            dir,
        } => remote(server, &with_dir(dir, run), *root),
        StepKind::Watch {
            server,
            run,
            root,
            dir,
            ..
        } => match server {
            Some(s) => remote(s, &with_dir(dir, run), *root),
            None => Ok(local(&with_dir(dir, run))),
        },
        StepKind::Action {
            server,
            app,
            action,
        } => {
            let r = rendered(config, server, app, action, n)?;
            if r.kind == ActionKind::Ssh && config.server(server).is_some_and(|s| s.asg.is_some()) {
                return Err(asg_step(n, server));
            }
            Ok(match r.kind {
                ActionKind::Ssh => ssh(&r.host, &r.command),
                ActionKind::Local => {
                    format!("\"${{SHELL:-/bin/zsh}}\" -lc {}", shell_quote(&r.command))
                }
            })
        }
        StepKind::Pause { .. } | StepKind::Parallel { .. } => {
            Err(format!("step {n} isn't a command"))
        }
    }
}

/// The whole run from step `from` (1-based) as one bash script. `token`:
/// the run's private folder (parallel branches write their exit codes
/// there).
pub fn script(
    config: &Config,
    wf: &Workflow,
    from: usize,
    ssh: &SshFor,
    token: &str,
) -> Result<String, String> {
    if wf.steps.is_empty() {
        return Err(format!("{} has no steps yet", wf.name));
    }
    if from == 0 || from > wf.steps.len() {
        return Err(format!("{} has {} steps", wf.name, wf.steps.len()));
    }
    let mut out = format!(
        "# Kemudi workflow: {}\nN={}\nT={}\n",
        wf.name,
        wf.steps.len(),
        shell_quote(token)
    );
    out.push_str(HELPERS);
    if from > 1 {
        out.push_str(&format!(
            "printf '\\033[2m· starting at step {from}; steps 1–{} skipped\\033[0m\\n'\n",
            from - 1
        ));
    }
    for (i, step) in wf.steps.iter().enumerate().skip(from - 1) {
        let n = i + 1;
        out.push_str(&format!(
            "\nhdr {n} {}\n",
            shell_quote(&title_of(config, step))
        ));
        match &step.kind {
            StepKind::Pause { text } => out.push_str(&format!(
                "mark \"pause;{n}\"; printf '%s \\033[2m[Enter: go on · Ctrl+C: stop]\\033[0m ' {}; read -r _",
                shell_quote(text)
            )),
            StepKind::Parallel { branches } => {
                // Check every branch builds before opening any pane.
                for (b, br) in branches.iter().enumerate() {
                    command_line(config, &br.kind, &format!("{n}.{}", b + 1), ssh)?;
                }
                let m = branches.len();
                out.push_str(&format!(
                    r#"rm -f "$T"/{n}-*; mark "group;{n};{m}"
printf '\033[2m· {m} steps at once, each in its own pane; waiting for all of them…\033[0m\n'
while :; do c=0; for i in $(seq 1 {m}); do [ -f "$T/{n}-$i" ] && c=$((c+1)); done; [ $c -ge {m} ] && break; sleep 0.5; done
rc=0; for i in $(seq 1 {m}); do r=$(cat "$T/{n}-$i" 2>/dev/null || echo 1); if [ "$r" != 0 ]; then printf '\033[31m✗ step {n}.%s failed (exit %s)\033[0m\n' "$i" "$r"; [ $rc -eq 0 ] && rc=$r; else printf '\033[32m✓ step {n}.%s\033[0m\n' "$i"; fi; done
[ $rc -eq 0 ]"#
                ));
            }
            StepKind::Watch { keep, .. } => {
                command_line(config, &step.kind, &n.to_string(), ssh)?;
                out.push_str(&format!(
                    "mark \"watch;{n}\"; printf '\\033[2m· watching in a side pane{}\\033[0m\\n'",
                    if *keep { "; it stays open after the run" } else { " until the run ends" }
                ));
            }
            kind => match fleet_target(config, kind, &n.to_string())? {
                Some(t) if wf.fleet == FleetMode::AllAtOnce => out.push_str(&fleet_at_once(&t, n)),
                Some(t) => out.push_str(&fleet_rolling(&t, n)),
                None => out.push_str(&command_line(config, kind, &n.to_string(), ssh)?),
            },
        }
        out.push_str(&format!(
            "\nrc=$?; [ $rc -eq 0 ] || fail {n} $rc; done_ {n}\n"
        ));
    }
    out.push_str(&format!(
        "\nmark end; printf '\\n\\033[1;32m✓ %s: all done\\033[0m\\n' {}\n",
        shell_quote(&wf.name)
    ));
    Ok(out)
}

/// Branch `branch` (1-based) of parallel step `step`: its command, then its
/// exit code into the run's folder (also when its pane is closed or
/// Ctrl+C'd, so the main run never waits forever).
pub fn branch_script(
    config: &Config,
    wf: &Workflow,
    step: usize,
    branch: usize,
    token: &str,
    ssh: &SshFor,
) -> Result<String, String> {
    let kind = wf.steps.get(step.wrapping_sub(1)).map(|s| &s.kind);
    if let Some(kind) = kind.filter(|k| !matches!(k, StepKind::Parallel { .. })) {
        if let Some(t) = fleet_target(config, kind, &step.to_string())? {
            return Ok(fleet_branch(config, wf, step, branch, token, &t));
        }
    }
    let Some(StepKind::Parallel { branches }) = kind else {
        return Err(format!("step {step} of {} isn't a parallel step", wf.name));
    };
    let br = branches
        .get(branch.wrapping_sub(1))
        .ok_or_else(|| format!("step {step} has no branch {branch}"))?;
    let n = format!("{step}.{branch}");
    let line = command_line(config, &br.kind, &n, ssh)?;
    Ok(format!(
        r#"# Kemudi workflow {name}: step {n}
N=1
f={file}
{HELPERS}trap 'echo 129 > "$f"; exit 129' HUP
trap 'echo 130 > "$f"; exit 130' INT TERM
mark "start;1"; printf '\033[1;35m━━ {n} · %s\033[0m\n' {title}
{line}
rc=$?
if [ $rc -eq 0 ]; then mark "done;1"; printf '\033[32m✓ step {n}\033[0m\n'; else mark "fail;1;$rc"; printf '\033[1;31m✗ step {n} failed (exit %s)\033[0m\n' "$rc"; fi
echo $rc > "$f"; mark end
exit $rc
"#,
        name = wf.name,
        file = shell_quote(&format!("{token}/{step}-{branch}")),
        title = shell_quote(&title_of(config, br)),
    ))
}

/// Instance `branch` (1-based, in the order the main run listed them) of an
/// all-at-once step on an Auto Scaling group: its session, then its exit
/// code into the run's folder (also when the pane is closed or Ctrl+C'd).
fn fleet_branch(config: &Config, wf: &Workflow, step: usize, branch: usize, token: &str, t: &FleetTarget) -> String {
    let title = wf.steps.get(step - 1).map(|s| title_of(config, s)).unwrap_or_default();
    format!(
        r#"# Kemudi workflow {name}: step {step}, instance {branch}
N=1
T={token}
f="$T/{step}-{branch}"
{HELPERS}trap 'echo 129 > "$f"; exit 129' HUP
trap 'echo 130 > "$f"; exit 130' INT TERM
i=$(sed -n '{branch}p' "$T/{step}-ids")
case "$i" in i-*) ;; *) echo 1 > "$f"; printf '\033[31mno instance %s for this step\033[0m\n' {branch}; exit 1;; esac
mark "start;1"; printf '\033[1;35m━━ {step}.{branch} · %s · %s\033[0m\n' {title} "$i"
{session}
if [ "$r" = 0 ]; then mark "done;1"; printf '\033[32m✓ %s\033[0m\n' "$i"; else mark "fail;1;$r"; printf '\033[1;31m✗ %s failed (exit %s)\033[0m\n' "$i" "$r"; fi
echo "$r" > "$f"; mark end
exit "$r"
"#,
        name = wf.name,
        token = shell_quote(token),
        title = shell_quote(&title),
        session = fleet_session(t, &format!("\"$T/{step}-{branch}-ssm\"")),
    )
}

/// The servers a run from `from` reaches over ssh (parallel branches and
/// watches included).
fn servers_used(config: &Config, wf: &Workflow, from: usize) -> Vec<String> {
    fn add(config: &Config, kind: &StepKind, out: &mut Vec<String>) {
        let id = match kind {
            StepKind::Server { server, .. } => Some(server),
            StepKind::Watch { server, .. } => server.as_ref(),
            StepKind::Action { server, action, .. } => {
                let ssh = crate::actions::commands::builtin(action).map_or_else(
                    || {
                        config.server(server).is_some_and(|s| {
                            s.actions
                                .iter()
                                .chain(s.apps.iter().flat_map(|a| a.actions.iter()))
                                .any(|a| &a.id == action && a.kind == ActionKind::Ssh)
                        })
                    },
                    |b| b.kind == ActionKind::Ssh,
                );
                ssh.then_some(server)
            }
            StepKind::Parallel { branches } => {
                for b in branches {
                    add(config, &b.kind, out);
                }
                None
            }
            _ => None,
        };
        if let Some(id) = id {
            if !out.contains(id) {
                out.push(id.clone());
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    for step in wf.steps.iter().skip(from.saturating_sub(1)) {
        add(config, &step.kind, &mut out);
    }
    out
}

fn find<'c>(config: &'c Config, id: &str) -> AppResult<&'c Workflow> {
    config
        .workflows
        .iter()
        .find(|w| w.id == id)
        .ok_or_else(|| AppError::NotFound(format!("there's no workflow `{id}`")))
}

fn loaded(state: &AppState) -> AppResult<Config> {
    let mut config = state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))?;
    // Server setup's workflows (made on request, not in servers.yaml).
    config.workflows.extend(crate::setup::adhoc());
    Ok(config)
}

#[cfg(test)]
pub(crate) fn script_for_test(config: &Config, wf: &Workflow) -> Result<String, String> {
    script(config, wf, 1, &|h: &str, r: &str| format!("ssh {h} {}", shell_quote(r)), "/tmp/kemudi-wf-test")
}

/// `ssh …` for a host, the way action tabs connect (its ssh config's
/// options; a `sudo …` RemoteCommand keeps meaning "as root").
fn ssh_line(env: &crate::env::LoginEnv) -> impl Fn(&str, &str) -> String + '_ {
    move |host: &str, remote: &str| {
        let hc = crate::ssh::host_config(host, env);
        let mut words = vec!["ssh".to_string()];
        words.extend(hc.connect_opts);
        words.extend(crate::ssh::ssh_args(
            host,
            Some(remote),
            hc.remote_command.as_deref(),
            false,
        ));
        words
            .iter()
            .map(|w| shell_quote(w))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// A fresh private folder for one run (`$TMPDIR/kemudi-wf-…`).
fn new_token() -> AppResult<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let dir = std::env::temp_dir().join(format!("kemudi-wf-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&dir)?;
    Ok(dir)
}

/// A token the UI hands back must be one of ours.
fn checked_token(token: &str) -> AppResult<String> {
    let p = Path::new(token);
    let ours = p.parent() == Some(std::env::temp_dir().as_path())
        && p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("kemudi-wf-"))
        && p.is_dir();
    if ours {
        Ok(token.to_string())
    } else {
        Err(AppError::Invalid("that workflow run has ended".into()))
    }
}

/// The script a run would use (for the run dialog's "Show script").
#[tauri::command]
pub async fn workflow_script(
    state: State<'_, AppState>,
    id: String,
    from: usize,
) -> AppResult<String> {
    let config = loaded(&state)?;
    let wf = find(&config, &id)?;
    let env = state.env_ready().await;
    script(&config, wf, from, &ssh_line(env), "$TMPDIR/kemudi-wf-…").map_err(AppError::Invalid)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub pty_id: PtyId,
    pub audit_id: Option<i64>,
    /// The run's private folder (for its parallel branches).
    pub token: String,
}

struct Spawn<'a> {
    body: String,
    audit_server: &'a str,
    app_id: Option<&'a str>,
    action_id: String,
    label: String,
    prod: bool,
    /// Also when it ends (the run's folder goes).
    cleanup: Option<PathBuf>,
}

/// Run a script in a local PTY (it ssh's where it needs to), with a History
/// row.
fn spawn(
    state: &AppState,
    env: &crate::env::LoginEnv,
    s: Spawn,
    size: PtySize,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> AppResult<(PtyId, Option<i64>)> {
    let audit_id = state.audit.as_ref().ok().and_then(|log| {
        log.start(&crate::audit::NewRun {
            server_id: s.audit_server,
            app_id: s.app_id,
            action_id: &s.action_id,
            label: &s.label,
            env: if s.prod { "prod" } else { "staging" },
            kind: "local",
            command: &s.body,
            edited: false,
        })
        .map_err(|e| eprintln!("kemudi: audit log write failed: {e}"))
        .ok()
    });
    let log = state.audit.as_ref().ok().cloned();
    let (a, b) = (log.clone(), log);
    let cleanup = s.cleanup.clone();
    let hooks = ExitHooks {
        on_action_exit: Some(Box::new(move |code| {
            if let (Some(id), Some(l)) = (audit_id, a.as_ref()) {
                let _ = l.finish(id, Some(code));
            }
        })),
        on_exit: Some(Box::new(move || {
            if let (Some(id), Some(l)) = (audit_id, b.as_ref()) {
                let _ = l.finish(id, None);
            }
            if let Some(dir) = &cleanup {
                let _ = std::fs::remove_dir_all(dir);
            }
        })),
    };
    let cmd = invocation::command_for(
        ActionKind::Local,
        "",
        &format!("bash -c {}", shell_quote(&s.body)),
        env,
        state.shell_integration(),
    );
    let launch = Launch::tracked(cmd).with_hooks(hooks);
    match state.ptys.spawn(launch, size, on_data, on_event) {
        Ok(p) => Ok((p, audit_id)),
        Err(e) => {
            if let (Some(id), Ok(l)) = (audit_id, state.audit.as_ref()) {
                let _ = l.finish(id, None);
            }
            if let Some(dir) = &s.cleanup {
                let _ = std::fs::remove_dir_all(dir);
            }
            Err(e)
        }
    }
}

fn audit_server(config: &Config, wf: &Workflow) -> String {
    wf.pin_server
        .clone()
        .or_else(|| servers_used(config, wf, 1).into_iter().next())
        .unwrap_or_else(|| "local".into())
}

pub(crate) fn touches_prod(config: &Config, wf: &Workflow, from: usize) -> bool {
    servers_used(config, wf, from)
        .iter()
        .any(|s| config.server(s).is_some_and(|x| x.env == Env::Prod))
}

/// Run a workflow from step `from` in a new terminal tab.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workflow_run(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    from: usize,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> AppResult<WorkflowRun> {
    let size: PtySize = pty_size(cols, rows)?;
    let config = loaded(&state)?;
    let wf = find(&config, &id)?.clone();
    for server in servers_used(&config, &wf, from) {
        crate::preflight::commands::ensure_reachable(&app, &server).await?;
    }
    let env = state.env_ready().await;
    let dir = new_token()?;
    let token = dir.to_string_lossy().to_string();
    let body = match script(&config, &wf, from, &ssh_line(env), &token) {
        Ok(b) => b,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(AppError::Invalid(e));
        }
    };
    let audit_server = audit_server(&config, &wf);
    let (pty_id, audit_id) = spawn(
        &state,
        env,
        Spawn {
            body,
            audit_server: &audit_server,
            app_id: wf.pin_app.as_deref(),
            action_id: format!("workflow:{}", wf.id),
            label: if from > 1 {
                format!("{} (from step {from})", wf.name)
            } else {
                wf.name.clone()
            },
            prod: touches_prod(&config, &wf, from),
            cleanup: Some(dir),
        },
        size,
        on_data,
        on_event,
    )?;
    Ok(WorkflowRun {
        pty_id,
        audit_id,
        token,
    })
}

/// One branch of a parallel step, in its own pane.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workflow_branch_run(
    state: State<'_, AppState>,
    id: String,
    step: usize,
    branch: usize,
    token: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> AppResult<WorkflowRun> {
    let size: PtySize = pty_size(cols, rows)?;
    let token = checked_token(&token)?;
    let config = loaded(&state)?;
    let wf = find(&config, &id)?.clone();
    let env = state.env_ready().await;
    let body = branch_script(&config, &wf, step, branch, &token, &ssh_line(env))
        .map_err(AppError::Invalid)?;
    let audit_server = audit_server(&config, &wf);
    let (pty_id, audit_id) = spawn(
        &state,
        env,
        Spawn {
            body,
            audit_server: &audit_server,
            app_id: wf.pin_app.as_deref(),
            action_id: format!("workflow:{}", wf.id),
            label: format!("{} · step {step}.{branch}", wf.name),
            prod: touches_prod(&config, &wf, 1),
            cleanup: None,
        },
        size,
        on_data,
        on_event,
    )?;
    Ok(WorkflowRun {
        pty_id,
        audit_id,
        token,
    })
}

/// A watch step's command, in its own pane.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn workflow_watch_run(
    state: State<'_, AppState>,
    id: String,
    step: usize,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> AppResult<WorkflowRun> {
    let size: PtySize = pty_size(cols, rows)?;
    let config = loaded(&state)?;
    let wf = find(&config, &id)?.clone();
    let st = wf
        .steps
        .get(step.wrapping_sub(1))
        .filter(|s| matches!(s.kind, StepKind::Watch { .. }))
        .ok_or_else(|| AppError::Invalid(format!("step {step} isn't a watch")))?;
    let env = state.env_ready().await;
    let line = command_line(&config, &st.kind, &step.to_string(), &ssh_line(env))
        .map_err(AppError::Invalid)?;
    let body = format!(
        "printf '\\033[1;35m━━ watch · %s\\033[0m\\n' {}\n{line}\n",
        shell_quote(&title_of(&config, st))
    );
    let audit_server = audit_server(&config, &wf);
    let (pty_id, audit_id) = spawn(
        &state,
        env,
        Spawn {
            body,
            audit_server: &audit_server,
            app_id: wf.pin_app.as_deref(),
            action_id: format!("workflow:{}", wf.id),
            label: format!("{} · watch (step {step})", wf.name),
            prod: touches_prod(&config, &wf, 1),
            cleanup: None,
        },
        size,
        on_data,
        on_event,
    )?;
    Ok(WorkflowRun {
        pty_id,
        audit_id,
        token: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        let out = crate::config::validate::parse(
            r#"
servers:
  - id: stg
    host: stg-host
    env: staging
    apps:
      - { id: shop, path: /var/www/shop }
  - id: prod
    host: prod-host
    env: prod
actions:
  app:
    - { id: pull, label: "Git pull", run: "cd {{ app.path }} && git pull" }
  server:
    - { id: port, run: "nc -vz {{ ip }} 22" }
workflows:
  - id: ship
    name: Ship it
    pin: { server: stg, app: shop }
    steps:
      - label: Merge & push
        local: git pull && git merge origin/main --no-edit && git push
        dir: ~/work/shop app
      - { server: prod, root: true, run: deploy /opt/www/app }
      - { pause: "Looks fine?" }
      - { action: pull, server: stg, app: shop }
  - id: broken
    steps:
      - { action: port, server: stg }
"#,
        );
        assert!(
            out.errors.is_empty() && out.warnings.is_empty(),
            "{:?} {:?}",
            out.errors,
            out.warnings
        );
        out.config.expect("config")
    }

    fn fleet_config(mode: &str) -> Config {
        let out = crate::config::validate::parse(&format!(
            r#"
servers:
  - id: web
    env: staging
    asg: {{ name: shop-web-asg, profile: acme }}
    apps:
      - {{ id: shop, path: /var/www/shop }}
workflows:
  - id: roll
    name: Roll out
    {mode}
    steps:
      - {{ server: web, dir: /var/www/shop, run: deploy }}
      - {{ local: echo next-step-ran }}
"#
        ));
        assert!(out.errors.is_empty() && out.warnings.is_empty(), "{:?} {:?}", out.errors, out.warnings);
        out.config.expect("config")
    }

    /// A fake `aws` on PATH: three instances; the session on the second
    /// reports exit 5 (or, with `nomark`, ends without its marker).
    fn fake_aws(dir: &Path, second: &str) {
        let bin = dir.join("aws");
        let body = format!(
            "#!/bin/sh\ncase \"$1\" in\n ec2) printf 'i-0aaa1111\\ti-0bbb2222\\ti-0ccc3333\\n';;\n ssm) t=$4; echo \"session on $t\"; if [ \"$t\" = i-0bbb2222 ]; then {second}; else printf '\\033]6974;0\\007'; fi;;\nesac\n"
        );
        std::fs::write(&bin, body).expect("write aws");
        std::process::Command::new("chmod").args(["+x"]).arg(&bin).status().expect("chmod");
    }

    fn run_with_fake_aws(s: &str, dir: &Path) -> (Option<i32>, String) {
        let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default());
        let out = std::process::Command::new("bash")
            .args(["-c", s])
            .env("PATH", path)
            .env("SHELL", "/bin/sh")
            .output()
            .expect("bash");
        (out.status.code(), String::from_utf8_lossy(&out.stdout).to_string())
    }

    #[test]
    fn asg_step_runs_one_instance_after_another() {
        let c = fleet_config("");
        let wf = &c.workflows[0];
        assert_eq!(wf.fleet, FleetMode::OneByOne);
        let dir = std::env::temp_dir().join(format!("kemudi-fleet-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let s = script(&c, wf, 1, &plain_ssh, &dir.to_string_lossy()).expect("script");
        assert!(s.contains("AWS-StartInteractiveCommand") && s.contains("--profile acme"), "{s}");
        assert!(s.contains("Values=shop-web-asg"), "{s}");

        // The second instance fails: the third isn't touched, the run stops.
        fake_aws(&dir, "printf '\\033]6974;5\\007'");
        let (code, text) = run_with_fake_aws(&s, &dir);
        assert_eq!(code, Some(101), "{text}");
        assert!(text.contains("step 1 failed (exit 5)"), "the instance's own code: {text}");
        assert!(text.contains("instance 2/3 · i-0bbb2222"), "{text}");
        assert!(text.contains("failed on i-0bbb2222 (exit 5)") && !text.contains("instance 3/3"), "{text}");
        assert!(!text.contains("next-step-ran"), "later steps don't run: {text}");

        // No exit code back (the session broke): counted as a failure.
        fake_aws(&dir, "true");
        let (code, text) = run_with_fake_aws(&s, &dir);
        assert_eq!(code, Some(101), "{text}");
        assert!(text.contains("couldn't tell whether it worked on i-0bbb2222"), "{text}");

        // All fine: every instance, then the next step.
        fake_aws(&dir, "printf '\\033]6974;0\\007'");
        let (code, text) = run_with_fake_aws(&s, &dir);
        assert_eq!(code, Some(0), "{text}");
        assert!(text.contains("instance 3/3 · i-0ccc3333") && text.contains("next-step-ran"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn asg_step_all_at_once_waits_for_a_pane_per_instance() {
        let c = fleet_config("fleet: all-at-once");
        let wf = &c.workflows[0];
        assert_eq!(wf.fleet, FleetMode::AllAtOnce);
        let dir = std::env::temp_dir().join(format!("kemudi-fleet-once-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let token = dir.to_string_lossy().to_string();
        let s = script(&c, wf, 1, &plain_ssh, &token).expect("script");
        assert!(s.contains("mark \"group;1;$m\""), "{s}");
        let out = std::process::Command::new("bash").args(["-n", "-c", &s]).output().expect("bash");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        // The panes: each runs its instance's session and writes its code.
        fake_aws(&dir, "printf '\\033]6974;5\\007'");
        std::fs::write(dir.join("1-ids"), "i-0aaa1111\ni-0bbb2222\ni-0ccc3333\n").expect("ids");
        for (b, want) in [(1, "0"), (2, "5")] {
            let body = branch_script(&c, wf, 1, b, &token, &plain_ssh).expect("branch");
            let (code, text) = run_with_fake_aws(&body, &dir);
            assert_eq!(code.map(|c| c.to_string()).as_deref(), Some(want), "{text}");
            assert_eq!(std::fs::read_to_string(dir.join(format!("1-{b}"))).expect("code").trim(), want);
        }
        // The main run (all three written) fails on the second.
        std::fs::write(dir.join("1-3"), "0\n").expect("third");
        let (code, text) = run_with_fake_aws(&s.replace("rm -f \"$T\"/1-[0-9]*;", ""), &dir);
        assert_eq!(code, Some(101), "{text}");
        assert!(text.contains("i-0bbb2222 failed (exit 5)") && text.contains("✓ i-0aaa1111"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn plain_ssh(host: &str, remote: &str) -> String {
        format!("ssh -t {host} {}", shell_quote(remote))
    }

    #[test]
    fn builds_a_valid_script() {
        let c = config();
        let wf = &c.workflows[0];
        let s = script(&c, wf, 1, &plain_ssh, "/tmp/t").expect("script");
        assert!(s.contains("N=4\n"));
        assert!(
            s.contains(r"-lic 'cd ~/'\''work/shop app'\'' && git pull"),
            "{s}"
        );
        assert!(s.contains("ssh -t prod-host"), "{s}");
        assert!(s.contains("rootsh"), "root step: {s}");
        assert!(
            s.contains("ssh -t stg-host 'cd /var/www/shop && git pull'"),
            "{s}"
        );
        assert!(s.contains("fail 4 $rc"));
        assert!(
            s.contains("mark \"pause;3\"") && s.contains("\nmark end;"),
            "markers: {s}"
        );
        let out = std::process::Command::new("bash")
            .args(["-n", "-c", &s])
            .output()
            .expect("bash");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        // From step 3: the first two are skipped.
        let s = script(&c, wf, 3, &plain_ssh, "/tmp/t").expect("from 3");
        assert!(!s.contains("hdr 1 ") && !s.contains("hdr 2 ") && s.contains("hdr 3 "));
        assert!(script(&c, wf, 9, &plain_ssh, "/tmp/t").is_err());
        assert_eq!(servers_used(&c, wf, 1), ["prod", "stg"]);
        assert_eq!(servers_used(&c, wf, 4), ["stg"]);
        // An action that asks for values can't be a step.
        assert!(script(&c, &c.workflows[1], 1, &plain_ssh, "/tmp/t")
            .unwrap_err()
            .contains("asks for values"));
    }

    /// `KEMUDI_WF_HOST=<ssh alias> KEMUDI_WF_OUT=<file> cargo test dump_server_step
    /// -- --ignored`: a one-step workflow running `KEMUDI_WF_CMD` as root
    /// on that host, through the real ssh line (for trying it by hand).
    #[test]
    #[ignore]
    fn dump_server_step() {
        let (Ok(host), Ok(out)) = (
            std::env::var("KEMUDI_WF_HOST"),
            std::env::var("KEMUDI_WF_OUT"),
        ) else {
            return;
        };
        let cmd = std::env::var("KEMUDI_WF_CMD").unwrap_or_else(|_| "id -un".into());
        let mut c = config();
        c.servers[1].host = host;
        let mut wf = c.workflows[0].clone();
        wf.steps = vec![crate::config::schema::Step {
            label: None,
            kind: StepKind::Server {
                server: "prod".into(),
                run: cmd,
                root: true,
                dir: None,
            },
        }];
        let env = crate::env::LoginEnv::capture();
        let s = script(&c, &wf, 1, &ssh_line(&env), "/tmp/t").expect("script");
        std::fs::write(out, s).expect("write");
    }

    /// A parallel group really runs: the main script waits for both branch
    /// scripts (run here as plain processes), then goes on; a failing branch
    /// fails the group. A watch step just marks and goes on.
    #[test]
    fn parallel_group_waits_for_its_branches() {
        let c = config();
        let local = |run: &str| crate::config::schema::Step {
            label: None,
            kind: StepKind::Local {
                run: run.into(),
                dir: None,
            },
        };
        let mut wf = c.workflows[0].clone();
        for fail in [false, true] {
            wf.steps = vec![
                crate::config::schema::Step {
                    label: Some("both".into()),
                    kind: StepKind::Parallel {
                        branches: vec![
                            local("echo a; sleep 1"),
                            local(if fail { "exit 4" } else { "echo b" }),
                        ],
                    },
                },
                crate::config::schema::Step {
                    label: None,
                    kind: StepKind::Watch {
                        server: None,
                        run: "tail -f /dev/null".into(),
                        root: false,
                        dir: None,
                        keep: false,
                    },
                },
                local("echo after"),
            ];
            let dir =
                std::env::temp_dir().join(format!("kemudi-wf-test-{}-{fail}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir(&dir).expect("dir");
            let token = dir.to_string_lossy().to_string();
            let main = script(&c, &wf, 1, &plain_ssh, &token).expect("main");
            let main = std::process::Command::new("bash")
                .args(["-c", &main])
                .env("SHELL", "/bin/sh")
                .stdout(std::process::Stdio::piped())
                .spawn()
                .expect("main");
            let branches: Vec<_> = (1..=2)
                .map(|b| {
                    let s = branch_script(&c, &wf, 1, b, &token, &plain_ssh).expect("branch");
                    std::process::Command::new("bash")
                        .args(["-c", &s])
                        .env("SHELL", "/bin/sh")
                        .output()
                        .expect("branch")
                })
                .collect();
            let out = main.wait_with_output().expect("wait");
            let text = String::from_utf8_lossy(&out.stdout);
            assert!(text.contains("\u{1b}]6973;group;1;2\u{7}"), "{text:?}");
            if fail {
                assert_eq!(out.status.code(), Some(101), "{text}");
                assert!(
                    text.contains("step 1.2 failed (exit 4)") && !text.contains("after"),
                    "{text}"
                );
                assert_eq!(branches[1].status.code(), Some(4));
            } else {
                assert_eq!(out.status.code(), Some(0), "{text}");
                assert!(
                    text.contains("\u{1b}]6973;watch;2\u{7}") && text.contains("after"),
                    "{text:?}"
                );
                assert!(String::from_utf8_lossy(&branches[0].stdout).contains('a'));
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The script runs: steps in order, the failing one stops it with
    /// exit 100 + its number. (Local steps only; `SHELL=sh`.)
    #[test]
    fn stops_at_the_failing_step() {
        let c = config();
        let mut wf = c.workflows[0].clone();
        wf.steps = vec![
            crate::config::schema::Step {
                label: None,
                kind: StepKind::Local {
                    run: "echo one".into(),
                    dir: None,
                },
            },
            crate::config::schema::Step {
                label: None,
                kind: StepKind::Local {
                    run: "exit 7".into(),
                    dir: None,
                },
            },
            crate::config::schema::Step {
                label: None,
                kind: StepKind::Local {
                    run: "echo three".into(),
                    dir: None,
                },
            },
        ];
        let s = script(&c, &wf, 1, &plain_ssh, "/tmp/t").expect("script");
        let out = std::process::Command::new("bash")
            .args(["-c", &s])
            .env("SHELL", "/bin/sh")
            .output()
            .expect("bash");
        let text = String::from_utf8_lossy(&out.stdout);
        assert_eq!(out.status.code(), Some(102), "{text}");
        assert!(text.contains("one") && !text.contains("three"), "{text}");
        assert!(text.contains("step 2 failed (exit 7)"), "{text}");
        assert!(
            text.contains("\u{1b}]6973;start;1\u{7}") && text.contains("\u{1b}]6973;fail;2;7\u{7}"),
            "{text:?}"
        );
    }
}
