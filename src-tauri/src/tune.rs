//! Server fine-tuning: read what a server has and how it's set (CPUs, RAM,
//! swap; PHP-FPM pools and how much memory their workers use; OPcache;
//! MySQL; nginx), suggest settings that fit, and apply the ones picked:
//! every file is backed up first, PHP / nginx changes are tested (`php-fpm
//! -t`, `nginx -t`) and rolled back if the test fails, then the service is
//! reloaded; MySQL values are applied live. Each run keeps a manifest on the
//! server (/root/.kemudi-tune/<time>/) so "Undo last tuning" can put it all
//! back.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::actions::render::shell_quote;
use crate::error::{AppError, AppResult};
use crate::remote_files::{errors, lookup, saved_sudo, sudo_prelude, NO_SUDO};
use crate::AppState;

const MB: u64 = 1024; // in KB

/// Root, or sudo; runs the body (a heredoc) as root.
fn as_root(body: &str, password: Option<&str>) -> String {
    format!(
        r#"export LC_ALL=C
{prelude}if [ "$(id -u)" = 0 ]; then S=""; elif [ -n "$SU" ]; then S="$SU"; else echo "@@err tuning needs root: {NO_SUDO}"; exit 0; fi
$S sh <<'KEMUDI_TUNE'
export LC_ALL=C
{body}
KEMUDI_TUNE
"#,
        prelude = sudo_prelude(password),
    )
}

