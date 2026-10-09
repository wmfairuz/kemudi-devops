//! Login-shell environment capture.
//!
//! Apps launched from Finder get launchd's minimal environment (PATH is
//! `/usr/bin:/bin:/usr/sbin:/sbin`, no Homebrew, maybe no SSH_AUTH_SOCK).
//! At startup we run the user's shell once as an interactive login shell,
//! dump its environment, and use that for every PTY we spawn.

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const START: &str = "__KEMUDI_ENV_START__";
const END: &str = "__KEMUDI_ENV_END__";
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// Variables that describe the capturing shell itself, not the user's setup.
const SKIP: &[&str] = &[
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "TERM_SESSION_ID",
    "ZDOTDIR_ORIG",
];

#[derive(Debug, Clone)]
pub struct LoginEnv {
    pub shell: String,
    pub vars: BTreeMap<String, String>,
    /// Set when capture failed and we fell back to the process environment.
    pub warning: Option<String>,
}

impl LoginEnv {
    pub fn capture() -> Self {
        let shell = user_shell();
        let mut vars: BTreeMap<String, String> = std::env::vars().collect();
        let warning = match run_capture(&shell) {
            Ok(captured) => {
                vars.extend(captured);
                None
            }
            Err(e) => Some(format!(
                "could not read login environment from {shell}: {e}"
            )),
        };
        for k in SKIP {
            vars.remove(*k);
        }
        apply_terminal_defaults(&mut vars);
        vars.insert("SHELL".into(), shell.clone());
        LoginEnv {
            shell,
            vars,
            warning,
        }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.vars.get(key).map(String::as_str)
    }
}

fn apply_terminal_defaults(vars: &mut BTreeMap<String, String>) {
    vars.insert("TERM".into(), "xterm-256color".into());
    vars.insert("COLORTERM".into(), "truecolor".into());
    vars.insert("TERM_PROGRAM".into(), "Kemudi".into());
    vars.insert(
        "TERM_PROGRAM_VERSION".into(),
        env!("CARGO_PKG_VERSION").into(),
    );
    // macOS ssh forwards LANG/LC_*; a missing or bare "UTF-8" value makes
    // Ubuntu print setlocale warnings on every command.
    let lang_ok = vars.get("LANG").is_some_and(|v| v.contains('_'));
    if !lang_ok {
        vars.insert("LANG".into(), "en_US.UTF-8".into());
    }
    if vars.get("LC_CTYPE").is_some_and(|v| !v.contains('_')) {
        vars.remove("LC_CTYPE");
    }
}

/// The user's login shell: $SHELL, then the passwd entry, then zsh.
fn user_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if s.starts_with('/') {
            return s;
        }
    }
    passwd_shell().unwrap_or_else(|| "/bin/zsh".into())
}

fn passwd_shell() -> Option<String> {
    // SAFETY: getpwuid returns a pointer into static storage or null; we copy
    // the string out immediately and never hold the pointer.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        let s = std::ffi::CStr::from_ptr((*pw).pw_shell)
            .to_string_lossy()
            .into_owned();
        (!s.is_empty()).then_some(s)
    }
}

fn run_capture(shell: &str) -> Result<BTreeMap<String, String>, String> {
    let script = format!("printf '%s' '{START}'; /usr/bin/env -0; printf '%s' '{END}'");
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + CAPTURE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {}s", CAPTURE_TIMEOUT.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = reader.join().map_err(|_| "reader thread panicked")?;
    parse_env_dump(&out).ok_or_else(|| "no environment markers in shell output".into())
}

/// Extract `KEY=value` pairs from NUL-separated `env -0` output between the
/// start/end markers. Anything the shell's rc files print is ignored.
pub fn parse_env_dump(out: &[u8]) -> Option<BTreeMap<String, String>> {
    let text = String::from_utf8_lossy(out);
    let start = text.find(START)? + START.len();
    let end = start + text[start..].find(END)?;
    let vars = text[start..end]
        .split('\0')
        .filter_map(|entry| {
            let (k, v) = entry.split_once('=')?;
            let valid = !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            valid.then(|| (k.to_string(), v.to_string()))
        })
        .collect();
    Some(vars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_between_markers_and_ignores_rc_noise() {
        let out = format!(
            "Welcome!\n{START}PATH=/opt/homebrew/bin:/usr/bin\0SSH_AUTH_SOCK=/tmp/agent\0MULTI=a\nb\0EQ=x=y\0{END}bye"
        );
        let vars = parse_env_dump(out.as_bytes()).expect("markers present");
        assert_eq!(vars["PATH"], "/opt/homebrew/bin:/usr/bin");
        assert_eq!(vars["SSH_AUTH_SOCK"], "/tmp/agent");
        assert_eq!(vars["MULTI"], "a\nb");
        assert_eq!(vars["EQ"], "x=y");
        assert_eq!(vars.len(), 4);
    }

    #[test]
    fn missing_markers_is_none() {
        assert!(parse_env_dump(b"PATH=/usr/bin\0").is_none());
        assert!(parse_env_dump(format!("{START}PATH=/x\0").as_bytes()).is_none());
    }

    #[test]
    fn skips_invalid_keys() {
        let out = format!("{START}=bad\0bad key=1\0GOOD=1\0noequals\0{END}");
        let vars = parse_env_dump(out.as_bytes()).expect("markers present");
        assert_eq!(vars.len(), 1);
        assert_eq!(vars["GOOD"], "1");
    }

    #[test]
    fn terminal_defaults_fix_bare_locale() {
        let mut vars = BTreeMap::from([
            ("LANG".to_string(), "".to_string()),
            ("LC_CTYPE".to_string(), "UTF-8".to_string()),
        ]);
        apply_terminal_defaults(&mut vars);
        assert_eq!(vars["LANG"], "en_US.UTF-8");
        assert!(!vars.contains_key("LC_CTYPE"));
        assert_eq!(vars["TERM"], "xterm-256color");
    }

    #[test]
    fn terminal_defaults_keep_real_locale() {
        let mut vars = BTreeMap::from([("LANG".to_string(), "en_GB.UTF-8".to_string())]);
        apply_terminal_defaults(&mut vars);
        assert_eq!(vars["LANG"], "en_GB.UTF-8");
    }
}
