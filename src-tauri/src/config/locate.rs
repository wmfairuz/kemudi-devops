//! Find (and minimally edit) where an action is defined in servers.yaml.
//! serde gives no spans, so this walks the file by indentation: servers →
//! server → apps → app → actions, falling back to the global `actions:`.
//! Edits touch only the lines they must, keeping comments and layout.

use super::validate::line_has;

struct Doc<'s> {
    lines: Vec<&'s str>,
}

/// A half-open range of 0-based line indexes.
type Range = (usize, usize);

fn indent(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn is_content(line: &str) -> bool {
    let t = line.trim_start();
    !t.is_empty() && !t.starts_with('#')
}

impl<'s> Doc<'s> {
    fn new(source: &'s str) -> Self {
        Doc {
            lines: source.lines().collect(),
        }
    }

    /// The lines nested under the key/item on line `at` (until a content line
    /// at the same or a smaller indent).
    fn body(&self, at: usize, limit: usize) -> Range {
        let base = indent(self.lines[at]);
        let end = (at + 1..limit)
            .find(|&i| is_content(self.lines[i]) && indent(self.lines[i]) <= base)
            .unwrap_or(limit);
        (at + 1, end)
    }

    /// `key:` among the direct children of `range` (the shallowest content
    /// lines), e.g. a server's own `actions:`, not its apps'.
    fn key(&self, range: Range, key: &str) -> Option<Range> {
        self.key_at(range, key).map(|(_, body)| body)
    }

    /// Like `key`, also returning the key's own line.
    fn key_at(&self, range: Range, key: &str) -> Option<(usize, Range)> {
        let (from, to) = range;
        let child = (from..to)
            .filter(|&i| is_content(self.lines[i]))
            .map(|i| self.item_indent(i))
            .min()?;
        let at = (from..to).find(|&i| {
            is_content(self.lines[i]) && self.item_indent(i) == child && {
                let t = self.lines[i].trim_start().trim_start_matches("- ");
                t.strip_prefix(key)
                    .is_some_and(|r| r.trim_start().starts_with(':'))
            }
        })?;
        Some((at, self.body(at, to)))
    }

    /// Last content line in a range.
    fn last_content(&self, range: Range) -> Option<usize> {
        (range.0..range.1)
            .rev()
            .find(|&i| is_content(self.lines[i]))
    }

    /// Indent of a line's content, counting `- ` as indentation so a list
    /// item's first key lines up with its siblings.
    fn item_indent(&self, i: usize) -> usize {
        let l = self.lines[i];
        let t = l.trim_start();
        indent(l) + if t.starts_with("- ") { 2 } else { 0 }
    }

    /// The list item in `range` whose `id:` is `id` (block or flow style).
    fn item(&self, range: Range, id: &str) -> Option<(usize, Range)> {
        let (from, to) = range;
        let at = (from..to).find(|&i| {
            self.lines[i].trim_start().starts_with("- ") && line_has(self.lines[i], "id", id)
        })?;
        // A flow mapping is one line; a block item runs until the next item.
        let dash = indent(self.lines[at]);
        let end = (at + 1..to)
            .find(|&i| is_content(self.lines[i]) && indent(self.lines[i]) <= dash)
            .unwrap_or(to);
        Some((at, (at + 1, end)))
    }

    fn top(&self, key: &str) -> Option<Range> {
        self.key((0, self.lines.len()), key)
    }
}

/// Where in the global `actions:` an action lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    App,
    Server,
    Local,
}

impl Section {
    pub fn name(self) -> &'static str {
        match self {
            Section::App => "app",
            Section::Server => "server",
            Section::Local => "local",
        }
    }
}

/// The `teams:` item with this id.
fn team_item(doc: &Doc, team: &str) -> Option<(usize, Range)> {
    let teams = doc.top("teams")?;
    doc.item(teams, team)
}

/// A shared list: (its key line, its items), if it's there.
fn shared_list(doc: &Doc, team: Option<&str>, section: Section) -> Option<(usize, Range)> {
    let parent = match team {
        Some(t) => doc.key(team_item(doc, t)?.1, "actions")?,
        None => doc.top("actions")?,
    };
    doc.key_at(parent, section.name())
}

/// 1-based line of the action's definition: the most specific override
/// (app, then server), else its team's entry, else its global entry.
pub fn action_line(
    source: &str,
    server: &str,
    app: Option<&str>,
    team: Option<&str>,
    action: &str,
    section: Section,
) -> Option<usize> {
    let doc = Doc::new(source);
    let found = (|| {
        let servers = doc.top("servers")?;
        let (_, srv) = doc.item(servers, server)?;
        match app {
            Some(app) => {
                let apps = doc.key(srv, "apps")?;
                let (_, a) = doc.item(apps, app)?;
                let acts = doc.key(a, "actions")?;
                doc.item(acts, action).map(|(at, _)| at)
            }
            None => {
                let acts = doc.key(srv, "actions")?;
                doc.item(acts, action).map(|(at, _)| at)
            }
        }
    })();
    found
        .or_else(|| {
            let (_, list) = shared_list(&doc, team, section)?;
            doc.item(list, action).map(|(at, _)| at)
        })
        .or_else(|| {
            let (_, list) = shared_list(&doc, None, section)?;
            doc.item(list, action).map(|(at, _)| at)
        })
        .map(|i| i + 1)
}

/// Split `{ a: 1, b: "x, y" }` style text into its unquoted, comma-separated
/// parts (raw, whitespace kept).
fn split_flow(inner: &str) -> Vec<String> {
    let (mut parts, mut cur) = (Vec::new(), String::new());
    let (mut quote, mut depth) = (None::<char>, 0i32);
    for c in inner.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '[' | '{') => depth += 1,
            (None, ']' | '}') => depth -= 1,
            (None, ',') if depth == 0 => {
                parts.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    parts.push(cur);
    parts
}

/// Set (Some) or remove (None) `key:` in a one-line flow mapping item.
fn flow_set(line: &str, key: &str, value: Option<&str>) -> Option<String> {
    let open = line.find('{')?;
    let close = line.rfind('}')?;
    let inner = &line[open + 1..close];
    let body = inner.trim_end();
    let trail = &inner[body.len()..];
    let mut parts = split_flow(body);
    let pos = parts.iter().position(|p| {
        p.trim_start()
            .strip_prefix(key)
            .is_some_and(|r| r.trim_start().starts_with(':'))
    });
    match (pos, value) {
        (Some(i), Some(v)) => {
            let lead = parts[i].len() - parts[i].trim_start().len();
            parts[i] = format!("{}{key}: {v}", " ".repeat(lead.max(1)));
        }
        (Some(i), None) => {
            parts.remove(i);
        }
        (None, Some(v)) => parts.push(format!(" {key}: {v}")),
        (None, None) => {}
    }
    Some(format!(
        "{}{}{}{}",
        &line[..=open],
        parts.join(","),
        trail,
        &line[close..]
    ))
}

/// A flow item like `- { id: x }` with nothing but its id.
fn flow_is_only_id(line: &str) -> bool {
    let (Some(open), Some(close)) = (line.find('{'), line.rfind('}')) else {
        return false;
    };
    split_flow(&line[open + 1..close])
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .all(|p| {
            p.strip_prefix("id")
                .is_some_and(|r| r.trim_start().starts_with(':'))
        })
}

const HAND: &str = "Kemudi couldn't save this change automatically";

/// Set (`Some`) or remove (`None`) `confirm:` for one server's or app's
/// action, on its existing override or a new one. Returns the new file text.
pub fn set_action_confirm(
    source: &str,
    server: &str,
    app: Option<&str>,
    action: &str,
    value: Option<&str>,
) -> Result<String, String> {
    set_action_key(source, server, app, action, "confirm", value)
}

/// Set (`Some`, a YAML scalar as written) or remove (`None`) `key:` for one
/// server's or app's action, on its existing override or a new one.
pub fn set_action_key(
    source: &str,
    server: &str,
    app: Option<&str>,
    action: &str,
    key: &str,
    value: Option<&str>,
) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let (scope_at, scope) = scope_of(&doc, server, app)?;
    if doc.lines[scope_at].trim_start().starts_with("- {") {
        return Err(format!(
            "`{}` is written on one line; {HAND}",
            app.unwrap_or(server)
        ));
    }
    let pad = |n: usize| " ".repeat(n);
    let starts = |l: &str| starts_with_key(l, key);
    match doc.key_at(scope, "actions") {
        Some((key_at, acts)) => {
            if let Some((at, body)) = doc.item(acts, action) {
                if let Some(v) = value {
                    set_item_key(&doc, &mut lines, at, body, key, v)?;
                    return Ok(finish(lines, source));
                }
                let line = doc.lines[at];
                // Lines to drop when a reset leaves an override with nothing
                // but its id (so resetting undoes what setting created).
                let mut drop: Vec<usize> = Vec::new();
                if line.trim_start().starts_with("- {") {
                    let new = flow_set(line, key, None).ok_or(HAND)?;
                    if flow_is_only_id(&new) {
                        drop.push(at);
                    } else {
                        lines[at] = new;
                    }
                } else {
                    let child = doc.item_indent(at);
                    let existing = (body.0..body.1).find(|&i| {
                        indent(doc.lines[i]) == child && starts(doc.lines[i].trim_start())
                    });
                    if let Some(i) = existing {
                        drop.push(i);
                        let others = (body.0..body.1).any(|j| j != i && is_content(doc.lines[j]));
                        if !others && line_has(line, "id", action) && line.matches(':').count() == 1
                        {
                            drop.push(at);
                        }
                    }
                }
                // Removing the only override empties `actions:`: drop the key too.
                if drop.contains(&at) {
                    let rest =
                        (acts.0..acts.1).any(|j| is_content(doc.lines[j]) && !drop.contains(&j));
                    let inline = doc.lines[key_at].split_once(':').is_some_and(|(_, r)| {
                        let r = r.split(" #").next().unwrap_or("").trim();
                        !r.is_empty()
                    });
                    if !rest && !inline {
                        drop.push(key_at);
                    }
                }
                drop.sort_unstable();
                for i in drop.into_iter().rev() {
                    lines.remove(i);
                }
            } else if let Some(v) = value {
                let key_line = doc.lines[key_at];
                let inline = key_line
                    .split_once(':')
                    .map_or("", |x| x.1)
                    .split(" #")
                    .next()
                    .unwrap_or("")
                    .trim();
                match inline {
                    "" => {}
                    "[]" => lines[key_at] = format!("{}actions:", pad(indent(key_line))),
                    _ => return Err(format!("the `actions:` list is written inline; {HAND}")),
                }
                let dash = (acts.0..acts.1)
                    .find(|&i| is_content(doc.lines[i]))
                    .map_or(indent(key_line) + 2, |i| indent(doc.lines[i]));
                let after = doc.last_content(acts).unwrap_or(key_at);
                lines.insert(
                    after + 1,
                    format!("{}- {{ id: {action}, {key}: {v} }}", pad(dash)),
                );
            }
        }
        None => {
            if let Some(v) = value {
                let child = doc.item_indent(scope_at);
                let after = doc.last_content(scope).unwrap_or(scope_at);
                lines.insert(after + 1, format!("{}actions:", pad(child)));
                lines.insert(
                    after + 2,
                    format!("{}  - {{ id: {action}, {key}: {v} }}", pad(child)),
                );
            }
        }
    }
    Ok(finish(lines, source))
}

