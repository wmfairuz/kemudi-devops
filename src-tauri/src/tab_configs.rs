//! Tab configs: a named tab (title, colour) with a pane layout where each
//! pane starts in a folder and runs commands, Warp-style. Same TOML format
//! as Warp, read from Kemudi's folder (~/.config/kemudi/tab_configs) and
//! from Warp's (~/.warp/tab_configs, read-only); a Kemudi config with the
//! same name wins.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const COLORS: [&str; 18] = [
    "red", "crimson", "maroon", "coral", "orange", "amber", "gold", "yellow", "brown", "lime",
    "green", "teal", "cyan", "blue", "indigo", "purple", "pink", "gray",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TabConfig {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub panes: Vec<PaneDef>,
    /// Warp's `[params]` table, kept as-is.
    #[serde(default)]
    pub params: toml::Table,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PaneDef {
    pub id: String,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `horizontal` (side by side) or `vertical` (stacked), for containers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<String>,
}

/// The layout the frontend builds the tab from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConfigLayout {
    Pane {
        id: String,
        directory: Option<String>,
        commands: Vec<String>,
    },
    Split {
        /// `row`: side by side; `col`: stacked.
        dir: &'static str,
        children: Vec<ConfigLayout>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabConfigEntry {
    pub file: String,
    /// `kemudi` (editable) or `warp` (read-only).
    pub source: &'static str,
    pub config: TabConfig,
    pub layout: Option<ConfigLayout>,
    pub error: Option<String>,
}

/// Panes → layout tree. Missing children are skipped; terminal panes no
/// container mentions are added next to the rest, so a slightly broken
/// config still opens every pane.
pub fn layout(config: &TabConfig) -> Result<ConfigLayout, String> {
    let by_id: HashMap<&str, &PaneDef> = config.panes.iter().map(|p| (p.id.as_str(), p)).collect();
    let is_container = |p: &PaneDef| p.split.is_some() || !p.children.is_empty();
    let referenced: HashSet<&str> = config
        .panes
        .iter()
        .flat_map(|p| p.children.iter().map(String::as_str))
        .collect();
    let roots: Vec<&PaneDef> = config
        .panes
        .iter()
        .filter(|p| !referenced.contains(p.id.as_str()))
        .collect();

    fn build(p: &PaneDef, by_id: &HashMap<&str, &PaneDef>, depth: usize) -> Option<ConfigLayout> {
        if depth > 16 {
            return None;
        }
        if p.split.is_none() && p.children.is_empty() {
            return Some(ConfigLayout::Pane {
                id: p.id.clone(),
                directory: p.directory.clone().filter(|d| !d.trim().is_empty()),
                commands: p
                    .commands
                    .iter()
                    .filter(|c| !c.trim().is_empty())
                    .cloned()
                    .collect(),
            });
        }
        let children: Vec<ConfigLayout> = p
            .children
            .iter()
            .filter_map(|c| {
                by_id
                    .get(c.as_str())
                    .and_then(|d| build(d, by_id, depth + 1))
            })
            .collect();
        match children.len() {
            0 => None,
            1 => children.into_iter().next(),
            _ => Some(ConfigLayout::Split {
                dir: if p.split.as_deref() == Some("vertical") {
                    "col"
                } else {
                    "row"
                },
                children,
            }),
        }
    }

    let mut built: Vec<ConfigLayout> = roots.iter().filter_map(|p| build(p, &by_id, 0)).collect();
    if built.is_empty() {
        return Err("no terminal panes".into());
    }
    if built.len() == 1 {
        return Ok(built.remove(0));
    }
    // Several roots: keep the container's direction for the extras.
    let dir = roots
        .iter()
        .find(|p| is_container(p))
        .and_then(|p| p.split.as_deref())
        .map_or("row", |s| if s == "vertical" { "col" } else { "row" });
    Ok(ConfigLayout::Split {
        dir,
        children: built,
    })
}

pub fn kemudi_dir() -> PathBuf {
    crate::config::config_dir().join("tab_configs")
}

fn warp_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".warp").join("tab_configs"))
}

