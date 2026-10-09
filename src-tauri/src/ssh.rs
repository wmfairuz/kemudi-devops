//! Helpers around the system `ssh`: host alias validation and reading
//! `Host` aliases from ~/.ssh/config for suggestions. Kemudi never speaks
//! SSH itself.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const MAX_INCLUDE_DEPTH: usize = 8;

/// Accept `alias`, `user@host`, `host.example.com`, `10.0.0.5`. Reject
/// anything ssh could read as an option (`-oProxyCommand=…`) or that needs
/// quoting.
pub fn validate_host(host: &str) -> AppResult<()> {
    let ok = !host.is_empty()
        && host.len() <= 255
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._@:-".contains(c));
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid(format!(
            "not a valid ssh host alias: {host:?}"
        )))
    }
}

/// The `RemoteCommand` the user's ssh config gives a host (e.g. `sudo -i`),
/// from `ssh -G` (local, no connection).
/// What Kemudi needs from a host's effective ssh config (`ssh -G`).
#[derive(Debug, Default)]
pub struct HostConfig {
    pub remote_command: Option<String>,
    /// Options that go before the host (see [`connect_opts`]).
    pub connect_opts: Vec<String>,
}

pub fn host_config(host: &str, env: &crate::env::LoginEnv) -> HostConfig {
    if validate_host(host).is_err() {
        return HostConfig::default();
    }
    let out = std::process::Command::new("ssh")
        .arg("-G")
        .arg(host)
        .env_clear()
        .envs(&env.vars)
        .stdin(std::process::Stdio::null())
        .output();
    let text = out
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    HostConfig {
        remote_command: parse_remote_command(&text),
        connect_opts: connect_opts(&text, control_path().as_deref()),
    }
}

/// Shared connection socket per host (also used by Monitor and Inspect).
pub fn control_path() -> Option<String> {
    dirs::home_dir().map(|h| h.join(".ssh").join("kemudi-cm-%C").display().to_string())
}

/// Some networks silently drop a share of new connections (per source
/// port), and ssh then waits out the OS's ~75 s connect timeout on the same
/// port. Unless the user's config already says otherwise:
///   * give up on an attempt after a few seconds and try again on a fresh
///     connection;
///   * share one connection per host (ControlMaster), so once it is up new
///     panes and actions reuse it instead of connecting again.
pub fn connect_opts(ssh_g: &str, control: Option<&str>) -> Vec<String> {
    let value = |key: &str| {
        ssh_g
            .lines()
            .find_map(|l| l.strip_prefix(key).and_then(|v| v.strip_prefix(' ')))
            .map(str::trim)
    };
    let mut opts = Vec::new();
    if matches!(value("connecttimeout"), None | Some("none")) {
        opts.extend(["-o".to_string(), "ConnectTimeout=5".to_string()]);
    }
    if matches!(value("connectionattempts"), None | Some("1")) {
        opts.extend(["-o".to_string(), "ConnectionAttempts=8".to_string()]);
    }
    let own_master = !matches!(value("controlmaster"), None | Some("false" | "no"))
        || value("controlpath").is_some_and(|p| p != "none");
    if let (Some(path), false) = (control, own_master) {
        for o in [
            "ControlMaster=auto".to_string(),
            format!("ControlPath={path}"),
            "ControlPersist=120".to_string(),
        ] {
            opts.extend(["-o".to_string(), o]);
        }
        // A shared connection that died (sleep, Wi-Fi change) must notice,
        // or new tabs would hang on it.
        if matches!(value("serveraliveinterval"), None | Some("0")) {
            opts.extend(["-o".to_string(), "ServerAliveInterval=15".to_string()]);
        }
    }
    opts
}

pub fn parse_remote_command(ssh_g: &str) -> Option<String> {
    ssh_g
        .lines()
        .find_map(|l| l.strip_prefix("remotecommand "))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v != "none")
}

