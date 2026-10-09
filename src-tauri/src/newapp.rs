//! New app: set up a Laravel app on a server (clone, .env, database,
//! composer, permissions, nginx vhost, queue worker, HTTPS) from a plan the
//! wizard fills in. The plan becomes one bash script that runs in a terminal
//! tab, so sudo / certbot / a database password can be answered there and
//! every line of output is visible. Each step skips what's already done, so
//! running it again after fixing a problem is safe.

use std::collections::BTreeMap;

use portable_pty::PtySize;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};

use crate::actions::invocation;
use crate::actions::render;
use crate::actions::render::shell_quote;
use crate::config::schema::{ActionKind, App, Config, Server};
use crate::discover::{WildPhp, Wildcard};
use crate::error::{AppError, AppResult};
use crate::pty::commands::pty_size;
use crate::pty::session::ExitHooks;
use crate::pty::{Launch, PtyEvent, PtyId};
use crate::remote_files::{
    base64_body, errors, lookup, parse_probe, probe_script, saved_sudo, valid_site_name, VhostProbe,
};
use crate::AppState;

// ------------------------------------------------------------------ probe

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PublicKey {
    pub path: String,
    pub key: String,
}

/// What the server has for a new app.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewAppProbe {
    pub vhost: VhostProbe,
    /// The SSH login user.
    pub user: String,
    pub root: bool,
    /// `8.4`, `8.3`… (from /usr/bin/phpX.Y).
    pub php_versions: Vec<String>,
    /// Which of git, composer, node, npm, mysql, supervisorctl are there.
    pub tools: Vec<String>,
    /// The login user's public keys (~/.ssh/*.pub): what git hosts see.
    pub keys: Vec<PublicKey>,
    /// The most common owner of the server's apps' `storage/`.
    pub owner: Option<String>,
    /// Where Supervisor reads programs from, e.g. `/etc/supervisor/conf.d`
    /// and `.conf`.
    pub supervisor_dir: Option<String>,
    pub supervisor_ext: String,
    /// MySQL answers as root (sudo mysql); users and databases are listed.
    pub mysql: bool,
    pub db_users: Vec<String>,
    pub databases: Vec<String>,
    /// Wildcard vhosts (one folder per subdomain) a new app can join.
    pub wildcards: Vec<crate::discover::Wildcard>,
}

fn extra_probe_script(paths: &[String]) -> String {
    let dirs = paths
        .iter()
        .map(|p| shell_quote(p))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"echo "@@user $(id -un) $(id -u)"
for c in git composer node npm mysql supervisorctl; do command -v "$c" >/dev/null 2>&1 && echo "@@tool $c"; done
echo "@@phps"
ls -1 /usr/bin/ 2>/dev/null | sed -n 's/^php\([0-9][0-9]*\.[0-9][0-9]*\)$/\1/p' | sort -t. -k1,1nr -k2,2nr
echo "@@keys"
for f in "$HOME"/.ssh/*.pub; do [ -f "$f" ] && printf '%s\t%s\n' "$f" "$(head -n1 "$f")"; done
echo "@@owners"
for d in {dirs}; do [ -d "$d/storage" ] && stat -c '%U:%G' "$d/storage"; done 2>/dev/null
echo "@@supinc"
sed -n '/^\[include\]/,/^\[/p' /etc/supervisor/supervisord.conf 2>/dev/null | sed -n 's/^files *= *//p' | head -n1 | tr ' ' '\n' | grep -v '^$'
if command -v mysql >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ]; then M="mysql"; else M="$SU mysql"; fi
  if [ "$(id -u)" = 0 ] || [ -n "$SU" ]; then
    if $M -N -e 'SELECT 1' >/dev/null 2>&1; then
      echo "@@mysql"
      echo "@@dbusers"
      $M -N -e "SELECT DISTINCT user FROM mysql.user WHERE host IN ('localhost','127.0.0.1','%') AND user NOT IN ('root','mysql','debian-sys-maint','mariadb.sys','mysql.sys','mysql.session','mysql.infoschema','')" 2>/dev/null
      echo "@@dbs"
      $M -N -e 'SHOW DATABASES' 2>/dev/null | grep -vE '^(information_schema|performance_schema|mysql|sys)$'
    fi
  fi
fi
echo "@@done"
"#
    )
}

fn parse_extra(out: &str, vhost: VhostProbe) -> NewAppProbe {
    let mut p = NewAppProbe {
        vhost,
        user: String::new(),
        root: false,
        php_versions: vec![],
        tools: vec![],
        keys: vec![],
        owner: None,
        supervisor_dir: None,
        supervisor_ext: ".conf".into(),
        mysql: false,
        db_users: vec![],
        databases: vec![],
        wildcards: vec![],
    };
    let mut owners: BTreeMap<String, usize> = BTreeMap::new();
    let mut section = "";
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("@@user ") {
            let mut it = rest.split_whitespace();
            p.user = it.next().unwrap_or_default().to_string();
            p.root = it.next() == Some("0");
            section = "";
            continue;
        }
        if let Some(t) = line.strip_prefix("@@tool ") {
            p.tools.push(t.trim().to_string());
            continue;
        }
        if line == "@@mysql" {
            p.mysql = true;
            continue;
        }
        if let Some(name) = line.strip_prefix("@@") {
            section = name;
            continue;
        }
        let v = line.trim();
        if v.is_empty() {
            continue;
        }
        match section {
            "phps" => p.php_versions.push(v.to_string()),
            "keys" => {
                if let Some((path, key)) = v.split_once('\t') {
                    if key.starts_with("ssh-") || key.starts_with("ecdsa-") {
                        p.keys.push(PublicKey {
                            path: path.to_string(),
                            key: key.trim().to_string(),
                        });
                    }
                }
            }
            "owners" => *owners.entry(v.to_string()).or_default() += 1,
            "supinc" => {
                // The first `dir/*.ext` pattern is where new programs go.
                if p.supervisor_dir.is_none() {
                    if let Some((dir, file)) = v.rsplit_once('/') {
                        if let Some(ext) = file.strip_prefix('*') {
                            if dir.starts_with('/') && !dir.contains('*') && ext.starts_with('.') {
                                p.supervisor_dir = Some(dir.to_string());
                                p.supervisor_ext = ext.to_string();
                            }
                        }
                    }
                }
            }
            "dbusers" => p.db_users.push(v.to_string()),
            "dbs" => p.databases.push(v.to_string()),
            _ => {}
        }
    }
    if p.supervisor_dir.is_none() && p.tools.iter().any(|t| t == "supervisorctl") {
        p.supervisor_dir = Some("/etc/supervisor/conf.d".into());
    }
    p.owner = owners.into_iter().max_by_key(|(_, n)| *n).map(|(o, _)| o);
    p
}

