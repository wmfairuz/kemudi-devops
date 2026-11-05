//! A read-only look into a Laravel app's database: its tables, a table's
//! rows (sorted, filtered, a page at a time) and your own SELECTs.
//!
//! Nothing connects from the Mac: a short PHP script runs in the app's
//! folder over ssh (as the owner of its storage/, like Queues), reads the
//! app's own database config the way Laravel does (its .env, or the cached
//! config) without booting the app, and answers in JSON. The password stays
//! on the server and is never printed.
//!
//! Every query runs inside a read-only transaction (MySQL / MariaDB /
//! Postgres) or with `query_only` (SQLite), so the database itself refuses
//! writes; only statements that read are sent at all, one at a time, with a
//! 10 s limit. Rows aren't kept anywhere on the Mac.

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::AppState;

/// argv[1]: the request (base64 JSON). Prints `@@json {…}` or `@@err why`.
/// PHP 7.1 syntax on purpose (old servers).
const PHP: &str = r#"<?php
error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);
ini_set('display_errors', 'stderr');
set_time_limit(25);
$J = (defined('JSON_INVALID_UTF8_SUBSTITUTE') ? JSON_INVALID_UTF8_SUBSTITUTE : 0) | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
function kerr($m) { echo "\n@@err " . str_replace(array("\r", "\n"), ' ', $m) . "\n"; exit(0); }
$req = json_decode(base64_decode(isset($argv[1]) ? $argv[1] : ''), true);
if (!is_array($req)) kerr("Kemudi's request didn't arrive whole");
$base = getcwd();
if (!is_readable($base . '/vendor/autoload.php')) kerr("can't read vendor/autoload.php (composer install not run, or not readable as " . get_current_user() . ")");
try {
    require $base . '/vendor/autoload.php';
    $app = new Illuminate\Foundation\Application($base);
} catch (Throwable $e) { kerr("Laravel didn't load: " . $e->getMessage()); }

// The .env as Laravel loads it, unless the config is cached. Its errors are
// never shown: they can quote a value from the file.
if (!$app->configurationIsCached() && is_file($app->environmentFilePath())) {
    if (!is_readable($app->environmentFilePath())) kerr('.env is not readable as ' . get_current_user());
    try {
        if (class_exists('Illuminate\Support\Env') && method_exists('Illuminate\Support\Env', 'getRepository')) {
            Dotenv\Dotenv::create(Illuminate\Support\Env::getRepository(), $app->environmentPath(), $app->environmentFile())->safeLoad();
        } elseif (method_exists('Dotenv\Dotenv', 'create')) {
            Dotenv\Dotenv::create($app->environmentPath(), $app->environmentFile())->safeLoad();
        } else {
            (new Dotenv\Dotenv($app->environmentPath(), $app->environmentFile()))->load();
        }
    } catch (Throwable $e) { kerr("the .env file couldn't be read (" . get_class($e) . ")"); }
}
try {
    (new Illuminate\Foundation\Bootstrap\LoadConfiguration)->bootstrap($app);
} catch (Throwable $e) { kerr("Laravel's config didn't load: " . $e->getMessage()); }

$cfg = $app['config'];
$name = (string) $cfg->get('database.default');
$c = $cfg->get('database.connections.' . $name);
if (!is_array($c)) kerr("the connection `$name` isn't in the database config");
$driver = isset($c['driver']) ? $c['driver'] : '';
$my = $driver === 'mysql' || $driver === 'mariadb';
$pg = $driver === 'pgsql';
$lite = $driver === 'sqlite';
if (!$my && !$pg && !$lite) kerr("Kemudi reads MySQL, MariaDB, Postgres and SQLite; this app's database is $driver");
if ($my && defined('PDO::MYSQL_ATTR_MULTI_STATEMENTS')) {
    $o = isset($c['options']) && is_array($c['options']) ? $c['options'] : array();
    $o[PDO::MYSQL_ATTR_MULTI_STATEMENTS] = false;
    $c['options'] = $o;
}
try {
    $conn = (new Illuminate\Database\Connectors\ConnectionFactory($app))->make($c, $name);
    $pdo = $conn->getReadPdo();
} catch (Throwable $e) { kerr("couldn't connect to the database: " . $e->getMessage()); }
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->setAttribute(PDO::ATTR_ORACLE_NULLS, PDO::NULL_NATURAL);
$quiet = function ($sql) use ($pdo) { try { $pdo->exec($sql); } catch (Throwable $e) {} };
try {
    if ($my) {
        $quiet('SET SESSION max_execution_time = 10000');
        $quiet('SET SESSION max_statement_time = 10');
        $pdo->exec('SET SESSION TRANSACTION READ ONLY');
        $pdo->exec('START TRANSACTION READ ONLY');
        $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
    } elseif ($pg) {
        $pdo->exec('BEGIN READ ONLY');
        $pdo->exec("SET LOCAL statement_timeout = '10s'");
    } else {
        $pdo->exec('PRAGMA query_only = ON');
    }
} catch (Throwable $e) { kerr("the database wouldn't start a read-only transaction, so Kemudi won't query it: " . $e->getMessage()); }

