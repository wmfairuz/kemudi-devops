//! ~/.config/kemudi/servers.yaml: load, validate, hot-reload.
//!
//! A reload that fails keeps the last good config (marked stale) so the
//! sidebar keeps working while you fix the file.

pub mod action_forms;
pub mod commands;
pub mod forms;
pub mod locate;
pub mod schema;
pub mod settings_form;
pub mod validate;
pub mod watcher;

use std::path::PathBuf;
use std::sync::RwLock;

use serde::Serialize;

use schema::Config;
use validate::Diag;

pub const SAMPLE: &str = include_str!("sample.yaml");

/// `$KEMUDI_CONFIG` if set (a second config, or testing), else
/// ~/.config/kemudi/servers.yaml.
pub fn config_path() -> PathBuf {
    if let Some(p) = std::env::var_os("KEMUDI_CONFIG").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".config")
        .join("kemudi")
        .join("servers.yaml")
}

pub fn config_dir() -> PathBuf {
    config_path()
        .parent()
        .map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub path: String,
    /// `~/…` form for display.
    pub display_path: String,
    pub exists: bool,
    /// The last good config (may be stale if `errors` is non-empty).
    pub config: Option<Config>,
    pub errors: Vec<Diag>,
    pub warnings: Vec<Diag>,
    /// True when `config` is from an earlier load because the file now fails.
    pub stale: bool,
    /// HH:MM:SS of the load that produced `config`.
    pub loaded_at: Option<String>,
}

pub struct ConfigStore {
    path: PathBuf,
    snapshot: RwLock<Snapshot>,
}

impl ConfigStore {
    pub fn new(path: PathBuf) -> Self {
        let display_path =
            match dirs::home_dir().and_then(|h| path.strip_prefix(h).ok().map(PathBuf::from)) {
                Some(rel) => format!("~/{}", rel.display()),
                None => path.display().to_string(),
            };
        let snapshot = Snapshot {
            path: path.display().to_string(),
            display_path,
            exists: false,
            config: None,
            errors: vec![],
            warnings: vec![],
            stale: false,
            loaded_at: None,
        };
        let store = ConfigStore {
            path,
            snapshot: RwLock::new(snapshot),
        };
        store.reload();
        store
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// The current usable config, stale or not.
    pub fn config(&self) -> Option<Config> {
        self.snapshot
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .config
            .clone()
    }

    /// Re-read the file and return the new snapshot.
    pub fn reload(&self) -> Snapshot {
        let read = std::fs::read_to_string(&self.path);
        let mut snap = self.snapshot.write().unwrap_or_else(|e| e.into_inner());
        match read {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                snap.exists = false;
                snap.config = None;
                snap.errors.clear();
                snap.warnings.clear();
                snap.stale = false;
                snap.loaded_at = None;
            }
            Err(e) => {
                snap.exists = true;
                snap.errors = vec![Diag {
                    message: format!("could not read the file: {e}"),
                    line: None,
                    column: None,
                    path: None,
                    suggestion: None,
                }];
                snap.stale = snap.config.is_some();
            }
            Ok(source) => {
                snap.exists = true;
                let out = validate::parse(&source);
                snap.warnings = out.warnings;
                snap.errors = out.errors;
                match out.config {
                    Some(c) => {
                        snap.config = Some(c);
                        snap.stale = false;
                        snap.loaded_at = Some(crate::util::local_hms());
                    }
                    None => snap.stale = snap.config.is_some(),
                }
            }
        }
        snap.clone()
    }
}
