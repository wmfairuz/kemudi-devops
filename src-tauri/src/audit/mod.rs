//! Audit log: every action run, in SQLite at
//! ~/Library/Application Support/kemudi/audit.db.

pub mod commands;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const MIGRATIONS: &[&str] = &["
    CREATE TABLE runs (
        id          INTEGER PRIMARY KEY,
        started_at  INTEGER NOT NULL,          -- unix ms
        finished_at INTEGER,                   -- unix ms; NULL while running
        server_id   TEXT    NOT NULL,
        app_id      TEXT,
        action_id   TEXT    NOT NULL,
        label       TEXT    NOT NULL,
        env         TEXT    NOT NULL,
        kind        TEXT    NOT NULL,          -- ssh | local | send
        command     TEXT    NOT NULL,          -- exactly what ran
        edited      INTEGER NOT NULL,
        exit_code   INTEGER                    -- NULL when not detectable
    );
    CREATE INDEX runs_started ON runs (started_at DESC);
"];

pub struct NewRun<'a> {
    pub server_id: &'a str,
    pub app_id: Option<&'a str>,
    pub action_id: &'a str,
    pub label: &'a str,
    pub env: &'a str,
    pub kind: &'a str,
    pub command: &'a str,
    pub edited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub server_id: String,
    pub app_id: Option<String>,
    pub action_id: String,
    pub label: String,
    pub env: String,
    pub kind: String,
    pub command: String,
    pub edited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub query: Option<String>,
    pub env: Option<String>,
    /// ok | failed | running
    pub exit: Option<String>,
    pub since_ms: Option<i64>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub runs: Vec<Run>,
    pub total: i64,
}

pub struct AuditLog {
    conn: Mutex<Connection>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

impl AuditLog {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        Self::init(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        for (i, sql) in MIGRATIONS
            .iter()
            .enumerate()
            .skip(usize::try_from(version).unwrap_or(0))
        {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", i64::try_from(i + 1).unwrap_or(0))?;
        }
        // Anything still "running" belongs to a previous app session.
        conn.execute(
            "UPDATE runs SET finished_at = started_at WHERE finished_at IS NULL",
            [],
        )?;
        Ok(AuditLog {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn start(&self, run: &NewRun) -> rusqlite::Result<i64> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO runs (started_at, server_id, app_id, action_id, label, env, kind, command, edited)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                now_ms(),
                run.server_id,
                run.app_id,
                run.action_id,
                run.label,
                run.env,
                run.kind,
                run.command,
                run.edited
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Record the end of a run. Only the first call counts.
    pub fn finish(&self, id: i64, exit_code: Option<i32>) -> rusqlite::Result<()> {
        self.conn().execute(
            "UPDATE runs SET finished_at = ?1, exit_code = ?2 WHERE id = ?3 AND finished_at IS NULL",
            params![now_ms(), exit_code, id],
        )?;
        Ok(())
    }

    pub fn get(&self, id: i64) -> rusqlite::Result<Option<Run>> {
        self.conn()
            .query_row(
                &format!("SELECT {COLUMNS} FROM runs WHERE id = ?1"),
                [id],
                row_to_run,
            )
            .optional()
    }

    pub fn list(&self, q: &Query) -> rusqlite::Result<Page> {
        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        // Push a value and get its numbered placeholder.
        let mut bind = |v: rusqlite::types::Value| {
            args.push(v);
            format!("?{}", args.len())
        };
        if let Some(text) = q.query.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            // LIKE is case-insensitive for ASCII; % and _ are matched literally.
            let escaped = text
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let p = bind(format!("%{escaped}%").into());
            let any = ["command", "server_id", "app_id", "action_id", "label"]
                .map(|col| format!("{col} LIKE {p} ESCAPE '\\'"))
                .join(" OR ");
            clauses.push(format!("({any})"));
        }
        if let Some(env) = q.env.as_deref().filter(|e| !e.is_empty() && *e != "all") {
            let p = bind(env.to_string().into());
            clauses.push(format!("env = {p}"));
        }
        if let Some(since) = q.since_ms {
            let p = bind(since.into());
            clauses.push(format!("started_at >= {p}"));
        }
        match q.exit.as_deref() {
            Some("ok") => clauses.push("exit_code = 0".into()),
            Some("failed") => clauses.push("exit_code IS NOT NULL AND exit_code <> 0".into()),
            Some("running") => clauses.push("finished_at IS NULL".into()),
            _ => {}
        }
        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let conn = self.conn();
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM runs {where_sql}"),
            rusqlite::params_from_iter(args.iter()),
            |r| r.get(0),
        )?;
        let limit = i64::from(q.limit.unwrap_or(200).min(1000));
        let offset = i64::from(q.offset.unwrap_or(0));
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM runs {where_sql} ORDER BY started_at DESC, id DESC LIMIT {limit} OFFSET {offset}"
        ))?;
        let runs = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), row_to_run)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Page { runs, total })
    }
}

