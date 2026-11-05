// Completions for the Query editor: table names, their columns (after
// `table.` or `alias.`, or of the tables the statement uses) and SQL words.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

import type { DbSchema } from "@/lib/ipc";

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN", "LIKE", "BETWEEN", "EXISTS",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "ON", "AS", "DISTINCT", "GROUP BY", "ORDER BY",
  "HAVING", "LIMIT", "OFFSET", "ASC", "DESC", "UNION", "UNION ALL", "CASE", "WHEN", "THEN", "ELSE",
  "END", "WITH", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "SHOW", "DESCRIBE",
  "EXPLAIN", "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "IFNULL", "CONCAT", "NOW()",
  "DATE", "LOWER", "UPPER", "TRIM", "LENGTH", "CAST",
];

const ident = (s: string) => s.replace(/[`"[\]]/g, "");

/** `alias` / table name → table, from FROM / JOIN / UPDATE / INTO clauses. */
export function aliases(sql: string, tables: Set<string>): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\b(?:from|join|update|into)\s+([`"]?[\w$.]+[`"]?)(?:\s+(?:as\s+)?([`"]?\w+[`"]?))?/gi;
  const stop = new Set(["where", "on", "join", "left", "right", "inner", "outer", "cross", "set", "group", "order", "limit", "values", "using", "natural", "full", "having", "union"]);
  for (const m of sql.matchAll(re)) {
    const t = ident(m[1] ?? "").split(".").pop() ?? "";
    if (!tables.has(t)) continue;
    map.set(t, t);
    const a = ident(m[2] ?? "");
    if (a && !stop.has(a.toLowerCase())) map.set(a, t);
  }
  return map;
}

/** A completion source over `schema`; `statement(doc, pos)` is the
 *  statement around the cursor. */
export function sqlCompletions(schema: DbSchema | null, statement: (doc: string, pos: number) => string) {
  const cols = new Map((schema?.tables ?? []).map((t) => [t.name, t.columns]));
  const names = new Set(cols.keys());
  const tableOpts: Completion[] = [...names].map((t) => ({ label: t, type: "class", detail: `${cols.get(t)?.length ?? 0} columns`, boost: 2 }));
  const words: Completion[] = KEYWORDS.map((k) => ({ label: k, type: "keyword", boost: -1 }));

  return (ctx: CompletionContext): CompletionResult | null => {
    if (!schema) return null;
    const doc = ctx.state.doc.toString();
    const stmt = statement(doc, ctx.pos);
    const known = aliases(stmt, names);

    // `alias.` or `table.`: that table's columns.
    const dotted = ctx.matchBefore(/[`"]?[\w$]+[`"]?\.[\w$]*$/);
    if (dotted) {
      const [left] = dotted.text.split(".");
      const t = known.get(ident(left ?? "")) ?? (names.has(ident(left ?? "")) ? ident(left ?? "") : null);
      if (!t) return null;
      return {
        from: dotted.from + dotted.text.indexOf(".") + 1,
        options: (cols.get(t) ?? []).map((c) => ({ label: c, type: "property", detail: t })),
        validFor: /^[\w$]*$/,
      };
    }
    const word = ctx.matchBefore(/[\w$]+$/);
    if (!word && !ctx.explicit) return null;
    const from = word?.from ?? ctx.pos;
    // Right after FROM / JOIN / UPDATE / INTO: only tables.
    const before = doc.slice(Math.max(0, from - 40), from);
    if (/\b(from|join|update|into|table|describe|desc)\s+$/i.test(before)) return { from, options: tableOpts, validFor: /^[\w$]*$/ };
    const used = [...new Set(known.values())];
    const colOpts: Completion[] = used.flatMap((t) => (cols.get(t) ?? []).map((c) => ({ label: c, type: "property", detail: t, boost: 3 })));
    return { from, options: [...colOpts, ...tableOpts, ...words], validFor: /^[\w$]*$/ };
  };
}
