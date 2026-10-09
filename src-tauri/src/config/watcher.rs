//! Watch the config directory (editors save by rename, so watching the file
//! itself misses updates) and reload when servers.yaml changes.

use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

pub const CHANGED_EVENT: &str = "config://changed";

pub struct ConfigWatcher(#[allow(dead_code)] Debouncer<RecommendedWatcher, RecommendedCache>);

pub fn start(app: &AppHandle) -> Result<ConfigWatcher, String> {
    let dir = super::config_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let file_name = super::config_path().file_name().map(|n| n.to_os_string());
    let handle = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(200),
        None,
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let touches_config = events
                .iter()
                .flat_map(|e| e.paths.iter())
                .any(|p| p.file_name().map(|n| n.to_os_string()) == file_name);
            if touches_config {
                let snapshot = handle.state::<AppState>().config.reload();
                let _ = handle.emit(CHANGED_EVENT, snapshot);
            }
        },
    )
    .map_err(|e| e.to_string())?;
    debouncer
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    Ok(ConfigWatcher(debouncer))
}
