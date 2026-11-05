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
// A dump's stdout is the file: its errors go to stderr.
function kerr($m) {
    $l = "\n@@err " . str_replace(array("\r", "\n"), ' ', $m) . "\n";
    if (!empty($GLOBALS['toErr'])) fwrite(STDERR, $l); else echo $l;
    exit(0);
}
$req = json_decode(base64_decode(isset($argv[1]) ? $argv[1] : ''), true);
if (!is_array($req)) kerr("Kemudi's request didn't arrive whole");
$mode = isset($req['mode']) ? $req['mode'] : '';
$toErr = $mode === 'dump';
// These change data (each in its own transaction); everything else reads.
$writing = in_array($mode, array('update', 'write', 'insert_row', 'delete_row'), true);
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
    // rowCount() = rows matched (an update to the same value counts).
    if ($mode === 'update') $o[PDO::MYSQL_ATTR_FOUND_ROWS] = true;
    $c['options'] = $o;
}
if ($mode === 'dump' && $pg) {
    // pg_dump knows Postgres best; one snapshot is how it always works.
    set_time_limit(0);
    exec('command -v pg_dump', $o, $rc);
    if ($rc !== 0) kerr("pg_dump isn't installed on this server (apt install postgresql-client)");
    $tables = isset($req['tables']) && is_array($req['tables']) ? $req['tables'] : array();
    $host = isset($c['host']) ? (is_array($c['host']) ? reset($c['host']) : $c['host']) : '';
    $args = array('pg_dump', '--no-owner', '--no-privileges', '--encoding=UTF8');
    if (empty($req['data'])) $args[] = '--schema-only';
    if (!empty($req['drop'])) { $args[] = '--clean'; $args[] = '--if-exists'; }
    if ($host !== '') { $args[] = '-h'; $args[] = (string) $host; }
    if (!empty($c['port'])) { $args[] = '-p'; $args[] = (string) $c['port']; }
    if (!empty($c['username'])) { $args[] = '-U'; $args[] = (string) $c['username']; }
    foreach ($tables as $t) { $args[] = '-t'; $args[] = (string) $t; }
    $args[] = (string) $c['database'];
    $env = array('PGPASSWORD' => isset($c['password']) ? (string) $c['password'] : '', 'PATH' => getenv('PATH'));
    if (!empty($c['sslmode'])) $env['PGSSLMODE'] = (string) $c['sslmode'];
    fwrite(STDERR, "@@table 1 1 pg_dump\n");
    $p = proc_open(implode(' ', array_map('escapeshellarg', $args)), array(1 => STDOUT, 2 => array('pipe', 'w')), $pipes, null, $env);
    if (!is_resource($p)) kerr("pg_dump didn't start");
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    $rc = proc_close($p);
    if ($rc !== 0) kerr('pg_dump: ' . trim($err));
    fwrite(STDERR, "\n@@done\n");
    exit(0);
}
try {
    $conn = (new Illuminate\Database\Connectors\ConnectionFactory($app))->make($c, $name);
    $pdo = $writing ? $conn->getPdo() : $conn->getReadPdo();
} catch (Throwable $e) { kerr("couldn't connect to the database: " . $e->getMessage()); }
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->setAttribute(PDO::ATTR_ORACLE_NULLS, PDO::NULL_NATURAL);
$quiet = function ($sql) use ($pdo) { try { $pdo->exec($sql); } catch (Throwable $e) {} };
if ($mode === 'dump') {
    // One consistent snapshot for the whole dump (InnoDB: nothing locked).
    set_time_limit(0);
    try {
        if ($my) {
            $quiet('SET SESSION max_execution_time = 0');
            $quiet('SET SESSION max_statement_time = 0');
            $quiet('SET SESSION net_write_timeout = 3600');
            $quiet("SET SESSION time_zone = '+00:00'");
            $pdo->exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            $pdo->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
            $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
            // Values exactly as the server writes them (no float rounding).
            $pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, true);
            $pdo->setAttribute(PDO::ATTR_STRINGIFY_FETCHES, true);
        } else {
            $pdo->exec('PRAGMA query_only = ON');
            $pdo->exec('BEGIN');
        }
    } catch (Throwable $e) { kerr("the database wouldn't start a read-only snapshot: " . $e->getMessage()); }
} elseif ($writing) {
    $secs = $mode === 'write' ? 30 : 10;
    try {
        if ($my) {
            $quiet('SET SESSION innodb_lock_wait_timeout = 5');
            $quiet("SET SESSION max_statement_time = $secs");
            $pdo->beginTransaction();
        } elseif ($pg) {
            $pdo->beginTransaction();
            $pdo->exec("SET LOCAL statement_timeout = '{$secs}s'");
            $pdo->exec("SET LOCAL lock_timeout = '5s'");
        } else {
            $pdo->beginTransaction();
        }
    } catch (Throwable $e) { kerr("couldn't start a transaction: " . $e->getMessage()); }
} else try {
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
// A table's columns: [[name, type, primary key?], …].
$columnsOf = function ($table) use ($all, $qi, $my, $pg) {
    try {
        if ($my) {
            $cols = array();
            foreach ($all("SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY = 'PRI', IS_NULLABLE = 'YES', COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", array($table)) as $r) {
                $cols[] = array($r[0], $r[1], (bool) $r[2], (bool) $r[3], $r[4], stripos((string) $r[5], 'auto_increment') !== false || stripos((string) $r[5], 'generated') !== false);
            }
            return $cols;
        }
        if ($pg) {
            $cols = array();
            foreach ($all("SELECT a.attname, format_type(a.atttypid, a.atttypmod), COALESCE(a.attnum = ANY(i.indkey), false), NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE n.nspname = current_schema() AND c.relname = ? AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum", array($table)) as $r) {
                $cols[] = array($r[0], $r[1], (bool) $r[2], (bool) $r[3], $r[4], ($r[5] !== null && $r[5] !== '') || strpos((string) $r[4], 'nextval(') === 0);
            }
            return $cols;
        }
        $cols = array();
        $pks = 0;
        $rows = $all('PRAGMA table_info(' . $qi($table) . ')');
        foreach ($rows as $r) if ((int) $r[5] > 0) $pks++;
        foreach ($rows as $r) $cols[] = array($r[1], $r[2], (int) $r[5] > 0, !(int) $r[3], $r[4], (int) $r[5] > 0 && $pks === 1 && strtoupper((string) $r[2]) === 'INTEGER');
        return $cols;
    } catch (Throwable $e) { kerr("couldn't read the columns of $table: " . $e->getMessage()); }
};
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

$ok = function () use (&$out, $J) { echo "\n@@json " . json_encode($out, $J) . "\n"; exit(0); };
$rollback = function () use ($pdo) { try { if ($pdo->inTransaction()) $pdo->rollBack(); } catch (Throwable $e) {} };
// A table's columns and its primary key, or why not.
$tableOf = function ($table) use ($columnsOf) {
    $cols = $columnsOf($table);
    if (!$cols) kerr("there's no table `$table` any more");
    $names = array();
    $pk = array();
    foreach ($cols as $r) { $names[(string) $r[0]] = $r; if ($r[2]) $pk[] = (string) $r[0]; }
    return array($names, $pk);
};
// WHERE for a row named by its whole primary key.
$keyed = function ($pk, $key, $table) use ($qi) {
    if (!$pk) kerr("$table has no primary key, so a row can't be picked out safely: nothing changed");
    $given = array();
    foreach ((is_array($key) ? $key : array()) as $k) $given[(string) $k['column']] = $k['value'];
    $a = $pk; $b = array_keys($given); sort($a); sort($b);
    if ($a !== $b) kerr("the row has to be named by its whole primary key (" . implode(', ', $pk) . "): nothing changed");
    $where = array();
    $args = array();
    foreach ($pk as $k) {
        if ($given[$k] === null) kerr("the row's key `$k` is NULL: nothing changed");
        $where[] = $qi($k) . ' = ?';
        $args[] = (string) $given[$k];
    }
    return array(implode(' AND ', $where), $args);
};

if ($mode === 'schema') {
    try {
        if ($my) {
            $rows = $all("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION");
        } elseif ($pg) {
            $rows = $all("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position");
        } else {
            $rows = array();
            foreach ($all("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name") as $t) {
                foreach ($all('PRAGMA table_info(' . $qi($t[0]) . ')') as $r) $rows[] = array($t[0], $r[1]);
            }
        }
    } catch (Throwable $e) { kerr("couldn't read the columns: " . $e->getMessage()); }
    $by = array();
    foreach ($rows as $r) $by[(string) $r[0]][] = (string) $r[1];
    $out['tables'] = array();
    foreach ($by as $t => $cs) $out['tables'][] = array('name' => $t, 'columns' => $cs);
    $ok();
}

if ($mode === 'write') {
    // Your own INSERT / UPDATE / DELETE: `dry` runs it and undoes it (how
    // many rows), then for real only if it changes that many again.
    $sql = rtrim(trim(isset($req['sql']) ? (string) $req['sql'] : ''), "; \t\r\n");
    $head = preg_replace('~^(\s+|--[^\n]*(\n|$)|#[^\n]*(\n|$)|/\*.*?\*/|\()+~s', '', $sql);
    $word = strtolower(preg_match('~^[A-Za-z]+~', $head, $m) ? $m[0] : '');
    if (!in_array($word, array('insert', 'update', 'delete', 'replace'), true)) {
        kerr('Kemudi changes data with INSERT, UPDATE or DELETE only (this starts with ' . ($word === '' ? 'something else' : strtoupper($word)) . '): no ALTER, DROP, TRUNCATE or CREATE');
    }
    if ($my) {
        try {
            $nt = $all("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND ENGINE IS NOT NULL AND ENGINE <> 'InnoDB'");
        } catch (Throwable $e) { $nt = array(); }
        foreach ($nt as $t) {
            if (preg_match('~(^|[^A-Za-z0-9_$])' . preg_quote((string) $t[0], '~') . '([^A-Za-z0-9_$]|$)~i', $sql)) {
                kerr("$t[0] is a $t[1] table: a change to it can't be undone, so Kemudi won't try or run it here");
            }
        }
    }
    $dry = !empty($req['dry']);
    $t0 = microtime(true);
    try {
        $st = $pdo->prepare($sql);
        $st->execute();
        $n = $st->rowCount();
        $st->closeCursor();
        if ($dry) {
            $pdo->rollBack();
        } else {
            $want = isset($req['expect']) ? (int) $req['expect'] : -1;
            if ($n !== $want) { $pdo->rollBack(); kerr("it now changes $n rows, not the $want you confirmed: nothing changed (try again)"); }
            $pdo->commit();
        }
    } catch (Throwable $e) { $rollback(); kerr($e->getMessage()); }
    $out['affected'] = $n;
    $out['ms'] = (int) round((microtime(true) - $t0) * 1000);
    $ok();
}

if ($mode === 'insert_row') {
    $table = isset($req['table']) ? (string) $req['table'] : '';
    list($names) = $tableOf($table);
    $cols = array(); $vals = array(); $args = array();
    foreach ((isset($req['values']) && is_array($req['values']) ? $req['values'] : array()) as $v) {
        $col = (string) $v['column'];
        if (!isset($names[$col])) kerr("no column `$col` in $table");
        $kind = isset($v['kind']) ? $v['kind'] : 'value';
        if ($kind === 'default') continue;
        $cols[] = $qi($col);
        if ($kind === 'null') $vals[] = 'NULL';
        elseif ($kind === 'now') $vals[] = 'CURRENT_TIMESTAMP';
        else { $vals[] = '?'; $args[] = (string) $v['value']; }
    }
    $sql = $cols ? 'INSERT INTO ' . $qi($table) . ' (' . implode(', ', $cols) . ') VALUES (' . implode(', ', $vals) . ')' : ($my ? 'INSERT INTO ' . $qi($table) . ' () VALUES ()' : 'INSERT INTO ' . $qi($table) . ' DEFAULT VALUES');
    $t0 = microtime(true);
    try {
        $st = $pdo->prepare($sql);
        $st->execute($args);
        if ($st->rowCount() !== 1) { $pdo->rollBack(); kerr('it would add ' . $st->rowCount() . ' rows, so nothing changed'); }
        $pdo->commit();
    } catch (Throwable $e) { $rollback(); kerr($e->getMessage()); }
    $out['affected'] = 1;
    $out['ms'] = (int) round((microtime(true) - $t0) * 1000);
    $ok();
}

if ($mode === 'delete_row') {
    $table = isset($req['table']) ? (string) $req['table'] : '';
    list($names, $pk) = $tableOf($table);
    list($where, $args) = $keyed($pk, isset($req['key']) ? $req['key'] : array(), $table);
    $t0 = microtime(true);
    try {
        $st = $pdo->prepare('DELETE FROM ' . $qi($table) . ' WHERE ' . $where);
        $st->execute($args);
        $n = $st->rowCount();
        if ($n !== 1) { $pdo->rollBack(); kerr($n === 0 ? "nothing changed: the row isn't there any more" : "it would delete $n rows, so nothing changed"); }
        $pdo->commit();
    } catch (Throwable $e) { $rollback(); kerr($e->getMessage()); }
    $out['affected'] = 1;
    $out['ms'] = (int) round((microtime(true) - $t0) * 1000);
    $ok();
}

if ($mode === 'dump') {
    // MySQL / MariaDB and SQLite (Postgres went to pg_dump above): the file
    // on stdout, progress and the outcome on stderr.
    $want = isset($req['tables']) && is_array($req['tables']) ? array_flip(array_map('strval', $req['tables'])) : null;
    $data = !empty($req['data']);
    $drop = !empty($req['drop']);
    $buf = '';
    $w = function ($s) use (&$buf) { $buf .= $s; if (strlen($buf) > 262144) { fwrite(STDOUT, $buf); $buf = ''; } };
    $say = function ($s) { fwrite(STDERR, $s . "\n"); };
    try {
        if ($my) {
            $list = $all("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME");
        } else {
            $list = $all("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
        }
    } catch (Throwable $e) { kerr("couldn't list the tables: " . $e->getMessage()); }
    $tables = array(); $views = array();
    foreach ($list as $r) {
        if ($want !== null && !isset($want[(string) $r[0]])) continue;
        if (stripos((string) $r[1], 'view') !== false) $views[] = (string) $r[0]; else $tables[] = (string) $r[0];
    }
    $total = count($tables) + count($views);
    $db = isset($c['database']) ? basename((string) $c['database']) : '';
    $w("-- Kemudi Devops SQL dump\n-- Database: $db (" . $driver . ' ' . $pdo->getAttribute(PDO::ATTR_SERVER_VERSION) . ")\n-- Taken: " . gmdate('Y-m-d H:i:s') . " UTC, in one consistent snapshot\n-- " . ($data ? 'Structure and data' : 'Structure only') . "; triggers, routines and events aren't included.\n\n");
    if ($my) {
        $w("/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n/*!40101 SET NAMES utf8mb4 */;\n/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;\n/*!40103 SET TIME_ZONE='+00:00' */;\n/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\n");
    } else {
        $w("PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n");
    }
    $i = 0;
    $rowsAll = 0;
    foreach ($tables as $t) {
        $i++;
        $say("@@table $i $total $t");
        $w("--\n-- Table " . $qi($t) . "\n--\n\n");
        if ($drop) $w('DROP TABLE IF EXISTS ' . $qi($t) . ";\n");
        try {
            if ($my) {
                $cr = $all('SHOW CREATE TABLE ' . $qi($t));
                $w($cr[0][1] . ";\n\n");
                $cs = $all("SELECT COLUMN_NAME, DATA_TYPE, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", array($t));
            } else {
                $cr = $all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", array($t));
                $w($cr[0][0] . ";\n\n");
                $cs = array();
                foreach ($all('PRAGMA table_info(' . $qi($t) . ')') as $r) $cs[] = array($r[1], strtolower((string) $r[2]), '');
            }
        } catch (Throwable $e) { kerr("couldn't read $t: " . $e->getMessage()); }
        if (!$data) continue;
        $names = array(); $kinds = array();
        foreach ($cs as $r) {
            if (stripos((string) $r[2], 'generated') !== false) continue; // computed: not inserted
            $names[] = $qi((string) $r[0]);
            $dt = strtolower((string) $r[1]);
            $kinds[] = preg_match('~^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)~', $dt) ? 'n'
                : (preg_match('~(blob|binary|bit|geometry|point|linestring|polygon|geometrycollection)~', $dt) ? 'b' : 's');
        }
        if (!$names) continue;
        $head = 'INSERT INTO ' . $qi($t) . ' (' . implode(', ', $names) . ') VALUES ';
        try {
            $st = $pdo->prepare('SELECT ' . implode(', ', $names) . ' FROM ' . $qi($t));
            $st->execute();
            $stmt = '';
            $n = 0;
            while (($r = $st->fetch(PDO::FETCH_NUM)) !== false) {
                $vs = array();
                foreach ($r as $k => $v) {
                    if (is_resource($v)) $v = stream_get_contents($v);
                    if ($v === null) $vs[] = 'NULL';
                    elseif ($kinds[$k] === 'n' && $v !== '' && is_numeric($v)) $vs[] = (string) $v;
                    elseif ($kinds[$k] === 'b' || (!$my && (strpos($v, "\0") !== false || !preg_match('//u', $v)))) $vs[] = $v === '' ? "''" : ($my ? '0x' . bin2hex($v) : "X'" . bin2hex($v) . "'");
                    else $vs[] = $pdo->quote((string) $v);
                }
                $tuple = '(' . implode(',', $vs) . ')';
                if ($stmt !== '' && strlen($stmt) + strlen($tuple) > 1000000) { $w($stmt . ";\n"); $stmt = ''; }
                $stmt .= ($stmt === '' ? $head : ',') . $tuple;
                $n++;
                if ($n % 5000 === 0) $say("@@rows $n");
            }
            $st->closeCursor();
            if ($stmt !== '') $w($stmt . ";\n");
            $rowsAll += $n;
            $w("\n");
        } catch (Throwable $e) { kerr("couldn't read the rows of $t: " . $e->getMessage()); }
    }
    // Views after the tables, each after the views it uses.
    $defs = array();
    foreach ($views as $v) {
        try {
            if ($my) {
                $cr = $all('SHOW CREATE VIEW ' . $qi($v));
                $defs[$v] = preg_replace('~ DEFINER=`[^`]*`@`[^`]*`~', '', (string) $cr[0][1]);
            } else {
                $cr = $all("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?", array($v));
                $defs[$v] = (string) $cr[0][0];
            }
        } catch (Throwable $e) { kerr("couldn't read the view $v: " . $e->getMessage()); }
    }
    $done = array();
    $order = array();
    $visit = function ($v, $depth) use (&$visit, &$done, &$order, $defs) {
        if (isset($done[$v]) || $depth > 50) return;
        $done[$v] = true;
        foreach ($defs as $o => $d) if ($o !== $v && preg_match('~[`" .]' . preg_quote($o, '~') . '[`" ]~', $defs[$v])) $visit($o, $depth + 1);
        $order[] = $v;
    };
    foreach (array_keys($defs) as $v) $visit($v, 0);
    foreach ($order as $v) {
        $i++;
        $say("@@table $i $total $v");
        $w("--\n-- View " . $qi($v) . "\n--\n\n");
        if ($drop) $w('DROP VIEW IF EXISTS ' . $qi($v) . ";\n");
        $w($defs[$v] . ";\n\n");
    }
    if ($my) {
        $w("/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;\n/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n");
    } else {
        $w("COMMIT;\nPRAGMA foreign_keys=ON;\n");
    }
    $w("\n-- Dump completed " . gmdate('Y-m-d H:i:s') . " UTC\n");
    fwrite(STDOUT, $buf);
    $say("@@done $total $rowsAll");
    exit(0);
}

if ($mode === 'update') {
    // One cell of one row, found by its whole primary key and only if the
    // cell still holds what was read (else someone changed it meanwhile).
    $table = isset($req['table']) ? (string) $req['table'] : '';
    $col = isset($req['column']) ? (string) $req['column'] : '';
    $cols = $columnsOf($table);
    if (!$cols) kerr("there's no table `$table` any more");
    $names = array();
    $pk = array();
    foreach ($cols as $r) { $names[(string) $r[0]] = true; if ($r[2]) $pk[] = (string) $r[0]; }
    if (!$pk) kerr("$table has no primary key, so a row can't be picked out safely: nothing changed");
    if (!isset($names[$col])) kerr("no column `$col` in $table");
    $key = isset($req['key']) && is_array($req['key']) ? $req['key'] : array();
    $given = array();
    foreach ($key as $k) $given[(string) $k['column']] = $k['value'];
    $a = $pk; $b = array_keys($given); sort($a); sort($b);
    if ($a !== $b) kerr("the row has to be named by its whole primary key (" . implode(', ', $pk) . "): nothing changed");
    $text = function ($q) use ($my, $pg) { return $my ? "CAST($q AS CHAR)" : "CAST($q AS TEXT)"; };
    $same = $my ? ' <=> ?' : ($pg ? ' IS NOT DISTINCT FROM ?' : ' IS ?');
    $where = array();
    $wargs = array();
    foreach ($pk as $k) {
        if ($given[$k] === null) kerr("the row's key `$k` is NULL: nothing changed");
        $where[] = $qi($k) . ' = ?';
        $wargs[] = (string) $given[$k];
    }
    $old = array_key_exists('old', $req) ? $req['old'] : null;
    $value = array_key_exists('value', $req) ? $req['value'] : null;
    $sql = 'UPDATE ' . $qi($table) . ' SET ' . $qi($col) . ' = ? WHERE ' . implode(' AND ', $where) . ' AND ' . $text($qi($col)) . $same;
    $t0 = microtime(true);
    try {
        $st = $pdo->prepare($sql);
        $st->execute(array_merge(array($value === null ? null : (string) $value), $wargs, array($old === null ? null : (string) $old)));
        $n = $st->rowCount();
        if ($n !== 1) {
            $pdo->rollBack();
            kerr($n === 0 ? "nothing changed: the row isn't there any more, or the cell changed since it was read (read the page again)" : "it would change $n rows, so nothing changed");
        }
        $st = $pdo->prepare('SELECT ' . $qi($col) . ' FROM ' . $qi($table) . ' WHERE ' . implode(' AND ', $where));
        $st->execute($wargs);
        $now = $st->fetchColumn();
        $st->closeCursor();
        $pdo->commit();
    } catch (Throwable $e) {
        try { $pdo->rollBack(); } catch (Throwable $e2) {}
        kerr($e->getMessage());
    }
    if (is_resource($now)) $now = stream_get_contents($now);
    $out['value'] = $now === null || $now === false ? null : (is_bool($now) ? ($now ? 'true' : 'false') : (string) $now);
    $out['ms'] = (int) round((microtime(true) - $t0) * 1000);
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
    $cols = $columnsOf($table);
    if (!$cols) kerr("there's no table `$table` any more");
    $names = array();
    $pk = array();
    foreach ($cols as $r) {
        $columns[] = array('name' => (string) $r[0], 'type' => (string) $r[1], 'key' => (bool) $r[2], 'nullable' => (bool) $r[3], 'default' => $r[4] === null ? null : (string) $r[4], 'auto' => (bool) $r[5]);
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
    /// Browse only: can be NULL, its default, filled by the database
    /// (auto-increment, identity, generated).
    pub nullable: bool,
    pub default: Option<String>,
    pub auto: bool,
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
    let res = async {
        let out = ask(&state, &server_id, &app_id, json).await?;
        serde_json::from_str(answer(&out)?).map_err(|e| AppError::Invalid(format!("the answer didn't read: {e}")))
    }
    .await;
    // Your own queries go in the history (their first page; not a cell
    // fetched whole).
    if req.mode == "sql" && req.offset == 0 && req.full.is_none() {
        record(&server_id, &app_id, &req.sql, &res);
    }
    res
}

// ------------------------------------------------------------ editing a cell

/// One cell of one row, named by its whole primary key.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DbUpdate {
    pub table: String,
    pub key: Vec<DbKey>,
    pub column: String,
    /// What the cell held when read (the update only lands if it still does).
    pub old: Option<String>,
    /// The new value (None: NULL).
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DbKey {
    pub column: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DbUpdated {
    /// The cell as the database has it now.
    pub value: Option<String>,
    pub ms: u64,
}

/// `'it''s'`, or NULL: for showing SQL (History), never for running it.
fn lit(v: Option<&str>) -> String {
    match v {
        None => "NULL".into(),
        Some(v) => {
            let v: String = if v.chars().count() > 200 { format!("{}…", v.chars().take(200).collect::<String>()) } else { v.to_string() };
            format!("'{}'", v.replace('\'', "''"))
        }
    }
}

/// The UPDATE as History shows it.
pub fn update_sql(u: &DbUpdate) -> String {
    let wh: Vec<String> = u.key.iter().map(|k| format!("{} = {}", k.column, lit(k.value.as_deref()))).collect();
    format!("UPDATE {} SET {} = {} WHERE {}", u.table, u.column, lit(u.value.as_deref()), wh.join(" AND "))
}

/// Change one cell (and nothing else): in a transaction that's rolled back
/// unless exactly one row matched. Recorded in History.
#[tauri::command]
pub async fn db_update(state: State<'_, AppState>, server_id: String, app_id: String, update: DbUpdate) -> AppResult<DbUpdated> {
    let bad = |s: &str| s.is_empty() || s.len() > 256 || s.contains('\0');
    if bad(&update.table)
        || bad(&update.column)
        || update.key.is_empty()
        || update.key.len() > 8
        || update.key.iter().any(|k| bad(&k.column))
        || update.value.as_ref().is_some_and(|v| v.len() > 60_000 || v.contains('\0'))
        || update.old.as_ref().is_some_and(|v| v.len() > 60_000 || v.contains('\0'))
    {
        return Err(AppError::Invalid("that change isn't one Kemudi sends".into()));
    }
    let server = crate::remote_files::lookup(&state, &server_id)?;
    let env = server.app(&app_id).map_or(server.env, |a| a.env);
    let shown = update_sql(&update);
    let run = state.audit.as_ref().ok().and_then(|log| {
        log.start(&crate::audit::NewRun {
            server_id: &server_id,
            app_id: Some(&app_id),
            action_id: "db-edit",
            label: &format!("Edit {}.{}", update.table, update.column),
            env: env.as_str(),
            kind: "edit",
            command: &shown,
            edited: false,
        })
        .ok()
        .map(|id| (log.clone(), id))
    });
    let mut json = serde_json::to_value(&update).map_err(|e| AppError::Invalid(e.to_string()))?;
    json["mode"] = "update".into();
    let res = async {
        let out = ask(&state, &server_id, &app_id, json).await?;
        serde_json::from_str::<DbUpdated>(answer(&out)?).map_err(|e| AppError::Invalid(format!("the answer didn't read: {e}")))
    }
    .await;
    if let Some((log, id)) = run {
        let _ = log.finish(id, Some(if res.is_ok() { 0 } else { 1 }));
    }
    res
}

// ------------------------------------------------------------ writing SQL, rows

/// What a change did.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DbChanged {
    /// Rows it changed (a dry run: would change; it was undone).
    pub affected: u64,
    pub ms: u64,
}

fn changed(out: &str) -> AppResult<DbChanged> {
    serde_json::from_str(answer(out)?).map_err(|e| AppError::Invalid(format!("the answer didn't read: {e}")))
}

/// Start a History row for a change to an app's database.
fn audit(state: &AppState, server_id: &str, app_id: &str, label: &str, sql: &str) -> Option<(std::sync::Arc<crate::audit::AuditLog>, i64)> {
    let server = crate::remote_files::lookup(state, server_id).ok()?;
    let env = server.app(app_id).map_or(server.env, |a| a.env);
    let log = state.audit.as_ref().ok()?;
    log.start(&crate::audit::NewRun {
        server_id,
        app_id: Some(app_id),
        action_id: "db-edit",
        label,
        env: env.as_str(),
        kind: "edit",
        command: sql,
        edited: false,
    })
    .ok()
    .map(|id| (log.clone(), id))
}

fn audit_end<T>(run: Option<(std::sync::Arc<crate::audit::AuditLog>, i64)>, res: &AppResult<T>) {
    if let Some((log, id)) = run {
        let _ = log.finish(id, Some(if res.is_ok() { 0 } else { 1 }));
    }
}

/// Your own INSERT / UPDATE / DELETE. `dry`: run it and undo it, to say how
/// many rows it changes. Else run it for real, kept only if it changes
/// `expect` rows again (recorded in History and the query history).
#[tauri::command]
pub async fn db_write(state: State<'_, AppState>, server_id: String, app_id: String, sql: String, dry: bool, expect: Option<u64>) -> AppResult<DbChanged> {
    if sql.trim().is_empty() || sql.len() > 60_000 || sql.contains('\0') || (!dry && expect.is_none()) {
        return Err(AppError::Invalid("that change isn't one Kemudi sends".into()));
    }
    let run = if dry { None } else { audit(&state, &server_id, &app_id, "Change data (SQL)", sql.trim()) };
    let req = serde_json::json!({ "mode": "write", "sql": sql, "dry": dry, "expect": expect });
    let res = async { changed(&ask(&state, &server_id, &app_id, req).await?) }.await;
    audit_end(run, &res);
    if !dry {
        let ran = Ran {
            at: store::now_ms(),
            sql: sql.trim().to_string(),
            ms: res.as_ref().ok().map(|r| r.ms),
            rows: res.as_ref().ok().map(|r| r.affected as u32),
            more: false,
            error: res.as_ref().err().map(|e| e.to_string().chars().take(300).collect()),
        };
        let _ = store::update(&server_id, &app_id, |q| store::ran(q, ran));
    }
    res
}

/// A value for a new row: typed, NULL, the column's default, or now.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DbNewValue {
    pub column: String,
    /// "value", "null", "default" or "now".
    pub kind: String,
    pub value: String,
}

/// Add one row (recorded in History).
#[tauri::command]
pub async fn db_insert_row(state: State<'_, AppState>, server_id: String, app_id: String, table: String, values: Vec<DbNewValue>) -> AppResult<DbChanged> {
    let bad = |s: &str| s.is_empty() || s.len() > 256 || s.contains('\0');
    if bad(&table)
        || values.len() > 500
        || values.iter().any(|v| bad(&v.column) || !matches!(v.kind.as_str(), "value" | "null" | "default" | "now") || v.value.len() > 60_000 || v.value.contains('\0'))
    {
        return Err(AppError::Invalid("that row isn't one Kemudi sends".into()));
    }
    let shown = {
        let set: Vec<&DbNewValue> = values.iter().filter(|v| v.kind != "default").collect();
        let vals: Vec<String> = set
            .iter()
            .map(|v| match v.kind.as_str() {
                "null" => "NULL".into(),
                "now" => "CURRENT_TIMESTAMP".into(),
                _ => lit(Some(&v.value)),
            })
            .collect();
        format!("INSERT INTO {table} ({}) VALUES ({})", set.iter().map(|v| v.column.as_str()).collect::<Vec<_>>().join(", "), vals.join(", "))
    };
    let run = audit(&state, &server_id, &app_id, &format!("Add a row to {table}"), &shown);
    let req = serde_json::json!({ "mode": "insert_row", "table": table, "values": values });
    let res = async { changed(&ask(&state, &server_id, &app_id, req).await?) }.await;
    audit_end(run, &res);
    res
}

/// Delete one row, named by its whole primary key (recorded in History).
#[tauri::command]
pub async fn db_delete_row(state: State<'_, AppState>, server_id: String, app_id: String, table: String, key: Vec<DbKey>) -> AppResult<DbChanged> {
    let bad = |s: &str| s.is_empty() || s.len() > 256 || s.contains('\0');
    if bad(&table) || key.is_empty() || key.len() > 8 || key.iter().any(|k| bad(&k.column)) {
        return Err(AppError::Invalid("that row isn't one Kemudi sends".into()));
    }
    let wh: Vec<String> = key.iter().map(|k| format!("{} = {}", k.column, lit(k.value.as_deref()))).collect();
    let shown = format!("DELETE FROM {table} WHERE {}", wh.join(" AND "));
    let run = audit(&state, &server_id, &app_id, &format!("Delete a row from {table}"), &shown);
    let req = serde_json::json!({ "mode": "delete_row", "table": table, "key": key });
    let res = async { changed(&ask(&state, &server_id, &app_id, req).await?) }.await;
    audit_end(run, &res);
    res
}

/// Every table's columns (for completing names in the editor).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DbSchema {
    pub tables: Vec<DbSchemaTable>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DbSchemaTable {
    pub name: String,
    pub columns: Vec<String>,
}

#[tauri::command]
pub async fn db_schema(state: State<'_, AppState>, server_id: String, app_id: String) -> AppResult<DbSchema> {
    let out = ask(&state, &server_id, &app_id, serde_json::json!({ "mode": "schema" })).await?;
    serde_json::from_str(answer(&out)?).map_err(|e| AppError::Invalid(format!("the answer didn't read: {e}")))
}

// ------------------------------------------------------------ SQL dump

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DumpOptions {
    /// None: every table and view.
    pub tables: Option<Vec<String>>,
    /// Rows too (else the structure only).
    pub data: bool,
    /// DROP … IF EXISTS before each CREATE.
    pub drop: bool,
    /// gzip on the server (smaller to bring over, `.sql.gz`).
    pub gzip: bool,
    /// The file's name (no folder).
    pub file_name: String,
    /// Where to save it (None: ~/Downloads).
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DumpProgress {
    /// Bytes saved so far (compressed, with gzip).
    pub bytes: u64,
    /// The table being written, its number and how many there are.
    pub table: String,
    pub index: u32,
    pub total: u32,
    /// Rows of that table so far.
    pub rows: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DumpDone {
    pub path: String,
    pub bytes: u64,
    pub tables: u32,
    pub rows: u64,
}

fn cancels() -> &'static std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

/// The dump on stdout (gzipped there when asked), everything else on stderr.
fn dump_script(path: &str, php: &str, req: &serde_json::Value, password: Option<&str>, gzip: bool) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(req.to_string());
    format!(
        r#"{{
{pre}
}} 1>&2
$RU "$PHP" -- {b64} <<'KEMUDI_PHP'{pipe}
{code}KEMUDI_PHP
"#,
        pre = crate::queues::prelude(path, php, password),
        pipe = if gzip { " | gzip -c" } else { "" },
        code = PHP,
    )
}

/// What the dump said on stderr: progress, the end, or what went wrong.
#[derive(Debug, Default)]
struct DumpLog {
    done: Option<(u32, u64)>,
    error: Option<String>,
    other: Vec<String>,
}

fn dump_line(l: &str, p: &mut DumpProgress, log: &mut DumpLog) {
    let l = l.trim();
    if let Some(rest) = l.strip_prefix("@@table ") {
        let mut it = rest.splitn(3, ' ');
        p.index = it.next().and_then(|x| x.parse().ok()).unwrap_or(p.index);
        p.total = it.next().and_then(|x| x.parse().ok()).unwrap_or(p.total);
        p.table = it.next().unwrap_or("").to_string();
        p.rows = 0;
    } else if let Some(n) = l.strip_prefix("@@rows ") {
        p.rows = n.trim().parse().unwrap_or(p.rows);
    } else if let Some(rest) = l.strip_prefix("@@done") {
        let mut it = rest.split_whitespace();
        let t = it.next().and_then(|x| x.parse().ok()).unwrap_or(p.total);
        let r = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        log.done = Some((t, r));
    } else if let Some(e) = l.strip_prefix("@@err ") {
        log.error = Some(e.to_string());
    } else if !l.is_empty() && !l.starts_with("@@") && log.other.len() < 20 {
        log.other.push(l.to_string());
    }
}

/// Export an app's database as an SQL file on this Mac, in one consistent
/// snapshot (MySQL / MariaDB / SQLite by Kemudi, Postgres by pg_dump on the
/// server). Streams straight into the file: nothing is left on the server.
#[tauri::command]
pub async fn db_dump(
    state: State<'_, AppState>,
    server_id: String,
    app_id: String,
    id: String,
    opts: DumpOptions,
    on_progress: tauri::ipc::Channel<DumpProgress>,
) -> AppResult<DumpDone> {
    use std::io::Write;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

    let name = opts.file_name.trim().to_string();
    if name.is_empty() || name.len() > 200 || name.contains(['/', '\\', '\0']) || name.starts_with('.') {
        return Err(AppError::Invalid("that file name won't do".into()));
    }
    if opts.tables.as_ref().is_some_and(|t| t.is_empty() || t.len() > 5000 || t.iter().any(|x| x.is_empty() || x.len() > 256 || x.contains('\0'))) {
        return Err(AppError::Invalid("pick at least one table".into()));
    }
    let dir = match opts.folder.as_deref().filter(|f| !f.trim().is_empty()) {
        Some(f) => std::path::PathBuf::from(f),
        None => crate::files::default_downloads()?,
    };
    if !dir.is_dir() {
        return Err(AppError::Invalid(format!("{} isn't a folder", dir.display())));
    }
    let (server, path, php) = crate::queues::app_of(&state, &server_id, &app_id)?;
    if server.asg.is_some() {
        return Err(AppError::Invalid("exporting needs ssh: AWS Session Manager servers can't stream a file yet".into()));
    }
    crate::ssh::validate_host(&server.host)?;
    let password = crate::remote_files::saved_sudo(&server_id).await;
    let req = serde_json::json!({ "mode": "dump", "tables": opts.tables, "data": opts.data, "drop": opts.drop });
    let script = dump_script(&path, &php, &req, password.as_deref(), opts.gzip);

    let env = state.env_ready().await;
    let hc = crate::ssh::host_config(&server.host, env);
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args(["-o", "BatchMode=yes", "-o", "RemoteCommand=none", "-o", "RequestTTY=no"])
        .args(&hc.connect_opts)
        .args([&server.host, "sh -s"])
        .env_clear()
        .envs(&env.vars)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(script.as_bytes()).await?;
    }
    let dest = crate::files::free_name(&dir, &name);
    let file = std::fs::File::create(&dest).map_err(|e| AppError::Invalid(format!("can't write {}: {e}", dest.display())))?;
    let mut file = std::io::BufWriter::with_capacity(1 << 20, file);
    let (tx, mut stop) = tokio::sync::oneshot::channel();
    cancels().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);

    let shared = std::sync::Arc::new(std::sync::Mutex::new((DumpProgress::default(), DumpLog::default())));
    let err_task = child.stderr.take().map(|e| {
        let shared = shared.clone();
        tokio::spawn(async move {
            let mut lines = tokio::io::BufReader::new(e).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut g = shared.lock().unwrap_or_else(|e| e.into_inner());
                let (p, log) = &mut *g;
                dump_line(&l, p, log);
            }
        })
    });
    let mut out = child.stdout.take().ok_or_else(|| AppError::Invalid("ssh gave no output".into()))?;
    let mut buf = vec![0u8; 1 << 16];
    let mut bytes = 0u64;
    let mut last = std::time::Instant::now();
    let copied: AppResult<bool> = async {
        loop {
            tokio::select! {
                _ = &mut stop => return Ok(false),
                n = out.read(&mut buf) => {
                    let n = n?;
                    if n == 0 { return Ok(true); }
                    file.write_all(&buf[..n]).map_err(|e| AppError::Invalid(format!("can't write {}: {e}", dest.display())))?;
                    bytes += n as u64;
                    if last.elapsed() >= std::time::Duration::from_millis(250) {
                        last = std::time::Instant::now();
                        let mut p = shared.lock().unwrap_or_else(|e| e.into_inner()).0.clone();
                        p.bytes = bytes;
                        let _ = on_progress.send(p);
                    }
                }
            }
        }
    }
    .await;
    cancels().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    let finished = match copied {
        Ok(true) => {
            let _ = child.wait().await;
            if let Some(t) = err_task {
                let _ = t.await;
            }
            true
        }
        _ => {
            let _ = child.kill().await;
            false
        }
    };
    let flushed = file.flush();
    drop(file);
    let g = shared.lock().unwrap_or_else(|e| e.into_inner());
    let log = &g.1;
    let fail = |why: String| {
        let _ = std::fs::remove_file(&dest);
        Err(AppError::Invalid(why))
    };
    if let Err(e) = copied {
        return fail(e.to_string());
    }
    if !finished {
        return fail("stopped: the partial file was removed".into());
    }
    if let Err(e) = flushed {
        return fail(format!("can't write {}: {e}", dest.display()));
    }
    match (log.done, &log.error) {
        (Some((tables, rows)), None) => Ok(DumpDone { path: dest.display().to_string(), bytes, tables, rows }),
        (_, Some(e)) => fail(e.clone()),
        (None, None) => fail(if log.other.is_empty() {
            "the export stopped before it finished".into()
        } else {
            crate::ssh_hosts::explain(&log.other.join("\n"))
        }),
    }
}

