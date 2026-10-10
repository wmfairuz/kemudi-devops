use std::collections::BTreeMap;

use portable_pty::PtySize;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use super::{invocation, render};
use crate::audit::NewRun;
use crate::config::schema::{Action, ActionKind, App, Config, Confirm, Env, Server, Vpn};
use crate::error::{AppError, AppResult};
use crate::pty::commands::pty_size;
use crate::pty::session::ExitHooks;
use crate::pty::{Launch, PtyEvent, PtyId};
use crate::AppState;

/// Which action, where.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRef {
    pub server_id: String,
    pub app_id: Option<String>,
    pub action_id: String,
    /// Values for the template's own variables (`{{ ip }}`), asked for at
    /// run time.
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

/// Everything the preview/confirm dialogs and the tab need to know.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedAction {
    pub server_id: String,
    pub app_id: Option<String>,
    pub action_id: String,
    pub label: String,
    /// Tab title, e.g. `akaun · pull` (an app's), `stg-svr03 · nginx`.
    pub title: String,
    /// The command that will run (rendered, or the user's edit).
    pub command: String,
    /// The command as rendered from servers.yaml, before any edit.
    pub rendered: String,
    pub kind: ActionKind,
    pub danger: bool,
    /// What to ask before running: explicit `confirm:` or the default.
    pub confirm: Confirm,
    /// True when `confirm:` is set in servers.yaml for this action.
    pub confirm_explicit: bool,
    pub env: Env,
    pub host: String,
    pub vpn: Vpn,
    /// The app's directory, for display.
    pub cwd: Option<String>,
    /// The template's own variables, asked for before running.
    pub params: Vec<render::Param>,
    /// Required params with no value yet (they render as `<name>`).
    pub missing: Vec<String>,
    /// The values it was rendered with.
    pub values: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub pty_id: PtyId,
    pub action: RenderedAction,
    pub edited: bool,
    pub audit_id: Option<i64>,
}

/// A root command for a terminal tab: as root it just runs; else `sudo`
/// (which may prompt), or `sudo su -c` when sudoers lets this user run only
/// `su` without a password. `cmd` is plain words (no quoting needed).
pub fn as_root(cmd: &str) -> String {
    format!("{ROOT_FN}; asroot {cmd}")
}

/// `asroot cmd args…` (see `as_root`), for commands that use it twice.
const ROOT_FN: &str = r#"asroot(){ if [ "$(id -u)" = 0 ]; then "$@"; elif sudo -n true 2>/dev/null || ! sudo -n su -c true 2>/dev/null; then sudo "$@"; else sudo su -c "$*"; fi; }"#;

/// systemd unit / Supervisor program names: safe as plain words.
fn plain_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "@._-".contains(c))
}

