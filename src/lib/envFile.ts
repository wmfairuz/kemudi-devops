// Editing a .env as text, a line at a time, so comments, blank lines and
// order survive. Values are quoted only when they need it.

export interface EnvLine {
  /** Index into the file's lines. */
  index: number;
  key: string;
  value: string;
  exported: boolean;
}

const KEY_LINE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/;
const SECRET_WORDS = ["PASS", "SECRET", "KEY", "TOKEN", "PRIVATE", "CREDENTIAL", "SALT", "AUTH", "DSN", "SIGNATURE"];

export function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** The value as dotenv reads it: quotes removed, inline comment dropped. */
export function unquote(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    let out = "";
    for (let i = 1; i < v.length; i++) {
      const c = v[i]!;
      if (c === "\\" && i + 1 < v.length) {
        const n = v[++i]!;
        out += n === "n" ? "\n" : n;
      } else if (c === '"') return out;
      else out += c;
    }
    return out;
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  const hash = v.search(/\s#/);
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

/** Quote a value only if it needs it: single quotes are literal (no
 *  ${VAR} expansion); a value with a ' gets escaped double quotes. */
export function quote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=~-]*$/.test(value)) return value;
  if (!value.includes("'") && !value.includes("\n")) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function parseEnv(text: string): EnvLine[] {
  const out: EnvLine[] = [];
  splitLines(text).forEach((line, index) => {
    const m = KEY_LINE.exec(line);
    if (m && !line.trimStart().startsWith("#")) out.push({ index, key: m[2]!, value: unquote(m[3] ?? ""), exported: !!m[1] });
  });
  return out;
}

export function isSecret(key: string, value: string): boolean {
  const k = key.toUpperCase();
  return SECRET_WORDS.some((w) => k.includes(w)) || /:\/\/[^/@\s]*:[^/@\s]*@/.test(value);
}

const lineFor = (key: string, value: string, exported: boolean) => `${exported ? "export " : ""}${key}=${quote(value)}`;

/** What follows the value on its line: an inline comment with the spacing
 *  before it ("   # note"), or "". */
export function trailing(rawValue: string): string {
  const lead = rawValue.length - rawValue.trimStart().length;
  const v = rawValue.slice(lead);
  let end = -1;
  if (v.startsWith('"')) {
    for (let i = 1; i < v.length; i++) {
      if (v[i] === "\\") i++;
      else if (v[i] === '"') {
        end = i + 1;
        break;
      }
    }
  } else if (v.startsWith("'")) {
    const close = v.indexOf("'", 1);
    end = close === -1 ? -1 : close + 1;
  }
  const rest = end === -1 ? v : v.slice(end);
  const hash = end === -1 ? rest.search(/\s+#/) : rest.search(/\s*#/);
  return hash === -1 ? "" : rest.slice(hash).trimEnd();
}

/** Rewrite one variable line, keeping `export` and an inline comment. */
export function setLine(text: string, index: number, key: string, value: string): string {
  const lines = splitLines(text);
  const old = lines[index];
  if (old === undefined) return text;
  const raw = KEY_LINE.exec(old)?.[3] ?? "";
  lines[index] = lineFor(key, value, /^\s*export\s/.test(old)) + trailing(raw);
  return lines.join(eolOf(text));
}

export function removeLine(text: string, index: number): string {
  const lines = splitLines(text);
  lines.splice(index, 1);
  return lines.join(eolOf(text));
}

export function addVar(text: string, key: string, value: string): string {
  const eol = eolOf(text);
  const body = text === "" || text.endsWith("\n") ? text : text + eol;
  return `${body}${lineFor(key, value, false)}${eol}`;
}

/** Keys defined more than once (dotenv uses the first). */
export function duplicates(vars: EnvLine[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of vars) (seen.has(v.key) ? dup : seen).add(v.key);
  return dup;
}

/** "changed A · added B · removed C", by key name only. */
export function summarize(before: string, after: string): string {
  const map = (t: string) => new Map(parseEnv(t).map((v) => [v.key, v.value] as const));
  const a = map(before);
  const b = map(after);
  const changed = [...b].filter(([k, v]) => a.has(k) && a.get(k) !== v).map(([k]) => k);
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const parts = [
    changed.length ? `changed ${changed.join(", ")}` : "",
    added.length ? `added ${added.join(", ")}` : "",
    removed.length ? `removed ${removed.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : before === after ? "no changes" : "comments or layout only";
}

export const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;