/// Set `key:` on a shared entry for `action`: a team's
/// `teams[…].actions.<section>`, or the global `actions.<section>`.
pub fn set_shared_action_key(
    source: &str,
    team: Option<&str>,
    section: Section,
    action: &str,
    key: &str,
    value: &str,
) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let name = section.name();
    let (at, body) = shared_list(&doc, team, section)
        .and_then(|(_, list)| doc.item(list, action))
        .ok_or_else(|| format!("`{action}` is not in the shared {name} actions"))?;
    set_item_key(&doc, &mut lines, at, body, key, value)?;
    Ok(finish(lines, source))
}

/// Where an action's `run:` comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunSource {
    /// The server's or app's own entry.
    Override,
    /// A shared entry (a team's, or the global `actions.<section>`), used
    /// by everything that doesn't override `run`.
    Shared(Option<String>, Section),
}

pub fn run_source(
    source: &str,
    server: &str,
    app: Option<&str>,
    team: Option<&str>,
    action: &str,
    section: Section,
) -> RunSource {
    let doc = Doc::new(source);
    let own = scope_of(&doc, server, app)
        .ok()
        .and_then(|(_, scope)| doc.key(scope, "actions"))
        .and_then(|acts| doc.item(acts, action))
        .is_some_and(|(at, body)| item_has_key(&doc, at, body, "run"));
    let in_list = |t: Option<&str>| {
        shared_list(&doc, t, section)
            .and_then(|(_, list)| doc.item(list, action))
            .is_some()
    };
    if own {
        RunSource::Override
    } else if team.is_some_and(|t| in_list(Some(t))) {
        RunSource::Shared(team.map(str::to_string), section)
    } else if in_list(None) {
        RunSource::Shared(None, section)
    } else {
        RunSource::Override
    }
}

/// A YAML double-quoted scalar for `s`, exact for any text.
pub fn yaml_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The server item, or the app item within it.
fn scope_of(doc: &Doc, server: &str, app: Option<&str>) -> Result<(usize, Range), String> {
    let servers = doc
        .top("servers")
        .ok_or("the server list is missing (no `servers:`)")?;
    let (srv_at, srv) = doc
        .item(servers, server)
        .ok_or_else(|| format!("server `{server}` not found"))?;
    match app {
        Some(app) => {
            let apps = doc
                .key(srv, "apps")
                .ok_or_else(|| format!("`{server}` has no apps"))?;
            doc.item(apps, app)
                .ok_or_else(|| format!("app `{app}` not found on `{server}`"))
        }
        None => Ok((srv_at, srv)),
    }
}

fn starts_with_key(text: &str, key: &str) -> bool {
    text.strip_prefix(key)
        .is_some_and(|r| r.trim_start().starts_with(':'))
}

fn item_has_key(doc: &Doc, at: usize, body: Range, key: &str) -> bool {
    let line = doc.lines[at];
    if line.trim_start().starts_with("- {") {
        let (Some(open), Some(close)) = (line.find('{'), line.rfind('}')) else {
            return false;
        };
        return split_flow(&line[open + 1..close])
            .iter()
            .any(|p| starts_with_key(p.trim_start(), key));
    }
    let child = doc.item_indent(at);
    starts_with_key(line.trim_start().trim_start_matches("- "), key)
        || (body.0..body.1).any(|i| {
            indent(doc.lines[i]) == child && starts_with_key(doc.lines[i].trim_start(), key)
        })
}

/// Set `key: value` on the list item at line `at` (flow or block style),
/// replacing a multi-line value if there is one.
fn set_item_key(
    doc: &Doc,
    lines: &mut Vec<String>,
    at: usize,
    body: Range,
    key: &str,
    value: &str,
) -> Result<(), String> {
    let line = doc.lines[at];
    if line.trim_start().starts_with("- {") {
        lines[at] = flow_set(line, key, Some(value)).ok_or(HAND)?;
        return Ok(());
    }
    let child = doc.item_indent(at);
    let on_dash = starts_with_key(line.trim_start().trim_start_matches("- "), key);
    let found = if on_dash {
        Some((at, format!("{}- ", " ".repeat(indent(line)))))
    } else {
        (body.0..body.1)
            .find(|&i| {
                indent(doc.lines[i]) == child && starts_with_key(doc.lines[i].trim_start(), key)
            })
            .map(|i| (i, " ".repeat(child)))
    };
    match found {
        Some((i, prefix)) => {
            // A block scalar or wrapped value continues on deeper lines.
            let end = (i + 1..body.1)
                .find(|&j| is_content(doc.lines[j]) && indent(doc.lines[j]) <= child)
                .unwrap_or(body.1);
            let last = (i + 1..end).rev().find(|&j| is_content(doc.lines[j]));
            lines[i] = format!("{prefix}{key}: {value}");
            if let Some(last) = last {
                lines.drain(i + 1..=last);
            }
        }
        None => lines.insert(at + 1, format!("{}{key}: {value}", " ".repeat(child))),
    }
    Ok(())
}

// ------------------------------------------------- servers and apps (forms)

/// Set (`Some`, a YAML scalar as written) or remove (`None`) `key:` on a
/// server item, or on an app item within it. New keys go before the item's
/// nested lists (`apps:`, `actions:`, `vars:`), else at its end.
pub fn set_entity_field(
    source: &str,
    server: &str,
    app: Option<&str>,
    key: &str,
    value: Option<&str>,
) -> Result<String, String> {
    let doc = Doc::new(source);
    let (at, body) = scope_of(&doc, server, app)?;
    set_field(&doc, source, at, body, key, value)
}

/// Set or remove `key:` on the list item at `at` (server, app or team).
fn set_field(
    doc: &Doc,
    source: &str,
    at: usize,
    body: Range,
    key: &str,
    value: Option<&str>,
) -> Result<String, String> {
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let line = doc.lines[at];
    if line.trim_start().starts_with("- {") {
        lines[at] = flow_set(line, key, value).ok_or(HAND)?;
        return Ok(finish(lines, source));
    }
    let child = doc.item_indent(at);
    match value {
        Some(v) if item_has_key(doc, at, body, key) => {
            set_item_key(doc, &mut lines, at, body, key, v)?
        }
        Some(v) => {
            let nested = (body.0..body.1).find(|&i| {
                let l = doc.lines[i];
                is_content(l) && indent(l) == child && value_part(l).is_empty()
            });
            let pos = nested.unwrap_or_else(|| doc.last_content(body).map_or(at + 1, |i| i + 1));
            lines.insert(pos, format!("{}{key}: {v}", " ".repeat(child)));
        }
        None => {
            if starts_with_key(line.trim_start().trim_start_matches("- "), key) {
                return Err(format!("`{key}` starts the entry; {HAND}"));
            }
            if let Some(i) = (body.0..body.1).find(|&i| {
                indent(doc.lines[i]) == child && starts_with_key(doc.lines[i].trim_start(), key)
            }) {
                let end = (i + 1..body.1)
                    .find(|&j| is_content(doc.lines[j]) && indent(doc.lines[j]) <= child)
                    .unwrap_or(body.1);
                let last = (i + 1..end)
                    .rev()
                    .find(|&j| is_content(doc.lines[j]))
                    .unwrap_or(i);
                lines.drain(i..=last);
            }
        }
    }
    Ok(finish(lines, source))
}

/// Append a server (`fields` in order, `id` first) to `servers:`.
pub fn add_server(source: &str, fields: &[(&str, String)]) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    match doc.key_at((0, doc.lines.len()), "servers") {
        Some((key_at, list)) => append_item(&doc, &mut lines, key_at, list, fields)?,
        None => {
            let mut block = vec!["servers:".to_string()];
            block.extend(item_lines(2, fields));
            block.push(String::new());
            lines.splice(0..0, block);
        }
    }
    Ok(finish(lines, source))
}

/// Append an app to a server's `apps:` (adding the key if needed).
pub fn add_app(source: &str, server: &str, fields: &[(&str, String)]) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let (srv_at, srv) = scope_of(&doc, server, None)?;
    if doc.lines[srv_at].trim_start().starts_with("- {") {
        return Err(format!("`{server}` is written on one line; {HAND}"));
    }
    match doc.key_at(srv, "apps") {
        Some((key_at, list)) => append_item(&doc, &mut lines, key_at, list, fields)?,
        None => {
            let child = doc.item_indent(srv_at);
            // Before the server's `actions:` if it has one, else at its end.
            let pos = doc
                .key_at(srv, "actions")
                .map(|(i, _)| i)
                .unwrap_or_else(|| doc.last_content(srv).map_or(srv_at + 1, |i| i + 1));
            let mut block = vec![format!("{}apps:", " ".repeat(child))];
            block.extend(item_lines(child + 2, fields));
            lines.splice(pos..pos, block);
        }
    }
    Ok(finish(lines, source))
}

/// Remove a server (with its apps) or an app. An emptied list becomes `[]`.
pub fn delete_entity(source: &str, server: &str, app: Option<&str>) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let (at, body) = scope_of(&doc, server, app)?;
    let (key_at, list) = match app {
        Some(_) => {
            let (_, srv) = scope_of(&doc, server, None)?;
            doc.key_at(srv, "apps").ok_or(HAND)?
        }
        None => doc.key_at((0, doc.lines.len()), "servers").ok_or(HAND)?,
    };
    remove_list_item(&doc, &mut lines, key_at, list, at, body, false);
    Ok(finish(lines, source))
}

