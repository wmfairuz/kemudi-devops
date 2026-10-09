//! Server monitor: CPU, memory, disks and the top processes, read over the
//! user's own SSH (keys/agent, no prompts) by a short read-only script.
//! Nothing is installed or written on the server, nothing needs sudo, and
//! one shared connection (ControlMaster) keeps polling cheap.

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::AppState;

/// Linux, POSIX sh. Sections start with `@@name`. CPU is sampled from
/// /proc/stat around `top`'s own 1 s window.
const SCRIPT: &str = r#"export LC_ALL=C
echo @@uptime; cat /proc/uptime
echo @@load; cat /proc/loadavg
echo @@nproc; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo
echo @@stat1; head -1 /proc/stat
echo @@top; top -b -c -n 2 -d 1 -w 512 -o %CPU 2>/dev/null | awk '/^top -/{n++} n==2' | awk 'f&&NR>0{print} /^ *PID/{f=1}' | head -10
echo @@stat2; head -1 /proc/stat
echo @@meminfo; cat /proc/meminfo
echo @@df; df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null || df -P -k
echo @@psmem; ps -eo pid=,user=,pcpu=,pmem=,rss=,etimes=,args= --sort=-rss 2>/dev/null | head -10
echo @@os; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"); uname -r
"#;

/// Just the disks, for background disk alerts.
const DISKS_SCRIPT: &str = r#"export LC_ALL=C
echo @@df; df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null || df -P -k
"#;

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub pid: u32,
    pub user: String,
    pub cpu: f64,
    pub mem_pct: f64,
    pub rss_kb: u64,
    /// CPU time (top) or how long it's been running (ps), as shown.
    pub time: String,
    pub command: String,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub mount: String,
    pub fs: String,
    pub size_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub uptime_s: u64,
    pub load: [f64; 3],
    pub cores: u32,
    /// Busy share of all CPUs over the sample's ~1 s, 0–100.
    pub cpu_pct: f64,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub mem_cache_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub disks: Vec<Disk>,
    pub top_cpu: Vec<Proc>,
    pub top_mem: Vec<Proc>,
    pub os: String,
    pub kernel: String,
}

fn sections(out: &str) -> std::collections::HashMap<&str, Vec<&str>> {
    let mut map: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
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

/// `cpu  user nice system idle iowait irq softirq steal …` → (busy, total).
fn cpu_ticks(line: &str) -> Option<(u64, u64)> {
    let nums: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|n| n.parse().ok())
        .collect();
    if nums.len() < 4 {
        return None;
    }
    let total: u64 = nums.iter().take(8).sum();
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    Some((total - idle, total))
}

/// top's RES: KiB, or with a m/g/t suffix.
fn kib(s: &str) -> u64 {
    let (num, mul) = match s.chars().last() {
        Some('m') => (&s[..s.len() - 1], 1024.0),
        Some('g') => (&s[..s.len() - 1], 1024.0 * 1024.0),
        Some('t') => (&s[..s.len() - 1], 1024.0 * 1024.0 * 1024.0),
        _ => (s, 1.0),
    };
    (num.parse::<f64>().unwrap_or(0.0) * mul) as u64
}

fn duration(secs: u64) -> String {
    match secs {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}

/// `df -P -k` lines (header first) → real disks (no snaps, no EFI).
fn disks(lines: &[&str]) -> Vec<Disk> {
    lines
        .iter()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let size: u64 = f.get(1)?.parse().ok()?;
            if f.len() < 6
                || size == 0
                || f[5].starts_with("/snap")
                || f[5].starts_with("/boot/efi")
            {
                return None;
            }
            Some(Disk {
                fs: f[0].to_string(),
                size_kb: size,
                used_kb: f[2].parse().unwrap_or(0),
                avail_kb: f[3].parse().unwrap_or(0),
                mount: f[5..].join(" "),
            })
        })
        .collect()
}

