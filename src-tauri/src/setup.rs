//! Server setup: named profiles of what a server should have (timezone,
//! packages, PHP, SSH, firewall, fail2ban…). A read-only check per server
//! (or instance), and fixes that run as a workflow in a terminal tab, so
//! you watch them, answer prompts and re-run from a failed step. SSH
//! changes go in an order that can't lock you out: a key login first, the
//! new port opened before the old one closes, and each stage checked from
//! this Mac on a fresh connection.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::actions::render::shell_quote;
use crate::baseline::BaselineStatus;
use crate::config::schema::*;
use crate::error::{AppError, AppResult};
use crate::AppState;

// ------------------------------------------------------------- profiles

/// `child` over `parent`: what the child sets wins; lists replace.
pub fn merge(child: &Profile, parent: Profile) -> Profile {
    let c = child.clone();
    Profile {
        id: c.id,
        name: c.name.or(parent.name),
        extends: c.extends,
        timezone: c.timezone.or(parent.timezone),
        ntp: c.ntp.or(parent.ntp),
        updates: c.updates.or(parent.updates),
        unattended_upgrades: c.unattended_upgrades.or(parent.unattended_upgrades),
        packages: c.packages.or(parent.packages),
        php: c.php.or(parent.php),
        composer: c.composer.or(parent.composer),
        mysql_secure: c.mysql_secure.or(parent.mysql_secure),
        ssh: c.ssh.or(parent.ssh),
        firewall: c.firewall.or(parent.firewall),
        fail2ban: c.fail2ban.or(parent.fail2ban),
        auditd: c.auditd.or(parent.auditd),
        lynis: c.lynis.or(parent.lynis),
        folders: c.folders.or(parent.folders),
        users: c.users.or(parent.users),
        helpers: c.helpers.or(parent.helpers),
        custom: c.custom.or(parent.custom),
    }
}

fn word_ok(s: &str, extra: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

/// `1h`, `10m`, `3600` → seconds.
fn secs(s: &str) -> Option<u64> {
    let s = s.trim();
    let (n, unit) = match s.char_indices().last()? {
        (i, c) if c.is_ascii_alphabetic() => (&s[..i], c),
        _ => (s, 's'),
    };
    let n: u64 = n.parse().ok()?;
    let k = match unit {
        's' => 1,
        'm' => 60,
        'h' => 3600,
        'd' => 86400,
        'w' => 604800,
        _ => return None,
    };
    Some(n * k)
}

fn f2b(p: &Profile) -> Option<Fail2banSetup> {
    match &p.fail2ban {
        Some(Toggle::Flag(true)) => Some(Fail2banSetup::default()),
        Some(Toggle::Set(f)) => Some(f.clone()),
        _ => None,
    }
}

fn custom_id(c: &CustomCheck) -> String {
    c.id.clone().unwrap_or_else(|| {
        let s: String = c
            .name
            .to_lowercase()
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect();
        s.split('-').filter(|w| !w.is_empty()).collect::<Vec<_>>().join("-")
    })
}

/// What's wrong with a (merged) profile (empty: fine).
pub fn problems(p: &Profile) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(tz) = &p.timezone {
        if !word_ok(tz, "/_+-") {
            out.push(format!("timezone {tz:?} isn't a zone name (e.g. Asia/Kuala_Lumpur)"));
        }
    }
    for pkg in p.packages.iter().flatten() {
        if !word_ok(pkg, ".+-") || pkg.chars().any(|c| c.is_ascii_uppercase()) {
            out.push(format!("package {pkg:?} isn't an apt package name"));
        }
    }
    if let Some(php) = &p.php {
        let v = &php.version.0;
        let ok = v.split_once('.').is_some_and(|(a, b)| {
            !a.is_empty() && !b.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit())
        });
        if !ok {
            out.push(format!("php version {v:?}: use e.g. \"8.4\""));
        }
        for e in &php.extensions {
            if !word_ok(e, "_-") || e.chars().any(|c| c.is_ascii_uppercase()) {
                out.push(format!("php extension {e:?}: use the package suffix (fpm, mbstring…)"));
            }
        }
    }
    if let Some(port) = p.ssh.as_ref().and_then(|s| s.port) {
        if port == 0 {
            out.push("ssh port can't be 0".into());
        }
    }
    for r in p.firewall.iter().flat_map(|f| &f.allow) {
        if !word_ok(r.trim(), " /:_.-") {
            out.push(format!("firewall rule {r:?}: an app (\"Nginx Full\") or port (443/tcp)"));
        }
    }
    if let Some(f) = f2b(p) {
        for (what, v) in [("bantime", &f.bantime), ("findtime", &f.findtime)] {
            if v.as_deref().is_some_and(|v| secs(v).is_none()) {
                out.push(format!("fail2ban {what}: use e.g. 1h, 10m or seconds"));
            }
        }
    }
    let name_ok = |n: &str| {
        n.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c == '_')
            && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_-".contains(c))
            && n.len() <= 32
    };
    for f in p.folders.iter().flatten() {
        if !f.path.starts_with('/') || f.path.contains(char::is_whitespace) || f.path.contains("..") || f.path.contains(['\'', '"', '$', '`', '\\']) {
            out.push(format!("folder {:?} must be an absolute path without spaces", f.path));
        }
        if let Some(o) = &f.owner {
            let (u, g) = o.split_once(':').map_or((o.as_str(), None), |(u, g)| (u, Some(g)));
            if !name_ok(u) || g.is_some_and(|g| !name_ok(g)) {
                out.push(format!("folder {}: owner {o:?} isn't user or user:group", f.path));
            }
        }
        if let Some(m) = &f.mode {
            if !(3..=4).contains(&m.len()) || !m.chars().all(|c| ('0'..='7').contains(&c)) {
                out.push(format!("folder {}: mode {m:?} isn't octal (e.g. 775)", f.path));
            }
        }
    }
    for u in p.users.iter().flatten() {
        if !name_ok(&u.name) || u.name == "root" {
            out.push(format!("user {:?}: lower-case letters, digits, - _", u.name));
        }
    }
    let mut ids = std::collections::HashSet::new();
    for c in p.custom.iter().flatten() {
        let id = custom_id(c);
        if c.name.trim().is_empty() || c.check.trim().is_empty() {
            out.push("each custom check needs a name and a check".into());
        } else if !word_ok(&id, "_-.") {
            out.push(format!("custom check {:?}: give it an id (letters, digits, - _)", c.name));
        } else if !ids.insert(id.clone()) {
            out.push(format!("custom check id {id:?} is used twice"));
        }
    }
    out
}

// ---------------------------------------------------------------- items

/// One thing a profile wants: how to check it, how to fix it (as root).
struct Item {
    id: String,
    section: &'static str,
    title: String,
    /// What the profile wants, shown next to what was found.
    expected: Option<String>,
    /// Shell that ends in one `say <id> <state> <detail>` line.
    check: String,
    /// Shell run as root to fix it; None: nothing to run (or SSH, which
    /// has its own steps).
    fix: Option<String>,
    /// Where it goes in a plan (lower first).
    order: u16,
}

/// Put `vals` into a template: `__K__` → value.
fn fill(t: &str, vals: &[(&str, &str)]) -> String {
    let mut s = t.to_string();
    for (k, v) in vals {
        s = s.replace(&format!("__{k}__"), v);
    }
    s
}

const PREAMBLE: &str = r#"say(){ printf '@@i %s %s %s\n' "$1" "$2" "$3"; }
R(){ if [ "$(id -u)" = 0 ]; then sh -c "$1"; elif sudo -n true 2>/dev/null; then sudo -n sh -c "$1"; elif sudo -n su -c true 2>/dev/null; then sudo -n su -c "$1"; else return 99; fi; }
inst(){ dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'; }
active(){ systemctl is-active --quiet "$1" 2>/dev/null; }
has(){ case " $1 " in *" $2 "*) return 0;; esac; return 1; }
ROOT=no; R true >/dev/null 2>&1 && ROOT=yes
echo "@@root $ROOT"
echo "@@os $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")"
"#;

