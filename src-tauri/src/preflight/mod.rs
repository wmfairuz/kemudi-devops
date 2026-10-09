//! Reachability: a 2s TCP probe per server, used for the sidebar status dots
//! and as the VPN gate before any SSH action.
//!
//! Probe target, in order: `vpn_check` (VPN servers), `check`, else what
//! `ssh -G <alias>` resolves (the first ProxyJump hop when there is one).
//! The only network traffic is these TCP connects to hosts in the config.

pub mod commands;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;

use crate::config::schema::{Server, Vpn};
use crate::env::LoginEnv;
use crate::AppState;

pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
pub const POLL_INTERVAL: Duration = Duration::from_secs(30);
const MAX_CONCURRENT: usize = 8;
pub const STATUS_EVENT: &str = "status://changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Up,
    Down,
    Unknown,
    Checking,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub server_id: String,
    pub state: State,
    /// `host:port` that was probed.
    pub target: Option<String>,
    /// How the target was chosen: vpn_check | check | ssh | jump.
    pub via: Option<&'static str>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub via: &'static str,
}

/// What `ssh -G` tells us about an alias.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshResolved {
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub proxyjump: Option<String>,
    pub proxycommand: Option<String>,
}

pub fn parse_ssh_g(output: &str) -> SshResolved {
    let mut r = SshResolved::default();
    for line in output.lines() {
        let Some((key, value)) = line.split_once(' ') else {
            continue;
        };
        let value = value.trim();
        let set = (!value.is_empty() && value != "none").then(|| value.to_string());
        match key {
            "hostname" => r.hostname = set,
            "user" => r.user = set,
            "port" => r.port = value.parse().ok(),
            "proxyjump" => r.proxyjump = set,
            "proxycommand" => r.proxycommand = set,
            _ => {}
        }
    }
    r
}

/// First hop of a ProxyJump spec: `[ssh://][user@]host[:port][,next…]`.
pub fn first_jump(spec: &str) -> Option<(String, Option<u16>)> {
    let hop = spec.split(',').next()?.trim();
    let hop = hop.strip_prefix("ssh://").unwrap_or(hop);
    let hop = hop.rsplit_once('@').map_or(hop, |(_, h)| h);
    if hop.is_empty() {
        return None;
    }
    match hop.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => Some((h.to_string(), p.parse().ok())),
        _ => Some((hop.to_string(), None)),
    }
}

pub async fn ssh_g(alias: &str, env: &LoginEnv) -> Result<SshResolved, String> {
    crate::ssh::validate_host(alias).map_err(|e| e.to_string())?;
    let out = tokio::time::timeout(
        PROBE_TIMEOUT,
        tokio::process::Command::new("ssh")
            .arg("-G")
            .arg(alias)
            .env_clear()
            .envs(&env.vars)
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "ssh -G timed out".to_string())?
    .map_err(|e| format!("ssh -G: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(parse_ssh_g(&String::from_utf8_lossy(&out.stdout)))
}

/// Where to probe for this server; `Ok(None)` when it can't be probed
/// directly (a ProxyCommand we can't follow).
pub async fn resolve_target(server: &Server, env: &LoginEnv) -> Result<Option<Target>, String> {
    if server.vpn != Vpn::None {
        if let Some(c) = &server.vpn_check {
            return Ok(Some(Target {
                host: c.host.clone(),
                port: c.port,
                via: "vpn_check",
            }));
        }
    }
    if let Some(c) = &server.check {
        return Ok(Some(Target {
            host: c.host.clone(),
            port: c.port,
            via: "check",
        }));
    }
    let r = ssh_g(&server.host, env).await?;
    if let Some(jump) = r.proxyjump.as_deref().and_then(first_jump) {
        let (alias, port) = jump;
        let j = ssh_g(&alias, env).await?;
        return Ok(Some(Target {
            host: j.hostname.unwrap_or(alias),
            port: port.or(j.port).unwrap_or(22),
            via: "jump",
        }));
    }
    if r.proxycommand.is_some() {
        return Ok(None);
    }
    Ok(r.hostname.map(|host| Target {
        host,
        port: r.port.unwrap_or(22),
        via: "ssh",
    }))
}

/// TCP connect with the 2s budget (DNS included). Ok(latency ms).
pub async fn probe(host: &str, port: u16) -> Result<u64, String> {
    let started = Instant::now();
    match tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect((host, port))).await {
        Ok(Ok(_stream)) => Ok(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!("timed out ({}s)", PROBE_TIMEOUT.as_secs())),
    }
}

pub async fn check_server(server: &Server, env: &LoginEnv) -> Status {
    let mut status = Status {
        server_id: server.id.clone(),
        state: State::Unknown,
        target: None,
        via: None,
        latency_ms: None,
        error: None,
        checked_at: Some(crate::util::local_hms()),
    };
    match resolve_target(server, env).await {
        Err(e) => status.error = Some(e),
        Ok(None) => status.error = Some("reached through a ProxyCommand; not probed".into()),
        Ok(Some(t)) => {
            status.target = Some(format!("{}:{}", t.host, t.port));
            status.via = Some(t.via);
            match probe(&t.host, t.port).await {
                Ok(ms) => {
                    status.state = State::Up;
                    status.latency_ms = Some(ms);
                }
                Err(e) => {
                    status.state = State::Down;
                    status.error = Some(e);
                }
            }
        }
    }
    status
}

#[derive(Default)]
pub struct StatusBoard {
    map: Mutex<HashMap<String, Status>>,
}

impl StatusBoard {
    pub fn all(&self) -> Vec<Status> {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    fn set(&self, s: Status) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(s.server_id.clone(), s);
    }

    fn mark_checking(&self, id: &str) -> Status {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(id.to_string()).or_insert_with(|| Status {
            server_id: id.to_string(),
            state: State::Unknown,
            target: None,
            via: None,
            latency_ms: None,
            error: None,
            checked_at: None,
        });
        entry.state = State::Checking;
        entry.clone()
    }

    /// Drop servers that are no longer in the config.
    fn retain(&self, ids: &[String]) {
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|k, _| ids.contains(k));
    }
}