/// Where an action list lives: a server's or app's `actions:`, or a global
/// `actions.<section>`.
#[derive(Debug, Clone, Copy)]
pub enum ActionList<'a> {
    Scope {
        server: &'a str,
        app: Option<&'a str>,
    },
    Global(Section),
    /// A team's shared `teams[…].actions.<section>`.
    Team(&'a str, Section),
}

/// Where to add a missing list key: line, indent, key name.
type NewKey<'a> = (usize, usize, &'a str);

/// Append a one-line action (`fields` in order, `id` first) to a list,
/// creating `actions:` (and the section) when missing.
pub fn add_action(
    source: &str,
    list: ActionList,
    fields: &[(&str, String)],
) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let item = format!(
        "- {{ {} }}",
        fields
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let pad = |n: usize| " ".repeat(n);
    // (the list's key line and range) or (where to insert a new key, its indent, its name)
    let (existing, create): (Option<(usize, Range)>, NewKey) = match list {
        ActionList::Scope { server, app } => {
            let (at, scope) = scope_of(&doc, server, app)?;
            if doc.lines[at].trim_start().starts_with("- {") {
                return Err(format!(
                    "`{}` is written on one line; {HAND}",
                    app.unwrap_or(server)
                ));
            }
            let pos = doc.last_content(scope).map_or(at + 1, |i| i + 1);
            (
                doc.key_at(scope, "actions"),
                (pos, doc.item_indent(at), "actions"),
            )
        }
        ActionList::Team(team, section) => {
            let (t_at, t) =
                team_item(&doc, team).ok_or_else(|| format!("team `{team}` not found"))?;
            if doc.lines[t_at].trim_start().starts_with("- {") {
                return Err(format!("team `{team}` is written on one line; {HAND}"));
            }
            match doc.key_at(t, "actions") {
                Some((g_at, g)) => {
                    let child = (g.0..g.1)
                        .find(|&i| is_content(doc.lines[i]))
                        .map_or(indent(doc.lines[g_at]) + 2, |i| indent(doc.lines[i]));
                    let pos = doc.last_content(g).map_or(g_at + 1, |i| i + 1);
                    (doc.key_at(g, section.name()), (pos, child, section.name()))
                }
                None => {
                    let child = doc.item_indent(t_at);
                    let pos = doc.last_content(t).map_or(t_at + 1, |i| i + 1);
                    lines.splice(
                        pos..pos,
                        [
                            format!("{}actions:", pad(child)),
                            format!("{}{}:", pad(child + 2), section.name()),
                            format!("{}{item}", pad(child + 4)),
                        ],
                    );
                    return Ok(finish(lines, source));
                }
            }
        }
        ActionList::Global(section) => match doc.key_at((0, doc.lines.len()), "actions") {
            Some((g_at, g)) => {
                let child = (g.0..g.1)
                    .find(|&i| is_content(doc.lines[i]))
                    .map_or(indent(doc.lines[g_at]) + 2, |i| indent(doc.lines[i]));
                let pos = doc.last_content(g).map_or(g_at + 1, |i| i + 1);
                (doc.key_at(g, section.name()), (pos, child, section.name()))
            }
            None => {
                let mut tail = vec![
                    String::new(),
                    "actions:".into(),
                    format!("  {}:", section.name()),
                ];
                tail.push(format!("    {item}"));
                while lines.last().is_some_and(|l| l.trim().is_empty()) {
                    lines.pop();
                }
                lines.extend(tail);
                return Ok(finish(lines, source));
            }
        },
    };
    match existing {
        Some((key_at, items)) => {
            let key_line = doc.lines[key_at];
            match value_part(key_line) {
                "" => {}
                "[]" => {
                    let name = key_line.trim_start().split(':').next().unwrap_or("");
                    lines[key_at] = format!("{}{name}:", pad(indent(key_line)));
                }
                _ => return Err(format!("the actions list is written inline; {HAND}")),
            }
            let dash = (items.0..items.1)
                .find(|&i| is_content(doc.lines[i]))
                .map_or(indent(key_line) + 2, |i| indent(doc.lines[i]));
            let after = doc.last_content(items).unwrap_or(key_at);
            lines.insert(after + 1, format!("{}{item}", pad(dash)));
        }
        None => {
            let (pos, child, name) = create;
            lines.splice(
                pos..pos,
                [
                    format!("{}{name}:", pad(child)),
                    format!("{}{item}", pad(child + 2)),
                ],
            );
        }
    }
    Ok(finish(lines, source))
}

/// Remove an action entry from a list. An emptied server/app `actions:` is
/// dropped; an emptied global section becomes `[]`.
pub fn remove_action(source: &str, list: ActionList, id: &str) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let (key_at, items, drop_key) = match list {
        ActionList::Scope { server, app } => {
            let (_, scope) = scope_of(&doc, server, app)?;
            let (k, r) = doc
                .key_at(scope, "actions")
                .ok_or_else(|| format!("no `{id}` here"))?;
            (k, r, true)
        }
        ActionList::Global(section) => {
            let g = doc
                .top("actions")
                .ok_or("there's no shared `actions:` list")?;
            let (k, r) = doc
                .key_at(g, section.name())
                .ok_or_else(|| format!("no actions.{}", section.name()))?;
            (k, r, false)
        }
        ActionList::Team(team, section) => {
            let (k, r) = shared_list(&doc, Some(team), section)
                .ok_or_else(|| format!("team `{team}` has no shared {} actions", section.name()))?;
            (k, r, false)
        }
    };
    let (at, body) = doc
        .item(items, id)
        .ok_or_else(|| format!("`{id}` isn't in this list"))?;
    remove_list_item(&doc, &mut lines, key_at, items, at, body, drop_key);
    Ok(finish(lines, source))
}

/// Remove the list item at `at` (through its last content line). When it
/// was the only one, the list's key becomes `key: []`, or goes (`drop_key`).
fn remove_list_item(
    doc: &Doc,
    lines: &mut Vec<String>,
    key_at: usize,
    list: Range,
    at: usize,
    body: Range,
    drop_key: bool,
) {
    let dash = indent(doc.lines[at]);
    let items = (list.0..list.1)
        .filter(|&i| {
            let l = doc.lines[i];
            is_content(l) && indent(l) == dash && l.trim_start().starts_with("- ")
        })
        .count();
    let last = doc.last_content(body).unwrap_or(at).max(at);
    lines.drain(at..=last);
    let key_line = doc.lines[key_at];
    if items == 1 && drop_key && value_part(key_line).is_empty() {
        // The key goes with its only entry; the lines around them stay.
        lines.remove(key_at);
        return;
    }
    // Don't leave two blank lines where the entry was.
    let blank = |i: usize, lines: &[String]| lines.get(i).is_none_or(|l| l.trim().is_empty());
    let after_gap = at == 0 || at - 1 == key_at || blank(at - 1, lines);
    if at < lines.len() && after_gap && blank(at, lines) {
        lines.remove(at);
    } else if at == lines.len() && at > 0 && at - 1 != key_at && blank(at - 1, lines) {
        lines.remove(at - 1);
    }
    if items == 1 {
        let name = key_line
            .trim_start()
            .trim_start_matches("- ")
            .split(':')
            .next()
            .unwrap_or("");
        let prefix = &key_line[..key_line.len() - key_line.trim_start().len()];
        let dashed = if key_line.trim_start().starts_with("- ") {
            "- "
        } else {
            ""
        };
        lines[key_at] = format!("{prefix}{dashed}{name}: []");
    }
}

/// Set (`Some`) or remove (`None`) `key:` in a top-level mapping such as
/// `terminal:`. The mapping is added at the end of the file when missing and
/// removed when its last key goes.
pub fn set_map_key(
    source: &str,
    map: &str,
    key: &str,
    value: Option<&str>,
) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let Some((at, body)) = doc.key_at((0, doc.lines.len()), map) else {
        if let Some(v) = value {
            while lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.pop();
            }
            lines.extend([String::new(), format!("{map}:"), format!("  {key}: {v}")]);
        }
        return Ok(finish(lines, source));
    };
    match value_part(doc.lines[at]) {
        "" => {}
        "{}" | "null" | "~" => lines[at] = format!("{map}:"),
        _ => return Err(format!("`{map}:` is written on one line; {HAND}")),
    }
    let child = (body.0..body.1)
        .find(|&i| is_content(doc.lines[i]))
        .map_or(2, |i| indent(doc.lines[i]));
    let existing = (body.0..body.1).find(|&i| {
        indent(doc.lines[i]) == child && starts_with_key(doc.lines[i].trim_start(), key)
    });
    // A value can continue on deeper lines (block scalars).
    let span = |i: usize| {
        let end = (i + 1..body.1)
            .find(|&j| is_content(doc.lines[j]) && indent(doc.lines[j]) <= child)
            .unwrap_or(body.1);
        (i + 1..end)
            .rev()
            .find(|&j| is_content(doc.lines[j]))
            .unwrap_or(i)
    };
    match (existing, value) {
        (Some(i), Some(v)) => {
            lines[i] = format!("{}{key}: {v}", " ".repeat(child));
            lines.drain(i + 1..=span(i));
        }
        (Some(i), None) => {
            let last = span(i);
            let others = (body.0..body.1).any(|j| (j < i || j > last) && is_content(doc.lines[j]));
            lines.drain(i..=last);
            if !others {
                lines.remove(at);
                if at > 0
                    && lines.get(at - 1).is_some_and(|l| l.trim().is_empty())
                    && lines.get(at).is_none_or(|l| l.trim().is_empty())
                {
                    lines.remove(at - 1);
                }
            }
        }
        (None, Some(v)) => {
            let pos = doc.last_content(body).map_or(at + 1, |i| i + 1);
            lines.insert(pos, format!("{}{key}: {v}", " ".repeat(child)));
        }
        (None, None) => {}
    }
    Ok(finish(lines, source))
}

/// Set (`Some`) or remove (`None`) a top-level `key: value` line.
pub fn set_top_key(source: &str, key: &str, value: Option<&str>) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    match (doc.key_at((0, doc.lines.len()), key), value) {
        (Some((at, body)), v) => {
            if (body.0..body.1).any(|i| is_content(doc.lines[i])) {
                return Err(format!("`{key}:` spans several lines; {HAND}"));
            }
            match v {
                Some(v) => lines[at] = format!("{key}: {v}"),
                None => {
                    lines.remove(at);
                    if at > 0
                        && lines.get(at - 1).is_some_and(|l| l.trim().is_empty())
                        && lines.get(at).is_none_or(|l| l.trim().is_empty())
                    {
                        lines.remove(at - 1);
                    }
                }
            }
        }
        (None, Some(v)) => {
            while lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.pop();
            }
            lines.extend([String::new(), format!("{key}: {v}")]);
        }
        (None, None) => {}
    }
    Ok(finish(lines, source))
}

