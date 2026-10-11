//! AWS Auto Scaling group servers (`asg:`): the group's running instances,
//! asked of the AWS CLI when they're needed (never in the background), and
//! Session Manager sessions to them (`aws ssm start-session`, so the user's
//! own AWS profiles and session-manager-plugin are used as they are).

use std::time::Duration;

use base64::Engine;
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::schema::{Asg, Server};
use crate::env::LoginEnv;
use crate::error::{AppError, AppResult};
use crate::pty::commands::base_command;
use crate::AppState;

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub name: Option<String>,
    pub ip: Option<String>,
    pub az: Option<String>,
    pub launched: Option<String>,
}

/// `--profile p --region r`, for whichever are set.
fn aws_opts(asg: &Asg) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(p) = &asg.profile {
        out.extend(["--profile".to_string(), p.clone()]);
    }
    if let Some(r) = &asg.region {
        out.extend(["--region".to_string(), r.clone()]);
    }
    out
}

/// `i-` and 8 or 17 hex digits.
pub fn validate_instance(id: &str) -> AppResult<()> {
    let hex = id.strip_prefix("i-").unwrap_or_default();
    if (8..=17).contains(&hex.len()) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("not an EC2 instance id: {id:?}")))
    }
}

fn describe_args(asg: &Asg) -> Vec<String> {
    let mut a: Vec<String> = ["ec2", "describe-instances", "--filters"]
        .map(String::from)
        .to_vec();
    a.push(format!(
        "Name=tag:aws:autoscaling:groupName,Values={}",
        asg.name
    ));
    a.push("Name=instance-state-name,Values=running".into());
    a.push("--query".into());
    a.push("Reservations[].Instances[].{id: InstanceId, name: Tags[?Key=='Name'] | [0].Value, ip: PrivateIpAddress, az: Placement.AvailabilityZone, launched: LaunchTime}".into());
    a.extend(["--output".into(), "json".into()]);
    a.extend(aws_opts(asg));
    a
}

/// Readable AWS CLI failures (an expired SSO login is the usual one).
fn lookup_error(asg: &Asg, stderr: &str) -> String {
    let msg = stderr.trim();
    let login = match &asg.profile {
        Some(p) => format!("aws sso login --profile {p}"),
        None => "aws sso login".into(),
    };
    if msg.contains("Token has expired")
        || msg.contains("SSO session")
        || msg.contains("sso") && msg.contains("expired")
    {
        format!("The AWS login for this profile has expired: run `{login}` in a terminal, then try again.\n\n{msg}")
    } else if msg.contains("could not be found") && msg.contains("profile") {
        format!(
            "No AWS profile {:?} in ~/.aws/config.\n\n{msg}",
            asg.profile.as_deref().unwrap_or("default")
        )
    } else {
        msg.to_string()
    }
}

/// The group's running instances, oldest first.
pub async fn instances(env: &LoginEnv, asg: &Asg) -> AppResult<Vec<Instance>> {
    let mut cmd = tokio::process::Command::new("aws");
    cmd.env_clear().envs(env.vars.iter());
    cmd.args(describe_args(asg)).kill_on_drop(true);
    let out = tokio::time::timeout(LOOKUP_TIMEOUT, cmd.output())
        .await
        .map_err(|_| AppError::Invalid("the AWS CLI took too long to list the instances".into()))?
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::Invalid(
                "The AWS CLI (`aws`) isn't installed or isn't on your login shell's PATH. Install it and the Session Manager plugin (brew install awscli session-manager-plugin)."
                    .into(),
            ),
            _ => AppError::Invalid(format!("aws: {e}")),
        })?;
    if !out.status.success() {
        return Err(AppError::Invalid(lookup_error(
            asg,
            &String::from_utf8_lossy(&out.stderr),
        )));
    }
    let mut list: Vec<Instance> = serde_json::from_slice(&out.stdout)
        .map_err(|e| AppError::Invalid(format!("unexpected AWS CLI output: {e}")))?;
    list.sort_by(|a, b| a.launched.cmp(&b.launched).then(a.id.cmp(&b.id)));
    Ok(list)
}

/// A server's instances, or (`asg`, from the server form before it's
/// saved) those of a group.
#[tauri::command]
pub async fn asg_instances(
    state: State<'_, AppState>,
    server_id: Option<String>,
    asg: Option<Asg>,
) -> AppResult<Vec<Instance>> {
    let asg = match (asg, server_id) {
        (Some(a), _) => {
            if a.name.trim().is_empty() {
                return Err(AppError::Invalid(
                    "the Auto Scaling group's name is empty".into(),
                ));
            }
            a
        }
        (None, Some(id)) => asg_server(&state, &id)?
            .asg
            .ok_or_else(|| AppError::Invalid(format!("{id} isn't an Auto Scaling group")))?,
        (None, None) => return Err(AppError::Invalid("which group?".into())),
    };
    instances(state.env_ready().await, &asg).await
}

/// Profile names in ~/.aws/config and ~/.aws/credentials (for the server
/// form's suggestions). Only the section names are read.
#[tauri::command]
pub async fn aws_profiles() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for (file, prefixed) in [("config", true), ("credentials", false)] {
        let Ok(text) = std::fs::read_to_string(home.join(".aws").join(file)) else {
            continue;
        };
        out.extend(profile_names(&text, prefixed));
    }
    out.sort();
    out.dedup();
    out
}

