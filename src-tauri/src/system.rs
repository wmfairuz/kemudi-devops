//! Small OS integrations: opening links, the environment report.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::AppState;

/// Open an http(s) link from the terminal in the default browser.
#[tauri::command]
pub async fn open_url(url: String) -> AppResult<()> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(AppError::Invalid(format!(
            "refusing to open non-http link: {url}"
        )));
    }
    Command::new("/usr/bin/open").arg(&url).spawn()?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocation {
    name: &'static str,
    path: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// Agent reachable and holding keys.
    Ok,
    /// Agent reachable but empty: fine if ssh loads keys itself.
    Empty,
    /// No agent socket, or ssh-add failed.
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvReport {
    shell: String,
    path: Vec<String>,
    ssh_auth_sock: Option<String>,
    /// Output of `ssh-add -l` (or why it failed).
    agent: String,
    agent_state: AgentState,
    tools: Vec<ToolLocation>,
    warning: Option<String>,
}

const TOOLS: &[&str] = &["ssh", "git", "php", "composer", "dep", "openfortivpn"];

/// What the PTYs will see: proves PATH and the agent survive a Finder launch.
#[tauri::command]
pub async fn env_report(state: State<'_, AppState>) -> AppResult<EnvReport> {
    let env = state.env_ready().await;
    let path_var = env.get("PATH").unwrap_or_default();
    let path: Vec<String> = path_var
        .split(':')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();
    let tools = TOOLS
        .iter()
        .map(|&name| ToolLocation {
            name,
            path: which(name, &path),
        })
        .collect();
    let (agent_state, agent) = ssh_agent_status(env);
    Ok(EnvReport {
        shell: env.shell.clone(),
        path,
        ssh_auth_sock: env.get("SSH_AUTH_SOCK").map(String::from),
        agent,
        agent_state,
        tools,
        warning: env.warning.clone(),
    })
}

fn which(name: &str, path: &[String]) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    path.iter()
        .map(|dir| Path::new(dir).join(name))
        .find_map(|p| {
            let meta = std::fs::metadata(&p).ok()?;
            (meta.is_file() && meta.permissions().mode() & 0o111 != 0)
                .then(|| p.display().to_string())
        })
}

fn ssh_agent_status(env: &crate::env::LoginEnv) -> (AgentState, String) {
    let mut cmd = Command::new("ssh-add");
    cmd.arg("-l")
        .env_clear()
        .envs(&env.vars)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return (
                AgentState::Unavailable,
                format!("could not run ssh-add: {e}"),
            )
        }
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut child = child;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                return (AgentState::Unavailable, "ssh-add timed out".into());
            }
        }
    }
    match child.wait_with_output() {
        Ok(out) => {
            let text = String::from_utf8_lossy(if out.stdout.is_empty() {
                &out.stderr
            } else {
                &out.stdout
            })
            .trim()
            .to_string();
            // 0 = keys listed, 1 = agent reachable but empty, 2 = no agent.
            let state = match out.status.code() {
                Some(0) => AgentState::Ok,
                Some(1) => AgentState::Empty,
                _ => AgentState::Unavailable,
            };
            (state, text)
        }
        Err(e) => (AgentState::Unavailable, e.to_string()),
    }
}

#[tauri::command]
pub async fn ssh_hosts() -> AppResult<Vec<String>> {
    Ok(crate::ssh::config_hosts())
}

/// `KEMUDI_QUIET=1`: no background checks or notifications (a second copy
/// started for testing, next to the real one).
#[tauri::command]
pub fn app_quiet() -> bool {
    std::env::var("KEMUDI_QUIET").is_ok_and(|v| !v.is_empty() && v != "0")
}
