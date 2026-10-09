use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::locate::{
    run_source, set_action_key, set_shared_action_key, shared_section_of, yaml_quote, RunSource,
    Section,
};
use super::schema::{Action, ActionKind, Config, Confirm, Editor};
use super::watcher::CHANGED_EVENT;
use super::{Snapshot, SAMPLE};
use crate::actions::commands::ActionRef;
use crate::env::LoginEnv;
use crate::error::{AppError, AppResult};
use crate::AppState;

#[tauri::command]
pub async fn config_get(state: State<'_, AppState>) -> AppResult<Snapshot> {
    Ok(state.config.snapshot())
}

#[tauri::command]
pub async fn config_reload(app: AppHandle, state: State<'_, AppState>) -> AppResult<Snapshot> {
    let snap = state.config.reload();
    let _ = app.emit(CHANGED_EVENT, snap.clone());
    Ok(snap)
}

/// Write the commented sample (only if the file doesn't exist) and open it.
#[tauri::command]
pub async fn config_create(app: AppHandle, state: State<'_, AppState>) -> AppResult<Snapshot> {
    let path = state.config.path().clone();
    if path.exists() {
        return Err(AppError::Invalid(format!(
            "{} already exists",
            path.display()
        )));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, SAMPLE)?;
    let snap = state.config.reload();
    let _ = app.emit(CHANGED_EVENT, snap.clone());
    open_in_editor(&path.display().to_string(), None, &state)?;
    Ok(snap)
}

/// Open servers.yaml in VS Code (at `line`) if `code` is installed, else in
/// the default text editor.
#[tauri::command]
pub async fn config_open(state: State<'_, AppState>, line: Option<u32>) -> AppResult<()> {
    let path = state.config.path().display().to_string();
    open_in_editor(&path, line, &state)
}

#[tauri::command]
pub async fn config_reveal(state: State<'_, AppState>) -> AppResult<()> {
    let path = state.config.path();
    let target = if path.exists() {
        path.clone()
    } else {
        super::config_dir()
    };
    Command::new("/usr/bin/open")
        .arg("-R")
        .arg(target)
        .spawn()?;
    Ok(())
}

/// Open servers.yaml, at `line` when the editor supports it. Uses the
/// configured `editor:` (from the last good config), else the first one
/// installed of Sublime Text, VS Code, PhpStorm, else TextEdit.
pub(crate) fn open_in_editor(path: &str, line: Option<u32>, state: &AppState) -> AppResult<()> {
    let pref = state.config.config().and_then(|c| c.editor);
    let order = match pref {
        Some(e) => vec![e],
        None => vec![Editor::Sublime, Editor::Vscode, Editor::Phpstorm],
    };
    for editor in order {
        if let Some((bin, args)) = editor_command(editor, path, line, &state.env) {
            Command::new(bin).args(args).envs(&state.env.vars).spawn()?;
            return Ok(());
        }
    }
    Command::new("/usr/bin/open").args(["-t", path]).spawn()?;
    Ok(())
}

