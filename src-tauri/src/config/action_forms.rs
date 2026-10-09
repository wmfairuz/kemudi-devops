//! Add and remove actions from the UI (the Actions panel): on one app or
//! server, or in the shared lists. Same rules as the other forms: minimal
//! line edits, then the result must parse cleanly and resolve as asked.

use serde::Deserialize;
use tauri::{AppHandle, State};

use super::commands::save;
use super::locate::{
    add_action, override_has_run, remove_action, set_action_key, shared_section_of, yaml_quote,
    yaml_scalar, ActionList, Section,
};
use super::schema::{Action, ActionKind, Config};
use super::Snapshot;
use crate::actions::commands::ActionRef;
use crate::error::{AppError, AppResult};
use crate::AppState;

/// Where a new action goes.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActionScope {
    #[serde(rename_all = "camelCase")]
    App { server_id: String, app_id: String },
    #[serde(rename_all = "camelCase")]
    Server { server_id: String },
    /// Every app (`actions.app`, or `actions.local` when it runs locally).
    SharedApp,
    /// Every server (`actions.server`).
    SharedServer,
    /// Every app on a team's servers (`teams[…].actions.app` / `.local`).
    #[serde(rename_all = "camelCase")]
    TeamApp { team_id: String },
    /// Every server in a team (`teams[…].actions.server`).
    #[serde(rename_all = "camelCase")]
    TeamServer { team_id: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAction {
    pub id: String,
    pub label: Option<String>,
    pub run: String,
    pub danger: bool,
    /// Run in a local tab on this Mac instead of over SSH (app actions).
    pub local: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoveMode {
    /// An action only this app/server has.
    Delete,
    /// Drop this app's/server's changes to a shared action.
    Reset,
    /// Hide a shared action here (`disabled: true`).
    Hide,
    /// Show a hidden shared action again.
    Unhide,
    /// Remove a shared action for every app/server.
    DeleteShared,
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Invalid(msg.into())
}

const BY_HAND: &str = "Kemudi couldn't save this change automatically";

fn loaded(state: &AppState) -> AppResult<Config> {
    state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))
}

fn checked(edited: &str, ok: impl Fn(&Config) -> bool) -> AppResult<()> {
    let out = super::validate::parse(edited);
    if let Some(e) = out.errors.first() {
        return Err(invalid(format!("not saved: {}", e.message)));
    }
    match out.config {
        Some(c) if ok(&c) => Ok(()),
        _ => Err(invalid(BY_HAND)),
    }
}

/// Every server's/app's actions and hidden ones, by family (apps or servers).
fn family(c: &Config, apps: bool) -> Vec<&Action> {
    team_family(c, apps, None)
}

/// Like `family`, for the servers of one team (or all, `None`).
fn team_family<'c>(c: &'c Config, apps: bool, team: Option<&str>) -> Vec<&'c Action> {
    c.servers
        .iter()
        .filter(|s| team.is_none_or(|t| s.team.as_deref() == Some(t)))
        .flat_map(|s| -> Vec<&Action> {
            if apps {
                s.apps
                    .iter()
                    .flat_map(|a| a.actions.iter().chain(&a.hidden))
                    .collect()
            } else {
                s.actions.iter().chain(&s.hidden).collect()
            }
        })
        .collect()
}

fn scoped<'c>(c: &'c Config, server: &str, app: Option<&str>) -> Option<&'c Vec<Action>> {
    let s = c.server(server)?;
    Some(match app {
        Some(a) => &s.app(a)?.actions,
        None => &s.actions,
    })
}

