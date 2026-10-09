//! Inspect's .env secret values, kept between launches in one encrypted
//! file (`inspect-secrets.bin` in the data dir, ChaCha20-Poly1305). The only
//! key is one random 256-bit Keychain item, "Kemudi Devops cache key",
//! however many apps there are. Deleting that item makes the file unreadable
//! (it is then started afresh). Non-secret values live in the frontend cache.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use tauri::State;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "dev.kemudi.app";

/// `KEMUDI_KEYCHAIN_SERVICE` gives a test copy its own Keychain item.
fn service() -> String {
    std::env::var("KEMUDI_KEYCHAIN_SERVICE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| SERVICE.to_string())
}
const ACCOUNT: &str = "inspect-cache-key";
const LABEL: &str = "Kemudi Devops cache key";
const FILE: &str = "inspect-secrets.bin";
const MAGIC: &[u8] = b"KMS1";
const NONCE_LEN: usize = 12;
/// errSecItemNotFound
const NOT_FOUND: i32 = -25300;

/// "server|/app/path" → .env key → value.
type Store = BTreeMap<String, BTreeMap<String, String>>;

/// The key once read from the Keychain (one Keychain access per launch),
/// and the lock that keeps file updates in order.
static KEY: Mutex<Option<Key>> = Mutex::new(None);
/// The Keychain prompt was refused this launch: don't ask again on every
/// Inspect (Try again clears it).
static REFUSED: AtomicBool = AtomicBool::new(false);

/// errSecAuthFailed (wrong password at the prompt), userCanceled (Deny),
/// errSecInteractionNotAllowed (no prompt possible, e.g. locked keychain).
const REFUSALS: [i32; 3] = [-25293, -128, -25308];
const REFUSED_MSG: &str =
    "macOS didn't let Kemudi read its key (\"Kemudi Devops cache key\"), so secret values are kept only until you quit. \
Click Try again; when macOS asks, enter your login keychain password (normally your Mac password, \
or your previous one if you changed it since) and choose Always Allow.";

/// The refusal, with macOS's own code for the record.
fn refused(code: i32) -> String {
    let why = match code {
        -25293 => "the password wasn't accepted",
        -128 => "the request was cancelled",
        _ => "macOS couldn't ask",
    };
    format!("{REFUSED_MSG} ({why}, {code})")
}

/// `KEMUDI_SECRET_CACHE=off`: keep secrets in memory only and never touch
/// the Keychain (a second, differently signed copy for testing would make
/// macOS ask for your password).
fn disabled() -> bool {
    std::env::var("KEMUDI_SECRET_CACHE").is_ok_and(|v| v == "off")
}

pub fn entry(server_id: &str, path: &str) -> String {
    format!("{server_id}|{}", path.trim().trim_end_matches('/'))
}

fn keychain_error(e: &security_framework::base::Error) -> String {
    if REFUSALS.contains(&e.code()) {
        REFUSED.store(true, Ordering::SeqCst);
        return refused(e.code());
    }
    let why = e.message().unwrap_or_else(|| format!("error {}", e.code()));
    format!("Keychain: {why}")
}

/// Ask the Keychain again after a refusal (the Try again button).
pub fn retry() {
    REFUSED.store(false, Ordering::SeqCst);
}

/// The Keychain key; created on first use when `create`.
fn key(slot: &mut Option<Key>, create: bool) -> Result<Option<Key>, String> {
    use security_framework::passwords::{
        get_generic_password, set_generic_password_options, PasswordOptions,
    };
    if let Some(k) = slot {
        return Ok(Some(*k));
    }
    if REFUSED.load(Ordering::SeqCst) {
        return Err(REFUSED_MSG.into());
    }
    match get_generic_password(&service(), ACCOUNT) {
        Ok(bytes) if bytes.len() == 32 => {
            let k = *Key::from_slice(&bytes);
            *slot = Some(k);
            Ok(Some(k))
        }
        Ok(_) => Err(
            "Keychain: \"Kemudi Devops cache key\" isn't a valid key; delete it in Keychain Access"
                .into(),
        ),
        Err(e) if e.code() == NOT_FOUND && create => {
            let k = ChaCha20Poly1305::generate_key(&mut OsRng);
            let mut opts = PasswordOptions::new_generic_password(&service(), ACCOUNT);
            opts.set_label(LABEL);
            set_generic_password_options(k.as_slice(), opts).map_err(|e| keychain_error(&e))?;
            *slot = Some(k);
            Ok(Some(k))
        }
        Err(e) if e.code() == NOT_FOUND => Ok(None),
        Err(e) => Err(keychain_error(&e)),
    }
}

fn seal(key: &Key, plain: &[u8]) -> Result<Vec<u8>, String> {
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let sealed = ChaCha20Poly1305::new(key)
        .encrypt(&nonce, plain)
        .map_err(|_| "could not encrypt".to_string())?;
    Ok([MAGIC, nonce.as_slice(), &sealed].concat())
}

fn open(key: &Key, bytes: &[u8]) -> Option<Vec<u8>> {
    let rest = bytes.strip_prefix(MAGIC)?;
    if rest.len() < NONCE_LEN {
        return None;
    }
    let (nonce, sealed) = rest.split_at(NONCE_LEN);
    ChaCha20Poly1305::new(key)
        .decrypt(Nonce::from_slice(nonce), sealed)
        .ok()
}

/// An encrypted file's contents; empty (default) when there's no file or it
/// can't be read with this key (e.g. the Keychain item was deleted and made
/// again). Shared with the password vault.
pub(crate) fn load<T: serde::de::DeserializeOwned + Default>(key: &Key, file: &Path) -> T {
    std::fs::read(file)
        .ok()
        .and_then(|b| open(key, &b))
        .and_then(|plain| serde_json::from_slice(&plain).ok())
        .unwrap_or_default()
}

pub(crate) fn save<T: serde::Serialize>(key: &Key, file: &Path, store: &T) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let plain = serde_json::to_vec(store).map_err(|e| e.to_string())?;
    let sealed = seal(key, &plain)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_extension("bin.tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(&sealed)
        .and_then(|()| f.sync_all())
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, file).map_err(|e| format!("{}: {e}", file.display()))
}