/// The CLI for an editor (bundled inside the .app, or on PATH) and its
/// "open at line" arguments.
fn editor_command(
    editor: Editor,
    path: &str,
    line: Option<u32>,
    env: &LoginEnv,
) -> Option<(PathBuf, Vec<String>)> {
    let on_path = |name: &str| {
        env.get("PATH")
            .unwrap_or_default()
            .split(':')
            .map(|d| Path::new(d).join(name))
            .find(|p| p.is_file())
    };
    let bundled = |p: &str| Some(PathBuf::from(p)).filter(|p| p.is_file());
    let at = |sep: &str| match line {
        Some(l) => format!("{path}{sep}{l}"),
        None => path.to_string(),
    };
    match editor {
        Editor::Sublime => {
            bundled("/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl")
                .or_else(|| on_path("subl"))
                .map(|bin| (bin, vec![at(":")]))
        }
        Editor::Vscode => {
            bundled("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
                .or_else(|| on_path("code"))
                .map(|bin| (bin, vec!["-g".into(), at(":")]))
        }
        Editor::Phpstorm => on_path("phpstorm")
            .or_else(|| bundled("/Applications/PhpStorm.app/Contents/MacOS/phpstorm"))
            .map(|bin| {
                let mut args = Vec::new();
                if let Some(l) = line {
                    args.extend(["--line".to_string(), l.to_string()]);
                }
                args.push(path.to_string());
                (bin, args)
            }),
        Editor::System => None,
    }
}

/// Set how much an action asks before running (`None` = back to the
/// env/danger default) by editing servers.yaml for that one button. The
/// edit is validated before it's written; the watcher then reloads as usual.
#[tauri::command]
pub async fn action_set_confirm(
    app: AppHandle,
    state: State<'_, AppState>,
    action: ActionRef,
    confirm: Option<Confirm>,
) -> AppResult<Snapshot> {
    let path = state.config.path().clone();
    let source = std::fs::read_to_string(&path)?;
    let value = confirm.map(|c| match c {
        Confirm::None => "none",
        Confirm::Warn => "warn",
        Confirm::Type => "type",
    });
    let edited = super::locate::set_action_confirm(
        &source,
        &action.server_id,
        action.app_id.as_deref(),
        &action.action_id,
        value,
    )
    .map_err(AppError::Invalid)?;

    // Never write a file that's broken or doesn't do what was asked.
    let out = super::validate::parse(&edited);
    let config = out.config.ok_or_else(|| {
        AppError::Invalid("Kemudi couldn't save this change automatically".into())
    })?;
    let resolved = config.server(&action.server_id).and_then(|s| {
        let list = match &action.app_id {
            Some(a) => &s.app(a)?.actions,
            None => &s.actions,
        };
        list.iter()
            .find(|a| a.id == action.action_id)
            .map(|a| a.confirm)
    });
    if resolved != Some(confirm) {
        return Err(AppError::Invalid(
            "Kemudi couldn't save this change automatically".into(),
        ));
    }

    save(&app, &state, &path, &edited)
}

/// Write servers.yaml atomically and reload (the watcher would too, later).
pub(super) fn save(
    app: &AppHandle,
    state: &AppState,
    path: &Path,
    edited: &str,
) -> AppResult<Snapshot> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("yaml.kemudi-tmp");
    std::fs::write(&tmp, edited)?;
    std::fs::rename(&tmp, path)?;
    let snap = state.config.reload();
    let _ = app.emit(CHANGED_EVENT, snap.clone());
    Ok(snap)
}

/// An action's command as written in servers.yaml, for the editor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionDefinition {
    /// The `run:` template (before `{{ … }}` is filled in).
    pub run: String,
    pub line: Option<usize>,
    /// `actions.app` etc. when `run` comes from the shared global entry.
    pub shared: Option<String>,
}

fn section_of(kind: ActionKind, app: Option<&str>) -> Section {
    match (app, kind) {
        (None, _) => Section::Server,
        (Some(_), ActionKind::Local) => Section::Local,
        (Some(_), ActionKind::Ssh) => Section::App,
    }
}

#[tauri::command]
pub async fn action_definition(
    state: State<'_, AppState>,
    action: ActionRef,
) -> AppResult<ActionDefinition> {
    let config = state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))?;
    let def = find_action(&config, &action)
        .ok_or_else(|| AppError::NotFound(format!("action `{}` not found", action.action_id)))?;
    let source = std::fs::read_to_string(state.config.path())?;
    let team = config
        .server(&action.server_id)
        .and_then(|s| s.team.clone());
    let section = shared_section_of(
        &source,
        team.as_deref(),
        &action.action_id,
        action.app_id.is_some(),
    )
    .map(|(_, s)| s)
    .unwrap_or_else(|| section_of(def.kind, action.app_id.as_deref()));
    let shared = match run_source(
        &source,
        &action.server_id,
        action.app_id.as_deref(),
        team.as_deref(),
        &action.action_id,
        section,
    ) {
        RunSource::Shared(Some(t), s) => Some(format!("team {t} ({})", s.name())),
        RunSource::Shared(None, s) => Some(format!("actions.{}", s.name())),
        RunSource::Override => None,
    };
    Ok(ActionDefinition {
        run: def.run.clone(),
        line: def.line,
        shared,
    })
}

