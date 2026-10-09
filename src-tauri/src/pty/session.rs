//! PTY sessions: spawn, stream output to the webview, write, resize, kill.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

use super::marker::{MarkerScanner, Segment};
use crate::error::{AppError, AppResult};

const READ_BUF: usize = 64 * 1024;
const KILL_GRACE: Duration = Duration::from_secs(2);

pub type PtyId = u32;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    /// The action's command finished (parsed from the exit marker).
    #[serde(rename_all = "camelCase")]
    ActionExit { code: i32, elapsed_ms: u64 },
    /// The PTY's process exited and the output stream closed.
    Exit { code: Option<u32> },
}

/// What to run in a new PTY.
pub struct Launch {
    pub cmd: CommandBuilder,
    /// Watch the output for the `__KEMUDI_EXIT:` marker (action tabs).
    pub track_exit_marker: bool,
    pub hooks: ExitHooks,
    /// The ssh host it talks to (passwords are only filled into its own
    /// server's sessions).
    pub host: Option<String>,
}

/// Callbacks from the reader thread (used by the audit log).
#[derive(Default)]
pub struct ExitHooks {
    /// The action's exit code, from the marker.
    pub on_action_exit: Option<Box<dyn FnOnce(i32) + Send>>,
    /// The PTY's output closed (process gone).
    pub on_exit: Option<Box<dyn FnOnce() + Send>>,
}

impl Launch {
    /// An interactive shell or ssh session.
    pub fn plain(cmd: CommandBuilder) -> Self {
        Launch {
            cmd,
            track_exit_marker: false,
            hooks: ExitHooks::default(),
            host: None,
        }
    }

    /// An action wrapped by `actions::invocation` (prints the exit marker).
    pub fn tracked(cmd: CommandBuilder) -> Self {
        Launch {
            cmd,
            track_exit_marker: true,
            hooks: ExitHooks::default(),
            host: None,
        }
    }

    pub fn with_hooks(mut self, hooks: ExitHooks) -> Self {
        self.hooks = hooks;
        self
    }

    pub fn on_host(mut self, host: impl Into<String>) -> Self {
        self.host = Some(host.into());
        self
    }
}

struct Session {
    input: mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    pid: Option<u32>,
    exited: Arc<AtomicBool>,
    host: Option<String>,
}

#[derive(Default)]
pub struct PtyRegistry {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<PtyId, Session>>,
}

impl PtyRegistry {
    fn sessions(&self) -> MutexGuard<'_, HashMap<PtyId, Session>> {
        // A panic while holding the lock can't leave the map inconsistent
        // (every operation is a single insert/remove/get), so keep going.
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn spawn(
        &self,
        launch: Launch,
        size: PtySize,
        on_data: Channel<InvokeResponseBody>,
        on_event: Channel<PtyEvent>,
    ) -> AppResult<PtyId> {
        let pair = native_pty_system().openpty(size).map_err(pty_err)?;
        let mut child = pair.slave.spawn_command(launch.cmd).map_err(pty_err)?;
        // The slave fd must be closed in this process, or reads never hit EOF.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(pty_err)?;
        let writer = pair.master.take_writer().map_err(pty_err)?;
        let pid = child.process_id();
        let exited = Arc::new(AtomicBool::new(false));

        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
        std::thread::Builder::new()
            .name("pty-writer".into())
            .spawn(move || write_loop(writer, input_rx))?;

        let (exit_tx, exit_rx) = mpsc::channel::<Option<u32>>();
        let exited_flag = exited.clone();
        std::thread::Builder::new()
            .name("pty-waiter".into())
            .spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code());
                exited_flag.store(true, Ordering::SeqCst);
                let _ = exit_tx.send(code);
            })?;

        let host = launch.host;
        let track = launch.track_exit_marker;
        let hooks = launch.hooks;
        std::thread::Builder::new()
            .name("pty-reader".into())
            .spawn(move || read_loop(reader, track, hooks, on_data, on_event, exit_rx))?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions().insert(
            id,
            Session {
                input: input_tx,
                master: pair.master,
                pid,
                exited,
                host,
            },
        );
        Ok(id)
    }

    /// The ssh host a session was started for (None: local).
    pub fn host_of(&self, id: PtyId) -> Option<String> {
        self.sessions().get(&id).and_then(|s| s.host.clone())
    }

    pub fn write(&self, id: PtyId, bytes: Vec<u8>) -> AppResult<()> {
        let sessions = self.sessions();
        let s = sessions.get(&id).ok_or(AppError::PtyNotFound(id))?;
        s.input
            .send(bytes)
            .map_err(|_| AppError::Pty("terminal input is closed".into()))
    }

    pub fn resize(&self, id: PtyId, size: PtySize) -> AppResult<()> {
        let sessions = self.sessions();
        let s = sessions.get(&id).ok_or(AppError::PtyNotFound(id))?;
        s.master.resize(size).map_err(pty_err)
    }

    /// SIGHUP the session's process group, then SIGKILL it if it's still
    /// alive after a grace period. Unknown ids are ignored (already closed).
    pub fn kill(&self, id: PtyId) {
        let Some(session) = self.sessions().remove(&id) else {
            return;
        };
        let (pid, exited) = (session.pid, session.exited.clone());
        // Dropping the master closes the PTY, which also hangs up the session.
        drop(session);
        let Some(pid) = pid else { return };
        signal_group(pid, libc::SIGHUP);
        std::thread::spawn(move || {
            std::thread::sleep(KILL_GRACE);
            if !exited.load(Ordering::SeqCst) {
                signal_group(pid, libc::SIGKILL);
            }
        });
    }

    /// Hang up every session (app quit). No grace period: we're exiting.
    pub fn kill_all(&self) {
        let sessions: Vec<Session> = self.sessions().drain().map(|(_, s)| s).collect();
        for s in sessions {
            if let Some(pid) = s.pid {
                signal_group(pid, libc::SIGHUP);
            }
        }
    }
}

