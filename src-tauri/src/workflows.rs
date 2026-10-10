//! Workflows: a named list of steps (a command on this Mac, a command on a
//! server, an existing action, a pause) run one after another in one
//! terminal tab, so prompts (git credentials, "run the migrations?") are
//! answered right there. The first failing step stops the run; the tab's
//! exit code is 100 + that step's number, so the UI can offer "run from
//! step N".

use std::collections::BTreeMap;

use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use crate::actions::commands::{render_action, ActionRef};
use crate::actions::invocation;
use crate::actions::render::shell_quote;
use crate::config::schema::{ActionKind, Config, Env, StepKind, Workflow};
use crate::error::{AppError, AppResult};
use crate::pty::commands::pty_size;
use crate::pty::session::ExitHooks;
use crate::pty::{Launch, PtyEvent, PtyId};
use crate::AppState;

/// `rootsh '<command>'` on the server: as root it runs; else `sudo` (which
/// may prompt), or `sudo su -c` when only `su` is passwordless.
const ROOT_SH: &str = r#"rootsh(){ if [ "$(id -u)" = 0 ]; then sh -c "$1"; elif sudo -n true 2>/dev/null || ! sudo -n su -c true 2>/dev/null; then sudo sh -c "$1"; else sudo su -c "$1"; fi; }"#;

const HELPERS: &str = r#"set -o pipefail
hdr(){ printf '\n\033[1;35m━━ %s/%s · %s\033[0m\n' "$1" "$N" "$2"; }
fail(){ printf '\n\033[1;31m✗ step %s failed (exit %s); later steps did not run\033[0m\n' "$1" "$2"; exit $((100 + $1)); }
done_(){ printf '\033[32m✓ step %s\033[0m\n' "$1"; }
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

/// A short title for a step.
pub fn step_title(config: &Config, kind: &StepKind) -> String {
    let server = |id: &str| config.server(id).map_or(id.to_string(), |s| s.name.clone());
    let short = |s: &str| {
        let one = s.lines().next().unwrap_or("").trim();
        if one.chars().count() > 60 {
            format!("{}…", one.chars().take(60).collect::<String>())
        } else {
            one.to_string()
        }
    };
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
    }
}

