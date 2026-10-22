//! Kemudi as an MCP server, so a Claude session can list and run your
//! workflows ("run Deploy eTabika").
//!
//! `kemudi --mcp` is a stdio MCP server (what `claude mcp add` launches).
//! It answers the handshake and the tool list itself, and hands each tool
//! call to the running Kemudi app over a private Unix socket in Kemudi's
//! data folder (mode 600): no network, nothing leaves this Mac. Runs start
//! in the app's Workflows tab like any other: you see them, answer their
//! prompts, can stop them; a workflow that touches production waits for you
//! to confirm it in Kemudi, exactly as when you click Run.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::schema::{Config, Workflow};
use crate::error::AppResult;
use crate::AppState;

/// The app's end of the bridge: in Kemudi's data folder, or (a Unix socket
/// path is limited to ~104 bytes) in this user's private temp folder under a
/// name made from it, so the bridge finds the same one.
pub fn socket_path() -> Option<PathBuf> {
    let dir = crate::data_dir()?;
    let path = dir.join("kemudi.sock");
    if path.as_os_str().len() <= 100 {
        return Some(path);
    }
    // FNV-1a of the data folder: stable across both processes.
    let hash = dir
        .to_string_lossy()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    Some(std::env::temp_dir().join(format!("kemudi-{hash:016x}.sock")))
}

const INSTRUCTIONS: &str = "Kemudi Devops runs the user's dev/ops workflows (named lists of steps: commands on this Mac, commands on servers, actions). list_workflows shows them; run_workflow starts one in the Kemudi app, where the user can watch it, answer prompts (passwords, yes/no) and stop it, and returns each step's result. A workflow that touches production waits for the user to confirm it in Kemudi; if they don't, it isn't run. Prefer running a workflow by its id from list_workflows.";

/// The tools, as `tools/list` returns them.
pub fn tools() -> Value {
    json!([
        {
            "name": "list_workflows",
            "description": "List Kemudi's workflows: id, name, where each is pinned (server/app), its steps, and whether it touches production.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "run_workflow",
            "description": "Run a Kemudi workflow (by id, or by name) in the Kemudi app and wait for it to finish; returns each step's result and output. A workflow that touches production waits for the user to confirm in Kemudi first. If it's still running after wait_minutes, returns its run_id: follow it with get_run.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workflow": { "type": "string", "description": "The workflow's id (from list_workflows) or its name." },
                    "from_step": { "type": "integer", "minimum": 1, "description": "Start at this step (1-based), e.g. to re-run from a failed step. Default 1." },
                    "wait_minutes": { "type": "number", "minimum": 0, "maximum": 30, "description": "How long to wait for it to finish before returning (default 10)." }
                },
                "required": ["workflow"],
                "additionalProperties": false
            }
        },
        {
            "name": "get_run",
            "description": "A workflow run started in this Kemudi session (run_id from run_workflow): its status, each step's result and output. Optionally waits for it to finish.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string" },
                    "wait_minutes": { "type": "number", "minimum": 0, "maximum": 30, "description": "Wait up to this long for it to finish (default 0: as it is now)." }
                },
                "required": ["run_id"],
                "additionalProperties": false
            }
        },
        {
            "name": "recent_runs",
            "description": "Recent workflow runs from Kemudi's History (also earlier sessions): when, which workflow, how long, and whether it succeeded or at which step it stopped.",
            "inputSchema": {
                "type": "object",
                "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 50, "description": "Default 10." } },
                "additionalProperties": false
            }
        }
    ])
}

/// A tool call as it crosses the socket, and its answer.
#[derive(Debug, Serialize, Deserialize)]
pub struct Call {
    pub tool: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub text: String,
    #[serde(default)]
    pub is_error: bool,
}

impl Reply {
    fn ok(text: impl Into<String>) -> Self {
        Reply { text: text.into(), is_error: false }
    }
    fn err(text: impl Into<String>) -> Self {
        Reply { text: text.into(), is_error: true }
    }
}

// ------------------------------------------------------------ the bridge

/// `kemudi --mcp`: MCP over stdin/stdout (newline-delimited JSON-RPC).
pub fn bridge() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            let _ = writeln!(out, "{}", json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "parse error"}}));
            let _ = out.flush();
            continue;
        };
        if let Some(answer) = answer(&msg) {
            let _ = writeln!(out, "{answer}");
            let _ = out.flush();
        }
    }
}

/// The JSON-RPC answer to one message (None for notifications).
fn answer(msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "kemudi", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let call = Call {
                tool: params.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                args: params.get("arguments").cloned().unwrap_or(json!({})),
            };
            let r = forward(&call);
            json!({ "content": [{ "type": "text", "text": r.text }], "isError": r.is_error })
        }
        _ => {
            return Some(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("unknown method {method}")}}));
        }
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