/// ssh arguments to run `remote` on `host`, given the host's RemoteCommand
/// (`rc`), which ssh won't combine with a command of ours:
///   * no `remote`: plain `ssh host` (their RemoteCommand runs as usual);
///   * a `sudo …` RemoteCommand (log in as root): skip it and run ours
///     through `sudo -H bash -lc`, keeping the "as root" intent;
///   * any other RemoteCommand: skip it for commands; an `interactive`
///     shell instead logs in plainly so theirs runs.
pub fn ssh_args(
    host: &str,
    remote: Option<&str>,
    rc: Option<&str>,
    interactive: bool,
) -> Vec<String> {
    let s = |x: &str| x.to_string();
    match (remote, rc) {
        (None, _) => vec![s(host)],
        (Some(r), None) => vec![s("-t"), s(host), s(r)],
        (Some(r), Some(c)) if c.trim_start().starts_with("sudo") => vec![
            s("-o"),
            s("RemoteCommand=none"),
            s("-t"),
            s(host),
            format!(
                "sudo -H bash -lc {}",
                crate::actions::render::shell_quote(r)
            ),
        ],
        (Some(_), Some(_)) if interactive => vec![s(host)],
        (Some(r), Some(_)) => vec![s("-o"), s("RemoteCommand=none"), s("-t"), s(host), s(r)],
    }
}

/// Non-wildcard `Host` aliases from ~/.ssh/config and its `Include`s.
pub fn config_hosts() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let ssh_dir = home.join(".ssh");
    let mut hosts = BTreeSet::new();
    collect(&ssh_dir.join("config"), &ssh_dir, &home, 0, &mut hosts);
    hosts.into_iter().collect()
}

fn collect(path: &Path, ssh_dir: &Path, home: &Path, depth: usize, out: &mut BTreeSet<String>) {
    if depth > MAX_INCLUDE_DEPTH {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for directive in parse_directives(&text) {
        match directive {
            Directive::Host(patterns) => out.extend(
                patterns
                    .into_iter()
                    .filter(|p| !p.contains(['*', '?', '!']) && validate_host(p).is_ok()),
            ),
            Directive::Include(targets) => {
                for t in targets {
                    for file in expand_include(&t, ssh_dir, home) {
                        collect(&file, ssh_dir, home, depth + 1, out);
                    }
                }
            }
        }
    }
}

#[derive(Debug, PartialEq)]
enum Directive {
    Host(Vec<String>),
    Include(Vec<String>),
}

fn parse_directives(text: &str) -> Vec<Directive> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            // `Keyword args` or `Keyword=args`.
            let split = line.find(|c: char| c.is_whitespace() || c == '=')?;
            let (key, rest) = line.split_at(split);
            let args: Vec<String> = rest
                .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
                .split_whitespace()
                .map(|a| a.trim_matches('"').to_string())
                .collect();
            match key.to_ascii_lowercase().as_str() {
                "host" => Some(Directive::Host(args)),
                "include" => Some(Directive::Include(args)),
                _ => None,
            }
        })
        .collect()
}

/// Resolve an Include argument: `~` expands, relative paths are relative to
/// ~/.ssh, and a `*` in the file name matches like a shell glob.
fn expand_include(arg: &str, ssh_dir: &Path, home: &Path) -> Vec<PathBuf> {
    let path = if let Some(rest) = arg.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(arg).is_absolute() {
        PathBuf::from(arg)
    } else {
        ssh_dir.join(arg)
    };
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    if !name.contains('*') {
        return vec![path];
    }
    let Some(dir) = path.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| wildcard_match(name, n))
        })
        .map(|e| e.path())
        .collect();
    files.sort();
    files
}

