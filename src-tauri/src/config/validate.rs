//! Parse + validate servers.yaml into the resolved model, collecting
//! diagnostics with line numbers wherever they can be found.

use std::collections::{BTreeMap, HashSet};

use serde::Serialize;

use super::schema::*;
use crate::actions::render;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diag {
    pub message: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
    /// Where in the file, e.g. `servers[1].apps[0]`.
    pub path: Option<String>,
    /// "Did you mean …?" for unknown fields.
    pub suggestion: Option<String>,
}

impl Diag {
    fn new(message: impl Into<String>) -> Self {
        Diag {
            message: message.into(),
            line: None,
            column: None,
            path: None,
            suggestion: None,
        }
    }
    fn at(mut self, line: Option<usize>) -> Self {
        self.line = line;
        self
    }
    fn path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
}

#[derive(Debug, Default)]
pub struct Outcome {
    /// None when there are errors.
    pub config: Option<Config>,
    pub errors: Vec<Diag>,
    pub warnings: Vec<Diag>,
}

pub fn parse(source: &str) -> Outcome {
    let raw: RawConfig = if source.trim().is_empty() {
        RawConfig {
            teams: vec![],
            servers: vec![],
            actions: RawActions::default(),
            terminal: TerminalSettings::default(),
            editor: None,
            workflows: vec![],
        }
    } else {
        match serde_norway::from_str(source) {
            Ok(raw) => raw,
            Err(e) => {
                return Outcome {
                    errors: vec![yaml_diag(&e)],
                    ..Outcome::default()
                }
            }
        }
    };
    let mut v = Validator {
        source,
        errors: vec![],
        warnings: vec![],
    };
    let mut config = v.resolve(raw);
    assign_lines(&mut config, source);
    Outcome {
        config: v.errors.is_empty().then_some(config),
        errors: v.errors,
        warnings: v.warnings,
    }
}

/// Record where each resolved action is defined, for "Edit in servers.yaml".
fn assign_lines(config: &mut Config, source: &str) {
    use super::locate::{action_line, Section};
    for s in &mut config.servers {
        let team = s.team.clone();
        for a in &mut s.actions {
            a.line = action_line(source, &s.id, None, team.as_deref(), &a.id, Section::Server);
        }
        for app in &mut s.apps {
            for a in &mut app.actions {
                let section = if a.kind == ActionKind::Local {
                    Section::Local
                } else {
                    Section::App
                };
                a.line = action_line(
                    source,
                    &s.id,
                    Some(&app.id),
                    team.as_deref(),
                    &a.id,
                    section,
                );
            }
        }
    }
}

/// Turn a serde_norway error into `unknown field `bracnh`` + line + "branch".
fn yaml_diag(e: &serde_norway::Error) -> Diag {
    let loc = e.location();
    let mut text = e.to_string();
    // Drop the trailing " at line X column Y"; we report it separately.
    if let Some(i) = text.rfind(" at line ") {
        text.truncate(i);
    }
    // serde prefixes the YAML path: "servers[0].apps[0]: unknown field …".
    let mut path = None;
    if let Some((p, rest)) = text.split_once(": ") {
        if !p.contains(' ') {
            path = Some(p.to_string());
            text = rest.to_string();
        }
    }
    let mut suggestion = None;
    if let Some((head, expected)) = text.split_once(", expected one of ") {
        let unknown = head.split('`').nth(1).unwrap_or_default().to_string();
        let options: Vec<&str> = expected.split('`').skip(1).step_by(2).collect();
        suggestion = closest(&unknown, &options).map(str::to_string);
        text = head.to_string();
    } else if let Some((head, _)) = text.split_once(", expected ") {
        if head.starts_with("unknown variant") {
            text = format!(
                "{head} (expected {})",
                text.split_once(", expected ").map_or("", |x| x.1)
            );
        }
    }
    Diag {
        message: text,
        line: loc.as_ref().map(|l| l.line()),
        column: loc.as_ref().map(|l| l.column()),
        path,
        suggestion,
    }
}

