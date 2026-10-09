// Turn log text into entries: one per message, with its stack trace or
// context lines folded in. Knows Laravel (Monolog), nginx error/access,
// PHP-FPM / PHP error_log, queue:work output and syslog; anything else is
// one entry per line (indented lines and "#0 …" frames stay with the one
// above).

export type Level = "debug" | "info" | "notice" | "warning" | "error" | "critical";

export const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, notice: 2, warning: 3, error: 4, critical: 5 };

export interface LogEntry {
  id: number;
  /** As written in the log (null: none on the line). */
  time: string | null;
  level: Level | null;
  /** The first line without its time and level (Laravel: without the context). */
  head: string;
  /** Lines after the first (stack trace, context JSON…). */
  body: string;
  /** "app/Http/Controllers/Foo.php:42" from an exception, if any. */
  where: string | null;
  /** The rest of the first line (Laravel's context JSON), shown dimmed. */
  extra?: string;
  raw: string;
  /** Multi-line format: following lines without a header belong to this one. */
  multiline: boolean;
  /** Continuation lines with no entry above them (cut off at the top). */
  orphan?: boolean;
  /** A note from the viewer itself (new file, skipped data). */
  marker?: boolean;
}

export function levelOf(word: string): Level | null {
  const w = word.toLowerCase();
  if (/^(emerg|emergency|alert|crit|critical|fatal|panic)$/.test(w)) return "critical";
  if (/^(err|error|fail|failed)$/.test(w)) return "error";
  if (/^(warn|warning)$/.test(w)) return "warning";
  if (w === "notice") return "notice";
  if (/^(info|done|processed)$/.test(w)) return "info";
  if (/^(debug|running|processing|trace)$/.test(w)) return "debug";
  return null;
}

/** For lines that don't say: guess from the words in them. */
function guessLevel(text: string): Level | null {
  if (/\b(emerg|panic|fatal|critical)\b/i.test(text)) return "critical";
  if (/\b(error|exception|failed|failure|denied|segfault)\b/i.test(text)) return "error";
  if (/\bwarn(ing)?\b/i.test(text)) return "warning";
  return null;
}

