//! servers.yaml: the raw file shape (strict, typo-catching) and the resolved
//! model the rest of the app and the frontend use.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};

// ---------------------------------------------------------------- raw file

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawConfig {
    /// Teams servers belong to (like DigitalOcean teams), each with its own
    /// shared actions.
    #[serde(default)]
    pub teams: Vec<RawTeam>,
    #[serde(default)]
    pub servers: Vec<RawServer>,
    #[serde(default)]
    pub actions: RawActions,
    #[serde(default)]
    pub terminal: TerminalSettings,
    /// Which editor "Edit in servers.yaml" opens (default: first installed of
    /// Sublime Text, VS Code, PhpStorm; else the system text editor).
    pub editor: Option<Editor>,
    /// Named lists of steps (local commands, server commands, actions,
    /// pauses) run one after another in one terminal tab.
    #[serde(default)]
    pub workflows: Vec<RawWorkflow>,
    /// What every server should have: repos cloned into one folder, and
    /// lines in root's ~/.bashrc (Server setup ▸ Helpers).
    pub baseline: Option<Baseline>,
    /// Server setup: named profiles of what a server should have (packages,
    /// PHP, SSH, firewall…), checked read-only and fixed on request.
    pub setup: Option<RawSetup>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawSetup {
    /// The profile of servers that don't name one (`setup:` on a server).
    pub default: Option<String>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

/// A server setup profile. Everything is optional: what's left out isn't
/// checked. `extends` starts from another profile (what's set here wins;
/// lists replace the other's).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct Profile {
    pub id: String,
    pub name: Option<String>,
    pub extends: Option<String>,
    /// e.g. Asia/Kuala_Lumpur.
    pub timezone: Option<String>,
    /// The clock kept in sync (systemd-timesyncd).
    pub ntp: Option<bool>,
    /// No pending package upgrades (Fix: apt upgrade).
    pub updates: Option<bool>,
    /// Security updates installed automatically.
    pub unattended_upgrades: Option<bool>,
    /// apt packages that must be installed.
    pub packages: Option<Vec<String>>,
    pub php: Option<PhpSetup>,
    /// Composer in /usr/local/bin.
    pub composer: Option<bool>,
    /// What mysql_secure_installation does: no anonymous users, no remote
    /// root, no test database.
    pub mysql_secure: Option<bool>,
    pub ssh: Option<SshSetup>,
    pub firewall: Option<FirewallSetup>,
    /// `true` (3 tries in 10m → banned 1h), `false`, or the numbers.
    pub fail2ban: Option<Toggle<Fail2banSetup>>,
    pub auditd: Option<bool>,
    pub lynis: Option<bool>,
    pub folders: Option<Vec<FolderSetup>>,
    pub users: Option<Vec<UserSetup>>,
    /// The helpers (`baseline:`: repos + root's ~/.bashrc lines). Default:
    /// on when there is a baseline.
    pub helpers: Option<bool>,
    /// Your own checks: a command that succeeds when all is well, and one
    /// that fixes it.
    pub custom: Option<Vec<CustomCheck>>,
}

/// `true` / `false`, or the settings (on).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Toggle<T> {
    Flag(bool),
    Set(T),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct PhpSetup {
    /// `"8.4"` (quote it: 8.10 would read as 8.1).
    pub version: Stringish,
    /// Package suffixes: fpm → php8.4-fpm.
    #[serde(default)]
    pub extensions: Vec<String>,
    /// From ppa:ondrej/php (default: yes).
    pub ppa: Option<bool>,
    /// The `php` command is this version (default: yes).
    pub default: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all(serialize = "camelCase"))]