$qi = function ($n) use ($my) {
    return $my ? '`' . str_replace('`', '``', $n) . '`' : '"' . str_replace('"', '""', $n) . '"';
};
$all = function ($sql, $args = array()) use ($pdo) {
    $st = $pdo->prepare($sql);
    $st->execute($args);
    $r = $st->fetchAll(PDO::FETCH_NUM);
    $st->closeCursor();
    return $r;
};
$mode = isset($req['mode']) ? $req['mode'] : '';
$out = array('driver' => $driver, 'database' => isset($c['database']) ? basename((string) $c['database']) : '', 'connection' => $name);

if ($mode === 'tables') {
    try {
        if ($my) {
            $rows = $all("SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME");
            $kind = function ($t) { return stripos($t, 'VIEW') !== false ? 'view' : 'table'; };
        } elseif ($pg) {
            $rows = $all("SELECT c.relname, c.relkind, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END, pg_total_relation_size(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN ('r','v','m','p','f') ORDER BY c.relname");
            $kind = function ($t) { return $t === 'v' || $t === 'm' ? 'view' : 'table'; };
        } else {
            $rows = $all("SELECT name, type, NULL, NULL FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
            $kind = function ($t) { return $t; };
        }
    } catch (Throwable $e) { kerr("couldn't list the tables: " . $e->getMessage()); }
    $out['tables'] = array();
    foreach ($rows as $r) {
        $out['tables'][] = array('name' => (string) $r[0], 'kind' => $kind((string) $r[1]), 'rows' => $r[2] === null ? null : (int) $r[2], 'bytes' => $r[3] === null ? null : (int) $r[3]);
    }
    $out['version'] = (string) $pdo->getAttribute(PDO::ATTR_SERVER_VERSION);
    echo "\n@@json " . json_encode($out, $J) . "\n";
    exit(0);
}

$limit = max(1, min(500, (int) (isset($req['limit']) ? $req['limit'] : 100)));
$offset = max(0, (int) (isset($req['offset']) ? $req['offset'] : 0));
$full = isset($req['full']) && is_array($req['full']) ? $req['full'] : null;
if ($full) { $offset += (int) $full['row']; $limit = 1; }
$cap = $full ? 1048576 : 300;
$columns = array();
$args = array();

if ($mode === 'browse') {
    $table = isset($req['table']) ? (string) $req['table'] : '';
    try {
        if ($my) {
            $cols = $all("SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY = 'PRI' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", array($table));
        } elseif ($pg) {
            $cols = $all("SELECT a.attname, format_type(a.atttypid, a.atttypmod), COALESCE(a.attnum = ANY(i.indkey), false) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary WHERE n.nspname = current_schema() AND c.relname = ? AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum", array($table));
        } else {
            $cols = array();
            foreach ($all('PRAGMA table_info(' . $qi($table) . ')') as $r) $cols[] = array($r[1], $r[2], (int) $r[5] > 0);
        }
    } catch (Throwable $e) { kerr("couldn't read the columns of $table: " . $e->getMessage()); }
    if (!$cols) kerr("there's no table `$table` any more");
    $names = array();
    $pk = array();
    foreach ($cols as $r) {
        $columns[] = array('name' => (string) $r[0], 'type' => (string) $r[1], 'key' => (bool) $r[2]);
        $names[(string) $r[0]] = true;
        if ($r[2]) $pk[] = (string) $r[0];
    }
    $where = array();
    foreach ((isset($req['filters']) && is_array($req['filters']) ? $req['filters'] : array()) as $f) {
        $col = isset($f['column']) ? (string) $f['column'] : '';
        if (!isset($names[$col])) kerr("no column `$col` in $table");
        $v = isset($f['value']) ? (string) $f['value'] : '';
        $q = $qi($col);
        $text = $pg ? 'CAST(' . $q . ' AS TEXT)' : $q;
        $like = '%' . addcslashes($v, '%_\\') . '%';
        switch (isset($f['op']) ? $f['op'] : '') {
            case 'eq': $where[] = "$q = ?"; $args[] = $v; break;
            case 'ne': $where[] = "$q <> ?"; $args[] = $v; break;
            case 'lt': $where[] = "$q < ?"; $args[] = $v; break;
            case 'gt': $where[] = "$q > ?"; $args[] = $v; break;
            case 'contains': $where[] = $text . ($pg ? ' ILIKE ?' : ' LIKE ?'); $args[] = $like; break;
            case 'starts': $where[] = $text . ($pg ? ' ILIKE ?' : ' LIKE ?'); $args[] = addcslashes($v, '%_\\') . '%'; break;
            case 'null': $where[] = "$q IS NULL"; break;
            case 'notnull': $where[] = "$q IS NOT NULL"; break;
            default: kerr('unknown filter');
        }
    }
    $sort = isset($req['sort']) && is_array($req['sort']) ? $req['sort'] : null;
    if ($sort && !isset($names[(string) $sort['column']])) kerr("no column `" . $sort['column'] . "` in $table");
    $order = $sort ? array($qi((string) $sort['column']) . (!empty($sort['desc']) ? ' DESC' : ' ASC')) : array_map($qi, $pk);
    $sql = 'SELECT * FROM ' . $qi($table) . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ($order ? ' ORDER BY ' . implode(', ', $order) : '');
    $shown = $sql;
    foreach ($args as $a) { $p = strpos($shown, '?'); if ($p !== false) $shown = substr_replace($shown, $pdo->quote($a), $p, 1); }
    $out['sql'] = $shown . ' LIMIT ' . $limit . ($offset ? ' OFFSET ' . $offset : '');
    $sql .= ' LIMIT ' . ($limit + 1) . ' OFFSET ' . $offset;
    $t0 = microtime(true);
    try { $st = $pdo->prepare($sql); $st->execute($args); } catch (Throwable $e) { kerr($e->getMessage()); }
    $skip = 0;
} elseif ($mode === 'sql') {
    $sql = rtrim(trim(isset($req['sql']) ? (string) $req['sql'] : ''), "; \t\r\n");
    // The first word, after comments and opening brackets.
    $head = preg_replace('~^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|/\*.*?\*/|\()+~s', '', $sql);
    $word = strtolower(preg_match('~^[A-Za-z]+~', $head, $m) ? $m[0] : '');
    if ($sql === '') kerr('write a query first');
    if (!in_array($word, array('select', 'with', 'show', 'describe', 'desc', 'explain', 'table', 'values'), true)) {
        kerr('Kemudi only reads: SELECT, WITH, SHOW, DESCRIBE or EXPLAIN (this starts with ' . ($word === '' ? 'something else' : strtoupper($word)) . ')');
    }
    if (preg_match('~\binto\s+(outfile|dumpfile)\b|\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b|\block\s+in\s+share\s+mode\b~i', $sql)) {
        kerr('Kemudi only reads: no INTO OUTFILE and no locking (FOR UPDATE / FOR SHARE)');
    }
    $out['sql'] = $sql;
    $t0 = microtime(true);
    $skip = 0;
    try {
        if ($pg && in_array($word, array('select', 'with', 'table', 'values'), true)) {
            $pdo->exec('DECLARE kemudi_c NO SCROLL CURSOR FOR ' . $sql);
            if ($offset > 0) $pdo->exec('MOVE FORWARD ' . $offset . ' IN kemudi_c');
            $st = $pdo->query('FETCH FORWARD ' . ($limit + 1) . ' FROM kemudi_c');
        } else {
            try {
                $st = $pdo->prepare($sql);
                $st->execute();
            } catch (PDOException $e) {
                // A SHOW the prepared protocol doesn't take (1295): as text.
                if (!$my || strpos($e->getMessage(), '1295') === false) throw $e;
                $pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, true);
                $st = $pdo->query($sql);
            }
            $skip = $offset;
        }
    } catch (Throwable $e) { kerr($e->getMessage()); }
} else {
    kerr('unknown request');
}