fn analyze_body(app_paths: &[String]) -> String {
    let apps = app_paths
        .iter()
        .map(|p| shell_quote(p))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"echo @@hw
echo "cpus $(nproc)"
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo | awk '{{print "mem", $1, $2}}'
echo "swappiness $(sysctl -n vm.swappiness 2>/dev/null)"
echo "load $(cut -d' ' -f1-3 /proc/loadavg)"
echo "diskfree $(df -Pk / | awk 'NR==2{{print $4}}')"
[ -n "$(ls -d /root/.kemudi-tune/2* 2>/dev/null)" ] && echo "lasttune $(ls -d /root/.kemudi-tune/2* | sort | tail -1)"
for b in /usr/sbin/php-fpm[0-9]*; do
  [ -x "$b" ] || continue
  v=${{b#/usr/sbin/php-fpm}}
  echo "@@fpm $v"
  m=$(pgrep -f "php-fpm: master process \(/etc/php/$v/" | head -1)
  echo "master ${{m:-0}}"
  [ -n "$m" ] && ps -eo ppid=,rss= | awk -v m="$m" '$1==m {{print "w", $2}}'
  for f in /etc/php/$v/fpm/pool.d/*.conf; do
    [ -f "$f" ] || continue
    echo "pool $f"
    grep -E '^[[:space:]]*(\[[^]]+\]|pm[.a-z_]*[[:space:]]*=)' "$f" | sed 's/^[[:space:]]*/  /'
  done
  "$b" -i 2>/dev/null | grep -E '^(memory_limit|upload_max_filesize|post_max_size|opcache\.(enable|memory_consumption|interned_strings_buffer|max_accelerated_files|validate_timestamps|revalidate_freq)) =>' | awk -F' => ' '{{print "ini", $1, $2}}'
  echo "warnings $(cat /var/log/php$v-fpm.log /var/log/php$v-fpm.log.1 2>/dev/null | grep -c 'reached pm.max_children')"
done
echo @@mysql
if pgrep -x mysqld >/dev/null 2>&1 || pgrep -x mariadbd >/dev/null 2>&1; then
  echo "rss $(ps -C mysqld,mariadbd -o rss= | awk '{{s+=$1}} END {{print s+0}}')"
  for d in /etc/mysql/mysql.conf.d /etc/mysql/mariadb.conf.d /etc/my.cnf.d; do [ -d "$d" ] && {{ echo "cnfdir $d"; break; }}; done
  Q="SELECT 'version', VERSION() UNION ALL SELECT 'bp', @@innodb_buffer_pool_size UNION ALL SELECT 'maxconn', @@max_connections UNION ALL SELECT 'data', IFNULL(SUM(data_length+index_length),0) FROM information_schema.tables WHERE engine='InnoDB'; SHOW GLOBAL STATUS LIKE 'Max_used_connections';"
  out=$(mysql -NBe "$Q" 2>/dev/null) || {{ [ -r /etc/mysql/debian.cnf ] && out=$(mysql --defaults-file=/etc/mysql/debian.cnf -NBe "$Q" 2>/dev/null) && echo "login debian"; }}
  if [ -n "$out" ]; then printf '%s\n' "$out" | awk -F'\t' '{{print "q", $1, $2}}'; else echo "nologin"; fi
fi
echo @@nginx
if [ -f /etc/nginx/nginx.conf ]; then
  grep -nE '^[[:space:]]*#?[[:space:]]*(worker_processes|worker_connections|client_max_body_size|gzip|gzip_types|server_tokens|keepalive_timeout)[[:space:]]' /etc/nginx/nginx.conf | sed 's/;.*//' | awk -F: '{{l=$1; sub(/^[0-9]+:/,""); print "d", l, $0}}'
  echo "bodymax $(cat /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null | grep -oE '^[[:space:]]*client_max_body_size[[:space:]]+[0-9]+[kKmMgG]?' | awk '{{print $2}}' | sort -u | tr '\n' ' ')"
fi
echo @@apps
for p in {apps}; do
  [ -d "$p" ] && echo "files $(find "$p" -name '*.php' -not -path '*/node_modules/*' -not -path '*/storage/*' 2>/dev/null | wc -l) $p"
done
"#,
        apps = if apps.is_empty() { "''".into() } else { apps },
    )
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub file: String,
    pub name: String,
    /// `pm`, `pm.max_children`…, as set.
    pub settings: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fpm {
    pub version: String,
    pub running: bool,
    pub pools: Vec<Pool>,
    /// RSS of each worker now (KB).
    pub workers_kb: Vec<u64>,
    /// "reached pm.max_children" in its log (this one and the last).
    pub warnings: u32,
    /// php.ini values for FPM (memory_limit, opcache.*).
    pub ini: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mysql {
    pub rss_kb: u64,
    pub version: Option<String>,
    pub buffer_pool: Option<u64>,
    pub max_connections: Option<u64>,
    pub max_used: Option<u64>,
    pub data_bytes: Option<u64>,
    pub cnf_dir: Option<String>,
    /// Couldn't log in to ask (root needs a password).
    pub no_login: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub cpus: u32,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub swap_total_kb: u64,
    pub swappiness: Option<u32>,
    pub load: String,
    pub disk_free_kb: u64,
    pub last_tune: Option<String>,
    pub fpm: Vec<Fpm>,
    pub mysql: Option<Mysql>,
    /// nginx.conf directives: name → (line, value, commented out).
    pub nginx: BTreeMap<String, (u32, String, bool)>,
    pub nginx_body_max: Vec<String>,
    pub php_files: u64,
    pub apps_counted: u32,
}

fn parse_facts(out: &str) -> Facts {
    let mut f = Facts::default();
    let mut sec = "";
    for l in out.lines() {
        if let Some(s) = l.strip_prefix("@@") {
            let mut it = s.splitn(2, ' ');
            sec = match it.next().unwrap_or("") {
                "hw" => "hw",
                "fpm" => {
                    f.fpm.push(Fpm {
                        version: it.next().unwrap_or("").trim().to_string(),
                        ..Fpm::default()
                    });
                    "fpm"
                }
                "mysql" => "mysql",
                "nginx" => "nginx",
                "apps" => "apps",
                _ => "",
            };
            continue;
        }
        let w: Vec<&str> = l.split_whitespace().collect();
        match sec {
            "hw" => match w.as_slice() {
                ["cpus", n] => f.cpus = n.parse().unwrap_or(1),
                ["mem", k, v] => {
                    let v: u64 = v.parse().unwrap_or(0);
                    match *k {
                        "MemTotal:" => f.mem_total_kb = v,
                        "MemAvailable:" => f.mem_available_kb = v,
                        "SwapTotal:" => f.swap_total_kb = v,
                        _ => {}
                    }
                }
                ["swappiness", n] => f.swappiness = n.parse().ok(),
                ["load", rest @ ..] => f.load = rest.join(" "),
                ["diskfree", n] => f.disk_free_kb = n.parse().unwrap_or(0),
                ["lasttune", p] => f.last_tune = Some((*p).to_string()),
                _ => {}
            },
            "fpm" => {
                let Some(p) = f.fpm.last_mut() else { continue };
                match w.as_slice() {
                    ["master", m] => p.running = *m != "0",
                    ["w", kb] => p.workers_kb.push(kb.parse().unwrap_or(0)),
                    ["pool", file] => p.pools.push(Pool {
                        file: (*file).to_string(),
                        ..Pool::default()
                    }),
                    ["warnings", n] => p.warnings = n.parse().unwrap_or(0),
                    ["ini", k, v @ ..] => {
                        p.ini.insert((*k).to_string(), v.join(" "));
                    }
                    _ => {
                        let t = l.trim();
                        let Some(pool) = p.pools.last_mut() else {
                            continue;
                        };
                        if let Some(n) = t.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
                            if pool.name.is_empty() {
                                pool.name = n.to_string();
                            }
                        } else if let Some((k, v)) = t.split_once('=') {
                            pool.settings
                                .insert(k.trim().to_string(), v.trim().to_string());
                        }
                    }
                }
            }
            "mysql" => {
                let m = f.mysql.get_or_insert_with(Mysql::default);
                match w.as_slice() {
                    ["rss", n] => m.rss_kb = n.parse().unwrap_or(0),
                    ["cnfdir", d] => m.cnf_dir = Some((*d).to_string()),
                    ["nologin"] => m.no_login = true,
                    ["q", k, v @ ..] => {
                        let v = v.join(" ");
                        match *k {
                            "version" => m.version = Some(v),
                            "bp" => m.buffer_pool = v.parse().ok(),
                            "maxconn" => m.max_connections = v.parse().ok(),
                            "data" => m.data_bytes = v.parse().ok(),
                            "Max_used_connections" => m.max_used = v.parse().ok(),
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            "nginx" => match w.as_slice() {
                ["d", line, rest @ ..] => {
                    let commented = rest.first().is_some_and(|x| x.starts_with('#'));
                    let rest: Vec<&str> = rest
                        .iter()
                        .map(|x| x.trim_start_matches('#'))
                        .filter(|x| !x.is_empty())
                        .collect();
                    if let Some((k, v)) = rest.split_first() {
                        let e = f
                            .nginx
                            .entry((*k).to_string())
                            .or_insert((0, String::new(), true));
                        // An active line wins over a commented one.
                        if e.0 == 0 || (e.2 && !commented) {
                            *e = (line.parse().unwrap_or(0), v.join(" "), commented);
                        }
                    }
                }
                ["bodymax", rest @ ..] => {
                    f.nginx_body_max = rest.iter().map(|s| (*s).to_string()).collect()
                }
                _ => {}
            },
            "apps" => {
                if let ["files", n, ..] = w.as_slice() {
                    f.php_files += n.parse::<u64>().unwrap_or(0);
                    f.apps_counted += 1;
                }
            }
            _ => {}
        }
    }
    f
}

/// What a change does on the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Change {
    /// `key = value` in a PHP-FPM pool file.
    Pool {
        version: String,
        file: String,
        key: String,
        value: String,
    },
    /// php.ini for FPM, in /etc/php/<v>/fpm/conf.d/99-kemudi.ini.
    PhpIni {
        version: String,
        key: String,
        value: String,
    },
    /// MySQL, live (SET GLOBAL) and in <cnfdir>/99-kemudi.cnf.
    Mysql {
        cnf_dir: String,
        key: String,
        value: String,
    },
    /// A directive in /etc/nginx/nginx.conf (`context`: main, events, http).
    Nginx {
        context: String,
        key: String,
        value: String,
    },
    /// /etc/sysctl.d/60-kemudi.conf, applied now.
    Sysctl { key: String, value: String },
    /// A swap file (/swapfile) of this many MB, on at boot.
    Swapfile { mb: u64 },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    /// "PHP-FPM 8.4 · www", "OPcache 8.4", "MySQL", "nginx", "Memory".
    pub area: String,
    pub setting: String,
    pub current: String,
    pub suggested: String,
    pub why: String,
    /// What applying does: "reload php8.4-fpm", "live, no restart"…
    pub effect: String,
    /// important / suggested / optional (optional ones start unticked).
    pub level: String,
    pub change: Option<Change>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub total_kb: u64,
    pub reserve_kb: u64,
    pub others_kb: u64,
    pub mysql_kb: u64,
    pub php_kb: u64,
    /// PHP-FPM workers now / at the suggested limits (if all busy).
    pub php_now_kb: u64,
    pub php_planned_kb: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    pub facts: Facts,
    pub budget: Budget,
    pub suggestions: Vec<Suggestion>,
    pub notes: Vec<String>,
}

fn mb(kb: u64) -> String {
    if kb >= 1024 * MB {
        format!("{:.1} GB", kb as f64 / (1024.0 * MB as f64))
    } else {
        format!("{} MB", kb / MB)
    }
}

/// "128M", "1G", "512" (bytes) → KB.
fn size_kb(s: &str) -> Option<u64> {
    let s = s.trim();
    if s == "-1" {
        return None;
    }
    let (n, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len()));
    let n: u64 = n.parse().ok()?;
    Some(match unit.to_ascii_uppercase().as_str() {
        "K" => n,
        "M" => n * MB,
        "G" => n * MB * 1024,
        "" => n / 1024,
        _ => return None,
    })
}

fn round_up(v: u64, step: u64) -> u64 {
    v.div_ceil(step) * step
}

fn suggest(f: &Facts) -> Tuning {
    let mut s: Vec<Suggestion> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let total = f.mem_total_kb.max(1);
    let used = total.saturating_sub(f.mem_available_kb);
    let fpm_now: u64 = f.fpm.iter().flat_map(|p| p.workers_kb.iter()).sum();
    let mysql_now = f.mysql.as_ref().map_or(0, |m| m.rss_kb);
    let others = used.saturating_sub(fpm_now + mysql_now);
    let reserve = (512 * MB).max(total / 10);

    let cpus = u64::from(f.cpus.max(1));
    let running: Vec<&Fpm> = f
        .fpm
        .iter()
        .filter(|p| p.running && !p.pools.is_empty())
        .collect();

    // Each pool: how big a busy worker is, its limit now, and what it needs
    // (half again for one that hit its limit).
    struct Plan<'a> {
        fpm: &'a Fpm,
        pool: &'a Pool,
        per: u64,
        cur: u64,
        need: u64,
    }
    let mut plans: Vec<Plan> = Vec::new();
    for p in &running {
        let avg = if p.workers_kb.is_empty() {
            60 * MB
        } else {
            p.workers_kb.iter().sum::<u64>() / p.workers_kb.len() as u64
        };
        let peak = p.workers_kb.iter().copied().max().unwrap_or(avg);
        // Between the average and the biggest worker seen.
        let per = ((avg + peak) / 2).max(30 * MB);
        for pool in &p.pools {
            let cur = pool
                .settings
                .get("pm.max_children")
                .and_then(|x| x.parse::<u64>().ok())
                .unwrap_or(5);
            let need = if p.warnings > 0 {
                (cur * 3).div_ceil(2).max(cur + 2)
            } else {
                cur
            };
            plans.push(Plan {
                fpm: p,
                pool,
                per,
                cur,
                need,
            });
        }
    }
    let php_floor: u64 = plans.iter().map(|x| x.need * x.per).sum();

    // MySQL: a buffer pool to fit the data, in the room PHP leaves.
    let mut mysql_target = mysql_now;
    if let Some(m) = &f.mysql {
        if m.no_login {
            notes.push("MySQL: Kemudi couldn't log in to read its settings (root needs a password, and there's no /etc/mysql/debian.cnf login), so it isn't tuned. Its memory is counted as it is now.".into());
        } else if let (Some(bp), Some(data), Some(dir)) =
            (m.buffer_pool, m.data_bytes, m.cnf_dir.as_deref())
        {
            let step = 128 * 1024 * 1024u64;
            let cap = ((total * 1024) as f64 * if running.is_empty() { 0.7 } else { 0.4 }) as u64
                / step
                * step;
            let want = round_up(data + data * 3 / 10, step).clamp(step, cap.max(step));
            let overhead = (mysql_now * 1024).saturating_sub(bp);
            let room = (total.saturating_sub(reserve + others + php_floor) * 1024)
                .saturating_sub(overhead)
                / step
                * step;
            let target = want.min(room).max(bp.min(want));
            mysql_target = (target.max(bp) + overhead) / 1024;
            if bp < target * 8 / 10 {
                let limited = target < want;
                s.push(Suggestion {
                    id: "mysql:bp".into(),
                    area: "MySQL".into(),
                    setting: "innodb_buffer_pool_size".into(),
                    current: mb(bp / 1024),
                    suggested: mb(target / 1024),
                    why: format!(
                        "InnoDB data and indexes are {}, but only {} is kept in memory: most reads go to disk.{}",
                        mb(data / 1024),
                        mb(bp / 1024),
                        if limited {
                            format!(" {} is what fits next to PHP-FPM's workers here; with more RAM, up to {} would help.", mb(target / 1024), mb(want / 1024))
                        } else {
                            String::new()
                        }
                    ),
                    effect: "live if MySQL allows it, else at its next restart".into(),
                    level: if bp * 2 < data { "important" } else { "suggested" }.into(),
                    change: Some(Change::Mysql { cnf_dir: dir.into(), key: "innodb_buffer_pool_size".into(), value: (target / 1024 / 1024).to_string() + "M" }),
                });
            }
            if let (Some(max), Some(peak)) = (m.max_connections, m.max_used) {
                if peak * 10 >= max * 8 {
                    let want = (peak * 2).max(200);
                    s.push(Suggestion {
                        id: "mysql:maxconn".into(),
                        area: "MySQL".into(),
                        setting: "max_connections".into(),
                        current: max.to_string(),
                        suggested: want.to_string(),
                        why: format!("{peak} connections were used at the busiest moment since MySQL started: close to the limit of {max}."),
                        effect: "live if MySQL allows it, else at its next restart".into(),
                        level: "important".into(),
                        change: Some(Change::Mysql { cnf_dir: dir.into(), key: "max_connections".into(), value: want.to_string() }),
                    });
                }
            }
        }
    }

    // PHP-FPM: each pool's need first, then any room left by weight; only
    // lower a limit when memory is overcommitted.
    let php_budget = total.saturating_sub(reserve + others + mysql_target);
    let over = php_floor > php_budget;
    let extra = php_budget.saturating_sub(php_floor);
    if over {
        notes.push(format!(
            "Memory is overcommitted: if every PHP-FPM worker allowed were busy at once they'd need {}, but {} is left after the system, MySQL and other services. Limits are lowered to fit; more RAM, or fewer PHP versions running, would help.",
            mb(php_floor),
            mb(php_budget)
        ));
    }
    let mut planned: u64 = 0;
    for x in &plans {
        let p = x.fpm;
        let v = &p.version;
        let pool = x.pool;
        let per = x.per;
        let cur = x.cur;
        let get = |k: &str| {
            pool.settings
                .get(k)
                .and_then(|y| y.trim_end_matches('s').parse::<u64>().ok())
        };
        let pm = pool
            .settings
            .get("pm")
            .map_or("dynamic", String::as_str)
            .to_string();
        let mine = x.need * per;
        let target = if over {
            mine * php_budget / php_floor.max(1)
        } else {
            mine + extra * mine / php_floor.max(1)
        };
        let mut want = (target / per).clamp(4, (cur * 3).clamp(10, 200));
        if !over {
            want = want.max(cur);
        }
        planned += want * per;
        let area = format!(
            "PHP-FPM {v} · {}",
            if pool.name.is_empty() {
                "pool"
            } else {
                &pool.name
            }
        );
        let file = pool.file.clone();
        let change_max = want != cur
            && (want >= cur * 5 / 4 || (p.warnings > 0 && want > cur) || (over && want < cur));
        if change_max {
            let hit = if p.warnings > 0 {
                format!(
                    " It hit its limit {} time{} recently (requests had to wait).",
                    p.warnings,
                    if p.warnings == 1 { "" } else { "s" }
                )
            } else {
                String::new()
            };
            let why = if over {
                format!(
                    "Workers use about {} each.{hit} With {} for all of PHP-FPM, {want} fit.",
                    mb(per),
                    mb(php_budget)
                )
            } else {
                format!("Workers use about {} each ({} running now).{hit} There's room for {want} ({} for all of PHP-FPM).", mb(per), p.workers_kb.len(), mb(php_budget))
            };
            s.push(Suggestion {
                id: format!("fpm:{v}:{file}:max"),
                area: area.clone(),
                setting: "pm.max_children".into(),
                current: cur.to_string(),
                suggested: want.to_string(),
                why,
                effect: format!("reload php{v}-fpm"),
                level: if p.warnings > 0 || want < cur {
                    "important"
                } else {
                    "suggested"
                }
                .into(),
                change: Some(Change::Pool {
                    version: v.clone(),
                    file: file.clone(),
                    key: "pm.max_children".into(),
                    value: want.to_string(),
                }),
            });
            if pm == "dynamic" {
                // Spares that fit the new limit (php-fpm refuses them otherwise).
                let min_spare = (cpus / 2).clamp(1, (want / 4).max(1));
                let max_spare = (cpus * 2).clamp(min_spare + 1, (want / 2).max(min_spare + 1));
                let start = (min_spare + (max_spare - min_spare) / 2).max(min_spare);
                for (k, val) in [
                    ("pm.start_servers", start),
                    ("pm.min_spare_servers", min_spare),
                    ("pm.max_spare_servers", max_spare),
                ] {
                    if get(k) != Some(val) {
                        s.push(Suggestion {
                            id: format!("fpm:{v}:{file}:{k}"),
                            area: area.clone(),
                            setting: k.into(),
                            current: get(k).map_or("–".into(), |y| y.to_string()),
                            suggested: val.to_string(),
                            why: format!("Idle workers kept ready, to match {want} children and {cpus} CPUs."),
                            effect: format!("reload php{v}-fpm"),
                            level: "suggested".into(),
                            change: Some(Change::Pool { version: v.clone(), file: file.clone(), key: k.into(), value: val.to_string() }),
                        });
                    }
                }
            }
        }
        if get("pm.max_requests").unwrap_or(0) == 0 {
            s.push(Suggestion {
                id: format!("fpm:{v}:{file}:maxreq"),
                area: area.clone(),
                setting: "pm.max_requests".into(),
                current: "0 (never)".into(),
                suggested: "500".into(),
                why: "Recycle a worker after 500 requests, so a slow memory leak in an app or extension can't grow forever.".into(),
                effect: format!("reload php{v}-fpm"),
                level: "suggested".into(),
                change: Some(Change::Pool { version: v.clone(), file, key: "pm.max_requests".into(), value: "500".into() }),
            });
        }
    }

    for p in &running {
        let v = &p.version;

        // OPcache and php.ini for this version.
        let ini = |k: &str| p.ini.get(k).map(String::as_str);
        let opc = format!("OPcache {v}");
        if ini("opcache.enable").is_some_and(|x| x.eq_ignore_ascii_case("off") || x == "0") {
            s.push(Suggestion {
                id: format!("ini:{v}:opcache.enable"),
                area: opc.clone(),
                setting: "opcache.enable".into(),
                current: "Off".into(),
                suggested: "1".into(),
                why:
                    "Without OPcache every request compiles the app's PHP again: often 2–3× slower."
                        .into(),
                effect: format!("reload php{v}-fpm"),
                level: "important".into(),
                change: Some(Change::PhpIni {
                    version: v.clone(),
                    key: "opcache.enable".into(),
                    value: "1".into(),
                }),
            });
        }
        let files = if f.apps_counted > 0 {
            f.php_files
        } else {
            20000
        };
        let need = files + files / 5;
        let steps = [10000u64, 20000, 32531, 65407, 100000, 130987];
        if let Some(cur) = ini("opcache.max_accelerated_files").and_then(|x| x.parse::<u64>().ok())
        {
            let want = steps.iter().copied().find(|x| *x >= need).unwrap_or(130987);
            if cur < need {
                s.push(Suggestion {
                    id: format!("ini:{v}:opcache.max_accelerated_files"),
                    area: opc.clone(),
                    setting: "opcache.max_accelerated_files".into(),
                    current: cur.to_string(),
                    suggested: want.to_string(),
                    why: if f.apps_counted > 0 {
                        format!("The {} app{} in Kemudi on this server have {files} PHP files (with vendor/): more than the cache can hold, so files keep being compiled again.", f.apps_counted, if f.apps_counted == 1 { "" } else { "s" })
                    } else {
                        "A Laravel app with its vendor/ folder has 15–25 thousand PHP files: more than the cache can hold.".into()
                    },
                    effect: format!("reload php{v}-fpm"),
                    level: "important".into(),
                    change: Some(Change::PhpIni { version: v.clone(), key: "opcache.max_accelerated_files".into(), value: want.to_string() }),
                });
            }
        }
        if let Some(cur) = ini("opcache.memory_consumption").and_then(|x| x.parse::<u64>().ok()) {
            let want: u64 = if files > 40000 || total >= 4 * 1024 * MB {
                256
            } else {
                128
            };
            if cur < want {
                s.push(Suggestion {
                    id: format!("ini:{v}:opcache.memory_consumption"),
                    area: opc.clone(),
                    setting: "opcache.memory_consumption".into(),
                    current: format!("{cur} MB"),
                    suggested: format!("{want} MB"),
                    why: "Room for the compiled code of all the apps (and their vendor/), so nothing is pushed out.".into(),
                    effect: format!("reload php{v}-fpm"),
                    level: "suggested".into(),
                    change: Some(Change::PhpIni { version: v.clone(), key: "opcache.memory_consumption".into(), value: want.to_string() }),
                });
            }
        }
        if let Some(cur) =
            ini("opcache.interned_strings_buffer").and_then(|x| x.parse::<u64>().ok())
        {
            if cur < 16 && total >= 2 * 1024 * MB {
                s.push(Suggestion {
                    id: format!("ini:{v}:opcache.interned_strings_buffer"),
                    area: opc.clone(),
                    setting: "opcache.interned_strings_buffer".into(),
                    current: format!("{cur} MB"),
                    suggested: "16 MB".into(),
                    why: "Laravel apps use many class and method names; 8 MB usually fills up."
                        .into(),
                    effect: format!("reload php{v}-fpm"),
                    level: "suggested".into(),
                    change: Some(Change::PhpIni {
                        version: v.clone(),
                        key: "opcache.interned_strings_buffer".into(),
                        value: "16".into(),
                    }),
                });
            }
        }
        if ini("opcache.validate_timestamps")
            .is_some_and(|x| x.eq_ignore_ascii_case("off") || x == "0")
        {
            notes.push(format!("PHP {v}: opcache.validate_timestamps is off, so code changed by `git pull` isn't picked up until php{v}-fpm is reloaded."));
        }
        if ini("memory_limit") == Some("-1") {
            s.push(Suggestion {
                id: format!("ini:{v}:memory_limit"),
                area: format!("PHP {v}"),
                setting: "memory_limit".into(),
                current: "-1 (no limit)".into(),
                suggested: "512M".into(),
                why: "With no limit one runaway request can use all the server's memory.".into(),
                effect: format!("reload php{v}-fpm"),
                level: "suggested".into(),
                change: Some(Change::PhpIni {
                    version: v.clone(),
                    key: "memory_limit".into(),
                    value: "512M".into(),
                }),
            });
        } else if let Some(lim) = ini("memory_limit").and_then(size_kb) {
            if lim > total / 4 {
                notes.push(format!("PHP {v}: memory_limit is {}, over a quarter of the RAM: a few busy requests could use it all.", mb(lim)));
            }
        }
    }

    // nginx.
    let ng = |k: &str| {
        f.nginx
            .get(k)
            .filter(|(_, _, c)| !c)
            .map(|(_, v, _)| v.as_str())
    };
    if !f.nginx.is_empty() || !f.nginx_body_max.is_empty() {
        if let Some(wp) = ng("worker_processes") {
            if wp != "auto" && wp.parse::<u64>().ok() != Some(cpus) {
                s.push(Suggestion {
                    id: "nginx:worker_processes".into(),
                    area: "nginx".into(),
                    setting: "worker_processes".into(),
                    current: wp.into(),
                    suggested: "auto".into(),
                    why: format!("One worker per CPU ({cpus})."),
                    effect: "test and reload nginx".into(),
                    level: "suggested".into(),
                    change: Some(Change::Nginx {
                        context: "main".into(),
                        key: "worker_processes".into(),
                        value: "auto".into(),
                    }),
                });
            }
        }
        let wc = ng("worker_connections")
            .and_then(|x| x.parse::<u64>().ok())
            .unwrap_or(512);
        if wc < 1024 {
            s.push(Suggestion {
                id: "nginx:worker_connections".into(),
                area: "nginx".into(),
                setting: "worker_connections".into(),
                current: wc.to_string(),
                suggested: "1024".into(),
                why: "Open connections each worker can hold (visitors, keep-alive, PHP-FPM): Ubuntu's 768 is low for several busy sites.".into(),
                effect: "test and reload nginx".into(),
                level: "optional".into(),
                change: Some(Change::Nginx { context: "events".into(), key: "worker_connections".into(), value: "1024".into() }),
            });
        }
        if ng("gzip").is_some_and(|g| g == "on") && ng("gzip_types").is_none() {
            s.push(Suggestion {
                id: "nginx:gzip_types".into(),
                area: "nginx".into(),
                setting: "gzip_types".into(),
                current: "text/html only".into(),
                suggested: "CSS, JS, JSON, SVG, XML".into(),
                why: "gzip is on but only for HTML; compressing CSS, JS and JSON responses makes pages and APIs load faster.".into(),
                effect: "test and reload nginx".into(),
                level: "optional".into(),
                change: Some(Change::Nginx {
                    context: "http".into(),
                    key: "gzip_types".into(),
                    value: "text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml".into(),
                }),
            });
        }
        if ng("server_tokens").is_none_or(|v| v != "off") {
            s.push(Suggestion {
                id: "nginx:server_tokens".into(),
                area: "nginx".into(),
                setting: "server_tokens".into(),
                current: ng("server_tokens").unwrap_or("on").into(),
                suggested: "off".into(),
                why: "Don't tell visitors the exact nginx version.".into(),
                effect: "test and reload nginx".into(),
                level: "optional".into(),
                change: Some(Change::Nginx {
                    context: "http".into(),
                    key: "server_tokens".into(),
                    value: "off".into(),
                }),
            });
        }
    }

    // Swap.
    if f.swap_total_kb == 0 {
        let want_mb: u64 = if total <= 2 * 1024 * MB {
            2048
        } else {
            2048.max((total / MB / 4).min(4096))
        };
        if f.disk_free_kb > (want_mb + 2048) * MB {
            s.push(Suggestion {
                id: "swap:file".into(),
                area: "Memory".into(),
                setting: "swap".into(),
                current: "none".into(),
                suggested: format!("{} swap file", mb(want_mb * MB)),
                why: "With no swap, when memory runs out the kernel kills a process (often MySQL or PHP-FPM). A little swap is a safety net.".into(),
                effect: "now, and at boot (/etc/fstab)".into(),
                level: if total <= 4 * 1024 * MB { "important" } else { "suggested" }.into(),
                change: Some(Change::Swapfile { mb: want_mb }),
            });
        }
    }
    if let Some(sw) = f.swappiness {
        if sw > 20 && (f.swap_total_kb > 0 || f.mem_total_kb > 0) {
            s.push(Suggestion {
                id: "sysctl:swappiness".into(),
                area: "Memory".into(),
                setting: "vm.swappiness".into(),
                current: sw.to_string(),
                suggested: "10".into(),
                why: "Use swap only when memory is really short, instead of pushing out PHP and MySQL memory early.".into(),
                effect: "now, and at boot".into(),
                level: "suggested".into(),
                change: Some(Change::Sysctl { key: "vm.swappiness".into(), value: "10".into() }),
            });
        }
    }

    Tuning {
        budget: Budget {
            total_kb: total,
            reserve_kb: reserve,
            others_kb: others,
            mysql_kb: mysql_target,
            php_kb: php_budget,
            php_now_kb: fpm_now,
            php_planned_kb: planned,
        },
        facts: f.clone(),
        suggestions: s,
        notes,
    }
}

/// What the server has and the settings Kemudi suggests for it. Read-only.
#[tauri::command]
pub async fn tune_analyze(state: State<'_, AppState>, server_id: String) -> AppResult<Tuning> {
    let server = lookup(&state, &server_id)?;
    let apps: Vec<String> = server
        .apps
        .iter()
        .map(|a| a.path.trim_end_matches('/').to_string())
        .filter(|p| p.starts_with('/') && !p.contains(['\n', '\r', '\0']))
        .collect();
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_for(
        &state,
        &server_id,
        &as_root(&analyze_body(&apps), password.as_deref()),
        90,
    )
    .await?;
    errors(&out)?;
    if !out.contains("@@hw") {
        return Err(AppError::Invalid("no answer from the server".into()));
    }
    Ok(suggest(&parse_facts(&out)))
}

fn safe_value(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 400
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b" ._-+/:".contains(&b))
}

fn safe_key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 64
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._".contains(&b))
}

fn safe_version(v: &str) -> bool {
    !v.is_empty() && v.len() <= 5 && v.bytes().all(|b| b.is_ascii_digit() || b == b'.')
}

/// The apply script: back up, change, test, reload or roll back, per
/// group (each PHP version, nginx, MySQL, sysctl, swap).
fn apply_body(changes: &[(String, Change)]) -> AppResult<String> {
    let q = |s: &str| shell_quote(s);
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, c) in changes {
        let ok = match c {
            Change::Pool {
                version,
                file,
                key,
                value,
            } => {
                safe_version(version)
                    && file.starts_with(&format!("/etc/php/{version}/fpm/pool.d/"))
                    && file.ends_with(".conf")
                    && !file.contains("..")
                    && safe_key(key)
                    && safe_value(value)
            }
            Change::PhpIni {
                version,
                key,
                value,
            } => safe_version(version) && safe_key(key) && safe_value(value),
            Change::Mysql {
                cnf_dir,
                key,
                value,
            } => {
                [
                    "/etc/mysql/mysql.conf.d",
                    "/etc/mysql/mariadb.conf.d",
                    "/etc/my.cnf.d",
                ]
                .contains(&cnf_dir.as_str())
                    && safe_key(key)
                    && safe_value(value)
            }
            Change::Nginx {
                context,
                key,
                value,
            } => {
                ["main", "events", "http"].contains(&context.as_str())
                    && safe_key(key)
                    && safe_value(value)
            }
            Change::Sysctl { key, value } => safe_key(key) && safe_value(value),
            Change::Swapfile { mb } => (256..=16384).contains(mb),
        };
        if !ok {
            return Err(AppError::Invalid(format!(
                "{id}: not a change Kemudi makes"
            )));
        }
        let (group, line) = match c {
            Change::Pool {
                version,
                file,
                key,
                value,
            } => (
                format!("php:{version}"),
                format!("setini {} {} {} {}", q(file), q(key), q(value), q(id)),
            ),
            Change::PhpIni {
                version,
                key,
                value,
            } => (
                format!("php:{version}"),
                format!(
                    "setini {} {} {} {}",
                    q(&format!("/etc/php/{version}/fpm/conf.d/99-kemudi.ini")),
                    q(key),
                    q(value),
                    q(id)
                ),
            ),
            Change::Mysql {
                cnf_dir,
                key,
                value,
            } => (
                "mysql".into(),
                format!(
                    "setmysql {} {} {} {}",
                    q(&format!("{cnf_dir}/99-kemudi.cnf")),
                    q(key),
                    q(value),
                    q(id)
                ),
            ),
            Change::Nginx {
                context,
                key,
                value,
            } => (
                "nginx".into(),
                format!("setngx {} {} {} {}", q(context), q(key), q(value), q(id)),
            ),
            Change::Sysctl { key, value } => (
                "sysctl".into(),
                format!("setsysctl {} {} {}", q(key), q(value), q(id)),
            ),
            Change::Swapfile { mb } => ("swap".into(), format!("mkswapfile {mb} {}", q(id))),
        };
        groups.entry(group).or_default().push(line);
    }
    let mut body = String::from(APPLY_LIB);
    for (group, lines) in &groups {
        body.push_str(&format!("IDS=\"\"\n# {group}\n"));
        for l in lines {
            body.push_str(l);
            body.push('\n');
        }
        let test = if let Some(v) = group.strip_prefix("php:") {
            format!("check \"php-fpm{v} -t\" \"systemctl reload php{v}-fpm\"\n")
        } else if group == "nginx" {
            "check \"nginx -t\" \"systemctl reload nginx\"\n".into()
        } else {
            "for i in $IDS; do echo \"@@done $i\"; DONE=$((DONE + 1)); done\nGROUPFILES=\"\"\n"
                .into()
        };
        body.push_str(&test);
    }
    // Nothing stayed changed: no undo point for it.
    body.push_str("if [ \"$DONE\" -gt 0 ]; then echo \"@@tune $T\"; else rm -rf \"$T\"; fi\n");
    Ok(body)
}