fn wildcard_match(pattern: &str, name: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == name,
        Some((prefix, rest)) => {
            let Some(tail) = name.strip_prefix(prefix) else {
                return false;
            };
            if rest.is_empty() {
                return true;
            }
            (0..=tail.len()).any(|i| tail.is_char_boundary(i) && wildcard_match(rest, &tail[i..]))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_command_routes() {
        let g = "user azureuser\nhostname 203.0.113.10\nremotecommand sudo -i\nrequesttty true\n";
        assert_eq!(parse_remote_command(g).as_deref(), Some("sudo -i"));
        assert_eq!(parse_remote_command("remotecommand none\n"), None);
        assert_eq!(parse_remote_command("hostname x\n"), None);

        let v = |a: Vec<String>| a.join(" | ");
        // No command of ours: plain ssh, their RemoteCommand runs.
        assert_eq!(v(ssh_args("h", None, Some("sudo -i"), true)), "h");
        // No RemoteCommand: as before.
        assert_eq!(
            v(ssh_args("h", Some("cd /x; bash -l"), None, true)),
            "-t | h | cd /x; bash -l"
        );
        // sudo RemoteCommand: skip it, run ours as root.
        assert_eq!(
            v(ssh_args(
                "h",
                Some("cd /opt/www/app"),
                Some("sudo -i"),
                false
            )),
            "-o | RemoteCommand=none | -t | h | sudo -H bash -lc 'cd /opt/www/app'"
        );
        // Another RemoteCommand: commands skip it; a shell honours it.
        assert_eq!(
            v(ssh_args("h", Some("git pull"), Some("cd /var/www"), false)),
            "-o | RemoteCommand=none | -t | h | git pull"
        );
        assert_eq!(
            v(ssh_args("h", Some("cd /x"), Some("cd /var/www"), true)),
            "h"
        );
    }

    #[test]
    fn host_validation() {
        for ok in [
            "stg-svr03",
            "deploy@10.0.0.5",
            "client-prod-01.example.com",
            "h_1",
        ] {
            assert!(validate_host(ok).is_ok(), "{ok}");
        }
        for bad in ["", "-oProxyCommand=evil", "a b", "host;rm", "$(x)", "a'b"] {
            assert!(validate_host(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn parses_hosts_and_includes() {
        let text = "\
# comment
Host stg-svr03 stg-svr04
  HostName 10.0.1.13
host=client-prod-01
Host *.internal !bastion bastion
Include config.d/*  ~/.ssh/extra
Match host foo
";
        assert_eq!(
            parse_directives(text),
            vec![
                Directive::Host(vec!["stg-svr03".into(), "stg-svr04".into()]),
                Directive::Host(vec!["client-prod-01".into()]),
                Directive::Host(vec![
                    "*.internal".into(),
                    "!bastion".into(),
                    "bastion".into()
                ]),
                Directive::Include(vec!["config.d/*".into(), "~/.ssh/extra".into()]),
            ]
        );
    }

    #[test]
    fn follows_glob_includes() {
        let root = std::env::temp_dir().join(format!("kemudi-ssh-test-{}", std::process::id()));
        let ssh = root.join(".ssh");
        let _ = std::fs::create_dir_all(ssh.join("config.d"));
        let write = |p: PathBuf, s: &str| std::fs::write(p, s).expect("write fixture");
        write(
            ssh.join("config"),
            "Host main\nInclude config.d/*.conf\nHost *\n",
        );
        write(ssh.join("config.d/a.conf"), "Host from-a\n");
        write(ssh.join("config.d/b.conf"), "Host from-b wild*\n");
        write(ssh.join("config.d/skip.txt"), "Host skipped\n");
        let mut out = BTreeSet::new();
        collect(&ssh.join("config"), &ssh, &root, 0, &mut out);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(
            out.into_iter().collect::<Vec<_>>(),
            vec!["from-a", "from-b", "main"]
        );
    }

    #[test]
    fn wildcards() {
        assert!(wildcard_match("*.conf", "a.conf"));
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("a*b*c", "aXXbYc"));
        assert!(!wildcard_match("*.conf", "a.txt"));
    }

    #[test]
    fn connect_retry_unless_configured() {
        let defaults =
            "user root\nconnecttimeout none\nconnectionattempts 1\ncontrolmaster false\n";
        assert_eq!(
            connect_opts(defaults, Some("/h/.ssh/cm-%C")),
            [
                "-o",
                "ConnectTimeout=5",
                "-o",
                "ConnectionAttempts=8",
                "-o",
                "ControlMaster=auto",
                "-o",
                "ControlPath=/h/.ssh/cm-%C",
                "-o",
                "ControlPersist=120",
                "-o",
                "ServerAliveInterval=15"
            ]
        );
        let own =
            "connecttimeout 30\nconnectionattempts 3\ncontrolmaster auto\ncontrolpath /x/%C\n";
        assert!(connect_opts(own, Some("/h/.ssh/cm-%C")).is_empty());
    }
}