/// Stop an export (its partial file is removed).
#[tauri::command]
pub fn db_dump_cancel(id: String) {
    if let Some(tx) = cancels().lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        let _ = tx.send(());
    }
}

// ------------------------------------------------------------ history and saved queries

/// Queries you ran (newest last, per app) and the ones you saved, in
/// `db-queries.json` in the data dir. Only the SQL and how it went: never
/// rows.
mod store {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use serde::{Deserialize, Serialize};

    const MAX_HISTORY: usize = 200;
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase", default)]
    pub struct Ran {
        /// Unix ms.
        pub at: u64,
        pub sql: String,
        pub ms: Option<u64>,
        /// Rows on the first page (with `more`: there were more).
        pub rows: Option<u32>,
        pub more: bool,
        pub error: Option<String>,
    }

    #[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase", default)]
    pub struct Saved {
        pub id: String,
        pub name: String,
        pub sql: String,
        pub at: u64,
    }

    #[derive(Debug, Clone, Default, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct AppQueries {
        pub history: Vec<Ran>,
        pub saved: Vec<Saved>,
    }

    #[derive(Debug, Default, Serialize, Deserialize)]
    struct File {
        #[serde(default)]
        apps: BTreeMap<String, AppQueries>,
    }

    fn path() -> Option<PathBuf> {
        crate::data_dir().map(|d| d.join("db-queries.json"))
    }

    pub fn now_ms() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
    }

    fn key(server: &str, app: &str) -> String {
        format!("{server}/{app}")
    }

    pub fn get(server: &str, app: &str) -> AppQueries {
        let Some(p) = path() else { return AppQueries::default() };
        let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let file: File = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        file.apps.get(&key(server, app)).cloned().unwrap_or_default()
    }

    /// Change one app's queries and write the file (atomically).
    pub fn update(server: &str, app: &str, f: impl FnOnce(&mut AppQueries)) -> Result<AppQueries, String> {
        let p = path().ok_or("no data folder")?;
        let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut file: File = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let q = file.apps.entry(key(server, app)).or_default();
        f(q);
        if q.history.len() > MAX_HISTORY {
            q.history.drain(..q.history.len() - MAX_HISTORY);
        }
        let out = q.clone();
        let tmp = p.with_extension("json.tmp");
        serde_json::to_vec_pretty(&file)
            .map_err(|e| e.to_string())
            .and_then(|b| std::fs::write(&tmp, b).map_err(|e| e.to_string()))
            .and_then(|()| std::fs::rename(&tmp, &p).map_err(|e| e.to_string()))?;
        Ok(out)
    }

    /// The same SQL again moves to the end instead of adding a copy.
    pub fn ran(q: &mut AppQueries, r: Ran) {
        q.history.retain(|h| h.sql.trim() != r.sql.trim());
        q.history.push(r);
    }
}