$rows = array();
$cut = array();
$bin = array();
$more = false;
try {
    $n = $st->columnCount();
    if (!$columns) {
        for ($i = 0; $i < $n; $i++) {
            $m = $st->getColumnMeta($i);
            $columns[] = array('name' => (string) (isset($m['name']) ? $m['name'] : $i), 'type' => strtolower((string) (isset($m['native_type']) ? $m['native_type'] : '')), 'key' => false);
        }
    }
    while ($skip > 0 && $st->fetch(PDO::FETCH_NUM) !== false) $skip--;
    while (($r = $st->fetch(PDO::FETCH_NUM)) !== false) {
        if (count($rows) === $limit) { $more = true; break; }
        $ri = count($rows);
        foreach ($r as $ci => $v) {
            if (is_resource($v)) $v = stream_get_contents($v);
            if ($v === null) { $r[$ci] = null; continue; }
            if (is_bool($v)) { $r[$ci] = $v ? 'true' : 'false'; continue; }
            $v = (string) $v;
            if (strpos($v, "\0") !== false || !preg_match('//u', $v)) {
                $bin[] = array($ri, $ci);
                $hex = $full ? 65536 : 32;
                if (strlen($v) > $hex) $cut[] = array($ri, $ci, strlen($v));
                $r[$ci] = '0x' . bin2hex(substr($v, 0, $hex));
                continue;
            }
            if (strlen($v) > $cap) {
                $t = substr($v, 0, $cap);
                while ($t !== '' && !preg_match('//u', $t)) $t = substr($t, 0, -1);
                $cut[] = array($ri, $ci, strlen($v));
                $v = $t;
            }
            $r[$ci] = $v;
        }
        $rows[] = $r;
    }
    $st->closeCursor();
} catch (Throwable $e) { kerr($e->getMessage()); }
$out['ms'] = (int) round((microtime(true) - $t0) * 1000);
$out['columns'] = $columns;
$out['rows'] = $rows;
$out['cut'] = $cut;
$out['bin'] = $bin;
$out['more'] = $more;
echo "\n@@json " . json_encode($out, $J) . "\n";
"#;

