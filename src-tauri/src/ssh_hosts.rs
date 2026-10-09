//! SSH hosts created from Kemudi's UI. They live in Kemudi's own file,
//! ~/.ssh/config.d/kemudi.conf, which ~/.ssh/config pulls in with one
//! `Include` line, so `ssh <alias>` works in any terminal too. Kemudi only
//! ever rewrites that file; the user's own config gets the Include line
//! (after a one-time backup) and nothing else. No passwords, ever.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const INCLUDE_LINE: &str = "Include ~/.ssh/config.d/kemudi.conf";
const HEADER: &str = "# SSH hosts added in Kemudi. Kemudi rewrites this file; edit hosts in the\n# app (or here, keeping one setting per line). ~/.ssh/config includes it.\n";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub alias: String,
    /// IP or domain name.
    pub hostname: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// Private key, e.g. `~/.ssh/id_ed25519` (the agent/defaults otherwise).
    pub identity_file: Option<String>,
    /// Jump host(s), e.g. `bastion` or `ops@bastion:2222`.
    pub jump: Option<String>,
    /// Any other ssh options, one `Key value` per line, kept as written.
    #[serde(default)]
    pub extra: Vec<String>,
}

pub fn ssh_dir() -> AppResult<PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".ssh"))
        .ok_or_else(|| AppError::Invalid("no home directory".into()))
}

pub fn managed_path(ssh_dir: &Path) -> PathBuf {
    ssh_dir.join("config.d").join("kemudi.conf")
}

fn invalid(msg: String) -> AppError {
    AppError::Invalid(msg)
}

fn plain(s: &str, extra: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.len() <= 255
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

impl HostEntry {
    pub fn validate(&self) -> AppResult<()> {
        if !plain(&self.alias, "._-") {
            return Err(invalid(format!(
                "the SSH host name {:?} can use letters, digits, . _ -",
                self.alias
            )));
        }
        if !plain(&self.hostname, ".-:") {
            return Err(invalid(format!(
                "{:?} isn't a host name or IP address",
                self.hostname
            )));
        }
        if let Some(u) = &self.user {
            if !plain(u, "._-") || u.len() > 64 {
                return Err(invalid(format!("{u:?} isn't a valid user name")));
            }
        }
        if self.port == Some(0) {
            return Err(invalid("port 0 isn't valid".into()));
        }
        if let Some(j) = &self.jump {
            if !plain(j, "._@:,-") {
                return Err(invalid(format!("{j:?} isn't a valid jump host")));
            }
        }
        if let Some(k) = &self.identity_file {
            if k.trim().is_empty() || k.starts_with('-') || k.contains(['\n', '\r', '"', '\0']) {
                return Err(invalid(format!("{k:?} isn't a usable key path")));
            }
        }
        for line in &self.extra {
            let key = line.split([' ', '\t', '=']).next().unwrap_or("");
            let ok = !key.is_empty()
                && key.chars().all(|c| c.is_ascii_alphanumeric())
                && !line.contains(['\n', '\r', '\0'])
                && !matches!(
                    key.to_ascii_lowercase().as_str(),
                    "host"
                        | "match"
                        | "include"
                        | "hostname"
                        | "user"
                        | "port"
                        | "identityfile"
                        | "proxyjump"
                );
            if !ok {
                return Err(invalid(format!(
                    "{line:?} isn't an extra ssh option Kemudi can keep (one `Key value` per line)"
                )));
            }
        }
        Ok(())
    }

    /// `ssh` options + destination that reach this host without the alias
    /// (for testing before it's saved).
    pub fn args(&self) -> Vec<String> {
        let mut a = Vec::new();
        if let Some(p) = self.port {
            a.extend(["-p".to_string(), p.to_string()]);
        }
        if let Some(k) = &self.identity_file {
            a.extend(["-i".to_string(), k.clone()]);
        }
        if let Some(j) = &self.jump {
            a.extend(["-J".to_string(), j.clone()]);
        }
        a.push(match &self.user {
            Some(u) => format!("{u}@{}", self.hostname),
            None => self.hostname.clone(),
        });
        a
    }

    fn block(&self) -> String {
        let mut b = format!("Host {}\n  HostName {}\n", self.alias, self.hostname);
        if let Some(u) = &self.user {
            b += &format!("  User {u}\n");
        }
        if let Some(p) = self.port {
            b += &format!("  Port {p}\n");
        }
        if let Some(k) = &self.identity_file {
            if k.contains(' ') {
                b += &format!("  IdentityFile \"{k}\"\n");
            } else {
                b += &format!("  IdentityFile {k}\n");
            }
        }
        if let Some(j) = &self.jump {
            b += &format!("  ProxyJump {j}\n");
        }
        for line in &self.extra {
            b += &format!("  {}\n", line.trim());
        }
        b
    }
}

/// Kemudi's file: `Host` blocks with one `Key value` per line.
pub fn parse_managed(text: &str) -> Vec<HostEntry> {
    let mut out: Vec<HostEntry> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(split) = line.find(|c: char| c.is_whitespace() || c == '=') else {
            continue;
        };
        let (key, rest) = line.split_at(split);
        let value = rest
            .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
            .trim()
            .trim_matches('"')
            .to_string();
        match key.to_ascii_lowercase().as_str() {
            "host" => out.push(HostEntry {
                alias: value,
                ..Default::default()
            }),
            k => {
                let Some(e) = out.last_mut() else { continue };
                match k {
                    "hostname" => e.hostname = value,
                    "user" => e.user = Some(value),
                    "port" => e.port = value.parse().ok(),
                    "identityfile" => e.identity_file = Some(value),
                    "proxyjump" => e.jump = Some(value),
                    _ => e.extra.push(line.to_string()),
                }
            }
        }
    }
    out
}

