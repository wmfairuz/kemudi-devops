//! Action templates (minijinja). Undefined variables are errors, and every
//! interpolated value is shell-quoted unless it is plainly safe or passed
//! through `| raw`.

use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use minijinja::value::Value;
use minijinja::{Environment, Error, ErrorKind, UndefinedBehavior};
use serde::Serialize;

use crate::config::schema::{App, Server};

static ENV: LazyLock<Environment<'static>> = LazyLock::new(|| {
    let mut env = Environment::new();
    env.set_undefined_behavior(UndefinedBehavior::Strict);
    env.set_formatter(|out, _state, value| {
        // None and empty render as nothing (so `php{{ app.php | default('') }}`
        // is plain `php`); anything else is quoted unless marked safe/raw.
        let raw = if value.is_none() {
            String::new()
        } else {
            value.to_string()
        };
        let text = if raw.is_empty() || value.is_safe() {
            raw
        } else {
            shell_quote(&raw)
        };
        out.write_str(&text)
            .map_err(|_| Error::new(ErrorKind::WriteFailure, "could not write template output"))
    });
    env.add_filter("raw", |v: Value| Value::from_safe_string(v.to_string()));
    env
});

/// Characters that never need quoting. `~` stays unquoted so a leading
/// `~/path` still expands.
fn is_safe_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "_./:@%+=,~-".contains(c)
}

pub fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(is_safe_char) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

#[derive(Serialize)]
struct ServerCtx<'a> {
    id: &'a str,
    name: &'a str,
    host: &'a str,
    env: &'a str,
    vpn: &'a str,
}

fn server_ctx(s: &Server) -> ServerCtx<'_> {
    ServerCtx {
        id: &s.id,
        name: &s.name,
        host: &s.host,
        env: s.env.as_str(),
        vpn: match s.vpn {
            crate::config::schema::Vpn::None => "none",
            crate::config::schema::Vpn::Openfortivpn => "openfortivpn",
            crate::config::schema::Vpn::Globalprotect => "globalprotect",
        },
    }
}

fn app_ctx(a: &App) -> BTreeMap<&str, Value> {
    let mut m: BTreeMap<&str, Value> = a
        .vars
        .iter()
        .map(|(k, v)| (k.as_str(), Value::from(v.as_str())))
        .collect();
    m.insert("id", Value::from(a.id.as_str()));
    m.insert("name", Value::from(a.name.as_str()));
    m.insert("path", Value::from(a.path.as_str()));
    m.insert("env", Value::from(a.env.as_str()));
    // Missing optional fields stay undefined, so using them is an error.
    if let Some(b) = &a.branch {
        m.insert("branch", Value::from(b.as_str()));
    }
    if let Some(p) = &a.php {
        m.insert("php", Value::from(p.as_str()));
    }
    if let Some(r) = &a.repo {
        m.insert("repo", Value::from(r.as_str()));
    }
    if let Some(u) = &a.url {
        m.insert("url", Value::from(u.as_str()));
    }
    m
}

/// Check a template's syntax without rendering it.
pub fn check_syntax(source: &str) -> Result<(), String> {
    ENV.template_from_str(source)
        .map(|_| ())
        .map_err(|e| describe(&e))
}

/// A free variable in an action's template (`{{ ip }}`), asked for at run
/// time. `server` and `app` are the config; any other top-level name is a
/// parameter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: String,
    /// From `{{ name | default('x') }}`.
    pub default: Option<String>,
    /// Has a default or is tested with `is defined`, so it may be left empty.
    pub optional: bool,
}

const CONTEXT_NAMES: [&str; 2] = ["server", "app"];

/// The parameters a template asks for, in order of first use.
pub fn params(source: &str) -> Vec<Param> {
    let Ok(t) = ENV.template_from_str(source) else {
        return Vec::new();
    };
    let globals: HashSet<&str> = ENV.globals().map(|(k, _)| k).collect();
    let mut names: Vec<(usize, String)> = t
        .undeclared_variables(false)
        .into_iter()
        .filter(|n| !CONTEXT_NAMES.contains(&n.as_str()) && !globals.contains(n.as_str()))
        .map(|n| (uses(source, &n).first().copied().unwrap_or(usize::MAX), n))
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|(_, name)| {
            let (default, tested) = default_of(source, &name);
            Param {
                optional: default.is_some() || tested,
                default,
                name,
            }
        })
        .collect()
}

/// Byte offsets where `name` appears as a whole word (not `x.name`).
fn uses(source: &str, name: &str) -> Vec<usize> {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    source
        .match_indices(name)
        .filter(|(i, _)| {
            let before = source[..*i].chars().next_back();
            let after = source[i + name.len()..].chars().next();
            !before.is_some_and(|c| word(c) || c == '.') && !after.is_some_and(word)
        })
        .map(|(i, _)| i)
        .collect()
}