/// sshd's effective settings (`sshd -T`, needs root), once.
const SSHD_T: &str = r#"[ -n "$SSHT" ] || { SSHT=x; [ $ROOT = yes ] && SSHT=$(R 'sshd -T 2>/dev/null' 2>/dev/null); }"#;

/// Listening TCP ports (anyone can ask).
const LISTENING: &str = r#"LIS=$(ss -ltnH 2>/dev/null | awk '{n=split($4,a,":"); print a[n]}' | sort -un | tr '\n' ' ')"#;

/// For fixes: no questions from apt, wait for its lock (a fresh server is
/// often busy with its own first updates).
const FIX_PRE: &str = "set -e\nexport DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a\napt-get(){ command apt-get -o DPkg::Lock::Timeout=300 \"$@\"; }\n";

/// Restart sshd so it reads its config: Ubuntu 24.04 starts it from
/// ssh.socket, whose ports come from sshd_config at daemon-reload; if the
/// socket doesn't pick a port up, run sshd as a plain service instead.
const RESTART_SSH: &str = r#"listens(){ ss -ltnH | awk '{n=split($4,a,":"); print a[n]}' | grep -qx "$1"; }
restart_ssh(){
  if systemctl is-active --quiet ssh.socket; then
    systemctl daemon-reload; systemctl restart ssh.socket; sleep 1
    if ! listens "$1"; then echo "ssh.socket didn't pick up port $1: running sshd as a service instead"; systemctl disable --now ssh.socket; systemctl enable ssh.service; systemctl restart ssh.service; sleep 1; fi
  else systemctl restart ssh 2>/dev/null || systemctl restart sshd; sleep 1; fi
}
"#;

pub struct Ctx<'a> {
    pub baseline: Option<&'a Baseline>,
    /// The port Kemudi connects on now (from `ssh -G`).
    pub port_now: u16,
}

