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
    if asg.instances.is_empty() {
        a.push(format!(
            "Name=tag:aws:autoscaling:groupName,Values={}",
            asg.name
        ));
    }
    a.push("Name=instance-state-name,Values=running".into());
    if !asg.instances.is_empty() {
        a.push("--instance-ids".into());
        a.extend(asg.instances.iter().cloned());
    }
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
            if a.name.trim().is_empty() && a.instances.is_empty() {
                return Err(AppError::Invalid(
                    "give the Auto Scaling group's name or the instance ids".into(),
                ));
            }
            for i in &a.instances {
                validate_instance(i)?;
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub name: String,
    pub instances: u32,
}

/// The Auto Scaling groups a profile (and region) can see, for the server
/// form's Group field.
#[tauri::command]
pub async fn asg_groups(
    state: State<'_, AppState>,
    profile: Option<String>,
    region: Option<String>,
) -> AppResult<Vec<Group>> {
    let probe = Asg {
        name: String::new(),
        instances: Vec::new(),
        profile: profile.filter(|p| !p.trim().is_empty()),
        region: region.filter(|r| !r.trim().is_empty()),
        root: true,
    };
    let env = state.env_ready().await;
    let mut cmd = tokio::process::Command::new("aws");
    cmd.env_clear().envs(env.vars.iter());
    cmd.args([
        "autoscaling",
        "describe-auto-scaling-groups",
        "--query",
        "AutoScalingGroups[].{name: AutoScalingGroupName, instances: length(Instances)}",
        "--output",
        "json",
    ]);
    cmd.args(aws_opts(&probe)).kill_on_drop(true);
    let out = tokio::time::timeout(LOOKUP_TIMEOUT, cmd.output())
        .await
        .map_err(|_| AppError::Invalid("the AWS CLI took too long to list the groups".into()))?
        .map_err(|e| AppError::Invalid(format!("aws: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Invalid(lookup_error(
            &probe,
            &String::from_utf8_lossy(&out.stderr),
        )));
    }
    let mut groups: Vec<Group> = serde_json::from_slice(&out.stdout)
        .map_err(|e| AppError::Invalid(format!("unexpected AWS CLI output: {e}")))?;
    groups.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(groups)
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Database {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub engine: Option<String>,
    pub status: Option<String>,
    /// An Aurora cluster's endpoint (else one DB instance).
    #[serde(default)]
    pub cluster: bool,
}

async fn aws_json<T: serde::de::DeserializeOwned>(
    env: &LoginEnv,
    asg: &Asg,
    args: &[&str],
) -> AppResult<T> {
    let mut cmd = tokio::process::Command::new("aws");
    cmd.env_clear().envs(env.vars.iter());
    cmd.args(args)
        .args(["--output", "json"])
        .args(aws_opts(asg))
        .kill_on_drop(true);
    let out = tokio::time::timeout(LOOKUP_TIMEOUT, cmd.output())
        .await
        .map_err(|_| AppError::Invalid("the AWS CLI took too long".into()))?
        .map_err(|e| AppError::Invalid(format!("aws: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Invalid(lookup_error(
            asg,
            &String::from_utf8_lossy(&out.stderr),
        )));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| AppError::Invalid(format!("unexpected AWS CLI output: {e}")))
}

/// The RDS databases the server's profile (and region) can see: Aurora
/// clusters' writer endpoints, and DB instances outside a cluster.
#[tauri::command]
pub async fn rds_databases(
    state: State<'_, AppState>,
    server_id: String,
) -> AppResult<Vec<Database>> {
    let server = asg_server(&state, &server_id)?;
    let asg = server
        .asg
        .as_ref()
        .ok_or_else(|| AppError::Invalid(server_id.clone()))?;
    let env = state.env_ready().await;
    let mut dbs: Vec<Database> = aws_json(
        env,
        asg,
        &[
            "rds",
            "describe-db-instances",
            "--query",
            "DBInstances[?DBClusterIdentifier == null && Endpoint != null].{id: DBInstanceIdentifier, host: Endpoint.Address, port: Endpoint.Port, engine: Engine, status: DBInstanceStatus}",
        ],
    )
    .await?;
    // No Aurora (or no permission to list it): just the instances.
    if let Ok(clusters) = aws_json::<Vec<Database>>(
        env,
        asg,
        &[
            "rds",
            "describe-db-clusters",
            "--query",
            "DBClusters[].{id: DBClusterIdentifier, host: Endpoint, port: Port, engine: Engine, status: Status, cluster: `true`}",
        ],
    )
    .await
    {
        dbs.extend(clusters);
    }
    dbs.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(dbs)
}