/// `name | default('x')` → Some("x"); also whether `name is [not] defined`
/// appears.
fn default_of(source: &str, name: &str) -> (Option<String>, bool) {
    let mut default = None;
    let mut tested = false;
    for i in uses(source, name) {
        let rest = source[i + name.len()..].trim_start();
        if let Some(r) = rest.strip_prefix('|') {
            let r = r.trim_start();
            let Some(arg) = r
                .strip_prefix("default(")
                .or_else(|| r.strip_prefix("d("))
                .map(str::trim_start)
            else {
                continue;
            };
            let value = match arg.chars().next() {
                Some(q @ ('\'' | '"')) => arg[1..].find(q).map(|end| arg[1..=end].to_string()),
                _ => arg.find(')').map(|end| arg[..end].trim().to_string()),
            };
            if default.is_none() {
                default = value;
            }
        } else if rest.starts_with("is defined")
            || rest.starts_with("is not defined")
            || rest.starts_with("is undefined")
        {
            tested = true;
        }
    }
    (default, tested)
}

/// Render an action's `run:` for a server (and app, for app/local actions).
/// Parameters show as `<name>` placeholders.
pub fn render(source: &str, server: &Server, app: Option<&App>) -> Result<String, String> {
    render_with(source, server, app, &BTreeMap::new()).map(|(text, _)| text)
}

/// Render with parameter values. A required parameter with no (or an
/// empty) value renders as `<name>` and is listed in the second result, so a
/// preview still reads well but the command must not run.
pub fn render_with(
    source: &str,
    server: &Server,
    app: Option<&App>,
    given: &BTreeMap<String, String>,
) -> Result<(String, Vec<String>), String> {
    let mut ctx: BTreeMap<String, Value> = BTreeMap::new();
    let mut missing = Vec::new();
    for p in params(source) {
        match given.get(&p.name).filter(|v| !v.is_empty()) {
            Some(v) => {
                ctx.insert(p.name, Value::from(v.as_str()));
            }
            // Left out, so `default(…)` / `is defined` apply.
            None if p.optional => {}
            None => {
                ctx.insert(
                    p.name.clone(),
                    Value::from_safe_string(format!("<{}>", p.name)),
                );
                missing.push(p.name);
            }
        }
    }
    ctx.insert("server".into(), Value::from_serialize(server_ctx(server)));
    if let Some(a) = app {
        ctx.insert("app".into(), Value::from_iter(app_ctx(a)));
    }
    ENV.render_str(source, Value::from_iter(ctx))
        .map(|s| (s.trim().to_string(), missing))
        .map_err(|e| describe(&e))
}