/// Built-in actions offered outside servers.yaml (from Inspect), e.g.
/// `supervisor-restart:<program>`. Treated as danger: prod asks for the
/// server name, like any danger action.
pub fn builtin(id: &str) -> Option<Action> {
    if let Some(cmd) = id.strip_prefix("laravel:") {
        // After a .env edit: a cached config ignores .env until re-cached.
        let (label, artisan) = match cmd {
            "config-cache" => ("Re-cache config", "config:cache"),
            "config-clear" => ("Clear config cache", "config:clear"),
            _ => return None,
        };
        return Some(Action {
            id: id.to_string(),
            label: label.to_string(),
            run: format!(
                "cd {{{{ app.path }}}} && php{{{{ app.php | default('') }}}} artisan {artisan}"
            ),
            shared: false,
            inherited: false,
            team: None,
            danger: false,
            confirm: None,
            kind: ActionKind::Ssh,
            line: None,
        });
    }
    if let Some(rest) = id.strip_prefix("web-") {
        // web-reload:nginx, web-restart:apache … always test the config first.
        let (verb, server) = rest.split_once(':')?;
        let (test, unit, name) = match server {
            "nginx" => ("asroot nginx -t", "nginx", "nginx"),
            "apache" => ("asroot apachectl configtest", "apache2", "Apache"),
            _ => return None,
        };
        let systemctl = match verb {
            "reload" | "restart" => verb,
            _ => return None,
        };
        let run = if server == "apache" {
            format!("{ROOT_FN}; {test} && {{ asroot systemctl {systemctl} {unit} 2>/dev/null || asroot systemctl {systemctl} httpd; }}")
        } else {
            format!("{ROOT_FN}; {test} && asroot systemctl {systemctl} {unit}")
        };
        let label = if verb == "reload" {
            format!("Test & reload {name}")
        } else {
            format!("Restart {name}")
        };
        return Some(Action {
            id: id.to_string(),
            label,
            run,
            shared: false,
            inherited: false,
            team: None,
            danger: true,
            confirm: None,
            kind: ActionKind::Ssh,
            line: None,
        });
    }
    if let Some(list) = id.strip_prefix("certbot:") {
        // After a new vhost: get a Let's Encrypt certificate and let certbot
        // add HTTPS to it. Interactive (it may ask), so it runs in a tab.
        let domains: Vec<&str> = list.split(',').collect();
        let ok = !domains.is_empty()
            && domains.len() <= 20
            && domains.iter().all(|d| {
                d.contains('.')
                    && d.len() <= 253
                    && !d.starts_with(['-', '.'])
                    && d.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
            });
        if !ok {
            return None;
        }
        let args: Vec<String> = domains.iter().map(|d| format!("-d {d}")).collect();
        return Some(Action {
            id: id.to_string(),
            label: format!("Get HTTPS certificate for {}", domains[0]),
            run: as_root(&format!("certbot --nginx {}", args.join(" "))),
            shared: false,
            inherited: false,
            team: None,
            danger: true,
            confirm: None,
            kind: ActionKind::Ssh,
            line: None,
        });
    }
    if let Some(key) = id.strip_prefix("ssh-copy-id:") {
        // Put one of my public keys (~/.ssh/<key>.pub) on the server, so ssh
        // stops asking for a password. Runs here, in a tab: ssh-copy-id asks
        // for the server's password once (the Fill chip helps).
        let ok = !key.is_empty()
            && key.len() <= 100
            && !key.starts_with('.')
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
        if !ok {
            return None;
        }
        return Some(Action {
            id: id.to_string(),
            label: format!("Install SSH key {key}"),
            run: format!(
                "ssh-copy-id -o RemoteCommand=none -i ~/.ssh/{key}.pub {{{{ server.host }}}}"
            ),
            shared: false,
            inherited: false,
            team: None,
            danger: false,
            confirm: None,
            kind: ActionKind::Local,
            line: None,
        });
    }
    if id == "ssh-keygen" {
        // A new key for ssh-copy-id when there's none yet; ssh-keygen asks
        // for a passphrase (and before replacing an existing file).
        return Some(Action {
            id: id.to_string(),
            label: "Create an SSH key".into(),
            run: "ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C \"$(whoami)@$(hostname -s)\""
                .into(),
            shared: false,
            inherited: false,
            team: None,
            danger: false,
            confirm: Some(crate::config::schema::Confirm::None),
            kind: ActionKind::Local,
            line: None,
        });
    }
    if id == "supervisor-update" {
        // After editing a program config: start new / changed programs,
        // stop removed ones. Unchanged programs keep running.
        return Some(Action {
            id: id.to_string(),
            label: "Apply Supervisor changes".into(),
            run: as_root("supervisorctl update"),
            shared: false,
            inherited: false,
            team: None,
            danger: true,
            confirm: None,
            kind: ActionKind::Ssh,
            line: None,
        });
    }
    // `service:<verb>:<unit>`: a systemd service (Health ▸ Services).
    if let Some(rest) = id.strip_prefix("service:") {
        let (verb, unit) = rest.split_once(':')?;
        if !plain_name(unit) || !["status", "start", "stop", "restart", "reload"].contains(&verb) {
            return None;
        }
        return Some(Action {
            id: id.to_string(),
            label: format!("{} {unit}", capital(verb)),
            run: if verb == "status" {
                format!("systemctl status {unit} --no-pager -l -n 30")
            } else {
                as_root(&format!("systemctl {verb} {unit}"))
            },
            shared: false,
            inherited: false,
            team: None,
            danger: matches!(verb, "stop" | "restart"),
            confirm: None,
            kind: ActionKind::Ssh,
            line: None,
        });
    }
    // `supervisor:<verb>:<program>` (and the older `supervisor-restart:<program>`).
    let (verb, program) = match id.strip_prefix("supervisor-restart:") {
        Some(p) => ("restart", p),
        None => id.strip_prefix("supervisor:")?.split_once(':')?,
    };
    if !plain_name(program) || !["status", "start", "stop", "restart"].contains(&verb) {
        return None;
    }
    Some(Action {
        id: id.to_string(),
        label: format!("{} {program}", capital(verb)),
        run: as_root(&format!("supervisorctl {verb} '{program}:*'")),
        shared: false,
        inherited: false,
        team: None,
        danger: matches!(verb, "stop" | "restart"),
        confirm: None,
        kind: ActionKind::Ssh,
        line: None,
    })
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
        .unwrap_or_default()
}