pub struct SshSetup {
    pub port: Option<u16>,
    /// `false`: keys only.
    pub password_auth: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FirewallSetup {
    /// ufw rules besides SSH (always allowed): "Nginx Full", 6379/tcp…
    #[serde(default)]
    pub allow: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Fail2banSetup {
    pub maxretry: Option<u32>,
    #[serde(default, deserialize_with = "opt_stringish")]
    pub bantime: Option<String>,
    #[serde(default, deserialize_with = "opt_stringish")]
    pub findtime: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FolderSetup {
    pub path: String,
    /// `user` or `user:group`.
    pub owner: Option<String>,
    /// e.g. 775.
    #[serde(default, deserialize_with = "opt_stringish")]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserSetup {
    pub name: String,
    /// In the sudo group.
    pub sudo: Option<bool>,
    /// Set a password when it has none (you type it, in the terminal).
    pub password: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomCheck {
    pub id: Option<String>,
    pub name: String,
    /// Succeeds when all is well (its first line of output is shown).
    pub check: String,
    /// Run as root to fix it.
    pub fix: Option<String>,
    /// The check needs root too.
    pub root: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Baseline {
    /// Where the repos go (`/opt/www` by default; created when missing).
    #[serde(default = "opt_www")]
    pub dir: String,
    #[serde(default)]
    pub repos: Vec<BaselineRepo>,
    /// Lines root's ~/.bashrc must have (added when missing), e.g. an alias.
    #[serde(default)]
    pub bashrc: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BaselineRepo {
    /// Its folder under `dir`.
    pub name: String,
    /// What `git clone` gets.
    pub url: String,
}

fn opt_www() -> String {
    "/opt/www".into()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawWorkflow {
    pub id: String,
    pub name: Option<String>,
    /// Shown as a button in this server's / app's Actions panel.
    pub pin: Option<RawPin>,
    /// How a run opens: `steps` (progress, the default) or `terminal`.
    pub view: Option<WorkflowView>,
    /// Steps on an Auto Scaling group: `one-by-one` (default) or `all-at-once`.
    pub fleet: Option<FleetMode>,
    #[serde(default)]
    pub steps: Vec<RawStep>,
}

/// How a step on an AWS Auto Scaling group runs: on each instance one
/// after another, stopping at the first failure (the default), or on all of
/// them at once, a pane each.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FleetMode {
    #[default]
    OneByOne,
    AllAtOnce,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkflowView {
    #[default]
    Steps,
    Terminal,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawPin {
    pub server: String,
    pub app: Option<String>,
}

/// One step: exactly one of `local`, `run` (with `server`), `action` (with
/// `server`, maybe `app`) or `pause`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawStep {
    pub label: Option<String>,
    /// A command on this Mac.
    pub local: Option<String>,
    /// Where it starts (local: `~/…` allowed; server: a path there).
    pub dir: Option<String>,
    pub server: Option<String>,
    pub app: Option<String>,
    /// A command on `server`.
    pub run: Option<String>,
    /// Run it as root (sudo, or `sudo su` where that's the only way).
    #[serde(default)]
    pub root: bool,
    /// An action's id on `server` (and `app`).
    pub action: Option<String>,
    /// Wait for Enter (with this message) before going on.
    pub pause: Option<String>,
    /// Steps run at the same time, each in its own pane (this Mac, server
    /// or action steps); the run goes on when all have passed.
    pub parallel: Option<Vec<RawStep>>,
    /// A command left running in a side pane (e.g. `tail -f` a log) while
    /// the workflow goes on; on `server`, else this Mac.
    pub watch: Option<String>,
    /// A watch pane keeps running after the workflow ends.
    #[serde(default)]
    pub keep: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Editor {
    Sublime,
    Vscode,
    Phpstorm,
    /// The macOS default text editor (`open -t`; can't jump to a line).
    System,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawTeam {
    pub id: String,
    pub name: Option<String>,
    /// Its colour (the switcher badge, and tabs of its servers that set none).
    pub color: Option<TabColor>,
    /// Actions every app / server in this team gets (after the global ones;
    /// the same id replaces a global one).
    #[serde(default)]
    pub actions: RawActions,
    /// Shell run by New app for this team's servers (templates, like
    /// actions): before the clone, and after everything else.
    pub new_app_before: Option<String>,
    pub new_app_after: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawServer {
    pub id: String,
    pub name: Option<String>,
    /// The team it belongs to (a `teams:` id).
    pub team: Option<String>,
    /// A sidebar group (a heading the servers sharing it sit under).
    pub group: Option<String>,
    /// An ~/.ssh/config alias (or user@host). Not with `asg`.
    #[serde(default)]
    pub host: String,
    /// An AWS Auto Scaling group instead of one host: its running instances,
    /// looked up when used and reached through Session Manager.
    pub asg: Option<Asg>,
    pub env: Env,
    #[serde(default)]
    pub vpn: Vpn,
    /// TCP probe that decides whether the VPN is up.
    pub vpn_check: Option<HostPort>,
    /// Local command that brings the VPN up (openfortivpn).
    pub vpn_connect: Option<String>,
    /// Override the reachability probe target (default: from `ssh -G`).
    pub check: Option<HostPort>,
    /// Colour for this server's tabs (apps can override).
    pub color: Option<TabColor>,
    /// New app hooks for this server (after its team's).
    pub new_app_before: Option<String>,
    pub new_app_after: Option<String>,
    #[serde(default)]
    pub apps: Vec<RawApp>,
    /// Overrides/additions to the global server actions.
    #[serde(default)]
    pub actions: Vec<ActionDef>,
    /// Its server setup profile (`none`: not checked); else the default.
    pub setup: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawApp {
    pub id: String,
    pub name: Option<String>,
    pub path: String,
    #[serde(default, deserialize_with = "opt_stringish")]
    pub branch: Option<String>,
    /// `php: "8.4"` and `php: 8.4` are both accepted.
    #[serde(default, deserialize_with = "opt_stringish")]
    pub php: Option<String>,
    /// Colour for this app's tabs (else the server's).
    pub color: Option<TabColor>,
    /// This app's environment when it differs from the server's (a staging
    /// app on a production box).
    pub env: Option<Env>,
    /// Git remote URL (e.g. git@github.com:org/repo.git).
    pub repo: Option<String>,
    /// Where the app is on the web (https://app.example.com).
    pub url: Option<String>,
    /// Vhost / Supervisor config files Inspect always reads (e.g. a
    /// wildcard vhost that doesn't name this app's path).
    #[serde(default)]
    pub vhost_files: Vec<String>,
    #[serde(default)]
    pub supervisor_files: Vec<String>,
    /// Extra template variables, available as `app.<name>`.
    #[serde(default)]
    pub vars: BTreeMap<String, Stringish>,
    /// Overrides/additions to the global app and local actions.
    #[serde(default)]
    pub actions: Vec<ActionDef>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawActions {
    #[serde(default)]
    pub app: Vec<ActionDef>,
    #[serde(default)]
    pub server: Vec<ActionDef>,
    #[serde(default)]
    pub local: Vec<ActionDef>,
}

/// One action, or (in a server/app `actions:` list) an override of one.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionDef {
    pub id: String,
    pub label: Option<String>,
    pub run: Option<String>,
    pub danger: Option<bool>,
    /// How much to ask before running (overrides the env/danger default).
    pub confirm: Option<Confirm>,
    /// Hide an inherited action for this server/app.
    pub disabled: Option<bool>,
    /// For new per-app actions: run in a local shell instead of over SSH.
    pub local: Option<bool>,
}

// ------------------------------------------------------------ shared types

/// How much to ask before running an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confirm {
    /// Run on click.
    None,
    /// Show the command; one click to run.
    Warn,
    /// Show the command; type the server id to run.
    Type,
}

impl Confirm {
    /// When `confirm:` isn't set: prod + danger types, prod or danger warns.
    pub fn default_for(env: Env, danger: bool) -> Confirm {
        match (env, danger) {
            (Env::Prod, true) => Confirm::Type,
            (Env::Prod, false) | (_, true) => Confirm::Warn,
            _ => Confirm::None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Env {
    Prod,
    Staging,
    Qa,
    Dev,
}

impl Env {
    pub fn as_str(self) -> &'static str {
        match self {
            Env::Prod => "prod",
            Env::Staging => "staging",
            Env::Qa => "qa",
            Env::Dev => "dev",
        }
    }
}

/// Tab colours (same names as the tab right-click menu).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabColor {
    Red,
    Crimson,
    Maroon,
    Coral,
    Orange,
    Amber,
    Gold,
    Brown,
    Yellow,
    Lime,
    Green,
    Teal,
    Cyan,
    Blue,
    Indigo,
    Purple,
    Pink,
    Gray,
}

impl TabColor {
    pub fn as_str(self) -> &'static str {
        match self {
            TabColor::Red => "red",
            TabColor::Crimson => "crimson",
            TabColor::Maroon => "maroon",
            TabColor::Coral => "coral",
            TabColor::Amber => "amber",
            TabColor::Gold => "gold",
            TabColor::Orange => "orange",
            TabColor::Yellow => "yellow",
            TabColor::Green => "green",
            TabColor::Cyan => "cyan",
            TabColor::Purple => "purple",
            TabColor::Pink => "pink",
            TabColor::Brown => "brown",
            TabColor::Lime => "lime",
            TabColor::Teal => "teal",
            TabColor::Blue => "blue",
            TabColor::Indigo => "indigo",
            TabColor::Gray => "gray",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Vpn {
    #[default]
    None,
    Openfortivpn,
    Globalprotect,
}

/// `asg: { name, profile, region, root }`: the group, the AWS CLI profile
/// and region it's in, and whether shells and actions run as root (`sudo`,
/// the default) or as Session Manager's own user. Instead of a group's
/// `name`, `instances: [i-…]` names fixed EC2 instances.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asg {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub instances: Vec<String>,
    pub profile: Option<String>,
    pub region: Option<String>,
    #[serde(default = "yes")]
    pub root: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostPort {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TerminalSettings {
    #[serde(alias = "font_family")]
    pub font_family: Option<String>,
    #[serde(alias = "font_size")]
    pub font_size: Option<f64>,
    /// Mark commands/output so the terminal can show blocks (default on).
    #[serde(alias = "shell_integration")]
    pub shell_integration: Option<bool>,
    /// Multiplier on xterm's natural cell height (default 1.25 ≈ Warp's 1.5).
    #[serde(alias = "line_height")]
    pub line_height: Option<f64>,
    #[serde(alias = "option_as_meta")]
    pub option_as_meta: Option<bool>,
    pub scrollback: Option<u32>,
}

/// A YAML scalar read as text (so `8.4`, `true` and `"8.4"` all work).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stringish(pub String);

impl<'de> Deserialize<'de> for Stringish {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Scalar {
            S(String),
            I(i64),
            F(f64),
            B(bool),
        }
        Ok(Stringish(match Scalar::deserialize(d)? {
            Scalar::S(s) => s,
            Scalar::I(i) => i.to_string(),
            Scalar::F(f) => f.to_string(),
            Scalar::B(b) => b.to_string(),
        }))
    }
}

fn opt_stringish<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(Option::<Stringish>::deserialize(d)?.map(|s| s.0))
}

// ---------------------------------------------------------- resolved model

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub teams: Vec<Team>,
    pub servers: Vec<Server>,
    pub terminal: TerminalSettings,
    pub editor: Option<Editor>,
    pub workflows: Vec<Workflow>,
    pub baseline: Option<Baseline>,
    pub setup: Setup,
}

/// Server setup, resolved: profiles with `extends` applied.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub default: Option<String>,
    pub profiles: Vec<Profile>,
    /// Servers that name a profile (or `none`).
    pub assigned: BTreeMap<String, String>,
}

impl Config {
    /// The setup profile a server is checked against, if any.
    pub fn profile_for(&self, server_id: &str) -> Option<&Profile> {
        let id = self.setup.assigned.get(server_id).or(self.setup.default.as_ref())?;
        self.setup.profiles.iter().find(|p| &p.id == id)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub pin_server: Option<String>,
    pub pin_app: Option<String>,
    pub view: WorkflowView,
    pub fleet: FleetMode,
    pub steps: Vec<Step>,
    /// 1-based line in servers.yaml.
    pub line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub label: Option<String>,
    #[serde(flatten)]
    pub kind: StepKind,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StepKind {
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
    Parallel {
        branches: Vec<Step>,
    },
    Watch {
        server: Option<String>,
        run: String,
        root: bool,
        dir: Option<String>,
        keep: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    pub color: Option<TabColor>,
    pub new_app: NewAppHooks,
}

/// Shell that New app runs before the clone and after everything else.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAppHooks {
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    pub team: Option<String>,
    pub group: Option<String>,
    /// Empty for an `asg` server.
    pub host: String,
    pub asg: Option<Asg>,
    pub env: Env,
    pub vpn: Vpn,
    pub vpn_check: Option<HostPort>,
    pub vpn_connect: Option<String>,
    pub check: Option<HostPort>,
    pub color: Option<TabColor>,
    pub new_app: NewAppHooks,
    pub apps: Vec<App>,
    /// Server-level actions (nginx, queues…), resolved.
    pub actions: Vec<Action>,
    /// Shared server actions hidden on this server (`disabled: true`).
    pub hidden: Vec<Action>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub id: String,
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub php: Option<String>,
    pub color: Option<TabColor>,
    /// The app's environment: its own `env:`, else the server's. Guardrails
    /// for the app's actions and files go by this.
    pub env: Env,
    /// `env:` is set on the app itself (not inherited from the server).
    pub env_set: bool,
    pub repo: Option<String>,
    pub url: Option<String>,
    pub vhost_files: Vec<String>,
    pub supervisor_files: Vec<String>,
    pub vars: BTreeMap<String, String>,
    /// App and local actions, resolved with this app's overrides.
    pub actions: Vec<Action>,
    /// Shared app actions hidden on this app (`disabled: true`).
    pub hidden: Vec<Action>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionKind {
    /// `ssh -t <host> …` in a new tab.
    Ssh,
    /// A local shell tab on this Mac.
    Local,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    pub label: String,
    /// The template source; rendered per server/app when run.
    pub run: String,
    /// The command comes from the global `actions:` list (shared by every
    /// app/server that doesn't override `run`).
    pub shared: bool,
    /// The id is in the global `actions:` list (shared, or overridden here).
    pub inherited: bool,
    /// It comes from this team's shared list (not the global one).
    pub team: Option<String>,
    pub danger: bool,
    /// Explicit `confirm:` from servers.yaml (None = env/danger default).
    pub confirm: Option<Confirm>,
    pub kind: ActionKind,
    /// 1-based line in servers.yaml of the definition that applies here
    /// (the app/server override, else the global entry).
    pub line: Option<usize>,
}

impl Config {
    pub fn server(&self, id: &str) -> Option<&Server> {
        self.servers.iter().find(|s| s.id == id)
    }
}

impl Server {
    pub fn app(&self, id: &str) -> Option<&App> {
        self.apps.iter().find(|a| a.id == id)
    }
}