fn read_dir(dir: &Path, source: &'static str) -> Vec<TabConfigEntry> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "toml"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let file = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let parsed = std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|t| toml::from_str::<TabConfig>(&t).map_err(|e| e.message().to_string()));
            match parsed {
                Ok(config) => {
                    let (layout, error) = match layout(&config) {
                        Ok(l) => (Some(l), None),
                        Err(e) => (None, Some(e)),
                    };
                    TabConfigEntry {
                        file,
                        source,
                        config,
                        layout,
                        error,
                    }
                }
                Err(e) => TabConfigEntry {
                    config: TabConfig {
                        name: file.trim_end_matches(".toml").to_string(),
                        ..Default::default()
                    },
                    file,
                    source,
                    layout: None,
                    error: Some(e),
                },
            }
        })
        .collect()
}

pub fn list_in(kemudi: &Path, warp: Option<&Path>) -> Vec<TabConfigEntry> {
    let mut out = read_dir(kemudi, "kemudi");
    let names: HashSet<String> = out.iter().map(|e| e.config.name.clone()).collect();
    if let Some(w) = warp {
        out.extend(
            read_dir(w, "warp")
                .into_iter()
                .filter(|e| !names.contains(&e.config.name)),
        );
    }
    out.sort_by_key(|e| e.config.name.to_lowercase());
    out
}

fn valid_file(file: &str) -> bool {
    file.ends_with(".toml")
        && file.len() <= 80
        && file
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        && !file.starts_with('.')
}

fn slug(name: &str) -> String {
    let s: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let s = s.trim_matches('_').to_string();
    if s.is_empty() {
        "tab_config".into()
    } else {
        s.chars().take(60).collect()
    }
}

pub fn validate(config: &TabConfig) -> AppResult<()> {
    if config.name.trim().is_empty() {
        return Err(AppError::Invalid("give the tab config a name".into()));
    }
    if let Some(c) = &config.color {
        if !COLORS.contains(&c.as_str()) {
            return Err(AppError::Invalid(format!("unknown colour {c:?}")));
        }
    }
    layout(config).map_err(AppError::Invalid)?;
    Ok(())
}