fn write_loop(mut writer: Box<dyn Write + Send>, rx: mpsc::Receiver<Vec<u8>>) {
    for chunk in rx {
        if writer
            .write_all(&chunk)
            .and_then(|_| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    track_exit_marker: bool,
    mut hooks: ExitHooks,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
    exit_rx: mpsc::Receiver<Option<u32>>,
) {
    let started = Instant::now();
    let mut scanner = track_exit_marker.then(MarkerScanner::new);
    let mut buf = vec![0u8; READ_BUF];
    let send = |bytes: Vec<u8>| on_data.send(InvokeResponseBody::Raw(bytes)).is_ok();

    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break, // EIO once the child side is gone
        };
        let chunk = &buf[..n];
        let delivered = match scanner.as_mut() {
            None => send(chunk.to_vec()),
            Some(scanner) => {
                let mut out = Vec::with_capacity(n + 64);
                for seg in scanner.feed(chunk) {
                    match seg {
                        Segment::Data(d) => out.extend(d),
                        Segment::Exit(code) => {
                            let elapsed = started.elapsed();
                            // Close the action's command block (OSC 133;D) before the banner.
                            out.extend(format!("\x1b]133;D;{code}\x07").into_bytes());
                            out.extend(exit_banner(code, elapsed));
                            // A blank row before the shell's prompt: room for the block divider.
                            out.extend(b"\r\n");
                            if let Some(hook) = hooks.on_action_exit.take() {
                                hook(code);
                            }
                            let _ = on_event.send(PtyEvent::ActionExit {
                                code,
                                elapsed_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
                            });
                        }
                    }
                }
                out.is_empty() || send(out)
            }
        };
        if !delivered {
            break; // webview is gone
        }
    }
    if let Some(rest) = scanner.as_mut().and_then(MarkerScanner::flush) {
        let _ = send(rest);
    }
    let code = exit_rx.recv_timeout(KILL_GRACE).ok().flatten();
    if let Some(hook) = hooks.on_exit.take() {
        hook();
    }
    let _ = on_event.send(PtyEvent::Exit { code });
}

/// Shown in place of the exit marker: `✓ exit 0 · 3.2s · 14:27:43`, with a
/// green check or a red cross (design frame 1a, terminal output).
pub fn exit_banner(code: i32, elapsed: Duration) -> Vec<u8> {
    // 130 is Ctrl+C (e.g. leaving `tail -f`): not a failure worth red.
    let (colour, glyph) = match code {
        0 => ("32", "✓"),
        130 => ("2", "^C"),
        _ => ("31", "✗"),
    };
    format!(
        "\x1b[{colour}m{glyph} \x1b[0;2mexit {code} · {} · {}\x1b[0m\r\n",
        format_elapsed(elapsed),
        crate::util::local_hms()
    )
    .into_bytes()
}

pub fn format_elapsed(d: Duration) -> String {
    let secs = d.as_secs_f64();
    if secs < 60.0 {
        format!("{secs:.1}s")
    } else {
        let total = d.as_secs();
        format!("{}m {:02}s", total / 60, total % 60)
    }
}

fn signal_group(pid: u32, sig: libc::c_int) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    // SAFETY: plain syscall; the child called setsid() so its pid is the
    // process-group id. ESRCH (already gone) is fine to ignore.
    unsafe {
        libc::killpg(pid, sig);
    }
}

fn pty_err(e: impl std::fmt::Display) -> AppError {
    AppError::Pty(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_formatting() {
        assert_eq!(format_elapsed(Duration::from_millis(12_340)), "12.3s");
        assert_eq!(format_elapsed(Duration::from_secs(245)), "4m 05s");
    }

    #[test]
    fn banner_colour_reflects_status() {
        let ok = String::from_utf8(exit_banner(0, Duration::from_secs(1))).unwrap_or_default();
        let bad = String::from_utf8(exit_banner(2, Duration::from_secs(1))).unwrap_or_default();
        assert!(ok.starts_with("\x1b[32m✓") && ok.contains("exit 0 · 1.0s · "));
        assert!(bad.starts_with("\x1b[31m✗") && bad.contains("exit 2"));
    }
}