/// Which shared list defines `id`: the team's (when given and it has it),
/// else the global one (`app` before `local` for apps).
pub fn shared_section_of(
    source: &str,
    team: Option<&str>,
    id: &str,
    app: bool,
) -> Option<(Option<String>, Section)> {
    let doc = Doc::new(source);
    let order: &[Section] = if app {
        &[Section::App, Section::Local]
    } else {
        &[Section::Server]
    };
    let find = |t: Option<&str>| {
        order.iter().copied().find(|s| {
            shared_list(&doc, t, *s)
                .and_then(|(_, l)| doc.item(l, id))
                .is_some()
        })
    };
    if let Some(t) = team {
        if let Some(s) = find(Some(t)) {
            return Some((Some(t.to_string()), s));
        }
    }
    find(None).map(|s| (None, s))
}

// ---------------------------------------------------------------- teams

/// Append a team (`fields` in order, `id` first) to `teams:`, which is
/// added before `servers:` when missing.
pub fn add_team(source: &str, fields: &[(&str, String)]) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    match doc.key_at((0, doc.lines.len()), "teams") {
        Some((key_at, list)) => append_item(&doc, &mut lines, key_at, list, fields)?,
        None => {
            let pos = doc
                .key_at((0, doc.lines.len()), "servers")
                .map_or(0, |(i, _)| i);
            let mut block = vec!["teams:".to_string()];
            block.extend(item_lines(2, fields));
            block.push(String::new());
            lines.splice(pos..pos, block);
        }
    }
    Ok(finish(lines, source))
}

/// Set or remove `key:` on a team (before its `actions:` when new).
pub fn set_team_field(
    source: &str,
    team: &str,
    key: &str,
    value: Option<&str>,
) -> Result<String, String> {
    let doc = Doc::new(source);
    let (at, body) = team_item(&doc, team).ok_or_else(|| format!("team `{team}` not found"))?;
    set_field(&doc, source, at, body, key, value)
}

/// A literal block (`|-`) for multi-line text under a key indented
/// `indent`; `|2-` when the text itself starts indented.
fn block_scalar(text: &str, indent: usize) -> String {
    let pad = " ".repeat(indent + 2);
    let lines: Vec<&str> = text.trim_end().lines().collect();
    let indented = lines
        .iter()
        .find(|l| !l.trim().is_empty())
        .is_some_and(|l| l.starts_with([' ', '\t']));
    let mut out = String::from(if indented { "|2-" } else { "|-" });
    for l in lines {
        out.push('\n');
        if !l.trim().is_empty() {
            out.push_str(&pad);
            out.push_str(l.trim_end());
        }
    }
    out
}

fn set_block(
    doc: &Doc,
    source: &str,
    at: usize,
    body: Range,
    key: &str,
    text: Option<&str>,
) -> Result<String, String> {
    if text.is_some() && doc.lines[at].trim_start().starts_with("- {") {
        return Err(format!(
            "{HAND}: that entry is written on one line ({{ … }})"
        ));
    }
    let value = text.map(|t| block_scalar(t, doc.item_indent(at)));
    set_field(doc, source, at, body, key, value.as_deref())
}

/// Set (as a `|-` block) or remove a multi-line `key:` on a server.
pub fn set_server_block(
    source: &str,
    server: &str,
    key: &str,
    text: Option<&str>,
) -> Result<String, String> {
    let doc = Doc::new(source);
    let (at, body) = scope_of(&doc, server, None)?;
    set_block(&doc, source, at, body, key, text)
}

/// Set (as a `|-` block) or remove a multi-line `key:` on a team.
pub fn set_team_block(
    source: &str,
    team: &str,
    key: &str,
    text: Option<&str>,
) -> Result<String, String> {
    let doc = Doc::new(source);
    let (at, body) = team_item(&doc, team).ok_or_else(|| format!("team `{team}` not found"))?;
    set_block(&doc, source, at, body, key, text)
}

/// Move app `app` of server `from` to server `to` (it may be the same),
/// before app `before` there, or at the end. The entry moves as written
/// (comments, its own actions); only its indentation changes. `new_id`
/// renames it on the way (its id is taken on `to`).
pub fn move_app(
    source: &str,
    from: &str,
    app: &str,
    to: &str,
    before: Option<&str>,
    new_id: Option<&str>,
) -> Result<String, String> {
    if from == to && before == Some(app) {
        return Ok(source.to_string());
    }
    let doc = Doc::new(source);
    let (_, srv) = scope_of(&doc, from, None)?;
    let (key_at, list) = doc
        .key_at(srv, "apps")
        .ok_or_else(|| format!("`{from}` has no apps"))?;
    let (at, body) = doc
        .item(list, app)
        .ok_or_else(|| format!("app `{app}` not found on `{from}`"))?;
    // The entry, relative to its dash (blank lines inside kept, trailing ones not).
    let dash = indent(doc.lines[at]);
    let last = doc.last_content(body).unwrap_or(at).max(at);
    let mut block: Vec<String> = doc.lines[at..=last]
        .iter()
        .map(|l| {
            if l.trim().is_empty() {
                String::new()
            } else {
                l.get(dash.min(indent(l))..).unwrap_or(l).to_string()
            }
        })
        .collect();
    if let Some(id) = new_id {
        rename_entry(&mut block, id)?;
    }
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    remove_list_item(&doc, &mut lines, key_at, list, at, body, true);
    let mid = finish(lines, source);

    let doc = Doc::new(&mid);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let (srv_at, srv) = scope_of(&doc, to, None)?;
    if doc.lines[srv_at].trim_start().starts_with("- {") {
        return Err(format!("`{to}` is written on one line; {HAND}"));
    }
    let place = |block: &[String], dash: usize| -> Vec<String> {
        block
            .iter()
            .map(|l| {
                if l.is_empty() {
                    String::new()
                } else {
                    format!("{}{l}", " ".repeat(dash))
                }
            })
            .collect()
    };
    match doc.key_at(srv, "apps") {
        Some((key_at, list)) => {
            let key_line = doc.lines[key_at];
            match value_part(key_line) {
                "" => {}
                "[]" => {
                    lines[key_at] = format!("{}apps:", " ".repeat(indent(key_line)));
                }
                _ => return Err(format!("`{to}`'s apps are written inline; {HAND}")),
            }
            let first = (list.0..list.1).find(|&i| is_content(doc.lines[i]));
            let dash = first.map_or(indent(key_line) + 2, |i| indent(doc.lines[i]));
            let spaced = first.is_some_and(|f| {
                let end = doc.last_content(list).unwrap_or(f);
                (f..end).any(|i| doc.lines[i].trim().is_empty())
            });
            let mut moved = place(&block, dash);
            match before.and_then(|b| doc.item(list, b)) {
                Some((pos, _)) => {
                    if spaced {
                        moved.push(String::new());
                    }
                    lines.splice(pos..pos, moved);
                }
                None => {
                    let after = doc.last_content(list).unwrap_or(key_at);
                    if spaced {
                        moved.insert(0, String::new());
                    }
                    lines.splice(after + 1..after + 1, moved);
                }
            }
        }
        None => {
            let child = doc.item_indent(srv_at);
            let pos = doc
                .key_at(srv, "actions")
                .map(|(i, _)| i)
                .unwrap_or_else(|| doc.last_content(srv).map_or(srv_at + 1, |i| i + 1));
            let mut moved = vec![format!("{}apps:", " ".repeat(child))];
            moved.extend(place(&block, child + 2));
            lines.splice(pos..pos, moved);
        }
    }
    Ok(finish(lines, source))
}

/// Move server `id` before server `before` (None: to the end). The entry
/// moves as written; comments above it stay where they are.
pub fn move_server(source: &str, id: &str, before: Option<&str>) -> Result<String, String> {
    if before == Some(id) {
        return Ok(source.to_string());
    }
    let doc = Doc::new(source);
    let (key_at, list) = doc
        .key_at((0, doc.lines.len()), "servers")
        .ok_or("the server list is missing (no `servers:`)")?;
    if !value_part(doc.lines[key_at]).is_empty() {
        return Err(format!("the server list is written inline; {HAND}"));
    }
    let (at, body) = doc
        .item(list, id)
        .ok_or_else(|| format!("server `{id}` not found"))?;
    let last = doc.last_content(body).unwrap_or(at).max(at);
    let block: Vec<String> = doc.lines[at..=last].iter().map(|l| l.to_string()).collect();
    let first = (list.0..list.1).find(|&i| is_content(doc.lines[i]));
    let spaced = first.is_some_and(|f| {
        let end = doc.last_content(list).unwrap_or(f);
        (f..end).any(|i| doc.lines[i].trim().is_empty())
    });
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    remove_list_item(&doc, &mut lines, key_at, list, at, body, false);
    let mid = finish(lines, source);

    let doc = Doc::new(&mid);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let (key_at, list) = doc
        .key_at((0, doc.lines.len()), "servers")
        .ok_or("the server list is missing (no `servers:`)")?;
    let mut moved = block;
    match before.and_then(|b| doc.item(list, b)) {
        Some((pos, _)) => {
            if spaced {
                moved.push(String::new());
            }
            lines.splice(pos..pos, moved);
        }
        None => {
            if value_part(doc.lines[key_at]) == "[]" {
                lines[key_at] = "servers:".into();
            }
            let after = doc.last_content(list).unwrap_or(key_at);
            if spaced {
                moved.insert(0, String::new());
            }
            lines.splice(after + 1..after + 1, moved);
        }
    }
    Ok(finish(lines, source))
}

/// Set `id:` in an entry's lines (relative to its dash).
fn rename_entry(block: &mut [String], id: &str) -> Result<(), String> {
    let value = yaml_scalar(id);
    let first = block.first().cloned().unwrap_or_default();
    if first.starts_with("- {") {
        block[0] = flow_set(&first, "id", Some(&value)).ok_or(HAND)?;
        return Ok(());
    }
    let i = block
        .iter()
        .position(|l| {
            let t = l.trim_start_matches("- ");
            l.len() - t.len() <= 2 && starts_with_key(t, "id")
        })
        .ok_or(HAND)?;
    let lead = block[i].len() - block[i].trim_start_matches("- ").len();
    block[i] = format!("{}id: {value}", &block[i][..lead]);
    Ok(())
}