#[tauri::command]
pub async fn action_add(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: ActionScope,
    action: NewAction,
) -> AppResult<Snapshot> {
    let id = action.id.trim().to_string();
    let run = action.run.trim_end().to_string();
    if id.is_empty() || run.trim().is_empty() {
        return Err(invalid("a name and a command are required"));
    }
    let label = action
        .label
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != id)
        .map(str::to_string);
    let config = loaded(&state)?;
    let taken = match &scope {
        ActionScope::App { server_id, app_id } => scoped(&config, server_id, Some(app_id))
            .ok_or_else(|| invalid("that app isn't in Kemudi"))?
            .iter()
            .any(|a| a.id == id),
        ActionScope::Server { server_id } => scoped(&config, server_id, None)
            .ok_or_else(|| invalid("that server isn't in Kemudi"))?
            .iter()
            .any(|a| a.id == id),
        ActionScope::SharedApp => family(&config, true)
            .iter()
            .any(|a| a.id == id && a.inherited),
        ActionScope::SharedServer => family(&config, false)
            .iter()
            .any(|a| a.id == id && a.inherited),
        ActionScope::TeamApp { team_id } | ActionScope::TeamServer { team_id } => {
            if !config.teams.iter().any(|t| &t.id == team_id) {
                return Err(invalid(format!("team `{team_id}` isn't in Kemudi")));
            }
            team_family(
                &config,
                matches!(scope, ActionScope::TeamApp { .. }),
                Some(team_id),
            )
            .iter()
            .any(|a| a.id == id && a.team.as_deref() == Some(team_id))
        }
    };
    if taken {
        return Err(invalid(format!(
            "there's already an action called `{id}` there"
        )));
    }

    let mut fields = vec![("id", yaml_scalar(&id))];
    if let Some(l) = &label {
        fields.push(("label", yaml_quote(l)));
    }
    fields.push(("run", yaml_quote(&run)));
    if action.danger {
        fields.push(("danger", "true".into()));
    }
    let local = action.local
        && !matches!(
            scope,
            ActionScope::Server { .. } | ActionScope::SharedServer | ActionScope::TeamServer { .. }
        );
    let list = match &scope {
        ActionScope::App { server_id, app_id } => {
            if local {
                fields.push(("local", "true".into()));
            }
            ActionList::Scope {
                server: server_id,
                app: Some(app_id),
            }
        }
        ActionScope::Server { server_id } => ActionList::Scope {
            server: server_id,
            app: None,
        },
        ActionScope::SharedApp => {
            ActionList::Global(if local { Section::Local } else { Section::App })
        }
        ActionScope::SharedServer => ActionList::Global(Section::Server),
        ActionScope::TeamApp { team_id } => {
            ActionList::Team(team_id, if local { Section::Local } else { Section::App })
        }
        ActionScope::TeamServer { team_id } => ActionList::Team(team_id, Section::Server),
    };
    let source = std::fs::read_to_string(state.config.path())?;
    let edited = add_action(&source, list, &fields).map_err(AppError::Invalid)?;
    let want_kind = if local {
        ActionKind::Local
    } else {
        ActionKind::Ssh
    };
    let label_is = label.clone().unwrap_or_else(|| id.clone());
    let matches = |a: &Action| {
        a.id == id
            && a.run == run
            && a.label == label_is
            && a.danger == action.danger
            && a.kind == want_kind
    };
    checked(&edited, |c| match &scope {
        ActionScope::App { server_id, app_id } => scoped(c, server_id, Some(app_id))
            .is_some_and(|l| l.iter().any(|a| matches(a) && !a.shared)),
        ActionScope::Server { server_id } => {
            scoped(c, server_id, None).is_some_and(|l| l.iter().any(|a| matches(a) && !a.shared))
        }
        // Every app/server that doesn't already override that id gets it.
        ActionScope::SharedApp => family(c, true)
            .iter()
            .filter(|a| a.id == id)
            .all(|a| !a.shared || matches(a)),
        ActionScope::SharedServer => family(c, false)
            .iter()
            .filter(|a| a.id == id)
            .all(|a| !a.shared || matches(a)),
        ActionScope::TeamApp { team_id } | ActionScope::TeamServer { team_id } => team_family(
            c,
            matches!(scope, ActionScope::TeamApp { .. }),
            Some(team_id),
        )
        .iter()
        .filter(|a| a.id == id)
        .all(|a| !a.shared || (matches(a) && a.team.as_deref() == Some(team_id))),
    })?;
    save(&app, &state, state.config.path(), &edited)
}