pub use store::{AppQueries, Ran, Saved};

fn record(server_id: &str, app_id: &str, sql: &str, res: &AppResult<DbResult>) {
    let r = Ran {
        at: store::now_ms(),
        sql: sql.trim().to_string(),
        ms: res.as_ref().ok().map(|r| r.ms),
        rows: res.as_ref().ok().map(|r| r.rows.len() as u32),
        more: res.as_ref().is_ok_and(|r| r.more),
        error: res.as_ref().err().map(|e| e.to_string().chars().take(300).collect()),
    };
    if let Err(e) = store::update(server_id, app_id, |q| store::ran(q, r)) {
        eprintln!("kemudi: query history not kept: {e}");
    }
}

/// An app's query history (oldest first) and saved queries.
#[tauri::command]
pub fn db_queries(server_id: String, app_id: String) -> AppQueries {
    store::get(&server_id, &app_id)
}

/// Save a query under a name (the same name: replaced).
#[tauri::command]
pub fn db_query_save(server_id: String, app_id: String, name: String, sql: String) -> AppResult<AppQueries> {
    let name = name.trim().to_string();
    if name.is_empty() || name.len() > 200 || sql.trim().is_empty() || sql.len() > 60_000 {
        return Err(AppError::Invalid("a saved query needs a name and some SQL".into()));
    }
    store::update(&server_id, &app_id, |q| {
        let at = store::now_ms();
        match q.saved.iter_mut().find(|s| s.name == name) {
            Some(s) => {
                s.sql = sql.trim().to_string();
                s.at = at;
            }
            None => q.saved.push(Saved { id: format!("q{at}"), name, sql: sql.trim().to_string(), at }),
        }
    })
    .map_err(AppError::Invalid)
}

