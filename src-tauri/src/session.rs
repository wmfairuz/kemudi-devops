//! Open tabs, remembered across restarts (data_dir()/session.json).
//! The frontend owns the shape; this only stores it. Restoring never re-runs
//! an action: action tabs come back as plain shells.

use crate::error::{AppError, AppResult};

fn path() -> AppResult<std::path::PathBuf> {
    crate::data_dir()
        .map(|d| d.join("session.json"))
        .ok_or_else(|| AppError::Config("no Application Support directory".into()))
}

#[tauri::command]
pub async fn session_load() -> AppResult<Option<serde_json::Value>> {
    let path = path()?;
    match std::fs::read_to_string(&path) {
        // A corrupt file is not worth an error dialog: start fresh.
        Ok(text) => Ok(serde_json::from_str(&text).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub async fn session_save(session: serde_json::Value) -> AppResult<()> {
    let path = path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&session).map_err(|e| AppError::Invalid(e.to_string()))?,
    )?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
