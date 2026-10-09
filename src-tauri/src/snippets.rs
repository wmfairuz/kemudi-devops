//! Command snippets: saved commands with notes, kept in
//! ~/.config/kemudi/snippets.yaml (next to servers.yaml). Kemudi owns the
//! file and rewrites it whole; a file it can't parse is never overwritten.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const HEADER: &str = "# Kemudi Devops snippets: edited from the Snippets panel.\n# Plain text: don't put passwords or tokens here.\n";
const MAX_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub notes: String,
    /// The team it belongs to (shown only there); None: every team.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default)]
    snippets: Vec<Snippet>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetInput {
    /// None: a new snippet.
    pub id: Option<String>,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub team: Option<String>,
}

fn path() -> PathBuf {
    crate::config::config_dir().join("snippets.yaml")
}

fn load(path: &Path) -> AppResult<Vec<Snippet>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_norway::from_str::<File>(&text)
        .map(|f| f.snippets)
        .map_err(|e| AppError::Config(format!("{}: {e}", path.display())))
}

fn store(path: &Path, snippets: &[Snippet]) -> AppResult<()> {
    let body = serde_norway::to_string(&File {
        snippets: snippets.to_vec(),
    })
    .map_err(|e| AppError::Invalid(e.to_string()))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("yaml.kemudi-tmp");
    std::fs::write(&tmp, format!("{HEADER}{body}"))?;
    std::fs::rename(&tmp, path)?;
    Ok(())
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
        "snippet".into()
    } else {
        out
    }
}

/// Add (at the top) or update a snippet; returns the new list.
pub fn save_in(path: &Path, input: SnippetInput) -> AppResult<Vec<Snippet>> {
    let name = input.name.trim().to_string();
    let command = input.command.trim_end().to_string();
    let notes = input.notes.trim_end().to_string();
    let team = input
        .team
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    if name.is_empty() || command.trim().is_empty() {
        return Err(AppError::Invalid(
            "a snippet needs a name and a command".into(),
        ));
    }
    if command.len() > MAX_LEN || notes.len() > MAX_LEN {
        return Err(AppError::Invalid("that snippet is too long".into()));
    }
    let mut list = load(path)?;
    match input.id {
        Some(id) => {
            let s = list
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or_else(|| AppError::NotFound(format!("snippet `{id}` is gone")))?;
            s.name = name;
            s.command = command;
            s.notes = notes;
            s.team = team;
        }
        None => {
            let base = slug(&name);
            let mut id = base.clone();
            let mut n = 2;
            while list.iter().any(|s| s.id == id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            list.insert(
                0,
                Snippet {
                    id,
                    name,
                    command,
                    notes,
                    team,
                },
            );
        }
    }
    store(path, &list)?;
    Ok(list)
}

pub fn delete_in(path: &Path, id: &str) -> AppResult<Vec<Snippet>> {
    let mut list = load(path)?;
    let before = list.len();
    list.retain(|s| s.id != id);
    if list.len() != before {
        store(path, &list)?;
    }
    Ok(list)
}

#[tauri::command]
pub async fn snippets_list() -> AppResult<Vec<Snippet>> {
    load(&path())
}

#[tauri::command]
pub async fn snippet_save(snippet: SnippetInput) -> AppResult<Vec<Snippet>> {
    save_in(&path(), snippet)
}

#[tauri::command]
pub async fn snippet_delete(id: String) -> AppResult<Vec<Snippet>> {
    delete_in(&path(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: Option<&str>, name: &str, command: &str, notes: &str) -> SnippetInput {
        SnippetInput {
            id: id.map(str::to_string),
            name: name.into(),
            command: command.into(),
            notes: notes.into(),
            team: None,
        }
    }

    #[test]
    fn add_edit_delete_roundtrip() {
        let dir = std::env::temp_dir().join(format!("kemudi-snippets-{}", std::process::id()));
        let file = dir.join("snippets.yaml");
        let _ = std::fs::remove_dir_all(&dir);

        let list = save_in(
            &file,
            input(None, "Tail log", "tail -f storage/logs/laravel.log", ""),
        )
        .unwrap();
        assert_eq!(list[0].id, "tail-log");
        let list = save_in(
            &file,
            input(
                None,
                "Tail log",
                "tail -n 200 x.log",
                "Line one\nLine two: with 'quotes' # and hash",
            ),
        )
        .unwrap();
        assert_eq!(
            list[0].id, "tail-log-2",
            "new ones go on top, ids stay unique"
        );

        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("# Kemudi Devops snippets"));
        let back = load(&file).unwrap();
        assert_eq!(back, list, "notes with newlines/quotes/# survive");

        let list = save_in(
            &file,
            input(Some("tail-log"), "Tail Laravel log", "tail -f a.log", "n"),
        )
        .unwrap();
        assert_eq!(list[1].name, "Tail Laravel log");
        assert!(save_in(&file, input(Some("nope"), "x", "y", "")).is_err());
        assert!(save_in(&file, input(None, " ", "y", "")).is_err());

        let list = delete_in(&file, "tail-log-2").unwrap();
        assert_eq!(list.len(), 1);

        // A file we can't parse is reported, never overwritten.
        std::fs::write(&file, "snippets: [oops").unwrap();
        assert!(save_in(&file, input(None, "a", "b", "")).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "snippets: [oops");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Restart Horizon!"), "restart-horizon");
        assert_eq!(slug("  ★ "), "snippet");
    }
}