fn file() -> Result<PathBuf, String> {
    data_file(FILE)
}

pub(crate) fn data_file(name: &str) -> Result<PathBuf, String> {
    crate::data_dir()
        .map(|d| d.join(name))
        .ok_or_else(|| "no Application Support directory".to_string())
}

/// Run `f` with the Keychain key (created first when `create`), holding the
/// lock that keeps every encrypted-file update in order. `None`: no key yet.
/// Err when the Keychain refused, or `KEMUDI_SECRET_CACHE=off`.
pub(crate) fn with_key<R>(
    create: bool,
    f: impl FnOnce(Option<&Key>) -> Result<R, String>,
) -> Result<R, String> {
    if disabled() {
        return Err("saved secrets are off in this copy (KEMUDI_SECRET_CACHE=off)".into());
    }
    let mut slot = KEY
        .lock()
        .map_err(|_| "secret cache lock poisoned".to_string())?;
    let k = key(&mut slot, create)?;
    f(k.as_ref())
}

/// Replace one app's secrets (none: forget them). Blocking: may wait on a
/// Keychain prompt.
pub fn put(entry: &str, secrets: BTreeMap<String, String>) -> Result<(), String> {
    if disabled() {
        return Ok(());
    }
    let mut slot = KEY
        .lock()
        .map_err(|_| "secret cache lock poisoned".to_string())?;
    let file = file()?;
    if secrets.is_empty() && !file.exists() {
        return Ok(());
    }
    let Some(key) = key(&mut slot, true)? else {
        return Ok(());
    };
    let mut store: Store = load(&key, &file);
    if secrets.is_empty() {
        if store.remove(entry).is_none() {
            return Ok(());
        }
    } else {
        store.insert(entry.to_string(), secrets);
    }
    save(&key, &file, &store)
}

/// One app's stored secrets (empty if none).
pub fn get(entry: &str) -> Result<BTreeMap<String, String>, String> {
    if disabled() {
        return Ok(BTreeMap::new());
    }
    let mut slot = KEY
        .lock()
        .map_err(|_| "secret cache lock poisoned".to_string())?;
    let file = file()?;
    if !file.exists() {
        return Ok(BTreeMap::new());
    }
    let Some(key) = key(&mut slot, false)? else {
        return Ok(BTreeMap::new());
    };
    Ok(load::<Store>(&key, &file).remove(entry).unwrap_or_default())
}

/// Clear an earlier refusal so the next read asks the Keychain again.
#[tauri::command]
pub async fn inspect_secrets_retry() {
    retry();
}

/// The .env secret values cached for an app by its last Inspect.
#[tauri::command]
pub async fn inspect_secrets(
    _state: State<'_, crate::AppState>,
    server_id: String,
    path: String,
) -> AppResult<BTreeMap<String, String>> {
    let entry = entry(&server_id, &path);
    tauri::async_runtime::spawn_blocking(move || get(&entry))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?
        .map_err(AppError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key = ChaCha20Poly1305::generate_key(&mut OsRng);
        let sealed = seal(&key, b"DB_PASSWORD=hunter2").unwrap();
        assert!(!sealed.windows(7).any(|w| w == b"hunter2"));
        assert_eq!(
            open(&key, &sealed).as_deref(),
            Some(&b"DB_PASSWORD=hunter2"[..])
        );
        let other = ChaCha20Poly1305::generate_key(&mut OsRng);
        assert!(open(&other, &sealed).is_none(), "wrong key");
        let mut tampered = sealed.clone();
        if let Some(b) = tampered.last_mut() {
            *b ^= 1;
        }
        assert!(open(&key, &tampered).is_none(), "tampered");
        assert!(open(&key, b"junk").is_none());
    }

    #[test]
    fn store_roundtrip_and_new_key() {
        let dir = std::env::temp_dir().join(format!("kemudi-secrets-{}", std::process::id()));
        let file = dir.join(FILE);
        let key = ChaCha20Poly1305::generate_key(&mut OsRng);
        let mut store = Store::new();
        store.insert(
            entry("stg", "/var/www/app/"),
            BTreeMap::from([("APP_KEY".to_string(), "base64:abc".to_string())]),
        );
        save(&key, &file, &store).unwrap();
        assert_eq!(load::<Store>(&key, &file), store);
        let other = ChaCha20Poly1305::generate_key(&mut OsRng);
        assert!(load::<Store>(&other, &file).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