/// The option within edit distance 2 of `word`, if exactly one is closest.
fn closest<'a>(word: &str, options: &[&'a str]) -> Option<&'a str> {
    options
        .iter()
        .map(|o| (levenshtein(word, o), *o))
        .filter(|(d, _)| *d <= 2)
        .min_by_key(|(d, _)| *d)
        .map(|(_, o)| o)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let sub = prev[j] + usize::from(ca != *cb);
            cur.push(sub.min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Whether a line holds `key: value`, block (`- key: v`) or flow
/// (`{ a: 1, key: v }`) style. Good enough for ids and hosts, which never
/// contain commas.
pub(crate) fn line_has(line: &str, key: &str, value: &str) -> bool {
    let line = line.split(" #").next().unwrap_or(line);
    line.split([',', '{', '}']).any(|part| {
        let part = part.trim().trim_start_matches("- ").trim();
        part.strip_prefix(key)
            .and_then(|r| r.trim_start().strip_prefix(':'))
            .is_some_and(|v| v.trim().trim_matches(['"', '\'']) == value)
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

struct Validator<'s> {
    source: &'s str,
    errors: Vec<Diag>,
    warnings: Vec<Diag>,
}

impl Validator<'_> {
    /// 1-based line of the `nth` (0-based) line whose `key:` equals `value`.
    fn find(&self, key: &str, value: &str, nth: usize) -> Option<usize> {
        self.source
            .lines()
            .enumerate()
            .filter(|(_, line)| line_has(line, key, value))
            .nth(nth)
            .map(|(i, _)| i + 1)
    }

    /// New app hooks: blank is none; a template syntax error is an error.
    fn hooks(&mut self, before: Option<String>, after: Option<String>, path: &str) -> NewAppHooks {
        let mut check = |which: &str, h: Option<String>| {
            let h = h.filter(|h| !h.trim().is_empty())?;
            if let Err(e) = render::check_syntax(&h) {
                self.errors
                    .push(Diag::new(format!("new_app_{which}: {e}")).path(path));
            }
            Some(h)
        };
        NewAppHooks {
            before: check("before", before),
            after: check("after", after),
        }
    }

    fn error(&mut self, d: Diag) {
        self.errors.push(d);
    }

    fn resolve(&mut self, raw: RawConfig) -> Config {
        let shared = |mut v: Vec<Action>| {
            v.iter_mut().for_each(|a| {
                a.shared = true;
                a.inherited = true;
            });
            v
        };
        let globals_app =
            shared(self.resolve_globals(&raw.actions.app, ActionKind::Ssh, "actions.app"));
        let globals_local =
            shared(self.resolve_globals(&raw.actions.local, ActionKind::Local, "actions.local"));
        let globals_server =
            shared(self.resolve_globals(&raw.actions.server, ActionKind::Ssh, "actions.server"));

        // Teams and their shared lists (marked with the team).
        let mut teams: Vec<Team> = Vec::new();
        let mut team_lists: BTreeMap<String, (Vec<Action>, Vec<Action>)> = BTreeMap::new();
        for (ti, rt) in raw.teams.into_iter().enumerate() {
            let path = format!("teams[{ti}] ({})", rt.id);
            let line = self.find("id", &rt.id, 0);
            if !valid_id(&rt.id) {
                self.error(
                    Diag::new(format!(
                        "invalid team id {:?}: use letters, digits, - _ .",
                        rt.id
                    ))
                    .at(line)
                    .path(&path),
                );
                continue;
            }
            if teams.iter().any(|t| t.id == rt.id) {
                self.error(
                    Diag::new(format!("duplicate team id `{}`", rt.id))
                        .at(line)
                        .path(&path),
                );
                continue;
            }
            let mark = |mut v: Vec<Action>, team: &str| {
                v.iter_mut().for_each(|a| {
                    a.shared = true;
                    a.inherited = true;
                    a.team = Some(team.to_string());
                });
                v
            };
            let mut apps = mark(
                self.resolve_globals(
                    &rt.actions.app,
                    ActionKind::Ssh,
                    &format!("{path}.actions.app"),
                ),
                &rt.id,
            );
            apps.extend(mark(
                self.resolve_globals(
                    &rt.actions.local,
                    ActionKind::Local,
                    &format!("{path}.actions.local"),
                ),
                &rt.id,
            ));
            let servers = mark(
                self.resolve_globals(
                    &rt.actions.server,
                    ActionKind::Ssh,
                    &format!("{path}.actions.server"),
                ),
                &rt.id,
            );
            team_lists.insert(rt.id.clone(), (apps, servers));
            let new_app = self.hooks(rt.new_app_before, rt.new_app_after, &path);
            teams.push(Team {
                name: rt.name.unwrap_or_else(|| rt.id.clone()),
                id: rt.id,
                color: rt.color,
                new_app,
            });
        }
        // The global list, with a team's entries replacing the same ids.
        let merged = |base: &[Action], team: &[Action]| {
            let mut out = base.to_vec();
            for t in team {
                match out.iter().position(|a| a.id == t.id) {
                    Some(i) => out[i] = t.clone(),
                    None => out.push(t.clone()),
                }
            }
            out
        };

        let mut seen = HashSet::new();
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut servers = Vec::with_capacity(raw.servers.len());
        for (si, rs) in raw.servers.into_iter().enumerate() {
            let path = format!("servers[{si}] ({})", rs.id);
            let nth = {
                let n = counts.entry(rs.id.clone()).or_default();
                *n += 1;
                *n - 1
            };
            let line = self.find("id", &rs.id, nth);
            if !valid_id(&rs.id) {
                self.error(
                    Diag::new(format!(
                        "invalid server id {:?}: use letters, digits, - _ .",
                        rs.id
                    ))
                    .at(line)
                    .path(&path),
                );
            }
            if !seen.insert(rs.id.clone()) {
                self.error(
                    Diag::new(format!("duplicate server id `{}`", rs.id))
                        .at(line)
                        .path(&path),
                );
            }
            if crate::ssh::validate_host(&rs.host).is_err() {
                let l = self.find("host", &rs.host, 0);
                self.error(
                    Diag::new(format!(
                        "`host` must be an ssh alias or user@host, got {:?}",
                        rs.host
                    ))
                    .at(l)
                    .path(&path),
                );
            }
            if rs.vpn != Vpn::None && rs.vpn_check.is_none() {
                self.error(
                    Diag::new(
                        "servers with a `vpn` need `vpn_check: { host, port }` to tell if it's up",
                    )
                    .at(line)
                    .path(&path),
                );
            }
            if rs.vpn == Vpn::Openfortivpn
                && rs
                    .vpn_connect
                    .as_deref()
                    .is_none_or(|c| c.trim().is_empty())
            {
                self.error(
                    Diag::new("`vpn: openfortivpn` needs a `vpn_connect` command")
                        .at(line)
                        .path(&path),
                );
            }
            if let Some(t) = rs.team.as_deref() {
                if !team_lists.contains_key(t) {
                    let l = self.find("team", t, 0);
                    self.error(
                        Diag::new(format!("team `{t}` isn't in `teams:`"))
                            .at(l)
                            .path(&path),
                    );
                }
            }
            let (team_apps, team_servers) = rs
                .team
                .as_deref()
                .and_then(|t| team_lists.get(t))
                .cloned()
                .unwrap_or_default();
            let inherited_apps = merged(
                &globals_app
                    .iter()
                    .chain(&globals_local)
                    .cloned()
                    .collect::<Vec<_>>(),
                &team_apps,
            );
            let server_base = merged(&globals_server, &team_servers);
            servers.push(self.resolve_server(rs, &path, &inherited_apps, &server_base));
        }
        let workflows = self.resolve_workflows(raw.workflows, &servers);
        Config {
            teams,
            servers,
            terminal: raw.terminal,
            editor: raw.editor,
            workflows,
        }
    }

    /// Workflows: a bad step shape is an error; a step that names a server,
    /// app or action that isn't there is a warning (it can't run until fixed,
    /// but the rest of the config still loads).
    fn resolve_workflows(&mut self, raw: Vec<RawWorkflow>, servers: &[Server]) -> Vec<Workflow> {
        let mut out: Vec<Workflow> = Vec::new();
        for (wi, rw) in raw.into_iter().enumerate() {
            let path = format!("workflows[{wi}] ({})", rw.id);
            let line = self.find("id", &rw.id, 0);
            if !valid_id(&rw.id) {
                self.error(
                    Diag::new(format!("invalid workflow id {:?}", rw.id))
                        .at(line)
                        .path(&path),
                );
            }
            if out.iter().any(|w| w.id == rw.id) {
                self.error(
                    Diag::new(format!("duplicate workflow id `{}`", rw.id))
                        .at(line)
                        .path(&path),
                );
            }
            let warn =
                |this: &mut Self, m: String| this.warnings.push(Diag::new(m).at(line).path(&path));
            let (pin_server, pin_app) = match rw.pin {
                Some(p) => (Some(p.server), p.app),
                None => (None, None),
            };
            if let Some(s) = &pin_server {
                match servers.iter().find(|x| &x.id == s) {
                    None => warn(
                        self,
                        format!(
                            "workflow `{}` is pinned to `{s}`, which isn't a server",
                            rw.id
                        ),
                    ),
                    Some(srv) => {
                        if let Some(a) = &pin_app {
                            if srv.app(a).is_none() {
                                warn(
                                    self,
                                    format!(
                                        "workflow `{}` is pinned to app `{a}`, which isn't on {s}",
                                        rw.id
                                    ),
                                );
                            }
                        }
                    }
                }
            }
            let mut steps = Vec::new();
            for (si, st) in rw.steps.into_iter().enumerate() {
                let n = si + 1;
                let kinds = [
                    st.local.is_some(),
                    st.run.is_some(),
                    st.action.is_some(),
                    st.pause.is_some(),
                ]
                .iter()
                .filter(|x| **x)
                .count();
                if kinds != 1 {
                    self.error(
                        Diag::new(format!(
                            "workflow `{}` step {n}: give exactly one of `local`, `run`, `action` or `pause`",
                            rw.id
                        ))
                        .at(line)
                        .path(&path),
                    );
                    continue;
                }
                let server_of = |this: &mut Self, s: &Option<String>| -> Option<String> {
                    match s {
                        None => {
                            this.error(
                                Diag::new(format!(
                                    "workflow `{}` step {n}: which `server`?",
                                    rw.id
                                ))
                                .at(line)
                                .path(&path),
                            );
                            None
                        }
                        Some(s) => Some(s.clone()),
                    }
                };
                let kind = if let Some(cmd) = st.local {
                    StepKind::Local {
                        run: cmd,
                        dir: st.dir,
                    }
                } else if let Some(cmd) = st.run {
                    let Some(server) = server_of(self, &st.server) else {
                        continue;
                    };
                    if !servers.iter().any(|x| x.id == server) {
                        warn(
                            self,
                            format!("workflow `{}` step {n}: `{server}` isn't a server", rw.id),
                        );
                    }
                    StepKind::Server {
                        server,
                        run: cmd,
                        root: st.root,
                        dir: st.dir,
                    }
                } else if let Some(action) = st.action {
                    let Some(server) = server_of(self, &st.server) else {
                        continue;
                    };
                    let found = servers
                        .iter()
                        .find(|x| x.id == server)
                        .map(|srv| match &st.app {
                            Some(a) => srv
                                .app(a)
                                .map(|app| app.actions.iter().any(|x| x.id == action)),
                            None => Some(srv.actions.iter().any(|x| x.id == action)),
                        });
                    match found {
                        None => warn(
                            self,
                            format!("workflow `{}` step {n}: `{server}` isn't a server", rw.id),
                        ),
                        Some(None) => warn(
                            self,
                            format!(
                                "workflow `{}` step {n}: app `{}` isn't on {server}",
                                rw.id,
                                st.app.clone().unwrap_or_default()
                            ),
                        ),
                        Some(Some(false))
                            if crate::actions::commands::builtin(&action).is_none() =>
                        {
                            warn(
                                self,
                                format!(
                                    "workflow `{}` step {n}: there's no action `{action}` there",
                                    rw.id
                                ),
                            )
                        }
                        _ => {}
                    }
                    StepKind::Action {
                        server,
                        app: st.app,
                        action,
                    }
                } else {
                    StepKind::Pause {
                        text: st.pause.unwrap_or_default(),
                    }
                };
                steps.push(Step {
                    label: st.label.filter(|l| !l.trim().is_empty()),
                    kind,
                });
            }
            out.push(Workflow {
                name: rw.name.unwrap_or_else(|| rw.id.clone()),
                id: rw.id,
                pin_server,
                pin_app,
                steps,
                line,
            });
        }
        out
    }

    fn resolve_globals(&mut self, defs: &[ActionDef], kind: ActionKind, path: &str) -> Vec<Action> {
        let mut out: Vec<Action> = Vec::new();
        for d in defs {
            let line = self.find("id", &d.id, 0);
            if !valid_id(&d.id) {
                self.error(
                    Diag::new(format!("invalid action id {:?}", d.id))
                        .at(line)
                        .path(path),
                );
                continue;
            }
            if out.iter().any(|a| a.id == d.id) {
                self.error(
                    Diag::new(format!("duplicate action id `{}`", d.id))
                        .at(line)
                        .path(path),
                );
                continue;
            }
            let Some(run) = d.run.clone().filter(|r| !r.trim().is_empty()) else {
                self.error(
                    Diag::new(format!("action `{}` needs `run:`", d.id))
                        .at(line)
                        .path(path),
                );
                continue;
            };
            if let Err(e) = render::check_syntax(&run) {
                self.error(
                    Diag::new(format!("action `{}`: template error: {e}", d.id))
                        .at(line)
                        .path(path),
                );
                continue;
            }
            out.push(Action {
                id: d.id.clone(),
                label: d.label.clone().unwrap_or_else(|| d.id.clone()),
                run,
                shared: false,
                inherited: false,
                team: None,
                danger: d.danger.unwrap_or(false),
                confirm: d.confirm,
                kind,
                line: None,
            });
        }
        out
    }

    /// Apply per-server/per-app overrides (matched by id) to inherited actions.
    /// Returns the actions and the inherited ones hidden here.
    fn apply_overrides(
        &mut self,
        base: &[Action],
        overrides: &[ActionDef],
        path: &str,
    ) -> (Vec<Action>, Vec<Action>) {
        let mut out = base.to_vec();
        let mut hidden = Vec::new();
        for o in overrides {
            let line = self.find("id", &o.id, 0);
            if let Some(i) = out.iter().position(|a| a.id == o.id) {
                if o.disabled == Some(true) {
                    hidden.push(out.remove(i));
                    continue;
                }
                let a = &mut out[i];
                if let Some(l) = &o.label {
                    a.label = l.clone();
                }
                if let Some(d) = o.danger {
                    a.danger = d;
                }
                if o.confirm.is_some() {
                    a.confirm = o.confirm;
                }
                if let Some(local) = o.local {
                    a.kind = if local {
                        ActionKind::Local
                    } else {
                        ActionKind::Ssh
                    };
                }
                if let Some(r) = &o.run {
                    if let Err(e) = render::check_syntax(r) {
                        self.error(
                            Diag::new(format!("action `{}`: template error: {e}", o.id))
                                .at(line)
                                .path(path),
                        );
                        continue;
                    }
                    out[i].run = r.clone();
                    out[i].shared = false;
                }
            } else if o.disabled == Some(true) {
                self.warnings.push(
                    Diag::new(format!("`{}` disables an action that doesn't exist", o.id))
                        .at(line)
                        .path(path),
                );
            } else {
                let defs = std::slice::from_ref(o);
                let kind = if o.local == Some(true) {
                    ActionKind::Local
                } else {
                    ActionKind::Ssh
                };
                out.extend(self.resolve_globals(defs, kind, path));
            }
        }
        (out, hidden)
    }

    /// `inherited_apps`: the shared app (and local) actions its apps get,
    /// `server_base`: the shared server actions (global, then its team's).
    fn resolve_server(
        &mut self,
        rs: RawServer,
        path: &str,
        inherited_apps: &[Action],
        server_base: &[Action],
    ) -> Server {
        let (server_actions, server_hidden) = self.apply_overrides(server_base, &rs.actions, path);
        let new_app = self.hooks(rs.new_app_before, rs.new_app_after, path);
        let mut server = Server {
            name: rs.name.clone().unwrap_or_else(|| rs.id.clone()),
            team: rs.team.clone(),
            id: rs.id,
            host: rs.host,
            env: rs.env,
            vpn: rs.vpn,
            vpn_check: rs.vpn_check,
            vpn_connect: rs.vpn_connect,
            check: rs.check,
            color: rs.color,
            new_app,
            apps: Vec::new(),
            actions: server_actions,
            hidden: server_hidden,
        };
        // Hooks render with a made-up app, so mistakes show now.
        for (which, hook) in [
            ("before", &server.new_app.before),
            ("after", &server.new_app.after),
        ] {
            if let Some(h) = hook {
                if let Err(e) = crate::newapp::check_hook(h, &server) {
                    self.warnings.push(
                        Diag::new(format!("new_app_{which} on {}: {e}", server.id)).path(path),
                    );
                }
            }
        }
        // Server actions render without an app.
        for a in &server.actions {
            if let Err(e) = render::render(&a.run, &server, None) {
                let line = self.find("id", &a.id, 0);
                self.warnings.push(
                    Diag::new(format!("`{}` on {}: {e}", a.id, server.id))
                        .at(line)
                        .path(path),
                );
            }
        }

        let inherited: Vec<Action> = inherited_apps.to_vec();
        let mut seen = HashSet::new();
        for (ai, ra) in rs.apps.into_iter().enumerate() {
            let app_path = format!("{path}.apps[{ai}] ({})", ra.id);
            let line = self.find("id", &ra.id, 0);
            if !valid_id(&ra.id) {
                self.error(
                    Diag::new(format!("invalid app id {:?}", ra.id))
                        .at(line)
                        .path(&app_path),
                );
            }
            if !seen.insert(ra.id.clone()) {
                self.error(
                    Diag::new(format!("duplicate app id `{}` on {}", ra.id, server.id))
                        .at(line)
                        .path(&app_path),
                );
            }
            if ra.path.trim().is_empty() {
                self.error(
                    Diag::new(format!("app `{}` needs a `path`", ra.id))
                        .at(line)
                        .path(&app_path),
                );
            }
            let (actions, hidden) = self.apply_overrides(&inherited, &ra.actions, &app_path);
            let app = App {
                name: ra.name.unwrap_or_else(|| ra.id.clone()),
                id: ra.id,
                path: ra.path,
                branch: ra.branch,
                php: ra.php,
                color: ra.color,
                env: ra.env.unwrap_or(server.env),
                env_set: ra.env.is_some(),
                repo: ra.repo,
                url: ra.url,
                vhost_files: ra.vhost_files,
                supervisor_files: ra.supervisor_files,
                vars: ra.vars.into_iter().map(|(k, v)| (k, v.0)).collect(),
                actions,
                hidden,
            };
            // Catch undefined variables now rather than at click time.
            for a in &app.actions {
                if let Err(e) = render::render(&a.run, &server, Some(&app)) {
                    self.warnings.push(
                        Diag::new(format!("`{}` on {}/{}: {e}", a.id, server.id, app.id))
                            .at(line)
                            .path(&app_path),
                    );
                }
            }
            server.apps.push(app);
        }
        server
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BRIEF: &str = r#"
servers:
  - id: stg-svr03
    name: Staging 03
    host: stg-svr03            # ~/.ssh/config alias
    env: staging
    vpn: none
    apps:
      - id: akaun
        name: Akaun
        path: /var/www/akaun
        branch: develop
        php: "8.4"

  - id: client-prod-01
    name: Client Prod 01
    host: client-prod-01
    env: prod
    vpn: openfortivpn
    vpn_check: { host: 10.0.0.5, port: 22 }
    vpn_connect: sudo openfortivpn -c ~/.config/openfortivpn/client.conf
    apps: []

actions:
  app:
    - { id: pull,    label: "Git pull",   run: "cd {{ app.path }} && git pull origin {{ app.branch }}" }
    - { id: composer,label: "Composer install", run: "cd {{ app.path }} && composer install --no-dev -o" }
    - { id: migrate, label: "Migrate",    run: "cd {{ app.path }} && php{{ app.php }} artisan migrate --force", danger: true }
    - { id: optimize,label: "Clear & cache", run: "cd {{ app.path }} && php{{ app.php }} artisan optimize:clear && php{{ app.php }} artisan optimize" }
    - { id: log,     label: "Tail log",   run: "tail -f {{ app.path }}/storage/logs/laravel.log" }
  server:
    - { id: nginx,   label: "nginx -t && reload", run: "sudo nginx -t && sudo systemctl reload nginx", danger: true }
    - { id: queues,  label: "Restart queues", run: "sudo supervisorctl restart all", danger: true }
  local:
    - { id: deploy,  label: "Deploy (Deployer)", run: "cd ~/Projects/{{ app.id }} && dep deploy {{ server.env }}", danger: true }
"#;

    #[test]
    fn brief_example_parses() {
        let out = parse(BRIEF);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
        let c = out.config.expect("config");
        assert_eq!(c.servers.len(), 2);
        let stg = &c.servers[0];
        assert_eq!(stg.env, Env::Staging);
        let akaun = &stg.apps[0];
        assert_eq!(akaun.php.as_deref(), Some("8.4"));
        let ids: Vec<&str> = akaun.actions.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(
            ids,
            ["pull", "composer", "migrate", "optimize", "log", "deploy"]
        );
        assert_eq!(akaun.actions[5].kind, ActionKind::Local);
        assert!(akaun.actions[2].danger);
        let prod = &c.servers[1];
        assert_eq!(prod.vpn, Vpn::Openfortivpn);
        assert_eq!(
            prod.vpn_check,
            Some(HostPort {
                host: "10.0.0.5".into(),
                port: 22
            })
        );
        assert_eq!(prod.actions.len(), 2);
    }

    #[test]
    fn sample_file_parses_cleanly() {
        let out = parse(include_str!("sample.yaml"));
        assert!(
            out.errors.is_empty() && out.warnings.is_empty(),
            "{:?} {:?}",
            out.errors,
            out.warnings
        );
        assert!(out.config.is_some_and(|c| c.servers.is_empty()));
    }

    #[test]
    fn apps_can_have_their_own_env() {
        let out = parse(
            "servers:\n  - id: acme\n    host: acme-host\n    env: prod\n    apps:\n      - id: live\n        path: /opt/www/app\n      - id: stg\n        path: /opt/www/app-dev\n        env: staging\n      - id: qa\n        path: /opt/www/app-qa\n        env: qa\n",
        );
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let c = out.config.expect("config");
        let s = c.server("acme").expect("server");
        let env = |id: &str| s.app(id).map(|a| (a.env, a.env_set));
        assert_eq!(env("live"), Some((Env::Prod, false)));
        assert_eq!(env("stg"), Some((Env::Staging, true)));
        assert_eq!(env("qa"), Some((Env::Qa, true)));
    }

    #[test]
    fn empty_file_is_an_empty_config() {
        let out = parse("  \n# nothing yet\n");
        assert!(out.errors.is_empty());
        assert!(out.config.is_some());
    }

    #[test]
    fn unknown_field_has_line_and_suggestion() {
        let src = "servers:\n  - id: a\n    host: a\n    env: dev\n    apps:\n      - id: x\n        path: /x\n        bracnh: main\n";
        let out = parse(src);
        assert!(out.config.is_none());
        let d = &out.errors[0];
        assert_eq!(d.message, "unknown field `bracnh`");
        assert_eq!(d.line, Some(8));
        assert_eq!(d.suggestion.as_deref(), Some("branch"));
        assert_eq!(d.path.as_deref(), Some("servers[0].apps[0]"));
    }

    #[test]
    fn bad_enum_value() {
        let out = parse("servers:\n  - id: a\n    host: a\n    env: production\n");
        let d = &out.errors[0];
        assert!(
            d.message.contains("unknown variant `production`"),
            "{}",
            d.message
        );
        assert_eq!(d.line, Some(4));
    }

    #[test]
    fn php_as_number_is_accepted() {
        let out = parse("servers:\n  - id: a\n    host: a\n    env: dev\n    apps:\n      - { id: x, path: /x, php: 8.4 }\n");
        let c = out.config.expect("config");
        assert_eq!(c.servers[0].apps[0].php.as_deref(), Some("8.4"));
    }

    #[test]
    fn semantic_errors_with_lines() {
        let src = "\
servers:
  - id: a
    host: a
    env: dev
  - id: a
    host: -oProxyCommand=evil
    env: prod
    vpn: openfortivpn
";
        let out = parse(src);
        assert!(out.config.is_none());
        let msgs: Vec<(&str, Option<usize>)> = out
            .errors
            .iter()
            .map(|d| (d.message.as_str(), d.line))
            .collect();
        assert!(
            msgs.contains(&("duplicate server id `a`", Some(5))),
            "{msgs:?}"
        );
        assert!(
            msgs.iter()
                .any(|(m, l)| m.starts_with("`host` must be") && *l == Some(6)),
            "{msgs:?}"
        );
        assert!(
            msgs.iter().any(|(m, _)| m.contains("vpn_check")),
            "{msgs:?}"
        );
        assert!(
            msgs.iter().any(|(m, _)| m.contains("vpn_connect")),
            "{msgs:?}"
        );
    }

    #[test]
    fn overrides_merge_disable_and_add() {
        let src = r#"
servers:
  - id: s
    host: s
    env: dev
    actions:
      - { id: queues, disabled: true }
    apps:
      - id: a
        path: /a
        branch: main
        actions:
          - { id: pull, label: "Pull main" }
          - { id: migrate, disabled: true }
          - { id: seed, run: "cd {{ app.path }} && php artisan db:seed", danger: true }
          - { id: open, run: "open https://example.test/{{ app.id }}", local: true }
actions:
  app:
    - { id: pull, label: "Git pull", run: "git -C {{ app.path }} pull origin {{ app.branch }}" }
    - { id: migrate, run: "php artisan migrate", danger: true }
  server:
    - { id: nginx, run: "sudo nginx -t" }
    - { id: queues, run: "sudo supervisorctl restart all" }
"#;
        let out = parse(src);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let c = out.config.expect("config");
        let s = &c.servers[0];
        assert_eq!(
            s.actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            ["nginx"]
        );
        let a = &s.apps[0];
        let ids: Vec<(&str, &str)> = a
            .actions
            .iter()
            .map(|x| (x.id.as_str(), x.label.as_str()))
            .collect();
        assert_eq!(
            ids,
            [("pull", "Pull main"), ("seed", "seed"), ("open", "open")]
        );
        assert!(a.actions[1].danger);
        assert_eq!(a.actions[2].kind, ActionKind::Local);
        assert!(
            a.actions[0].run.starts_with("git -C"),
            "label override keeps the global run"
        );
    }

    #[test]
    fn shared_own_and_hidden_actions() {
        let src = "\
servers:
  - id: s
    host: s
    env: dev
    actions:
      - { id: nginx, disabled: true }
    apps:
      - id: a
        path: /a
        actions:
          - { id: pull, disabled: true }
          - { id: deploy, run: own-deploy }
          - { id: seed, run: seed-it }
          - { id: composer, label: Composer! }
actions:
  app:
    - { id: pull, run: git pull }
    - { id: composer, run: composer install }
  local:
    - { id: deploy, run: dep deploy }
  server:
    - { id: nginx, run: nginx -t }
    - { id: queues, run: supervisorctl restart all }
";
        let c = parse(src).config.expect("valid");
        let s = c.server("s").expect("server");
        let a = s.app("a").expect("app");
        let flags: Vec<(&str, bool)> = a
            .actions
            .iter()
            .map(|x| (x.id.as_str(), x.shared))
            .collect();
        // A label-only override still runs the shared command.
        assert_eq!(
            flags,
            [("composer", true), ("deploy", false), ("seed", false)]
        );
        assert_eq!(
            a.hidden.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            ["pull"]
        );
        assert_eq!(
            s.actions
                .iter()
                .map(|x| (x.id.as_str(), x.shared))
                .collect::<Vec<_>>(),
            [("queues", true)]
        );
        assert_eq!(
            s.hidden.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            ["nginx"]
        );
    }

    #[test]
    fn undefined_template_vars_are_warnings() {
        let src = r#"
servers:
  - id: s
    host: s
    env: dev
    apps:
      - { id: nobranch, path: /x }
actions:
  app:
    - { id: pull, run: "git pull origin {{ app.branch }}" }
  server:
    - { id: bad, run: "cd {{ app.path }}" }
"#;
        let out = parse(src);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(out.warnings.len(), 2, "{:?}", out.warnings);
        assert!(out.config.is_some());
    }

    #[test]
    fn template_syntax_error_is_an_error() {
        let out = parse("actions:\n  app:\n    - { id: x, run: \"cd {{ app.path }\" }\n");
        assert!(out.config.is_none());
        assert!(
            out.errors[0].message.contains("template error"),
            "{:?}",
            out.errors
        );
        assert_eq!(out.errors[0].line, Some(3));
    }

    #[test]
    fn missing_run_and_bad_ids() {
        let out = parse("actions:\n  app:\n    - { id: x }\n    - { id: \"bad id\", run: ls }\n");
        let msgs: Vec<&str> = out.errors.iter().map(|d| d.message.as_str()).collect();
        assert!(msgs.contains(&"action `x` needs `run:`"), "{msgs:?}");
        assert!(
            msgs.iter().any(|m| m.starts_with("invalid action id")),
            "{msgs:?}"
        );
    }

    #[test]
    fn actions_know_their_lines() {
        let src = "\
servers:
  - id: s
    host: s
    env: dev
    apps:
      - id: a
        path: /a
        actions:
          - { id: deploy, run: remote-deploy, local: false }
actions:
  app:
    - { id: pull, run: git pull }
  local:
    - { id: deploy, run: dep deploy }
";
        let c = parse(src).config.expect("config");
        let lines: Vec<(&str, Option<usize>)> = c.servers[0].apps[0]
            .actions
            .iter()
            .map(|a| (a.id.as_str(), a.line))
            .collect();
        assert_eq!(lines, [("pull", Some(12)), ("deploy", Some(9))]);
    }

    #[test]
    fn teams_share_actions() {
        let src = r#"
teams:
  - id: nw
    name: Northwind
    color: purple
    actions:
      app:
        - { id: pull, label: "Pull (team)", run: "cd {{ app.path }} && git pull --rebase" }
        - { id: seed, run: "cd {{ app.path }} && php artisan db:seed" }
      server:
        - { id: fpm, run: "sudo systemctl reload php8.4-fpm" }
servers:
  - id: a
    host: a
    env: staging
    team: nw
    apps:
      - { id: x, path: /x }
  - id: b
    host: b
    env: staging
    apps:
      - { id: y, path: /y }
actions:
  app:
    - { id: pull, run: "cd {{ app.path }} && git pull" }
  server:
    - { id: nginx, run: "sudo nginx -t" }
"#;
        let out = parse(src);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let c = out.config.unwrap();
        assert_eq!(c.teams.len(), 1);
        assert_eq!(c.teams[0].name, "Northwind");
        let a = c.server("a").unwrap();
        assert_eq!(a.team.as_deref(), Some("nw"));
        let x = a.app("x").unwrap();
        // The team's `pull` replaces the global one; `seed` is added.
        let pull = x.actions.iter().find(|a| a.id == "pull").unwrap();
        assert!(pull.run.contains("--rebase"));
        assert_eq!(pull.team.as_deref(), Some("nw"));
        assert!(pull.shared && pull.inherited);
        assert!(x.actions.iter().any(|a| a.id == "seed"));
        assert!(a.actions.iter().any(|a| a.id == "fpm" && a.team.is_some()));
        assert!(a
            .actions
            .iter()
            .any(|a| a.id == "nginx" && a.team.is_none()));
        // A server outside the team gets only the global ones.
        let y = c.server("b").unwrap().app("y").unwrap();
        let pull = y.actions.iter().find(|a| a.id == "pull").unwrap();
        assert!(!pull.run.contains("--rebase") && pull.team.is_none());
        assert!(!y.actions.iter().any(|a| a.id == "seed"));
    }

    #[test]
    fn unknown_team_is_an_error() {
        let out = parse("servers:\n  - id: a\n    host: a\n    env: dev\n    team: nope\n");
        assert!(
            out.errors
                .iter()
                .any(|e| e.message.contains("team `nope`") && e.line == Some(5)),
            "{:?}",
            out.errors
        );
    }

    #[test]
    fn edit_distance() {
        assert_eq!(levenshtein("bracnh", "branch"), 2);
        assert_eq!(closest("hots", &["host", "env", "apps"]), Some("host"));
        assert_eq!(closest("zzzzzz", &["host", "env"]), None);
    }
}

/// Validate a real config file without starting the app:
/// `KEMUDI_VALIDATE=~/.config/kemudi/servers.yaml cargo test validate_file -- --ignored --nocapture`
#[cfg(test)]
mod file_check {
    #[test]
    #[ignore]
    fn validate_file() {
        let Some(path) = std::env::var_os("KEMUDI_VALIDATE") else {
            return;
        };
        let source = std::fs::read_to_string(&path).expect("read KEMUDI_VALIDATE");
        let out = super::parse(&source);
        for d in out.errors.iter().chain(&out.warnings) {
            println!("line {:?}: {}", d.line, d.message);
        }
        if let Some(c) = &out.config {
            for s in &c.servers {
                let actions: Vec<&str> = s.actions.iter().map(|a| a.id.as_str()).collect();
                let apps: Vec<&str> = s.apps.iter().map(|a| a.id.as_str()).collect();
                println!(
                    "{} ({:?}, {}): server actions {actions:?}, apps {apps:?}",
                    s.id, s.env, s.host
                );
                for app in &s.apps {
                    for a in &app.actions {
                        let cmd = crate::actions::render::render(&a.run, s, Some(app))
                            .unwrap_or_else(|e| format!("<{e}>"));
                        println!(
                            "  {}/{} [{:?}] line {:?} {}: {cmd}",
                            s.id, app.id, a.kind, a.line, a.label
                        );
                    }
                }
            }
        }
        assert!(
            out.errors.is_empty() && out.warnings.is_empty(),
            "config has problems"
        );
    }
}