/// `[profile x]` (config) / `[x]` (credentials) section names; `[default]`
/// in both. `[sso-session …]` and `[services …]` aren't profiles.
fn profile_names(text: &str, prefixed: bool) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.trim().strip_prefix('[')?.strip_suffix(']'))
        .filter_map(|s| {
            let s = s.trim();
            if s == "default" {
                Some(s.to_string())
            } else if prefixed {
                s.strip_prefix("profile ").map(|p| p.trim().to_string())
            } else {
                Some(s.to_string())
            }
        })
        .filter(|p| !p.is_empty())
        .collect()
}

/// The server, which must be an `asg:` one.
pub fn asg_server(state: &AppState, server_id: &str) -> AppResult<Server> {
    let server = state
        .config
        .config()
        .and_then(|c| c.server(server_id).cloned())
        .ok_or_else(|| AppError::NotFound(format!("server {server_id}")))?;
    if server.asg.is_none() {
        return Err(AppError::Invalid(format!(
            "{server_id} isn't an Auto Scaling group"
        )));
    }
    Ok(server)
}

/// What the session runs on the instance. A script goes base64-encoded, so
/// nothing in it needs quoting for Session Manager's parameters or the
/// remote `sh -c`; it runs as root through `sudo` unless `root: false`.
/// No script: a root login shell (`sudo -i`), or a login bash as
/// Session Manager's user.
pub fn remote(asg: &Asg, script: Option<&str>) -> String {
    match script {
        Some(s) => {
            // From the user's home, not the agent's folder (an app's
            // commands cd into the app themselves).
            let b64 =
                base64::engine::general_purpose::STANDARD.encode(format!("cd 2>/dev/null\n{s}"));
            let sudo = if asg.root { "sudo -H " } else { "" };
            format!("{sudo}bash -c \"$(echo {b64} | base64 -d)\"")
        }
        None if asg.root => "sudo -i".into(),
        None => "exec bash -l".into(),
    }
}

/// `aws ssm start-session` to `instance`, running `script` (else a shell).
pub fn session(
    env: &LoginEnv,
    asg: &Asg,
    instance: &str,
    script: Option<&str>,
) -> AppResult<CommandBuilder> {
    validate_instance(instance)?;
    let mut cmd = base_command(env, Some("aws"));
    cmd.args(["ssm", "start-session", "--target", instance]);
    cmd.args(aws_opts(asg));
    cmd.args([
        "--document-name",
        "AWS-StartInteractiveCommand",
        "--parameters",
    ]);
    cmd.arg(serde_json::json!({ "command": [remote(asg, script)] }).to_string());
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asg(root: bool) -> Asg {
        Asg {
            name: "shop-web-asg".into(),
            profile: Some("acme-staging".into()),
            region: Some("ap-southeast-1".into()),
            root,
        }
    }

    #[test]
    fn aws_profile_sections() {
        let config = "[default]\nregion=x\n[profile acme-staging]\nsso_session=s\n[sso-session s]\n[services y]\n";
        assert_eq!(profile_names(config, true), ["default", "acme-staging"]);
        assert_eq!(profile_names("[default]\n[ci]\n", false), ["default", "ci"]);
    }

    #[test]
    fn instance_ids() {
        assert!(validate_instance("i-0123456789abcdef0").is_ok());
        assert!(validate_instance("i-1234abcd").is_ok());
        assert!(validate_instance("i-xyz").is_err());
        assert!(validate_instance("-oProxyCommand=x").is_err());
    }

    #[test]
    fn describe_filters_by_group() {
        let a = describe_args(&asg(true));
        assert!(a.contains(&"Name=tag:aws:autoscaling:groupName,Values=shop-web-asg".to_string()));
        assert!(a.windows(2).any(|w| w == ["--profile", "acme-staging"]));
        assert!(a.windows(2).any(|w| w == ["--region", "ap-southeast-1"]));
    }

    #[test]
    fn remote_shell_and_script() {
        assert_eq!(remote(&asg(true), None), "sudo -i");
        assert_eq!(remote(&asg(false), None), "exec bash -l");
        let r = remote(&asg(true), Some("cd '/srv/app' && echo \"hi\"\n"));
        assert!(r.starts_with("sudo -H bash -c \"$(echo "), "{r}");
        assert!(!r.contains('\''), "{r}");
    }

    /// The encoded script comes back intact through a real `sh -c`.
    #[test]
    fn remote_script_round_trips_in_sh() {
        let script = "printf '%s|' \"a b\" 'c\"d' $((1+2))\n";
        let cmd = remote(&asg(false), Some(script));
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &cmd])
            .output()
            .expect("sh");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "a b|c\"d|3|");
    }

    #[test]
    fn expired_login_hint() {
        let m = lookup_error(
            &asg(true),
            "Error when retrieving token from sso: Token has expired and refresh failed",
        );
        assert!(m.contains("aws sso login --profile acme-staging"), "{m}");
    }

    #[test]
    fn parses_cli_output() {
        let json = r#"[{"id":"i-0bbb","name":"web","ip":"10.0.1.5","az":"ap-southeast-1a","launched":"2026-10-02T01:00:00+00:00"},{"id":"i-0aaa","name":null,"ip":null,"az":null,"launched":"2026-10-01T01:00:00+00:00"}]"#;
        let list: Vec<Instance> = serde_json::from_str(json).expect("parse");
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].name, None);
    }
}
