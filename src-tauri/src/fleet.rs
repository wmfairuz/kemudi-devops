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
pub fn aws_opts(asg: &Asg) -> Vec<String> {
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
    // A saved server's list (pickers, switches): reused for a minute, like
    // the scripts that follow it. A group from the form: asked afresh.
    let cached = asg.is_none();
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
    if cached {
        instances_cached(state.env_ready().await, &asg).await
    } else {
        instances(state.env_ready().await, &asg).await
    }
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

/// Which instances a script runs on.
#[derive(Debug, Clone, Copy)]
pub enum Which<'a> {
    /// The first running one (the oldest; the same one while the list is
    /// cached): reading.
    First,
    One(&'a str),
    /// Every running one: changes, so a group's instances stay alike.
    All,
}

type Cache =
    std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Vec<Instance>)>>;
static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
const CACHE_FOR: Duration = Duration::from_secs(60);

/// `instances`, reused for a minute: scripts in a row (list, then copy,
/// then clean up) land on the same instance, and aren't each a lookup.
pub async fn instances_cached(env: &LoginEnv, asg: &Asg) -> AppResult<Vec<Instance>> {
    let key = format!("{asg:?}");
    let cache = CACHE.get_or_init(Default::default);
    if let Some((at, list)) = cache.lock().ok().and_then(|c| c.get(&key).cloned()) {
        if at.elapsed() < CACHE_FOR && !list.is_empty() {
            return Ok(list);
        }
    }
    let list = instances(env, asg).await?;
    if let Ok(mut c) = cache.lock() {
        c.insert(key, (std::time::Instant::now(), list.clone()));
    }
    Ok(list)
}

async fn targets(env: &LoginEnv, asg: &Asg, which: Which<'_>) -> AppResult<Vec<String>> {
    if let Which::One(id) = which {
        validate_instance(id)?;
        return Ok(vec![id.to_string()]);
    }
    let list = instances_cached(env, asg).await?;
    let ids: Vec<String> = match which {
        Which::All => list.into_iter().map(|i| i.id).collect(),
        _ => list.into_iter().take(1).map(|i| i.id).collect(),
    };
    if ids.is_empty() {
        return Err(AppError::Invalid("no running instances".into()));
    }
    Ok(ids)
}

/// Run a script with `aws ssm send-command` (AWS-RunShellScript, as root)
/// and return its output: `monitor::run_for` for an AWS server. On several
/// instances, the first one's output, once all of them succeeded.
pub async fn run_script(
    env: &LoginEnv,
    asg: &Asg,
    script: &str,
    secs: u64,
    which: Which<'_>,
) -> AppResult<String> {
    let ids = targets(env, asg, which).await?;
    let params = run_shell_commands(script).to_string();
    let timeout = secs.max(30).to_string();
    let mut args: Vec<&str> = vec!["ssm", "send-command", "--instance-ids"];
    args.extend(ids.iter().map(String::as_str));
    args.extend([
        "--document-name",
        "AWS-RunShellScript",
        "--timeout-seconds",
        &timeout,
        "--parameters",
        &params,
        "--query",
        "Command.CommandId",
    ]);
    let id: String = aws_json(env, asg, &args).await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(secs + 10);
    let mut outputs: Vec<Option<String>> = vec![None; ids.len()];
    let mut wait = Duration::from_millis(500);
    loop {
        tokio::time::sleep(wait).await;
        wait = Duration::from_millis(900);
        for (k, instance) in ids.iter().enumerate() {
            if outputs[k].is_some() {
                continue;
            }
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
                    instance,
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
                    if inv.status != "Success" && !inv.stdout.contains("@@") {
                        return Err(AppError::Invalid(format!(
                            "{} on {instance}: {}",
                            inv.status,
                            inv.stderr.trim()
                        )));
                    }
                    outputs[k] = Some(inv.stdout);
                }
                Err(e) if !e.to_string().contains("InvocationDoesNotExist") => return Err(e),
                Err(_) => {}
            }
        }
        if outputs.iter().all(Option::is_some) {
            return Ok(outputs.into_iter().next().flatten().unwrap_or_default());
        }
        if std::time::Instant::now() > deadline {
            return Err(AppError::Invalid(format!(
                "no answer from {} within {secs} s",
                ids.join(", ")
            )));
        }
    }
}