pub fn render_managed(entries: &[HostEntry]) -> String {
    let mut s = HEADER.to_string();
    for e in entries {
        s.push('\n');
        s += &e.block();
    }
    s
}

/// ~/.ssh/config with the Include line first, or None if it's already there.
/// Include has to come before any Host/Match block to apply to every host.
pub fn with_include(config: &str) -> Option<String> {
    let has = config.lines().any(|l| {
        let t = l.trim();
        t.to_ascii_lowercase().starts_with("include")
            && (t.contains("config.d/kemudi.conf") || t.contains("config.d/*"))
    });
    if has {
        return None;
    }
    let mut out = format!("# Hosts added in Kemudi (see that file).\n{INCLUDE_LINE}\n");
    if !config.trim().is_empty() {
        out.push('\n');
        out += config;
    }
    Some(out)
}

fn write_private(path: &Path, text: &str) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let tmp = path.with_extension("kemudi-tmp");
    std::fs::write(&tmp, text)?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Add or replace (`original` = its current alias) a host in Kemudi's file
/// and make sure ~/.ssh/config includes it. `taken` lists every alias ssh
/// already knows, so a new one can't shadow the user's own.
pub fn save(
    ssh_dir: &Path,
    original: Option<&str>,
    entry: &HostEntry,
    taken: &[String],
) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    entry.validate()?;
    let path = managed_path(ssh_dir);
    let mut entries = std::fs::read_to_string(&path)
        .map(|t| parse_managed(&t))
        .unwrap_or_default();
    if let Some(orig) = original {
        if !entries.iter().any(|e| e.alias == orig) {
            return Err(invalid(format!(
                "`{orig}` isn't one of Kemudi's SSH hosts; edit it in ~/.ssh/config"
            )));
        }
    }
    if original != Some(entry.alias.as_str()) && taken.iter().any(|t| t == &entry.alias) {
        return Err(invalid(format!(
            "there's already an SSH host called `{}`",
            entry.alias
        )));
    }
    match original.and_then(|o| entries.iter().position(|e| e.alias == o)) {
        Some(i) => entries[i] = entry.clone(),
        None => entries.push(entry.clone()),
    }

    for dir in [ssh_dir.to_path_buf(), ssh_dir.join("config.d")] {
        if !dir.exists() {
            std::fs::create_dir_all(&dir)?;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    write_private(&path, &render_managed(&entries))?;

    let config = ssh_dir.join("config");
    let current = match std::fs::read_to_string(&config) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    if let Some(updated) = with_include(&current) {
        let backup = ssh_dir.join("config.kemudi-backup");
        if config.exists() && !backup.exists() {
            std::fs::copy(&config, &backup)?;
        }
        write_private(&config, &updated)?;
    }
    Ok(())
}

/// Remove one of Kemudi's hosts.
pub fn delete(ssh_dir: &Path, alias: &str) -> AppResult<()> {
    let path = managed_path(ssh_dir);
    let mut entries = managed(ssh_dir);
    let before = entries.len();
    entries.retain(|e| e.alias != alias);
    if entries.len() == before {
        return Err(invalid(format!(
            "`{alias}` isn't one of Kemudi's SSH hosts"
        )));
    }
    write_private(&path, &render_managed(&entries))
}

fn keyword(l: &str) -> String {
    l.trim()
        .split([' ', '\t', '='])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn args(l: &str) -> Vec<String> {
    let t = l.trim();
    let rest = t.find([' ', '\t', '=']).map_or("", |i| &t[i..]);
    rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=')
        .split_whitespace()
        .map(|a| a.trim_matches('"').to_string())
        .collect()
}

/// The `Host <alias>` block in the user's own config file, split out: the
/// file without it, and the host as an entry. Only a block whose Host line
/// names just that alias, without an Include of its own, can move.
pub fn take_block(config: &str, alias: &str) -> Result<(String, HostEntry), String> {
    let lines: Vec<&str> = config.lines().collect();
    let start = lines
        .iter()
        .position(|l| keyword(l) == "host" && args(l).iter().any(|a| a == alias))
        .ok_or_else(|| {
            format!("`{alias}` isn't in ~/.ssh/config itself (it may come from an included file)")
        })?;
    let names = args(lines[start]);
    if names.len() != 1 {
        return Err(format!(
            "its Host line names several hosts ({}); split it in ~/.ssh/config first",
            names.join(" ")
        ));
    }
    let end = (start + 1..lines.len())
        .find(|&i| matches!(keyword(lines[i]).as_str(), "host" | "match"))
        .unwrap_or(lines.len());
    let mut entry = HostEntry {
        alias: alias.to_string(),
        ..Default::default()
    };
    for l in &lines[start + 1..end] {
        let t = l.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let value = args(l).join(" ");
        match keyword(l).as_str() {
            "include" => return Err("its block has an Include; move it by hand".into()),
            "hostname" => entry.hostname = value,
            "user" => entry.user = Some(value),
            "port" => entry.port = Some(value.parse().map_err(|_| format!("odd Port {value:?}"))?),
            "identityfile" => entry.identity_file = Some(value),
            "proxyjump" => entry.jump = Some(value),
            _ => entry.extra.push(t.to_string()),
        }
    }
    if entry.hostname.is_empty() {
        entry.hostname = alias.to_string();
    }
    entry.validate().map_err(|e| e.to_string())?;
    // Drop the block, and a blank line it would leave doubled.
    let mut kept: Vec<&str> = lines[..start].to_vec();
    let tail = &lines[end..];
    if kept.last().is_some_and(|l| l.trim().is_empty())
        && tail.first().is_none_or(|l| l.trim().is_empty())
    {
        kept.pop();
    }
    kept.extend_from_slice(tail);
    let mut out = kept.join("\n");
    if config.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    Ok((out, entry))
}

/// Move a host from ~/.ssh/config into Kemudi's file (after a timestamped
/// backup), so it can be edited in the app.
pub fn adopt(ssh_dir: &Path, alias: &str, stamp: &str) -> AppResult<HostEntry> {
    use std::os::unix::fs::PermissionsExt;
    if managed(ssh_dir).iter().any(|e| e.alias == alias) {
        return Err(invalid(format!("`{alias}` is already Kemudi's")));
    }
    let config_path = ssh_dir.join("config");
    let config = std::fs::read_to_string(&config_path)?;
    let (rest, entry) = take_block(&config, alias).map_err(invalid)?;
    std::fs::copy(
        &config_path,
        ssh_dir.join(format!("config.kemudi-backup-{stamp}")),
    )?;
    // Into Kemudi's file first, then out of the user's: never lost between.
    let dir = ssh_dir.join("config.d");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut entries = managed(ssh_dir);
    entries.push(entry.clone());
    write_private(&managed_path(ssh_dir), &render_managed(&entries))?;
    let rest = with_include(&rest).unwrap_or(rest);
    write_private(&config_path, &rest)?;
    Ok(entry)
}

/// Kemudi's own hosts.
pub fn managed(ssh_dir: &Path) -> Vec<HostEntry> {
    std::fs::read_to_string(managed_path(ssh_dir))
        .map(|t| parse_managed(&t))
        .unwrap_or_default()
}

/// Private keys in ~/.ssh (files with a matching .pub), as `~/.ssh/<name>`.
pub fn keys(ssh_dir: &Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(ssh_dir) else {
        return Vec::new();
    };
    let mut keys: Vec<String> = rd
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter_map(|n| n.strip_suffix(".pub").map(str::to_string))
        .filter(|n| ssh_dir.join(n).is_file())
        .map(|n| format!("~/.ssh/{n}"))
        .collect();
    keys.sort();
    keys
}

// ------------------------------------------------------------- commands

/// What the server form shows for an SSH host alias.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub alias: String,
    /// ssh knows it (any config file).
    pub known: bool,
    /// For the user's own hosts: why "Manage in Kemudi" can't move it
    /// (None: it can).
    pub adopt_blocker: Option<String>,
    /// Kemudi's own entry (editable in the app).
    pub managed: Option<HostEntry>,
    /// The user's own `Host` block in ~/.ssh/config, as written (to show
    /// and, once edited, move into Kemudi's file).
    pub external: Option<HostEntry>,
    /// What `ssh -G` makes of it (also for the user's own hosts).
    pub resolved: Option<crate::preflight::SshResolved>,
}

#[tauri::command]
pub async fn ssh_host_info(
    state: tauri::State<'_, crate::AppState>,
    alias: String,
) -> AppResult<HostInfo> {
    let dir = ssh_dir()?;
    let known = crate::ssh::config_hosts().contains(&alias);
    let managed = managed(&dir).into_iter().find(|e| e.alias == alias);
    let resolved = if known {
        crate::preflight::ssh_g(&alias, state.env_ready().await)
            .await
            .ok()
    } else {
        None
    };
    let (adopt_blocker, external) = if known && managed.is_none() {
        match std::fs::read_to_string(dir.join("config")) {
            Ok(cfg) => match take_block(&cfg, &alias) {
                Ok((_, e)) => (None, Some(e)),
                Err(why) => (Some(why), None),
            },
            Err(e) => (Some(e.to_string()), None),
        }
    } else {
        (None, None)
    };
    Ok(HostInfo {
        alias,
        known,
        adopt_blocker,
        managed,
        external,
        resolved,
    })
}

#[tauri::command]
pub async fn ssh_host_save(original: Option<String>, entry: HostEntry) -> AppResult<()> {
    let taken = crate::ssh::config_hosts();
    save(&ssh_dir()?, original.as_deref(), &entry, &taken)
}

/// Open ~/.ssh/config (for hosts Kemudi doesn't manage) in the editor.
#[tauri::command]
pub async fn ssh_config_open(state: tauri::State<'_, crate::AppState>) -> AppResult<()> {
    let path = ssh_dir()?.join("config");
    crate::config::commands::open_in_editor(&path.display().to_string(), None, &state)
}

#[tauri::command]
pub async fn ssh_host_delete(alias: String) -> AppResult<()> {
    delete(&ssh_dir()?, &alias)
}

#[tauri::command]
pub async fn ssh_host_adopt(alias: String) -> AppResult<HostEntry> {
    adopt(&ssh_dir()?, &alias, &stamp())
}

/// `YYYYmmdd-HHMMSS` (local time), for backup names.
fn stamp() -> String {
    std::process::Command::new("/bin/date")
        .arg("+%Y%m%d-%H%M%S")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs())
                .to_string()
        })
}