fn lookup<'c>(
    config: &'c Config,
    r: &ActionRef,
) -> AppResult<(&'c Server, Option<&'c App>, &'c Action)> {
    let server = config
        .server(&r.server_id)
        .ok_or_else(|| AppError::NotFound(format!("server `{}` isn't in Kemudi", r.server_id)))?;
    let app =
        match &r.app_id {
            Some(id) => Some(server.app(id).ok_or_else(|| {
                AppError::NotFound(format!("app `{id}` is not on {}", server.id))
            })?),
            None => None,
        };
    let actions = app.map_or(&server.actions, |a| &a.actions);
    let action = actions
        .iter()
        .find(|a| a.id == r.action_id)
        .ok_or_else(|| {
            AppError::NotFound(format!("action `{}` is not available here", r.action_id))
        })?;
    Ok((server, app, action))
}

pub fn render_action(
    config: &Config,
    r: &ActionRef,
    command_override: Option<String>,
) -> AppResult<RenderedAction> {
    let built = builtin(&r.action_id);
    let (server, app, action) = match &built {
        Some(b) => {
            let server = config.server(&r.server_id).ok_or_else(|| {
                AppError::NotFound(format!("server `{}` isn't in Kemudi", r.server_id))
            })?;
            let app = match &r.app_id {
                Some(id) => Some(server.app(id).ok_or_else(|| {
                    AppError::NotFound(format!("app `{id}` is not on {}", server.id))
                })?),
                None => None,
            };
            (server, app, b)
        }
        None => lookup(config, r)?,
    };
    // An app's actions go by the app's environment (a staging app on a
    // production server); server actions by the server's.
    // Built-ins other than laravel:… act on the whole server (nginx,
    // Supervisor, certbot, ssh keys) even when started from an app's page.
    let server_wide = built
        .as_ref()
        .is_some_and(|b| !b.id.starts_with("laravel:"));
    let env = if server_wide {
        server.env
    } else {
        app.map_or(server.env, |a| a.env)
    };
    let (rendered, missing) = render::render_with(&action.run, server, app, &r.values)
        .map_err(|e| AppError::Invalid(format!("{}: {e}", action.label)))?;
    let command = command_override
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| rendered.clone());
    Ok(RenderedAction {
        server_id: server.id.clone(),
        app_id: app.map(|a| a.id.clone()),
        action_id: action.id.clone(),
        label: action.label.clone(),
        // Named after what it acts on: the app (like Logs and Queues tabs),
        // or the server for server actions and server-wide built-ins.
        title: {
            let who = match app {
                Some(a) if !server_wide => &a.id,
                _ => &server.id,
            };
            if built.is_some() {
                format!("{who} · {}", action.label.to_lowercase())
            } else {
                format!("{who} · {}", action.id)
            }
        },
        command,
        rendered,
        kind: action.kind,
        danger: action.danger,
        confirm: action
            .confirm
            .unwrap_or(Confirm::default_for(env, action.danger)),
        confirm_explicit: action.confirm.is_some(),
        env,
        host: server.host.clone(),
        vpn: server.vpn,
        cwd: app.map(|a| a.path.clone()),
        params: render::params(&action.run),
        missing,
        values: r.values.clone(),
    })
}

