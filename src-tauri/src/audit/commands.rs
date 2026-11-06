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

/// When each app on a server last had a History row (app id → ms).
#[tauri::command]
pub async fn audit_app_activity(
    state: State<'_, AppState>,
    server_id: String,
) -> AppResult<std::collections::BTreeMap<String, i64>> {
    let log = state
        .audit
        .as_ref()
        .map_err(|e| AppError::Config(format!("audit log unavailable: {e}")))?;
    Ok(log
        .last_by_app(&server_id)
        .map_err(|e| AppError::Config(format!("audit log: {e}")))?
        .into_iter()
        .collect())
}