/// A hostname (an RDS endpoint): letters, digits, dots and dashes.
fn valid_hostname(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('-')
        && h.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// `aws ssm start-session` forwarding `127.0.0.1:local` through `instance`
/// to `host:port` (a database the instance can reach).
pub fn forward(
    env: &LoginEnv,
    asg: &Asg,
    instance: &str,
    host: &str,
    port: u16,
    local: u16,
) -> AppResult<CommandBuilder> {
    validate_instance(instance)?;
    if !valid_hostname(host) {
        return Err(AppError::Invalid(format!("not a host name: {host:?}")));
    }
    if port == 0 || local == 0 {
        return Err(AppError::Invalid("ports must be 1–65535".into()));
    }
    let mut cmd = base_command(env, Some("aws"));
    cmd.args(["ssm", "start-session", "--target", instance]);
    cmd.args(aws_opts(asg));
    cmd.args([
        "--document-name",
        "AWS-StartPortForwardingSessionToRemoteHost",
        "--parameters",
    ]);
    cmd.arg(
        serde_json::json!({
            "host": [host],
            "portNumber": [port.to_string()],
            "localPortNumber": [local.to_string()],
        })
        .to_string(),
    );
    Ok(cmd)
}

/// What `get-command-invocation` reports.
#[derive(Debug, Deserialize)]
struct Invocation {
    #[serde(rename = "Status")]
    status: String,
    #[serde(rename = "StandardOutputContent", default)]
    stdout: String,
    #[serde(rename = "StandardErrorContent", default)]
    stderr: String,
}

/// Session Manager keeps this much of a command's output.
const OUTPUT_LIMIT: usize = 24_000;

/// The `commands` for AWS-RunShellScript: the script, base64-encoded so no
/// quoting can break it, fed to `sh -s` as ssh's `run_for` does.
fn run_shell_commands(script: &str) -> serde_json::Value {
    let b64 = base64::engine::general_purpose::STANDARD.encode(script);
    serde_json::json!({ "commands": [format!("echo {b64} | base64 -d | sh -s")] })
}

/// Run a script on one of the server's instances (the first running one;
/// a group's are alike) with `aws ssm send-command` (AWS-RunShellScript, as
/// root) and return its output: `monitor::run_for` for an AWS server.
pub async fn run_script(env: &LoginEnv, asg: &Asg, script: &str, secs: u64) -> AppResult<String> {
    let first = instances(env, asg)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Invalid("no running instances".into()))?;
    let params = run_shell_commands(script).to_string();
    let timeout = secs.max(30).to_string();
    let id: String = aws_json(
        env,
        asg,
        &[
            "ssm",
            "send-command",
            "--instance-ids",
            &first.id,
            "--document-name",
            "AWS-RunShellScript",
            "--timeout-seconds",
            &timeout,
            "--parameters",
            &params,
            "--query",
            "Command.CommandId",
        ],
    )
    .await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(secs + 10);
    loop {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        // Just after sending, the invocation may not exist yet.
        let inv: Result<Invocation, _> = aws_json(
            env,
            asg,
            &[
                "ssm",
                "get-command-invocation",
                "--command-id",
                &id,
                "--instance-id",
                &first.id,
            ],
        )
        .await;
        match inv {
            Ok(inv) if matches!(inv.status.as_str(), "Pending" | "InProgress" | "Delayed") => {}
            Ok(inv) => {
                if inv.stdout.len() >= OUTPUT_LIMIT {
                    return Err(AppError::Invalid(
                        "the output is longer than Session Manager keeps (24 KB)".into(),
                    ));
                }
                if inv.status == "Success" || inv.stdout.contains("@@") {
                    return Ok(inv.stdout);
                }
                return Err(AppError::Invalid(format!(
                    "{} on {}: {}",
                    inv.status,
                    first.id,
                    inv.stderr.trim()
                )));
            }
            Err(e) if !e.to_string().contains("InvocationDoesNotExist") => return Err(e),
            Err(_) => {}
        }
        if std::time::Instant::now() > deadline {
            return Err(AppError::Invalid(format!(
                "no answer from {} within {secs} s",
                first.id
            )));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command AWS-RunShellScript runs gives back the script intact.
    #[test]
    fn run_shell_command_round_trips() {
        let script = "printf '%s|' \"a b\" 'c\"d'\necho \"@@x\"\n";
        let v = run_shell_commands(script);
        let cmd = v["commands"][0].as_str().expect("command");
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", cmd])
            .output()
            .expect("sh");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "a b|c\"d|@@x\n");
    }

    #[test]
    fn fixed_instances_are_described_by_id() {
        let mut a = asg(true);
        a.name.clear();
        a.instances = vec!["i-0123456789abcdef0".into()];
        let args = describe_args(&a);
        assert!(!args.iter().any(|x| x.contains("autoscaling")), "{args:?}");
        assert!(args
            .windows(2)
            .any(|w| w == ["--instance-ids", "i-0123456789abcdef0"]));
    }

    #[test]
    fn hostnames() {
        assert!(valid_hostname(
            "shop-db.abc123.ap-southeast-1.rds.amazonaws.com"
        ));
        assert!(!valid_hostname("-oProxy"));
        assert!(!valid_hostname("a b"));
        assert!(!valid_hostname(""));
    }

    #[test]
    fn database_listing_parses() {
        let json = r#"[{"id":"shop-db","host":"shop-db.x.rds.amazonaws.com","port":3306,"engine":"mysql","status":"available"}]"#;
        let dbs: Vec<Database> = serde_json::from_str(json).expect("parse");
        assert!(!dbs[0].cluster && dbs[0].port == 3306);
    }

    fn asg(root: bool) -> Asg {
        Asg {
            name: "shop-web-asg".into(),
            instances: Vec::new(),
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