fn items(p: &Profile, ctx: &Ctx) -> Vec<Item> {
    let mut out = Vec::new();
    let mut add = |id: &str, section: &'static str, title: &str, expected: Option<String>, check: String, fix: Option<String>, order: u16| {
        out.push(Item { id: id.into(), section, title: title.into(), expected, check, fix, order })
    };

    if p.updates == Some(true) {
        add(
            "updates",
            "System",
            "Packages up to date",
            Some("no pending upgrades".into()),
            r#"n=$(apt list --upgradable 2>/dev/null | grep -c upgradable); sec=$(apt list --upgradable 2>/dev/null | grep -c -- '-security')
st=$(stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || stat -c %Y /var/cache/apt/pkgcache.bin 2>/dev/null || echo 0); age=$(( ($(date +%s) - st) / 86400 ))
rb=; [ -f /var/run/reboot-required ] && rb='; a reboot is needed'
if [ "$n" = 0 ] && [ -z "$rb" ]; then say updates ok "up to date (package lists ${age}d old)"; elif [ "$n" = 0 ]; then say updates warn "up to date$rb"; else say updates warn "$n to upgrade, $sec of them security (package lists ${age}d old)$rb"; fi"#
                .into(),
            Some("apt-get update\napt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade\n[ -f /var/run/reboot-required ] && echo 'A reboot is needed to finish (not done here).' || true".into()),
            10,
        );
    }
    if let Some(tz) = &p.timezone {
        let q = shell_quote(tz);
        add(
            "timezone",
            "System",
            "Timezone",
            Some(tz.clone()),
            fill(
                r#"tz=$(timedatectl show -p Timezone --value 2>/dev/null); [ -n "$tz" ] || tz=$(cat /etc/timezone 2>/dev/null)
if [ "$tz" = __TZ__ ]; then say timezone ok "$tz"; else say timezone bad "${tz:-unknown}"; fi"#,
                &[("TZ", &q)],
            ),
            Some(format!("timedatectl set-timezone {q}\ntimedatectl | grep -i 'time zone'")),
            20,
        );
    }
    if p.ntp == Some(true) {
        add(
            "ntp",
            "System",
            "Clock synchronised",
            Some("NTP on".into()),
            r#"n=$(timedatectl show -p NTP --value 2>/dev/null); s=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)
if [ "$n" = yes ] && [ "$s" = yes ]; then say ntp ok "on, synchronised"; elif [ "$n" = yes ]; then say ntp warn "on, not synchronised yet"; elif [ -z "$n" ]; then say ntp unknown "no timedatectl"; else say ntp bad "off"; fi"#
                .into(),
            Some("timedatectl set-ntp true 2>/dev/null || { apt-get install -y systemd-timesyncd && timedatectl set-ntp true; }\ntimedatectl show -p NTP --value".into()),
            20,
        );
    }
    if let Some(pkgs) = p.packages.as_ref().filter(|p| !p.is_empty()) {
        let list = pkgs.join(" ");
        add(
            "packages",
            "Packages",
            "Packages installed",
            Some(list.clone()),
            fill(
                r#"m=; c=0; for p in __P__; do c=$((c+1)); inst "$p" || m="$m $p"; done
if [ -z "$m" ]; then say packages ok "all $c installed"; else say packages bad "missing:$m"; fi"#,
                &[("P", &list)],
            ),
            Some(format!("apt-get update\napt-get install -y {list}")),
            30,
        );
    }
    if let Some(php) = &p.php {
        let v = php.version.0.clone();
        let exts = php.extensions.join(" ");
        let fpm = php.extensions.iter().any(|e| e == "fpm");
        add(
            "php",
            "PHP",
            &format!("PHP {v}"),
            Some(if exts.is_empty() { format!("php{v}") } else { format!("php{v} with {exts}") }),
            fill(
                r#"v=__V__
if ! command -v php$v >/dev/null 2>&1; then say php bad "PHP $v isn't installed"; else
  m=; na=; for e in __E__; do inst "php$v-$e" && continue; if apt-cache show "php$v-$e" >/dev/null 2>&1; then m="$m $e"; else na="$na $e"; fi; done
  d="PHP $(php$v -r 'echo PHP_VERSION;' 2>/dev/null)"; [ -n "$m" ] && d="$d · missing:$m"; [ -n "$na" ] && d="$d · not in apt:$na"
  w=; if __FPM__ && ! active php$v-fpm; then d="$d · php$v-fpm isn't running"; w=1; fi
  if [ -n "$m$na" ]; then say php bad "$d"; elif [ -n "$w" ]; then say php warn "$d"; else say php ok "$d"; fi
fi"#,
                &[("V", &v), ("E", &exts), ("FPM", if fpm { "true" } else { "false" })],
            ),
            Some(fill(
                r#"__PPA__apt-get update
ok=; miss=; for p in php__V__ __PKGS__; do if apt-cache show "$p" >/dev/null 2>&1; then ok="$ok $p"; else miss="$miss $p"; fi; done
apt-get install -y $ok
__FPMUP__[ -z "$miss" ] || { echo "Not available from apt:$miss"; exit 1; }
php__V__ -v"#,
                &[
                    ("V", &v),
                    ("PKGS", &php.extensions.iter().map(|e| format!("php{v}-{e}")).collect::<Vec<_>>().join(" ")),
                    (
                        "PPA",
                        if php.ppa != Some(false) {
                            ". /etc/os-release; [ \"$ID\" = ubuntu ] || { echo \"ppa:ondrej/php is for Ubuntu (this is $PRETTY_NAME)\"; exit 1; }\ncommand -v add-apt-repository >/dev/null || { apt-get update; apt-get install -y software-properties-common; }\ngrep -rqs ondrej/php /etc/apt/sources.list /etc/apt/sources.list.d/ || add-apt-repository -y ppa:ondrej/php\n"
                        } else {
                            ""
                        },
                    ),
                    ("FPMUP", &if fpm { format!("systemctl enable --now php{v}-fpm\n") } else { String::new() }),
                ],
            )),
            40,
        );
        if php.default != Some(false) {
            add(
                "php-default",
                "PHP",
                "Default php command",
                Some(format!("php → php{v}")),
                fill(
                    r#"d=$(readlink -f "$(command -v php)" 2>/dev/null)
case "$d" in */php__V__) say php-default ok "php → php__V__";; "") say php-default bad "no php command";; *) say php-default bad "php → ${d##*/}";; esac"#,
                    &[("V", &v)],
                ),
                Some(format!("update-alternatives --set php /usr/bin/php{v}\nphp -v")),
                41,
            );
        }
    }
    if p.composer == Some(true) {
        add(
            "composer",
            "PHP",
            "Composer",
            Some("in /usr/local/bin".into()),
            r#"if command -v composer >/dev/null 2>&1; then say composer ok "$(COMPOSER_ALLOW_SUPERUSER=1 composer --version 2>/dev/null | head -n1)"; else say composer bad "not installed"; fi"#.into(),
            Some(r#"cd /tmp
expected=$(php -r 'copy("https://composer.github.io/installer.sig", "php://stdout");')
php -r 'copy("https://getcomposer.org/installer", "composer-setup.php");'
actual=$(php -r 'echo hash_file("sha384", "composer-setup.php");')
if [ "$expected" != "$actual" ]; then rm -f composer-setup.php; echo "The Composer installer's checksum doesn't match: not installed"; exit 1; fi
php composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer
rm -f composer-setup.php
COMPOSER_ALLOW_SUPERUSER=1 composer --version"#.into()),
            42,
        );
    }
    if p.mysql_secure == Some(true) {
        add(
            "mysql-secure",
            "Database",
            "MySQL locked down",
            Some("no anonymous users, no remote root, no test database".into()),
            r#"if ! command -v mysql >/dev/null 2>&1; then say mysql-secure bad "mysql isn't installed"
elif [ $ROOT = no ]; then say mysql-secure unknown "needs root"
else
  a=$(R "mysql -NBe \"SELECT COUNT(*) FROM mysql.user WHERE User=''\"" 2>/dev/null) || a=x
  if [ "$a" = x ] || [ -z "$a" ]; then say mysql-secure unknown "can't sign in to MySQL as root over its socket"
  else
    r=$(R "mysql -NBe \"SELECT COUNT(*) FROM mysql.user WHERE User='root' AND Host NOT IN ('localhost','127.0.0.1','::1')\"" 2>/dev/null)
    t=$(R "mysql -NBe \"SHOW DATABASES LIKE 'test'\"" 2>/dev/null)
    d=; [ "$a" != 0 ] && d="$d $a anonymous user(s);"; [ "${r:-0}" != 0 ] && d="$d root can sign in from elsewhere;"; [ -n "$t" ] && d="$d a test database;"
    if [ -z "$d" ]; then say mysql-secure ok "no anonymous users, no remote root, no test database"; else say mysql-secure bad "${d# }"; fi
  fi
fi"#
                .into(),
            Some(r#"mysql <<'SQL'
DELETE FROM mysql.user WHERE User='';
DELETE FROM mysql.user WHERE User='root' AND Host NOT IN ('localhost','127.0.0.1','::1');
DROP DATABASE IF EXISTS test;
DELETE FROM mysql.db WHERE Db='test' OR Db='test\_%';
FLUSH PRIVILEGES;
SQL
echo "MySQL: anonymous users, remote root and the test database removed""#.into()),
            45,
        );
    }
    for f in p.folders.iter().flatten() {
        let id = format!("folder:{}", f.path);
        let q = shell_quote(&f.path);
        let mode = f.mode.as_deref().map(|m| m.trim_start_matches('0').to_string()).filter(|m| !m.is_empty());
        let owner_check = match f.owner.as_deref() {
            Some(o) if o.contains(':') => format!("[ \"$o\" = {} ] || ok=0", shell_quote(o)),
            Some(o) => format!("case \"$o\" in {}:*) ;; *) ok=0;; esac", shell_quote(o)),
            None => String::new(),
        };
        let mode_check = mode.as_ref().map(|m| format!("[ \"$m\" = {m} ] || ok=0")).unwrap_or_default();
        let expected = [f.owner.clone(), mode.clone()].into_iter().flatten().collect::<Vec<_>>().join(" ");
        let mut fix = format!("mkdir -p {q}\n");
        if let Some(o) = &f.owner {
            fix.push_str(&format!("chown {} {q}\n", shell_quote(o)));
        }
        if let Some(m) = &mode {
            fix.push_str(&format!("chmod {m} {q}\n"));
        }
        fix.push_str(&format!("ls -ld {q}"));
        add(
            &id,
            "Folders",
            &f.path,
            Some(if expected.is_empty() { "exists".into() } else { expected }),
            fill(
                r#"p=__P__
l=; [ -L "$p" ] && l=" (link to $(readlink -f "$p"))"
if [ ! -d "$p" ]; then say __ID__ bad "missing"; else o=$(stat -L -c '%U:%G' "$p"); m=$(stat -L -c '%a' "$p"); ok=1; __OC__; __MC__; if [ $ok = 1 ]; then say __ID__ ok "$o $m$l"; else say __ID__ bad "$o $m$l"; fi; fi"#,
                &[("P", &q), ("ID", &id), ("OC", if owner_check.is_empty() { ":" } else { &owner_check }), ("MC", if mode_check.is_empty() { ":" } else { &mode_check })],
            ),
            Some(fix),
            50,
        );
    }
    for u in p.users.iter().flatten() {
        let id = format!("user:{}", u.name);
        let n = &u.name;
        let sudo = u.sudo == Some(true);
        let pw = u.password == Some(true);
        let mut want = vec!["exists".to_string()];
        if sudo {
            want.push("in sudo".into());
        }
        if pw {
            want.push("has a password".into());
        }
        let mut fix = format!("id -u {n} >/dev/null 2>&1 || {{ useradd -m -s /bin/bash {n}; echo 'added user {n}'; }}\n");
        if sudo {
            fix.push_str(&format!("usermod -aG sudo {n}\n"));
        }
        if pw {
            fix.push_str(&format!("case \"$(passwd -S {n} | awk '{{print $2}}')\" in L|NP) echo 'Set a password for {n}:'; passwd {n};; *) echo '{n} has a password';; esac\n"));
        }
        fix.push_str(&format!("id {n}"));
        add(
            &id,
            "Users",
            n,
            Some(want.join(", ")),
            fill(
                r#"u=__N__
if ! id -u "$u" >/dev/null 2>&1; then say __ID__ bad "no such user"; else g=$(id -nG "$u"); d="groups: $g"; ok=1
  if __SUDO__ && ! has "$g" sudo; then ok=0; d="not in sudo ($d)"; fi
  if __PW__; then if [ $ROOT = yes ]; then ps=$(R "passwd -S $u" 2>/dev/null | awk '{print $2}'); case "$ps" in L|NP) ok=0; d="$d; no password";; esac; else d="$d; password: needs root to see"; fi; fi
  if [ $ok = 1 ]; then say __ID__ ok "$d"; else say __ID__ bad "$d"; fi
fi"#,
                &[("N", n), ("ID", &id), ("SUDO", if sudo { "true" } else { "false" }), ("PW", if pw { "true" } else { "false" })],
            ),
            Some(fix),
            51,
        );
    }
    if p.unattended_upgrades == Some(true) {
        add(
            "unattended-upgrades",
            "Security",
            "Automatic security updates",
            Some("unattended-upgrades on".into()),
            r#"if ! inst unattended-upgrades; then say unattended-upgrades bad "not installed"; elif grep -qsE 'Unattended-Upgrade[[:space:]]+"1"' /etc/apt/apt.conf.d/20auto-upgrades; then say unattended-upgrades ok "on"; else say unattended-upgrades bad "installed, not switched on"; fi"#.into(),
            Some("apt-get install -y unattended-upgrades\nprintf 'APT::Periodic::Update-Package-Lists \"1\";\\nAPT::Periodic::Unattended-Upgrade \"1\";\\n' > /etc/apt/apt.conf.d/20auto-upgrades\nsystemctl enable --now unattended-upgrades\ncat /etc/apt/apt.conf.d/20auto-upgrades".into()),
            60,
        );
    }
    if let Some(f) = f2b(p) {
        let maxretry = f.maxretry.unwrap_or(3);
        let bantime = f.bantime.clone().unwrap_or_else(|| "1h".into());
        let findtime = f.findtime.clone().unwrap_or_else(|| "10m".into());
        let (bt, ft) = (secs(&bantime).unwrap_or(3600), secs(&findtime).unwrap_or(600));
        let port = p.ssh.as_ref().and_then(|s| s.port).unwrap_or(ctx.port_now);
        let port = if port == 22 { "ssh".to_string() } else { port.to_string() };
        add(
            "fail2ban",
            "Security",
            "fail2ban guards SSH",
            Some(format!("{maxretry} tries in {findtime} → banned {bantime}")),
            fill(
                r#"if ! inst fail2ban; then say fail2ban bad "not installed"
elif ! active fail2ban; then say fail2ban bad "installed, not running"
elif [ $ROOT = no ]; then say fail2ban unknown "running (its jails need root to read)"
elif ! R 'fail2ban-client status sshd' >/dev/null 2>&1; then say fail2ban bad "running, no sshd jail"
else mr=$(R 'fail2ban-client get sshd maxretry' | tr -dc 0-9); bt=$(R 'fail2ban-client get sshd bantime' | tr -dc 0-9); ft=$(R 'fail2ban-client get sshd findtime' | tr -dc 0-9)
  d="sshd jail: $mr tries in ${ft}s → banned ${bt}s"
  if [ "$mr" = __MR__ ] && [ "$bt" = __BT__ ] && [ "$ft" = __FT__ ]; then say fail2ban ok "$d"; else say fail2ban warn "$d"; fi
fi"#,
                &[("MR", &maxretry.to_string()), ("BT", &bt.to_string()), ("FT", &ft.to_string())],
            ),
            Some(format!(
                "apt-get install -y fail2ban python3-systemd\ncat > /etc/fail2ban/jail.d/kemudi-sshd.local <<'EOF'\n[sshd]\nenabled = true\nport = {port}\nbackend = systemd\nmaxretry = {maxretry}\nfindtime = {findtime}\nbantime = {bantime}\nEOF\nsystemctl enable fail2ban\nsystemctl restart fail2ban\nsleep 2\nfail2ban-client status sshd"
            )),
            62,
        );
    }
    if p.auditd == Some(true) {
        add(
            "auditd",
            "Security",
            "auditd (audit log)",
            Some("installed, running".into()),
            r#"if ! inst auditd; then say auditd bad "not installed"; elif active auditd; then say auditd ok "running"; else say auditd bad "installed, not running"; fi"#.into(),
            Some("apt-get install -y auditd\nsystemctl enable --now auditd\nsystemctl is-active auditd".into()),
            63,
        );
    }
    if p.lynis == Some(true) {
        add(
            "lynis",
            "Security",
            "Lynis (security audit)",
            Some("installed".into()),
            r#"if ! command -v lynis >/dev/null 2>&1; then say lynis bad "not installed"
else d="installed"; if [ $ROOT = yes ]; then r=$(R 'cat /var/log/lynis-report.dat' 2>/dev/null); hi=$(printf '%s\n' "$r" | sed -n 's/^hardening_index=//p' | tail -n1); at=$(printf '%s\n' "$r" | sed -n 's/^report_datetime_end=//p' | tail -n1 | cut -c1-10); [ -n "$hi" ] && d="hardening index $hi (audit of $at)" || d="installed, never run"; fi; say lynis ok "$d"; fi"#.into(),
            Some("apt-get install -y lynis\nlynis --version".into()),
            64,
        );
    }
    if let Some(b) = ctx.baseline.filter(|_| p.helpers != Some(false)) {
        add(
            "helpers",
            "Helpers",
            "Helpers (repos, ~/.bashrc)",
            Some(b.repos.iter().map(|r| r.name.as_str()).chain(b.bashrc.iter().map(|_| "~/.bashrc lines")).collect::<Vec<_>>().join(", ")),
            // Answered by the baseline's own check (appended to the script).
            String::new(),
            Some(crate::baseline::install_script(b)),
            70,
        );
    }
    for c in p.custom.iter().flatten() {
        let id = format!("custom:{}", custom_id(c));
        let run = if c.root == Some(true) {
            format!("R {} 2>&1", shell_quote(&c.check))
        } else {
            format!("( {}\n) 2>&1", c.check)
        };
        add(
            &id,
            "Custom",
            &c.name,
            None,
            fill(
                r#"out=$( __RUN__ ); r=$?; l=$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | head -n1)
if [ $r = 0 ]; then say __ID__ ok "${l:-ok}"; elif [ $r = 99 ] && [ $ROOT = no ]; then say __ID__ unknown "needs root"; else say __ID__ bad "${l:-exit $r}"; fi"#,
                &[("RUN", &run), ("ID", &id)],
            ),
            c.fix.clone(),
            80,
        );
    }
    if let Some(fw) = &p.firewall {
        let port = p.ssh.as_ref().and_then(|s| s.port).unwrap_or(ctx.port_now);
        let rules: Vec<String> = fw.allow.iter().map(|r| r.trim().to_string()).collect();
        let ssh_pat = if port == 22 { "^(22(/tcp)?|OpenSSH)[[:space:]]".to_string() } else { format!("^{port}(/tcp)?[[:space:]]") };
        let mut fix = String::from("command -v ufw >/dev/null || apt-get install -y ufw\nufw default deny incoming\nufw default allow outgoing\n");
        fix.push_str(&format!("ufw allow {}/tcp   # the SSH port Kemudi is on now\n", ctx.port_now));
        if port != ctx.port_now {
            fix.push_str(&format!("ufw allow {port}/tcp   # the SSH port to move to\n"));
        }
        for r in &rules {
            fix.push_str(&format!("ufw allow {}\n", shell_quote(r)));
        }
        fix.push_str("ufw --force enable\nufw status verbose");
        add(
            "firewall",
            "Firewall",
            "Firewall (ufw)",
            Some(format!("on, deny incoming; allow SSH {port}{}", rules.iter().map(|r| format!(", {r}")).collect::<String>())),
            fill(
                r#"if ! command -v ufw >/dev/null 2>&1; then say firewall bad "ufw isn't installed"
elif [ $ROOT = no ]; then if grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then say firewall unknown "on (its rules need root to read)"; else say firewall bad "off"; fi
else st=$(R 'ufw status verbose' 2>/dev/null)
  case "$st" in *"Status: active"*)
    allowed(){ printf '%s\n' "$st" | awk -v r="$1" 'index($0, r" ")==1 && / ALLOW IN / {f=1} END {exit !f}'; }
    m=; printf '%s\n' "$st" | grep -qE '__SSH__' || m="$m, SSH __PORT__"
    __RULES__
    case "$st" in *"deny (incoming)"*) ;; *) m="$m, deny incoming by default";; esac
    if [ -z "$m" ]; then say firewall ok "on"; else say firewall bad "on, but not allowed:${m#,}"; fi;;
  *) say firewall bad "off";;
  esac