/// Shell helpers for applying (run as root). Every file touched is backed
/// up once into $T and listed in $T/manifest (for undo).
const APPLY_LIB: &str = r#"T=/root/.kemudi-tune/$(date +%Y%m%d-%H%M%S)
mkdir -p "$T" && chmod 700 /root/.kemudi-tune "$T"
M="$T/manifest"; : > "$M"
GROUPFILES=""
DONE=0
bk() {
  f=$1
  case " $GROUPFILES " in *" $f "*) ;; *) GROUPFILES="$GROUPFILES $f" ;; esac
  grep -qxF "file $f" "$M" && return 0
  echo "file $f" >> "$M"
  if [ -e "$f" ]; then c="$T/$(printf '%s' "$f" | tr / _)"; cp -p "$f" "$c" && echo "backup $f $c" >> "$M"; else echo "created $f" >> "$M"; fi
}
kre() { printf '%s' "$1" | sed 's/[.]/\\./g'; }
# key = value in an ini-style file: the active line, else a commented one, else added.
setini() {
  f=$1; k=$2; v=$3; IDS="$IDS $4"
  bk "$f"
  [ -e "$f" ] || : > "$f"
  r=$(kre "$k")
  if grep -qE "^[[:space:]]*$r[[:space:]]*=" "$f"; then
    sed -i -E "s|^[[:space:]]*$r[[:space:]]*=.*|$k = $v|" "$f"
  elif grep -qE "^[[:space:]]*;[[:space:]]*$r[[:space:]]*=" "$f"; then
    sed -i -E "0,/^[[:space:]]*;[[:space:]]*$r[[:space:]]*=.*/s||$k = $v|" "$f"
  else
    printf '%s = %s\n' "$k" "$v" >> "$f"
  fi
}
setmysql() {
  f=$1; k=$2; v=$3; IDS="$IDS $4"
  bk "$f"
  [ -s "$f" ] || printf '# Kemudi Devops (server tuning)\n[mysqld]\n' > "$f"
  setini "$f" "$k" "$v" ""
  M_Q="mysql"; mysql -e 'SELECT 1' >/dev/null 2>&1 || M_Q="mysql --defaults-file=/etc/mysql/debian.cnf"
  old=$($M_Q -NBe "SELECT @@$k" 2>/dev/null)
  [ -n "$old" ] && echo "mysql $k $old" >> "$M"
  case "$v" in *M) bytes=$(( ${v%M} * 1024 * 1024 )) ;; *G) bytes=$(( ${v%G} * 1024 * 1024 * 1024 )) ;; *) bytes=$v ;; esac
  if err=$($M_Q -NBe "SET GLOBAL $k = $bytes; SHOW WARNINGS" 2>&1); then
    case "$err" in
      *Truncated*|*"read only"*) echo "@@note $4 saved; it takes effect when MySQL is next restarted (it can't change it while running here)" ;;
      *)
        # The buffer pool is resized in the background: wait a little for it.
        i=0; while [ "$($M_Q -NBe "SELECT @@$k" 2>/dev/null)" != "$bytes" ] && [ $i -lt 10 ]; do sleep 1; i=$((i + 1)); done
        [ "$($M_Q -NBe "SELECT @@$k" 2>/dev/null)" = "$bytes" ] || echo "@@note $4 saved; MySQL is still resizing it in the background" ;;
    esac
  else echo "@@note $4 saved for the next start; live change refused: $(printf '%s' "$err" | tail -1)"; fi
}
# A directive in nginx.conf: the active line, else a commented one, else added to its block.
setngx() {
  c=$1; k=$2; v=$3; IDS="$IDS $4"; f=/etc/nginx/nginx.conf
  bk "$f"
  if grep -qE "^[[:space:]]*$k[[:space:]]" "$f"; then
    sed -i -E "0,/^([[:space:]]*)$k[[:space:]][^;]*;/s||\1$k $v;|" "$f"
  elif grep -qE "^[[:space:]]*#[[:space:]]*$k[[:space:]]" "$f"; then
    sed -i -E "0,/^([[:space:]]*)#[[:space:]]*$k[[:space:]][^;]*;.*/s||\1$k $v;|" "$f"
  elif [ "$c" = main ]; then
    sed -i "1i $k $v;" "$f"
  else
    sed -i -E "0,/^[[:space:]]*$c[[:space:]]*\{/s||&\n\t$k $v;|" "$f"
  fi
}
setsysctl() {
  k=$1; v=$2; IDS="$IDS $3"; f=/etc/sysctl.d/60-kemudi.conf
  bk "$f"
  echo "sysctl $k $(sysctl -n "$k" 2>/dev/null)" >> "$M"
  [ -e "$f" ] || printf '# Kemudi Devops (server tuning)\n' > "$f"
  setini "$f" "$k" "$v" ""
  sysctl -w "$k=$v" >/dev/null 2>&1 || echo "@@note $3 saved for the next boot; setting it now was refused"
}
mkswapfile() {
  mb=$1; IDS="$IDS $2"
  if [ -e /swapfile ]; then echo "@@fail $2 /swapfile already exists"; IDS=""; return; fi
  bk /etc/fstab
  { fallocate -l "${mb}M" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="$mb" status=none; } &&
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile &&
    echo "swapfile /swapfile" >> "$M" &&
    { grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab; } ||
    { swapoff /swapfile 2>/dev/null; rm -f /swapfile; echo "@@fail $2 couldn't make the swap file"; IDS=""; }
}
# Restore this group's files from their backups (or remove new ones).
rollback() {
  for f in $GROUPFILES; do
    b=$(grep -F "backup $f " "$M" | head -1 | cut -d' ' -f3)
    if [ -n "$b" ]; then cp -p "$b" "$f"; elif grep -qxF "created $f" "$M"; then rm -f "$f"; fi
  done
}
# Test; reload if it passes, roll back if it doesn't.
check() {
  if out=$(sh -c "$1" 2>&1); then
    if r=$(sh -c "$2" 2>&1); then for i in $IDS; do echo "@@done $i"; DONE=$((DONE + 1)); done
    else for i in $IDS; do echo "@@fail $i reload failed: $(printf '%s' "$r" | tail -1)"; done; fi
  else
    rollback
    for i in $IDS; do echo "@@fail $i rolled back: $(printf '%s' "$out" | grep -iE 'error|emerg|failed' | head -1)"; done
  fi
  GROUPFILES=""
}
"#;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub done: Vec<String>,
    /// id → why it failed (rolled back).
    pub failed: Vec<(String, String)>,
    pub notes: Vec<String>,
    /// Where the backups and manifest are on the server.
    pub dir: Option<String>,
}

