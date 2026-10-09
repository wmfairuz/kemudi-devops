//! Shell integration: make shells mark where each prompt, command and
//! output begins and ends (OSC 133, plus 633;E for the exact command line),
//! so the terminal can offer Warp-style blocks: copy command / copy output.
//!
//! The user's dotfiles are never edited:
//! * local zsh: ZDOTDIR points at small files that source the user's own
//!   startup files first, then add precmd/preexec hooks;
//! * remote bash: the ssh command writes a temp rcfile that loads the usual
//!   profile files, adds PROMPT_COMMAND/PS0 hooks and deletes itself.

use std::path::PathBuf;
use std::sync::OnceLock;

use portable_pty::CommandBuilder;

use crate::env::LoginEnv;

const ZSH_FILES: &[(&str, &str)] = &[
    (".zshenv", include_str!("shell_integration/zsh/.zshenv")),
    (".zprofile", include_str!("shell_integration/zsh/.zprofile")),
    (".zshrc", include_str!("shell_integration/zsh/.zshrc")),
    (".zlogin", include_str!("shell_integration/zsh/.zlogin")),
];

const BASH_RC: &str = include_str!("shell_integration/bashrc.sh");
const RC_EOF: &str = "__KEMUDI_RC_EOF__";

/// Write the zsh files to <data_dir>/shell-integration/zsh (once per run).
fn zsh_dir() -> Option<&'static PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = crate::data_dir()?.join("shell-integration").join("zsh");
        std::fs::create_dir_all(&dir).ok()?;
        for (name, body) in ZSH_FILES {
            let path = dir.join(name);
            if std::fs::read_to_string(&path).ok().as_deref() != Some(*body) {
                std::fs::write(&path, body).ok()?;
            }
        }
        Some(dir)
    })
    .as_ref()
}

/// Point a local zsh at the integration files (no-op for other shells).
pub fn apply_local(cmd: &mut CommandBuilder, env: &LoginEnv, shell: &str) {
    if !shell.ends_with("zsh") {
        return;
    }
    let Some(dir) = zsh_dir() else { return };
    let user_dir = env
        .get("ZDOTDIR")
        .or_else(|| env.get("HOME"))
        .unwrap_or("~")
        .to_string();
    cmd.env("KEMUDI_USER_ZDOTDIR", user_dir);
    cmd.env("ZDOTDIR", dir);
}

/// POSIX sh that starts an integrated interactive bash on the remote end,
/// falling back to the user's login shell when bash or mktemp is missing.
pub fn remote_shell() -> String {
    format!(
        "if command -v bash >/dev/null 2>&1 && KEMUDI_RC=$(mktemp 2>/dev/null); then\n\
         cat > \"$KEMUDI_RC\" <<'{RC_EOF}'\n{BASH_RC}{RC_EOF}\n\
         export KEMUDI_RC\n\
         ${{K_EXEC-exec}} bash --rcfile \"$KEMUDI_RC\" -i; exit $?\n\
         fi\n\
         ${{K_EXEC-exec}} \"${{SHELL:-/bin/sh}}\" -l; exit $?\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rc_never_contains_its_heredoc_terminator() {
        assert!(!BASH_RC.lines().any(|l| l.trim() == RC_EOF));
        assert!(
            BASH_RC.ends_with('\n'),
            "terminator must start its own line"
        );
    }

    /// The bootstrap is valid POSIX sh (checked with sh -n).
    #[test]
    fn bootstrap_parses_in_sh() {
        let out = std::process::Command::new("/bin/sh")
            .args(["-n", "-c", &remote_shell()])
            .output()
            .expect("run sh");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// The rcfile and zsh files are valid in their shells.
    #[test]
    fn integration_scripts_parse() {
        let bash = std::process::Command::new("/bin/bash")
            .args(["-n", "-c", BASH_RC])
            .output()
            .expect("bash");
        assert!(
            bash.status.success(),
            "{}",
            String::from_utf8_lossy(&bash.stderr)
        );
        for (name, body) in ZSH_FILES {
            let zsh = std::process::Command::new("/bin/zsh")
                .args(["-n", "-c", body])
                .output()
                .expect("zsh");
            assert!(
                zsh.status.success(),
                "{name}: {}",
                String::from_utf8_lossy(&zsh.stderr)
            );
        }
    }

    /// In a real bash: the rc marks prompt, command and exit status.
    #[test]
    fn bash_rc_emits_markers() {
        let script = format!(
            "{BASH_RC}\ntrue; __kemudi_prompt; false; __kemudi_prompt; printf '%s' \"$PS0\""
        );
        let out = std::process::Command::new("/bin/bash")
            .args(["--norc", "--noprofile", "-c", &script])
            .env("HOME", std::env::temp_dir())
            .output()
            .expect("bash");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            text.contains("\u{1b}]133;D;0\u{7}\u{1b}]133;A\u{7}"),
            "{text:?}"
        );
        assert!(
            text.contains("\u{1b}]133;D;1\u{7}"),
            "exit status of `false`: {text:?}"
        );
        assert!(text.contains("133;C"), "PS0 marks output start: {text:?}");
        assert!(
            !text.contains("\u{7}\n"),
            "no blank row when no command ran: {text:?}"
        );
    }

    /// After a command ran (PS0 sets the flag), the prompt adds a blank row.
    #[test]
    fn bash_rc_blank_row_after_command() {
        let script =
            format!("{BASH_RC}\n: \"${{__kemudi_ps0[__kemudi_ran=1]-}}\"; false; __kemudi_prompt; echo \"ran=$__kemudi_ran\"");
        let out = std::process::Command::new("/bin/bash")
            .args(["--norc", "--noprofile", "-c", &script])
            .env("HOME", std::env::temp_dir())
            .output()
            .expect("bash");
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            text.contains("\u{1b}]133;D;1\u{7}\n\u{1b}]133;A\u{7}"),
            "{text:?}"
        );
        assert!(text.ends_with("ran=0\n"), "flag resets: {text:?}");
    }
}