const COLUMNS: &str =
    "id, started_at, finished_at, server_id, app_id, action_id, label, env, kind, command, edited, exit_code";

fn row_to_run(r: &rusqlite::Row) -> rusqlite::Result<Run> {
    Ok(Run {
        id: r.get(0)?,
        started_at: r.get(1)?,
        finished_at: r.get(2)?,
        server_id: r.get(3)?,
        app_id: r.get(4)?,
        action_id: r.get(5)?,
        label: r.get(6)?,
        env: r.get(7)?,
        kind: r.get(8)?,
        command: r.get(9)?,
        edited: r.get(10)?,
        exit_code: r.get(11)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run<'a>(server: &'a str, action: &'a str, env: &'a str, command: &'a str) -> NewRun<'a> {
        NewRun {
            server_id: server,
            app_id: Some("akaun"),
            action_id: action,
            label: action,
            env,
            kind: "ssh",
            command,
            edited: false,
        }
    }

    #[test]
    fn roundtrip_start_finish() {
        let log = AuditLog::in_memory().expect("db");
        let id = log
            .start(&run("stg", "pull", "staging", "git pull"))
            .expect("start");
        let r = log.get(id).expect("get").expect("row");
        assert_eq!((r.finished_at, r.exit_code), (None, None));
        log.finish(id, Some(0)).expect("finish");
        log.finish(id, Some(9)).expect("second finish is ignored");
        let r = log.get(id).expect("get").expect("row");
        assert!(r.finished_at.is_some());
        assert_eq!(r.exit_code, Some(0));
    }

    #[test]
    fn list_filters_and_search() {
        let log = AuditLog::in_memory().expect("db");
        let a = log
            .start(&run(
                "stg",
                "pull",
                "staging",
                "cd /var/www/akaun && git pull",
            ))
            .expect("a");
        let b = log
            .start(&run(
                "prod-1",
                "migrate",
                "prod",
                "php artisan migrate --force",
            ))
            .expect("b");
        let c = log
            .start(&run("prod-1", "pull", "prod", "git pull 100%_done"))
            .expect("c");
        log.finish(a, Some(0)).expect("a");
        log.finish(b, Some(1)).expect("b");

        let all = log.list(&Query::default()).expect("all");
        assert_eq!(all.total, 3);
        assert_eq!(all.runs[0].id, c, "newest first");

        let q = |query: Query| log.list(&query).expect("list");
        assert_eq!(
            q(Query {
                env: Some("prod".into()),
                ..Query::default()
            })
            .total,
            2
        );
        assert_eq!(
            q(Query {
                exit: Some("failed".into()),
                ..Query::default()
            })
            .runs[0]
                .id,
            b
        );
        assert_eq!(
            q(Query {
                exit: Some("ok".into()),
                ..Query::default()
            })
            .runs[0]
                .id,
            a
        );
        assert_eq!(
            q(Query {
                exit: Some("running".into()),
                ..Query::default()
            })
            .runs[0]
                .id,
            c
        );
        assert_eq!(
            q(Query {
                query: Some("artisan".into()),
                ..Query::default()
            })
            .total,
            1
        );
        assert_eq!(
            q(Query {
                query: Some("PULL".into()),
                ..Query::default()
            })
            .total,
            2,
            "case-insensitive"
        );
        // % and _ are literal, not wildcards.
        assert_eq!(
            q(Query {
                query: Some("100%_".into()),
                ..Query::default()
            })
            .total,
            1
        );
        assert_eq!(
            q(Query {
                query: Some("%".into()),
                ..Query::default()
            })
            .total,
            1
        );
        let combo = q(Query {
            query: Some("pull".into()),
            env: Some("prod".into()),
            ..Query::default()
        });
        assert_eq!((combo.total, combo.runs[0].id), (1, c));
        let since = q(Query {
            since_ms: Some(now_ms() + 60_000),
            ..Query::default()
        });
        assert_eq!(since.total, 0);
        let paged = q(Query {
            limit: Some(1),
            offset: Some(1),
            ..Query::default()
        });
        assert_eq!((paged.total, paged.runs.len(), paged.runs[0].id), (3, 1, b));
    }

    #[test]
    fn reopen_marks_interrupted_runs_finished() {
        let dir = std::env::temp_dir().join(format!("kemudi-audit-test-{}", std::process::id()));
        let path = dir.join("audit.db");
        let _ = std::fs::remove_dir_all(&dir);
        let id = {
            let log = AuditLog::open(&path).expect("open");
            log.start(&run("stg", "log", "staging", "tail -f x"))
                .expect("start")
        };
        let log = AuditLog::open(&path).expect("reopen");
        let r = log.get(id).expect("get").expect("row");
        assert!(r.finished_at.is_some() && r.exit_code.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