pub fn parse(out: &str) -> Result<Sample, String> {
    let sec = sections(out);
    let first = |name: &str| sec.get(name).and_then(|v| v.first().copied()).unwrap_or("");
    if !sec.contains_key("meminfo") {
        return Err("the server didn't answer with Linux stats (is it Linux?)".into());
    }
    let mut s = Sample {
        uptime_s: first("uptime")
            .split_whitespace()
            .next()
            .and_then(|u| u.parse::<f64>().ok())
            .unwrap_or(0.0) as u64,
        cores: first("nproc").trim().parse().unwrap_or(1),
        ..Default::default()
    };
    let load: Vec<f64> = first("load")
        .split_whitespace()
        .take(3)
        .filter_map(|x| x.parse().ok())
        .collect();
    if load.len() == 3 {
        s.load = [load[0], load[1], load[2]];
    }
    if let (Some((b1, t1)), Some((b2, t2))) = (cpu_ticks(first("stat1")), cpu_ticks(first("stat2")))
    {
        if t2 > t1 {
            s.cpu_pct =
                ((b2.saturating_sub(b1)) as f64 / (t2 - t1) as f64 * 100.0).clamp(0.0, 100.0);
        }
    }
    let mut mem = std::collections::HashMap::new();
    for l in sec.get("meminfo").into_iter().flatten() {
        let mut it = l.split_whitespace();
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            mem.insert(k.trim_end_matches(':'), v.parse::<u64>().unwrap_or(0));
        }
    }
    let m = |k: &str| mem.get(k).copied().unwrap_or(0);
    s.mem_total_kb = m("MemTotal");
    s.mem_available_kb = if mem.contains_key("MemAvailable") {
        m("MemAvailable")
    } else {
        m("MemFree") + m("Cached")
    };
    s.mem_cache_kb = m("Buffers") + m("Cached") + m("SReclaimable");
    s.swap_total_kb = m("SwapTotal");
    s.swap_free_kb = m("SwapFree");

    s.disks = disks(sec.get("df").map(Vec::as_slice).unwrap_or_default());

    // top: PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND…
    for l in sec.get("top").into_iter().flatten() {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 12 {
            continue;
        }
        let Ok(pid) = f[0].parse() else { continue };
        s.top_cpu.push(Proc {
            pid,
            user: f[1].to_string(),
            rss_kb: kib(f[5]),
            cpu: f[8].parse().unwrap_or(0.0),
            mem_pct: f[9].parse().unwrap_or(0.0),
            time: f[10].to_string(),
            command: f[11..].join(" "),
        });
    }
    // ps: PID USER %CPU %MEM RSS ELAPSED ARGS…
    for l in sec.get("psmem").into_iter().flatten() {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 7 {
            continue;
        }
        let Ok(pid) = f[0].parse() else { continue };
        s.top_mem.push(Proc {
            pid,
            user: f[1].to_string(),
            cpu: f[2].parse().unwrap_or(0.0),
            mem_pct: f[3].parse().unwrap_or(0.0),
            rss_kb: f[4].parse().unwrap_or(0),
            time: duration(f[5].parse().unwrap_or(0)),
            command: f[6..].join(" "),
        });
    }
    let os = sec.get("os").cloned().unwrap_or_default();
    s.os = os.first().map(|x| x.trim().to_string()).unwrap_or_default();
    s.kernel = os.get(1).map(|x| x.trim().to_string()).unwrap_or_default();
    Ok(s)
}

/// Run a read-only script on a server over the shared ssh connection.
pub(crate) async fn run(state: &AppState, server_id: &str, script: &str) -> AppResult<String> {
    run_for(state, server_id, script, 20).await
}