/// What to read (see the PHP above).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DbRequest {
    /// "browse" or "sql".
    pub mode: String,
    pub table: String,
    pub sql: String,
    pub sort: Option<DbSort>,
    pub filters: Vec<DbFilter>,
    pub offset: u64,
    pub limit: u32,
    /// Just this cell, whole (a row of the page, a column).
    pub full: Option<DbCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSort {
    pub column: String,
    pub desc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbFilter {
    pub column: String,
    /// eq ne lt gt contains starts null notnull
    pub op: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbCell {
    pub row: u32,
    pub col: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DbTable {
    pub name: String,
    /// "table" or "view".
    pub kind: String,
    /// The database's estimate (InnoDB's is rough).
    pub rows: Option<u64>,
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DbTables {
    pub driver: String,
    pub database: String,
    pub connection: String,
    pub version: String,
    pub tables: Vec<DbTable>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DbColumn {
    pub name: String,
    pub r#type: String,
    /// Part of the primary key (browse only).
    pub key: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DbResult {
    pub driver: String,
    pub database: String,
    /// What ran (browse: with the filter values in).
    pub sql: String,
    pub ms: u64,
    pub columns: Vec<DbColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Cells cut short: [row, col, whole length in bytes].
    pub cut: Vec<(u32, u32, u64)>,
    /// Binary cells (shown as 0x…): [row, col].
    pub bin: Vec<(u32, u32)>,
    /// There are more rows after this page.
    pub more: bool,
}

fn script(path: &str, php: &str, req: &serde_json::Value, password: Option<&str>) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(req.to_string());
    format!(
        r#"{pre}echo @@php
$RU "$PHP" -- {b64} 2>&1 <<'KEMUDI_PHP'
{code}KEMUDI_PHP
"#,
        pre = crate::queues::prelude(path, php, password),
        code = PHP,
    )
}

/// The `@@json` line, or why there's none.
fn answer(out: &str) -> AppResult<&str> {
    crate::queues::php_json(out).map_err(AppError::Invalid)
}

async fn ask(state: &AppState, server_id: &str, app_id: &str, req: serde_json::Value) -> AppResult<String> {
    let (_, path, php) = crate::queues::app_of(state, server_id, app_id)?;
    let password = crate::remote_files::saved_sudo(server_id).await;
    crate::monitor::run_for(state, server_id, &script(&path, &php, &req, password.as_deref()), 30).await
}

fn check(req: &DbRequest) -> AppResult<()> {
    let bad = |s: &str| s.contains('\0');
    let ok = match req.mode.as_str() {
        "browse" => !req.table.is_empty() && req.table.len() <= 256 && !bad(&req.table),
        "sql" => !req.sql.trim().is_empty() && req.sql.len() <= 60_000 && !bad(&req.sql),
        _ => false,
    };
    if !ok
        || req.filters.len() > 20
        || req.filters.iter().any(|f| bad(&f.column) || bad(&f.value) || f.value.len() > 10_000)
        || req.limit > 500
        || req.offset > 100_000_000
    {
        return Err(AppError::Invalid("that query isn't one Kemudi sends".into()));
    }
    Ok(())
}

/// The tables (and views) of an app's database.
#[tauri::command]
pub async fn db_tables(state: State<'_, AppState>, server_id: String, app_id: String) -> AppResult<DbTables> {
    let out = ask(&state, &server_id, &app_id, serde_json::json!({ "mode": "tables" })).await?;
    serde_json::from_str(answer(&out)?).map_err(|e| AppError::Invalid(format!("the answer didn't read: {e}")))
}

/// A page of a table, or of your own read-only query.
#[tauri::command]
pub async fn db_query(state: State<'_, AppState>, server_id: String, app_id: String, req: DbRequest) -> AppResult<DbResult> {
    check(&req)?;
    let json = serde_json::to_value(&req).map_err(|e| AppError::Invalid(e.to_string()))?;
    let out = ask(&state, &server_id, &app_id, json).await?;
    serde_json::from_str(answer(&out)?).map_err(|e| AppError::Invalid(format!("the answer didn't read: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_answer() {
        let out = "@@user www-data\n@@php\n\n@@json {\"driver\":\"mysql\",\"database\":\"shop\",\"sql\":\"SELECT 1\",\"ms\":3,\"columns\":[{\"name\":\"1\",\"type\":\"longlong\",\"key\":false}],\"rows\":[[\"1\"],[null]],\"cut\":[[0,0,900]],\"bin\":[],\"more\":true}\n";
        let r: DbResult = serde_json::from_str(answer(out).unwrap()).unwrap();
        assert_eq!(r.rows, vec![vec![Some("1".to_string())], vec![None]]);
        assert_eq!(r.cut, vec![(0, 0, 900)]);
        assert!(r.more);
    }

    #[test]
    fn says_why() {
        let out = "@@php\n\n@@err couldn't connect to the database: SQLSTATE[HY000] [2002] Connection refused\n";
        assert!(answer(out).unwrap_err().to_string().contains("Connection refused"));
    }

    #[test]
    fn checks_requests() {
        let sql = |s: &str| DbRequest { mode: "sql".into(), sql: s.into(), limit: 100, ..Default::default() };
        assert!(check(&sql("select 1")).is_ok());
        assert!(check(&sql("  ")).is_err());
        assert!(check(&DbRequest { mode: "drop".into(), ..Default::default() }).is_err());
        assert!(check(&DbRequest { limit: 501, ..sql("select 1") }).is_err());
        assert!(check(&DbRequest { mode: "browse".into(), table: "users".into(), ..Default::default() }).is_ok());
    }

    #[test]
    fn request_goes_as_base64() {
        let s = script("/opt/www/app", "php", &serde_json::json!({"mode": "sql", "sql": "select 'x'"}), None);
        assert!(s.contains("$RU \"$PHP\" -- eyJ"));
        assert!(!s.contains("select 'x'"));
        assert!(s.contains("START TRANSACTION READ ONLY"));
    }
}
