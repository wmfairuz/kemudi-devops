//! The server baseline: what every server should have (git repos cloned
//! into one folder, lines in root's ~/.bashrc). A read-only check per
//! server (or instance), and the script behind the built-in action
//! "Install / update baseline": clone what's missing, `git pull --ff-only`
//! what's there, add the missing lines.

use serde::Serialize;
use tauri::State;

use crate::actions::render::shell_quote;
use crate::config::schema::Baseline;
use crate::error::{AppError, AppResult};
use crate::AppState;

/// What's wrong with a baseline (empty: fine).
pub fn problems(b: &Baseline) -> Vec<String> {
    let mut out = Vec::new();
    let dir = b.dir.trim();
    if !dir.starts_with('/') || dir.contains(char::is_whitespace) || dir.contains("..") {
        out.push(format!("folder {dir:?} must be an absolute path without spaces"));
    }
    let mut seen = std::collections::HashSet::new();
    for r in &b.repos {
        let name_ok = !r.name.is_empty()
            && !r.name.starts_with('.')
            && r.name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
        if !name_ok {
            out.push(format!("repo name {:?}: use letters, digits, - _ .", r.name));
        }
        if !seen.insert(r.name.as_str()) {
            out.push(format!("repo {:?} is listed twice", r.name));
        }
        let url = r.url.trim();
        let url_ok = (url.starts_with("https://") || url.starts_with("git@") || url.starts_with("ssh://"))
            && !url.contains(char::is_whitespace)
            && !url.starts_with('-');
        if !url_ok {
            out.push(format!("repo {:?}: {url:?} isn't a git URL (https://…, git@…, ssh://…)", r.name));
        }
    }
    for l in &b.bashrc {
        if l.trim().is_empty() || l.contains('\n') || l.contains('\r') {
            out.push("each ~/.bashrc line must be one non-empty line".into());
        }
    }
    out
}

/// `asroot cmd…`: as root directly, else sudo (which may ask), else `sudo su -c`.
const ROOT_FN: &str = r#"asroot(){ if [ "$(id -u)" = 0 ]; then "$@"; elif sudo -n true 2>/dev/null || ! sudo -n su -c true 2>/dev/null; then sudo "$@"; else sudo su -c "$*"; fi; }"#;

