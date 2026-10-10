//! Add, edit and delete servers and apps from the UI. Each save edits only
//! the lines it must (see `locate`), then must parse cleanly and resolve to
//! exactly what the form asked for before it's written.

use serde::Deserialize;
use tauri::{AppHandle, State};

use super::commands::save;
use super::locate::{
    add_app, add_server, add_team, delete_entity, delete_team, delete_workflow, move_app,
    move_server, set_entity_field, set_server_block, set_team_block, set_team_field, set_workflow,
    yaml_quote, yaml_scalar,
};
use super::schema::{Config, Env, HostPort, TabColor, Vpn};
use super::Snapshot;
use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerForm {
    pub id: String,
    pub name: Option<String>,
    /// Its team (None: no team).
    #[serde(default)]
    pub team: Option<String>,
    pub host: String,
    pub env: Env,
    pub vpn: Vpn,
    pub vpn_check: Option<HostPort>,
    pub vpn_connect: Option<String>,
    pub check: Option<HostPort>,
    #[serde(default)]
    pub color: Option<TabColor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppForm {
    pub id: String,
    pub name: Option<String>,
    pub path: String,
    pub branch: Option<String>,
    pub php: Option<String>,
    #[serde(default)]
    pub color: Option<TabColor>,
    /// None: the same as the server.
    #[serde(default)]
    pub env: Option<Env>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub vhost_files: Vec<String>,
    #[serde(default)]
    pub supervisor_files: Vec<String>,
}

/// Trimmed, or None when blank.
fn opt(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn host_port(h: &HostPort) -> String {
    format!(
        "{{ host: {}, port: {} }}",
        yaml_scalar(h.host.trim()),
        h.port
    )
}

fn vpn_str(v: Vpn) -> &'static str {
    match v {
        Vpn::None => "none",
        Vpn::Openfortivpn => "openfortivpn",
        Vpn::Globalprotect => "globalprotect",
    }
}

/// The server's keys as they should be in the file (`None` = absent).
fn server_fields(f: &ServerForm) -> Vec<(&'static str, Option<String>)> {
    let id = f.id.trim();
    let vpn = f.vpn != Vpn::None;
    vec![
        (
            "name",
            opt(&f.name).filter(|n| n != id).map(|n| yaml_scalar(&n)),
        ),
        ("team", opt(&f.team).map(|t| yaml_scalar(&t))),
        ("host", Some(yaml_scalar(f.host.trim()))),
        ("env", Some(f.env.as_str().to_string())),
        ("vpn", vpn.then(|| vpn_str(f.vpn).to_string())),
        (
            "vpn_check",
            f.vpn_check.as_ref().filter(|_| vpn).map(host_port),
        ),
        (
            "vpn_connect",
            opt(&f.vpn_connect).filter(|_| vpn).map(|c| yaml_scalar(&c)),
        ),
        ("check", f.check.as_ref().map(host_port)),
        ("color", f.color.map(|c| c.as_str().to_string())),
    ]
}

/// `["/a", "/b"]` (a one-line YAML list), or None when empty.
fn file_list(files: &[String]) -> Option<String> {
    let files: Vec<String> = files
        .iter()
        .map(|f| f.trim())
        .filter(|f| !f.is_empty())
        .map(yaml_quote)
        .collect();
    (!files.is_empty()).then(|| format!("[{}]", files.join(", ")))
}

fn clean_files(files: &[String]) -> Vec<String> {
    files
        .iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect()
}

fn app_fields(f: &AppForm) -> Vec<(&'static str, Option<String>)> {
    let id = f.id.trim();
    vec![
        (
            "name",
            opt(&f.name).filter(|n| n != id).map(|n| yaml_scalar(&n)),
        ),
        ("path", Some(yaml_scalar(f.path.trim()))),
        ("branch", opt(&f.branch).map(|b| yaml_scalar(&b))),
        ("php", opt(&f.php).map(|p| yaml_scalar(&p))),
        ("color", f.color.map(|c| c.as_str().to_string())),
        ("env", f.env.map(|e| e.as_str().to_string())),
        ("repo", opt(&f.repo).map(|r| yaml_scalar(&r))),
        (
            "url",
            opt(&f.url).map(|u| yaml_scalar(u.trim_end_matches('/'))),
        ),
        ("vhost_files", file_list(&f.vhost_files)),
        ("supervisor_files", file_list(&f.supervisor_files)),
    ]
}

/// The file to edit; a first server starts from the commented sample.
fn read(state: &AppState) -> AppResult<String> {
    match std::fs::read_to_string(state.config.path()) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(super::SAMPLE.to_string()),
        r => Ok(r?),
    }
}