/// One call to the running app (a connection each).
fn forward(call: &Call) -> Reply {
    let Some(path) = socket_path() else {
        return Reply::err("Kemudi's data folder isn't available");
    };
    let mut stream = match std::os::unix::net::UnixStream::connect(&path) {
        Ok(s) => s,
        Err(_) => return Reply::err("Kemudi Devops isn't running (or is an older version): open it and try again."),
    };
    let Ok(body) = serde_json::to_string(call) else {
        return Reply::err("couldn't encode the call");
    };
    if writeln!(stream, "{body}").and_then(|_| stream.flush()).is_err() {
        return Reply::err("couldn't reach Kemudi Devops");
    }
    let mut line = String::new();
    match BufReader::new(stream).read_line(&mut line) {
        Ok(n) if n > 0 => serde_json::from_str(&line).unwrap_or_else(|_| Reply::err("Kemudi answered something unreadable")),
        _ => Reply::err("Kemudi Devops closed the connection (quit?) before answering"),
    }
}

// ---------------------------------------------------------- the app's end

/// Listen for the bridge (started with the app).
pub fn serve(app: AppHandle) {
    let Some(path) = socket_path() else { return };
    tauri::async_runtime::spawn(async move {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // A socket left by an earlier run (or a crash).
        let _ = std::fs::remove_file(&path);
        let listener = match tokio::net::UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("kemudi: MCP socket {}: {e}", path.display());
                return;
            }
        };
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                let (read, mut write) = stream.into_split();
                let mut lines = tokio::io::BufReader::new(read).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let reply = match serde_json::from_str::<Call>(&line) {
                        Ok(call) => handle(&app, call).await,
                        Err(e) => Reply::err(format!("bad call: {e}")),
                    };
                    let body = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"text\":\"?\",\"isError\":true}".into());
                    if write.write_all(format!("{body}\n").as_bytes()).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
}

async fn handle(app: &AppHandle, call: Call) -> Reply {
    let state: State<'_, AppState> = app.state();
    let Some(config) = state.config.config() else {
        return Reply::err("Kemudi's server list isn't loaded (see the banner in Kemudi)");
    };
    match call.tool.as_str() {
        "list_workflows" => Reply::ok(list_workflows(&config)),
        "recent_runs" => recent_runs(&state, call.args.get("limit").and_then(Value::as_u64).unwrap_or(10)),
        "run_workflow" => {
            let name = call.args.get("workflow").and_then(Value::as_str).unwrap_or("").trim();
            let wf = match find_workflow(&config, name) {
                Ok(w) => w,
                Err(e) => return Reply::err(e),
            };
            let from = call.args.get("from_step").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
            if from > wf.steps.len() {
                return Reply::err(format!("{} has {} steps", wf.name, wf.steps.len()));
            }
            let wait = minutes(&call.args, 10.0);
            let prod = crate::workflows::touches_prod(&config, wf, from);
            if prod {
                // It waits for you: bring Kemudi to the front.
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            // The run itself happens in the window (its terminal and steps
            // live there); up to 15 more minutes to confirm a prod one.
            ask_window(app, "mcp://run-workflow", json!({ "workflowId": wf.id, "from": from, "waitMs": wait.as_millis() as u64, "prod": prod }), wait + Duration::from_secs(15 * 60)).await
        }
        "get_run" => {
            let run = call.args.get("run_id").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if run.is_empty() {
                return Reply::err("give run_id (from run_workflow)");
            }
            let wait = minutes(&call.args, 0.0);
            ask_window(app, "mcp://get-run", json!({ "runId": run, "waitMs": wait.as_millis() as u64 }), wait + Duration::from_secs(60)).await
        }
        other => Reply::err(format!("unknown tool {other}")),
    }
}

fn minutes(args: &Value, default: f64) -> Duration {
    let m = args.get("wait_minutes").and_then(Value::as_f64).unwrap_or(default).clamp(0.0, 30.0);
    Duration::from_secs_f64(m * 60.0)
}

/// A workflow by id, else by name (any case).
fn find_workflow<'c>(config: &'c Config, name: &str) -> Result<&'c Workflow, String> {
    let lower = name.to_lowercase();
    config
        .workflows
        .iter()
        .find(|w| w.id == name)
        .or_else(|| config.workflows.iter().find(|w| w.name.to_lowercase() == lower))
        .ok_or_else(|| {
            let ids: Vec<&str> = config.workflows.iter().map(|w| w.id.as_str()).collect();
            format!("no workflow {name:?}; there are: {}", ids.join(", "))
        })
}

pub fn list_workflows(config: &Config) -> String {
    if config.workflows.is_empty() {
        return "No workflows yet (make them in Kemudi: Workflows ▸ + New workflow).".into();
    }
    let mut out = String::new();
    for w in &config.workflows {
        let pin = match (&w.pin_server, &w.pin_app) {
            (Some(s), Some(a)) => format!(" · pinned to app {a} on {s}"),
            (Some(s), None) => format!(" · pinned to server {s}"),
            _ => String::new(),
        };
        let prod = if crate::workflows::touches_prod(config, w, 1) { " · touches PRODUCTION (asks the user first)" } else { "" };
        out.push_str(&format!("{} — {}{pin}{prod}\n", w.id, w.name));
        for (i, s) in w.steps.iter().enumerate() {
            out.push_str(&format!("  {}. {}\n", i + 1, crate::workflows::title_of(config, s)));
        }
    }
    out
}