/// Read-only: each repo's state (and whether GitHub has newer commits),
/// and whether each line is in root's ~/.bashrc. Nothing is fetched into
/// the clones (`ls-remote` only asks).
pub fn check_script(b: &Baseline) -> String {
    let mut s = String::from("G(){ git -c safe.directory='*' \"$@\"; }\n");
    for r in &b.repos {
        let d = shell_quote(&format!("{}/{}", b.dir.trim_end_matches('/'), r.name));
        s.push_str(&format!(
            r#"echo "@@repo {name}"; d={d}
if [ -d "$d/.git" ]; then
  l=$(G -C "$d" rev-parse HEAD 2>/dev/null); echo "at $(G -C "$d" log -1 --format='%h %cs' 2>/dev/null)"
  r=$( (command -v timeout >/dev/null && timeout 15 git -c safe.directory='*' -C "$d" ls-remote origin HEAD || G -C "$d" ls-remote origin HEAD) 2>/dev/null | cut -f1)
  if [ -z "$r" ]; then echo "state unknown"; elif [ "$r" = "$l" ]; then echo "state ok"; elif G -C "$d" cat-file -e "$r" 2>/dev/null; then echo "state ahead"; else echo "state behind"; fi
elif [ -e "$d" ]; then echo "state notgit"; else echo "state missing"; fi
"#,
            name = r.name,
        ));
    }
    s.push_str("echo @@bashrc\n");
    for (i, l) in b.bashrc.iter().enumerate() {
        let q = shell_quote(l);
        s.push_str(&format!(
            "if [ -r /root/.bashrc ]; then grep -qxF -- {q} /root/.bashrc && echo 'line {i} yes' || echo 'line {i} no'; elif sudo -n true 2>/dev/null; then sudo -n grep -qxF -- {q} /root/.bashrc && echo 'line {i} yes' || echo 'line {i} no'; else echo 'line {i} unknown'; fi\n"
        ));
    }
    s.push_str("echo @@end\n");
    s
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub name: String,
    /// ok (same as its remote), behind (the remote has newer commits),
    /// ahead (local commits), missing, notgit (the folder isn't a clone),
    /// unknown (the remote didn't answer).
    pub state: String,
    /// `<short hash> <date>` of what's checked out.
    pub at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineStatus {
    pub line: String,
    /// None: couldn't read root's ~/.bashrc (no root, no passwordless sudo).
    pub present: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaselineStatus {
    pub repos: Vec<RepoStatus>,
    pub lines: Vec<LineStatus>,
    /// Everything there (a repo that's only behind still counts as there).
    pub complete: bool,
}

pub fn parse(b: &Baseline, out: &str) -> Result<BaselineStatus, String> {
    if !out.contains("@@end") {
        return Err("the check didn't finish".into());
    }
    let mut repos: Vec<RepoStatus> = Vec::new();
    let mut lines: Vec<LineStatus> = b.bashrc.iter().map(|l| LineStatus { line: l.clone(), present: None }).collect();
    let mut cur: Option<usize> = None;
    for raw in out.lines() {
        let line = raw.trim_end_matches('\r');
        if let Some(name) = line.strip_prefix("@@repo ") {
            repos.push(RepoStatus { name: name.to_string(), state: "unknown".into(), at: None });
            cur = Some(repos.len() - 1);
        } else if line == "@@bashrc" {
            cur = None;
        } else if let (Some(i), Some(at)) = (cur, line.strip_prefix("at ")) {
            repos[i].at = Some(at.trim().to_string()).filter(|a| !a.is_empty());
        } else if let (Some(i), Some(st)) = (cur, line.strip_prefix("state ")) {
            repos[i].state = st.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("line ") {
            let mut w = rest.split_whitespace();
            if let (Some(Ok(i)), Some(v)) = (w.next().map(str::parse::<usize>), w.next()) {
                if let Some(l) = lines.get_mut(i) {
                    l.present = match v {
                        "yes" => Some(true),
                        "no" => Some(false),
                        _ => None,
                    };
                }
            }
        }
    }
    let complete = repos.iter().all(|r| matches!(r.state.as_str(), "ok" | "behind" | "ahead" | "unknown"))
        && lines.iter().all(|l| l.present == Some(true));
    Ok(BaselineStatus { repos, lines, complete })
}

/// Clone what's missing, update what's there (fast-forward only: local
/// changes on a server stop it, nothing is overwritten), add missing lines
/// to root's ~/.bashrc. Ends non-zero if anything didn't work.
pub fn install_script(b: &Baseline) -> String {
    let dir = b.dir.trim_end_matches('/');
    let mut s = format!("{ROOT_FN}\nbad=0\nasroot mkdir -p {}\n", shell_quote(dir));
    for r in &b.repos {
        let d = shell_quote(&format!("{dir}/{}", r.name));
        let name = shell_quote(&r.name);
        s.push_str(&format!(
            r#"printf '\n\033[1;36m── %s\033[0m\n' {name}
if [ -d {d}/.git ]; then echo "updating {d_plain}"; asroot git -c safe.directory='*' -C {d} pull --ff-only || bad=1
elif [ -e {d} ]; then echo "{d_plain} is there but isn't a git clone: left alone"; bad=1
else echo "cloning into {d_plain}"; asroot git clone {url} {d} || bad=1; fi
"#,
            d_plain = format!("{dir}/{}", r.name),
            url = shell_quote(r.url.trim()),
        ));
    }
    if !b.bashrc.is_empty() {
        s.push_str("printf '\\n\\033[1;36m── root ~/.bashrc\\033[0m\\n'\n");
    }
    for l in &b.bashrc {
        let q = shell_quote(l);
        s.push_str(&format!(
            "if asroot grep -qxF -- {q} /root/.bashrc 2>/dev/null; then echo \"already there: \"{q}; else printf '%s\\n' {q} | asroot tee -a /root/.bashrc >/dev/null && echo \"added: \"{q} || bad=1; fi\n"
        ));
    }
    s.push_str("[ $bad = 0 ] && printf '\\n\\033[32m✓ baseline in place\\033[0m\\n' || printf '\\n\\033[31m✗ not all of it worked (see above)\\033[0m\\n'\n[ $bad = 0 ]");
    s
}

/// Check a server (an AWS server: `instance`, else its first) against the
/// baseline. Read-only.
#[tauri::command]
pub async fn baseline_check(
    state: State<'_, AppState>,
    server_id: String,
    instance: Option<String>,
) -> AppResult<BaselineStatus> {
    let b = state
        .config
        .config()
        .and_then(|c| c.baseline.clone())
        .ok_or_else(|| AppError::Invalid("no server baseline set up yet (Settings ▸ Server baseline)".into()))?;
    let out = crate::monitor::run_on(&state, &server_id, instance.as_deref(), &check_script(&b), 45).await?;
    parse(&b, &out).map_err(AppError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::schema::BaselineRepo;

    fn baseline() -> Baseline {
        Baseline {
            dir: "/opt/www".into(),
            repos: vec![
                BaselineRepo { name: "server-helper".into(), url: "https://example.com/acme/server-helper.git".into() },
                BaselineRepo { name: "laravel-helper".into(), url: "https://example.com/acme/laravel-helper.git".into() },
            ],
            bashrc: vec!["alias deploy='/opt/www/laravel-helper/laravel-helper -d'".into()],
        }
    }

    #[test]
    fn validates() {
        assert!(problems(&baseline()).is_empty());
        let mut b = baseline();
        b.dir = "opt/www".into();
        b.repos[0].name = "../x".into();
        b.repos[1].url = "-oProxyCommand=x".into();
        b.bashrc.push("two\nlines".into());
        assert_eq!(problems(&b).len(), 4, "{:?}", problems(&b));
    }

    /// The built-in action runs the install script exactly (actions are
    /// templates; nothing in it may be taken for one).
    #[test]
    fn action_renders_the_script() {
        let out = crate::config::validate::parse(
            "servers:\n  - { id: web, host: web, env: dev }\nbaseline: { repos: [{ name: tools, url: https://example.com/acme/tools.git }], bashrc: [\"alias deploy='/opt/www/tools/run -d'\"] }\n",
        );
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let c = out.config.expect("config");
        let r = crate::actions::commands::render_action(
            &c,
            &crate::actions::commands::ActionRef {
                server_id: "web".into(),
                app_id: None,
                action_id: "baseline".into(),
                values: Default::default(),
            },
            None,
        )
        .expect("render");
        assert_eq!(r.command, install_script(c.baseline.as_ref().expect("baseline")));
        assert!(r.server_wide);
    }

    #[test]
    fn scripts_are_valid_bash() {
        for s in [check_script(&baseline()), install_script(&baseline())] {
            let out = std::process::Command::new("bash").args(["-n", "-c", &s]).output().expect("bash");
            assert!(out.status.success(), "{}\n{s}", String::from_utf8_lossy(&out.stderr));
        }
    }

    /// `KEMUDI_BASELINE_HOST=<ssh alias> cargo test live_check -- --ignored
    /// --nocapture`: the read-only check on a real server, with a baseline
    /// from KEMUDI_BASELINE (YAML, like the config's `baseline:` value).
    #[test]
    #[ignore]
    fn live_check() {
        let host = std::env::var("KEMUDI_BASELINE_HOST").expect("KEMUDI_BASELINE_HOST");
        let b: Baseline = serde_norway::from_str(&std::env::var("KEMUDI_BASELINE").expect("KEMUDI_BASELINE")).expect("baseline");
        let out = std::process::Command::new("ssh")
            .args(["-o", "BatchMode=yes", "-o", "RemoteCommand=none", "-o", "RequestTTY=no", &host, "sh -s"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                use std::io::Write;
                c.stdin.take().expect("stdin").write_all(check_script(&b).as_bytes())?;
                c.wait_with_output()
            })
            .expect("ssh");
        println!("{:#?}", parse(&b, &String::from_utf8_lossy(&out.stdout)));
    }

    /// The check and the install, for real, in a temp folder with local
    /// repos standing in for GitHub and a fake root ~/.bashrc.
    #[test]
    fn install_then_check() {
        let t = std::env::temp_dir().join(format!("kemudi-baseline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(t.join("src")).expect("dir");
        let git = |args: &[&str], dir: &std::path::Path| {
            let ok = std::process::Command::new("git").args(args).current_dir(dir).output().expect("git").status.success();
            assert!(ok, "git {args:?}");
        };
        for name in ["one", "two"] {
            let d = t.join("src").join(name);
            std::fs::create_dir_all(&d).expect("repo");
            git(&["init", "-q", "-b", "main"], &d);
            std::fs::write(d.join("README"), name).expect("file");
            git(&["add", "."], &d);
            git(&["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"], &d);
        }
        let b = Baseline {
            dir: t.join("www").to_string_lossy().to_string(),
            repos: ["one", "two"]
                .map(|n| BaselineRepo { name: n.into(), url: format!("file://{}", t.join("src").join(n).display()) })
                .to_vec(),
            bashrc: vec!["alias deploy='echo hi'".into()],
        };
        // The scripts use /root/.bashrc; point them at a file of ours.
        let rc = t.join("bashrc");
        std::fs::write(&rc, "# rc\n").expect("rc");
        let run = |script: &str| {
            let script = format!(
                "asroot(){{ \"$@\"; }}\nsudo(){{ return 1; }}\n{}",
                script.replace("/root/.bashrc", &rc.to_string_lossy())
            )
            .replace(ROOT_FN, "");
            let out = std::process::Command::new("bash").args(["-c", &script]).output().expect("bash");
            (out.status.success(), String::from_utf8_lossy(&out.stdout).to_string())
        };
        // file:// URLs aren't https: fine for the test, problems() isn't asked.
        let (_, before) = run(&check_script(&b));
        let st = parse(&b, &before).expect("parse");
        assert!(!st.complete && st.repos.iter().all(|r| r.state == "missing"), "{before}");
        assert_eq!(st.lines[0].present, Some(false));

        let (ok, out) = run(&install_script(&b));
        assert!(ok, "{out}");
        let (_, after) = run(&check_script(&b));
        let st = parse(&b, &after).expect("parse");
        assert!(st.complete, "{after}");
        assert!(st.repos.iter().all(|r| r.state == "ok" && r.at.is_some()), "{after}");

        // Again: nothing added twice.
        let (ok, out) = run(&install_script(&b));
        assert!(ok && out.contains("already there"), "{out}");
        assert_eq!(std::fs::read_to_string(&rc).expect("rc").matches("alias deploy").count(), 1);

        // A newer commit upstream: behind, then updated.
        let one = t.join("src").join("one");
        std::fs::write(one.join("README"), "new").expect("file");
        git(&["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qam", "more"], &one);
        let st = parse(&b, &run(&check_script(&b)).1).expect("parse");
        assert_eq!(st.repos[0].state, "behind");
        assert!(run(&install_script(&b)).0);
        let st = parse(&b, &run(&check_script(&b)).1).expect("parse");
        assert_eq!(st.repos[0].state, "ok");
        let _ = std::fs::remove_dir_all(&t);
    }
}