fi"#,
                &[("SSH", &ssh_pat), ("PORT", &port.to_string()), ("RULES", &rules.iter().map(|r| rule_check(r)).collect::<Vec<_>>().join("\n    "))],
            ),
            Some(fix),
            90,
        );
    }
    if let Some(ssh) = &p.ssh {
        if let Some(port) = ssh.port {
            add(
                "ssh-port",
                "SSH",
                "SSH port",
                Some(port.to_string()),
                fill(
                    &format!(
                        r#"{SSHD_T}; {LISTENING}
cfg=; [ "$SSHT" != x ] && cfg=$(printf '%s\n' "$SSHT" | awk '$1=="port"{{print $2}}' | sort -un | tr '\n' ' ')
how=; [ -n "$cfg" ] || {{ how=' (from the files: sshd itself needs root to ask)'; cfg=$(cat /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | awk 'tolower($1)=="port"{{print $2}}' | sort -un | tr '\n' ' '); }}
[ -n "$cfg" ] || cfg='22 '
sock=; active ssh.socket && sock=' via ssh.socket'
if [ "$cfg" = "__P__ " ] && has "$LIS" __P__; then say ssh-port ok "__P__$sock"
elif [ "$cfg" = "__P__ " ]; then say ssh-port bad "set to __P__ but not listening on it$sock (sshd needs a restart)"
else say ssh-port bad "port ${{cfg% }}$sock$how"; fi"#
                    ),
                    &[("P", &port.to_string())],
                ),
                None,
                100,
            );
        }
        if ssh.password_auth == Some(false) {
            add(
                "ssh-passwords",
                "SSH",
                "SSH: keys only",
                Some("password logins off".into()),
                format!(
                    r#"{SSHD_T}
pa=; kb=; how=
if [ "$SSHT" != x ]; then pa=$(printf '%s\n' "$SSHT" | awk '$1=="passwordauthentication"{{print $2}}'); kb=$(printf '%s\n' "$SSHT" | awk '$1=="kbdinteractiveauthentication"{{print $2}}'); fi
if [ -z "$pa" ]; then how=' (from the files: sshd itself needs root to ask)'; pa=$(cat /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | awk 'tolower($1)=="passwordauthentication"{{print tolower($2); exit}}'); [ -n "$pa" ] || pa=yes; fi
src=$(grep -lisE '^[[:space:]]*PasswordAuthentication[[:space:]]+yes' /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | head -n1)
if [ "$pa" = no ] && [ "$kb" != yes ]; then say ssh-passwords ok "password logins off$how"
elif [ "$pa" = no ]; then say ssh-passwords bad "keyboard-interactive logins on (they can ask for a password)$how"
else say ssh-passwords bad "password logins on${{src:+ (set in $src)}}$how"; fi"#
                ),
                None,
                101,
            );
        }
    }
    out
}