fn recent_runs(state: &AppState, limit: u64) -> Reply {
    let audit = match &state.audit {
        Ok(a) => a,
        Err(e) => return Reply::err(format!("History isn't available: {e}")),
    };
    let q = crate::audit::Query { query: Some("workflow:".into()), limit: Some(200), ..Default::default() };
    let page = match audit.list(&q) {
        Ok(p) => p,
        Err(e) => return Reply::err(format!("History: {e}")),
    };
    let now = crate::audit::now_ms();
    let lines: Vec<String> = page
        .runs
        .iter()
        .filter(|r| r.action_id.starts_with("workflow:") && !r.label.contains(" · step ") && !r.label.contains(" · watch"))
        .take(limit.clamp(1, 50) as usize)
        .map(|r| {
            let ago = ago(now - r.started_at);
            let took = r.finished_at.map(|f| format!(", took {}", secs(f - r.started_at))).unwrap_or_default();
            let outcome = match r.exit_code {
                None if r.finished_at.is_none() => "running (or the app quit while it ran)".to_string(),
                None => "ended".to_string(),
                Some(0) => "✓ succeeded".to_string(),
                Some(c) if (101..200).contains(&c) => format!("✗ stopped at step {}", c - 100),
                Some(c) => format!("✗ exit {c}"),
            };
            format!("{} — {ago}{took}: {outcome} (workflow {})", r.label, &r.action_id["workflow:".len()..])
        })
        .collect();
    Reply::ok(if lines.is_empty() { "No workflow runs in History yet.".into() } else { lines.join("\n") })
}

fn secs(ms: i64) -> String {
    let s = (ms / 1000).max(0);
    if s < 60 { format!("{s}s") } else { format!("{}m {}s", s / 60, s % 60) }
}

fn ago(ms: i64) -> String {
    let m = (ms / 60_000).max(0);
    match m {
        0 => "just now".into(),
        1..=59 => format!("{m} min ago"),
        60..=2879 => format!("{} h ago", m / 60),
        _ => format!("{} days ago", m / 1440),
    }
}

// ------------------------------------------------- answers from the window

static PENDING: LazyLock<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Reply>>>> = LazyLock::new(Default::default);
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Hand a request to the window (event `name`, with `id`) and wait for its
/// `mcp_reply`, at most `limit`.
async fn ask_window(app: &AppHandle, name: &str, mut payload: Value, limit: Duration) -> Reply {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Ok(mut p) = PENDING.lock() {
        p.insert(id, tx);
    }
    payload["id"] = json!(id);
    if app.emit(name, payload).is_err() {
        if let Ok(mut p) = PENDING.lock() {
            p.remove(&id);
        }
        return Reply::err("Kemudi's window isn't there to run it");
    }
    match tokio::time::timeout(limit, rx).await {
        Ok(Ok(r)) => r,
        _ => {
            if let Ok(mut p) = PENDING.lock() {
                p.remove(&id);
            }
            Reply::err("Kemudi didn't answer in time (is its window open?)")
        }
    }
}

/// The window's answer to a request.
#[tauri::command]
pub async fn mcp_reply(id: u64, text: String, is_error: bool) -> AppResult<()> {
    let tx = PENDING.lock().ok().and_then(|mut p| p.remove(&id));
    if let Some(tx) = tx {
        let _ = tx.send(Reply { text, is_error });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_and_tools_without_the_app() {
        let init = answer(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})).expect("answer");
        assert_eq!(init["result"]["serverInfo"]["name"], "kemudi");
        assert!(answer(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        let list = answer(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).expect("answer");
        let names: Vec<&str> = list["result"]["tools"].as_array().expect("tools").iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(names, ["list_workflows", "run_workflow", "get_run", "recent_runs"]);
        let unknown = answer(&json!({"jsonrpc":"2.0","id":3,"method":"nope"})).expect("answer");
        assert_eq!(unknown["error"]["code"], -32601);
    }

    #[test]
    fn lists_and_finds_workflows() {
        let out = crate::config::validate::parse(
            "servers:\n  - { id: web, host: web, env: prod }\nworkflows:\n  - id: ship\n    name: Ship it\n    steps:\n      - { local: echo hi }\n      - { server: web, run: deploy }\n",
        );
        let c = out.config.expect("config");
        let text = list_workflows(&c);
        assert!(text.contains("ship — Ship it") && text.contains("PRODUCTION") && text.contains("  2. "), "{text}");
        assert_eq!(find_workflow(&c, "ship it").map(|w| w.id.as_str()), Ok("ship"));
        assert!(find_workflow(&c, "nope").unwrap_err().contains("there are: ship"));
    }
}
