//! Watch: the background checks behind Home's *Needs attention* and the
//! fleet grid. Read-only, over the same ssh connection the server's tabs
//! use; nothing else calls out.
//!
//! Each check has its own interval (Settings ▸ Checks): **system** (disks,
//! inodes, load, memory, swap, failed units; hourly), **updates** (pending
//! and security updates, restart needed, each app's APP_DEBUG and
//! maintenance mode; every 6 h), **certificates** (daily, every 4 h once one
//! is close) and **setup** (against the server's profile; daily). Results
//! are kept in `data_dir()/watch.json` with when they were read, so a launch
//! shows the last ones straight away and only checks what's due. System and
//! updates go in one ssh command when both are due. Only servers that answer
//! the reachability probe are checked; the others keep their last values.
//! A Health or Setup tab's check counts too.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Notify, Semaphore};

use crate::actions::render::shell_quote;
use crate::config::schema::{Config, Env, Server, Vpn};
use crate::error::{AppError, AppResult};
use crate::AppState;

pub const EVENT: &str = "watch://changed";
/// How many servers are checked at once.
const AT_ONCE: usize = 3;
/// A check that failed is tried again after this long (or its own interval
/// when that's shorter).
const RETRY_SECS: i64 = 30 * 60;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Background checks at all (off: only Refresh).
    pub enabled: bool,
    /// Reachability probe (a TCP connect, no ssh), minutes.
    pub reach_mins: u32,
    /// Intervals; 0 turns that check off (Refresh still runs it).
    pub system_mins: u32,
    pub updates_hours: u32,
    pub certs_hours: u32,
    /// Certificates again this often once one is within `cert_warn_days`.
    pub certs_soon_hours: u32,
    pub setup_hours: u32,
    /// Check AWS groups too (each check asks AWS for an instance).
    pub aws: bool,
    /// A macOS notification when something becomes urgent.
    pub notify: bool,
    pub disk_warn: u32,
    pub disk_urgent: u32,
    pub inode_warn: u32,
    /// Memory in use (of total, by MemAvailable), %.
    pub mem_warn: u32,
    pub swap_warn: u32,
    /// 5-minute load per CPU.
    pub load_warn: f64,
    pub cert_warn_days: i64,
    pub cert_urgent_days: i64,
    /// Server ids never checked in the background.
    pub skip: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            enabled: true,
            reach_mins: 5,
            system_mins: 60,
            updates_hours: 6,
            certs_hours: 24,
            certs_soon_hours: 4,
            setup_hours: 24,
            aws: true,
            notify: true,
            disk_warn: 80,
            disk_urgent: 90,
            inode_warn: 90,
            mem_warn: 90,
            swap_warn: 50,
            load_warn: 2.0,
            cert_warn_days: 21,
            cert_urgent_days: 7,
            skip: Vec::new(),
        }
    }
}

impl Settings {
    fn checked(mut self) -> AppResult<Self> {
        let pct = |v: u32, what: &str| {
            if (1..=100).contains(&v) {
                Ok(())
            } else {
                Err(AppError::Invalid(format!("{what} should be 1–100%")))
            }
        };
        pct(self.disk_warn, "Disk warning")?;
        pct(self.disk_urgent, "Disk urgent")?;
        pct(self.inode_warn, "Inodes")?;
        pct(self.mem_warn, "Memory")?;
        pct(self.swap_warn, "Swap")?;
        if self.disk_warn > self.disk_urgent {
            return Err(AppError::Invalid("the disk warning should be at or under the urgent level".into()));
        }
        if self.cert_urgent_days > self.cert_warn_days || self.cert_urgent_days < 0 {
            return Err(AppError::Invalid("certificate days: urgent should be at or under the warning".into()));
        }
        if !(self.load_warn > 0.0 && self.load_warn <= 100.0) {
            return Err(AppError::Invalid("load per CPU should be above 0".into()));
        }
        self.reach_mins = self.reach_mins.clamp(1, 24 * 60);
        if self.system_mins != 0 {
            self.system_mins = self.system_mins.max(5);
        }
        if self.certs_soon_hours == 0 {
            self.certs_soon_hours = self.certs_hours;
        }
        self.skip.sort();
        self.skip.dedup();
        Ok(self)
    }