/// Shell that adds `rule` to `$m` unless ufw allows it: an nginx app
/// profile also counts as allowed when its ports are (80/tcp, 443/tcp).
fn rule_check(rule: &str) -> String {
    let ports: &[&str] = match rule {
        "Nginx Full" => &["80/tcp", "443/tcp"],
        "Nginx HTTP" => &["80/tcp"],
        "Nginx HTTPS" => &["443/tcp"],
        "OpenSSH" => &["22/tcp"],
        _ => &[],
    };
    let q = shell_quote(rule);
    if ports.is_empty() {
        format!("allowed {q} || m=\"$m, \"{q}")
    } else {
        let alt = ports.iter().map(|p| format!("allowed {p}")).collect::<Vec<_>>().join(" && ");
        format!("allowed {q} || {{ {alt}; }} || m=\"$m, \"{q}")
    }
}

// ---------------------------------------------------------------- check

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemStatus {
    pub id: String,
    pub section: String,
    pub title: String,
    pub expected: Option<String>,
    /// ok, warn, bad, unknown.
    pub state: String,
    pub detail: String,
    /// Kemudi can fix it (as a workflow).
    pub fixable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub profile: String,
    pub os: Option<String>,
    /// The check could read root-only settings (root, or sudo without a
    /// password).
    pub root: bool,
    pub items: Vec<ItemStatus>,
    /// The helpers part, in detail (as the Health tab shows it).
    pub helpers: Option<BaselineStatus>,
    /// The port Kemudi connects on (from `ssh -G`).
    pub port_now: u16,
}

pub fn check_script(p: &Profile, ctx: &Ctx) -> String {
    let mut s = String::from(PREAMBLE);
    for it in items(p, ctx) {
        if it.check.is_empty() {
            continue;
        }
        s.push_str("(\n");
        s.push_str(&it.check);
        s.push_str("\n)\n");
    }
    s.push_str("echo @@done\n");
    if let Some(b) = ctx.baseline.filter(|_| p.helpers != Some(false)) {
        s.push_str(&crate::baseline::check_script(b));
    }
    s
}

pub fn parse(p: &Profile, ctx: &Ctx, out: &str) -> Result<SetupStatus, String> {
    if !out.lines().any(|l| l.trim_end() == "@@done") {
        return Err("the check didn't finish".into());
    }
    let mut found: std::collections::HashMap<String, (String, String)> = Default::default();
    let (mut os, mut root) = (None, false);
    for raw in out.lines() {
        let line = raw.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("@@i ") {
            let mut w = rest.splitn(3, ' ');
            if let (Some(id), Some(state)) = (w.next(), w.next()) {
                found.insert(id.to_string(), (state.to_string(), w.next().unwrap_or("").trim().to_string()));
            }
        } else if let Some(o) = line.strip_prefix("@@os ") {
            os = Some(o.trim().to_string()).filter(|o| !o.is_empty() && o != "unknown");
        } else if let Some(r) = line.strip_prefix("@@root ") {
            root = r.trim() == "yes";
        }
    }
    let helpers = match ctx.baseline.filter(|_| p.helpers != Some(false)) {
        Some(b) => crate::baseline::parse(b, out).ok(),
        None => None,
    };
    let items = items(p, ctx)
        .into_iter()
        .map(|it| {
            let (state, detail) = if it.id == "helpers" {
                match &helpers {
                    Some(h) => helpers_summary(h),
                    None => ("unknown".into(), "the check didn't answer".into()),
                }
            } else {
                found.remove(&it.id).unwrap_or_else(|| ("unknown".into(), "no answer".into()))
            };
            let fixable = matches!(state.as_str(), "bad" | "warn") && (it.fix.is_some() || it.id.starts_with("ssh-"));
            ItemStatus { id: it.id, section: it.section.into(), title: it.title, expected: it.expected, state, detail, fixable }
        })
        .collect();
    Ok(SetupStatus { profile: p.id.clone(), os, root, items, helpers, port_now: ctx.port_now })
}

fn helpers_summary(h: &BaselineStatus) -> (String, String) {
    let missing: Vec<&str> = h.repos.iter().filter(|r| matches!(r.state.as_str(), "missing" | "notgit")).map(|r| r.name.as_str()).collect();
    let behind: Vec<&str> = h.repos.iter().filter(|r| r.state == "behind").map(|r| r.name.as_str()).collect();
    let lines_missing = h.lines.iter().filter(|l| l.present == Some(false) && l.other.is_none()).count();
    let differ = h.lines.iter().filter(|l| l.other.is_some() || l.count > 1).count();
    let mut parts = Vec::new();
    if !missing.is_empty() {
        parts.push(format!("missing: {}", missing.join(", ")));
    }
    if lines_missing > 0 {
        parts.push(format!("{lines_missing} ~/.bashrc line(s) missing"));
    }
    if !behind.is_empty() {
        parts.push(format!("update available: {}", behind.join(", ")));
    }
    if differ > 0 {
        parts.push(format!("{differ} alias(es) differ (kept)"));
    }
    if !h.complete {
        ("bad".into(), parts.join(" · "))
    } else if !behind.is_empty() || differ > 0 {
        ("warn".into(), parts.join(" · "))
    } else {
        ("ok".into(), "all there, up to date".into())
    }
}

// ----------------------------------------------------------------- plan

/// Workflows made here (not in servers.yaml), so the Workflows tab, its
/// re-run from a failed step and the run dialog find them by id.
static ADHOC: Mutex<Vec<Workflow>> = Mutex::new(Vec::new());

pub(crate) fn adhoc() -> Vec<Workflow> {
    ADHOC.lock().map(|l| l.clone()).unwrap_or_default()
}

fn remember(wf: Workflow) {
    if let Ok(mut l) = ADHOC.lock() {
        l.retain(|w| w.id != wf.id);
        l.push(wf);
        let extra = l.len().saturating_sub(30);
        l.drain(..extra);
    }
}

fn server_step(server: &str, label: String, run: String) -> Step {
    Step { label: Some(label), kind: StepKind::Server { server: server.into(), run, root: true, dir: None } }
}

fn local_step(label: String, run: String) -> Step {
    Step { label: Some(label), kind: StepKind::Local { run, dir: None } }
}

/// `ssh` from this Mac on a fresh connection (never the shared one, which
/// would still be on the old port), without the config's RemoteCommand.
fn fresh_ssh(host: &str, port: u16, extra: &str) -> String {
    format!(
        "ssh -o BatchMode=yes -o ControlMaster=no -o ControlPath=none -o RemoteCommand=none -o RequestTTY=no -o ConnectTimeout=15 {extra}-p {port} {} true",
        shell_quote(host)
    )
}