/// A command with `<name>` placeholders must not run (in a shell `<ip`
/// reads a file).
fn ready(r: RenderedAction) -> AppResult<RenderedAction> {
    if !r.missing.is_empty() && r.command == r.rendered {
        return Err(AppError::Invalid(format!(
            "{} needs a value for {}",
            r.label,
            r.missing.join(", ")
        )));
    }
    Ok(r)
}

fn current_config(state: &AppState) -> AppResult<Config> {
    state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))
}

#[tauri::command]
pub async fn action_render(
    state: State<'_, AppState>,
    action: ActionRef,
) -> AppResult<RenderedAction> {
    render_action(&current_config(&state)?, &action, None)
}

/// Run an action in a new PTY (the caller shows it as a new tab).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn action_run(
    app: AppHandle,
    state: State<'_, AppState>,
    action: ActionRef,
    command_override: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> AppResult<RunInfo> {
    let size: PtySize = pty_size(cols, rows)?;
    let rendered = ready(render_action(
        &current_config(&state)?,
        &action,
        command_override,
    )?)?;
    let edited = rendered.command != rendered.rendered;
    // The VPN gate is enforced here, not just in the UI.
    if rendered.kind == ActionKind::Ssh {
        crate::preflight::commands::ensure_reachable(&app, &rendered.server_id).await?;
    }
    let audit_id = record(
        &state,
        &rendered,
        if rendered.kind == ActionKind::Local {
            "local"
        } else {
            "ssh"
        },
        edited,
    );
    let hooks = match (audit_id, state.audit.as_ref()) {
        (Some(id), Ok(log)) => {
            let (a, b) = (log.clone(), log.clone());
            ExitHooks {
                on_action_exit: Some(Box::new(move |code| {
                    let _ = a.finish(id, Some(code));
                })),
                on_exit: Some(Box::new(move || {
                    let _ = b.finish(id, None);
                })),
            }
        }
        _ => ExitHooks::default(),
    };
    let env = state.env_ready().await;
    let cmd = invocation::command_for(
        rendered.kind,
        &rendered.host,
        &rendered.command,
        env,
        state.shell_integration(),
    );
    let launch = Launch::tracked(cmd).with_hooks(hooks);
    let launch = if rendered.kind == ActionKind::Ssh {
        launch.on_host(rendered.host.clone())
    } else {
        launch
    };
    let pty_id = match state.ptys.spawn(launch, size, on_data, on_event) {
        Ok(id) => id,
        Err(e) => {
            if let (Some(id), Ok(log)) = (audit_id, state.audit.as_ref()) {
                let _ = log.finish(id, None);
            }
            return Err(e);
        }
    };
    Ok(RunInfo {
        pty_id,
        action: rendered,
        edited,
        audit_id,
    })
}

/// Write an audit row; failures never block the action.
fn record(state: &AppState, a: &RenderedAction, kind: &str, edited: bool) -> Option<i64> {
    let log = state.audit.as_ref().ok()?;
    log.start(&NewRun {
        server_id: &a.server_id,
        app_id: a.app_id.as_deref(),
        action_id: &a.action_id,
        label: &a.label,
        env: a.env.as_str(),
        kind,
        command: &a.command,
        edited,
    })
    .map_err(|e| eprintln!("kemudi: audit log write failed: {e}"))
    .ok()
}

