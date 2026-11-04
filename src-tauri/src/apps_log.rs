//! What happened to a server's apps, for the Apps section's numbers: when
//! Discover last looked (and how many new ones it found), and apps added or
//! removed through Kemudi (by hand, Discover or New app). Kept on this Mac
//! in `apps-log.json` in the data dir; an app added by editing servers.yaml
//! isn't in it. Nothing secret: ids, names and times.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// Kept per server (older ones are dropped).
const MAX_EVENTS: usize = 200;
const MAX_DISCOVERS: usize = 20;

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverRun {
    /// Unix seconds.
    pub at: u64,
    /// Laravel apps found that weren't in Kemudi yet.
    pub found: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    Added,
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppEvent {
    pub at: u64,
    pub kind: EventKind,
    pub app_id: String,
    /// "discover", "new app" or none (the app form).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerLog {
    #[serde(default)]
    pub discovers: Vec<DiscoverRun>,
    #[serde(default)]
    pub events: Vec<AppEvent>,
    /// When this server's log started (the numbers count from then).
    #[serde(default)]
    pub since: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LogFile {
    #[serde(default)]
    servers: BTreeMap<String, ServerLog>,
}

fn path() -> Option<PathBuf> {
    crate::data_dir().map(|d| d.join("apps-log.json"))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn load(p: &PathBuf) -> LogFile {
    std::fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Changes one server's log and writes the file (atomically). Failing to
/// write is only logged: it's a record, never in the way of the change.
fn update(server_id: &str, f: impl FnOnce(&mut ServerLog)) {
    let Some(p) = path() else { return };
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load(&p);
    let log = file.servers.entry(server_id.to_string()).or_default();
    if log.since == 0 {
        log.since = now();
    }
    f(log);
    trim(log);
    let tmp = p.with_extension("json.tmp");
    let wrote = serde_json::to_vec_pretty(&file)
        .map_err(|e| e.to_string())
        .and_then(|b| std::fs::write(&tmp, b).map_err(|e| e.to_string()))
        .and_then(|()| std::fs::rename(&tmp, &p).map_err(|e| e.to_string()));
    if let Err(e) = wrote {
        eprintln!("kemudi: can't write {}: {e}", p.display());
    }
}

fn trim(log: &mut ServerLog) {
    if log.events.len() > MAX_EVENTS {
        log.events.drain(..log.events.len() - MAX_EVENTS);
    }
    if log.discovers.len() > MAX_DISCOVERS {
        log.discovers.drain(..log.discovers.len() - MAX_DISCOVERS);
    }
}

fn clean_via(via: Option<&str>) -> Option<String> {
    via.map(str::trim)
        .filter(|v| matches!(*v, "discover" | "new app"))
        .map(str::to_string)
}

pub fn discovered(server_id: &str, found: usize) {
    update(server_id, |l| l.discovers.push(DiscoverRun { at: now(), found }));
}

pub fn added(server_id: &str, app_id: &str, via: Option<&str>) {
    let via = clean_via(via);
    update(server_id, |l| {
        l.events.push(AppEvent { at: now(), kind: EventKind::Added, app_id: app_id.to_string(), via })
    });
}

pub fn removed(server_id: &str, app_id: &str) {
    update(server_id, |l| {
        l.events.push(AppEvent { at: now(), kind: EventKind::Removed, app_id: app_id.to_string(), via: None })
    });
}

/// A server's log (empty when nothing's been recorded).
#[tauri::command]
pub async fn apps_log(server_id: String) -> AppResult<ServerLog> {
    Ok(tauri::async_runtime::spawn_blocking(move || {
        path()
            .map(|p| load(&p).servers.remove(&server_id).unwrap_or_default())
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_and_reads_old_files() {
        let mut l = ServerLog::default();
        for i in 0..(MAX_EVENTS + 5) {
            l.events.push(AppEvent { at: i as u64, kind: EventKind::Added, app_id: "a".into(), via: None });
        }
        trim(&mut l);
        assert_eq!(l.events.len(), MAX_EVENTS);
        assert_eq!(l.events[0].at, 5);
        let f: LogFile = serde_json::from_str(r#"{"servers":{"web":{"events":[{"at":1,"kind":"added","appId":"shop"}]}}}"#).unwrap();
        assert_eq!(f.servers["web"].events[0].via, None);
        assert_eq!(clean_via(Some("discover")).as_deref(), Some("discover"));
        assert_eq!(clean_via(Some("rm -rf")), None);
    }
}