/// Replace workflow `original` with `item` (lines with the dash at column
/// 0), or add it at the end of `workflows:` (made at the end of the file
/// when missing).
pub fn set_workflow(
    source: &str,
    original: Option<&str>,
    item: &[String],
) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let place = |dash: usize| -> Vec<String> {
        item.iter()
            .map(|l| {
                if l.is_empty() {
                    String::new()
                } else {
                    format!("{}{l}", " ".repeat(dash))
                }
            })
            .collect()
    };
    match doc.key_at((0, doc.lines.len()), "workflows") {
        Some((key_at, list)) => {
            let key_line = doc.lines[key_at];
            match value_part(key_line) {
                "" => {}
                "[]" => lines[key_at] = "workflows:".into(),
                _ => return Err(format!("the workflow list is written inline; {HAND}")),
            }
            let first = (list.0..list.1).find(|&i| is_content(doc.lines[i]));
            let dash = first.map_or(2, |i| indent(doc.lines[i]));
            match original.and_then(|id| doc.item(list, id)) {
                Some((at, body)) => {
                    let last = doc.last_content(body).unwrap_or(at).max(at);
                    lines.splice(at..=last, place(dash));
                }
                None if original.is_some() => {
                    return Err(format!(
                        "workflow `{}` not found",
                        original.unwrap_or_default()
                    ))
                }
                None => {
                    let after = doc.last_content(list).unwrap_or(key_at);
                    let mut block = place(dash);
                    if first.is_some() {
                        block.insert(0, String::new());
                    }
                    lines.splice(after + 1..after + 1, block);
                }
            }
        }
        None if original.is_some() => return Err("there are no workflows yet".into()),
        None => {
            while lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.pop();
            }
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push("workflows:".into());
            lines.extend(place(2));
        }
    }
    Ok(finish(lines, source))
}

/// Remove a workflow (and `workflows:` with its last one).
pub fn delete_workflow(source: &str, id: &str) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let (key_at, list) = doc
        .key_at((0, doc.lines.len()), "workflows")
        .ok_or("there are no workflows")?;
    let (at, body) = doc
        .item(list, id)
        .ok_or_else(|| format!("workflow `{id}` not found"))?;
    remove_list_item(&doc, &mut lines, key_at, list, at, body, true);
    Ok(finish(lines, source))
}

/// Remove a team (with its shared actions).
pub fn delete_team(source: &str, team: &str) -> Result<String, String> {
    let doc = Doc::new(source);
    let mut lines: Vec<String> = doc.lines.iter().map(|l| l.to_string()).collect();
    let (at, body) = team_item(&doc, team).ok_or_else(|| format!("team `{team}` not found"))?;
    let (key_at, list) = doc.key_at((0, doc.lines.len()), "teams").ok_or(HAND)?;
    remove_list_item(&doc, &mut lines, key_at, list, at, body, false);
    Ok(finish(lines, source))
}

/// Whether a server's/app's own entry for `id` sets `run` (None: no entry).
pub fn override_has_run(source: &str, server: &str, app: Option<&str>, id: &str) -> Option<bool> {
    let doc = Doc::new(source);
    let (_, scope) = scope_of(&doc, server, app).ok()?;
    let (at, body) = doc.item(doc.key(scope, "actions")?, id)?;
    Some(item_has_key(&doc, at, body, "run"))
}

/// A plain YAML scalar when that reads back as the same string, else quoted.
pub fn yaml_scalar(s: &str) -> String {
    let plain = s
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || "/~._".contains(c))
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/~._@+-".contains(c))
        && !matches!(
            s.to_ascii_lowercase().as_str(),
            "true"
                | "false"
                | "yes"
                | "no"
                | "on"
                | "off"
                | "null"
                | "y"
                | "n"
                | "~"
                | ".inf"
                | ".nan"
        );
    if plain {
        s.to_string()
    } else {
        yaml_quote(s)
    }
}

fn value_part(line: &str) -> &str {
    line.split_once(':')
        .map_or("", |(_, r)| r)
        .split(" #")
        .next()
        .unwrap_or("")
        .trim()
}

fn item_lines(dash: usize, fields: &[(&str, String)]) -> Vec<String> {
    fields
        .iter()
        .enumerate()
        .map(|(n, (k, v))| {
            let lead = if n == 0 {
                format!("{}- ", " ".repeat(dash))
            } else {
                " ".repeat(dash + 2)
            };
            format!("{lead}{k}: {v}")
        })
        .collect()
}

fn append_item(
    doc: &Doc,
    lines: &mut Vec<String>,
    key_at: usize,
    list: Range,
    fields: &[(&str, String)],
) -> Result<(), String> {
    let key_line = doc.lines[key_at];
    match value_part(key_line) {
        "" => {}
        "[]" => {
            let name = key_line.trim_start().split(':').next().unwrap_or("");
            lines[key_at] = format!("{}{name}:", " ".repeat(indent(key_line)));
        }
        _ => return Err(format!("the list is written inline; {HAND}")),
    }
    let first = (list.0..list.1).find(|&i| is_content(doc.lines[i]));
    let dash = first.map_or(indent(key_line) + 2, |i| indent(doc.lines[i]));
    let after = doc.last_content(list).unwrap_or(key_at);
    // Keep the file's style: blank lines between entries if it has them.
    let spaced = first.is_some_and(|f| {
        (f..after).any(|i| doc.lines[i].trim().is_empty())
            && (f..=after)
                .filter(|&i| {
                    indent(doc.lines[i]) == dash && doc.lines[i].trim_start().starts_with("- ")
                })
                .count()
                > 1
    });
    let mut block = Vec::new();
    if spaced {
        block.push(String::new());
    }
    block.extend(item_lines(dash, fields));
    lines.splice(after + 1..after + 1, block);
    Ok(())
}