/// sshd_config.d/00-kemudi.conf (read before the other files, so its
/// settings win) with `lines`; Port lines anywhere else commented out
/// (sshd adds every Port up). Backed up first and put back if `sshd -t`
/// doesn't like the result.
fn sshd_write(lines: &str, keep_other_ports: bool) -> String {
    let ports = if keep_other_ports {
        // The Port lines already in our file stay.
        r#"pl=$(grep -iE '^[[:space:]]*Port[[:space:]]' "$f" 2>/dev/null || true)
"#
        .to_string()
    } else {
        r#"for x in /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf; do
  [ -f "$x" ] && [ "$x" != "$f" ] && grep -qiE '^[[:space:]]*Port[[:space:]]' "$x" || continue
  cp -p "$x" "$x.kemudi-backup-$ts"; bk="$bk $x"
  sed -i -E 's/^[[:space:]]*[Pp][Oo][Rr][Tt][[:space:]]/# (kemudi) &/' "$x"; echo "commented out Port in $x (backup: $x.kemudi-backup-$ts)"
done
"#
        .to_string()
    };
    format!(
        r#"ts=$(date +%Y%m%d-%H%M%S); f=/etc/ssh/sshd_config.d/00-kemudi.conf; bk=; pl=
mkdir -p /etc/ssh/sshd_config.d
grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d' /etc/ssh/sshd_config || {{ echo "sshd_config doesn't include sshd_config.d: not changed"; exit 1; }}
{ports}if [ -f "$f" ]; then cp -p "$f" "$f.kemudi-backup-$ts"; bk="$bk $f"; fi
printf '%s\n' '# Kemudi server setup' ${{pl:+"$pl"}} {lines} > "$f.new" && mv "$f.new" "$f"
echo "--- $f"; cat "$f"
if ! sshd -t; then
  echo "sshd doesn't accept it: putting the files back"
  for x in $bk; do cp -p "$x.kemudi-backup-$ts" "$x"; done
  case " $bk " in *" $f "*) ;; *) rm -f "$f";; esac
  exit 1
fi
"#
    )
}

fn quoted_lines(lines: &[String]) -> String {
    lines.iter().map(|l| shell_quote(l)).collect::<Vec<_>>().join(" ")
}

/// The steps that fix `ids` on `server`, in a safe order.
pub fn plan(server: &Server, p: &Profile, ctx: &Ctx, ids: &[String]) -> Result<Workflow, String> {
    if server.asg.is_some() {
        return Err(format!("{} is an AWS Auto Scaling group: set up its image instead (checking works)", server.name));
    }
    let mut chosen: Vec<Item> = items(p, ctx).into_iter().filter(|i| ids.contains(&i.id)).collect();
    let lynis_audit = ids.iter().any(|i| i == "lynis-audit");
    if chosen.is_empty() && !lynis_audit {
        return Err("nothing to fix".into());
    }
    chosen.sort_by_key(|i| i.order);
    let host = server.host.as_str();
    let now = ctx.port_now;
    let want_port = chosen.iter().any(|i| i.id == "ssh-port");
    let want_keys = chosen.iter().any(|i| i.id == "ssh-passwords");
    let target = p.ssh.as_ref().and_then(|s| s.port).unwrap_or(now);
    let moving = want_port && target != now;
    let mut steps = Vec::new();
    if want_port || want_keys {
        steps.push(local_step(
            "Check: you can sign in with a key".into(),
            format!(
                "{} && echo '✓ signed in with a key' || {{ echo '✗ No key login to {host}: put your key on it first (the server ▸ Details ▸ Use a key), or SSH changes could lock you out.'; exit 1; }}",
                fresh_ssh(host, now, "")
            ),
        ));
    }
    for it in chosen.iter().filter(|i| !i.id.starts_with("ssh-")) {
        if let Some(fix) = &it.fix {
            // Helpers: the baseline's script asks for root itself.
            if it.id == "helpers" {
                steps.push(Step {
                    label: Some(it.title.clone()),
                    kind: StepKind::Server { server: server.id.clone(), run: fix.clone(), root: false, dir: None },
                });
            } else {
                steps.push(server_step(&server.id, it.title.clone(), format!("{FIX_PRE}{fix}")));
            }
        }
    }
    let auth: Vec<String> = if want_keys {
        vec!["PasswordAuthentication no".into(), "KbdInteractiveAuthentication no".into(), "PubkeyAuthentication yes".into()]
    } else {
        vec![]
    };
    if moving {
        steps.push(server_step(
            &server.id,
            format!("SSH: listen on {target} too ({now} stays open)"),
            format!(
                "{FIX_PRE}{RESTART_SSH}{}if ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow {target}/tcp; fi\nrestart_ssh {target}\nlistens {target} || {{ echo '✗ sshd is not listening on {target}'; exit 1; }}\nlistens {now} || {{ echo '✗ sshd stopped listening on {now}'; exit 1; }}\necho '✓ sshd listens on {now} and {target}'",
                sshd_write(&quoted_lines(&[format!("Port {now}"), format!("Port {target}")]), false)
            ),
        ));
        steps.push(local_step(
            format!("Check: sign in on port {target}"),
            format!("{} && echo '✓ signed in on port {target}' || {{ echo '✗ Port {target} does not let you in (a firewall in front of the server, e.g. a cloud security group?). Port {now} is still open.'; exit 1; }}", fresh_ssh(host, target, "")),
        ));
        steps.push(Step {
            label: Some(format!("Set Port {target} in ~/.ssh/config")),
            kind: StepKind::Pause {
                text: format!("In ~/.ssh/config, set `Port {target}` in the Host block for {host} (Kemudi connects the way `ssh -G {host}` says). Then press Enter."),
            },
        });
        steps.push(local_step(
            format!("Check: ~/.ssh/config says port {target}"),
            format!(
                "p=$(ssh -G {h} 2>/dev/null | awk '$1==\"port\"{{print $2}}'); if [ \"$p\" = {target} ]; then echo '✓ ~/.ssh/config: port {target}'; else printf 'ssh -G %s says port %s. Add this to ~/.ssh/config, then run again from this step:\\n\\n  Host %s\\n    Port {target}\\n\\n' {h} \"$p\" {h}; exit 1; fi",
                h = shell_quote(host)
            ),
        ));
        let mut lines = vec![format!("Port {target}")];
        lines.extend(auth.iter().cloned());
        let ufw_close = if now == 22 {
            "ufw delete allow 22/tcp || true; ufw delete allow 22 || true; ufw delete allow OpenSSH || true; ufw delete allow ssh || true".to_string()
        } else {
            format!("ufw delete allow {now}/tcp || true; ufw delete allow {now} || true")
        };
        steps.push(server_step(
            &server.id,
            format!("SSH: close port {now}{}", if want_keys { ", keys only" } else { "" }),
            format!(
                "{FIX_PRE}{RESTART_SSH}{}restart_ssh {target}\nlistens {target} || {{ echo '✗ sshd is not listening on {target}'; exit 1; }}\nif ufw status 2>/dev/null | grep -q 'Status: active'; then {ufw_close}; fi\nlistens {now} && {{ echo '✗ still listening on {now}'; exit 1; }}\necho '✓ sshd is on {target} only'",
                sshd_write(&quoted_lines(&lines), false)
            ),
        ));
    } else if want_keys {
        steps.push(server_step(
            &server.id,
            "SSH: keys only".into(),
            format!(
                "{FIX_PRE}{RESTART_SSH}{}restart_ssh {now}\necho '✓ password logins off'",
                sshd_write(&quoted_lines(&auth), true)
            ),
        ));
    } else if want_port {
        // Already on the wanted port in ~/.ssh/config, but sshd isn't (or
        // listens on more): just sshd's side.
        steps.push(server_step(
            &server.id,
            format!("SSH: port {target}"),
            format!(
                "{FIX_PRE}{RESTART_SSH}{}restart_ssh {target}\nlistens {target} || {{ echo '✗ sshd is not listening on {target}'; exit 1; }}\necho '✓ sshd is on {target}'",
                sshd_write(&quoted_lines(&[format!("Port {target}")]), false)
            ),
        ));
    }
    if want_port || want_keys {
        steps.push(local_step(
            "Check: you can still sign in".into(),
            format!("{} && echo '✓ signed in on port {target} with a key' || {{ echo '✗ Key login on port {target} failed: keep the session you have open and check sshd there.'; exit 1; }}", fresh_ssh(host, target, "")),
        ));
    }
    if want_keys {
        steps.push(local_step(
            "Check: passwords are refused".into(),
            format!(
                "out=$({} 2>&1); case \"$out\" in *'(publickey)'*) echo '✓ the server only takes keys';; *) printf '%s\\n' \"$out\"; echo '✗ the server still offers other ways in'; exit 1;; esac",
                fresh_ssh(host, target, "-o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive ")
            ),
        ));
    }
    if lynis_audit {
        steps.push(server_step(
            &server.id,
            "Lynis security audit".into(),
            format!("{FIX_PRE}command -v lynis >/dev/null || apt-get install -y lynis\nlynis audit system --quick"),
        ));
    }
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let what = match (chosen.len(), lynis_audit) {
        (0, _) => "Lynis audit".to_string(),
        (1, false) => chosen[0].title.clone(),
        _ => "Set up".to_string(),
    };
    let wf = Workflow {
        id: format!("setup-{}-{n}", server.id),
        name: format!("{what} · {}", server.name),
        pin_server: Some(server.id.clone()),
        pin_app: None,
        view: WorkflowView::Steps,
        fleet: FleetMode::default(),
        steps,
        line: None,
    };
    remember(wf.clone());
    Ok(wf)
}