/// The whole run from step `from` (1-based) as one bash script.
pub fn script(config: &Config, wf: &Workflow, from: usize, ssh: &SshFor) -> Result<String, String> {
    if wf.steps.is_empty() {
        return Err(format!("{} has no steps yet", wf.name));
    }
    if from == 0 || from > wf.steps.len() {
        return Err(format!("{} has {} steps", wf.name, wf.steps.len()));
    }
    let mut out = format!("# Kemudi workflow: {}\nN={}\n", wf.name, wf.steps.len());
    out.push_str(HELPERS);
    if from > 1 {
        out.push_str(&format!(
            "printf '\\033[2m· starting at step {from}; steps 1–{} skipped\\033[0m\\n'\n",
            from - 1
        ));
    }
    for (i, step) in wf.steps.iter().enumerate().skip(from - 1) {
        let n = i + 1;
        let title = step
            .label
            .clone()
            .unwrap_or_else(|| step_title(config, &step.kind));
        out.push_str(&format!("\nhdr {n} {}\n", shell_quote(&title)));
        let body = match &step.kind {
            StepKind::Local { run, dir } => {
                let inner = match dir {
                    Some(d) if !d.trim().is_empty() => format!("{} && {run}", cd(d)),
                    _ => run.clone(),
                };
                // Your own shell, interactive, so your aliases work.
                format!("\"${{SHELL:-/bin/zsh}}\" -lic {}", shell_quote(&inner))
            }
            StepKind::Server {
                server,
                run,
                root,
                dir,
            } => {
                let srv = config
                    .server(server)
                    .ok_or_else(|| format!("step {n}: `{server}` isn't a server in Kemudi"))?;
                let inner = match dir {
                    Some(d) if !d.trim().is_empty() => format!("{} && {run}", cd(d)),
                    _ => run.clone(),
                };
                // An interactive login bash, so aliases (e.g. `deploy`) work.
                let shell = format!("bash -lic {}", shell_quote(&inner));
                let remote = if *root {
                    format!("{ROOT_SH}; rootsh {}", shell_quote(&shell))
                } else {
                    shell
                };
                ssh(&srv.host, &remote)
            }
            StepKind::Action {
                server,
                app,
                action,
            } => {
                let r = render_action(
                    config,
                    &ActionRef {
                        server_id: server.clone(),
                        app_id: app.clone(),
                        action_id: action.clone(),
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
                match r.kind {
                    ActionKind::Ssh => ssh(&r.host, &r.command),
                    ActionKind::Local => {
                        format!("\"${{SHELL:-/bin/zsh}}\" -lc {}", shell_quote(&r.command))
                    }
                }
            }
            StepKind::Pause { text } => format!(
                "printf '%s \\033[2m[Enter: go on · Ctrl+C: stop]\\033[0m ' {}; read -r _",
                shell_quote(text)
            ),
        };
        out.push_str(&body);
        out.push_str(&format!(
            "\nrc=$?; [ $rc -eq 0 ] || fail {n} $rc; done_ {n}\n"
        ));
    }
    out.push_str(&format!(
        "\nprintf '\\n\\033[1;32m✓ %s: all done\\033[0m\\n' {}\n",
        shell_quote(&wf.name)
    ));
    Ok(out)
}

/// The servers a run from `from` reaches over ssh.
fn servers_used(config: &Config, wf: &Workflow, from: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for step in wf.steps.iter().skip(from.saturating_sub(1)) {
        let id = match &step.kind {
            StepKind::Server { server, .. } => Some(server),
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
            _ => None,
        };
        if let Some(id) = id {
            if !out.contains(id) {
                out.push(id.clone());
            }
        }
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
    state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))
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
    script(&config, wf, from, &ssh_line(env)).map_err(AppError::Invalid)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub pty_id: PtyId,
    pub audit_id: Option<i64>,
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
    let body = script(&config, &wf, from, &ssh_line(env)).map_err(AppError::Invalid)?;
    // History: under the pinned (else first) server it touches.
    let audit_server = wf
        .pin_server
        .clone()
        .or_else(|| servers_used(&config, &wf, 1).into_iter().next())
        .unwrap_or_else(|| "local".into());
    let prod = servers_used(&config, &wf, from)
        .iter()
        .any(|s| config.server(s).is_some_and(|x| x.env == Env::Prod));
    let label = if from > 1 {
        format!("{} (from step {from})", wf.name)
    } else {
        wf.name.clone()
    };
    let action_id = format!("workflow:{}", wf.id);
    let audit_id = state.audit.as_ref().ok().and_then(|log| {
        log.start(&crate::audit::NewRun {
            server_id: &audit_server,
            app_id: wf.pin_app.as_deref(),
            action_id: &action_id,
            label: &label,
            env: if prod { "prod" } else { "staging" },
            kind: "local",
            command: &body,
            edited: false,
        })
        .map_err(|e| eprintln!("kemudi: audit log write failed: {e}"))
        .ok()
    });
    let hooks = match (audit_id, state.audit.as_ref()) {
        (Some(aid), Ok(log)) => {
            let (a, b) = (log.clone(), log.clone());
            ExitHooks {
                on_action_exit: Some(Box::new(move |code| {
                    let _ = a.finish(aid, Some(code));
                })),
                on_exit: Some(Box::new(move || {
                    let _ = b.finish(aid, None);
                })),
            }
        }
        _ => ExitHooks::default(),
    };
    let cmd = invocation::command_for(
        ActionKind::Local,
        "",
        &format!("bash -c {}", shell_quote(&body)),
        env,
        state.shell_integration(),
    );
    let launch = Launch::tracked(cmd).with_hooks(hooks);
    let pty_id = match state.ptys.spawn(launch, size, on_data, on_event) {
        Ok(p) => p,
        Err(e) => {
            if let (Some(aid), Ok(log)) = (audit_id, state.audit.as_ref()) {
                let _ = log.finish(aid, None);
            }
            return Err(e);
        }
    };
    Ok(WorkflowRun { pty_id, audit_id })
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

    fn plain_ssh(host: &str, remote: &str) -> String {
        format!("ssh -t {host} {}", shell_quote(remote))
    }

    #[test]
    fn builds_a_valid_script() {
        let c = config();
        let wf = &c.workflows[0];
        let s = script(&c, wf, 1, &plain_ssh).expect("script");
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
        let s = script(&c, wf, 3, &plain_ssh).expect("from 3");
        assert!(!s.contains("hdr 1 ") && !s.contains("hdr 2 ") && s.contains("hdr 3 "));
        assert!(script(&c, wf, 9, &plain_ssh).is_err());
        assert_eq!(servers_used(&c, wf, 1), ["prod", "stg"]);
        assert_eq!(servers_used(&c, wf, 4), ["stg"]);
        // An action that asks for values can't be a step.
        assert!(script(&c, &c.workflows[1], 1, &plain_ssh)
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
        let s = script(&c, &wf, 1, &ssh_line(&env)).expect("script");
        std::fs::write(out, s).expect("write");
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
        let s = script(&c, &wf, 1, &plain_ssh).expect("script");
        let out = std::process::Command::new("bash")
            .args(["-c", &s])
            .env("SHELL", "/bin/sh")
            .output()
            .expect("bash");
        let text = String::from_utf8_lossy(&out.stdout);
        assert_eq!(out.status.code(), Some(102), "{text}");
        assert!(text.contains("one") && !text.contains("three"), "{text}");
        assert!(text.contains("step 2 failed (exit 7)"), "{text}");
    }
}