/// The SSH hosts Kemudi manages (editable from the app).
#[tauri::command]
pub async fn ssh_managed_hosts() -> AppResult<Vec<HostEntry>> {
    Ok(managed(&ssh_dir()?))
}

#[tauri::command]
pub async fn ssh_keys() -> AppResult<Vec<String>> {
    Ok(keys(&ssh_dir()?))
}

#[derive(Debug, Serialize)]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
}

/// Try a non-interactive login (`BatchMode`, no password prompt) to an alias
/// or to an unsaved entry, and explain what happened in plain words.
#[tauri::command]
pub async fn ssh_test(
    state: tauri::State<'_, crate::AppState>,
    alias: Option<String>,
    entry: Option<HostEntry>,
) -> AppResult<TestResult> {
    let target = match (&entry, &alias) {
        (Some(e), _) => {
            e.validate()?;
            e.args()
        }
        (None, Some(a)) => {
            crate::ssh::validate_host(a)?;
            vec![a.clone()]
        }
        (None, None) => return Err(invalid("nothing to test".into())),
    };
    let env = state.env_ready().await;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "RemoteCommand=none",
        "-o",
        "RequestTTY=no",
    ])
    .args(&target)
    .arg("echo \"$(whoami)@$(hostname)\"")
    .env_clear()
    .envs(&env.vars)
    .stdin(std::process::Stdio::null())
    .kill_on_drop(true);
    let out = match tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output()).await {
        Err(_) => {
            return Ok(TestResult {
                ok: false,
                message: "No answer within 15 s (VPN down, or a wrong address?)".into(),
            })
        }
        Ok(r) => r?,
    };
    if out.status.success() {
        let who = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Ok(TestResult {
            ok: true,
            message: format!("Connected: logged in as {who}"),
        });
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Ok(TestResult {
        ok: false,
        message: explain(&err),
    })
}

