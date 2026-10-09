//! Saved passwords: a plain list of entries (name, username, notes,
//! password), filled into any terminal at a password prompt after the user
//! picks one. An entry can be marked as the sudo password for some servers;
//! saving root-owned files there uses it in the background.
//!
//! Encrypted in `vault.bin` (data dir) with the same Keychain key as the .env
//! secret cache, so there is still one Keychain item. Passwords never go to
//! the webview: filling is done here, straight into the PTY; Copy puts it on
//! the clipboard here (cleared after 45 s if it's still there).

use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::pty::session::PtyId;
use crate::secret_cache::{data_file, load, save, with_key};
use crate::AppState;

const FILE: &str = "vault.bin";
const CLIPBOARD_SECONDS: u64 = 45;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    name: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    notes: String,
    password: String,
    /// Server ids this is the sudo password for.
    #[serde(default)]
    sudo_for: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Vault {
    entries: Vec<Entry>,
}

/// The first version: server id → { sudo, login }.
#[derive(Deserialize)]
struct OldEntry {
    sudo: Option<String>,
    login: Option<String>,
}

/// Read the vault's JSON, upgrading the first per-server format.
fn decode(value: serde_json::Value) -> Vault {
    if value.get("entries").is_some() {
        return serde_json::from_value(value).unwrap_or_default();
    }
    let Ok(old) = serde_json::from_value::<BTreeMap<String, OldEntry>>(value) else {
        return Vault::default();
    };
    let mut entries = Vec::new();
    for (server, e) in old {
        if let Some(p) = e.sudo {
            entries.push(Entry {
                id: format!("{server}-sudo"),
                name: format!("{server} sudo"),
                username: String::new(),
                notes: String::new(),
                password: p,
                sudo_for: vec![server.clone()],
            });
        }
        if let Some(p) = e.login {
            entries.push(Entry {
                id: format!("{server}-ssh"),
                name: format!("{server} SSH login"),
                username: String::new(),
                notes: String::new(),
                password: p,
                sudo_for: vec![],
            });
        }
    }
    Vault { entries }
}

fn read_all() -> Result<Vault, String> {
    let file = data_file(FILE)?;
    if !file.exists() {
        return Ok(Vault::default());
    }
    with_key(false, |key| {
        Ok(key
            .map(|k| decode(load::<serde_json::Value>(k, &file)))
            .unwrap_or_default())
    })
}

fn update(f: impl FnOnce(&mut Vault) -> Result<(), String>) -> Result<(), String> {
    let file = data_file(FILE)?;
    with_key(true, |key| {
        let Some(key) = key else {
            return Err("no Keychain key".into());
        };
        let mut vault = decode(load::<serde_json::Value>(key, &file));
        f(&mut vault)?;
        save(key, &file, &vault)
    })
}

/// The sudo password saved for a server (blocking: may wait on the
/// Keychain).
pub fn sudo_for(server_id: &str) -> Result<Option<String>, String> {
    Ok(read_all()?
        .entries
        .into_iter()
        .find(|e| e.sudo_for.iter().any(|s| s == server_id))
        .map(|e| e.password))
}

fn password_of(id: &str) -> Result<(String, String), String> {
    read_all()?
        .entries
        .into_iter()
        .find(|e| e.id == id)
        .map(|e| (e.name, e.password))
        .ok_or_else(|| "that password is gone".to_string())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?
        .map_err(AppError::Invalid)
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "password".into()
    } else {
        out
    }
}

/// An entry without its password.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub id: String,
    pub name: String,
    pub username: String,
    pub notes: String,
    pub sudo_for: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    /// None: a new entry.
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub sudo_for: Vec<String>,
    /// None keeps the saved one (required for a new entry).
    pub password: Option<String>,
}

fn apply(vault: &mut Vault, input: EntryInput) -> Result<String, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("give it a name".into());
    }
    if let Some(p) = &input.password {
        if p.is_empty() || p.contains(['\n', '\r', '\0']) || p == "KEMUDI_PW_END" {
            return Err("a password can't be empty or have line breaks".into());
        }
    }
    let id = match &input.id {
        Some(id) => id.clone(),
        None => {
            let base = slug(&name);
            let mut id = base.clone();
            let mut n = 2;
            while vault.entries.iter().any(|e| e.id == id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            id
        }
    };
    if input.id.is_some() && !vault.entries.iter().any(|e| e.id == id) {
        return Err("that password is gone".into());
    }
    if input.id.is_none() && input.password.is_none() {
        return Err("type the password".into());
    }
    // One sudo password per server: taking a server moves it here.
    for e in vault.entries.iter_mut().filter(|e| e.id != id) {
        e.sudo_for.retain(|s| !input.sudo_for.contains(s));
    }
    let username = input.username.trim().to_string();
    let notes = input.notes.trim_end().to_string();
    match vault.entries.iter_mut().find(|e| e.id == id) {
        Some(e) => {
            e.name = name;
            e.username = username;
            e.notes = notes;
            e.sudo_for = input.sudo_for;
            if let Some(p) = input.password {
                e.password = p;
            }
        }
        None => vault.entries.push(Entry {
            id: id.clone(),
            name,
            username,
            notes,
            password: input.password.unwrap_or_default(),
            sudo_for: input.sudo_for,
        }),
    }
    vault.entries.sort_by_key(|e| e.name.to_lowercase());
    Ok(id)
}