// ------------------------------------------------------------- commands

fn port_of(host: &str, env: &crate::env::LoginEnv) -> u16 {
    if crate::ssh::validate_host(host).is_err() {
        return 22;
    }
    std::process::Command::new("ssh")
        .arg("-G")
        .arg(host)
        .env_clear()
        .envs(&env.vars)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .find_map(|l| l.strip_prefix("port ").and_then(|p| p.trim().parse().ok()))
        })
        .unwrap_or(22)
}

fn loaded(state: &AppState) -> AppResult<Config> {
    state.config.config().ok_or_else(|| AppError::Config("Kemudi's server list isn't loaded".into()))
}

fn profile_of<'c>(config: &'c Config, server_id: &str) -> AppResult<(&'c Server, &'c Profile)> {
    let server = config.server(server_id).ok_or_else(|| AppError::NotFound(format!("server `{server_id}` isn't in Kemudi")))?;
    let profile = config
        .profile_for(server_id)
        .ok_or_else(|| AppError::Invalid(format!("{} has no setup profile (Server setup ▸ its Profile)", server.name)))?;
    Ok((server, profile))
}

/// Check a server (an AWS server: `instance`, else its first) against its
/// profile. Read-only.
#[tauri::command]
pub async fn setup_check(state: State<'_, AppState>, server_id: String, instance: Option<String>) -> AppResult<SetupStatus> {
    let config = loaded(&state)?;
    let (server, profile) = profile_of(&config, &server_id)?;
    let env = state.env_ready().await;
    let port_now = if server.asg.is_some() { 22 } else { port_of(&server.host, env) };
    let ctx = Ctx { baseline: config.baseline.as_ref(), port_now };
    let out = crate::monitor::run_on(&state, &server_id, instance.as_deref(), &check_script(profile, &ctx), 90).await?;
    parse(profile, &ctx, &out).map_err(AppError::Invalid)
}

/// A workflow that fixes `items` on a server (and the Lynis audit with
/// `lynis-audit`). The frontend runs it like any other.
#[tauri::command]
pub async fn setup_plan(state: State<'_, AppState>, server_id: String, items: Vec<String>) -> AppResult<Workflow> {
    let config = loaded(&state)?;
    let (server, profile) = profile_of(&config, &server_id)?;
    let env = state.env_ready().await;
    let ctx = Ctx { baseline: config.baseline.as_ref(), port_now: port_of(&server.host, env) };
    plan(server, profile, &ctx, &items).map_err(AppError::Invalid)
}

/// The `setup:` block as written in servers.yaml (empty: none yet).
#[tauri::command]
pub async fn setup_source(state: State<'_, AppState>) -> AppResult<String> {
    let source = std::fs::read_to_string(state.config.path())?;
    Ok(top_block(&source, "setup").map(|(a, b)| source.lines().skip(a).take(b - a).collect::<Vec<_>>().join("\n")).unwrap_or_default())
}

/// Lines `[start, end)` of top-level `key:` and everything under it.
fn top_block(source: &str, key: &str) -> Option<(usize, usize)> {
    let lines: Vec<&str> = source.lines().collect();
    let start = lines.iter().position(|l| l.strip_prefix(key).is_some_and(|r| r.trim_start().starts_with(':')))?;
    let mut end = start + 1;
    for (i, l) in lines.iter().enumerate().skip(start + 1) {
        // A comment at the left edge belongs to whatever comes next.
        if l.starts_with('#') {
            continue;
        }
        if !l.is_empty() && !l.starts_with(' ') && !l.starts_with('\t') {
            break;
        }
        if !l.trim().is_empty() {
            end = i + 1;
        }
    }
    Some((start, end))
}

/// Replace the `setup:` block with `text` (YAML starting `setup:`; empty:
/// removed). Not saved if the file wouldn't load.
#[tauri::command]
pub async fn setup_save(app: AppHandle, state: State<'_, AppState>, text: String) -> AppResult<crate::config::Snapshot> {
    let text = text.trim_end().to_string();
    if !text.is_empty() && !text.starts_with("setup:") {
        return Err(AppError::Invalid("it has to start with `setup:`".into()));
    }
    let path = state.config.path().clone();
    let source = std::fs::read_to_string(&path)?;
    let lines: Vec<&str> = source.lines().collect();
    let mut out: Vec<String> = Vec::new();
    match top_block(&source, "setup") {
        Some((a, b)) => {
            out.extend(lines[..a].iter().map(|l| l.to_string()));
            if !text.is_empty() {
                out.push(text.clone());
            }
            out.extend(lines[b..].iter().map(|l| l.to_string()));
        }
        None => {
            out.extend(lines.iter().map(|l| l.to_string()));
            while out.last().is_some_and(|l| l.trim().is_empty()) {
                out.pop();
            }
            if !text.is_empty() {
                out.push(String::new());
                out.push(text.clone());
            }
        }
    }
    let mut edited = out.join("\n");
    edited.push('\n');
    let checked = crate::config::validate::parse(&edited);
    if let Some(e) = checked.errors.first() {
        let at = e.line.map(|l| format!(" (line {l})")).unwrap_or_default();
        return Err(AppError::Invalid(format!("not saved: {}{at}", e.message)));
    }
    crate::config::commands::save(&app, &state, &path, &edited)
}