fn finish(lines: Vec<String>, source: &str) -> String {
    let mut out = lines.join("\n");
    if source.ends_with('\n') {
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_servers() {
        let src = "servers:
  - id: a
    host: a
    env: staging

  # the prod ones
  - id: b
    host: b
    env: prod
    apps:
      - { id: x, path: /x }

  - { id: c, host: c, env: dev }
actions:
  server:
    - { id: up, run: uptime }
";
        let ids = |src: &str| -> Vec<String> {
            let c = crate::config::validate::parse(src);
            assert!(c.errors.is_empty(), "{:?}\n{src}", c.errors);
            c.config
                .expect("config")
                .servers
                .iter()
                .map(|s| s.id.clone())
                .collect()
        };
        let out = move_server(src, "c", Some("a")).expect("c first");
        assert_eq!(ids(&out), ["c", "a", "b"], "{out}");
        let out = move_server(src, "a", None).expect("a last");
        assert_eq!(ids(&out), ["b", "c", "a"], "{out}");
        assert!(out.contains("actions:\n  server:"), "the rest stays: {out}");
        let out = move_server(src, "b", Some("a")).expect("b first");
        assert_eq!(ids(&out), ["b", "a", "c"], "{out}");
        let c = crate::config::validate::parse(&out).config.expect("c");
        assert_eq!(c.server("b").expect("b").apps.len(), 1, "apps move with it");
        assert_eq!(move_server(src, "a", Some("a")).expect("same"), src);
    }

    #[test]
    fn moves_apps() {
        let src = "servers:
  - id: a
    host: a
    env: staging
    apps:
      - id: one
        path: /one
        # its own
        actions:
          - { id: pull, disabled: true }

      - id: two
        path: /two

      - { id: three, path: /three }
  - id: b
    host: b
    env: prod
  - id: c
    host: c
    env: dev
    apps:
      - id: one
        path: /c-one
";
        let ids = |src: &str, server: &str| -> Vec<String> {
            let c = crate::config::validate::parse(src);
            assert!(c.errors.is_empty(), "{:?}\n{src}", c.errors);
            let c = c.config.expect("config");
            c.server(server)
                .expect("server")
                .apps
                .iter()
                .map(|a| a.id.clone())
                .collect()
        };
        // Reorder: three before one.
        let out = move_app(src, "a", "three", "a", Some("one"), None).expect("reorder");
        assert_eq!(ids(&out, "a"), ["three", "one", "two"], "{out}");
        // To the end.
        let out = move_app(src, "a", "one", "a", None, None).expect("to end");
        assert_eq!(ids(&out, "a"), ["two", "three", "one"], "{out}");
        assert!(
            out.contains("        # its own\n        actions:"),
            "kept as written: {out}"
        );
        // To a server with no apps: gets `apps:`, one leaves a.
        let out = move_app(src, "a", "one", "b", None, None).expect("to b");
        assert_eq!(ids(&out, "a"), ["two", "three"]);
        assert_eq!(ids(&out, "b"), ["one"]);
        let c = crate::config::validate::parse(&out).config.expect("c");
        let one = c.server("b").expect("b").app("one").expect("one");
        assert_eq!(one.path, "/one");
        assert!(
            one.hidden.iter().any(|h| h.id == "pull") || one.actions.iter().all(|x| x.id != "pull")
        );
        // Onto a server that has the id: renamed.
        let out = move_app(src, "a", "one", "c", None, Some("one-2")).expect("to c");
        assert_eq!(ids(&out, "c"), ["one", "one-2"]);
        let out = move_app(src, "a", "three", "c", Some("one"), Some("three")).expect("flow");
        assert_eq!(ids(&out, "c"), ["three", "one"]);
        // The last app leaves: `apps:` goes too.
        let out = move_app(src, "c", "one", "b", None, None).expect("last");
        assert_eq!(ids(&out, "c"), Vec::<String>::new());
        assert_eq!(ids(&out, "b"), ["one"]);
    }

    #[test]
    fn hook_blocks_roundtrip() {
        let src = "teams:\n  - id: t\n    name: T\nservers:\n  - id: a\n    host: a\n    env: staging\n    apps:\n      - { id: x, path: /x }\n";
        let hook = "f=/etc/x; h={{ app.domain }}\nif true; then\n  echo \"$h\"  \n\n  printf '%s\\n' ok\nfi\n";
        let out = set_server_block(src, "a", "new_app_after", Some(hook)).expect("set");
        let out = set_team_block(&out, "t", "new_app_before", Some("  indented first\nline"))
            .expect("team");
        let c = crate::config::validate::parse(&out);
        assert!(c.errors.is_empty(), "{:?}\n{out}", c.errors);
        let c = c.config.expect("config");
        let after = c.servers[0].new_app.after.as_deref().expect("after");
        assert_eq!(
            after,
            "f=/etc/x; h={{ app.domain }}\nif true; then\n  echo \"$h\"\n\n  printf '%s\\n' ok\nfi"
        );
        assert_eq!(
            c.teams[0].new_app.before.as_deref(),
            Some("  indented first\nline")
        );
        assert_eq!(c.servers[0].apps.len(), 1, "apps kept");
        // Replace, then remove.
        let out2 = set_server_block(&out, "a", "new_app_after", Some("echo new")).expect("replace");
        let c2 = crate::config::validate::parse(&out2)
            .config
            .expect("config");
        assert_eq!(c2.servers[0].new_app.after.as_deref(), Some("echo new"));
        let out3 = set_server_block(&out2, "a", "new_app_after", None).expect("remove");
        let c3 = crate::config::validate::parse(&out3)
            .config
            .expect("config");
        assert!(c3.servers[0].new_app.after.is_none());
        assert_eq!(c3.servers[0].apps.len(), 1);
    }

    #[test]
    fn teams_add_edit_delete() {
        let src = "servers:\n  - id: a\n    host: a\n    env: dev\n";
        let t = add_team(src, &[("id", "nw".into()), ("name", "Northwind".into())]).unwrap();
        assert!(
            t.starts_with("teams:\n  - id: nw\n    name: Northwind\n\nservers:"),
            "{t}"
        );
        let t = add_team(&t, &[("id", "acme-host".into())]).unwrap();
        assert!(t.contains("  - id: acme-host\n"));
        let t = set_team_field(&t, "nw", "color", Some("purple")).unwrap();
        assert!(
            t.contains("    name: Northwind\n    color: purple\n"),
            "{t}"
        );
        // Team-shared actions: list created, then appended, then removed.
        let t = add_action(
            &t,
            ActionList::Team("nw", Section::App),
            &[("id", "pull".into()), ("run", "\"git pull\"".into())],
        )
        .unwrap();
        assert!(
            t.contains("    actions:\n      app:\n        - { id: pull, run: \"git pull\" }"),
            "{t}"
        );
        let t = add_action(
            &t,
            ActionList::Team("nw", Section::Server),
            &[("id", "fpm".into()), ("run", "x".into())],
        )
        .unwrap();
        assert!(
            t.contains("      server:\n        - { id: fpm, run: x }"),
            "{t}"
        );
        assert_eq!(
            shared_section_of(&t, Some("nw"), "pull", true),
            Some((Some("nw".into()), Section::App))
        );
        assert_eq!(shared_section_of(&t, Some("acme-host"), "pull", true), None);
        let t2 = set_shared_action_key(
            &t,
            Some("nw"),
            Section::App,
            "pull",
            "run",
            "\"git pull --rebase\"",
        )
        .unwrap();
        assert!(t2.contains("{ id: pull, run: \"git pull --rebase\" }"));
        let t = remove_action(&t, ActionList::Team("nw", Section::Server), "fpm").unwrap();
        assert!(t.contains("      server: []"), "{t}");
        let t = delete_team(&t, "nw").unwrap();
        assert!(!t.contains("nw") && t.contains("  - id: acme-host"), "{t}");
        assert!(super::super::validate::parse(&t).errors.is_empty());
    }

    const SRC: &str = "\
servers:
  - id: stg-web3
    host: stg-web3
    env: staging
    apps:
      - id: billing
        path: /opt/www/billing

  # comment between servers
  - id: novaos
    host: nova-gw
    env: prod
    actions:
      - { id: nginx, disabled: true }
    apps:
      - id: novaos
        path: /opt/www/app
        actions:
          - { id: deploy, run: deploynovaos, local: false }
      - id: crm
        path: /opt/www/crm
        actions:
          - id: deploy
            run: deploycrm

actions:
  app:
    - { id: pull, run: git pull }
    - { id: deploy, run: nope }
  server:
    - { id: nginx, run: nginx -t }
  local:
    - { id: deploy, run: dep deploy }
";

    #[test]
    fn app_override_wins() {
        assert_eq!(
            action_line(
                SRC,
                "novaos",
                Some("novaos"),
                None,
                "deploy",
                Section::Local
            ),
            Some(19)
        );
        assert_eq!(
            action_line(SRC, "novaos", Some("crm"), None, "deploy", Section::Local),
            Some(23)
        );
    }

    #[test]
    fn falls_back_to_global_section() {
        assert_eq!(
            action_line(SRC, "stg-web3", Some("billing"), None, "pull", Section::App),
            Some(28)
        );
        assert_eq!(
            action_line(
                SRC,
                "stg-web3",
                Some("billing"),
                None,
                "deploy",
                Section::Local
            ),
            Some(33)
        );
        assert_eq!(
            action_line(SRC, "novaos", Some("novaos"), None, "pull", Section::App),
            Some(28)
        );
    }

    #[test]
    fn server_actions_ignore_app_overrides() {
        // novaos's own `actions:` (line 14), not an app's.
        assert_eq!(
            action_line(SRC, "novaos", None, None, "nginx", Section::Server),
            Some(14)
        );
        assert_eq!(
            action_line(SRC, "stg-web3", None, None, "nginx", Section::Server),
            Some(31)
        );
    }

    #[test]
    fn flow_edits_keep_quoted_commas() {
        let l = r#"    - { id: deploy, run: "a, b && c", danger: true }  # note"#;
        assert_eq!(
            flow_set(l, "confirm", Some("warn")).as_deref(),
            Some(r#"    - { id: deploy, run: "a, b && c", danger: true, confirm: warn }  # note"#)
        );
        let set = r#"    - { id: deploy, confirm: type, run: x }"#;
        assert_eq!(
            flow_set(set, "confirm", Some("none")).as_deref(),
            Some(r#"    - { id: deploy, confirm: none, run: x }"#)
        );
        assert_eq!(
            flow_set(set, "confirm", None).as_deref(),
            Some(r#"    - { id: deploy, run: x }"#)
        );
    }

    fn confirm_of(
        src: &str,
        server: &str,
        app: Option<&str>,
        action: &str,
    ) -> Option<crate::config::schema::Confirm> {
        let c = crate::config::validate::parse(src)
            .config
            .expect("valid after edit");
        let s = c.server(server).expect("server");
        let list = match app {
            Some(a) => &s.app(a).expect("app").actions,
            None => &s.actions,
        };
        list.iter()
            .find(|a| a.id == action)
            .expect("action")
            .confirm
    }

    #[test]
    fn set_confirm_on_existing_flow_override() {
        use crate::config::schema::Confirm;
        let out = set_action_confirm(SRC, "novaos", Some("novaos"), "deploy", Some("warn"))
            .expect("edit");
        assert!(
            out.contains("- { id: deploy, run: deploynovaos, local: false, confirm: warn }"),
            "{out}"
        );
        assert_eq!(
            confirm_of(&out, "novaos", Some("novaos"), "deploy"),
            Some(Confirm::Warn)
        );
        // Everything else is untouched.
        assert_eq!(out.lines().count(), SRC.lines().count());
        let back =
            set_action_confirm(&out, "novaos", Some("novaos"), "deploy", None).expect("reset");
        assert_eq!(back, SRC);
    }

    #[test]
    fn set_confirm_on_block_override() {
        use crate::config::schema::Confirm;
        let out =
            set_action_confirm(SRC, "novaos", Some("crm"), "deploy", Some("type")).expect("edit");
        assert!(
            out.contains(
                "          - id: deploy\n            confirm: type\n            run: deploycrm"
            ),
            "{out}"
        );
        assert_eq!(
            confirm_of(&out, "novaos", Some("crm"), "deploy"),
            Some(Confirm::Type)
        );
        let again =
            set_action_confirm(&out, "novaos", Some("crm"), "deploy", Some("none")).expect("edit");
        assert_eq!(
            confirm_of(&again, "novaos", Some("crm"), "deploy"),
            Some(Confirm::None)
        );
        assert_eq!(
            set_action_confirm(&again, "novaos", Some("crm"), "deploy", None).expect("reset"),
            SRC
        );
    }

    #[test]
    fn creates_override_where_needed() {
        use crate::config::schema::Confirm;
        // App with an actions list but no entry for `pull`.
        let a =
            set_action_confirm(SRC, "novaos", Some("novaos"), "pull", Some("none")).expect("edit");
        assert!(a.contains("          - { id: deploy, run: deploynovaos, local: false }\n          - { id: pull, confirm: none }"), "{a}");
        assert_eq!(
            confirm_of(&a, "novaos", Some("novaos"), "pull"),
            Some(Confirm::None)
        );
        assert_eq!(
            set_action_confirm(&a, "novaos", Some("novaos"), "pull", None).expect("reset"),
            SRC
        );
        // App without `actions:` at all.
        let b = set_action_confirm(SRC, "stg-web3", Some("billing"), "pull", Some("warn"))
            .expect("edit");
        assert!(b.contains("        path: /opt/www/billing\n        actions:\n          - { id: pull, confirm: warn }"), "{b}");
        assert_eq!(
            confirm_of(&b, "stg-web3", Some("billing"), "pull"),
            Some(Confirm::Warn)
        );
        assert_eq!(
            set_action_confirm(&b, "stg-web3", Some("billing"), "pull", None).expect("reset"),
            SRC
        );
        // Server-level action, server has `actions:` already.
        let c = set_action_confirm(SRC, "novaos", None, "nginx", Some("type")).expect("edit");
        // novaos disables nginx; the edit lands on that override and it stays hidden.
        assert!(
            c.contains("- { id: nginx, disabled: true, confirm: type }"),
            "{c}"
        );
        let parsed = crate::config::validate::parse(&c).config.expect("valid");
        assert!(parsed
            .server("novaos")
            .is_some_and(|s| s.actions.iter().all(|a| a.id != "nginx")));
        let d = set_action_confirm(SRC, "stg-web3", None, "nginx", Some("type")).expect("edit");
        assert_eq!(
            confirm_of(&d, "stg-web3", None, "nginx"),
            Some(Confirm::Type)
        );
    }

    #[test]
    fn refuses_one_line_apps() {
        let src = "servers:\n  - id: s\n    host: s\n    env: dev\n    apps:\n      - { id: a, path: /a }\nactions:\n  app:\n    - { id: pull, run: git pull }\n";
        assert!(set_action_confirm(src, "s", Some("a"), "pull", Some("warn")).is_err());
    }

    #[test]
    fn missing_is_none() {
        assert_eq!(
            action_line(SRC, "nope", None, None, "zzz", Section::Server),
            None
        );
        assert_eq!(action_line("", "a", None, None, "b", Section::App), None);
    }

    fn run_of(src: &str, server: &str, app: Option<&str>, action: &str) -> String {
        let c = crate::config::validate::parse(src)
            .config
            .expect("valid after edit");
        let s = c.server(server).expect("server");
        let list = match app {
            Some(a) => &s.app(a).expect("app").actions,
            None => &s.actions,
        };
        list.iter()
            .find(|a| a.id == action)
            .expect("action")
            .run
            .clone()
    }

    #[test]
    fn quoting_round_trips_any_command() {
        for cmd in [
            "bash -lic deploycrm",
            r#"echo "a, b" && printf '%s\n' $HOME \ done # not a comment"#,
            "line one\nline two\n\ttabbed",
            "cd {{ app.path }} && php{{ app.php }} artisan migrate --force",
        ] {
            let out = set_action_key(
                SRC,
                "novaos",
                Some("crm"),
                "deploy",
                "run",
                Some(&yaml_quote(cmd)),
            )
            .expect("edit");
            assert_eq!(run_of(&out, "novaos", Some("crm"), "deploy"), cmd, "{out}");
        }
    }

    #[test]
    fn set_run_on_overrides() {
        let q = yaml_quote("deploy-now --fast");
        let flow =
            set_action_key(SRC, "novaos", Some("novaos"), "deploy", "run", Some(&q)).expect("edit");
        assert!(
            flow.contains(r#"- { id: deploy, run: "deploy-now --fast", local: false }"#),
            "{flow}"
        );
        assert_eq!(flow.lines().count(), SRC.lines().count());
        let block =
            set_action_key(SRC, "novaos", Some("crm"), "deploy", "run", Some(&q)).expect("edit");
        assert!(
            block.contains(
                "          - id: deploy\n            run: \"deploy-now --fast\"\n\nactions:"
            ),
            "{block}"
        );
        // A multi-line block scalar is replaced whole, keeping what follows.
        let multi = SRC.replace(
            "            run: deploycrm\n",
            "            run: |\n              cd /opt/www/crm\n              ./deploy\n            danger: true\n",
        );
        let out =
            set_action_key(&multi, "novaos", Some("crm"), "deploy", "run", Some(&q)).expect("edit");
        assert!(
            out.contains("            run: \"deploy-now --fast\"\n            danger: true\n"),
            "{out}"
        );
        assert_eq!(
            run_of(&out, "novaos", Some("crm"), "deploy"),
            "deploy-now --fast"
        );
    }

    #[test]
    fn run_source_and_global_edits() {
        assert_eq!(
            run_source(SRC, "novaos", Some("crm"), None, "deploy", Section::App),
            RunSource::Override
        );
        assert_eq!(
            run_source(SRC, "stg-web3", Some("billing"), None, "pull", Section::App),
            RunSource::Shared(None, Section::App)
        );
        // An override that only sets `confirm` still takes `run` from the global.
        let c = set_action_confirm(SRC, "stg-web3", Some("billing"), "pull", Some("warn"))
            .expect("edit");
        assert_eq!(
            run_source(&c, "stg-web3", Some("billing"), None, "pull", Section::App),
            RunSource::Shared(None, Section::App)
        );

        // Only this app: a new override; other apps keep the global.
        let here = set_action_key(
            SRC,
            "stg-web3",
            Some("billing"),
            "pull",
            "run",
            Some(&yaml_quote("git pull --rebase")),
        )
        .expect("edit");
        assert_eq!(
            run_of(&here, "stg-web3", Some("billing"), "pull"),
            "git pull --rebase"
        );
        assert_eq!(run_of(&here, "novaos", Some("crm"), "pull"), "git pull");
        // Everywhere: the global entry.
        let all = set_shared_action_key(
            SRC,
            None,
            Section::App,
            "pull",
            "run",
            &yaml_quote("git pull --rebase"),
        )
        .expect("edit");
        assert!(
            all.contains(r#"    - { id: pull, run: "git pull --rebase" }"#),
            "{all}"
        );
        assert_eq!(
            run_of(&all, "novaos", Some("crm"), "pull"),
            "git pull --rebase"
        );
        assert_eq!(
            run_of(&all, "stg-web3", Some("billing"), "pull"),
            "git pull --rebase"
        );
        assert!(set_shared_action_key(SRC, None, Section::App, "nope", "run", "x").is_err());
    }

    fn parsed(src: &str) -> crate::config::schema::Config {
        let out = crate::config::validate::parse(src);
        assert!(out.errors.is_empty(), "{:?}\n{src}", out.errors);
        out.config.expect("config")
    }

    #[test]
    fn add_servers_and_apps() {
        let a = add_server(
            SRC,
            &[
                ("id", "new-srv".into()),
                ("name", yaml_scalar("New Srv")),
                ("host", "new-srv".into()),
                ("env", "dev".into()),
            ],
        )
        .expect("add server");
        // After the last server, before `actions:`, blank-line separated.
        assert!(a.contains("            run: deploycrm\n\n  - id: new-srv\n    name: \"New Srv\"\n    host: new-srv\n    env: dev\n"), "{a}");
        let c = parsed(&a);
        assert_eq!(c.servers.len(), 3);
        assert_eq!(c.server("new-srv").expect("srv").name, "New Srv");

        // An app on a server with no `apps:` yet.
        let b = add_app(
            &a,
            "new-srv",
            &[
                ("id", "web".into()),
                ("path", "/var/www/web".into()),
                ("php", yaml_scalar("8.4")),
            ],
        )
        .expect("add app");
        assert!(b.contains("    env: dev\n    apps:\n      - id: web\n        path: /var/www/web\n        php: \"8.4\""), "{b}");
        let app = parsed(&b)
            .server("new-srv")
            .expect("srv")
            .app("web")
            .expect("app")
            .clone();
        assert_eq!(
            (app.path.as_str(), app.php.as_deref()),
            ("/var/www/web", Some("8.4"))
        );

        // Another app next to existing ones.
        let d = add_app(
            SRC,
            "stg-web3",
            &[("id", "api".into()), ("path", "/opt/www/api".into())],
        )
        .expect("add");
        assert!(
            d.contains(
                "        path: /opt/www/billing\n      - id: api\n        path: /opt/www/api\n"
            ),
            "{d}"
        );
        assert_eq!(parsed(&d).server("stg-web3").expect("srv").apps.len(), 2);
    }

    #[test]
    fn edit_server_and_app_fields() {
        // New keys go before `apps:`; existing ones change in place.
        let a = set_entity_field(SRC, "stg-web3", None, "name", Some("\"Staging Web 3\""))
            .expect("edit");
        assert!(
            a.contains("    env: staging\n    name: \"Staging Web 3\"\n    apps:"),
            "{a}"
        );
        let a = set_entity_field(&a, "stg-web3", None, "env", Some("prod")).expect("edit");
        let a = set_entity_field(
            &a,
            "stg-web3",
            None,
            "vpn_check",
            Some("{ host: 10.0.0.5, port: 22 }"),
        )
        .expect("edit");
        let a = set_entity_field(&a, "stg-web3", None, "vpn", Some("globalprotect")).expect("edit");
        let c = parsed(&a);
        let s = c.server("stg-web3").expect("srv");
        assert_eq!((s.name.as_str(), s.env.as_str()), ("Staging Web 3", "prod"));
        assert_eq!(s.vpn_check.as_ref().map(|h| h.port), Some(22));
        // Removing undoes adding, exactly.
        let mut back = a.clone();
        for key in ["vpn", "vpn_check", "name"] {
            back = set_entity_field(&back, "stg-web3", None, key, None).expect("remove");
        }
        let back = set_entity_field(&back, "stg-web3", None, "env", Some("staging")).expect("edit");
        assert_eq!(back, SRC);

        // Rename an app (its id is on the dash line) and set its branch.
        let r = set_entity_field(SRC, "novaos", Some("crm"), "branch", Some("main")).expect("edit");
        let r = set_entity_field(&r, "novaos", Some("crm"), "id", Some("crm2")).expect("rename");
        assert!(r.contains("      - id: crm2\n        path: /opt/www/crm\n        branch: main\n        actions:"), "{r}");
        let c = parsed(&r);
        assert_eq!(
            c.server("novaos")
                .expect("srv")
                .app("crm2")
                .expect("app")
                .branch
                .as_deref(),
            Some("main")
        );
        assert!(set_entity_field(SRC, "novaos", Some("crm"), "id", None).is_err());
    }

    #[test]
    fn delete_servers_and_apps() {
        let a = delete_entity(SRC, "novaos", Some("crm")).expect("delete app");
        assert!(!a.contains("crm") && !a.contains("deploycrm"), "{a}");
        assert_eq!(parsed(&a).server("novaos").expect("srv").apps.len(), 1);
        // Deleting the only app leaves `apps: []`, which still parses.
        let b = delete_entity(SRC, "stg-web3", Some("billing")).expect("delete app");
        assert!(b.contains("    env: staging\n    apps: []\n"), "{b}");
        assert!(parsed(&b).server("stg-web3").expect("srv").apps.is_empty());
        // A whole server, with its apps; the comment above the next one stays.
        let c = delete_entity(SRC, "stg-web3", None).expect("delete server");
        assert!(
            c.starts_with("servers:\n  # comment between servers\n  - id: novaos"),
            "{c}"
        );
        assert_eq!(parsed(&c).servers.len(), 1);
        let d = delete_entity(&c, "novaos", None).expect("delete last");
        assert!(d.starts_with("servers: []\n"), "{d}");
        assert!(parsed(&d).servers.is_empty());
        // And adding to `servers: []` works again.
        let e = add_server(
            &d,
            &[
                ("id", "x".into()),
                ("host", "x".into()),
                ("env", "dev".into()),
            ],
        )
        .expect("add");
        assert_eq!(parsed(&e).servers.len(), 1);
    }

    #[test]
    fn scalars() {
        assert_eq!(yaml_scalar("/opt/www/app"), "/opt/www/app");
        assert_eq!(yaml_scalar("deploy@nova-gw"), "deploy@nova-gw");
        assert_eq!(yaml_scalar("8.4"), "\"8.4\"");
        assert_eq!(yaml_scalar("yes"), "\"yes\"");
        assert_eq!(yaml_scalar("My App"), "\"My App\"");
        assert_eq!(yaml_scalar(""), "\"\"");
    }

    #[test]
    fn add_and_remove_actions() {
        let ids = |src: &str, server: &str, app: Option<&str>| -> Vec<String> {
            let c = parsed(src);
            let s = c.server(server).expect("srv");
            let list = match app {
                Some(a) => &s.app(a).expect("app").actions,
                None => &s.actions,
            };
            list.iter().map(|a| a.id.clone()).collect()
        };
        let f = |id: &str, run: &str| {
            vec![
                ("id", id.to_string()),
                ("label", yaml_scalar("Seed DB")),
                ("run", yaml_quote(run)),
            ]
        };
        // App with an `actions:` list already.
        let a = add_action(
            SRC,
            ActionList::Scope {
                server: "novaos",
                app: Some("novaos"),
            },
            &f("seed", "php artisan db:seed"),
        )
        .expect("add");
        assert!(a.contains("          - { id: deploy, run: deploynovaos, local: false }\n          - { id: seed, label: \"Seed DB\", run: \"php artisan db:seed\" }\n"), "{a}");
        assert!(ids(&a, "novaos", Some("novaos")).contains(&"seed".to_string()));
        assert_eq!(
            remove_action(
                &a,
                ActionList::Scope {
                    server: "novaos",
                    app: Some("novaos")
                },
                "seed"
            )
            .expect("rm"),
            SRC
        );
        // App without `actions:`: created, and removing the only one drops it again.
        let b = add_action(
            SRC,
            ActionList::Scope {
                server: "stg-web3",
                app: Some("billing"),
            },
            &f("seed", "x"),
        )
        .expect("add");
        assert!(
            b.contains("        path: /opt/www/billing\n        actions:\n          - { id: seed"),
            "{b}"
        );
        assert_eq!(
            remove_action(
                &b,
                ActionList::Scope {
                    server: "stg-web3",
                    app: Some("billing")
                },
                "seed"
            )
            .expect("rm"),
            SRC
        );
        // Server without `actions:` (its apps come first): a server-level key after them.
        let c = add_action(
            SRC,
            ActionList::Scope {
                server: "stg-web3",
                app: None,
            },
            &f("logs", "journalctl -f"),
        )
        .expect("add");
        assert!(
            ids(&c, "stg-web3", None).contains(&"logs".to_string()),
            "{c}"
        );
        assert!(!ids(&c, "stg-web3", Some("billing")).contains(&"logs".to_string()));
        assert_eq!(
            remove_action(
                &c,
                ActionList::Scope {
                    server: "stg-web3",
                    app: None
                },
                "logs"
            )
            .expect("rm"),
            SRC
        );
        // Shared: every app gets it.
        let d = add_action(
            SRC,
            ActionList::Global(Section::App),
            &f("seed", "php artisan db:seed"),
        )
        .expect("add");
        assert!(
            d.contains("    - { id: deploy, run: nope }\n    - { id: seed"),
            "{d}"
        );
        assert!(ids(&d, "stg-web3", Some("billing")).contains(&"seed".to_string()));
        assert!(ids(&d, "novaos", Some("crm")).contains(&"seed".to_string()));
        assert_eq!(
            remove_action(&d, ActionList::Global(Section::App), "seed").expect("rm"),
            SRC
        );
        // A missing section is created; removing its only entry leaves `[]`.
        let no_server = SRC.replace("  server:\n    - { id: nginx, run: nginx -t }\n", "");
        let e = add_action(
            &no_server,
            ActionList::Global(Section::Server),
            &f("df", "df -h"),
        )
        .expect("add");
        assert!(ids(&e, "stg-web3", None).contains(&"df".to_string()), "{e}");
        let e2 = remove_action(&e, ActionList::Global(Section::Server), "df").expect("rm");
        assert!(e2.contains("  server: []"), "{e2}");
        parsed(&e2);
        // No `actions:` at all.
        let bare = "servers:\n  - id: s\n    host: s\n    env: dev\n    apps:\n      - id: a\n        path: /a\n";
        let g = add_action(
            bare,
            ActionList::Global(Section::App),
            &f("pull", "git pull"),
        )
        .expect("add");
        assert_eq!(ids(&g, "s", Some("a")), ["pull"]);
    }

    #[test]
    fn terminal_and_editor_settings() {
        let a = set_map_key(SRC, "terminal", "font_size", Some("15")).expect("add");
        assert!(
            a.ends_with("    - { id: deploy, run: dep deploy }\n\nterminal:\n  font_size: 15\n"),
            "{a}"
        );
        let b =
            set_map_key(&a, "terminal", "font_family", Some("\"JetBrains Mono\"")).expect("add");
        let b = set_map_key(&b, "terminal", "font_size", Some("13")).expect("change");
        assert!(
            b.ends_with("terminal:\n  font_size: 13\n  font_family: \"JetBrains Mono\"\n"),
            "{b}"
        );
        let t = parsed(&b).terminal;
        assert_eq!(
            (t.font_size, t.font_family.as_deref()),
            (Some(13.0), Some("JetBrains Mono"))
        );
        let c = set_top_key(&b, "editor", Some("vscode")).expect("editor");
        assert_eq!(
            parsed(&c).editor,
            Some(crate::config::schema::Editor::Vscode)
        );
        // Removing everything gives the original back.
        let d = set_top_key(&c, "editor", None).expect("rm");
        let d = set_map_key(&d, "terminal", "font_family", None).expect("rm");
        let d = set_map_key(&d, "terminal", "font_size", None).expect("rm");
        assert_eq!(d, SRC);
        // `terminal: {}` becomes a block.
        let e = set_map_key(
            "servers: []\nterminal: {}\n",
            "terminal",
            "scrollback",
            Some("5000"),
        )
        .expect("edit");
        assert_eq!(e, "servers: []\nterminal:\n  scrollback: 5000\n");
    }
}

/// Round-trip a confirm edit on a real file without writing it:
/// `KEMUDI_VALIDATE=<file> KEMUDI_EDIT=server/app/action cargo test confirm_roundtrip -- --ignored`
#[cfg(test)]
mod file_check {
    #[test]
    #[ignore]
    fn confirm_roundtrip() {
        let (Some(path), Some(target)) = (
            std::env::var_os("KEMUDI_VALIDATE"),
            std::env::var("KEMUDI_EDIT").ok(),
        ) else {
            return;
        };
        let source = std::fs::read_to_string(path).expect("read");
        let parts: Vec<&str> = target.split('/').collect();
        let (server, app, action) = match parts.as_slice() {
            [s, a, x] => (*s, Some(*a), *x),
            [s, x] => (*s, None, *x),
            _ => panic!("KEMUDI_EDIT=server/app/action or server/action"),
        };
        for level in ["none", "warn", "type"] {
            let edited =
                super::set_action_confirm(&source, server, app, action, Some(level)).expect("edit");
            let changed: Vec<(usize, &str)> = edited
                .lines()
                .enumerate()
                .filter(|(i, l)| source.lines().nth(*i) != Some(*l))
                .collect();
            println!("{level}: {changed:?}");
            let out = crate::config::validate::parse(&edited);
            assert!(out.errors.is_empty(), "{:?}", out.errors);
            let back =
                super::set_action_confirm(&edited, server, app, action, None).expect("reset");
            assert_eq!(back, source, "reset restores the file exactly");
        }
    }

    /// Dry-run turning `danger` off on a real file (removing the key, or
    /// `danger: false` when it's inherited):
    /// `KEMUDI_VALIDATE=<file> KEMUDI_EDIT=server/app/action cargo test danger_off -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn danger_off() {
        let (Some(path), Some(target)) = (
            std::env::var_os("KEMUDI_VALIDATE"),
            std::env::var("KEMUDI_EDIT").ok(),
        ) else {
            return;
        };
        let source = std::fs::read_to_string(path).expect("read");
        let parts: Vec<&str> = target.split('/').collect();
        let [server, app, action] = parts.as_slice() else {
            panic!("KEMUDI_EDIT=server/app/action");
        };
        let danger = |src: &str| {
            let c = crate::config::validate::parse(src).config.expect("valid");
            let s = c.server(server).expect("server");
            s.app(app)
                .expect("app")
                .actions
                .iter()
                .find(|a| a.id == *action)
                .expect("action")
                .danger
        };
        for value in [None, Some("false")] {
            let edited = super::set_action_key(&source, server, Some(app), action, "danger", value)
                .expect("edit");
            let first = edited.lines().zip(source.lines()).position(|(a, b)| a != b);
            let line = first
                .and_then(|i| edited.lines().nth(i))
                .unwrap_or("(appended)");
            println!("{value:?}: danger now {} · {line}", danger(&edited));
        }
    }

    /// Dry-run a `run:` edit on a real file:
    /// `KEMUDI_VALIDATE=<file> KEMUDI_EDIT=server/app/action cargo test run_edit -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn run_edit() {
        let (Some(path), Some(target)) = (
            std::env::var_os("KEMUDI_VALIDATE"),
            std::env::var("KEMUDI_EDIT").ok(),
        ) else {
            return;
        };
        let source = std::fs::read_to_string(path).expect("read");
        let parts: Vec<&str> = target.split('/').collect();
        let (server, app, action) = match parts.as_slice() {
            [s, a, x] => (*s, Some(*a), *x),
            [s, x] => (*s, None, *x),
            _ => panic!("KEMUDI_EDIT=server/app/action or server/action"),
        };
        let cmd = r#"echo "edited" && true"#;
        let edited = super::set_action_key(
            &source,
            server,
            app,
            action,
            "run",
            Some(&super::yaml_quote(cmd)),
        )
        .expect("edit");
        // Print up to the first line that differs, then what was added.
        let added = edited.lines().count() - source.lines().count();
        if let Some(i) = edited.lines().zip(source.lines()).position(|(a, b)| a != b) {
            for (n, l) in edited.lines().enumerate().skip(i).take(added + 1) {
                println!("line {}: {l}", n + 1);
            }
        }
        let out = crate::config::validate::parse(&edited);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
    }
}