/// Write a config into Kemudi's folder: over `file`, or a new file named
/// after it. Returns the file name.
pub fn save_in(dir: &Path, file: Option<&str>, config: &TabConfig) -> AppResult<String> {
    validate(config)?;
    let name = match file {
        Some(f) if valid_file(f) => f.to_string(),
        Some(f) => return Err(AppError::Invalid(format!("bad file name {f:?}"))),
        None => {
            let base = slug(&config.name);
            let mut n = 0;
            loop {
                let candidate = if n == 0 {
                    format!("{base}.toml")
                } else {
                    format!("{base}_{n}.toml")
                };
                if !dir.join(&candidate).exists() {
                    break candidate;
                }
                n += 1;
            }
        }
    };
    std::fs::create_dir_all(dir)?;
    let text = toml::to_string_pretty(config).map_err(|e| AppError::Invalid(e.to_string()))?;
    let path = dir.join(&name);
    let tmp = path.with_extension("toml.kemudi-tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(name)
}

#[tauri::command]
pub async fn tab_configs_list() -> AppResult<Vec<TabConfigEntry>> {
    Ok(list_in(&kemudi_dir(), warp_dir().as_deref()))
}

#[tauri::command]
pub async fn tab_config_save(file: Option<String>, config: TabConfig) -> AppResult<String> {
    save_in(&kemudi_dir(), file.as_deref(), &config)
}

#[tauri::command]
pub async fn tab_config_delete(file: String) -> AppResult<()> {
    if !valid_file(&file) {
        return Err(AppError::Invalid(format!("bad file name {file:?}")));
    }
    std::fs::remove_file(kemudi_dir().join(file))?;
    Ok(())
}

/// Show Kemudi's tab configs folder in Finder.
#[tauri::command]
pub async fn tab_configs_reveal() -> AppResult<()> {
    let dir = kemudi_dir();
    std::fs::create_dir_all(&dir)?;
    std::process::Command::new("/usr/bin/open")
        .arg(dir)
        .spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PETCLINIC: &str = r#"
name = "PetClinic Deploy"
title = "PetClinic"
color = "red"

[[panes]]
id = "root"
split = "horizontal"
children = ["code", "server"]

[[panes]]
id = "code"
type = "terminal"
directory = "/Users/me/code/laravel/petclinic-production"
commands = ["git pull", "git merge origin/master --no-edit", "git push"]

[[panes]]
id = "server"
type = "terminal"
directory = "/Users/me/code/laravel/petclinic-production"
commands = ["ssh petclinic-app -t 'sudo su'"]

[params]
"#;

    fn ids(l: &ConfigLayout) -> String {
        match l {
            ConfigLayout::Pane { id, .. } => id.clone(),
            ConfigLayout::Split { dir, children } => {
                format!(
                    "{dir}[{}]",
                    children.iter().map(ids).collect::<Vec<_>>().join(",")
                )
            }
        }
    }

    #[test]
    fn warp_two_panes() {
        let c: TabConfig = toml::from_str(PETCLINIC).expect("parse");
        assert_eq!(c.color.as_deref(), Some("red"));
        let l = layout(&c).expect("layout");
        assert_eq!(ids(&l), "row[code,server]");
        let ConfigLayout::Split { children, .. } = &l else {
            panic!()
        };
        assert_eq!(
            children[0],
            ConfigLayout::Pane {
                id: "code".into(),
                directory: Some("/Users/me/code/laravel/petclinic-production".into()),
                commands: vec![
                    "git pull".into(),
                    "git merge origin/master --no-edit".into(),
                    "git push".into()
                ],
            }
        );
    }

    #[test]
    fn grid_and_broken_references() {
        let grid = r#"
name = "Fleet"
[[panes]]
id = "root"
split = "vertical"
children = ["top", "bottom"]
[[panes]]
id = "top"
split = "horizontal"
children = ["i1", "i2", "i3"]
[[panes]]
id = "bottom"
split = "horizontal"
children = ["i4", "i5", "i6"]
"#
        .to_string()
            + &(1..=6).map(|i| format!("[[panes]]\nid = \"i{i}\"\ntype = \"terminal\"\ncommands = [\"asg-ssh {i}\"]\n")).collect::<String>();
        let c: TabConfig = toml::from_str(&grid).expect("parse");
        assert_eq!(
            ids(&layout(&c).expect("layout")),
            "col[row[i1,i2,i3],row[i4,i5,i6]]"
        );

        // eSchool Deploy: root names "code", but the panes are codemain/codeprod.
        let broken = r#"
name = "eSchool Deploy"
[[panes]]
id = "root"
split = "horizontal"
children = ["code", "server"]
[[panes]]
id = "codemain"
type = "terminal"
[[panes]]
id = "codeprod"
type = "terminal"
[[panes]]
id = "server"
type = "terminal"
"#;
        let c: TabConfig = toml::from_str(broken).expect("parse");
        assert_eq!(
            ids(&layout(&c).expect("layout")),
            "row[server,codemain,codeprod]"
        );
    }

    #[test]
    fn save_round_trip() {
        let dir = std::env::temp_dir().join(format!("kemudi-tabcfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let c: TabConfig = toml::from_str(PETCLINIC).expect("parse");
        let f = save_in(&dir, None, &c).expect("save");
        assert_eq!(f, "petclinic_deploy.toml");
        assert_eq!(
            save_in(&dir, None, &c).expect("again"),
            "petclinic_deploy_1.toml"
        );
        let listed = list_in(&dir, None);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].config, c);
        assert!(save_in(&dir, Some("../evil.toml"), &c).is_err());
        assert!(validate(&TabConfig {
            name: " ".into(),
            ..c.clone()
        })
        .is_err());
        assert!(validate(&TabConfig {
            color: Some("chartreuse".into()),
            ..c
        })
        .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_real_warp_configs() {
        // Smoke test against this machine's Warp configs, when there are any.
        let Some(w) = warp_dir() else { return };
        for e in list_in(Path::new("/nonexistent"), Some(&w)) {
            assert!(e.error.is_none(), "{}: {:?}", e.file, e.error);
        }
    }
}