/// A server's profile (`None`: the default; `"none"`: not checked).
#[tauri::command]
pub async fn server_set_setup(
    app: AppHandle,
    state: State<'_, AppState>,
    server_id: String,
    profile: Option<String>,
) -> AppResult<crate::config::Snapshot> {
    let path = state.config.path().clone();
    let source = std::fs::read_to_string(&path)?;
    let value = profile.as_deref().map(str::trim).filter(|p| !p.is_empty());
    let edited = crate::config::locate::set_entity_field(&source, &server_id, None, "setup", value).map_err(AppError::Invalid)?;
    let checked = crate::config::validate::parse(&edited);
    if let Some(e) = checked.errors.first() {
        return Err(AppError::Invalid(format!("not saved: {}", e.message)));
    }
    let ok = checked.config.is_some_and(|c| c.setup.assigned.get(&server_id).map(String::as_str) == value);
    if !ok {
        return Err(AppError::Invalid("Kemudi couldn't save this change automatically".into()));
    }
    crate::config::commands::save(&app, &state, &path, &edited)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> Profile {
        let yaml = r#"
id: web
timezone: Asia/Kuala_Lumpur
ntp: true
updates: true
unattended_upgrades: true
packages: [curl, git, nginx]
php: { version: "8.4", extensions: [fpm, cli, mbstring] }
composer: true
mysql_secure: true
ssh: { port: 2222, password_auth: false }
firewall: { allow: ["Nginx Full"] }
fail2ban: { maxretry: 3, bantime: 1h, findtime: 10m }
auditd: true
lynis: true
folders: [{ path: /opt/www, owner: www-data, mode: 775 }]
users: [{ name: deploy, sudo: true, password: true }]
custom: [{ name: Swap on, check: "swapon --show | grep -q .", fix: "fallocate -l 2G /swapfile" }]
"#;
        serde_norway::from_str(yaml).expect("profile")
    }

    fn ctx() -> Ctx<'static> {
        Ctx { baseline: None, port_now: 22 }
    }

    #[test]
    fn validates() {
        assert!(problems(&profile()).is_empty(), "{:?}", problems(&profile()));
        let mut p = profile();
        p.timezone = Some("Asia/KL; rm -rf /".into());
        p.packages = Some(vec!["Curl".into()]);
        p.folders = Some(vec![FolderSetup { path: "opt/www".into(), owner: Some("www data".into()), mode: Some("999".into()) }]);
        p.users = Some(vec![UserSetup { name: "root".into(), sudo: None, password: None }]);
        assert_eq!(problems(&p).len(), 6, "{:?}", problems(&p));
    }

    #[test]
    fn durations() {
        assert_eq!(secs("1h"), Some(3600));
        assert_eq!(secs("10m"), Some(600));
        assert_eq!(secs("90"), Some(90));
        assert_eq!(secs("1x"), None);
    }

    #[test]
    fn extends_merges() {
        let base = profile();
        let child = Profile { id: "old-php".into(), extends: Some("web".into()), php: Some(PhpSetup { version: Stringish("8.1".into()), extensions: vec![], ppa: None, default: None }), ..Default::default() };
        let m = merge(&child, base);
        assert_eq!(m.id, "old-php");
        assert_eq!(m.php.map(|p| p.version.0), Some("8.1".into()));
        assert_eq!(m.timezone.as_deref(), Some("Asia/Kuala_Lumpur"));
    }

    #[test]
    fn scripts_are_valid_bash() {
        let p = profile();
        let s = check_script(&p, &ctx());
        let out = std::process::Command::new("bash").args(["-n", "-c", &s]).output().expect("bash");
        assert!(out.status.success(), "{}\n{s}", String::from_utf8_lossy(&out.stderr));
        let config = crate::config::validate::parse("servers:\n  - { id: web, host: web.example.com, env: dev }\n").config.expect("config");
        let server = config.server("web").expect("server").clone();
        let all: Vec<String> = items(&p, &ctx()).into_iter().map(|i| i.id).chain(["lynis-audit".to_string()]).collect();
        let wf = plan(&server, &p, &ctx(), &all).expect("plan");
        for st in &wf.steps {
            let run = match &st.kind {
                StepKind::Server { run, .. } | StepKind::Local { run, .. } => run,
                _ => continue,
            };
            let out = std::process::Command::new("bash").args(["-n", "-c", run]).output().expect("bash");
            assert!(out.status.success(), "{:?}: {}\n{run}", st.label, String::from_utf8_lossy(&out.stderr));
        }
    }

    /// The order that can't lock you out: a key login checked first, the
    /// firewall opened for both ports, the new port tried and in
    /// ~/.ssh/config before the old one closes, and checks last.
    #[test]
    fn ssh_steps_in_a_safe_order() {
        let p = profile();
        let config = crate::config::validate::parse("servers:\n  - { id: web, host: web.example.com, env: dev }\n").config.expect("config");
        let server = config.server("web").expect("server").clone();
        let ids: Vec<String> = ["ssh-passwords", "firewall", "ssh-port", "packages"].map(String::from).to_vec();
        let wf = plan(&server, &p, &ctx(), &ids).expect("plan");
        let labels: Vec<String> = wf.steps.iter().map(|s| s.label.clone().unwrap_or_default()).collect();
        assert_eq!(
            labels,
            [
                "Check: you can sign in with a key",
                "Packages installed",
                "Firewall (ufw)",
                "SSH: listen on 2222 too (22 stays open)",
                "Check: sign in on port 2222",
                "Set Port 2222 in ~/.ssh/config",
                "Check: ~/.ssh/config says port 2222",
                "SSH: close port 22, keys only",
                "Check: you can still sign in",
                "Check: passwords are refused",
            ]
        );
        let fw = match &wf.steps[2].kind {
            StepKind::Server { run, root, .. } => {
                assert!(root);
                run.clone()
            }
            _ => panic!("firewall step"),
        };
        assert!(fw.contains("ufw allow 22/tcp") && fw.contains("ufw allow 2222/tcp"), "{fw}");
        assert!(fw.find("ufw allow 2222/tcp") < fw.find("ufw --force enable"));
        assert!(crate::workflows::script_for_test(&config, &wf).is_ok());
    }

    /// The check, for real, against this machine's shell (no root, no
    /// sudo): every item answers, and nothing is changed.
    #[test]
    fn check_answers_every_item() {
        let p = profile();
        let script = check_script(&p, &ctx()).replace("sudo -n", "false");
        let out = std::process::Command::new("bash").args(["-c", &script]).output().expect("bash");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let st = parse(&p, &ctx(), &text).expect("parse");
        assert!(!st.root);
        for it in &st.items {
            assert_ne!(it.detail, "no answer", "{} didn't answer:\n{text}", it.id);
        }
    }

    /// `KEMUDI_SETUP_HOST=<ssh alias> cargo test setup::tests::live_check --
    /// --ignored --nocapture`: the read-only check on a real server, with the
    /// test profile.
    #[test]
    #[ignore]
    fn live_check() {
        let host = std::env::var("KEMUDI_SETUP_HOST").expect("KEMUDI_SETUP_HOST");
        let p = profile();
        let out = std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "RemoteCommand=none", "-o", "RequestTTY=no", &host, "sh -s"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                use std::io::Write;
                c.stdin.take().expect("stdin").write_all(check_script(&p, &ctx()).as_bytes())?;
                c.wait_with_output()
            })
            .expect("ssh");
        let st = parse(&p, &ctx(), &String::from_utf8_lossy(&out.stdout)).expect("parse");
        println!("os {:?} root {}", st.os, st.root);
        for it in st.items {
            println!("{:8} {:22} {}", it.state, it.id, it.detail);
        }
    }

    /// `KEMUDI_CHECK_CONFIG=<servers.yaml> cargo test setup::tests::config_file
    /// -- --ignored --nocapture`: does that file load, and its profiles.
    #[test]
    #[ignore]
    fn config_file() {
        let path = std::env::var("KEMUDI_CHECK_CONFIG").expect("KEMUDI_CHECK_CONFIG");
        let out = crate::config::validate::parse(&std::fs::read_to_string(path).expect("read"));
        assert!(out.errors.is_empty(), "{:#?}", out.errors);
        let c = out.config.expect("config");
        println!("default {:?}; profiles {:?}", c.setup.default, c.setup.profiles.iter().map(|p| &p.id).collect::<Vec<_>>());
    }

    #[test]
    fn source_block() {
        let src = "servers: []\nsetup:\n  default: web\n  profiles:\n    - id: web\n\n# after\nworkflows: []\n";
        let (a, b) = top_block(src, "setup").expect("block");
        assert_eq!((a, b), (1, 5));
        assert!(top_block(src, "baseline").is_none());
    }

    #[test]
    fn config_profiles_and_servers() {
        let out = crate::config::validate::parse(
            "servers:\n  - { id: a, host: a, env: dev }\n  - { id: b, host: b, env: dev, setup: none }\n  - { id: c, host: c, env: dev, setup: old }\nsetup:\n  default: web\n  profiles:\n    - { id: web, timezone: UTC, php: { version: \"8.4\" } }\n    - { id: old, extends: web, php: { version: \"8.1\" } }\n",
        );
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let c = out.config.expect("config");
        assert_eq!(c.profile_for("a").map(|p| p.id.as_str()), Some("web"));
        assert!(c.profile_for("b").is_none());
        let old = c.profile_for("c").expect("old");
        assert_eq!((old.timezone.as_deref(), old.php.as_ref().map(|p| p.version.0.as_str())), (Some("UTC"), Some("8.1")));
        let bad = crate::config::validate::parse("servers:\n  - { id: a, host: a, env: dev, setup: nope }\nsetup:\n  profiles:\n    - { id: x, extends: y }\n");
        assert_eq!(bad.errors.len(), 2, "{:?}", bad.errors);
    }
}