    fn every(&self, check: Check) -> i64 {
        match check {
            Check::System => i64::from(self.system_mins) * 60,
            Check::Updates => i64::from(self.updates_hours) * 3600,
            Check::Certs => i64::from(self.certs_hours) * 3600,
            Check::Setup => i64::from(self.setup_hours) * 3600,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Check {
    System,
    Updates,
    Certs,
    Setup,
}

impl Check {
    fn name(self) -> &'static str {
        match self {
            Check::System => "system",
            Check::Updates => "updates",
            Check::Certs => "certs",
            Check::Setup => "setup",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamped<T> {
    /// When it was read (epoch seconds, this Mac's clock).
    pub at: i64,
    pub value: T,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiskUse {
    pub mount: String,
    pub size_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
}

impl DiskUse {
    /// As df shows it: used of what's usable (reserved blocks left out).
    pub fn pct(&self) -> u32 {
        let usable = self.used_kb + self.avail_kb;
        if usable == 0 {
            0
        } else {
            ((self.used_kb as f64 * 100.0 / usable as f64).ceil()) as u32
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct System {
    pub disks: Vec<DiskUse>,
    /// (mount, % of inodes used).
    pub inodes: Vec<(String, u32)>,
    pub load: [f64; 3],
    pub cores: u32,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub failed_units: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppWatch {
    pub id: String,
    /// Its folder isn't there.
    pub missing: bool,
    pub app_env: Option<String>,
    pub app_debug: Option<bool>,
    /// In maintenance mode since (storage/framework/down).
    pub down_since: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Updates {
    pub os: String,
    pub uptime_s: u64,
    /// Ubuntu/Debian's apt-check; None elsewhere.
    pub updates: Option<u32>,
    pub security: Option<u32>,
    pub reboot_required: bool,
    pub reboot_since: Option<i64>,
    pub apps: Vec<AppWatch>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CertWatch {
    pub name: String,
    pub app_id: Option<String>,
    pub not_after: Option<i64>,
    pub missing: bool,
    /// The certificate is for this name.
    pub covers: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Certs {
    pub certs: Vec<CertWatch>,
    pub renew: Vec<String>,
    pub renew_errors: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Setup {
    pub profile: String,
    pub ok: u32,
    pub warn: u32,
    pub bad: u32,
    /// Titles of what doesn't match.
    pub failing: Vec<String>,
    /// The profile (and helpers) it was checked against; a result for a
    /// profile that has changed since isn't shown and is checked again.
    pub fingerprint: String,
}

/// What a server's setup check depends on: its profile and the helpers.
pub fn setup_fingerprint(config: &Config, server_id: &str) -> Option<String> {
    use std::hash::{Hash, Hasher};
    let profile = config.profile_for(server_id)?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_string(profile).unwrap_or_default().hash(&mut h);
    serde_json::to_string(&config.baseline).unwrap_or_default().hash(&mut h);
    Some(format!("{:016x}", h.finish()))
}

/// Results as they apply now: a setup result for another profile is left out.
fn current(config: &Config, id: &str, w: &ServerWatch) -> ServerWatch {
    let mut w = w.clone();
    let fp = setup_fingerprint(config, id);
    if w.setup.as_ref().is_some_and(|s| Some(&s.value.fingerprint) != fp.as_ref()) {
        w.setup = None;
    }
    w
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerWatch {
    pub system: Option<Stamped<System>>,
    pub updates: Option<Stamped<Updates>>,
    pub certs: Option<Stamped<Certs>>,
    pub setup: Option<Stamped<Setup>>,
    /// Last attempt per check, so a failing one isn't retried every minute.
    pub tried: BTreeMap<String, i64>,
    /// Why the last attempt failed, per check (cleared when one works).
    pub errors: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    servers: BTreeMap<String, ServerWatch>,
    /// Item key → snoozed until (epoch seconds).
    snoozed: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Urgent,
    Warn,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// Stable: `<server>:<kind>:<subject>`; what Snooze keeps.
    pub key: String,
    pub server_id: String,
    pub severity: Severity,
    /// disk, inodes, memory, swap, load, failed, updates, security, reboot,
    /// debug, down, cert, renew, setup, unreachable, error.
    pub kind: &'static str,
    pub text: String,
    pub detail: Option<String>,
    pub app_id: Option<String>,
    /// When what it's based on was read.
    pub at: i64,
    pub snoozed_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub now: i64,
    pub servers: BTreeMap<String, ServerWatch>,
    pub items: Vec<Item>,
    /// Servers being checked right now.
    pub running: Vec<String>,
}

/// Kept in AppState.
pub struct Watch {
    store: Mutex<Store>,
    settings: Mutex<Settings>,
    running: Mutex<HashSet<String>>,
    /// Wakes the reachability poller when its interval changes.
    pub reach_changed: Notify,
    dir: Option<PathBuf>,
}

impl Watch {
    pub fn load() -> Self {
        Self::load_from(crate::data_dir())
    }

    fn load_from(dir: Option<PathBuf>) -> Self {
        let read = |name: &str| {
            dir.as_ref()
                .and_then(|d| std::fs::read_to_string(d.join(name)).ok())
        };
        // A file that doesn't parse is started afresh (it's only a cache).
        let store = read("watch.json")
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let settings = read("watch-settings.json")
            .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
            .and_then(|s| s.checked().ok())
            .unwrap_or_default();
        Watch {
            store: Mutex::new(store),
            settings: Mutex::new(settings),
            running: Mutex::new(HashSet::new()),
            reach_changed: Notify::new(),
            dir,
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn write(&self, name: &str, value: &impl Serialize) -> AppResult<()> {
        let Some(dir) = &self.dir else {
            return Ok(());
        };
        std::fs::create_dir_all(dir)?;
        let path = dir.join(name);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(value).map_err(|e| AppError::Invalid(e.to_string()))?,
        )?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    fn update(&self, f: impl FnOnce(&mut Store)) {
        let copy = {
            let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut store);
            store.clone()
        };
        if let Err(e) = self.write("watch.json", &copy) {
            eprintln!("kemudi: couldn't save watch.json: {e}");
        }
    }

    fn server(&self, id: &str) -> ServerWatch {
        self.store
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .servers
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    fn put<T>(&self, id: &str, check: Check, result: Result<T, String>, set: impl FnOnce(&mut ServerWatch, Stamped<T>)) {
        let at = now();
        self.update(|s| {
            let w = s.servers.entry(id.to_string()).or_default();
            w.tried.insert(check.name().into(), at);
            match result {
                Ok(value) => {
                    w.errors.remove(check.name());
                    set(w, Stamped { at, value });
                }
                Err(e) => {
                    w.errors.insert(check.name().into(), e);
                }
            }
        });
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// What's due on a server now (all that apply when `force`).
fn due(server: &Server, config: &Config, w: &ServerWatch, settings: &Settings, now: i64, force: bool) -> Vec<Check> {
    let mut out = Vec::new();
    for check in [Check::System, Check::Updates, Check::Certs, Check::Setup] {
        if check == Check::Setup && config.profile_for(&server.id).is_none() {
            continue;
        }
        // Health (certificates) isn't offered on AWS groups.
        if check == Check::Certs && server.asg.is_some() {
            continue;
        }
        if force {
            out.push(check);
            continue;
        }
        let mut every = settings.every(check);
        if every == 0 {
            continue;
        }
        let at = match check {
            Check::System => w.system.as_ref().map(|s| s.at),
            Check::Updates => w.updates.as_ref().map(|s| s.at),
            Check::Certs => w.certs.as_ref().map(|s| s.at),
            Check::Setup => current(config, &server.id, w).setup.map(|s| s.at),
        };
        if check == Check::Certs {
            let soon = w.certs.as_ref().is_some_and(|c| {
                c.value.certs.iter().any(|c| {
                    c.covers && c.not_after.is_some_and(|t| days_left(t, now) <= settings.cert_warn_days)
                })
            });
            if soon {
                every = every.min(i64::from(settings.certs_soon_hours) * 3600);
            }
        }
        let tried = w.tried.get(check.name()).copied();
        let failed = w.errors.contains_key(check.name());
        let next = match (at, tried) {
            // Failing: try again after the retry time (or the interval).
            (_, Some(t)) if failed => t + every.min(RETRY_SECS),
            (Some(a), _) => a + every,
            (None, _) => 0,
        };
        if now >= next {
            out.push(check);
        }
    }
    out
}

/// Whole days left (negative once expired).
pub fn days_left(not_after: i64, now: i64) -> i64 {
    (not_after - now).div_euclid(86_400)
}

fn gb(kb: u64) -> String {
    let g = kb as f64 / 1024.0 / 1024.0;
    if g >= 10.0 {
        format!("{g:.0} GB")
    } else if g >= 1.0 {
        format!("{g:.1} GB")
    } else {
        format!("{:.0} MB", kb as f64 / 1024.0)
    }
}

fn span(secs: i64) -> String {
    match secs.max(0) {
        s if s < 3600 => format!("{} min", (s / 60).max(1)),
        s if s < 86_400 => {
            let h = s / 3600;
            format!("{h} hour{}", if h == 1 { "" } else { "s" })
        }
        s => {
            let d = s / 86_400;
            format!("{d} day{}", if d == 1 { "" } else { "s" })
        }
    }
}

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// What needs attention, worst first (snoozed ones included, marked).
pub fn items(
    config: &Config,
    servers: &BTreeMap<String, ServerWatch>,
    snoozed: &BTreeMap<String, i64>,
    down: &HashSet<String>,
    s: &Settings,
    now: i64,
) -> Vec<Item> {
    let mut out = Vec::new();
    for (order, server) in config.servers.iter().enumerate() {
        let Some(w) = servers.get(&server.id) else {
            continue;
        };
        let mut push = |severity, kind, subject: &str, text: String, detail: Option<String>, app_id: Option<&str>, at: i64| {
            let key = format!("{}:{kind}:{subject}", server.id);
            let snoozed_until = snoozed.get(&key).copied().filter(|&u| u > now);
            out.push((
                order,
                Item {
                    key,
                    server_id: server.id.clone(),
                    severity,
                    kind,
                    text,
                    detail,
                    app_id: app_id.map(str::to_string),
                    at,
                    snoozed_until,
                },
            ));
        };
        // Reachable before (it has results), not now; VPN servers are
        // often just off.
        if down.contains(&server.id) && server.vpn == Vpn::None && server.asg.is_none() {
            let sev = if server.env == Env::Prod { Severity::Urgent } else { Severity::Warn };
            push(sev, "unreachable", "", "doesn't answer".into(), None, None, now);
        }
        if let Some(sys) = &w.system {
            let v = &sys.value;
            for d in &v.disks {
                let pct = d.pct();
                if pct >= s.disk_warn {
                    let sev = if pct >= s.disk_urgent { Severity::Urgent } else { Severity::Warn };
                    push(sev, "disk", &d.mount, format!("{} is {pct}% full ({} left)", d.mount, gb(d.avail_kb)), None, None, sys.at);
                }
            }
            for (mount, pct) in &v.inodes {
                if *pct >= s.inode_warn {
                    push(Severity::Warn, "inodes", mount, format!("{mount}: {pct}% of inodes used"), Some("Lots of small files (sessions, cache, mail queue)".into()), None, sys.at);
                }
            }
            if let Some(free) = (v.mem_available_kb * 100).checked_div(v.mem_total_kb) {
                let used = 100 - free.min(100);
                if used as u32 >= s.mem_warn {
                    push(Severity::Warn, "memory", "", format!("memory {used}% used ({} free)", gb(v.mem_available_kb)), None, None, sys.at);
                }
            }
            if let Some(free) = (v.swap_free_kb * 100).checked_div(v.swap_total_kb) {
                let used = 100 - free.min(100);
                if used as u32 >= s.swap_warn {
                    push(Severity::Warn, "swap", "", format!("swap {used}% used"), None, None, sys.at);
                }
            }
            if v.cores > 0 && v.load[1] / f64::from(v.cores) >= s.load_warn {
                push(
                    Severity::Warn,
                    "load",
                    "",
                    format!("load {:.1} on {}", v.load[1], plural(v.cores as usize, "CPU")),
                    None,
                    None,
                    sys.at,
                );
            }
            if !v.failed_units.is_empty() {
                push(
                    Severity::Warn,
                    "failed",
                    "",
                    format!("{} failed: {}", plural(v.failed_units.len(), "service"), v.failed_units.join(", ")),
                    None,
                    None,
                    sys.at,
                );
            }
        }
        if let Some(up) = &w.updates {
            let v = &up.value;
            match (v.security, v.updates) {
                (Some(sec), _) if sec > 0 => push(
                    Severity::Warn,
                    "security",
                    "",
                    format!("{sec} security update{}", if sec == 1 { "" } else { "s" }),
                    v.updates.filter(|&n| n > sec).map(|n| format!("{n} updates in all")),
                    None,
                    up.at,
                ),
                (_, Some(n)) if n > 0 => push(Severity::Info, "updates", "", format!("{n} update{} pending", if n == 1 { "" } else { "s" }), None, None, up.at),
                _ => {}
            }
            if v.reboot_required {
                let since = v.reboot_since.map(|t| format!(" for {}", span(now - t))).unwrap_or_default();
                push(Severity::Warn, "reboot", "", format!("needs a restart{since}"), None, None, up.at);
            }
            for a in &v.apps {
                let app = server.apps.iter().find(|x| x.id == a.id);
                let prod = app.is_some_and(|x| x.env == Env::Prod) || a.app_env.as_deref() == Some("production");
                if prod && a.app_debug == Some(true) {
                    push(Severity::Warn, "debug", &a.id, format!("{}: APP_DEBUG is on in production", a.id), Some("Error pages show code and settings".into()), Some(&a.id), up.at);
                }
                if let Some(t) = a.down_since {
                    push(Severity::Warn, "down", &a.id, format!("{}: in maintenance mode for {}", a.id, span(now - t)), None, Some(&a.id), up.at);
                }
                if a.missing {
                    push(Severity::Info, "missing", &a.id, format!("{}: its folder isn't there", a.id), None, Some(&a.id), up.at);
                }
            }
        }
        if let Some(c) = &w.certs {
            let v = &c.value;
            let mut close = false;
            for cert in &v.certs {
                let Some(t) = cert.not_after.filter(|_| cert.covers && !cert.missing) else {
                    continue;
                };
                let days = days_left(t, now);
                if days > s.cert_warn_days {
                    continue;
                }
                close = true;
                let sev = if days <= s.cert_urgent_days { Severity::Urgent } else { Severity::Warn };
                let text = match days {
                    d if d < 0 => format!("{}: certificate expired {} ago", cert.name, span(now - t)),
                    0 => format!("{}: certificate expires today", cert.name),
                    1 => format!("{}: certificate expires tomorrow", cert.name),
                    d => format!("{}: certificate expires in {d} days", cert.name),
                };
                let detail = (v.renew.is_empty()).then(|| "Nothing on the server seems to renew it".to_string());
                push(sev, "cert", &cert.name, text, detail, cert.app_id.as_deref(), c.at);
            }
            if !v.renew_errors.is_empty() {
                let sev = if close { Severity::Urgent } else { Severity::Warn };
                push(sev, "renew", "", "certificate renewal is failing".into(), v.renew_errors.first().cloned(), None, c.at);
            }
        }
        if let Some(st) = &w.setup {
            let v = &st.value;
            if v.bad > 0 {
                push(
                    Severity::Info,
                    "setup",
                    "",
                    format!("{} don't match the {} profile", plural(v.bad as usize, "setup item"), v.profile),
                    Some(v.failing.iter().take(4).cloned().collect::<Vec<_>>().join(", ")).filter(|d| !d.is_empty()),
                    None,
                    st.at,
                );
            }
        }
        for (check, err) in &w.errors {
            let at = w.tried.get(check).copied().unwrap_or(now);
            push(Severity::Info, "error", check, format!("couldn't check {check}"), Some(err.clone()), None, at);
        }
    }
    out.sort_by(|(oa, a), (ob, b)| a.severity.cmp(&b.severity).then(oa.cmp(ob)));
    out.into_iter().map(|(_, i)| i).collect()
}

pub fn snapshot(state: &AppState) -> Snapshot {
    let w = &state.watch;
    let (servers, snoozed) = {
        let store = w.store.lock().unwrap_or_else(|e| e.into_inner());
        (store.servers.clone(), store.snoozed.clone())
    };
    let settings = w.settings();
    let now = now();
    let down: HashSet<String> = state
        .status
        .all()
        .into_iter()
        .filter(|s| s.state == crate::preflight::State::Down)
        .map(|s| s.server_id)
        .collect();
    let (servers, items) = state
        .config
        .config()
        .map(|c| {
            let servers: BTreeMap<_, _> = servers
                .iter()
                .filter(|(id, _)| c.server(id).is_some())
                .map(|(k, v)| (k.clone(), current(&c, k, v)))
                .collect();
            let items = items(&c, &servers, &snoozed, &down, &settings, now);
            (servers, items)
        })
        .unwrap_or_default();
    let mut running: Vec<String> = w.running.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
    running.sort();
    Snapshot { now, servers, items, running }
}

fn emit(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = app.emit(EVENT, snapshot(&state));
}

// ---- the checks ------------------------------------------------------

const SYSTEM_SCRIPT: &str = r#"echo @@df; df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null || df -P -k
echo @@inodes; df -P -i -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null | awk 'NR>1{print $5, $6}'
echo @@load; cat /proc/loadavg
echo @@nproc; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo @@meminfo; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
echo @@failed; systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}'
"#;

const UPDATES_SCRIPT: &str = r#"echo @@os; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"); cut -d' ' -f1 /proc/uptime
echo @@updates; if [ -x /usr/lib/update-notifier/apt-check ]; then /usr/lib/update-notifier/apt-check 2>&1 | tail -1; echo; fi
echo @@reboot; [ -f /var/run/reboot-required ] && stat -c %Y /var/run/reboot-required
"#;

/// Each app's APP_ENV / APP_DEBUG and maintenance file (in its folder or
/// its `current/`).
fn apps_script(server: &Server) -> String {
    let mut s = String::from("echo @@apps\n");
    for a in &server.apps {
        s.push_str(&format!(
            r#"echo "@app {id}"
P={p}
if [ -d "$P" ] || {{ [ -n "$SU" ] && $SU test -d "$P"; }}; then
  D=$P; {{ [ -e "$P/artisan" ] || [ ! -e "$P/current/artisan" ]; }} || D=$P/current
  t=$(stat -c %Y "$D/storage/framework/down" 2>/dev/null || {{ [ -n "$SU" ] && $SU stat -c %Y "$D/storage/framework/down" 2>/dev/null; }})
  [ -n "$t" ] && echo "down $t"
  e=$(grep -E '^(APP_ENV|APP_DEBUG)=' "$D/.env" 2>/dev/null || {{ [ -n "$SU" ] && $SU grep -E '^(APP_ENV|APP_DEBUG)=' "$D/.env" 2>/dev/null; }})
  printf '%s\n' "$e" | sed -n 's/^/env /p'
else
  echo missing
fi
"#,
            id = a.id,
            p = shell_quote(&a.path),
        ));
    }
    s
}

fn sections(out: &str) -> BTreeMap<&str, Vec<&str>> {
    let mut map: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut cur = "";
    for line in out.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            cur = name.trim();
            map.entry(cur).or_default();
        } else if !cur.is_empty() {
            map.entry(cur).or_default().push(line);
        }
    }
    map
}

fn parse_system(sec: &BTreeMap<&str, Vec<&str>>) -> Result<System, String> {
    let df = sec.get("df").ok_or("no answer from the server")?;
    let mut s = System {
        disks: crate::monitor::disks(df)
            .into_iter()
            .map(|d| DiskUse {
                mount: d.mount,
                size_kb: d.size_kb,
                used_kb: d.used_kb,
                avail_kb: d.avail_kb,
            })
            .collect(),
        ..System::default()
    };
    let mounts: HashSet<&str> = s.disks.iter().map(|d| d.mount.as_str()).collect();
    s.inodes = sec
        .get("inodes")
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let (pct, mount) = l.trim().split_once(' ')?;
            let pct = pct.trim_end_matches('%').parse().ok()?;
            mounts.contains(mount).then(|| (mount.to_string(), pct))
        })
        .collect();
    if let Some(l) = sec.get("load").and_then(|l| l.first()) {
        for (i, v) in l.split_whitespace().take(3).enumerate() {
            s.load[i] = v.parse().unwrap_or(0.0);
        }
    }
    s.cores = sec
        .get("nproc")
        .and_then(|l| l.first())
        .and_then(|n| n.trim().parse().ok())
        .unwrap_or(0);
    for l in sec.get("meminfo").into_iter().flatten() {
        let Some((k, v)) = l.split_once(':') else { continue };
        let kb = v.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
        match k {
            "MemTotal" => s.mem_total_kb = kb,
            "MemAvailable" => s.mem_available_kb = kb,
            "SwapTotal" => s.swap_total_kb = kb,
            "SwapFree" => s.swap_free_kb = kb,
            _ => {}
        }
    }
    s.failed_units = sec
        .get("failed")
        .into_iter()
        .flatten()
        .map(|l| l.trim().trim_end_matches(".service").to_string())
        .filter(|l| !l.is_empty() && l != "●")
        .collect();
    Ok(s)
}

fn parse_updates(sec: &BTreeMap<&str, Vec<&str>>) -> Result<Updates, String> {
    let os = sec.get("os").ok_or("no answer from the server")?;
    let mut u = Updates {
        os: os.first().map(|s| s.trim().to_string()).unwrap_or_default(),
        uptime_s: os
            .get(1)
            .and_then(|s| s.trim().parse::<f64>().ok())
            .map_or(0, |f| f as u64),
        ..Updates::default()
    };
    if let Some(l) = sec.get("updates").and_then(|u| u.iter().find(|l| l.contains(';'))) {
        let mut it = l.trim().split(';');
        u.updates = it.next().and_then(|x| x.parse().ok());
        u.security = it.next().and_then(|x| x.parse().ok());
    }
    if let Some(t) = sec.get("reboot").and_then(|r| r.first()) {
        u.reboot_required = true;
        u.reboot_since = t.trim().parse().ok();
    }
    let mut cur: Option<AppWatch> = None;
    for l in sec.get("apps").into_iter().flatten() {
        if let Some(id) = l.strip_prefix("@app ") {
            u.apps.extend(cur.take());
            cur = Some(AppWatch {
                id: id.trim().to_string(),
                ..AppWatch::default()
            });
            continue;
        }
        let Some(a) = cur.as_mut() else { continue };
        if l.trim() == "missing" {
            a.missing = true;
        } else if let Some(t) = l.strip_prefix("down ") {
            a.down_since = t.trim().parse().ok();
        } else if let Some(v) = l.strip_prefix("env APP_ENV=") {
            a.app_env = Some(v.trim().trim_matches(['"', '\'']).to_string());
        } else if let Some(v) = l.strip_prefix("env APP_DEBUG=") {
            let v = v.trim().trim_matches(['"', '\'']).to_ascii_lowercase();
            a.app_debug = Some(v == "true" || v == "1" || v == "(true)");
        }
    }
    u.apps.extend(cur);
    Ok(u)
}

/// Certificates from a Health check (the tab's, or the background one).
pub fn certs_of(h: &crate::health::Health) -> Certs {
    Certs {
        certs: h
            .certs
            .iter()
            .map(|c| CertWatch {
                name: c.name.clone(),
                app_id: c.app_id.clone(),
                not_after: c.not_after,
                missing: c.missing,
                covers: c.covers,
            })
            .collect(),
        renew: h.renew.clone(),
        renew_errors: h.renew_errors.clone(),
    }
}

pub fn setup_of(s: &crate::setup::SetupStatus, fingerprint: String) -> Setup {
    let count = |st: &str| s.items.iter().filter(|i| i.state == st).count() as u32;
    Setup {
        profile: s.profile.clone(),
        ok: count("ok"),
        warn: count("warn"),
        bad: count("bad"),
        failing: s.items.iter().filter(|i| i.state == "bad").map(|i| i.title.clone()).collect(),
        fingerprint,
    }
}

/// A Health tab checked SSL: keep it, so the background check waits.
pub fn record_certs(app: &AppHandle, server_id: &str, h: &crate::health::Health) {
    app.state::<AppState>()
        .watch
        .put(server_id, Check::Certs, Ok(certs_of(h)), |w, v| w.certs = Some(v));
    emit(app);
}

pub fn record_setup(app: &AppHandle, server_id: &str, s: &crate::setup::SetupStatus) {
    let state = app.state::<AppState>();
    let fp = state.config.config().and_then(|c| setup_fingerprint(&c, server_id)).unwrap_or_default();
    state
        .watch
        .put(server_id, Check::Setup, Ok(setup_of(s, fp)), |w, v| w.setup = Some(v));
    emit(app);
}

type Sections<'a> = BTreeMap<&'a str, Vec<&'a str>>;

fn parsed<T>(out: &Result<String, String>, f: fn(&Sections) -> Result<T, String>) -> Result<T, String> {
    let sec = sections(out.as_ref().map_err(Clone::clone)?);
    if sec.contains_key("now") {
        f(&sec)
    } else {
        Err("no answer from the server".to_string())
    }
}

async fn check_server(app: &AppHandle, server: &Server, checks: &[Check]) {
    let state = app.state::<AppState>();
    let w = &state.watch;
    let id = server.id.as_str();
    let sys = checks.contains(&Check::System);
    let upd = checks.contains(&Check::Updates);
    if sys || upd {
        let mut script = String::from("export LC_ALL=C\n");
        if upd && !server.apps.is_empty() {
            let password = crate::remote_files::saved_sudo(id).await;
            script.push_str(&crate::remote_files::sudo_prelude(password.as_deref()));
        }
        script.push_str("echo @@now\n");
        if sys {
            script.push_str(SYSTEM_SCRIPT);
        }
        if upd {
            script.push_str(UPDATES_SCRIPT);
            script.push_str(&apps_script(server));
        }
        let out = crate::monitor::run_for(&state, id, &script, 60)
            .await
            .map_err(|e| e.to_string());
        if sys {
            w.put(id, Check::System, parsed(&out, parse_system), |w, v| w.system = Some(v));
        }
        if upd {
            w.put(id, Check::Updates, parsed(&out, parse_updates), |w, v| w.updates = Some(v));
        }
        emit(app);
    }
    if checks.contains(&Check::Certs) {
        let r = crate::health::check(&state, id, true)
            .await
            .map(|h| certs_of(&h))
            .map_err(|e| e.to_string());
        w.put(id, Check::Certs, r, |w, v| w.certs = Some(v));
        emit(app);
    }
    if checks.contains(&Check::Setup) {
        let fp = state.config.config().and_then(|c| setup_fingerprint(&c, id)).unwrap_or_default();
        let r = crate::setup::check(&state, id, None)
            .await
            .map(|s| setup_of(&s, fp))
            .map_err(|e| e.to_string());
        w.put(id, Check::Setup, r, |w, v| w.setup = Some(v));
        emit(app);
    }
}

/// One round: every server with something due (all of `only`'s checks
/// when `force`).
pub async fn round(app: &AppHandle, only: Option<&[String]>, force: bool) {
    let state = app.state::<AppState>();
    let Some(config) = state.config.config() else {
        return;
    };
    let settings = state.watch.settings();
    let up: HashSet<String> = state
        .status
        .all()
        .into_iter()
        .filter(|s| s.state == crate::preflight::State::Up)
        .map(|s| s.server_id)
        .collect();
    let now = now();
    let mut jobs = Vec::new();
    for server in &config.servers {
        if only.is_some_and(|ids| !ids.contains(&server.id)) {
            continue;
        }
        if !force {
            if settings.skip.contains(&server.id) || (server.asg.is_some() && !settings.aws) {
                continue;
            }
            // AWS groups aren't probed: Session Manager decides.
            if server.asg.is_none() && !up.contains(&server.id) {
                continue;
            }
        }
        let checks = due(server, &config, &state.watch.server(&server.id), &settings, now, force);
        if checks.is_empty() {
            continue;
        }
        let fresh = state
            .watch
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(server.id.clone());
        if fresh {
            jobs.push((server.clone(), checks));
        }
    }
    if jobs.is_empty() {
        return;
    }
    emit(app);
    let limit = Arc::new(Semaphore::new(AT_ONCE));
    let mut tasks = tokio::task::JoinSet::new();
    for (server, checks) in jobs {
        let app = app.clone();
        let limit = limit.clone();
        tasks.spawn(async move {
            let _permit = limit.acquire_owned().await.ok();
            check_server(&app, &server, &checks).await;
            let state = app.state::<AppState>();
            state
                .watch
                .running
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&server.id);
            emit(&app);
        });
    }
    while tasks.join_next().await.is_some() {}
}

/// Every minute: what's due. Not in a quiet test copy.
pub fn start(app: AppHandle) {
    if crate::system::app_quiet() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Let the first reachability probe finish.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let enabled = app.state::<AppState>().watch.settings().enabled;
            if enabled {
                round(&app, None, false).await;
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

// ---- commands --------------------------------------------------------

#[tauri::command]
pub async fn watch_get(state: State<'_, AppState>) -> AppResult<Snapshot> {
    Ok(snapshot(&state))
}

/// Check now: these servers (all when None), every check, reachable or not.
#[tauri::command]
pub async fn watch_refresh(app: AppHandle, server_ids: Option<Vec<String>>) -> AppResult<Snapshot> {
    round(&app, server_ids.as_deref(), true).await;
    Ok(snapshot(&app.state::<AppState>()))
}

/// Snooze an item for `days` (0: show it again).
#[tauri::command]
pub async fn watch_snooze(app: AppHandle, key: String, days: u32) -> AppResult<Snapshot> {
    let state = app.state::<AppState>();
    let until = now() + i64::from(days) * 86_400;
    state.watch.update(|s| {
        let at = now();
        s.snoozed.retain(|_, u| *u > at);
        if days == 0 {
            s.snoozed.remove(&key);
        } else {
            s.snoozed.insert(key, until);
        }
    });
    emit(&app);
    Ok(snapshot(&state))
}

#[tauri::command]
pub async fn watch_settings_get(state: State<'_, AppState>) -> AppResult<Settings> {
    Ok(state.watch.settings())
}

#[tauri::command]
pub async fn watch_settings_set(app: AppHandle, settings: Settings) -> AppResult<Settings> {
    let settings = settings.checked()?;
    let state = app.state::<AppState>();
    state.watch.write("watch-settings.json", &settings)?;
    let reach = {
        let mut cur = state.watch.settings.lock().unwrap_or_else(|e| e.into_inner());
        let changed = cur.reach_mins != settings.reach_mins;
        *cur = settings.clone();
        changed
    };
    if reach {
        state.watch.reach_changed.notify_waiters();
    }
    emit(&app);
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        let yaml = r#"
servers:
  - id: web-1
    host: web-1
    env: prod
    apps:
      - { id: shop, path: /opt/www/shop }
  - id: stg
    host: stg
    env: staging
"#;
        crate::config::validate::parse(yaml).config.expect("config parses")
    }

    #[test]
    fn parses_the_script_output() {
        let out = "@@now\n@@df\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000 94000 6000 94% /\n@@inodes\n12% /\n95% /data\n@@load\n3.10 4.50 2.00 1/200 99\n@@nproc\n2\n@@meminfo\nMemTotal: 2000000 kB\nMemAvailable: 100000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n@@failed\nphp8.3-fpm.service\n@@os\nUbuntu 24.04 LTS\n1234.5\n@@updates\n12;3\n@@reboot\n1700000000\n@@apps\n@app shop\ndown 1700000100\nenv APP_ENV=production\nenv APP_DEBUG=true\n";
        let sec = sections(out);
        let s = parse_system(&sec).expect("system");
        assert_eq!(s.disks.len(), 1);
        assert_eq!(s.disks[0].pct(), 94);
        assert_eq!(s.inodes, vec![("/".to_string(), 12)]);
        assert_eq!(s.cores, 2);
        assert_eq!(s.failed_units, vec!["php8.3-fpm"]);
        let u = parse_updates(&sec).expect("updates");
        assert_eq!((u.updates, u.security, u.reboot_required), (Some(12), Some(3), true));
        assert_eq!(u.apps[0].down_since, Some(1_700_000_100));
        assert_eq!(u.apps[0].app_debug, Some(true));
    }

    #[test]
    fn items_worst_first_and_snoozed() {
        let c = config();
        let now = 1_700_100_000;
        let mut servers = BTreeMap::new();
        servers.insert(
            "stg".to_string(),
            ServerWatch {
                updates: Some(Stamped { at: now, value: Updates { updates: Some(4), security: Some(0), ..Updates::default() } }),
                ..ServerWatch::default()
            },
        );
        servers.insert(
            "web-1".to_string(),
            ServerWatch {
                system: Some(Stamped {
                    at: now,
                    value: System {
                        disks: vec![DiskUse { mount: "/".into(), size_kb: 100, used_kb: 91, avail_kb: 9 }],
                        ..System::default()
                    },
                }),
                updates: Some(Stamped {
                    at: now,
                    value: Updates {
                        apps: vec![AppWatch { id: "shop".into(), app_debug: Some(true), ..AppWatch::default() }],
                        ..Updates::default()
                    },
                }),
                certs: Some(Stamped {
                    at: now,
                    value: Certs {
                        certs: vec![CertWatch { name: "shop.example.com".into(), not_after: Some(now + 10 * 86_400 + 5), covers: true, ..CertWatch::default() }],
                        ..Certs::default()
                    },
                }),
                ..ServerWatch::default()
            },
        );
        let mut snoozed = BTreeMap::new();
        snoozed.insert("web-1:debug:shop".to_string(), now + 60);
        let s = Settings::default();
        let it = items(&c, &servers, &snoozed, &HashSet::new(), &s, now);
        let kinds: Vec<_> = it.iter().map(|i| (i.server_id.as_str(), i.kind, i.severity)).collect();
        assert_eq!(
            kinds,
            vec![
                ("web-1", "disk", Severity::Urgent),
                ("web-1", "debug", Severity::Warn),
                ("web-1", "cert", Severity::Warn),
                ("stg", "updates", Severity::Info),
            ]
        );
        assert!(it[1].snoozed_until.is_some());
        assert_eq!(it[2].text, "shop.example.com: certificate expires in 10 days");
        assert_eq!(it[2].detail.as_deref(), Some("Nothing on the server seems to renew it"));
    }

    #[test]
    fn only_what_is_due() {
        let c = config();
        let server = c.server("web-1").expect("server");
        let s = Settings::default();
        let now = 1_700_100_000;
        assert_eq!(due(server, &c, &ServerWatch::default(), &s, now, false), vec![Check::System, Check::Updates, Check::Certs]);
        let fresh = ServerWatch {
            system: Some(Stamped { at: now - 59 * 60, value: System::default() }),
            updates: Some(Stamped { at: now - 7 * 3600, value: Updates::default() }),
            certs: Some(Stamped {
                at: now - 5 * 3600,
                value: Certs {
                    certs: vec![CertWatch { name: "a".into(), not_after: Some(now + 86_400 * 30), covers: true, ..CertWatch::default() }],
                    ..Certs::default()
                },
            }),
            ..ServerWatch::default()
        };
        assert_eq!(due(server, &c, &fresh, &s, now, false), vec![Check::Updates]);
        // A certificate within the warning: every 4 h instead of daily.
        let mut close = fresh.clone();
        if let Some(c) = close.certs.as_mut() {
            c.value.certs[0].not_after = Some(now + 86_400 * 5);
        }
        assert_eq!(due(server, &c, &close, &s, now, false), vec![Check::Updates, Check::Certs]);
        // A failing check waits for the retry time.
        let mut failing = fresh;
        failing.errors.insert("system".into(), "timeout".into());
        failing.tried.insert("system".into(), now - 10 * 60);
        assert_eq!(due(server, &c, &failing, &s, now, false), vec![Check::Updates]);
        // Off: never in the background.
        let off = Settings { updates_hours: 0, ..Settings::default() };
        assert!(!due(server, &c, &failing, &off, now, false).contains(&Check::Updates));
    }

    #[test]
    fn setup_result_for_a_changed_profile_is_dropped() {
        let yaml = |users: &str| {
            format!(
                "setup:\n  default: web\n  profiles:\n    - id: web\n      ntp: true\n{users}servers:\n  - {{ id: web-1, host: web-1, env: prod }}\n"
            )
        };
        let before = crate::config::validate::parse(&yaml("      users: [{ name: deploy, sudo: true }]\n")).config.expect("config");
        let after = crate::config::validate::parse(&yaml("")).config.expect("config");
        let server = before.server("web-1").expect("server").clone();
        let now = 1_700_100_000;
        let w = ServerWatch {
            setup: Some(Stamped {
                at: now - 60,
                value: Setup { profile: "web".into(), bad: 1, fingerprint: setup_fingerprint(&before, "web-1").expect("fp"), ..Setup::default() },
            }),
            ..ServerWatch::default()
        };
        let s = Settings::default();
        assert!(current(&before, "web-1", &w).setup.is_some());
        assert!(!due(&server, &before, &w, &s, now, false).contains(&Check::Setup));
        // The profile lost its users: the old ✗ isn't shown, and it's due.
        assert!(current(&after, "web-1", &w).setup.is_none());
        assert!(due(&server, &after, &w, &s, now, false).contains(&Check::Setup));
    }

    #[test]
    fn settings_round_trip_and_checks() {
        let dir = std::env::temp_dir().join(format!("kemudi-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let w = Watch::load_from(Some(dir.clone()));
        assert_eq!(w.settings(), Settings::default());
        let bad = Settings { disk_warn: 95, disk_urgent: 90, ..Settings::default() };
        assert!(bad.checked().is_err());
        let s = Settings { reach_mins: 0, system_mins: 1, ..Settings::default() }.checked().expect("ok");
        assert_eq!((s.reach_mins, s.system_mins), (1, 5));
        w.write("watch-settings.json", &s).expect("write");
        assert_eq!(Watch::load_from(Some(dir.clone())).settings(), s);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