/// Parse the edited file; refuse it when it has errors or doesn't hold what
/// the form asked for.
fn checked(edited: &str, ok: impl Fn(&Config) -> bool) -> AppResult<()> {
    let out = super::validate::parse(edited);
    if let Some(e) = out.errors.first() {
        return Err(AppError::Invalid(format!("not saved: {}", e.message)));
    }
    match out.config {
        Some(c) if ok(&c) => Ok(()),
        _ => Err(AppError::Invalid(
            "Kemudi couldn't save this change automatically".into(),
        )),
    }
}

fn required(value: &str, what: &str) -> AppResult<()> {
    if value.trim().is_empty() {
        return Err(AppError::Invalid(format!("{what} is required")));
    }
    Ok(())
}

/// Add a server (`original` None) or edit the one with id `original`.
#[tauri::command]
pub async fn server_save(
    app: AppHandle,
    state: State<'_, AppState>,
    original: Option<String>,
    server: ServerForm,
) -> AppResult<Snapshot> {
    required(&server.id, "An ID")?;
    required(&server.host, "The SSH host")?;
    let id = server.id.trim().to_string();
    let source = read(&state)?;
    let fields = server_fields(&server);
    let edited = match &original {
        None => {
            let mut all = vec![("id", yaml_scalar(&id))];
            all.extend(
                fields
                    .iter()
                    .filter_map(|(k, v)| v.clone().map(|v| (*k, v))),
            );
            add_server(&source, &all)
        }
        Some(orig) => fields
            .iter()
            .try_fold(source.clone(), |src, (k, v)| {
                set_entity_field(&src, orig, None, k, v.as_deref())
            })
            .and_then(|src| match orig == &id {
                true => Ok(src),
                false => set_entity_field(&src, orig, None, "id", Some(&yaml_scalar(&id))),
            }),
    }
    .map_err(AppError::Invalid)?;
    let vpn = server.vpn != Vpn::None;
    checked(&edited, |c| {
        c.server(&id).is_some_and(|s| {
            s.host == server.host.trim()
                && s.env == server.env
                && s.vpn == server.vpn
                && s.name == opt(&server.name).unwrap_or_else(|| id.clone())
                && s.check
                    == server.check.clone().map(|h| HostPort {
                        host: h.host.trim().into(),
                        ..h
                    })
                && s.vpn_check
                    == server.vpn_check.clone().filter(|_| vpn).map(|h| HostPort {
                        host: h.host.trim().into(),
                        ..h
                    })
                && s.vpn_connect == opt(&server.vpn_connect).filter(|_| vpn)
                && s.color == server.color
                && s.team == opt(&server.team)
        }) && original
            .as_ref()
            .is_none_or(|o| o == &id || c.server(o).is_none())
    })?;
    save(&app, &state, state.config.path(), &edited)
}

#[tauri::command]
pub async fn server_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Snapshot> {
    let edited = delete_entity(&read(&state)?, &id, None).map_err(AppError::Invalid)?;
    checked(&edited, |c| c.server(&id).is_none())?;
    save(&app, &state, state.config.path(), &edited)
}

