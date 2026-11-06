use std::collections::BTreeMap;

use tauri::State;

use super::{Page, Query};
use crate::error::{AppError, AppResult};
use crate::AppState;

#[tauri::command]
pub async fn audit_list(state: State<'_, AppState>, query: Query) -> AppResult<Page> {
    let log = state
        .audit
        .as_ref()
        .map_err(|e| AppError::Config(format!("audit log unavailable: {e}")))?;
    log.list(&query)
        .map_err(|e| AppError::Config(format!("audit log: {e}")))
}

/// When each app last had a History row (server id → app id → ms).
#[tauri::command]
pub async fn audit_app_activity(
    state: State<'_, AppState>,
) -> AppResult<BTreeMap<String, BTreeMap<String, i64>>> {
    let log = state
        .audit
        .as_ref()
        .map_err(|e| AppError::Config(format!("audit log unavailable: {e}")))?;
    let mut out: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for (server, app, at) in log
        .last_by_app()
        .map_err(|e| AppError::Config(format!("audit log: {e}")))?
    {
        out.entry(server).or_default().insert(app, at);
    }
    Ok(out)
}