/// Save an action's command and label: on this server/app (an override when
/// they came from the shared entry), or with `everywhere` on the shared
/// entry. Only what changed is written; validated before it's written.
#[tauri::command]
pub async fn action_set_run(
    app: AppHandle,
    state: State<'_, AppState>,
    action: ActionRef,
    run: String,
    label: Option<String>,
    everywhere: bool,
) -> AppResult<Snapshot> {
    let run = run.trim_end().to_string();
    if run.trim().is_empty() {
        return Err(AppError::Invalid("the command can't be empty".into()));
    }
    let config = state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))?;
    let before = find_action(&config, &action)
        .ok_or_else(|| AppError::NotFound(format!("action `{}` not found", action.action_id)))?
        .clone();
    let label = label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| before.label.clone());
    let path = state.config.path().clone();
    let mut edited = std::fs::read_to_string(&path)?;
    let team = config
        .server(&action.server_id)
        .and_then(|s| s.team.clone());
    let section = shared_section_of(
        &edited,
        team.as_deref(),
        &action.action_id,
        action.app_id.is_some(),
    )
    .map(|(_, s)| s)
    .unwrap_or_else(|| section_of(before.kind, action.app_id.as_deref()));
    // "Everywhere": the shared entry it comes from (its team's, or global).
    let shared_in = match run_source(
        &edited,
        &action.server_id,
        action.app_id.as_deref(),
        team.as_deref(),
        &action.action_id,
        section,
    ) {
        RunSource::Shared(t, _) if everywhere => Some(t),
        _ => None,
    };
    let changes = [
        ("label", label != before.label, yaml_quote(&label)),
        ("run", run != before.run, yaml_quote(&run)),
    ];
    for (key, changed, value) in changes {
        if !changed {
            continue;
        }
        edited = if let Some(t) = &shared_in {
            set_shared_action_key(
                &edited,
                t.as_deref(),
                section,
                &action.action_id,
                key,
                &value,
            )
        } else {
            set_action_key(
                &edited,
                &action.server_id,
                action.app_id.as_deref(),
                &action.action_id,
                key,
                Some(&value),
            )
        }
        .map_err(AppError::Invalid)?;
    }

    let out = super::validate::parse(&edited);
    if let Some(e) = out.errors.first() {
        return Err(AppError::Invalid(format!("not saved: {}", e.message)));
    }
    let config = out.config.ok_or_else(|| {
        AppError::Invalid("Kemudi couldn't save this change automatically".into())
    })?;
    let after = find_action(&config, &action);
    if !after.is_some_and(|a| a.run == run && a.label == label && a.kind == before.kind) {
        return Err(AppError::Invalid(
            "Kemudi couldn't save this change automatically".into(),
        ));
    }
    save(&app, &state, &path, &edited)
}

/// Mark an action as danger or not, for this server/app only. Prefers
/// dropping `danger:` when that already gives the wanted value (so the file
/// stays as small as it was), else writes it explicitly.
#[tauri::command]
pub async fn action_set_danger(
    app: AppHandle,
    state: State<'_, AppState>,
    action: ActionRef,
    danger: bool,
) -> AppResult<Snapshot> {
    let config = state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))?;
    let before = find_action(&config, &action)
        .ok_or_else(|| AppError::NotFound(format!("action `{}` not found", action.action_id)))?
        .clone();
    let path = state.config.path().clone();
    let source = std::fs::read_to_string(&path)?;
    let edit = |value: Option<&str>| {
        set_action_key(
            &source,
            &action.server_id,
            action.app_id.as_deref(),
            &action.action_id,
            "danger",
            value,
        )
    };
    // Only `danger` may change; anything else means the edit went wrong.
    let check = |edited: &str| -> bool {
        let out = super::validate::parse(edited);
        out.errors.is_empty()
            && out
                .config
                .as_ref()
                .and_then(|c| find_action(c, &action))
                .is_some_and(|a| {
                    a.danger == danger
                        && a.run == before.run
                        && a.kind == before.kind
                        && a.confirm == before.confirm
                        && a.label == before.label
                })
    };
    let removed = edit(None).ok().filter(|e| check(e));
    let edited = match removed {
        Some(e) => e,
        None => edit(Some(if danger { "true" } else { "false" }))
            .ok()
            .filter(|e| check(e))
            .ok_or_else(|| {
                AppError::Invalid("Kemudi couldn't save this change automatically".into())
            })?,
    };
    save(&app, &state, &path, &edited)
}

fn find_action<'c>(config: &'c Config, r: &ActionRef) -> Option<&'c Action> {
    let server = config.server(&r.server_id)?;
    let list = match &r.app_id {
        Some(a) => &server.app(a)?.actions,
        None => &server.actions,
    };
    list.iter().find(|a| a.id == r.action_id)
}