/// Type the rendered command into an existing tab and press Enter.
#[tauri::command]
pub async fn action_send(
    state: State<'_, AppState>,
    pty_id: PtyId,
    action: ActionRef,
    command_override: Option<String>,
) -> AppResult<RenderedAction> {
    let rendered = ready(render_action(
        &current_config(&state)?,
        &action,
        command_override,
    )?)?;
    state
        .ptys
        .write(pty_id, format!("{}\r", rendered.command).into_bytes())?;
    // Typed into a live shell: the exit code isn't detectable.
    let edited = rendered.command != rendered.rendered;
    if let (Some(id), Ok(log)) = (
        record(&state, &rendered, "send", edited),
        state.audit.as_ref(),
    ) {
        let _ = log.finish(id, None);
    }
    Ok(rendered)
}

#[cfg(test)]
mod tests {
    #[test]
    fn builtin_supervisor_restart() {
        let a = super::builtin("supervisor-restart:core-worker").expect("builtin");
        assert_eq!(a.run, as_root("supervisorctl restart 'core-worker:*'"));
        assert!(a.danger);
        assert!(super::builtin("supervisor-restart:x; rm -rf /").is_none());
        assert!(super::builtin("supervisor-restart:").is_none());
        assert!(super::builtin("deploy").is_none());
        let r = super::builtin("web-reload:nginx").expect("nginx");
        assert_eq!(
            r.run,
            format!("{ROOT_FN}; asroot nginx -t && asroot systemctl reload nginx")
        );
        assert_eq!(r.label, "Test & reload nginx");
        assert!(super::builtin("web-restart:apache")
            .expect("apache")
            .run
            .contains("; asroot apachectl configtest && "));
        assert!(super::builtin("web-reload:caddy").is_none());
        assert!(super::builtin("web-stop:nginx").is_none());
        let c = super::builtin("laravel:config-cache").expect("config-cache");
        assert_eq!(
            c.run,
            "cd {{ app.path }} && php{{ app.php | default('') }} artisan config:cache"
        );
        assert!(super::builtin("laravel:migrate").is_none());
        assert!(super::builtin("supervisor-update").expect("update").danger);
        assert_eq!(
            super::builtin("certbot:shop.example.com,www.shop.example.com")
                .expect("certbot")
                .run,
            as_root("certbot --nginx -d shop.example.com -d www.shop.example.com")
        );
        let s = super::builtin("service:restart:php8.4-fpm").expect("service");
        assert!(s.danger && s.run.ends_with("asroot systemctl restart php8.4-fpm"));
        assert!(
            !super::builtin("service:status:nginx")
                .expect("status")
                .danger
        );
        assert!(super::builtin("service:restart:x;rm").is_none());
        assert!(super::builtin("service:kill:nginx").is_none());
        let p = super::builtin("supervisor:stop:horizon").expect("stop");
        assert!(p.danger && p.run.ends_with("asroot supervisorctl stop 'horizon:*'"));
        assert_eq!(
            super::builtin("supervisor-restart:horizon")
                .expect("old id")
                .label,
            "Restart horizon"
        );
        // The helper is valid sh, and runs the command directly as root.
        let out = std::process::Command::new("sh")
            .args(["-n", "-c", &s.run])
            .output()
            .expect("sh");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(super::builtin("certbot:x.com;rm -rf /").is_none());
        assert!(super::builtin("certbot:-x.com").is_none());
        let k = super::builtin("ssh-copy-id:id_ed25519").expect("ssh-copy-id");
        assert_eq!(
            k.run,
            "ssh-copy-id -o RemoteCommand=none -i ~/.ssh/id_ed25519.pub {{ server.host }}"
        );
        assert_eq!(k.kind, ActionKind::Local);
        assert!(super::builtin("ssh-copy-id:../x").is_none());
        assert!(super::builtin("ssh-copy-id:a b").is_none());
        assert!(super::builtin("ssh-keygen").is_some());
    }