/// Add an app to `server_id` (`original` None) or edit the one with id
/// `original`.
#[tauri::command]
pub async fn app_save(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    original: Option<String>,
    form: AppForm,
) -> AppResult<Snapshot> {
    required(&form.id, "An ID")?;
    required(&form.path, "The path")?;
    for f in form.vhost_files.iter().chain(&form.supervisor_files) {
        let f = f.trim();
        if !f.is_empty() && (!f.starts_with('/') || f.contains(['\n', '\r', '\0'])) {
            return Err(AppError::Invalid(format!(
                "{f:?}: config files need a full path (e.g. /etc/nginx/sites-enabled/app)"
            )));
        }
    }
    if let Some(r) = opt(&form.repo) {
        if crate::monitor::strip_credentials(&r) != r {
            return Err(AppError::Invalid(
                "that git remote has a username/token in it; Kemudi never stores secrets with an app, so leave it out".into(),
            ));
        }
    }
    if let Some(u) = opt(&form.url) {
        let rest = u
            .strip_prefix("https://")
            .or_else(|| u.strip_prefix("http://"));
        if rest.is_none_or(|r| r.is_empty() || r.contains(char::is_whitespace)) {
            return Err(AppError::Invalid(format!(
                "{u:?}: the URL needs to start with https:// or http://"
            )));
        }
        if crate::monitor::strip_credentials(&u) != u {
            return Err(AppError::Invalid(
                "that URL has a username/password in it; leave it out".into(),
            ));
        }
    }
    let id = form.id.trim().to_string();
    let source = read(&state)?;
    let fields = app_fields(&form);
    let edited = match &original {
        None => {
            let mut all = vec![("id", yaml_scalar(&id))];
            all.extend(
                fields
                    .iter()
                    .filter_map(|(k, v)| v.clone().map(|v| (*k, v))),
            );
            add_app(&source, &server_id, &all)
        }
        Some(orig) => fields
            .iter()
            .try_fold(source.clone(), |src, (k, v)| {
                set_entity_field(&src, &server_id, Some(orig), k, v.as_deref())
            })
            .and_then(|src| match orig == &id {
                true => Ok(src),
                false => {
                    set_entity_field(&src, &server_id, Some(orig), "id", Some(&yaml_scalar(&id)))
                }
            }),
    }
    .map_err(AppError::Invalid)?;
    checked(&edited, |c| {
        c.server(&server_id).is_some_and(|s| {
            s.app(&id).is_some_and(|a| {
                a.path == form.path.trim()
                    && a.name == opt(&form.name).unwrap_or_else(|| id.clone())
                    && a.branch == opt(&form.branch)
                    && a.php == opt(&form.php)
                    && a.color == form.color
                    && a.env_set == form.env.is_some()
                    && form.env.is_none_or(|e| a.env == e)
                    && a.repo == opt(&form.repo)
                    && a.url == opt(&form.url).map(|u| u.trim_end_matches('/').to_string())
                    && a.vhost_files == clean_files(&form.vhost_files)
                    && a.supervisor_files == clean_files(&form.supervisor_files)
            }) && original
                .as_ref()
                .is_none_or(|o| o == &id || s.app(o).is_none())
        })
    })?;
    save(&app, &state, state.config.path(), &edited)
}

#[tauri::command]
pub async fn app_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    id: String,
) -> AppResult<Snapshot> {
    let edited = delete_entity(&read(&state)?, &server_id, Some(&id)).map_err(AppError::Invalid)?;
    checked(&edited, |c| {
        c.server(&server_id).is_some_and(|s| s.app(&id).is_none())
    })?;
    save(&app, &state, state.config.path(), &edited)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamForm {
    pub id: String,
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<TabColor>,
}

/// Add a team (`original` None) or edit one. Renaming its id moves its
/// servers along.
#[tauri::command]
pub async fn team_save(
    app: AppHandle,
    state: State<'_, AppState>,
    original: Option<String>,
    team: TeamForm,
) -> AppResult<Snapshot> {
    required(&team.id, "An ID")?;
    let id = team.id.trim().to_string();
    let name = opt(&team.name).filter(|n| n != &id);
    let source = read(&state)?;
    let config = state.config.config();
    let edited = match &original {
        None => {
            let mut all = vec![("id", yaml_scalar(&id))];
            if let Some(n) = &name {
                all.push(("name", yaml_scalar(n)));
            }
            if let Some(c) = team.color {
                all.push(("color", c.as_str().to_string()));
            }
            add_team(&source, &all)
        }
        Some(orig) => {
            let mut src = set_team_field(
                &source,
                orig,
                "name",
                name.as_deref().map(yaml_scalar).as_deref(),
            );
            src =
                src.and_then(|s| set_team_field(&s, orig, "color", team.color.map(|c| c.as_str())));
            if orig != &id {
                src = src.and_then(|s| set_team_field(&s, orig, "id", Some(&yaml_scalar(&id))));
                // Its servers follow the new id.
                for s in config
                    .iter()
                    .flat_map(|c| c.servers.iter())
                    .filter(|s| s.team.as_deref() == Some(orig))
                {
                    src = src.and_then(|x| {
                        set_entity_field(&x, &s.id, None, "team", Some(&yaml_scalar(&id)))
                    });
                }
            }
            src
        }
    }
    .map_err(AppError::Invalid)?;
    checked(&edited, |c| {
        c.teams.iter().any(|t| {
            t.id == id
                && t.name == name.clone().unwrap_or_else(|| id.clone())
                && t.color == team.color
        }) && original
            .as_ref()
            .is_none_or(|o| o == &id || !c.teams.iter().any(|t| &t.id == o))
    })?;
    save(&app, &state, state.config.path(), &edited)
}

/// Delete a team: its servers stay, with no team; its shared actions go.
#[tauri::command]
pub async fn team_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Snapshot> {
    let source = read(&state)?;
    let mut src = Ok(source);
    if let Some(c) = state.config.config() {
        for s in c
            .servers
            .iter()
            .filter(|s| s.team.as_deref() == Some(id.as_str()))
        {
            src = src.and_then(|x| set_entity_field(&x, &s.id, None, "team", None));
        }
    }
    let edited = src
        .and_then(|s| delete_team(&s, &id))
        .map_err(AppError::Invalid)?;
    checked(&edited, |c| {
        !c.teams.iter().any(|t| t.id == id)
            && c.servers
                .iter()
                .all(|s| s.team.as_deref() != Some(id.as_str()))
    })?;
    save(&app, &state, state.config.path(), &edited)
}

/// Whose New app hooks.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum HookScope {
    Server { id: String },
    Team { id: String },
}