const LARAVEL = /^\[(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:[+-]\d\d:?\d\d|Z)?)\]\s+([\w.-]+)\.([A-Z]+):\s?(.*)$/;
const NGINX_ERR = /^(\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d) \[(\w+)\] (.*)$/;
const FPM = /^\[(\d\d-[A-Za-z]{3}-\d{4} \d\d:\d\d:\d\d(?:\.\d+)?)\] ([A-Z]+): (.*)$/;
const PHP_LOG = /^\[(\d\d-[A-Za-z]{3}-\d{4} \d\d:\d\d:\d\d(?: [\w/+-]+)?)\] (.*)$/;
const ACCESS = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) (\S+)(.*)$/;
const WORKER = /^\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (.*?)\s*\.{2,}\s*(?:([\d.]+\s?(?:ms|s))\s+)?(RUNNING|DONE|FAIL)\s*$/;
const WORKER_OLD = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]\[[^\]]*\] (Processing|Processed|Failed):\s*(.*)$/;
const ISO = /^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:[+-]\d\d:?\d\d|Z)?)\s+(.*)$/;
const SYSLOG = /^([A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d) (.*)$/;

const WHERE = /\bat (\/[^\s():]+\.php):(\d+)/;

function where(text: string): string | null {
  const m = WHERE.exec(text);
  if (!m) return null;
  // From the app's own folders: vendor/…, else the last app/, routes/…
  const path = m[1]!;
  let i = path.indexOf("/vendor/");
  if (i < 0) for (const d of ["app", "routes", "config", "database", "resources", "bootstrap", "public"]) i = Math.max(i, path.lastIndexOf(`/${d}/`));
  return `${i >= 0 ? path.slice(i + 1) : path.split("/").slice(-3).join("/")}:${m[2]}`;
}

/** A line that starts a new entry, or null (a continuation line). */
function header(line: string): Omit<LogEntry, "id" | "body" | "raw"> | null {
  let m = LARAVEL.exec(line);
  if (m) {
    const msg = m[4]!;
    // Monolog appends the context (` {"exception":…`) and extras (` [] []`).
    const cut = msg.search(/ (\{"|\{\}|\[\])/);
    const extra = cut > 0 ? msg.slice(cut + 1).replace(/^(\[\]|\{\})( (\[\]|\{\}))*$/, "") : "";
    return { time: m[1]!, level: levelOf(m[3]!), head: cut > 0 ? msg.slice(0, cut) : msg, where: where(line), extra, multiline: true };
  }
  if ((m = NGINX_ERR.exec(line))) return { time: m[1]!, level: levelOf(m[2]!), head: m[3]!.replace(/^\d+#\d+: (\*\d+ )?/, ""), where: null, multiline: false };
  if ((m = FPM.exec(line))) return { time: m[1]!, level: levelOf(m[2]!), head: m[3]!, where: null, multiline: false };
  if ((m = PHP_LOG.exec(line))) {
    const msg = m[2]!;
    const lv = /^PHP (Fatal|Parse) error/.test(msg) ? "critical" : /^PHP (Warning|Deprecated)/.test(msg) ? "warning" : /^PHP Notice/.test(msg) ? "notice" : guessLevel(msg);
    const on = / in (\/\S+\.php) on line (\d+)/.exec(msg);
    return { time: m[1]!, level: lv, head: msg, where: where(msg) ?? (on ? where(`at ${on[1]}:${on[2]}`) : null), multiline: true };
  }
  if ((m = ACCESS.exec(line))) {
    const status = Number(m[4]);
    const level: Level = status >= 500 ? "error" : status >= 400 ? "warning" : "info";
    return { time: m[2]!, level, head: `${m[4]} ${m[3]}  ${m[1]}`, where: null, multiline: false };
  }
  if ((m = WORKER.exec(line))) {
    return { time: m[1]!, level: levelOf(m[4]!), head: `${m[4]} ${m[2]}${m[3] ? `  ${m[3]}` : ""}`, where: null, multiline: false };
  }
  if ((m = WORKER_OLD.exec(line))) return { time: m[1]!, level: levelOf(m[2]!), head: `${m[2]}: ${m[3]}`, where: null, multiline: false };
  if ((m = ISO.exec(line))) return { time: m[1]!, level: guessLevel(m[2]!), head: m[2]!, where: null, multiline: false };
  if ((m = SYSLOG.exec(line))) return { time: m[1]!, level: guessLevel(m[2]!), head: m[2]!, where: null, multiline: false };
  return null;
}

/** Indented lines, stack frames and the like belong to the entry above. */
const CONTINUATION = /^(\s|#\d|Stack trace:|\[stacktrace\]|\[previous exception\]|"}|\}|Next |Caused by|at )/;

function appendLine(e: LogEntry, line: string): LogEntry {
  return {
    ...e,
    body: e.body ? `${e.body}\n${line}` : line,
    raw: `${e.raw}\n${line}`,
    where: e.where ?? where(line),
  };
}

/** Parse `text` (whole lines) after `last` (the entry it may continue).
 *  Returns the updated `last` (when lines were added to it) and new entries. */
export function parseChunk(text: string, last: LogEntry | null, nextId: () => number): { last: LogEntry | null; added: LogEntry[] } {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let prev: LogEntry | null = last && !last.marker ? last : null;
  let updatedLast: LogEntry | null = null;
  const added: LogEntry[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const h = header(line);
    if (!h && prev && line !== "" && (prev.multiline || CONTINUATION.test(line))) {
      prev = appendLine(prev, line);
      if (added.length) added[added.length - 1] = prev;
      else updatedLast = prev;
      continue;
    }
    if (!h && line === "") continue;
    const e: LogEntry = h
      ? { id: nextId(), ...h, body: "", raw: line }
      : { id: nextId(), time: null, level: guessLevel(line), head: line, body: "", where: null, raw: line, multiline: false, orphan: !prev && CONTINUATION.test(line) };
    added.push(e);
    prev = e;
  }
  return { last: updatedLast, added };
}

/** Earlier entries go before `entries`: lines cut off at the top of the
 *  later part join the entry they belong to. */
export function prependEntries(earlier: LogEntry[], entries: LogEntry[]): LogEntry[] {
  const out = earlier.slice();
  let rest = entries;
  const tail = out[out.length - 1];
  if (tail && !tail.marker) {
    let joined = tail;
    while (rest.length && rest[0]!.orphan) {
      const o = rest[0]!;
      for (const l of o.raw.split("\n")) joined = appendLine(joined, l);
      rest = rest.slice(1);
    }
    out[out.length - 1] = joined;
  }
  return out.concat(rest);
}

/** `laravel-2026-10-09.log` → `laravel.log`, `error.log.1` → `error.log`
 *  (same rules as the server side). */
export function familyOf(name: string): string | null {
  if (/\.(gz|xz|bz2|zip|zst)$/i.test(name)) return null;
  let m = /^(.+)-\d{4}-\d\d-\d\d\.log$/.exec(name);
  if (m) return `${m[1]}.log`;
  m = /^(.+)\.\d+$/.exec(name);
  if (m) return m[1]!;
  m = /^(.+)-\d{8,}$/.exec(name);
  if (m) return m[1]!;
  return name;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Compact time: today's as `09:01:00`, else `10-08 09:01:00`. Knows
 *  2026-10-09 / 2026/10/09, 09/Oct/2026:09:01:00 (access logs),
 *  09-Oct-2026 09:01:00 (PHP) and Oct  9 09:01:00 (syslog). */
export function shortTime(t: string): string {
  let y: string, mo: string, d: string, time: string;
  let m = /^(\d{4})[-/](\d\d)[-/](\d\d)[T ](\d\d:\d\d:\d\d)/.exec(t);
  if (m) [, y, mo, d, time] = m as unknown as [string, string, string, string, string];
  else if ((m = /^(\d\d)[/-]([A-Za-z]{3})[/-](\d{4})[: ](\d\d:\d\d:\d\d)/.exec(t))) {
    const i = MONTHS.indexOf(m[2]!.toLowerCase());
    if (i < 0) return t;
    [y, mo, d, time] = [m[3]!, String(i + 1).padStart(2, "0"), m[1]!, m[4]!];
  } else if ((m = /^([A-Za-z]{3}) +(\d{1,2}) (\d\d:\d\d:\d\d)/.exec(t))) {
    const i = MONTHS.indexOf(m[1]!.toLowerCase());
    if (i < 0) return t;
    [y, mo, d, time] = [String(new Date().getFullYear()), String(i + 1).padStart(2, "0"), m[2]!.padStart(2, "0"), m[3]!];
  } else return t;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${y}-${mo}-${d}` === today ? time : `${mo}-${d} ${time}`;
}