fn describe(e: &Error) -> String {
    let mut msg = match e.kind() {
        ErrorKind::UndefinedError => "undefined variable".to_string(),
        _ => e
            .detail()
            .map_or_else(|| e.kind().to_string(), str::to_string),
    };
    if e.kind() == ErrorKind::UndefinedError {
        if let Some(detail) = e.detail() {
            msg = format!("undefined variable ({detail})");
        }
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::schema::{Env, Vpn};

    fn server() -> Server {
        Server {
            id: "stg-svr03".into(),
            name: "Staging 03".into(),
            team: None,
            host: "stg-svr03".into(),
            env: Env::Staging,
            vpn: Vpn::None,
            vpn_check: None,
            vpn_connect: None,
            check: None,
            color: None,
            new_app: Default::default(),
            apps: vec![],
            actions: vec![],
            hidden: vec![],
        }
    }

    fn app() -> App {
        App {
            id: "akaun".into(),
            name: "Akaun".into(),
            path: "/var/www/akaun".into(),
            branch: Some("develop".into()),
            php: Some("8.4".into()),
            color: None,
            env: Env::Staging,
            env_set: false,
            repo: None,
            url: None,
            vhost_files: vec![],
            supervisor_files: vec![],
            vars: BTreeMap::from([("queue".to_string(), "akaun worker".to_string())]),
            actions: vec![],
            hidden: vec![],
        }
    }

    #[test]
    fn renders_brief_examples() {
        let s = server();
        let a = app();
        assert_eq!(
            render(
                "cd {{ app.path }} && git pull origin {{ app.branch }}",
                &s,
                Some(&a)
            )
            .as_deref(),
            Ok("cd /var/www/akaun && git pull origin develop")
        );
        assert_eq!(
            render(
                "cd {{ app.path }} && php{{ app.php }} artisan migrate --force",
                &s,
                Some(&a)
            )
            .as_deref(),
            Ok("cd /var/www/akaun && php8.4 artisan migrate --force")
        );
        assert_eq!(
            render(
                "cd ~/Projects/{{ app.id }} && dep deploy {{ server.env }}",
                &s,
                Some(&a)
            )
            .as_deref(),
            Ok("cd ~/Projects/akaun && dep deploy staging")
        );
    }

    #[test]
    fn quotes_unsafe_values() {
        let s = server();
        let mut a = app();
        a.path = "/var/www/my app".into();
        assert_eq!(
            render("cd {{ app.path }}", &s, Some(&a)).as_deref(),
            Ok("cd '/var/www/my app'")
        );
        a.path = "/tmp/it's; rm -rf /".into();
        assert_eq!(
            render("cd {{ app.path }}", &s, Some(&a)).as_deref(),
            Ok(r"cd '/tmp/it'\''s; rm -rf /'")
        );
        assert_eq!(
            render("supervisorctl restart {{ app.queue }}", &s, Some(&a)).as_deref(),
            Ok("supervisorctl restart 'akaun worker'")
        );
        assert_eq!(
            render("supervisorctl restart {{ app.queue | raw }}", &s, Some(&a)).as_deref(),
            Ok("supervisorctl restart akaun worker")
        );
    }

    #[test]
    fn undefined_is_an_error() {
        let s = server();
        let mut a = app();
        a.branch = None;
        let err = render("git pull origin {{ app.branch }}", &s, Some(&a)).unwrap_err();
        assert!(err.contains("undefined"), "{err}");
        assert!(
            render("cd {{ app.path }}", &s, None).is_err(),
            "server actions have no app"
        );
        assert!(render("{{ server.nope }}", &s, None).is_err());
    }

    /// Optional fields: `is defined` and `default` work in strict mode, and
    /// an empty default renders as nothing.
    #[test]
    fn optional_branch_and_php() {
        let s = server();
        let mut a = app();
        let pull = "cd {{ app.path }} && git pull{% if app.branch is defined %} origin {{ app.branch }}{% endif %}";
        let php = "php{{ app.php | default('') }} artisan migrate";
        assert_eq!(
            render(pull, &s, Some(&a)).as_deref(),
            Ok("cd /var/www/akaun && git pull origin develop")
        );
        assert_eq!(
            render(php, &s, Some(&a)).as_deref(),
            Ok("php8.4 artisan migrate")
        );
        a.branch = None;
        a.php = None;
        assert_eq!(
            render(pull, &s, Some(&a)).as_deref(),
            Ok("cd /var/www/akaun && git pull")
        );
        assert_eq!(
            render(php, &s, Some(&a)).as_deref(),
            Ok("php artisan migrate")
        );
    }

    #[test]
    fn app_env_is_the_apps_own() {
        let s = server();
        let mut a = app();
        a.env = Env::Qa;
        a.env_set = true;
        assert_eq!(
            render("dep deploy {{ app.env }} # {{ server.env }}", &s, Some(&a)).as_deref(),
            Ok("dep deploy qa # staging")
        );
    }

    #[test]
    fn syntax_errors() {
        assert!(check_syntax("cd {{ app.path }").is_err());
        assert!(check_syntax("{% if %}").is_err());
        assert!(check_syntax("cd {{ app.path }}").is_ok());
    }

    #[test]
    fn finds_params() {
        let ps = params("nc -vz -w 5 {{ ip }} {{ port }} # {{ server.host }} {{ app.path }}");
        let names: Vec<&str> = ps.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["ip", "port"]);
        assert!(ps.iter().all(|p| !p.optional && p.default.is_none()));
        let ps = params("{% if tag is defined %}{{ tag }}{% endif %} {{ port | default('22') }} {{ n|d(5) }} {% for x in range(2) %}{{ x }}{% endfor %}");
        assert_eq!(
            ps,
            [
                Param {
                    name: "tag".into(),
                    default: None,
                    optional: true
                },
                Param {
                    name: "port".into(),
                    default: Some("22".into()),
                    optional: true
                },
                Param {
                    name: "n".into(),
                    default: Some("5".into()),
                    optional: true
                },
            ]
        );
        assert!(params("cd {{ app.path }}").is_empty());
    }

    #[test]
    fn renders_params() {
        let s = server();
        let src = "nc -vz -w 5 {{ ip }} {{ port | default('22') }}";
        let given = BTreeMap::from([("ip".to_string(), "10.0.0.5".to_string())]);
        assert_eq!(
            render_with(src, &s, None, &given),
            Ok(("nc -vz -w 5 10.0.0.5 22".to_string(), vec![]))
        );
        let given = BTreeMap::from([
            ("ip".to_string(), "a b".to_string()),
            ("port".to_string(), "443".to_string()),
        ]);
        assert_eq!(
            render_with(src, &s, None, &given).map(|r| r.0).as_deref(),
            Ok("nc -vz -w 5 'a b' 443")
        );
        // Missing: a placeholder, listed; config values still checked.
        assert_eq!(
            render_with(src, &s, None, &BTreeMap::new()),
            Ok(("nc -vz -w 5 <ip> 22".to_string(), vec!["ip".to_string()]))
        );
        assert_eq!(render(src, &s, None).as_deref(), Ok("nc -vz -w 5 <ip> 22"));
        assert!(render("{{ ip }} {{ app.path }}", &s, None).is_err());
    }

    #[test]
    fn quote_helper() {
        assert_eq!(shell_quote("plain-value_1.2"), "plain-value_1.2");
        assert_eq!(shell_quote("~/Projects/x"), "~/Projects/x");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("$(id)"), "'$(id)'");
    }
}