/// Apply the picked suggestions (backed up; tested and rolled back per
/// group). Recorded in History.
#[tauri::command]
pub async fn tune_apply(
    state: State<'_, AppState>,
    server_id: String,
    changes: Vec<(String, Change)>,
) -> AppResult<ApplyResult> {
    let server = lookup(&state, &server_id)?;
    if changes.is_empty() || changes.len() > 100 {
        return Err(AppError::Invalid("nothing to apply".into()));
    }
    let body = apply_body(&changes)?;
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_for(
        &state,
        &server_id,
        &as_root(&body, password.as_deref()),
        300,
    )
    .await?;
    errors(&out)?;
    let mut r = ApplyResult::default();
    for l in out.lines() {
        if let Some(id) = l.strip_prefix("@@done ") {
            r.done.push(id.trim().to_string());
        } else if let Some(x) = l.strip_prefix("@@fail ") {
            let (id, why) = x.split_once(' ').unwrap_or((x, ""));
            r.failed.push((id.to_string(), why.to_string()));
        } else if let Some(n) = l.strip_prefix("@@note ") {
            r.notes.push(n.to_string());
        } else if let Some(d) = l.strip_prefix("@@tune ") {
            r.dir = Some(d.trim().to_string());
        }
    }
    record(
        &state,
        &server,
        "Tune server",
        &format!(
            "{} change(s): {}",
            changes.len(),
            changes
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        r.failed.is_empty(),
    );
    Ok(r)
}

const UNDO: &str = r#"T=$(ls -d /root/.kemudi-tune/2* 2>/dev/null | sort | tail -1)
[ -n "$T" ] && [ -f "$T/manifest" ] || { echo "@@err there's no tuning to undo"; exit 0; }
M="$T/manifest"
if grep -q '^swapfile ' "$M"; then swapoff /swapfile 2>/dev/null; rm -f /swapfile; fi
grep '^backup ' "$M" | while read -r _ f b; do cp -p "$b" "$f"; done
grep '^created ' "$M" | while read -r _ f; do rm -f "$f"; done
grep '^sysctl ' "$M" | while read -r _ k v; do [ -n "$v" ] && sysctl -w "$k=$v" >/dev/null; done
M_Q="mysql"; mysql -e 'SELECT 1' >/dev/null 2>&1 || M_Q="mysql --defaults-file=/etc/mysql/debian.cnf"
grep '^mysql ' "$M" | while read -r _ k v; do $M_Q -e "SET GLOBAL $k = $v" 2>/dev/null; done
for v in $(grep -oE '^file /etc/php/[0-9.]+/' "$M" | cut -d/ -f4 | sort -u); do
  if php-fpm$v -t >/dev/null 2>&1; then systemctl reload php$v-fpm && echo "@@reloaded php$v-fpm"; else echo "@@note php$v-fpm's config doesn't pass its test after undo"; fi
done
if grep -q '^file /etc/nginx/' "$M"; then
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx && echo "@@reloaded nginx"; else echo "@@note nginx's config doesn't pass its test after undo"; fi
fi
mv "$T" "${T%/*}/undone-${T##*/}"
echo "@@undone $T"
"#;

/// Put back everything the last tuning changed, and reload.
#[tauri::command]
pub async fn tune_undo(state: State<'_, AppState>, server_id: String) -> AppResult<Vec<String>> {
    let server = lookup(&state, &server_id)?;
    let password = saved_sudo(&server_id).await;
    let out = crate::monitor::run_for(&state, &server_id, &as_root(UNDO, password.as_deref()), 120)
        .await?;
    errors(&out)?;
    if !out.lines().any(|l| l.starts_with("@@undone ")) {
        return Err(AppError::Invalid("the undo didn't finish".into()));
    }
    record(
        &state,
        &server,
        "Undo server tuning",
        "restore the last tuning's backups",
        true,
    );
    Ok(out
        .lines()
        .filter_map(|l| {
            l.strip_prefix("@@reloaded ")
                .map(|x| format!("reloaded {x}"))
                .or_else(|| l.strip_prefix("@@note ").map(str::to_string))
        })
        .collect())
}

fn record(
    state: &AppState,
    server: &crate::config::schema::Server,
    label: &str,
    what: &str,
    ok: bool,
) {
    if let Ok(log) = state.audit.as_ref() {
        if let Ok(row) = log.start(&crate::audit::NewRun {
            server_id: &server.id,
            app_id: None,
            action_id: "tune",
            label,
            env: server.env.as_str(),
            kind: "edit",
            command: what,
            edited: false,
        }) {
            let _ = log.finish(row, Some(i32::from(!ok)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "@@hw\ncpus 4\nmem MemTotal: 8131792\nmem MemAvailable: 4807256\nmem SwapTotal: 4194300\nmem SwapFree: 4000000\nswappiness 60\nload 0.5 0.4 0.3\ndiskfree 59000000\n\
@@fpm 8.4\nmaster 123\nw 170000\nw 168000\nw 172000\npool /etc/php/8.4/fpm/pool.d/www.conf\n  [www]\n  pm = dynamic\n  pm.max_children = 5\n  pm.start_servers = 2\n  pm.min_spare_servers = 1\n  pm.max_spare_servers = 3\n\
ini memory_limit 128M\nini opcache.enable On\nini opcache.max_accelerated_files 10000\nini opcache.memory_consumption 128\nini opcache.interned_strings_buffer 8\nini opcache.validate_timestamps On\nwarnings 5\n\
@@fpm 8.1\nmaster 0\n\
@@mysql\nrss 796504\ncnfdir /etc/mysql/mysql.conf.d\nnologin\n\
@@nginx\nd 2 worker_processes auto\nd 7 worker_connections 768\nd 30 server_tokens off\nd 40 gzip on\nd 48 # gzip_types text/plain\nbodymax 40M\n\
@@apps\nfiles 21000 /opt/www/a\n";

    #[test]
    fn parses_and_suggests() {
        let f = parse_facts(SAMPLE);
        assert_eq!(f.cpus, 4);
        assert_eq!(f.fpm.len(), 2);
        assert!(f.fpm[0].running && !f.fpm[1].running);
        assert_eq!(f.fpm[0].pools[0].name, "www");
        assert_eq!(
            f.fpm[0].pools[0]
                .settings
                .get("pm.max_children")
                .map(String::as_str),
            Some("5")
        );
        assert_eq!(f.fpm[0].warnings, 5);
        assert!(f.mysql.as_ref().unwrap().no_login);
        assert_eq!(
            f.nginx.get("worker_connections").map(|x| x.1.as_str()),
            Some("768")
        );
        assert!(f.nginx.get("gzip_types").unwrap().2);
        assert_eq!(f.php_files, 21000);

        let t = suggest(&f);
        let get = |id: &str| t.suggestions.iter().find(|s| s.id.ends_with(id));
        let max = get(":max").expect("max_children");
        assert_eq!(max.level, "important");
        let n: u64 = max.suggested.parse().unwrap();
        assert!(n > 5 && n <= 200, "{n}");
        // Spares fit inside the new limit.
        let maxs: u64 = get(":pm.max_spare_servers")
            .unwrap()
            .suggested
            .parse()
            .unwrap();
        assert!(maxs < n);
        assert_eq!(
            get("opcache.max_accelerated_files").unwrap().suggested,
            "32531"
        );
        assert!(get("nginx:worker_connections").is_some());
        assert!(get("nginx:gzip_types").is_some());
        assert!(get("nginx:server_tokens").is_none());
        assert!(get("swap:file").is_none());
        assert_eq!(get("sysctl:swappiness").unwrap().suggested, "10");
        assert!(t.notes.iter().any(|n| n.contains("MySQL")));
        assert!(get("mysql:bp").is_none());
    }

    #[test]
    fn mysql_and_swap() {
        let mut f = parse_facts(SAMPLE);
        f.swap_total_kb = 0;
        f.mysql = Some(Mysql {
            rss_kb: 400 * MB,
            buffer_pool: Some(128 * 1024 * 1024),
            data_bytes: Some(2 * 1024 * 1024 * 1024),
            max_connections: Some(151),
            max_used: Some(140),
            cnf_dir: Some("/etc/mysql/mysql.conf.d".into()),
            ..Mysql::default()
        });
        let t = suggest(&f);
        let bp = t.suggestions.iter().find(|s| s.id == "mysql:bp").unwrap();
        assert_eq!(bp.level, "important");
        assert!(matches!(&bp.change, Some(Change::Mysql { value, .. }) if value == "2688M"));
        assert!(t
            .suggestions
            .iter()
            .any(|s| s.id == "mysql:maxconn" && s.suggested == "280"));
        assert!(t.suggestions.iter().any(|s| s.id == "swap:file"));
    }

    #[test]
    fn like_nst_stg3() {
        // 8 GB, 4 PHP versions (8.2 and 8.4 hit their limit), 58 GB of InnoDB data.
        let pool = |v: &str, max: &str| {
            format!("pool /etc/php/{v}/fpm/pool.d/www.conf\n  [www]\n  pm = dynamic\n  pm.max_children = {max}\n  pm.start_servers = 2\n  pm.min_spare_servers = 1\n  pm.max_spare_servers = 3\n  pm.max_requests = 500\n")
        };
        let mut out = String::from("@@hw\ncpus 4\nmem MemTotal: 8131792\nmem MemAvailable: 4807256\nmem SwapTotal: 4194300\nswappiness 60\n");
        for (v, max, w, kb, warn) in [
            ("8.1", "12", 4, 101582, 0),
            ("8.2", "5", 3, 121692, 2),
            ("8.3", "5", 3, 151856, 0),
            ("8.4", "5", 3, 169969, 5),
        ] {
            out.push_str(&format!("@@fpm {v}\nmaster 1\n"));
            for _ in 0..w {
                out.push_str(&format!("w {kb}\n"));
            }
            out.push_str(&pool(v, max));
            out.push_str(&format!("warnings {warn}\n"));
        }
        out.push_str("@@mysql\nrss 796504\ncnfdir /etc/mysql/mysql.conf.d\nq bp 134217728\nq maxconn 151\nq data 62277025792\nq Max_used_connections 20\n");
        let t = suggest(&parse_facts(&out));
        let max = |v: &str| {
            t.suggestions
                .iter()
                .find(|s| s.id == format!("fpm:{v}:/etc/php/{v}/fpm/pool.d/www.conf:max"))
                .map(|s| s.suggested.parse::<u64>().unwrap())
        };
        // Nothing lowered; the two that hit their limit get more.
        assert!(max("8.1").is_none_or(|n| n >= 12));
        assert!(max("8.2").unwrap() >= 8);
        assert!(max("8.4").unwrap() >= 8);
        assert!(!t.notes.iter().any(|n| n.contains("overcommitted")));
        // The buffer pool grows, but only into what PHP leaves.
        let bp = t.suggestions.iter().find(|s| s.id == "mysql:bp").unwrap();
        assert!(bp.why.contains("more RAM"), "{}", bp.why);
        assert!(
            t.budget.php_planned_kb + t.budget.mysql_kb + t.budget.reserve_kb + t.budget.others_kb
                <= t.budget.total_kb + 64 * MB
        );
    }

    #[test]
    fn apply_guards() {
        let bad = vec![(
            "x".to_string(),
            Change::Pool {
                version: "8.4".into(),
                file: "/etc/passwd".into(),
                key: "pm".into(),
                value: "x".into(),
            },
        )];
        assert!(apply_body(&bad).is_err());
        let bad = vec![(
            "x".to_string(),
            Change::Nginx {
                context: "http".into(),
                key: "x;y".into(),
                value: "1".into(),
            },
        )];
        assert!(apply_body(&bad).is_err());
        let ok = vec![
            (
                "a".to_string(),
                Change::Pool {
                    version: "8.4".into(),
                    file: "/etc/php/8.4/fpm/pool.d/www.conf".into(),
                    key: "pm.max_children".into(),
                    value: "20".into(),
                },
            ),
            (
                "b".to_string(),
                Change::PhpIni {
                    version: "8.4".into(),
                    key: "opcache.max_accelerated_files".into(),
                    value: "32531".into(),
                },
            ),
            (
                "c".to_string(),
                Change::Nginx {
                    context: "events".into(),
                    key: "worker_connections".into(),
                    value: "1024".into(),
                },
            ),
        ];
        let body = apply_body(&ok).unwrap();
        assert!(body.contains("check \"php-fpm8.4 -t\" \"systemctl reload php8.4-fpm\""));
        assert!(body.contains("/etc/php/8.4/fpm/conf.d/99-kemudi.ini"));
        assert!(body.contains("check \"nginx -t\""));
    }

    #[test]
    fn change_json() {
        let c = Change::Mysql {
            cnf_dir: "/etc/mysql/mysql.conf.d".into(),
            key: "k".into(),
            value: "1".into(),
        };
        let j = serde_json::to_string(&c).unwrap();
        assert_eq!(
            j,
            r#"{"kind":"mysql","cnfDir":"/etc/mysql/mysql.conf.d","key":"k","value":"1"}"#
        );
        let back: Change =
            serde_json::from_str(r#"{"kind":"phpIni","version":"8.4","key":"k","value":"1"}"#)
                .unwrap();
        assert!(matches!(back, Change::PhpIni { .. }));
    }

    #[test]
    fn sizes() {
        assert_eq!(size_kb("128M"), Some(128 * MB));
        assert_eq!(size_kb("1G"), Some(1024 * MB));
        assert_eq!(size_kb("-1"), None);
    }

    /// KEMUDI_TUNE_OUT=/tmp/x cargo test dump_tune -- --ignored
    #[test]
    #[ignore]
    fn dump_tune() {
        if let Ok(out) = std::env::var("KEMUDI_TUNE_OUT") {
            std::fs::write(&out, as_root(&analyze_body(&["/opt/www/app".into()]), None))
                .expect("write");
            let changes = vec![
                (
                    "fpm:max".to_string(),
                    Change::Pool {
                        version: "8.3".into(),
                        file: "/etc/php/8.3/fpm/pool.d/www.conf".into(),
                        key: "pm.max_children".into(),
                        value: "12".into(),
                    },
                ),
                (
                    "fpm:start".to_string(),
                    Change::Pool {
                        version: "8.3".into(),
                        file: "/etc/php/8.3/fpm/pool.d/www.conf".into(),
                        key: "pm.start_servers".into(),
                        value: "3".into(),
                    },
                ),
                (
                    "opc".to_string(),
                    Change::PhpIni {
                        version: "8.3".into(),
                        key: "opcache.max_accelerated_files".into(),
                        value: "32531".into(),
                    },
                ),
                (
                    "wc".to_string(),
                    Change::Nginx {
                        context: "events".into(),
                        key: "worker_connections".into(),
                        value: "1024".into(),
                    },
                ),
                (
                    "gz".to_string(),
                    Change::Nginx {
                        context: "http".into(),
                        key: "gzip_types".into(),
                        value: "text/css application/json".into(),
                    },
                ),
                (
                    "sw".to_string(),
                    Change::Sysctl {
                        key: "vm.swappiness".into(),
                        value: "10".into(),
                    },
                ),
            ];
            std::fs::write(
                format!("{out}.apply"),
                as_root(&apply_body(&changes).expect("ok"), None),
            )
            .expect("write");
            let bad = vec![(
                "bad".to_string(),
                Change::Pool {
                    version: "8.3".into(),
                    file: "/etc/php/8.3/fpm/pool.d/www.conf".into(),
                    key: "pm.max_children".into(),
                    value: "0".into(),
                },
            )];
            std::fs::write(
                format!("{out}.bad"),
                as_root(&apply_body(&bad).expect("ok"), None),
            )
            .expect("write");
            std::fs::write(format!("{out}.undo"), as_root(UNDO, None)).expect("write");
            let my = vec![(
                "mysql:bp".to_string(),
                Change::Mysql {
                    cnf_dir: "/etc/mysql/mariadb.conf.d".into(),
                    key: "innodb_buffer_pool_size".into(),
                    value: "256M".into(),
                },
            )];
            std::fs::write(
                format!("{out}.mysql"),
                as_root(&apply_body(&my).expect("ok"), None),
            )
            .expect("write");
        }
    }
}