/// `run` with a longer limit, for work that takes a while (copying a big
/// folder, packing one to download, searching).
pub(crate) async fn run_for(
    state: &AppState,
    server_id: &str,
    script: &str,
    secs: u64,
) -> AppResult<String> {
    let config = state
        .config
        .config()
        .ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))?;
    let server = config
        .server(server_id)
        .ok_or_else(|| AppError::NotFound(format!("server `{server_id}` isn't in Kemudi")))?;
    crate::ssh::validate_host(&server.host)?;
    let control = dirs::home_dir()
        .map(|h| h.join(".ssh").join("kemudi-cm-%C"))
        .ok_or_else(|| AppError::Invalid("no home directory".into()))?;
    let env = state.env_ready().await;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args([
        "-o",
        "BatchMode=yes",
        "-o",
        // Our own read-only script, never the config's RemoteCommand
        // (e.g. `sudo -i`), and no TTY: it reads the script from stdin.
        "RemoteCommand=none",
        "-o",
        "RequestTTY=no",
        "-o",
        "ConnectTimeout=5",
        "-o",
        // See ssh::connect_opts: retry dropped connects on a fresh port.
        "ConnectionAttempts=8",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ControlMaster=auto",
        "-o",
    ])
    .arg(format!("ControlPath={}", control.display()))
    .args(["-o", "ControlPersist=120", &server.host, "sh -s"])
    .env_clear()
    .envs(&env.vars)
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
    let mut child = cmd.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin.write_all(script.as_bytes()).await?;
    }
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(secs),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| {
        AppError::Invalid(if secs <= 20 {
            format!("no answer within {secs} s (VPN down?)")
        } else {
            format!("still not done after {} min: stopped waiting", secs / 60)
        })
    })??;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() && !stdout.contains("@@") {
        return Err(AppError::Invalid(crate::ssh_hosts::explain(
            &String::from_utf8_lossy(&out.stderr),
        )));
    }
    Ok(stdout)
}

/// One sample from a server in servers.yaml.
#[tauri::command]
pub async fn monitor_sample(state: State<'_, AppState>, server_id: String) -> AppResult<Sample> {
    parse(&run(&state, &server_id, SCRIPT).await?).map_err(AppError::Invalid)
}

/// Just the disks (cheap; for background disk alerts).
#[tauri::command]
pub async fn monitor_disks(state: State<'_, AppState>, server_id: String) -> AppResult<Vec<Disk>> {
    let out = run(&state, &server_id, DISKS_SCRIPT).await?;
    let sec = sections(&out);
    Ok(disks(sec.get("df").map(Vec::as_slice).unwrap_or_default()))
}

/// The git remote (origin) of a folder on a server: `git remote get-url`,
/// read-only. `safe.directory=*` so a repo owned by another user still
/// answers.
#[tauri::command]
pub async fn app_detect_repo(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
) -> AppResult<String> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::Invalid("set the app's path first".into()));
    }
    let q = crate::actions::render::shell_quote(path);
    let script = format!(
        "export LC_ALL=C\necho @@repo\ngit -c safe.directory='*' -C {q} remote get-url origin 2>&1 || git -c safe.directory='*' -C {q} remote -v 2>&1 | head -1\n"
    );
    let out = run(&state, &server_id, &script).await?;
    let lines = sections(&out).get("repo").cloned().unwrap_or_default();
    pick_remote(&lines)
        .map_err(|why| AppError::Invalid(format!("no git remote found in {path} ({why})")))
}

/// `https://user:token@host/…` → `https://host/…`: a token in a clone URL is
/// a secret and never goes into servers.yaml.
pub fn strip_credentials(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    if !scheme.starts_with("http") {
        return url.to_string();
    }
    let host_end = rest.find('/').unwrap_or(rest.len());
    match rest[..host_end].rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => url.to_string(),
    }
}

/// `git remote get-url origin` output, else a `git remote -v` line
/// (`name<TAB>url (fetch)`), else git's own error. Credentials are dropped.
fn pick_remote(lines: &[&str]) -> Result<String, String> {
    pick_raw(lines).map(|u| strip_credentials(&u))
}