/// ssh's stderr → what to do about it.
pub fn explain(stderr: &str) -> String {
    let has = |s: &str| stderr.contains(s);
    if has("Permission denied") {
        "Login refused: the server wants a password or another key. Kemudi never stores passwords: \
         Open shell and type it there, or pick the right key."
            .into()
    } else if has("Host key verification failed") || has("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        "The server's host key isn't trusted yet (or it changed). Open shell once and answer the prompt, then test again.".into()
    } else if has("Could not resolve hostname") {
        "That host name can't be found.".into()
    } else if has("Connection refused") {
        "Nothing is listening on that port (wrong port?).".into()
    } else if has("timed out") || has("No route to host") {
        "No answer (VPN down, or a wrong address?).".into()
    } else if has("Identity file") && has("not accessible") {
        "That key file doesn't exist.".into()
    } else {
        stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("ssh failed")
            .trim()
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> HostEntry {
        HostEntry {
            alias: "stg-web3".into(),
            hostname: "10.0.1.13".into(),
            user: Some("root".into()),
            port: Some(2222),
            identity_file: Some("~/.ssh/id_ed25519".into()),
            jump: Some("bastion".into()),
            extra: vec![],
        }
    }

    #[test]
    fn blocks_round_trip() {
        let e = entry();
        let other = HostEntry {
            alias: "b".into(),
            hostname: "b.example.com".into(),
            ..Default::default()
        };
        let text = render_managed(&[e.clone(), other.clone()]);
        assert!(text.contains("Host stg-web3\n  HostName 10.0.1.13\n  User root\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\n  ProxyJump bastion\n"), "{text}");
        assert_eq!(parse_managed(&text), vec![e, other]);
        assert_eq!(
            entry().args(),
            [
                "-p",
                "2222",
                "-i",
                "~/.ssh/id_ed25519",
                "-J",
                "bastion",
                "root@10.0.1.13"
            ]
        );
    }

    #[test]
    fn include_goes_first_once() {
        let cfg = "Host github.com\n  User git\n";
        let out = with_include(cfg).expect("added");
        assert!(out.starts_with("# Hosts added in Kemudi (see that file).\nInclude ~/.ssh/config.d/kemudi.conf\n\nHost github.com"), "{out}");
        assert_eq!(with_include(&out), None);
        assert_eq!(with_include("Include config.d/*\n"), None);
        assert_eq!(
            with_include("").as_deref(),
            Some("# Hosts added in Kemudi (see that file).\nInclude ~/.ssh/config.d/kemudi.conf\n")
        );
    }

    #[test]
    fn rejects_unsafe_values() {
        let bad = [
            HostEntry {
                alias: "-oProxyCommand=x".into(),
                ..entry()
            },
            HostEntry {
                alias: "a b".into(),
                ..entry()
            },
            HostEntry {
                hostname: "".into(),
                ..entry()
            },
            HostEntry {
                hostname: "x;rm".into(),
                ..entry()
            },
            HostEntry {
                user: Some("ro ot".into()),
                ..entry()
            },
            HostEntry {
                identity_file: Some("a\nProxyCommand x".into()),
                ..entry()
            },
            HostEntry {
                jump: Some("-x".into()),
                ..entry()
            },
            HostEntry {
                port: Some(0),
                ..entry()
            },
        ];
        for e in bad {
            assert!(e.validate().is_err(), "{e:?}");
        }
        assert!(entry().validate().is_ok());
    }

    #[test]
    fn extra_options_round_trip() {
        let e = HostEntry {
            extra: vec!["ForwardAgent yes".into(), "ServerAliveInterval 30".into()],
            ..entry()
        };
        let text = render_managed(std::slice::from_ref(&e));
        assert!(
            text.contains("  ProxyJump bastion\n  ForwardAgent yes\n  ServerAliveInterval 30\n"),
            "{text}"
        );
        assert_eq!(parse_managed(&text), vec![e]);
        for bad in ["Include evil", "HostName x", "Match all", "a\nb", ""] {
            assert!(
                HostEntry {
                    extra: vec![bad.into()],
                    ..entry()
                }
                .validate()
                .is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn takes_a_block_out_of_the_users_config() {
        let cfg = "Include ~/.ssh/config.d/kemudi.conf\n\nHost github.com\n  User git\n\nHost stg-web3\n  HostName 10.0.1.13\n  User root\n  ForwardAgent yes\n\nHost *\n  AddKeysToAgent yes\n";
        let (rest, e) = take_block(cfg, "stg-web3").expect("take");
        assert_eq!(rest, "Include ~/.ssh/config.d/kemudi.conf\n\nHost github.com\n  User git\n\nHost *\n  AddKeysToAgent yes\n");
        assert_eq!(
            (e.hostname.as_str(), e.user.as_deref(), e.extra.clone()),
            (
                "10.0.1.13",
                Some("root"),
                vec!["ForwardAgent yes".to_string()]
            )
        );
        let (_, e) =
            take_block("Host box.example.com\n  User me\n", "box.example.com").expect("take");
        assert_eq!(e.hostname, "box.example.com");
        assert!(
            take_block("Host a b\n  User x\n", "a").is_err(),
            "several names"
        );
        assert!(
            take_block("Host a\n  Include other\n", "a").is_err(),
            "include inside"
        );
        assert!(take_block("Host other\n", "a").is_err(), "not here");
    }

    #[test]
    fn adopt_and_delete() {
        let dir = std::env::temp_dir().join(format!("kemudi-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(
            dir.join("config"),
            "Host stg-web3\n  HostName 10.0.1.13\n  User root\n\nHost github.com\n  User git\n",
        )
        .expect("cfg");
        let e = adopt(&dir, "stg-web3", "t1").expect("adopt");
        assert_eq!(e.hostname, "10.0.1.13");
        let cfg = std::fs::read_to_string(dir.join("config")).expect("cfg");
        assert!(
            cfg.contains(INCLUDE_LINE)
                && !cfg.contains("stg-web3")
                && cfg.contains("Host github.com"),
            "{cfg}"
        );
        assert!(std::fs::read_to_string(dir.join("config.kemudi-backup-t1"))
            .expect("bak")
            .contains("Host stg-web3"));
        assert_eq!(managed(&dir).len(), 1);
        assert!(adopt(&dir, "stg-web3", "t2").is_err(), "already Kemudi's");
        delete(&dir, "stg-web3").expect("delete");
        assert!(managed(&dir).is_empty());
        assert!(delete(&dir, "stg-web3").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Read-only: which of this machine's hosts "Manage in Kemudi" can move.
    /// `cargo test dry_run_take_blocks -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn dry_run_take_blocks() {
        let Ok(dir) = ssh_dir() else { return };
        let Ok(cfg) = std::fs::read_to_string(dir.join("config")) else {
            return;
        };
        for alias in crate::ssh::config_hosts() {
            match take_block(&cfg, &alias) {
                Ok((_, e)) => println!(
                    "{alias}: can move → {} {:?} extra={:?}",
                    e.hostname, e.user, e.extra
                ),
                Err(why) => println!("{alias}: stays ({why})"),
            }
        }
    }

    #[test]
    fn explains_ssh_errors() {
        assert!(
            explain("root@1.2.3.4: Permission denied (publickey,password).")
                .starts_with("Login refused")
        );
        assert!(
            explain("ssh: Could not resolve hostname nope: nodename nor servname provided")
                .starts_with("That host name")
        );
        assert!(
            explain("ssh: connect to host 1.2.3.4 port 22: Operation timed out")
                .starts_with("No answer")
        );
        assert_eq!(explain("weird\nlast line\n"), "last line");
    }

    #[test]
    fn save_writes_both_files() {
        let dir = std::env::temp_dir().join(format!("kemudi-ssh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("config"), "Host github.com\n  User git\n").expect("cfg");
        let taken = vec!["github.com".to_string()];
        save(&dir, None, &entry(), &taken).expect("save");
        let cfg = std::fs::read_to_string(dir.join("config")).expect("cfg");
        assert!(
            cfg.starts_with("# Hosts added in Kemudi")
                && cfg.ends_with("Host github.com\n  User git\n"),
            "{cfg}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("config.kemudi-backup")).expect("bak"),
            "Host github.com\n  User git\n"
        );
        assert_eq!(managed(&dir), vec![entry()]);
        // Rename keeps one entry; a clash with the user's own host is refused.
        let renamed = HostEntry {
            alias: "nst3".into(),
            ..entry()
        };
        save(&dir, Some("stg-web3"), &renamed, &taken).expect("rename");
        assert_eq!(managed(&dir), vec![renamed.clone()]);
        let clash = HostEntry {
            alias: "github.com".into(),
            ..entry()
        };
        assert!(save(&dir, None, &clash, &taken).is_err());
        assert!(
            save(&dir, Some("github.com"), &clash, &taken).is_err(),
            "not Kemudi's to edit"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
