//! Security check: your secops skill's read-only `secops-check.sh` (active
//! compromise, exposure, Laravel app holes, tampering), run on a server over
//! the shared ssh connection, as root through sudo when it can be. The
//! script stays in the skill's folder (Settings ▸ Checks), not in Kemudi.
//! Its raw output is saved with the skill's reports
//! (`reports/<host>-<date>.txt`, as `/secops` does), so a Claude session can
//! pick it up. Kept and shown by `watch` (the server tab's Security).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config::schema::Server;
use crate::error::{AppError, AppResult};
use crate::AppState;

/// The script, in the secops folder.
pub const CHECK_SCRIPT: &str = "scripts/secops-check.sh";

/// The secops folder: the one set in Settings ▸ Checks, else the skill's.
pub fn folder(setting: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let s = setting.trim();
    Some(if s.is_empty() {
        home.join(".claude/skills/secops")
    } else if s == "~" {
        home
    } else if let Some(rest) = s.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(s)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    /// A miner, web shell, bad cron, tampered binary…
    Compromised,
    /// Nothing active found, but a hole that can be used from outside
    /// (Livewire / Ignition RCE).
    AtRisk,
    /// Only hygiene warnings.
    Hardening,
    Clean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Crit,
    Warn,
    Ok,
    /// Detail under a finding, or a table.
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub level: Level,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Section {
    /// "A2. DISGUISED / RENAMED PROCESSES".
    pub title: String,
    pub lines: Vec<Line>,
}

/// A row of the script's Laravel app table.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppRow {
    /// Its folder under the web root (`/opt/www/` or `/var/www/` left out).
    pub name: String,
    pub laravel: Option<String>,
    pub livewire: Option<String>,
    pub ignition: Option<String>,
    /// `.php` files in public/ besides index.php.
    pub extra_php: u32,
    /// Media files with PHP in them.
    pub php_media: u32,
    /// `LIVEWIRE-RCE(CVE-2025-54068)`, `APP_DEBUG=true`, `extra-php`…
    pub flags: Vec<String>,
    /// `composer audit` lines (with --audit).
    pub audit: Vec<String>,
}

impl AppRow {
    /// Planted files: the app has been written to.
    pub fn exploited(&self) -> bool {
        self.flags.iter().any(|f| {
            f.starts_with("FAKE-WORDPRESS") || f.starts_with("PHP-IN-MEDIA") || f.starts_with("LIVEWIRE-EXPLOITED")
        })
    }

    /// The RCE it's open to, if any.
    pub fn rce(&self) -> Option<&str> {
        self.flags
            .iter()
            .find(|f| f.starts_with("LIVEWIRE-RCE") || f.starts_with("IGNITION-RCE"))
            .map(String::as_str)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Security {
    pub verdict: Verdict,
    /// The script's own counts (SUMMARY).
    pub crit: u32,
    pub warn: u32,
    /// Hostname, OS, kernel, CPUs, load… (the HOST line).
    pub host: String,
    /// Ran as root (else processes, cron and configs are only partly seen).
    pub root: bool,
    /// With `composer audit`.
    pub audit: bool,
    pub sections: Vec<Section>,
    pub apps: Vec<AppRow>,
    /// Where the raw output was saved.
    pub report: Option<String>,
}

/// `LIVEWIRE-EXPLOITED(3 _lw_cmd files) APP_DEBUG=true` → the two flags.
fn flags(tokens: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut open = false;
    for t in tokens {
        match out.last_mut() {
            Some(last) if open => {
                last.push(' ');
                last.push_str(t);
            }
            _ => out.push((*t).to_string()),
        }
        let o = out.last().map_or(0, |l| l.matches('(').count());
        let c = out.last().map_or(0, |l| l.matches(')').count());
        open = o > c;
    }
    out
}

fn app_row(line: &str) -> Option<AppRow> {
    let f: Vec<&str> = line.split_whitespace().collect();
    if f.len() < 6 {
        return None;
    }
    let opt = |s: &str| (s != "-").then(|| s.to_string());
    Some(AppRow {
        name: f[0].to_string(),
        laravel: opt(f[1]),
        livewire: opt(f[2]),
        ignition: opt(f[3]),
        extra_php: f[4].parse().ok()?,
        php_media: f[5].parse().ok()?,
        flags: flags(&f[6..]),
        audit: Vec::new(),
    })
}

/// `VERDICT: … — 3 critical, 12 warnings` → (3, 12).
fn counts(line: &str) -> Option<(u32, u32)> {
    let n = |word: &str| -> Option<u32> {
        let at = line.find(word)?;
        // "3 critical", "1 hardening warnings".
        line[..at].split_whitespace().rev().take(2).find_map(|t| t.parse().ok())
    };
    Some((n(" critical").unwrap_or(0), n(" warning").unwrap_or(0)))
}

/// Read the script's output (what follows the `@@secops` marker, or all of it).
pub fn parse(out: &str) -> Result<Security, String> {
    let body = out.split_once("@@secops\n").map_or(out, |(_, b)| b);
    let mut sections: Vec<Section> = Vec::new();
    let mut apps: Vec<AppRow> = Vec::new();
    let mut summary: Option<(u32, u32)> = None;
    for raw in body.lines() {
        if let Some(t) = raw.strip_prefix("=== ") {
            sections.push(Section {
                title: t.trim().to_string(),
                lines: Vec::new(),
            });
            continue;
        }
        let Some(sec) = sections.last_mut() else { continue };
        let line = raw.strip_prefix("  ").unwrap_or(raw).trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if sec.title == "SUMMARY" {
            if let Some(v) = line.trim().strip_prefix("VERDICT:") {
                summary = counts(v).or(Some((0, 0)));
            }
        }
        if sec.title.starts_with("C. ") {
            let t = line.trim();
            if t.starts_with("APP ") || t.starts_with("PHP+ =") {
                continue;
            }
            if let Some(a) = t.strip_prefix("audit:") {
                if let Some(last) = apps.last_mut() {
                    last.audit.push(a.trim().to_string());
                }
                continue;
            }
            if let Some(row) = app_row(line) {
                apps.push(row);
                continue;
            }
        }
        let (level, text) = if let Some(t) = line.strip_prefix("[CRIT] ") {
            (Level::Crit, t)
        } else if let Some(t) = line.strip_prefix("[WARN] ") {
            (Level::Warn, t)
        } else if let Some(t) = line.strip_prefix("[ok] ") {
            (Level::Ok, t)
        } else {
            (Level::Info, line)
        };
        sec.lines.push(Line {
            level,
            text: text.to_string(),
        });
    }
    let Some((crit, warn)) = summary else {
        return Err(match sections.last() {
            Some(s) => format!("the check stopped before the end (last part: {})", s.title),
            None => "no answer from the check (is it the secops-check.sh script?)".into(),
        });
    };
    let host = sections
        .iter()
        .find(|s| s.title == "HOST")
        .and_then(|s| s.lines.first())
        .map(|l| l.text.clone())
        .unwrap_or_default();
    let root = !sections
        .iter()
        .flat_map(|s| &s.lines)
        .any(|l| l.level == Level::Warn && l.text.starts_with("not running as root"));
    let verdict = if crit > 0 || apps.iter().any(AppRow::exploited) {
        Verdict::Compromised
    } else if apps.iter().any(|a| a.rce().is_some()) {
        Verdict::AtRisk
    } else if warn > 0 {
        Verdict::Hardening
    } else {
        Verdict::Clean
    };
    // The summary is in the header; the table is in `apps`.
    sections.retain(|s| s.title != "SUMMARY");
    Ok(Security {
        verdict,
        crit,
        warn,
        host,
        root,
        audit: false,
        sections,
        apps,
        report: None,
    })
}

/// What runs on the server: the script on bash's stdin (a here-document, so
/// nothing is copied to the server), as root when sudo works; the saved
/// sudo password, if any, arrives on ssh's stdin, never on a command line.
pub fn remote_script(check: &str, audit: bool, sudo_password: Option<&str>) -> String {
    let mut s = String::from("export LC_ALL=C\n");
    s.push_str(&crate::remote_files::sudo_prelude(sudo_password));
    s.push_str("echo @@now\necho @@secops\n");
    s.push_str(r#"if [ "$(id -u)" = 0 ]; then R=""; else R="$SU"; fi"#);
    s.push('\n');
    s.push_str(&format!(
        "$R bash -s --{} <<'__KEMUDI_SECOPS_END__'\n{}\n__KEMUDI_SECOPS_END__\n",
        if audit { " --audit" } else { "" },
        check.trim_end(),
    ));
    s
}

/// `<host>-<YYYY-MM-DD>.txt`, with only safe characters in the host.
fn report_name(host: &str, date: &str) -> String {
    let h: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    format!("{h}-{date}.txt")
}

/// Run the check on a server and read it; saves the raw output.
pub async fn run(state: &AppState, server: &Server, folder_setting: &str, audit: bool) -> AppResult<Security> {
    if server.asg.is_some() {
        return Err(AppError::Invalid("the security check isn't offered on AWS groups yet".into()));
    }
    let dir = folder(folder_setting).ok_or_else(|| AppError::Invalid("no home folder".into()))?;
    let path = dir.join(CHECK_SCRIPT);
    let check = std::fs::read_to_string(&path).map_err(|_| {
        AppError::Invalid(format!("{} isn't there (set the secops folder in Settings ▸ Checks)", path.display()))
    })?;
    let password = crate::remote_files::saved_sudo(&server.id).await;
    let script = remote_script(&check, audit, password.as_deref());
    // Walking every app takes a while on a big box; composer audit longer.
    let secs = if audit { 30 * 60 } else { 15 * 60 };
    let out = crate::monitor::run_for(state, &server.id, &script, secs).await?;
    let mut sec = parse(&out).map_err(AppError::Invalid)?;
    sec.audit = audit;
    let reports = dir.join("reports");
    let body = out.split_once("@@secops\n").map_or(out.as_str(), |(_, b)| b);
    if std::fs::create_dir_all(&reports).is_ok() {
        let file = reports.join(report_name(&server.host, &crate::util::local_date()));
        match std::fs::write(&file, body) {
            Ok(()) => sec.report = Some(file.to_string_lossy().into_owned()),
            Err(e) => eprintln!("kemudi: couldn't save the security report: {e}"),
        }
    }
    Ok(sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: &str = "noise before\n@@now\n@@secops\n
=== HOST
  web-01 | Ubuntu 24.04.1 LTS | kernel 6.8.0 | 4 vCPU | load 0.10 0.20 0.30 | mem avail 5000 MB | up 3 days

=== A1. CPU HOGS (non-root, >5%)
    PID    PPID USER     %CPU     ELAPSED COMMAND         COMMAND

=== A2. DISGUISED / RENAMED PROCESSES
  [ok] none

=== A5. CRONTABS (suspicious entries)
  [CRIT] www-data: @reboot sleep 90 && /var/tmp/.x/.rc-local

=== A6. DROPPED FILES IN TEMP DIRS
  [CRIT] non-root executables / scripts / large files:
      www-data     1234 2026-10-17 15:48:00 /var/tmp/.x/xmrig

=== B3. SSH CONFIG
  [ok] password login off
  [WARN] fail2ban not running

=== C. LARAVEL APPS
  APP                                                LARAVEL  LIVEWIRE  IGNITN  PHP+   MEDIA  FLAGS
  acme/shop                                          11.9.0   3.6.3     -       0      0      LIVEWIRE-RCE(CVE-2025-54068) APP_DEBUG=true
  acme/blog                                          10.2.0   3.7.1     2.4.0   11     0      extra-php LIVEWIRE-EXPLOITED(3 _lw_cmd files)
      audit: Package livewire/livewire\tSeverity high
  acme/plain                                         9.52.0   -         -       0      0
  PHP+ = .php files in public/ besides index.php (some apps ship legit ones; FAKE-WORDPRESS, PHP-IN-MEDIA and LIVEWIRE-RCE are always bad)

=== SUMMARY
  VERDICT: COMPROMISED or very likely — 3 critical, 1 warnings
";

    #[test]
    fn reads_the_check() {
        let s = parse(OUT).unwrap();
        assert_eq!(s.verdict, Verdict::Compromised);
        assert_eq!((s.crit, s.warn), (3, 1));
        assert!(s.host.starts_with("web-01 | Ubuntu"));
        assert!(s.root);
        assert!(!s.sections.iter().any(|x| x.title == "SUMMARY"));
        let a6 = s.sections.iter().find(|x| x.title.starts_with("A6.")).unwrap();
        assert_eq!(a6.lines[0].level, Level::Crit);
        assert_eq!(a6.lines[1].level, Level::Info);
        assert!(a6.lines[1].text.contains("/var/tmp/.x/xmrig"));
        assert_eq!(s.apps.len(), 3);
        let shop = &s.apps[0];
        assert_eq!(shop.livewire.as_deref(), Some("3.6.3"));
        assert_eq!(shop.ignition, None);
        assert_eq!(shop.flags, vec!["LIVEWIRE-RCE(CVE-2025-54068)", "APP_DEBUG=true"]);
        assert!(shop.rce().is_some() && !shop.exploited());
        let blog = &s.apps[1];
        assert_eq!(blog.extra_php, 11);
        assert_eq!(blog.flags, vec!["extra-php", "LIVEWIRE-EXPLOITED(3 _lw_cmd files)"]);
        assert!(blog.exploited());
        assert_eq!(blog.audit.len(), 1);
        assert!(s.apps[2].flags.is_empty());
        // The table isn't repeated as lines.
        let c = s.sections.iter().find(|x| x.title.starts_with("C.")).unwrap();
        assert!(c.lines.is_empty());
    }

    #[test]
    fn verdicts() {
        let at_risk = OUT
            .replace("  [CRIT] www-data: @reboot sleep 90 && /var/tmp/.x/.rc-local\n", "")
            .replace("  [CRIT] non-root executables / scripts / large files:\n", "")
            .replace(" LIVEWIRE-EXPLOITED(3 _lw_cmd files)", "")
            .replace("COMPROMISED or very likely — 3 critical, 1 warnings", "NO ACTIVE COMPROMISE FOUND — 1 hardening warnings");
        let s = parse(&at_risk).unwrap();
        assert_eq!((s.crit, s.warn), (0, 1));
        assert_eq!(s.verdict, Verdict::AtRisk);
        let hardening = at_risk.replace("LIVEWIRE-RCE(CVE-2025-54068) ", "");
        assert_eq!(parse(&hardening).unwrap().verdict, Verdict::Hardening);
        let clean = hardening.replace("NO ACTIVE COMPROMISE FOUND — 1 hardening warnings", "CLEAN on all checks");
        assert_eq!(parse(&clean).unwrap().verdict, Verdict::Clean);
    }

    #[test]
    fn not_root_and_cut_short() {
        let s = parse(&OUT.replace(
            "=== A1.",
            "  [WARN] not running as root — process, cron and config checks are incomplete\n\n=== A1.",
        ))
        .unwrap();
        assert!(!s.root);
        let cut = &OUT[..OUT.find("=== SUMMARY").unwrap()];
        assert!(parse(cut).unwrap_err().contains("C. LARAVEL APPS"));
        assert!(parse("").is_err());
    }

    #[test]
    fn script_and_names() {
        let s = remote_script("#!/bin/bash\necho hi\n", true, None);
        assert!(s.contains("$R bash -s -- --audit <<'__KEMUDI_SECOPS_END__'\n#!/bin/bash\necho hi\n__KEMUDI_SECOPS_END__\n"));
        assert!(s.find("@@secops").unwrap() < s.find("bash -s").unwrap());
        assert!(!remote_script("x", false, None).contains("--audit"));
        assert_eq!(report_name("web-01", "2026-11-01"), "web-01-2026-11-01.txt");
        assert_eq!(report_name("deploy@web/01", "2026-11-01"), "deploy_web_01-2026-11-01.txt");
        let home = dirs::home_dir().unwrap();
        assert_eq!(folder("").unwrap(), home.join(".claude/skills/secops"));
        assert_eq!(folder("~/sec").unwrap(), home.join("sec"));
        assert_eq!(folder("/opt/sec").unwrap(), PathBuf::from("/opt/sec"));
    }
}
