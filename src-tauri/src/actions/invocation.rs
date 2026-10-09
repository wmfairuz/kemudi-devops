//! Turn a rendered command into what actually runs in the PTY.
//!
//! The command is wrapped so that:
//!   * Ctrl+C stops the command but not the wrapper (`trap : INT`), so the
//!     tab falls through to a live shell instead of closing;
//!   * a `# comment` at the end of the command can't swallow the marker
//!     (everything is newline-separated);
//!   * the exit status is printed as `__KEMUDI_EXIT:<n>`, which the PTY
//!     reader strips and reports.
//!
//! Afterwards the tab becomes a live shell: with shell integration on, an
//! integrated bash remotely (see `shell_integration`), else a login shell.
//!
//! The wrapper is passed as a single argv element (no local shell parsing).

use portable_pty::CommandBuilder;

use crate::config::schema::ActionKind;
use crate::env::LoginEnv;
use crate::pty::commands::base_command;
use crate::shell_integration;

/// Run `command`, report its exit status, then run `then` (the shell the
/// tab falls through to).
///
/// After the command, the shell that follows runs as a job of this one with
/// job control on (`set -m`, `K_EXEC` empty) instead of replacing it: an
/// interactive `bash -lic …` that ran programs (a deploy alias with
/// `sudo -u www-data …`) can leave the terminal to a process group that's
/// gone, and an exec'd shell then gets "no job control in background" and
/// quits on the first ↵; a job-control parent hands it the terminal. Job
/// control is only turned on after the command, as with it Ctrl+C would end
/// this shell over ssh. Not under zsh, which needs none of this.
pub fn wrap(command: &str, then: &str) -> String {
    format!("trap : INT\n{command}\n__k=$?; trap - INT; printf '\\n__KEMUDI_EXIT:%s\\n' \"$__k\"\nif [ -z \"$ZSH_VERSION\" ] && set -m 2>/dev/null; then K_EXEC=; fi\n{then}")
}

fn login_shell(fallback: &str) -> String {
    format!("${{K_EXEC-exec}} \"${{SHELL:-{fallback}}}\" -l; exit $?\n")
}

/// `ssh -t <host> <wrapped>` or `<login shell> -l -c <wrapped>`.
pub fn command_for(
    kind: ActionKind,
    host: &str,
    command: &str,
    env: &LoginEnv,
    integrate: bool,
) -> CommandBuilder {
    match kind {
        ActionKind::Ssh => {
            let then = if integrate {
                shell_integration::remote_shell()
            } else {
                login_shell("/bin/bash")
            };
            let mut cmd = base_command(env, Some("ssh"));
            let hc = crate::ssh::host_config(host, env);
            cmd.args(&hc.connect_opts);
            cmd.args(crate::ssh::ssh_args(
                host,
                Some(&wrap(command, &then)),
                hc.remote_command.as_deref(),
                false,
            ));
            cmd
        }
        ActionKind::Local => {
            let mut cmd = base_command(env, Some(&env.shell));
            cmd.args(["-l", "-c", &wrap(command, &login_shell(&env.shell))]);
            if integrate {
                shell_integration::apply_local(&mut cmd, env, &env.shell);
            }
            cmd
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapper_shape() {
        let w = wrap(
            "cd /var/www/akaun && git pull # trailing comment",
            &login_shell("/bin/bash"),
        );
        let lines: Vec<&str> = w.lines().collect();
        assert_eq!(lines[0], "trap : INT");
        assert_eq!(lines[1], "cd /var/www/akaun && git pull # trailing comment");
        assert!(lines[2].contains("__KEMUDI_EXIT:%s"));
        assert!(lines[3].contains("set -m") && lines[3].contains("K_EXEC="));
        assert_eq!(
            lines[4],
            r#"${K_EXEC-exec} "${SHELL:-/bin/bash}" -l; exit $?"#
        );
    }

    /// Run the wrapper in a real shell: the marker carries the exit code.
    #[test]
    fn wrapper_reports_exit_code() {
        let script = wrap("(exit 3)", "true\n");
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .env_remove("SHELL")
            .output()
            .expect("run /bin/sh");
        assert!(String::from_utf8_lossy(&out.stdout).contains("__KEMUDI_EXIT:3"));
    }
}

/// Real PTY + login shell. Run with `cargo test -- --ignored`.
#[cfg(test)]
mod pty_tests {
    use super::*;
    use crate::pty::marker::{MarkerScanner, Segment};
    use portable_pty::{native_pty_system, PtySize};
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// Spawn a local action, optionally send input after `delay`, and return
    /// (exit code from the marker, output after the marker).
    fn run_local(command: &str, input_after: Option<(Duration, &[u8])>) -> (Option<i32>, String) {
        let env = crate::env::LoginEnv::capture();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut child = pair
            .slave
            .spawn_command(command_for(ActionKind::Local, "", command, &env, false))
            .expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let started = Instant::now();
        let mut sent = false;
        let mut scanner = MarkerScanner::new();
        let mut code = None;
        let mut after = String::new();
        while started.elapsed() < Duration::from_secs(20) {
            if let Some((delay, bytes)) = input_after {
                if !sent && started.elapsed() > delay {
                    let _ = writer.write_all(bytes);
                    sent = true;
                }
            }
            let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            for seg in scanner.feed(&chunk) {
                match seg {
                    Segment::Exit(c) => code = Some(c),
                    Segment::Data(d) if code.is_some() => {
                        after.push_str(&String::from_utf8_lossy(&d))
                    }
                    Segment::Data(_) => {}
                }
            }
            // After the marker the wrapper execs a login shell; give it a
            // moment to print its prompt, then leave.
            if code.is_some() && !after.is_empty() {
                break;
            }
        }
        let _ = writer.write_all(b"exit\r");
        let _ = child.kill();
        (code, after)
    }

    #[test]
    #[ignore]
    fn local_action_reports_exit_code_and_stays_open() {
        let (code, after) = run_local("echo hello; (exit 3)", None);
        assert_eq!(code, Some(3));
        assert!(!after.is_empty(), "a live shell should follow the marker");
    }

    #[test]
    #[ignore]
    fn ctrl_c_stops_command_not_tab() {
        let (code, after) = run_local("sleep 30", Some((Duration::from_millis(1500), b"\x03")));
        assert_eq!(code, Some(130), "SIGINT exit status");
        assert!(!after.is_empty(), "shell must survive Ctrl+C");
    }

    /// The real wrapper around a command, for trying it over ssh:
    /// KEMUDI_WRAP_OUT=file KEMUDI_WRAP_CMD='…' cargo test dump_wrapper -- --ignored
    #[test]
    #[ignore]
    fn dump_wrapper() {
        if let (Ok(out), Ok(cmd)) = (
            std::env::var("KEMUDI_WRAP_OUT"),
            std::env::var("KEMUDI_WRAP_CMD"),
        ) {
            std::fs::write(out, wrap(&cmd, &crate::shell_integration::remote_shell()))
                .expect("write");
        }
    }
}