/// An `after` hook that gives a site its PHP version the way a wildcard
/// vhost's `if ($http_host = …) { set $var "x"; }` file does (None for other
/// set-ups). It's a suggestion: saved as the server's hook, then it's yours.
pub fn php_versions_hook(w: &Wildcard) -> Option<String> {
    let WildPhp::Ifs {
        file, var, default, ..
    } = &w.php
    else {
        return None;
    };
    let default_branch = default.as_ref().map_or(String::new(), |d| {
        format!(
            "elif [ \"$v\" = {d} ]; then\n  note \"$h gets the default PHP $v\"\n",
            d = shell_quote(d)
        )
    });
    Some(format!(
        r#"# PHP per site for the wildcard vhost {vhost} (*{suffix}):
# an `if ($http_host = …)` block in {file}{default_note}.
f={file_q}; h={{{{ app.domain }}}}; v={{{{ app.php }}}}
case "$h" in *{suffix_q}) ;; *) note "$h isn't under *{suffix}: nothing to do"; exit 0;; esac
if grep -qF "\"$h\"" "$f"; then
  grep -A2 -F "\"$h\"" "$f" | grep -qF "\"$v\"" || die "$f already gives $h another PHP version: change it there"
  note "$f already gives $h PHP $v"
{default_branch}else
  bak=$(mktemp); $S cat "$f" > "$bak"
  printf '\nif ($http_host = "%s") {{\n    set ${var} "%s";\n}}\n' "$h" "$v" | $S tee -a "$f" >/dev/null
  if ! $S nginx -t; then cat "$bak" | $S tee "$f" >/dev/null; rm -f "$bak"; die "nginx -t failed; $f is back as it was"; fi
  rm -f "$bak"
  $S systemctl reload nginx || $S nginx -s reload
  ok "$h runs PHP $v"
fi"#,
        vhost = w.file,
        suffix = w.suffix,
        suffix_q = shell_quote(&w.suffix),
        file_q = shell_quote(file),
        default_note = default
            .as_ref()
            .map_or(String::new(), |d| format!(" (sites without one get {d})")),
    ))
}

/// What the server has for a new app (read-only).
#[tauri::command]
pub async fn newapp_probe(state: State<'_, AppState>, server_id: String) -> AppResult<NewAppProbe> {
    let server = lookup(&state, &server_id)?;
    let paths: Vec<String> = server.apps.iter().map(|a| a.path.clone()).collect();
    let password = saved_sudo(&server_id).await;
    let script = format!(
        "{}{}",
        probe_script(password.as_deref()),
        extra_probe_script(&paths)
    );
    let (out, wildcards) = tokio::join!(
        crate::monitor::run_for(&state, &server_id, &script, 30),
        crate::discover::wildcards(&state, &server_id)
    );
    let out = out?;
    errors(&out)?;
    let mut probe = parse_extra(&out, parse_probe(&out));
    // Not knowing about wildcard vhosts only means a new vhost is proposed.
    probe.wildcards = wildcards.unwrap_or_default();
    for w in &mut probe.wildcards {
        w.hook = php_versions_hook(w);
    }
    Ok(probe)
}

// ------------------------------------------------------------ repo access

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoCheck {
    pub ok: bool,
    pub branches: Vec<String>,
    pub default_branch: Option<String>,
    /// git's own words when it can't read the repo.
    pub error: Option<String>,
}

fn valid_repo(repo: &str) -> bool {
    !repo.is_empty()
        && repo.len() <= 300
        && !repo.starts_with('-')
        && !repo.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn repo_check_script(repo: &str) -> String {
    format!(
        r#"export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
if out=$(timeout 30 git ls-remote --symref {repo} 2>&1); then
  echo "@@ok"; printf '%s\n' "$out" | grep -E '^ref: |refs/heads/' | head -n 500
else
  echo "@@fail"; printf '%s\n' "$out" | grep -v '^$' | tail -n 6
fi
"#,
        repo = shell_quote(repo)
    )
}

fn parse_repo_check(out: &str) -> RepoCheck {
    let ok = out.lines().any(|l| l == "@@ok");
    let mut branches = vec![];
    let mut default_branch = None;
    let mut error = vec![];
    let mut seen = false;
    for line in out.lines() {
        if line == "@@ok" || line == "@@fail" {
            seen = true;
            continue;
        }
        if !seen {
            continue;
        }
        if !ok {
            error.push(line.trim());
        } else if let Some(r) = line.strip_prefix("ref: refs/heads/") {
            if let Some((b, _)) = r.split_once(char::is_whitespace) {
                default_branch = Some(b.to_string());
            }
        } else if let Some((_, r)) = line.split_once("refs/heads/") {
            branches.push(r.trim().to_string());
        }
    }
    RepoCheck {
        ok,
        branches,
        default_branch,
        error: (!ok).then(|| {
            let e = error.join("\n");
            if e.is_empty() {
                "no answer from git".into()
            } else {
                e
            }
        }),
    }
}

/// Can the server read this repo? Lists its branches (git ls-remote, run on
/// the server with its own key).
#[tauri::command]
pub async fn newapp_repo_check(
    state: State<'_, AppState>,
    server_id: String,
    repo: String,
) -> AppResult<RepoCheck> {
    lookup(&state, &server_id)?;
    let repo = repo.trim();
    if !valid_repo(repo) {
        return Err(AppError::Invalid(
            "that doesn't look like a git remote".into(),
        ));
    }
    if crate::monitor::strip_credentials(repo) != repo {
        return Err(AppError::Invalid(
            "leave the username/token out of the URL; Kemudi uses the server's key".into(),
        ));
    }
    let out = crate::monitor::run_for(&state, &server_id, &repo_check_script(repo), 45).await?;
    Ok(parse_repo_check(&out))
}

/// Make an ed25519 key for the login user (never replaces one).
#[tauri::command]
pub async fn newapp_create_key(
    state: State<'_, AppState>,
    server_id: String,
) -> AppResult<PublicKey> {
    let server = lookup(&state, &server_id)?;
    let script = r#"f="$HOME/.ssh/id_ed25519"
[ -e "$f" ] && { echo "@@err $f already exists"; exit 0; }
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" || { echo "@@err can't create ~/.ssh"; exit 0; }
ssh-keygen -q -t ed25519 -N "" -C "$(id -un)@$(hostname -s)" -f "$f" </dev/null >/dev/null 2>&1 || { echo "@@err ssh-keygen failed"; exit 0; }
printf '@@key %s\t%s\n' "$f.pub" "$(head -n1 "$f.pub")"
"#;
    let audit = state.audit.as_ref().ok().and_then(|log| {
        log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: None,
            action_id: "ssh-keygen",
            label: "Create an SSH key",
            env: server.env.as_str(),
            kind: "edit",
            command: "ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519",
            edited: false,
        })
        .ok()
        .map(|id| (log.clone(), id))
    });
    let result = crate::monitor::run(&state, &server_id, script)
        .await
        .and_then(|out| {
            errors(&out)?;
            out.lines()
                .find_map(|l| l.strip_prefix("@@key "))
                .and_then(|r| r.split_once('\t'))
                .map(|(path, key)| PublicKey {
                    path: path.to_string(),
                    key: key.trim().to_string(),
                })
                .ok_or_else(|| AppError::Invalid("no key came back".into()))
        });
    if let Some((log, id)) = audit {
        let _ = log.finish(id, Some(i32::from(result.is_err())));
    }
    result
}

