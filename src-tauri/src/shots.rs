//! Pictures of apps: the front page of an app's URL, taken by a Chromium
//! browser on this Mac (Chrome, Edge, Chromium or Brave) running headless,
//! shrunk with `sips` and kept in the data dir (`shots/`). Only when asked:
//! the Apps section in Pictures view takes the missing and old ones. The
//! browser gets a profile of its own (no cookies or logins of yours), so an
//! app behind basic auth or a login shows that page.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::remote_files::{lookup, sha_hex};
use crate::AppState;

const BROWSERS: &[&str] = &[
    "Google Chrome.app/Contents/MacOS/Google Chrome",
    "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "Chromium.app/Contents/MacOS/Chromium",
    "Brave Browser.app/Contents/MacOS/Brave Browser",
];

/// One browser at a time (they share a profile, and it's background work).
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// `data:image/jpeg;base64,…`
    pub data: String,
    /// When it was taken (Unix seconds).
    pub at: u64,
    /// The URL it shows.
    pub url: String,
}

fn browser() -> Option<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
        .iter()
        .flat_map(|r| BROWSERS.iter().map(move |b| r.join(b)))
        .find(|p| p.is_file())
}

/// Only plain http(s) URLs (never something the browser reads as a flag).
fn valid_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn safe(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect()
}

fn shots_dir() -> AppResult<PathBuf> {
    crate::data_dir()
        .map(|d| d.join("shots"))
        .ok_or_else(|| AppError::Invalid("no Application Support directory".into()))
}

/// `shots/<server>/<app>-<hash of the URL>.jpg`: a new URL, a new picture.
fn file_for(dir: &Path, server_id: &str, app_id: &str, url: &str) -> PathBuf {
    let h = sha_hex(url.as_bytes());
    dir.join(safe(server_id))
        .join(format!("{}-{}.jpg", safe(app_id), &h[..12]))
}

fn read(path: &Path, url: &str) -> Option<Shot> {
    let bytes = std::fs::read(path).ok()?;
    let at = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    Some(Shot {
        data: format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        at,
        url: url.to_string(),
    })
}

fn app_url(state: &AppState, server_id: &str, app_id: &str) -> AppResult<Option<String>> {
    let server = lookup(state, server_id)?;
    let app = server
        .app(app_id)
        .ok_or_else(|| AppError::NotFound(format!("app `{app_id}` isn't on {server_id}")))?;
    Ok(app.url.clone().filter(|u| valid_url(u)))
}

/// The picture of an app kept from before, if any (nothing is taken).
#[tauri::command]
pub async fn app_shot(state: State<'_, AppState>, server_id: String, app_id: String) -> AppResult<Option<Shot>> {
    let Some(url) = app_url(&state, &server_id, &app_id)? else {
        return Ok(None);
    };
    let path = file_for(&shots_dir()?, &server_id, &app_id, &url);
    Ok(tauri::async_runtime::spawn_blocking(move || read(&path, &url))
        .await
        .ok()
        .flatten())
}

/// Takes a new picture of an app's URL (and forgets the older ones).
#[tauri::command]
pub async fn app_shot_take(state: State<'_, AppState>, server_id: String, app_id: String) -> AppResult<Shot> {
    let url = app_url(&state, &server_id, &app_id)?
        .ok_or_else(|| AppError::Invalid("the app has no URL (http or https) to take a picture of".into()))?;
    let exe = browser().ok_or_else(|| {
        AppError::Invalid("taking pictures needs Chrome, Edge, Chromium or Brave on this Mac".into())
    })?;
    let dir = shots_dir()?;
    let target = file_for(&dir, &server_id, &app_id, &url);
    let folder = target.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.clone());
    std::fs::create_dir_all(&folder).map_err(|e| AppError::Invalid(format!("can't make {}: {e}", folder.display())))?;

    let _one = LOCK.lock().await;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let png = dir.join(format!(".take-{stamp}.png"));
    let jpg = dir.join(format!(".take-{stamp}.jpg"));
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.arg("--headless=new")
        .arg(format!("--user-data-dir={}", dir.join("browser-profile").display()))
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-sync",
            "--disable-default-apps",
            "--disable-background-networking",
            "--disable-component-update",
            "--mute-audio",
            "--hide-scrollbars",
            // Only ever a picture, in a profile of its own: a staging or
            // Herd certificate this profile doesn't trust still loads.
            "--ignore-certificate-errors",
            "--window-size=1280,800",
            "--virtual-time-budget=6000",
        ])
        .arg(format!("--screenshot={}", png.display()))
        .arg(&url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let ran = tokio::time::timeout(Duration::from_secs(45), async { cmd.status().await }).await;
    let cleanup = |p: &Path| {
        let _ = std::fs::remove_file(p);
    };
    match ran {
        Err(_) => {
            cleanup(&png);
            return Err(AppError::Invalid(format!("{url} didn't load within 45 s")));
        }
        Ok(Err(e)) => return Err(AppError::Invalid(format!("couldn't start {}: {e}", exe.display()))),
        Ok(Ok(_)) => {}
    }
    if !png.is_file() {
        return Err(AppError::Invalid(format!("the browser took no picture of {url} (is it reachable from this Mac, and not behind basic auth?)")));
    }
    // 1280×800 → 800×500 JPEG: small enough to keep many.
    let sips = tokio::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg", "-s", "formatOptions", "72", "-Z", "800"])
        .arg(&png)
        .arg("--out")
        .arg(&jpg)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
    cleanup(&png);
    if !matches!(sips, Ok(s) if s.success()) || !jpg.is_file() {
        cleanup(&jpg);
        return Err(AppError::Invalid("couldn't shrink the picture (sips)".into()));
    }
    // Older pictures of this app (another URL) go.
    let prefix = format!("{}-", safe(&app_id));
    if let Ok(list) = std::fs::read_dir(&folder) {
        for e in list.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && name.ends_with(".jpg") && name.len() == prefix.len() + 16 {
                cleanup(&e.path());
            }
        }
    }
    std::fs::rename(&jpg, &target).map_err(|e| {
        cleanup(&jpg);
        AppError::Invalid(format!("can't keep the picture: {e}"))
    })?;
    read(&target, &url).ok_or_else(|| AppError::Invalid("the picture went missing".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_files() {
        assert!(valid_url("https://shop.example.com/"));
        assert!(!valid_url("--remote-debugging-port=1") && !valid_url("https://a b") && !valid_url("file:///etc/passwd"));
        let f = file_for(Path::new("/d"), "web", "shop", "https://shop.example.com");
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        assert!(f.starts_with("/d/web") && name.starts_with("shop-") && name.len() == "shop-".len() + 16);
        assert_eq!(safe("../x y"), ".._x_y");
    }
}