#[tauri::command]
pub async fn vault_list() -> AppResult<Vec<EntryInfo>> {
    blocking(|| {
        Ok(read_all()?
            .entries
            .into_iter()
            .map(|e| EntryInfo {
                id: e.id,
                name: e.name,
                username: e.username,
                notes: e.notes,
                sudo_for: e.sudo_for,
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn vault_save(entry: EntryInput) -> AppResult<String> {
    blocking(move || {
        let mut id = String::new();
        update(|v| {
            id = apply(v, entry)?;
            Ok(())
        })?;
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn vault_delete(id: String) -> AppResult<()> {
    blocking(move || {
        update(|v| {
            v.entries.retain(|e| e.id != id);
            Ok(())
        })
    })
    .await
}

/// Type a saved password (and ↵) into a terminal, after the user picked it
/// at a password prompt.
#[tauri::command]
pub async fn vault_fill(
    state: State<'_, AppState>,
    pty_id: PtyId,
    id: String,
    server_id: Option<String>,
) -> AppResult<()> {
    let (name, password) = blocking(move || password_of(&id)).await?;
    state
        .ptys
        .write(pty_id, format!("{password}\r").into_bytes())?;
    // History: which entry, where (never the value).
    let server =
        server_id.and_then(|sid| state.config.config().and_then(|c| c.server(&sid).cloned()));
    if let (Ok(log), Some(server)) = (state.audit.as_ref(), server) {
        let what = format!("Filled the saved password “{name}”");
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: None,
            action_id: "vault:fill",
            label: &what,
            env: server.env.as_str(),
            kind: "fill",
            command: &what,
            edited: false,
        }) {
            let _ = log.finish(row, Some(0));
        }
    }
    Ok(())
}

fn pbcopy(text: &str) -> Result<(), String> {
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}

fn pbpaste() -> Option<String> {
    let out = Command::new("/usr/bin/pbpaste").output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Put a password on the clipboard; cleared after 45 s unless something
/// else was copied meanwhile. Returns the seconds.
#[tauri::command]
pub async fn vault_copy(id: String) -> AppResult<u64> {
    let (_, password) = blocking(move || password_of(&id)).await?;
    pbcopy(&password).map_err(AppError::Invalid)?;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(CLIPBOARD_SECONDS));
        if pbpaste().as_deref() == Some(password.as_str()) {
            let _ = pbcopy("");
        }
    });
    Ok(CLIPBOARD_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: Option<&str>, name: &str, pw: Option<&str>, sudo: &[&str]) -> EntryInput {
        EntryInput {
            id: id.map(str::to_string),
            name: name.into(),
            username: "deploy".into(),
            notes: String::new(),
            sudo_for: sudo.iter().map(|s| s.to_string()).collect(),
            password: pw.map(str::to_string),
        }
    }

    #[test]
    fn add_edit_and_one_sudo_password_per_server() {
        let mut v = Vault::default();
        let a = apply(&mut v, input(None, "Acme root", Some("one"), &["acme"])).unwrap();
        assert_eq!(a, "acme-root");
        let b = apply(
            &mut v,
            input(None, "Acme root", Some("two"), &["acme", "stg"]),
        )
        .unwrap();
        assert_eq!(b, "acme-root-2");
        // acme moved to b.
        assert!(v
            .entries
            .iter()
            .find(|e| e.id == a)
            .unwrap()
            .sudo_for
            .is_empty());
        // Editing without a password keeps it.
        apply(&mut v, input(Some(&a), "Acme root (old)", None, &[])).unwrap();
        assert_eq!(
            v.entries.iter().find(|e| e.id == a).unwrap().password,
            "one"
        );
        assert!(
            apply(&mut v, input(None, "x", None, &[])).is_err(),
            "new needs a password"
        );
        assert!(apply(&mut v, input(None, " ", Some("p"), &[])).is_err());
        assert!(apply(&mut v, input(None, "x", Some("a\nb"), &[])).is_err());
        assert!(apply(&mut v, input(Some("gone"), "x", Some("p"), &[])).is_err());
    }

    #[test]
    fn upgrades_the_first_format() {
        let old = serde_json::json!({"stg": {"sudo": "s3cret"}, "acme-host": {"login": "pw"}});
        let v = decode(old);
        assert_eq!(v.entries.len(), 2);
        let sudo = v.entries.iter().find(|e| e.id == "stg-sudo").unwrap();
        assert_eq!(sudo.password, "s3cret");
        assert_eq!(sudo.sudo_for, ["stg"]);
        assert!(v
            .entries
            .iter()
            .any(|e| e.name == "acme-host SSH login" && e.sudo_for.is_empty()));
        let again = decode(serde_json::to_value(&v).unwrap());
        assert_eq!(again.entries, v.entries);
        assert!(
            decode(serde_json::Value::Null).entries.is_empty(),
            "no file yet"
        );
    }
}