fn loaded(state: &AppState) -> AppResult<Config> {
    state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))
}

// ------------------------------------------------------------------- plan

#[derive(Debug, Clone, Deserialize)]
#[serde(
    rename_all = "camelCase",
    tag = "mode",
    rename_all_fields = "camelCase"
)]
pub enum Db {
    /// Leave the database settings in .env alone.
    None,
    /// A new MySQL user with a password made on the server (it goes only
    /// into the app's .env).
    New { database: String, user: String },
    /// An existing user: its password is typed in the terminal.
    Existing { database: String, user: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VhostPlan {
    /// File name in sites-available.
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerPlan {
    /// Full path of the Supervisor program file.
    pub file: String,
    pub processes: u8,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub branch: Option<String>,
    pub path: String,
    /// `8.4` → php8.4
    pub php: String,
    /// `user` or `user:group` that owns the app.
    pub owner: String,
    /// APP_ENV (production, staging, local…).
    pub app_env: String,
    pub url: Option<String>,
    pub npm: bool,
    pub migrate: bool,
    pub seed: bool,
    pub db: Db,
    pub vhost: Option<VhostPlan>,
    pub worker: Option<WorkerPlan>,
    /// certbot --nginx for these names (empty: no certbot).
    #[serde(default)]
    pub certbot: Vec<String>,
    /// A cron.d entry for `artisan schedule:run` every minute.
    #[serde(default)]
    pub schedule: bool,
    /// The site's main name (`{{ app.domain }}` in hooks).
    #[serde(default)]
    pub domain: Option<String>,
}

fn plain(s: &str, extra: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

fn valid_path(p: &str) -> bool {
    p.starts_with('/')
        && p.len() > 1
        && plain(p, "/._-", 300)
        && !p.split('/').any(|s| s == ".." || s == ".")
}

fn valid_domain(d: &str) -> bool {
    plain(d, ".-*", 253) && d.contains('.') && !d.starts_with(['.', '-']) && !d.contains("..")
}

fn check(plan: &Plan) -> AppResult<()> {
    let bad = |m: &str| Err(AppError::Invalid(m.to_string()));
    if !plain(&plan.id, "._-", 64) || !plan.id.starts_with(|c: char| c.is_ascii_alphanumeric()) {
        return bad("The ID can use letters, digits, . _ -");
    }
    if plan.name.trim().is_empty() || plan.name.contains(['\n', '\r']) {
        return bad("Give the app a name.");
    }
    if !valid_repo(plan.repo.trim()) {
        return bad("The repository doesn't look like a git remote.");
    }
    if crate::monitor::strip_credentials(plan.repo.trim()) != plan.repo.trim() {
        return bad("Leave the username/token out of the repository URL.");
    }
    if let Some(b) = &plan.branch {
        if !b.is_empty() && (!plain(b, "._/-", 200) || b.starts_with('-')) {
            return bad("That branch name has odd characters.");
        }
    }
    if !valid_path(&plan.path) || plan.path.matches('/').count() < 2 {
        return bad("The path must be a full path at least two folders deep, without spaces.");
    }
    if !plain(&plan.php, ".", 10) || !plan.php.contains('.') {
        return bad("Pick a PHP version.");
    }
    let (user, group) = plan
        .owner
        .split_once(':')
        .unwrap_or((plan.owner.as_str(), ""));
    let name_ok = |s: &str| plain(s, "_-", 32) && !s.starts_with('-');
    if !name_ok(user) || (!group.is_empty() && !name_ok(group)) {
        return bad("The owner looks like www-data or www-data:www-data.");
    }
    if !plain(&plan.app_env, "_-", 30) {
        return bad("APP_ENV is a single word (production, staging, local).");
    }
    if let Some(u) = &plan.url {
        let rest = u
            .strip_prefix("https://")
            .or_else(|| u.strip_prefix("http://"));
        if rest.is_none_or(|r| r.is_empty() || r.contains(char::is_whitespace)) {
            return bad("The URL starts with https:// or http://.");
        }
    }
    match &plan.db {
        Db::None => {}
        Db::New { database, user } | Db::Existing { database, user } => {
            if !plain(database, "_", 64) {
                return bad("The database name can use letters, digits and _.");
            }
            if !plain(user, "_", 32) {
                return bad("The database user can use letters, digits and _ (up to 32).");
            }
        }
    }
    if let Some(v) = &plan.vhost {
        if !valid_site_name(&v.name) {
            return bad("The vhost file name can use letters, digits, . _ -");
        }
        if v.content.trim().is_empty() || v.content.len() > 64 * 1024 {
            return bad("The vhost is empty or too big.");
        }
    }
    if let Some(w) = &plan.worker {
        if !valid_path(&w.file) || !w.file.ends_with(".conf") && !w.file.ends_with(".ini") {
            return bad("The queue worker file must be a full path ending in .conf.");
        }
        if !(1..=16).contains(&w.processes) {
            return bad("Queue workers: 1 to 16 processes.");
        }
    }
    if plan
        .certbot
        .iter()
        .any(|d| !valid_domain(d) || d.contains('*'))
    {
        return bad("certbot needs plain domain names (no wildcards).");
    }
    if !plan.certbot.is_empty() && plan.vhost.is_none() {
        return bad("certbot --nginx needs the nginx vhost step.");
    }
    if let Some(d) = &plan.domain {
        if !valid_domain(d) || d.contains('*') {
            return bad("The domain isn't a domain name.");
        }
    }
    Ok(())
}

// ----------------------------------------------------------------- script

const HELPERS: &str = r#"set -o pipefail
c(){ printf '\n\033[1;36m━━ %s/%s · %s\033[0m\n' "$1" "$N" "$2"; }
ok(){ printf '\033[32m✓\033[0m %s\n' "$*"; }
note(){ printf '\033[2m· %s\033[0m\n' "$*"; }
warn(){ printf '\033[33m! %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }
if [ "$(id -u)" = 0 ]; then S=""; else S="sudo"; fi
as_owner(){ if [ "$(id -un)" = "$OWN_USER" ]; then "$@"; elif [ "$(id -u)" = 0 ]; then runuser -u "$OWN_USER" -- "$@"; else sudo -u "$OWN_USER" -- "$@"; fi; }
envget(){ grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | sed -E "s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/"; }
envq(){ case "$1" in "") printf '""';; *[!A-Za-z0-9_./:@%+=,~-]*) case "$1" in *\'*) v=${1//\\/\\\\}; v=${v//\"/\\\"}; printf '"%s"' "$v";; *) printf "'%s'" "$1";; esac;; *) printf '%s' "$1";; esac; }
envset(){ K="$1" V="$2" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]} !d && $0 ~ ("^#? *" k "=") {print k "=" v; d=1; next} {print} END{if(!d) print k "=" v}' .env > .env.kemudi && cat .env.kemudi > .env && rm -f .env.kemudi || die "couldn't update .env"; }
"#;

const MYSQL_ROOT: &str = r#"my(){ $S mysql "$@"; }
if ! my -N -e 'SELECT 1' >/dev/null 2>&1; then
  read -rs -p "MySQL root password: " MYROOT; echo
  my(){ MYSQL_PWD="$MYROOT" mysql -u root "$@"; }
  my -N -e 'SELECT 1' >/dev/null || die "can't log in to MySQL as root"
fi
as_db(){ MYSQL_PWD="$DBPASS" mysql -h localhost -u "$DBUSER" "$@"; }
DBPASS=""
[ -f .env ] && [ "$(envget DB_USERNAME)" = "$DBUSER" ] && DBPASS=$(envget DB_PASSWORD)
"#;

const GRANT: &str = r#"my -e "CREATE DATABASE IF NOT EXISTS \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON \`$DB\`.* TO '$DBUSER'@'localhost'; FLUSH PRIVILEGES;" || die "couldn't create database $DB for $DBUSER""#;

/// `name='value'` lines for the script's variables.
fn vars(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}\n", shell_quote(v)))
        .collect()
}

fn worker_conf(plan: &Plan, w: &WorkerPlan) -> String {
    let user = plan.owner.split(':').next().unwrap_or(&plan.owner);
    format!(
        "[program:{id}-worker]
process_name=%(program_name)s_%(process_num)02d
command=/usr/bin/php{php} {path}/artisan queue:work --sleep=3 --tries=3 --max-time=3600
directory={path}
autostart=true
autorestart=true
stopasgroup=true
killasgroup=true
user={user}
numprocs={n}
redirect_stderr=true
stdout_logfile={path}/storage/logs/worker.log
stopwaitsecs=3600
",
        id = plan.id,
        php = plan.php,
        path = plan.path.trim_end_matches('/'),
        n = w.processes,
    )
}

/// `/etc/cron.d/laravel-<id>` (cron.d names: letters, digits, - and _).
fn cron_file(plan: &Plan) -> String {
    let id: String = plan
        .id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("/etc/cron.d/laravel-{id}")
}

fn cron_conf(plan: &Plan) -> String {
    let user = plan.owner.split(':').next().unwrap_or(&plan.owner);
    format!(
        "# Laravel scheduler for {id} (added by Kemudi's New app)\nSHELL=/bin/sh\n* * * * * {user} cd {dir} && /usr/bin/php{php} artisan schedule:run >> /dev/null 2>&1\n",
        id = plan.id,
        dir = plan.path.trim_end_matches('/'),
        php = plan.php,
    )
}

/// A hook as a step: in a subshell with `set -e` (its first failing command
/// stops it), from `dir`. Kemudi's helpers (`$S`, ok, note, warn, die) work
/// in it.
fn hook_step(dir: &str, title: &str, body: &str) -> String {
    let what: String = title.chars().filter(|c| !"\"$`\\".contains(*c)).collect();
    format!("cd \"{dir}\" || die \"can't open {dir}\"\n(\nset -e\n{body}\n)\n[ $? = 0 ] || die \"the {what} failed\"\n")
}

/// Hooks rendered for one run: (step title, shell).
#[derive(Debug, Default)]
pub struct Hooks {
    pub before: Vec<(String, String)>,
    pub after: Vec<(String, String)>,
}

/// The app as hooks see it: `app.*` like actions, plus `app.domain`,
/// `app.app_env` and `app.owner`.
fn hook_app(plan: &Plan, server: &Server) -> App {
    let mut vars = BTreeMap::new();
    if let Some(d) = plan.domain.as_deref().filter(|d| !d.is_empty()) {
        vars.insert("domain".to_string(), d.to_string());
    }
    vars.insert("app_env".to_string(), plan.app_env.clone());
    vars.insert("owner".to_string(), plan.owner.clone());
    App {
        id: plan.id.clone(),
        name: plan.name.trim().to_string(),
        path: plan.path.trim_end_matches('/').to_string(),
        branch: plan.branch.clone().filter(|b| !b.is_empty()),
        php: Some(plan.php.clone()),
        color: None,
        env: server.env,
        env_set: false,
        repo: Some(plan.repo.trim().to_string()),
        url: plan.url.clone(),
        vhost_files: vec![],
        supervisor_files: vec![],
        vars,
        actions: vec![],
        hidden: vec![],
    }
}

fn render_hook(source: &str, server: &Server, app: &App) -> Result<String, String> {
    let (text, missing) = render::render_with(source, server, Some(app), &BTreeMap::new())?;
    if !missing.is_empty() {
        return Err(format!(
            "hooks can't ask for values ({}); use app.* and server.*",
            missing.join(", ")
        ));
    }
    Ok(text)
}

/// Does a hook render for a made-up app on this server? (config check)
pub fn check_hook(source: &str, server: &Server) -> Result<(), String> {
    let sample = Plan {
        id: "example".into(),
        name: "Example".into(),
        repo: "git@git.example.com:team/example.git".into(),
        branch: Some("main".into()),
        path: "/var/www/example".into(),
        php: "8.4".into(),
        owner: "www-data:www-data".into(),
        app_env: "production".into(),
        url: Some("https://example.com".into()),
        npm: false,
        migrate: true,
        seed: false,
        db: Db::None,
        vhost: None,
        worker: None,
        certbot: vec![],
        schedule: true,
        domain: Some("example.com".into()),
    };
    render_hook(source, server, &hook_app(&sample, server)).map(|_| ())
}

/// The team's hooks, then the server's, rendered for this app.
fn hooks_for(config: &Config, server: &Server, plan: &Plan) -> AppResult<Hooks> {
    let app = hook_app(plan, server);
    let team = server
        .team
        .as_ref()
        .and_then(|t| config.teams.iter().find(|x| &x.id == t));
    let mut out = Hooks::default();
    let sources = team
        .map(|t| (format!("team {}", t.name), &t.new_app))
        .into_iter()
        .chain([(server.id.clone(), &server.new_app)]);
    for (who, h) in sources {
        for (which, src, list) in [
            ("before", &h.before, &mut out.before),
            ("after", &h.after, &mut out.after),
        ] {
            if let Some(src) = src {
                let text = render_hook(src, server, &app).map_err(|e| {
                    AppError::Invalid(format!("New app's {which} hook ({who}): {e}"))
                })?;
                list.push((format!("{which} hook ({who})"), text));
            }
        }
    }
    Ok(out)
}

/// The whole setup as one bash script (run with `bash -c`).
pub fn script(plan: &Plan, hooks: &Hooks) -> String {
    let dir = plan.path.trim_end_matches('/');
    let own_user = plan.owner.split(':').next().unwrap_or(&plan.owner);
    let production = plan.app_env == "production";
    let branch = plan.branch.as_deref().unwrap_or("").trim();
    let mut steps: Vec<(&str, String)> = vec![];

    // 1. Check tools first, so nothing is half-done for a missing one.
    let mut s = String::from(
        r#"PHPBIN=$(command -v "php$PHPV") || die "php$PHPV isn't installed on this server"
command -v git >/dev/null || die "git isn't installed"
COMPOSER=$(command -v composer) || die "composer isn't installed"
id "$OWN_USER" >/dev/null 2>&1 || die "there's no user $OWN_USER"
"#,
    );
    if plan.npm {
        s.push_str("command -v npm >/dev/null || die \"npm isn't installed\"\n");
    }
    if !matches!(plan.db, Db::None) {
        s.push_str("command -v mysql >/dev/null || die \"the mysql client isn't installed\"\n");
    }
    if plan.vhost.is_some() {
        s.push_str("[ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ] || die \"nginx has no sites-available / sites-enabled\"\n");
    }
    if plan.worker.is_some() {
        s.push_str("command -v supervisorctl >/dev/null || die \"Supervisor isn't installed\"\n");
    }
    if !plan.certbot.is_empty() {
        s.push_str("command -v certbot >/dev/null || die \"certbot isn't installed\"\n");
    }
    s.push_str(
        r#"if [ -n "$S" ]; then note "sudo is needed for folders, nginx, Supervisor and MySQL"; sudo -v || die "sudo didn't work"; fi
ok "php$PHPV ($PHPBIN), composer, git"
"#,
    );
    steps.push(("Check the server", s));
    for (title, body) in &hooks.before {
        steps.push((title, hook_step("$HOME", title, body)));
    }

    // 2. Clone.
    let clone_branch = if branch.is_empty() {
        String::new()
    } else {
        "--branch \"$BRANCH\" ".into()
    };
    steps.push((
        "Clone the repository",
        format!(
            r#"export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"
if [ -d "$DIR/.git" ]; then
  cur=$(git -c safe.directory="$DIR" -C "$DIR" remote get-url origin 2>/dev/null)
  [ "$cur" = "$REPO" ] || die "$DIR is already a clone of ${{cur:-another repository}}"
  note "already cloned"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR already exists and isn't empty"
else
  $S mkdir -p "$DIR" || die "can't create $DIR"
  [ -w "$DIR" ] || $S chown "$(id -un)" "$DIR" || die "can't write to $DIR"
  git clone {clone_branch}"$REPO" "$DIR" || die "git clone failed: can this server's key read $REPO?"
  ok "cloned into $DIR"
fi
cd "$DIR" || die "can't open $DIR"
if [ ! -w "$DIR" ] || [ ! -w "$DIR/vendor" -a -d "$DIR/vendor" ]; then
  note "taking the folder back from its owner for the build (it's handed back below)"
  $S chown -R "$(id -un)" "$DIR" || die "chown failed"
fi
"#
        ),
    ));

    // 3. Database.
    match &plan.db {
        Db::None => {}
        Db::New { .. } => steps.push((
            "Database",
            format!(
                r#"{MYSQL_ROOT}if [ "$(my -N -e "SELECT COUNT(*) FROM mysql.user WHERE user='$DBUSER'")" != 0 ]; then
  [ -n "$DBPASS" ] && as_db -e 'SELECT 1' >/dev/null 2>&1 || die "MySQL user $DBUSER already exists: choose “Existing user” instead"
  note "MySQL user $DBUSER is already set up"
else
  DBPASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
  [ ${{#DBPASS}} = 32 ] || die "couldn't make a password"
  my -e "CREATE USER '$DBUSER'@'localhost' IDENTIFIED BY '$DBPASS';" || die "couldn't create MySQL user $DBUSER"
  ok "created MySQL user $DBUSER (its password is only in .env)"
fi
{GRANT}
ok "database $DB for $DBUSER"
"#
            ),
        )),
        Db::Existing { .. } => steps.push((
            "Database",
            format!(
                r#"{MYSQL_ROOT}if [ -z "$DBPASS" ] || ! as_db -e 'SELECT 1' >/dev/null 2>&1; then
  read -rs -p "Password for MySQL user $DBUSER (goes only into .env): " DBPASS; echo
  as_db -e 'SELECT 1' >/dev/null || die "can't log in to MySQL as $DBUSER with that password"
fi
if as_db -e "USE \`$DB\`" 2>/dev/null; then
  note "$DBUSER can already use database $DB"
else
  {GRANT}
  ok "database $DB, granted to $DBUSER"
fi
"#
            ),
        )),
    }

    // 4. .env
    let mut s = String::from(
        r#"if [ -f .env ]; then note ".env is already there; setting Kemudi's keys only"
elif [ -f .env.example ]; then cp .env.example .env && ok "copied .env.example to .env"
else : > .env; note "no .env.example; starting an empty .env"; fi
envset APP_NAME "$(envq "$NAME")"
envset APP_ENV "$APPENV"
"#,
    );
    s.push_str(&format!(
        "envset APP_DEBUG {}\n",
        if production { "false" } else { "true" }
    ));
    if plan.url.is_some() {
        s.push_str("envset APP_URL \"$URL\"\n");
    }
    if !matches!(plan.db, Db::None) {
        s.push_str(
            r#"envset DB_CONNECTION mysql
envset DB_HOST localhost
envset DB_PORT 3306
envset DB_DATABASE "$DB"
envset DB_USERNAME "$DBUSER"
envset DB_PASSWORD "$(envq "$DBPASS")"
"#,
        );
    }
    s.push_str("ok \".env: APP_NAME, APP_ENV, APP_DEBUG${URL:+, APP_URL}${DB:+, DB_*}\"\n");
    steps.push((".env", s));

    // 5. Composer.
    steps.push((
        "composer install",
        format!(
            "COMPOSER_ALLOW_SUPERUSER=1 \"$PHPBIN\" \"$COMPOSER\" install --no-interaction --prefer-dist --optimize-autoloader{} || die \"composer install failed\"\nok \"vendor/ is ready\"\n",
            if production { " --no-dev" } else { "" }
        ),
    ));

    // 6. Front-end.
    if plan.npm {
        steps.push((
            "Front-end build",
            r#"if [ -f package.json ]; then
  { [ -f package-lock.json ] && npm ci; } || npm install || die "npm install failed"
  npm run build || die "npm run build failed"
  ok "built"
else note "no package.json"; fi
"#
            .into(),
        ));
    }

    // 7. Owner and permissions.
    steps.push((
        "Owner and permissions",
        r#"$S chown -R "$OWNER" "$DIR" || die "chown failed"
$S chmod -R ug+rwX "$DIR/storage" "$DIR/bootstrap/cache" || die "chmod failed"
$S chmod 640 "$DIR/.env"
if ! git -C "$DIR" rev-parse >/dev/null 2>&1; then git config --global --add safe.directory "$DIR" && note "git: $DIR is marked safe for $(id -un), so git pull keeps working"; fi
ok "owned by $OWNER; storage/ and bootstrap/cache writable"
"#
        .into(),
    ));

    // 8. Artisan.
    let mut s = String::from(
        r#"art(){ as_owner "$PHPBIN" artisan "$@"; }
if [ -z "$(envget APP_KEY)" ]; then art key:generate --force || die "key:generate failed"; else note "APP_KEY is already set"; fi
[ -L public/storage ] || art storage:link || warn "storage:link failed"
"#,
    );
    if plan.migrate {
        s.push_str(&format!(
            "art migrate --force{} || die \"migrate failed\"\n",
            if plan.seed { " --seed" } else { "" }
        ));
    }
    steps.push(("Laravel", s));

    // 9. nginx.
    if let Some(v) = &plan.vhost {
        steps.push((
            "nginx vhost",
            format!(
                r#"f=/etc/nginx/sites-available/{name}; l=/etc/nginx/sites-enabled/{name}
new=$(mktemp) || die "mktemp failed"
base64 -d > "$new" <<'KEMUDI_B64'
{body}
KEMUDI_B64
if [ -e "$f" ]; then
  if $S cmp -s "$new" "$f"; then note "$f is already there"
  elif $S grep -q "managed by Certbot" "$f"; then note "$f is already there (with certbot's HTTPS)"
  else rm -f "$new"; die "$f already exists and is different: pick another file name"; fi
  [ -e "$l" ] || $S ln -s "$f" "$l" || die "couldn't link $l"
else
  pre=0; $S nginx -t >/dev/null 2>&1 || pre=1
  $S install -m 644 "$new" "$f" && $S ln -sf "$f" "$l" || {{ rm -f "$new"; die "couldn't write $f"; }}
  if ! $S nginx -t; then
    if [ $pre = 0 ]; then $S rm -f "$l" "$f"; rm -f "$new"; die "nginx -t failed with the new site, so it was removed again"; fi
    warn "nginx -t was already failing before this site"
  fi
  ok "wrote $f"
fi
rm -f "$new"
$S systemctl reload nginx || $S nginx -s reload || die "couldn't reload nginx"
ok "nginx reloaded"
"#,
                name = shell_quote(&v.name),
                body = base64_body(&v.content),
            ),
        ));
    }

    // 10. Queue worker.
    if let Some(w) = &plan.worker {
        steps.push((
            "Queue worker",
            format!(
                r#"wf={file}
new=$(mktemp) || die "mktemp failed"
base64 -d > "$new" <<'KEMUDI_B64'
{body}
KEMUDI_B64
if [ -e "$wf" ]; then
  if $S cmp -s "$new" "$wf"; then note "$wf is already there"; else rm -f "$new"; die "$wf already exists and is different"; fi
else
  $S install -m 644 "$new" "$wf" || {{ rm -f "$new"; die "couldn't write $wf"; }}
  ok "wrote $wf"
fi
rm -f "$new"
$S supervisorctl reread >/dev/null && $S supervisorctl update || die "supervisorctl update failed"
sleep 2; $S supervisorctl status "$ID-worker:*" || warn "the worker isn't running yet: see storage/logs/worker.log"
"#,
                file = shell_quote(&w.file),
                body = base64_body(&worker_conf(plan, w)),
            ),
        ));
    }

    // 10b. Laravel's scheduler.
    if plan.schedule {
        steps.push((
            "Scheduler (cron)",
            format!(
                r#"cf={file}
others=$(grep -rlsF -- "$DIR" /etc/crontab /etc/cron.d 2>/dev/null | grep -vx "$cf" | xargs -r grep -ls schedule:run)
if [ -n "$others" ] || $S crontab -l -u "$OWN_USER" 2>/dev/null | grep -F -- "$DIR" | grep -q schedule:run; then
  note "a cron entry for $DIR is already there; not adding another"
else
  new=$(mktemp) || die "mktemp failed"
  base64 -d > "$new" <<'KEMUDI_B64'
{body}
KEMUDI_B64
  if [ -e "$cf" ] && $S cmp -s "$new" "$cf"; then note "$cf is already there"
  else $S install -m 644 "$new" "$cf" || {{ rm -f "$new"; die "couldn't write $cf"; }}; ok "$cf: schedule:run every minute as $OWN_USER"; fi
  rm -f "$new"
fi
"#,
                file = shell_quote(&cron_file(plan)),
                body = base64_body(&cron_conf(plan)),
            ),
        ));
    }

    // 11. HTTPS (never fails the run: the app works over http meanwhile).
    if !plan.certbot.is_empty() {
        let names: String = plan
            .certbot
            .iter()
            .map(|d| format!(" -d {}", shell_quote(d)))
            .collect();
        steps.push((
            "HTTPS certificate",
            format!(
                r#"if $S certbot --nginx{names} --redirect --keep-until-expiring; then ok "HTTPS is on"
else warn "certbot didn't finish; the app works over http. Its DNS must point here: try again from Health ▸ SSL later."; fi
"#
            ),
        ));
    }

    for (title, body) in &hooks.after {
        steps.push((title, hook_step("$DIR", title, body)));
    }

    let (db, dbuser) = match &plan.db {
        Db::None => ("", ""),
        Db::New { database, user } | Db::Existing { database, user } => {
            (database.as_str(), user.as_str())
        }
    };
    let mut out = String::from("# Kemudi: set up a new Laravel app\n");
    out.push_str(&vars(&[
        ("N", &steps.len().to_string()),
        ("ID", &plan.id),
        ("NAME", plan.name.trim()),
        ("REPO", plan.repo.trim()),
        ("BRANCH", branch),
        ("DIR", dir),
        ("PHPV", &plan.php),
        ("OWNER", &plan.owner),
        ("OWN_USER", own_user),
        ("APPENV", &plan.app_env),
        ("URL", plan.url.as_deref().unwrap_or("")),
        ("DB", db),
        ("DBUSER", dbuser),
    ]));
    out.push_str(HELPERS);
    for (i, (title, body)) in steps.iter().enumerate() {
        out.push_str(&format!("\nc {} {}\n", i + 1, shell_quote(title)));
        out.push_str(body);
    }
    out.push_str(
        "\nprintf '\\n\\033[1;32m✓ %s is set up\\033[0m %s\\n' \"$NAME\" \"${URL:-$DIR}\"\n",
    );
    out
}

/// The script, for the wizard's review page.
#[tauri::command]
pub async fn newapp_script(
    state: State<'_, AppState>,
    server_id: String,
    plan: Plan,
) -> AppResult<String> {
    let server = lookup(&state, &server_id)?;
    check(&plan)?;
    let config = loaded(&state)?;
    Ok(script(&plan, &hooks_for(&config, &server, &plan)?))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAppRun {
    pub pty_id: PtyId,
    pub audit_id: Option<i64>,
}

/// Run the setup in a new terminal tab on the server.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn newapp_run(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    plan: Plan,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<PtyEvent>,
) -> AppResult<NewAppRun> {
    let size: PtySize = pty_size(cols, rows)?;
    let server = lookup(&state, &server_id)?;
    if server.app(plan.id.trim()).is_some() {
        return Err(AppError::Invalid(format!(
            "{} already has an app `{}`",
            server.id, plan.id
        )));
    }
    check(&plan)?;
    crate::preflight::commands::ensure_reachable(&app, &server_id).await?;
    let config = loaded(&state)?;
    let body = script(&plan, &hooks_for(&config, &server, &plan)?);
    let label = format!("New app {}", plan.id);
    let audit_id = state.audit.as_ref().ok().and_then(|log| {
        log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: None,
            action_id: "newapp",
            label: &label,
            env: server.env.as_str(),
            kind: "ssh",
            command: &body,
            edited: false,
        })
        .map_err(|e| eprintln!("kemudi: audit log write failed: {e}"))
        .ok()
    });
    let hooks = match (audit_id, state.audit.as_ref()) {
        (Some(id), Ok(log)) => {
            let (a, b) = (log.clone(), log.clone());
            ExitHooks {
                on_action_exit: Some(Box::new(move |code| {
                    let _ = a.finish(id, Some(code));
                })),
                on_exit: Some(Box::new(move || {
                    let _ = b.finish(id, None);
                })),
            }
        }
        _ => ExitHooks::default(),
    };
    let env = state.env_ready().await;
    let cmd = invocation::command_for(
        ActionKind::Ssh,
        &server.host,
        &format!("bash -c {}", shell_quote(&body)),
        env,
        state.shell_integration(),
    );
    let launch = Launch::tracked(cmd)
        .with_hooks(hooks)
        .on_host(server.host.clone());
    let pty_id = match state.ptys.spawn(launch, size, on_data, on_event) {
        Ok(id) => id,
        Err(e) => {
            if let (Some(id), Ok(log)) = (audit_id, state.audit.as_ref()) {
                let _ = log.finish(id, None);
            }
            return Err(e);
        }
    };
    Ok(NewAppRun { pty_id, audit_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn plan() -> Plan {
        Plan {
            id: "akaun".into(),
            name: "Akaun Staging".into(),
            repo: "git@git.example.com:team/akaun.git".into(),
            branch: Some("develop".into()),
            path: "/opt/www/staging.example.com/akaun".into(),
            php: "8.4".into(),
            owner: "www-data:www-data".into(),
            app_env: "staging".into(),
            url: Some("https://akaun.staging.example.com".into()),
            npm: true,
            migrate: true,
            seed: false,
            db: Db::New {
                database: "akaun".into(),
                user: "akaun".into(),
            },
            vhost: Some(VhostPlan {
                name: "akaun.staging.example.com".into(),
                content: "server {\n    listen 80;\n    root /opt/www/staging.example.com/akaun/public;\n}\n".into(),
            }),
            worker: Some(WorkerPlan {
                file: "/etc/supervisor/conf.d/akaun-worker.conf".into(),
                processes: 2,
            }),
            certbot: vec!["akaun.staging.example.com".into()],
            schedule: true,
            domain: Some("akaun.staging.example.com".into()),
        }
    }

    #[test]
    fn script_is_valid_bash() {
        let mut p = plan();
        for db in [
            Db::None,
            Db::Existing {
                database: "a".into(),
                user: "b".into(),
            },
            p.db.clone(),
        ] {
            p.db = db;
            check(&p).expect("valid plan");
            let s = script(&p, &Hooks::default());
            let out = std::process::Command::new("bash")
                .arg("-n")
                .arg("-c")
                .arg(&s)
                .output()
                .expect("bash");
            assert!(
                out.status.success(),
                "{}\n{s}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        let s = script(&plan(), &Hooks::default());
        assert!(s.contains("N=12\n"), "12 steps with everything on");
        assert!(s.contains("certbot --nginx -d akaun.staging.example.com --redirect"));
        assert!(s.contains("--branch \"$BRANCH\""));
        assert!(!s.contains("--no-dev"), "staging keeps dev packages");
        assert!(s.contains("NAME='Akaun Staging'"));
    }

    /// `KEMUDI_NEWAPP_OUT=<file> cargo test dump_newapp -- --ignored`: the
    /// script for a Docker test (local repo, no certbot/npm).
    #[test]
    #[ignore]
    fn dump_newapp() {
        let Ok(out) = std::env::var("KEMUDI_NEWAPP_OUT") else {
            return;
        };
        let mut p = plan();
        p.repo = "/srv/repo.git".into();
        p.branch = Some("main".into());
        p.php = "8.3".into();
        p.npm = false;
        p.certbot = vec![];
        let mut hooks = Hooks::default();
        if std::env::var("KEMUDI_NEWAPP_WILD").is_ok() {
            p.vhost = None;
            p.path = "/opt/www/staging.example.com/akaun2".into();
            p.id = "akaun2".into();
            p.worker = None;
            p.db = Db::None;
            p.migrate = false;
            p.domain = Some("akaun2.staging.example-it.com".into());
            let w = wildcard();
            let server = server();
            let hook = php_versions_hook(&w).expect("hook");
            let app = hook_app(&p, &server);
            hooks.before.push((
                "before hook (test)".into(),
                "note \"hello from $(pwd)\"".into(),
            ));
            hooks.after.push((
                "after hook (stg)".into(),
                render_hook(&hook, &server, &app).expect("render"),
            ));
        }
        if std::env::var("KEMUDI_NEWAPP_DB").as_deref() == Ok("existing") {
            p.db = Db::Existing {
                database: "shared".into(),
                user: "olduser".into(),
            };
        }
        std::fs::write(out, script(&p, &hooks)).expect("write");
    }

    fn server() -> Server {
        crate::config::validate::parse("servers:\n  - { id: stg, host: stg, env: staging }\n")
            .config
            .expect("config")
            .servers
            .remove(0)
    }

    fn wildcard() -> Wildcard {
        Wildcard {
            file: "/etc/nginx/sites-enabled/wild".into(),
            root: "/opt/www/staging.example.com/$subdomain".into(),
            var: "subdomain".into(),
            suffix: ".staging.example-it.com".into(),
            ssl: true,
            php: WildPhp::Ifs {
                file: "/etc/nginx/php-versions.conf".into(),
                var: "phpversion".into(),
                default: Some("8.1".into()),
                hosts: vec![],
            },
            hook: None,
        }
    }

    #[test]
    fn hooks_render_and_run_in_order() {
        let p = plan();
        let s = server();
        let app = hook_app(&p, &s);
        assert_eq!(
            render_hook(
                "echo {{ app.domain }} {{ app.php }} {{ app.path }} {{ server.id }}",
                &s,
                &app
            )
            .as_deref(),
            Ok("echo akaun.staging.example.com 8.4 /opt/www/staging.example.com/akaun stg")
        );
        assert!(render_hook("nc {{ ip }}", &s, &app)
            .unwrap_err()
            .contains("can't ask"));
        assert!(check_hook("{{ app.domain }}", &s).is_ok());
        assert!(check_hook("{{ app.nope }}", &s).is_err());
        let hook = php_versions_hook(&wildcard()).expect("ifs → hook");
        assert!(hook.contains("{{ app.domain }}") && hook.contains("/etc/nginx/php-versions.conf"));
        let hooks = Hooks {
            before: vec![("before hook (stg)".into(), "echo one".into())],
            after: vec![(
                "after hook (stg)".into(),
                render_hook(&hook, &s, &app).expect("render"),
            )],
        };
        let script = script(&p, &hooks);
        let before = script.find("echo one").expect("before");
        let clone = script.find("Clone the repository").expect("clone");
        let after = script.find("after hook (stg)").expect("after");
        let certbot = script.find("HTTPS certificate").expect("certbot");
        assert!(
            before < clone && certbot < after,
            "before runs before the clone, after last"
        );
        assert!(script.contains("/etc/cron.d/laravel-akaun"));
        let out = std::process::Command::new("bash")
            .args(["-n", "-c", &script])
            .output()
            .expect("bash");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn rejects_bad_plans() {
        let ok = plan();
        assert!(check(&ok).is_ok());
        let cases: Vec<fn(&mut Plan)> = vec![
            |p| p.path = "/opt/www/../etc".into(),
            |p| p.path = "/opt".into(),
            |p| p.path = "/opt/www/my app".into(),
            |p| p.repo = "https://user:token@github.com/x/y.git".into(),
            |p| p.repo = "--upload-pack=x".into(),
            |p| p.branch = Some("-x".into()),
            |p| p.owner = "www data".into(),
            |p| p.php = "latest".into(),
            |p| {
                p.db = Db::New {
                    database: "a;drop".into(),
                    user: "u".into(),
                }
            },
            |p| p.certbot = vec!["*.example.com".into()],
            |p| {
                p.worker = Some(WorkerPlan {
                    file: "/etc/x".into(),
                    processes: 1,
                })
            },
            |p| p.id = "-x".into(),
        ];
        for (i, f) in cases.iter().enumerate() {
            let mut p = plan();
            f(&mut p);
            assert!(check(&p).is_err(), "case {i} should be rejected");
        }
    }

    #[test]
    fn parses_probe_and_repo_check() {
        let out = "@@nginx yes\n@@sockets\n/run/php/php8.4-fpm.sock\n@@end\n@@user root 0\n@@tool git\n@@tool composer\n@@tool mysql\n@@tool supervisorctl\n@@phps\n8.4\n8.3\n@@keys\n/root/.ssh/id_rsa.pub\tssh-rsa AAAA root@x\n@@owners\nwww-data:www-data\nwww-data:www-data\nroot:root\n@@supinc\n/etc/supervisor/conf.d/*.conf\n/etc/supervisor/conf.d/*/*.conf\n@@mysql\n@@dbusers\nbilling\n@@dbs\nbilling\n@@done\n";
        let p = parse_extra(out, parse_probe(out));
        assert!(p.root && p.vhost.nginx && p.mysql);
        assert_eq!(p.user, "root");
        assert_eq!(p.php_versions, ["8.4", "8.3"]);
        assert_eq!(p.owner.as_deref(), Some("www-data:www-data"));
        assert_eq!(p.supervisor_dir.as_deref(), Some("/etc/supervisor/conf.d"));
        assert_eq!(p.supervisor_ext, ".conf");
        assert_eq!(p.keys[0].key, "ssh-rsa AAAA root@x");
        assert_eq!((p.db_users.len(), p.databases.len()), (1, 1));

        let r = parse_repo_check(
            "@@ok\nref: refs/heads/main\tHEAD\nabc\trefs/heads/main\ndef\trefs/heads/develop\n",
        );
        assert!(r.ok);
        assert_eq!(r.default_branch.as_deref(), Some("main"));
        assert_eq!(r.branches, ["main", "develop"]);
        let r = parse_repo_check("@@fail\ngit@x: Permission denied (publickey).\nfatal: Could not read from remote repository.\n");
        assert!(!r.ok && r.error.unwrap().contains("Permission denied"));
    }
}
