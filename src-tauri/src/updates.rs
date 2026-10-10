//! Check for updates: only when asked (menu / Settings), or at launch when
//! that's switched on. Asks GitHub for the latest release's `latest.json`;
//! the update file is verified with Kemudi's update key before it's
//! installed. Nothing else in Kemudi calls out.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    /// The newer version, if there is one.
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

fn err(e: impl std::fmt::Display) -> AppError {
    AppError::Invalid(format!("couldn't check for updates: {e}"))
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let update = app.updater().map_err(err)?.check().await.map_err(err)?;
    Ok(match update {
        Some(u) => UpdateInfo {
            current,
            version: Some(u.version.clone()),
            notes: u.body.clone(),
            date: u.date.map(|d| d.to_string()),
        },
        None => UpdateInfo {
            current,
            version: None,
            notes: None,
            date: None,
        },
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Progress {
    Downloading { done: u64, total: Option<u64> },
    Installing,
}

/// Download, verify and install the update, then restart Kemudi.
#[tauri::command]
pub async fn update_install(app: AppHandle, on_progress: Channel<Progress>) -> AppResult<()> {
    if cfg!(debug_assertions) {
        return Err(AppError::Invalid(
            "this is a development build; updates install in the released app".into(),
        ));
    }
    let Some(update) = app.updater().map_err(err)?.check().await.map_err(err)? else {
        return Err(AppError::Invalid("Kemudi is already up to date".into()));
    };
    let mut done = 0u64;
    let progress = on_progress.clone();
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = progress.send(Progress::Downloading { done, total });
            },
            move || {
                let _ = on_progress.send(Progress::Installing);
            },
        )
        .await
        .map_err(|e| AppError::Invalid(format!("the update didn't install: {e}")))?;
    app.restart();
}