    use super::*;
    use crate::config::validate::parse;

    fn config() -> Config {
        parse(
            r#"
servers:
  - id: stg
    host: stg-alias
    env: staging
    apps:
      - { id: akaun, path: /var/www/akaun, branch: develop, php: "8.4" }
actions:
  app:
    - { id: pull, label: "Git pull", run: "cd {{ app.path }} && git pull origin {{ app.branch }}" }
  server:
    - { id: nginx, run: "sudo nginx -t", danger: true }
    - { id: port, run: "nc -vz -w 5 {{ ip }} {{ port | default('22') }}" }
  local:
    - { id: deploy, run: "dep deploy {{ server.env }}" }
"#,
        )
        .config
        .expect("valid")
    }

    fn r(app: Option<&str>, action: &str) -> ActionRef {
        ActionRef {
            server_id: "stg".into(),
            app_id: app.map(String::from),
            action_id: action.into(),
            values: BTreeMap::new(),
        }
    }

    #[test]
    fn renders_with_title_and_kind() {
        let c = config();
        let a = render_action(&c, &r(Some("akaun"), "pull"), None).expect("render");
        assert_eq!(a.command, "cd /var/www/akaun && git pull origin develop");
        assert_eq!(a.title, "akaun · pull", "named after the app");
        assert_eq!(a.kind, ActionKind::Ssh);
        assert_eq!(a.host, "stg-alias");
        let d = render_action(&c, &r(Some("akaun"), "deploy"), None).expect("render");
        assert_eq!(
            (d.kind, d.command.as_str()),
            (ActionKind::Local, "dep deploy staging")
        );
        let n = render_action(&c, &r(None, "nginx"), None).expect("render");
        assert!(n.danger && n.app_id.is_none());
        assert_eq!(n.title, "stg · nginx", "server actions: the server");
    }

    #[test]
    fn override_replaces_command_but_keeps_rendered() {
        let c = config();
        let a = render_action(
            &c,
            &r(Some("akaun"), "pull"),
            Some("  git status \n".into()),
        )
        .expect("render");
        assert_eq!(a.command, "git status");
        assert_eq!(a.rendered, "cd /var/www/akaun && git pull origin develop");
        let blank =
            render_action(&c, &r(Some("akaun"), "pull"), Some("  ".into())).expect("render");
        assert_eq!(blank.command, blank.rendered);
    }

    #[test]
    fn params_are_asked_for() {
        let c = config();
        let mut a = r(None, "port");
        let p = render_action(&c, &a, None).expect("render");
        assert_eq!(p.command, "nc -vz -w 5 <ip> 22");
        assert_eq!(p.missing, ["ip"]);
        let names: Vec<&str> = p.params.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["ip", "port"]);
        assert!(ready(p).is_err(), "placeholders never run");
        a.values.insert("ip".into(), "10.1.2.3".into());
        a.values.insert("port".into(), "3306".into());
        let p = ready(render_action(&c, &a, None).expect("render")).expect("ready");
        assert_eq!(p.command, "nc -vz -w 5 10.1.2.3 3306");
    }

    #[test]
    fn unknown_targets_are_errors() {
        let c = config();
        assert!(render_action(&c, &r(Some("nope"), "pull"), None).is_err());
        assert!(render_action(&c, &r(Some("akaun"), "nope"), None).is_err());
        assert!(
            render_action(&c, &r(None, "pull"), None).is_err(),
            "app action without an app"
        );
        let other = ActionRef {
            server_id: "x".into(),
            app_id: None,
            action_id: "nginx".into(),
            values: BTreeMap::new(),
        };
        assert!(render_action(&c, &other, None).is_err());
    }
}
