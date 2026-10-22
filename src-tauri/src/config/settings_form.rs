//! Settings window: terminal look/behaviour and the editor for "Edit in
//! servers.yaml". Values equal to the defaults are left out of the file.

use serde::Deserialize;
use tauri::{AppHandle, State};

use super::commands::save;
use super::locate::{set_map_key, set_top_key, yaml_scalar};
use super::schema::{Baseline, BaselineRepo, Editor, TerminalSettings};
use super::Snapshot;
use crate::error::{AppError, AppResult};
use crate::AppState;

pub const DEFAULT_FONT: &str = "Menlo";
pub const DEFAULT_SIZE: f64 = 14.0;
pub const DEFAULT_LINE_HEIGHT: f64 = 1.25;
pub const DEFAULT_SCROLLBACK: u32 = 10_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsForm {
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub option_as_meta: bool,
    pub scrollback: u32,
    pub shell_integration: bool,
    /// None: the first installed of Sublime Text, VS Code, PhpStorm.
    pub editor: Option<Editor>,
}

fn num(n: f64) -> String {
    let s = format!("{n:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn editor_str(e: Editor) -> &'static str {
    match e {
        Editor::Sublime => "sublime",
        Editor::Vscode => "vscode",
        Editor::Phpstorm => "phpstorm",
        Editor::System => "system",
    }
}

#[tauri::command]
pub async fn settings_save(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: SettingsForm,
) -> AppResult<Snapshot> {
    let f = &settings;
    let font = f.font_family.trim();
    if font.is_empty() {
        return Err(AppError::Invalid("pick a font".into()));
    }
    if !(8.0..=40.0).contains(&f.font_size) {
        return Err(AppError::Invalid(
            "font size must be between 8 and 40".into(),
        ));
    }
    if !(1.0..=2.0).contains(&f.line_height) {
        return Err(AppError::Invalid(
            "line height must be between 1.0 and 2.0".into(),
        ));
    }
    if f.scrollback > 1_000_000 {
        return Err(AppError::Invalid(
            "scrollback is at most 1,000,000 lines".into(),
        ));
    }
    let size = (f.font_size * 2.0).round() / 2.0;
    let line_height = (f.line_height * 100.0).round() / 100.0;
    let keys: [(&str, Option<String>); 6] = [
        (
            "font_family",
            (font != DEFAULT_FONT).then(|| yaml_scalar(font)),
        ),
        ("font_size", (size != DEFAULT_SIZE).then(|| num(size))),
        (
            "line_height",
            (line_height != DEFAULT_LINE_HEIGHT).then(|| num(line_height)),
        ),
        (
            "option_as_meta",
            f.option_as_meta.then(|| "true".to_string()),
        ),
        (
            "scrollback",
            (f.scrollback != DEFAULT_SCROLLBACK).then(|| f.scrollback.to_string()),
        ),
        (
            "shell_integration",
            (!f.shell_integration).then(|| "false".to_string()),
        ),
    ];
    let path = state.config.path().clone();
    let mut edited = std::fs::read_to_string(&path)?;
    for (key, value) in &keys {
        edited =
            set_map_key(&edited, "terminal", key, value.as_deref()).map_err(AppError::Invalid)?;
    }
    edited = set_top_key(&edited, "editor", f.editor.map(editor_str)).map_err(AppError::Invalid)?;

    let out = super::validate::parse(&edited);
    if let Some(e) = out.errors.first() {
        return Err(AppError::Invalid(format!("not saved: {}", e.message)));
    }
    let ok = out.config.is_some_and(|c| {
        let t: &TerminalSettings = &c.terminal;
        t.font_family.as_deref().unwrap_or(DEFAULT_FONT) == font
            && t.font_size.unwrap_or(DEFAULT_SIZE) == size
            && t.line_height.unwrap_or(DEFAULT_LINE_HEIGHT) == line_height
            && t.option_as_meta.unwrap_or(false) == f.option_as_meta
            && t.scrollback.unwrap_or(DEFAULT_SCROLLBACK) == f.scrollback
            && t.shell_integration.unwrap_or(true) == f.shell_integration
            && c.editor == f.editor
    });
    if !ok {
        return Err(AppError::Invalid(
            "Kemudi couldn't save this change automatically".into(),
        ));
    }
    save(&app, &state, &path, &edited)
}

/// Settings ▸ Server baseline: saved as one `baseline:` line (none: the
/// key goes).
#[tauri::command]
pub async fn baseline_save(
    app: AppHandle,
    state: State<'_, AppState>,
    baseline: Baseline,
) -> AppResult<Snapshot> {
    let b = Baseline {
        dir: baseline.dir.trim().trim_end_matches('/').to_string(),
        repos: baseline
            .repos
            .iter()
            .map(|r| BaselineRepo { name: r.name.trim().to_string(), url: r.url.trim().to_string() })
            .collect(),
        bashrc: baseline
            .bashrc
            .iter()
            .map(|l| l.trim_end().to_string())
            .filter(|l| !l.trim().is_empty())
            .collect(),
    };
    let empty = b.repos.is_empty() && b.bashrc.is_empty();
    if !empty {
        if let Some(p) = crate::baseline::problems(&b).first() {
            return Err(AppError::Invalid(p.clone()));
        }
    }
    let value = (!empty).then(|| baseline_yaml(&b));
    let path = state.config.path().clone();
    let source = std::fs::read_to_string(&path)?;
    let edited = set_top_key(&source, "baseline", value.as_deref()).map_err(AppError::Invalid)?;
    let out = super::validate::parse(&edited);
    if let Some(e) = out.errors.first() {
        return Err(AppError::Invalid(format!("not saved: {}", e.message)));
    }
    let ok = out.config.is_some_and(|c| if empty { c.baseline.is_none() } else { c.baseline.as_ref() == Some(&b) });
    if !ok {
        return Err(AppError::Invalid("Kemudi couldn't save this change automatically".into()));
    }
    save(&app, &state, &path, &edited)
}

/// `{ dir: …, repos: [{ name: …, url: … }], bashrc: [ … ] }` on one line.
fn baseline_yaml(b: &Baseline) -> String {
    let repos: Vec<String> = b
        .repos
        .iter()
        .map(|r| format!("{{ name: {}, url: {} }}", yaml_scalar(&r.name), yaml_scalar(&r.url)))
        .collect();
    let lines: Vec<String> = b.bashrc.iter().map(|l| yaml_scalar(l)).collect();
    format!(
        "{{ dir: {}, repos: [{}], bashrc: [{}] }}",
        yaml_scalar(&b.dir),
        repos.join(", "),
        lines.join(", ")
    )
}

#[cfg(test)]
mod baseline_tests {
    use super::*;

    #[test]
    fn baseline_round_trips() {
        let b = Baseline {
            dir: "/opt/www".into(),
            repos: vec![
                BaselineRepo { name: "server-helper".into(), url: "https://example.com/acme/server-helper.git".into() },
                BaselineRepo { name: "laravel-helper".into(), url: "git@example.com:acme/laravel-helper.git".into() },
            ],
            bashrc: vec!["alias deploy='/opt/www/laravel-helper/laravel-helper -uifr -d'".into(), "export A=\"b c\" # note".into()],
        };
        let src = format!("servers: []\nbaseline: {}\n", baseline_yaml(&b));
        let out = super::super::validate::parse(&src);
        assert!(out.errors.is_empty(), "{:?}\n{src}", out.errors);
        assert_eq!(out.config.expect("config").baseline, Some(b));
    }
}
