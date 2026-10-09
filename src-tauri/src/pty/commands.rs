use portable_pty::{CommandBuilder, PtySize};
use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use super::{Launch, PtyEvent, PtyId};
use crate::env::LoginEnv;
use crate::error::{AppError, AppResult};
use crate::AppState;

/// What kind of terminal the frontend wants. The frontend never sends argv.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SpawnSpec {
    /// An interactive login shell on this Mac.
    Local { cwd: Option<String> },
    /// `ssh <host>` using ~/.ssh/config, keys and the agent as-is,
    /// optionally starting in `cwd` on the server (an app's path).
    Ssh { host: String, cwd: Option<String> },
}

/// Keyboard/paste input is text; a few legacy mouse encodings are raw bytes.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum PtyInput {
    Text(String),
    Bytes(Vec<u8>),
}

pub fn pty_size(cols: u16, rows: u16) -> AppResult<PtySize> {
    if cols == 0 || rows == 0 {
        return Err(AppError::Invalid(format!(
            "invalid terminal size {cols}x{rows}"
        )));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

/// A command builder with exactly the captured login environment.
pub fn base_command(env: &LoginEnv, program: Option<&str>) -> CommandBuilder {
    let mut cmd = match program {
        Some(p) => CommandBuilder::new(p),
        // Runs $SHELL as a login shell (argv0 "-zsh").
        None => CommandBuilder::new_default_prog(),
    };
    cmd.env_clear();
    for (k, v) in &env.vars {
        cmd.env(k, v);
    }
    if let Some(home) = env.get("HOME") {
        cmd.cwd(home);
    }
    cmd
}

/// `~/x` → $HOME/x (tab config folders are often written that way).
fn expand_home(path: &str, env: &LoginEnv) -> std::path::PathBuf {
    match (path.strip_prefix("~/"), env.get("HOME")) {
        (Some(rest), Some(home)) => std::path::Path::new(&home).join(rest),
        _ => std::path::PathBuf::from(path),
    }
}

fn launch_for(spec: SpawnSpec, env: &LoginEnv, integrate: bool) -> AppResult<Launch> {
    Ok(match spec {
        SpawnSpec::Local { cwd } => {
            let mut cmd = base_command(env, None);
            if let Some(dir) = cwd.map(|d| expand_home(&d, env)).filter(|d| d.is_dir()) {
                cmd.cwd(dir);
            }
            if integrate {
                crate::shell_integration::apply_local(&mut cmd, env, &env.shell);
            }
            Launch::plain(cmd)
        }
        SpawnSpec::Ssh { host, cwd } => {
            crate::ssh::validate_host(&host)?;
            let mut cmd = base_command(env, Some("ssh"));
            let remote = remote_command(cwd.as_deref(), integrate);
            let hc = crate::ssh::host_config(&host, env);
            cmd.args(&hc.connect_opts);
            cmd.args(crate::ssh::ssh_args(
                &host,
                remote.as_deref(),
                hc.remote_command.as_deref(),
                true,
            ));
            Launch::plain(cmd).on_host(host)
        }
    })
}

/// What an ssh tab runs on the server: optionally `cd` into a directory,
/// then an interactive shell (integrated bash when enabled). `None` means a
/// plain `ssh <host>`.
pub fn remote_command(cwd: Option<&str>, integrate: bool) -> Option<String> {
    let cd = cwd.map(str::trim).filter(|c| !c.is_empty()).map(|dir| {
        let q = crate::actions::render::shell_quote(dir);
        format!("cd {q} 2>/dev/null || printf 'kemudi: could not cd to %s\\n' {q}\n")
    });
    match (cd, integrate) {
        (None, false) => None,
        (cd, true) => Some(format!(
            "{}{}",
            cd.unwrap_or_default(),
            crate::shell_integration::remote_shell()
        )),
        (Some(cd), false) => Some(format!("{cd}exec \"${{SHELL:-/bin/sh}}\" -l\n")),
    }
}

#[tauri::command]
pub async fn pty_spawn(
    state: State<'_, AppState>,
    spec: SpawnSpec,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> AppResult<PtyId> {
    let size = pty_size(cols, rows)?;
    let launch = launch_for(spec, state.env_ready().await, state.shell_integration())?;
    state.ptys.spawn(launch, size, on_data, on_event)
}

#[tauri::command]
pub async fn pty_write(state: State<'_, AppState>, id: PtyId, data: PtyInput) -> AppResult<()> {
    let bytes = match data {
        PtyInput::Text(s) => s.into_bytes(),
        PtyInput::Bytes(b) => b,
    };
    state.ptys.write(id, bytes)
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, AppState>,
    id: PtyId,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state.ptys.resize(id, pty_size(cols, rows)?)
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, AppState>, id: PtyId) -> AppResult<()> {
    state.ptys.kill(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::native_pty_system;
    use std::io::Read;

    #[test]
    fn remote_command_cds_into_app_path() {
        assert_eq!(remote_command(None, false), None);
        assert_eq!(remote_command(Some("  "), false), None);
        let plain =
            remote_command(Some("/opt/www/staging.example.com/billing"), false).unwrap_or_default();
        assert!(
            plain.starts_with("cd /opt/www/staging.example.com/billing 2>/dev/null ||"),
            "{plain}"
        );
        assert!(
            plain.ends_with("exec \"${SHELL:-/bin/sh}\" -l\n"),
            "{plain}"
        );
        let spaced = remote_command(Some("/var/www/my app"), false).unwrap_or_default();
        assert!(spaced.starts_with("cd '/var/www/my app' "), "{spaced}");
        let integrated = remote_command(Some("/srv/app"), true).unwrap_or_default();
        assert!(
            integrated.starts_with("cd /srv/app ") && integrated.contains("bash --rcfile"),
            "{integrated}"
        );
    }

    /// The composed command really lands in the directory (run with sh).
    #[test]
    fn remote_command_runs_in_sh() {
        let dir = std::env::temp_dir();
        let script = remote_command(dir.to_str(), false)
            .unwrap_or_default()
            .replace("exec \"${SHELL:-/bin/sh}\" -l", "pwd -P");
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .expect("sh");
        let want = std::fs::canonicalize(&dir).expect("canonical tmp");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            want.display().to_string()
        );
    }

    #[test]
    fn rejects_zero_size() {
        assert!(pty_size(0, 24).is_err());
        assert!(pty_size(80, 0).is_err());
        assert!(pty_size(80, 24).is_ok());
    }

    /// Machine-dependent smoke test of the real spawn path: captured login
    /// env → login shell in a PTY. Run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn login_shell_in_pty_sees_login_env() {
        let env = LoginEnv::capture();
        assert!(env.warning.is_none(), "{:?}", env.warning);
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 200,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = base_command(&env, Some(&env.shell));
        cmd.args(["-l", "-c", "echo \"PATH=$PATH\"; echo \"TERM=$TERM\"; echo \"AGENT=${SSH_AUTH_SOCK:+set}\"; command -v ssh"]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        // Read concurrently: the PTY buffer is small, so waiting first would
        // deadlock once the shell's output fills it.
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let collector = std::thread::spawn(move || {
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
            }
            String::from_utf8_lossy(&out).into_owned()
        });
        let _ = child.wait();
        drop(pair.master);
        let out = collector.join().unwrap_or_default();
        println!("{out}");
        assert!(out.contains("TERM=xterm-256color"), "{out}");
        assert!(out.contains("/usr/bin/ssh"), "{out}");
        let path_line = out
            .lines()
            .find(|l| l.starts_with("PATH="))
            .unwrap_or_default();
        assert!(
            path_line.contains(".cargo/bin") || path_line.contains("/opt/homebrew"),
            "{path_line}"
        );
    }
}