/// Text as the config reads it back: lines without trailing spaces, no
/// trailing blank lines.
fn hook_text(t: &str) -> String {
    t.trim_end()
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Save (or, blank, remove) a server's or team's New app hook (`before` /
/// `after`), written as a `|-` block.
#[tauri::command]
pub async fn new_app_hook_save(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: HookScope,
    which: String,
    text: Option<String>,
) -> AppResult<Snapshot> {
    let key = match which.as_str() {
        "before" => "new_app_before",
        "after" => "new_app_after",
        _ => return Err(AppError::Invalid("a hook is `before` or `after`".into())),
    };
    let text = text
        .map(|t| t.replace("\r\n", "\n"))
        .filter(|t| !t.trim().is_empty());
    let source = read(&state)?;
    let edited = match &scope {
        HookScope::Server { id } => set_server_block(&source, id, key, text.as_deref()),
        HookScope::Team { id } => set_team_block(&source, id, key, text.as_deref()),
    }
    .map_err(AppError::Invalid)?;
    let want = text.as_deref().map(hook_text);
    checked(&edited, |c| {
        let hooks = match &scope {
            HookScope::Server { id } => c.server(id).map(|s| &s.new_app),
            HookScope::Team { id } => c.teams.iter().find(|t| &t.id == id).map(|t| &t.new_app),
        };
        hooks.is_some_and(|h| {
            let got = if which == "before" {
                &h.before
            } else {
                &h.after
            };
            got.as_deref().map(hook_text) == want
        })
    })?;
    save(&app, &state, state.config.path(), &edited)
}

/// Move an app within its server's list (before `before`, or to the end), or
/// to another server. Only Kemudi's record moves; nothing on either server
/// changes. Returns its id (renamed `-2`… when the other server has it).
#[tauri::command]
pub async fn app_move(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    app_id: String,
    to_server: String,
    before: Option<String>,
) -> AppResult<String> {
    let source = read(&state)?;
    let current = super::validate::parse(&source)
        .config
        .ok_or_else(|| AppError::Invalid("fix the config's errors first".into()))?;
    let target = current
        .server(&to_server)
        .ok_or_else(|| AppError::NotFound(format!("server `{to_server}` isn't in Kemudi")))?;
    let new_id = (to_server != server_id && target.app(&app_id).is_some()).then(|| {
        (2..)
            .map(|n| format!("{app_id}-{n}"))
            .find(|id| target.app(id).is_none())
            .unwrap_or_default()
    });
    let edited = move_app(
        &source,
        &server_id,
        &app_id,
        &to_server,
        before.as_deref(),
        new_id.as_deref(),
    )
    .map_err(AppError::Invalid)?;
    let id = new_id.unwrap_or_else(|| app_id.clone());
    checked(&edited, |c| {
        let Some(t) = c.server(&to_server) else {
            return false;
        };
        let ids: Vec<&str> = t.apps.iter().map(|a| a.id.as_str()).collect();
        let Some(at) = ids.iter().position(|x| *x == id) else {
            return false;
        };
        let placed = match before.as_deref().filter(|b| *b != app_id) {
            Some(b) => ids.get(at + 1) == Some(&b),
            None => at + 1 == ids.len() || before.as_deref() == Some(app_id.as_str()),
        };
        placed
            && (to_server == server_id
                || c.server(&server_id)
                    .is_some_and(|s| s.app(&app_id).is_none()))
    })?;
    save(&app, &state, state.config.path(), &edited)?;
    Ok(id)
}

/// Move a server before `before` (None: to the end) in Kemudi's list.
#[tauri::command]
pub async fn server_move(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    before: Option<String>,
) -> AppResult<Snapshot> {
    let source = read(&state)?;
    let edited = move_server(&source, &server_id, before.as_deref()).map_err(AppError::Invalid)?;
    checked(&edited, |c| {
        let ids: Vec<&str> = c.servers.iter().map(|s| s.id.as_str()).collect();
        let Some(at) = ids.iter().position(|x| *x == server_id) else {
            return false;
        };
        match before.as_deref().filter(|b| *b != server_id) {
            Some(b) => ids.get(at + 1) == Some(&b),
            None => before.is_some() || at + 1 == ids.len(),
        }
    })?;
    save(&app, &state, state.config.path(), &edited)
}

/// A workflow as the editor sends it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowForm {
    pub id: String,
    pub name: String,
    pub pin_server: Option<String>,
    pub pin_app: Option<String>,
    #[serde(default)]
    pub view: super::schema::WorkflowView,
    pub steps: Vec<StepForm>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepForm {
    pub label: Option<String>,
    #[serde(flatten)]
    pub kind: StepFormKind,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StepFormKind {
    Local {
        run: String,
        dir: Option<String>,
    },
    Server {
        server: String,
        run: String,
        root: bool,
        dir: Option<String>,
    },
    Action {
        server: String,
        app: Option<String>,
        action: String,
    },
    Pause {
        text: String,
    },
}

/// The workflow as YAML lines (dash at column 0).
fn workflow_yaml(f: &WorkflowForm) -> Vec<String> {
    let q = |s: &str| yaml_scalar(s.trim());
    let mut out = vec![
        format!("- id: {}", q(&f.id)),
        format!("  name: {}", q(&f.name)),
    ];
    if let Some(s) = opt(&f.pin_server) {
        match opt(&f.pin_app) {
            Some(a) => out.push(format!("  pin: {{ server: {}, app: {} }}", q(&s), q(&a))),
            None => out.push(format!("  pin: {{ server: {} }}", q(&s))),
        }
    }
    if f.view == super::schema::WorkflowView::Terminal {
        out.push("  view: terminal".into());
    }
    out.push("  steps:".into());
    for st in &f.steps {
        let mut fields: Vec<(&str, String)> = Vec::new();
        if let Some(l) = opt(&st.label) {
            fields.push(("label", q(&l)));
        }
        match &st.kind {
            StepFormKind::Local { run, dir } => {
                fields.push(("local", q(run)));
                if let Some(d) = opt(dir) {
                    fields.push(("dir", q(&d)));
                }
            }
            StepFormKind::Server {
                server,
                run,
                root,
                dir,
            } => {
                fields.push(("server", q(server)));
                if *root {
                    fields.push(("root", "true".into()));
                }
                if let Some(d) = opt(dir) {
                    fields.push(("dir", q(&d)));
                }
                fields.push(("run", q(run)));
            }
            StepFormKind::Action {
                server,
                app,
                action,
            } => {
                fields.push(("action", q(action)));
                fields.push(("server", q(server)));
                if let Some(a) = opt(app) {
                    fields.push(("app", q(&a)));
                }
            }
            StepFormKind::Pause { text } => {
                let t = if text.trim().is_empty() {
                    "Continue?"
                } else {
                    text.as_str()
                };
                fields.push(("pause", q(t)));
            }
        }
        for (i, (k, v)) in fields.iter().enumerate() {
            let lead = if i == 0 { "    - " } else { "      " };
            out.push(format!("{lead}{k}: {v}"));
        }
    }
    out
}

/// Add (`original` None) or replace a workflow.
#[tauri::command]
pub async fn workflow_save(
    app: AppHandle,
    state: State<'_, AppState>,
    original: Option<String>,
    form: WorkflowForm,
) -> AppResult<Snapshot> {
    required(&form.id, "An ID")?;
    required(&form.name, "A name")?;
    if form.steps.is_empty() {
        return Err(AppError::Invalid("add at least one step".into()));
    }
    for (i, st) in form.steps.iter().enumerate() {
        let n = i + 1;
        let empty = |s: &str| s.trim().is_empty();
        let bad = match &st.kind {
            StepFormKind::Local { run, .. } => empty(run).then_some("needs a command"),
            StepFormKind::Server { server, run, .. } => {
                (empty(server) || empty(run)).then_some("needs a server and a command")
            }
            StepFormKind::Action { server, action, .. } => {
                (empty(server) || empty(action)).then_some("needs an action")
            }
            StepFormKind::Pause { .. } => None,
        };
        if let Some(why) = bad {
            return Err(AppError::Invalid(format!("step {n} {why}")));
        }
    }
    let id = form.id.trim().to_string();
    let source = read(&state)?;
    let edited = set_workflow(&source, original.as_deref(), &workflow_yaml(&form))
        .map_err(AppError::Invalid)?;
    checked(&edited, |c| {
        c.workflows.iter().filter(|w| w.id == id).count() == 1
            && c.workflows
                .iter()
                .find(|w| w.id == id)
                .is_some_and(|w| w.name == form.name.trim() && w.steps.len() == form.steps.len())
            && original
                .as_ref()
                .is_none_or(|o| o == &id || c.workflows.iter().all(|w| &w.id != o))
    })?;
    save(&app, &state, state.config.path(), &edited)
}

#[tauri::command]
pub async fn workflow_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Snapshot> {
    let source = read(&state)?;
    let edited = delete_workflow(&source, &id).map_err(AppError::Invalid)?;
    checked(&edited, |c| c.workflows.iter().all(|w| w.id != id))?;
    save(&app, &state, state.config.path(), &edited)
}

#[cfg(test)]
mod workflow_tests {
    use super::*;

    #[test]
    fn workflow_yaml_round_trips() {
        let form = WorkflowForm {
            id: "ship".into(),
            name: "Ship it: \"now\"".into(),
            pin_server: Some("stg".into()),
            pin_app: Some("shop".into()),
            view: crate::config::schema::WorkflowView::Terminal,
            steps: vec![
                StepForm {
                    label: Some("Merge & push".into()),
                    kind: StepFormKind::Local {
                        run: "git pull && git merge origin/main --no-edit && git push".into(),
                        dir: Some("~/work/shop".into()),
                    },
                },
                StepForm {
                    label: None,
                    kind: StepFormKind::Server {
                        server: "stg".into(),
                        run: "deploy /opt/www/app".into(),
                        root: true,
                        dir: None,
                    },
                },
                StepForm {
                    label: None,
                    kind: StepFormKind::Pause {
                        text: String::new(),
                    },
                },
            ],
        };
        let src = "servers:\n  - id: stg\n    host: stg\n    env: staging\n    apps:\n      - { id: shop, path: /x }\n";
        let out = set_workflow(src, None, &workflow_yaml(&form)).expect("add");
        let c = super::super::validate::parse(&out);
        assert!(
            c.errors.is_empty() && c.warnings.is_empty(),
            "{:?} {:?}\n{out}",
            c.errors,
            c.warnings
        );
        let c = c.config.expect("config");
        let w = &c.workflows[0];
        assert_eq!(w.name, "Ship it: \"now\"");
        assert_eq!(w.pin_app.as_deref(), Some("shop"));
        assert_eq!(w.view, crate::config::schema::WorkflowView::Terminal);
        assert_eq!(w.steps.len(), 3);
        assert!(matches!(
            &w.steps[1].kind,
            crate::config::schema::StepKind::Server { root: true, .. }
        ));
        // Replace, then delete.
        let mut form2 = form;
        form2.steps.truncate(1);
        let out2 = set_workflow(&out, Some("ship"), &workflow_yaml(&form2)).expect("replace");
        let c2 = super::super::validate::parse(&out2).config.expect("c2");
        assert_eq!(c2.workflows[0].steps.len(), 1);
        let out3 = delete_workflow(&out2, "ship").expect("delete");
        assert!(!out3.contains("workflows:"), "{out3}");
        assert!(super::super::validate::parse(&out3)
            .config
            .expect("c3")
            .workflows
            .is_empty());
    }
}