fn pick_raw(lines: &[&str]) -> Result<String, String> {
    let looks_like_url =
        |u: &str| u.contains("://") || u.starts_with('/') || (u.contains('@') && u.contains(':'));
    for l in lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        if looks_like_url(l) && !l.contains(' ') {
            return Ok(l.to_string());
        }
        if let Some(url) = l.split_whitespace().nth(1).filter(|u| looks_like_url(u)) {
            return Ok(url.to_string());
        }
    }
    let why = lines
        .iter()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("no output");
    Err(if why.contains("command not found") {
        "git isn't installed there".into()
    } else {
        why.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: &str = "@@uptime\n123456.78 400000.00\n@@load\n0.42 0.38 0.30 2/345 6789\n@@nproc\n4\n@@stat1\ncpu  1000 0 500 8000 100 0 0 0 0 0\n@@top\n 1234 www-data  20   0  512000 210m  12000 S  41.2   2.7   3:12.45 php-fpm: pool www\n  987 mysql     20   0 2100000 1.2g  30000 S  12.0  15.6 120:00.01 /usr/sbin/mysqld\n@@stat2\ncpu  1100 0 550 8150 100 0 0 0 0 0\n@@meminfo\nMemTotal:        8000000 kB\nMemFree:          500000 kB\nMemAvailable:    3000000 kB\nBuffers:          100000 kB\nCached:          2000000 kB\nSReclaimable:     200000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n@@df\nFilesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/vda1         62000000  38000000  24000000      62% /\n/dev/vdb1        100000000  92000000   8000000      92% /var/www\n/dev/loop0           50000     50000         0     100% /snap/core/1\n@@psmem\n  987 mysql    12.3 15.6 1250000 864000 /usr/sbin/mysqld\n 1234 www-data  1.1  2.7  215000   7200 php-fpm: pool www\n@@os\nUbuntu 22.04.4 LTS\n5.15.0-105-generic\n";

    #[test]
    fn parses_a_sample() {
        let s = parse(OUT).expect("parse");
        assert_eq!(
            (s.uptime_s, s.cores, s.load),
            (123456, 4, [0.42, 0.38, 0.30])
        );
        // busy 150 of 300 ticks
        assert!((s.cpu_pct - 50.0).abs() < 0.01, "{}", s.cpu_pct);
        assert_eq!(
            (s.mem_total_kb, s.mem_available_kb, s.mem_cache_kb),
            (8_000_000, 3_000_000, 2_300_000)
        );
        assert_eq!((s.swap_total_kb, s.swap_free_kb), (2_000_000, 1_500_000));
        assert_eq!(
            s.disks.iter().map(|d| d.mount.as_str()).collect::<Vec<_>>(),
            ["/", "/var/www"]
        );
        assert_eq!(s.top_cpu[0].command, "php-fpm: pool www");
        assert_eq!((s.top_cpu[0].cpu, s.top_cpu[0].rss_kb), (41.2, 210 * 1024));
        assert_eq!(s.top_cpu[1].rss_kb, (1.2 * 1024.0 * 1024.0) as u64);
        assert_eq!(
            (
                s.top_mem[0].user.as_str(),
                s.top_mem[0].rss_kb,
                s.top_mem[0].time.as_str()
            ),
            ("mysql", 1_250_000, "10d")
        );
        assert_eq!(
            (s.os.as_str(), s.kernel.as_str()),
            ("Ubuntu 22.04.4 LTS", "5.15.0-105-generic")
        );
    }

    #[test]
    fn picks_the_remote() {
        assert_eq!(
            pick_remote(&["git@github.com:org/core-v2.git"]).as_deref(),
            Ok("git@github.com:org/core-v2.git")
        );
        assert_eq!(
            pick_remote(&["https://gitlab.com/org/pdf.git"]).as_deref(),
            Ok("https://gitlab.com/org/pdf.git")
        );
        // No origin, another remote.
        assert_eq!(
            pick_remote(&[
                "error: No such remote 'origin'",
                "upstream\tgit@github.com:org/x.git (fetch)"
            ])
            .as_deref(),
            Ok("git@github.com:org/x.git")
        );
        assert!(pick_remote(&[
            "fatal: not a git repository (or any of the parent directories): .git"
        ])
        .is_err());
        assert_eq!(
            pick_remote(&["sh: 1: git: command not found"]),
            Err("git isn't installed there".to_string())
        );
        // A token in the clone URL never comes back.
        assert_eq!(
            pick_remote(&["https://deploy:ghp_SECRET@github.com/org/app.git"]).as_deref(),
            Ok("https://github.com/org/app.git")
        );
        assert_eq!(
            strip_credentials("git@github.com:org/app.git"),
            "git@github.com:org/app.git"
        );
    }

    #[test]
    fn not_linux() {
        assert!(parse("@@uptime\n@@load\n").is_err());
    }

    #[test]
    fn script_is_read_only() {
        // No writes, no sudo, no package installs.
        for bad in ["sudo", " > ", ">>", "rm ", "apt", "curl", "wget", "tee "] {
            assert!(
                !SCRIPT.contains(bad) && !DISKS_SCRIPT.contains(bad),
                "{bad}"
            );
        }
    }
}