/// A file's bytes from the first instance, streamed through a Session
/// Manager session (base64 between markers): downloads, which can be far
/// bigger than send-command's output.
pub async fn read_file(env: &LoginEnv, asg: &Asg, path: &str) -> AppResult<Vec<u8>> {
    let first = targets(env, asg, Which::First).await?.remove(0);
    let script = format!(
        "f={}\necho @@KB; base64 -w0 -- \"$f\" 2>/dev/null || echo @@KFAIL; echo; echo @@KE\n",
        crate::actions::render::shell_quote(path)
    );
    let mut cmd = tokio::process::Command::new("aws");
    cmd.env_clear().envs(env.vars.iter());
    cmd.args(["ssm", "start-session", "--target", &first]);
    cmd.args(aws_opts(asg));
    cmd.args([
        "--document-name",
        "AWS-StartInteractiveCommand",
        "--parameters",
    ]);
    cmd.arg(serde_json::json!({ "command": [remote(asg, Some(&script))] }).to_string());
    // Stdin stays open: at end of input the plugin closes the session, maybe
    // before all of the file has arrived.
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Invalid(format!("aws: {e}")))?;
    let _stdin = child.stdin.take();
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Invalid("aws: no output".into()))?;
    let collect = async {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = stdout.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            // Done once the end marker is in (allowing for a split read).
            let tail = &buf[buf.len().saturating_sub(n + 8)..];
            if tail.windows(4).any(|w| w == b"@@KE") {
                break;
            }
        }
        buf
    };
    let out = tokio::time::timeout(Duration::from_secs(900), collect)
        .await
        .map_err(|_| AppError::Invalid("the download took over 15 min: stopped".into()))?;
    let _ = child.kill().await;
    let text = String::from_utf8_lossy(&out);
    let body = between(&text, "@@KB", "@@KE").ok_or_else(|| {
        AppError::Invalid(format!(
            "no file came back from {first}: {}",
            text.trim().lines().last().unwrap_or_default()
        ))
    })?;
    if body.contains("@@KFAIL") {
        return Err(AppError::Invalid(format!(
            "couldn't read {path} on {first}"
        )));
    }
    let clean: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(clean)
        .map_err(|e| AppError::Invalid(format!("the download came back damaged: {e}")))
}

/// The text between the line `from` and the line `to`.
fn between<'t>(text: &'t str, from: &str, to: &str) -> Option<&'t str> {
    let start = text
        .find(&format!("{from}\r"))
        .or_else(|| text.find(&format!("{from}\n")))?
        + from.len();
    let end = text[start..].find(to)? + start;
    Some(&text[start..end])
}

/// Write `data` to `path` on every instance (a temp file an upload then
/// moves into place), in pieces small enough for send-command.
pub async fn write_file_all(env: &LoginEnv, asg: &Asg, data: &[u8], path: &str) -> AppResult<()> {
    const PIECE: usize = 24_000;
    let q = crate::actions::render::shell_quote(path);
    let b64 = format!("{path}.b64");
    let qb = crate::actions::render::shell_quote(&b64);
    run_script(
        env,
        asg,
        &format!("rm -f {q} {qb}; : > {qb}; chmod 600 {qb}\n"),
        60,
        Which::All,
    )
    .await?;
    for piece in data.chunks(PIECE) {
        let enc = base64::engine::general_purpose::STANDARD.encode(piece);
        run_script(
            env,
            asg,
            &format!("printf '%s\\n' '{enc}' >> {qb}\n"),
            60,
            Which::All,
        )
        .await?;
    }
    let out = run_script(
        env,
        asg,
        &format!("base64 -d {qb} > {q} && chmod 600 {q} && echo @@ok; rm -f {qb}\n"),
        60,
        Which::All,
    )
    .await?;
    if out.lines().any(|l| l.trim() == "@@ok") {
        Ok(())
    } else {
        Err(AppError::Invalid("the upload didn't arrive whole".into()))
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
    fn between_markers() {
        let out = "Starting session…\r\n@@KB\r\naGk=\r\n@@KE\r\n";
        assert_eq!(between(out, "@@KB", "@@KE").map(str::trim), Some("aGk="));
        assert_eq!(between("nothing", "@@KB", "@@KE"), None);
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

/// Against a real group: KEMUDI_ASG_TEST="group profile" cargo test
/// live_transfer -- --ignored. Writes /tmp/kemudi-live-test on every
/// instance, reads it back, removes it.
#[cfg(test)]
mod live {
    use super::*;

    #[test]
    #[ignore]
    fn live_transfer() {
        let Ok(spec) = std::env::var("KEMUDI_ASG_TEST") else {
            return;
        };
        let mut parts = spec.split_whitespace();
        let asg = Asg {
            name: parts.next().unwrap_or_default().into(),
            instances: Vec::new(),
            profile: parts.next().map(String::from),
            region: None,
            root: true,
        };
        let env = LoginEnv::capture();
        let data: Vec<u8> = (0..60_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        rt.block_on(async {
            let path = "/tmp/kemudi-live-test";
            write_file_all(&env, &asg, &data, path)
                .await
                .expect("write");
            let back = read_file(&env, &asg, path).await.expect("read");
            assert_eq!(back, data, "round trip");
            let all = run_script(
                &env,
                &asg,
                &format!("ls -l {path} | wc -l; rm -f {path}\n"),
                30,
                Which::All,
            )
            .await
            .expect("cleanup");
            println!("cleanup: {all}");
        });
    }
}