/// Probe the given servers (all when `only` is None), emitting a
/// `status://changed` event per server as results arrive.
pub async fn refresh(app: &AppHandle, only: Option<&[String]>) -> Vec<Status> {
    let state = app.state::<AppState>();
    let Some(config) = state.config.config() else {
        return Vec::new();
    };
    let all_ids: Vec<String> = config.servers.iter().map(|s| s.id.clone()).collect();
    state.status.retain(&all_ids);
    let servers: Vec<Server> = config
        .servers
        .into_iter()
        .filter(|s| only.is_none_or(|ids| ids.contains(&s.id)))
        .collect();
    for s in &servers {
        let _ = app.emit(STATUS_EVENT, state.status.mark_checking(&s.id));
    }
    let limit = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut tasks = tokio::task::JoinSet::new();
    for server in servers {
        let app = app.clone();
        let limit = limit.clone();
        tasks.spawn(async move {
            let _permit = limit.acquire_owned().await.ok();
            let state = app.state::<AppState>();
            let status = check_server(&server, state.env_ready().await).await;
            state.status.set(status.clone());
            let _ = app.emit(STATUS_EVENT, status.clone());
            status
        });
    }
    let mut out = Vec::new();
    while let Some(res) = tasks.join_next().await {
        if let Ok(s) = res {
            out.push(s);
        }
    }
    out
}

pub fn start_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            refresh(&app, None).await;
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_g() {
        let out = "user deploy\nhostname 10.0.1.13\nport 2222\nproxyjump none\nproxycommand none\nidentityfile ~/.ssh/id_ed25519\n";
        assert_eq!(
            parse_ssh_g(out),
            SshResolved {
                hostname: Some("10.0.1.13".into()),
                user: Some("deploy".into()),
                port: Some(2222),
                proxyjump: None,
                proxycommand: None
            }
        );
        let jumpy =
            parse_ssh_g("hostname app.internal\nport 22\nproxyjump ops@bastion:2200,inner\n");
        assert_eq!(jumpy.proxyjump.as_deref(), Some("ops@bastion:2200,inner"));
    }

    #[test]
    fn jump_hops() {
        assert_eq!(first_jump("bastion"), Some(("bastion".into(), None)));
        assert_eq!(
            first_jump("ops@bastion:2200,inner"),
            Some(("bastion".into(), Some(2200)))
        );
        assert_eq!(
            first_jump("ssh://ops@bastion:2201"),
            Some(("bastion".into(), Some(2201)))
        );
        assert_eq!(first_jump(""), None);
    }

    #[tokio::test]
    async fn probe_up_and_down() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert!(probe("127.0.0.1", port).await.is_ok());
        // A port that's bound but not listening refuses connections. Keeping
        // it bound matters: a freed port can be picked as the probe's own
        // source port, and that self-connect "succeeds".
        let closed = tokio::net::TcpSocket::new_v4().expect("socket");
        closed
            .bind("127.0.0.1:0".parse().expect("addr"))
            .expect("bind");
        let closed_port = closed.local_addr().expect("addr").port();
        assert!(
            probe("127.0.0.1", closed_port).await.is_err(),
            "closed port is down"
        );
    }
}
