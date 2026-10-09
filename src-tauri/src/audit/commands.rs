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