/// Rename (`name`) or delete (`name` None) a saved query.
#[tauri::command]
pub fn db_query_saved_edit(server_id: String, app_id: String, id: String, name: Option<String>) -> AppResult<AppQueries> {
    store::update(&server_id, &app_id, |q| match name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        Some(n) => {
            if let Some(s) = q.saved.iter_mut().find(|s| s.id == id) {
                s.name = n;
            }
        }
        None => q.saved.retain(|s| s.id != id),
    })
    .map_err(AppError::Invalid)
}

/// Forget an app's query history (saved queries stay).
#[tauri::command]
pub fn db_history_clear(server_id: String, app_id: String) -> AppResult<AppQueries> {
    store::update(&server_id, &app_id, |q| q.history.clear()).map_err(AppError::Invalid)
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
    fn shows_an_update() {
        let u = DbUpdate {
            table: "addresses".into(),
            key: vec![DbKey { column: "id".into(), value: Some("7".into()) }],
            column: "line_1".into(),
            old: Some("a".into()),
            value: Some("Jalan O'Hara".into()),
        };
        assert_eq!(update_sql(&u), "UPDATE addresses SET line_1 = 'Jalan O''Hara' WHERE id = '7'");
        assert!(update_sql(&DbUpdate { value: None, ..u }).contains("= NULL WHERE"));
    }

    #[test]
    fn history_moves_a_repeat_to_the_end() {
        let mut q = AppQueries::default();
        let r = |sql: &str| Ran { sql: sql.into(), ..Default::default() };
        store::ran(&mut q, r("select 1"));
        store::ran(&mut q, r("select 2"));
        store::ran(&mut q, r(" select 1 "));
        assert_eq!(q.history.iter().map(|h| h.sql.trim()).collect::<Vec<_>>(), ["select 2", "select 1"]);
    }

    #[test]
    fn reads_dump_progress() {
        let mut p = DumpProgress::default();
        let mut log = DumpLog::default();
        for l in ["@@table 3 86 orders", "@@rows 5000", "PHP Warning: x", "@@done 86 120000"] {
            dump_line(l, &mut p, &mut log);
        }
        assert_eq!((p.index, p.total, p.table.as_str(), p.rows), (3, 86, "orders", 5000));
        assert_eq!(log.done, Some((86, 120000)));
        assert_eq!(log.other, vec!["PHP Warning: x"]);
        let mut log = DumpLog::default();
        dump_line("@@err pg_dump isn't installed", &mut p, &mut log);
        assert!(log.error.is_some() && log.done.is_none());
    }

    #[test]
    fn dump_keeps_stdout_for_the_file() {
        let s = dump_script("/srv/app", "php", &serde_json::json!({"mode": "dump"}), None, true);
        assert!(s.starts_with("{\n") && s.contains("} 1>&2\n"));
        assert!(s.contains("<<'KEMUDI_PHP' | gzip -c\n"));
    }

    #[test]
    fn request_goes_as_base64() {
        let s = script("/opt/www/app", "php", &serde_json::json!({"mode": "sql", "sql": "select 'x'"}), None);
        assert!(s.contains("$RU \"$PHP\" -- eyJ"));
        assert!(!s.contains("select 'x'"));
        assert!(s.contains("START TRANSACTION READ ONLY"));
    }
}