#[tauri::command]
pub async fn action_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    action: ActionRef,
    mode: RemoveMode,
) -> AppResult<Snapshot> {
    let ActionRef {
        server_id,
        app_id,
        action_id: id,
        ..
    } = action;
    let config = loaded(&state)?;
    let source = std::fs::read_to_string(state.config.path())?;
    let scope = ActionList::Scope {
        server: &server_id,
        app: app_id.as_deref(),
    };
    // DeleteShared: which list it went from (Some(team) or None = global).
    let mut deleted_from: Option<Option<String>> = None;
    let edited = match mode {
        RemoveMode::Delete | RemoveMode::Reset => remove_action(&source, scope, &id),
        RemoveMode::Hide => set_action_key(
            &source,
            &server_id,
            app_id.as_deref(),
            &id,
            "disabled",
            Some("true"),
        ),
        RemoveMode::Unhide => set_action_key(
            &source,
            &server_id,
            app_id.as_deref(),
            &id,
            "disabled",
            None,
        ),
        RemoveMode::DeleteShared => {
            let team = config.server(&server_id).and_then(|s| s.team.clone());
            let (from_team, section) =
                shared_section_of(&source, team.as_deref(), &id, app_id.is_some())
                    .ok_or_else(|| invalid(format!("`{id}` isn't a shared action")))?;
            let list = match from_team.as_deref() {
                Some(t) => ActionList::Team(t, section),
                None => ActionList::Global(section),
            };
            let mut src = remove_action(&source, list, &id).map_err(AppError::Invalid)?;
            deleted_from = Some(from_team.clone());
            // Per-app/server tweaks of it (confirm, label, disabled…) go too;
            // ones with their own command stay, as that app's own action.
            for s in config
                .servers
                .iter()
                .filter(|s| from_team.is_none() || s.team == from_team)
            {
                let targets: Vec<Option<&str>> = if app_id.is_some() {
                    s.apps.iter().map(|a| Some(a.id.as_str())).collect()
                } else {
                    vec![None]
                };
                for a in targets {
                    if override_has_run(&src, &s.id, a, &id) == Some(false) {
                        src = remove_action(
                            &src,
                            ActionList::Scope {
                                server: &s.id,
                                app: a,
                            },
                            &id,
                        )
                        .map_err(AppError::Invalid)?;
                    }
                }
            }
            Ok(src)
        }
    }
    .map_err(AppError::Invalid)?;

    let in_scope = |c: &Config| -> (Option<Action>, bool) {
        let s = c.server(&server_id);
        let (list, hidden) = match (&app_id, s) {
            (Some(a), Some(s)) => match s.app(a) {
                Some(a) => (&a.actions, &a.hidden),
                None => return (None, false),
            },
            (None, Some(s)) => (&s.actions, &s.hidden),
            _ => return (None, false),
        };
        (
            list.iter().find(|a| a.id == id).cloned(),
            hidden.iter().any(|a| a.id == id),
        )
    };
    checked(&edited, |c| {
        let (now, hidden) = in_scope(c);
        match mode {
            RemoveMode::Delete => now.is_none() && !hidden,
            RemoveMode::Reset => now.is_some_and(|a| a.shared),
            RemoveMode::Hide => now.is_none() && hidden,
            RemoveMode::Unhide => now.is_some() && !hidden,
            RemoveMode::DeleteShared => match &deleted_from {
                Some(Some(t)) => team_family(c, app_id.is_some(), Some(t))
                    .iter()
                    .all(|a| a.id != id || a.team.as_deref() != Some(t)),
                _ => family(c, app_id.is_some())
                    .iter()
                    .all(|a| a.id != id || !a.inherited || a.team.is_some()),
            },
        }
    })?;
    save(&app, &state, state.config.path(), &edited)
}
