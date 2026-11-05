import { ArrowDown, ArrowUp, Bookmark, ChevronLeft, ChevronRight, Copy, CornerDownLeft, Eye, History, KeyRound, Lock, Pencil, Play, Plus, RotateCw, SquareCode, Table2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { CodeEditor } from "@/components/kit/CodeEditor";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { wordsMatch } from "@/components/kit/Filters";
import { Spinner } from "@/components/kit/Spinner";
import { Group, Tool } from "@/components/kit/Toolbar";
import { copyText } from "@/lib/clipboard";
import {
  dbHistoryClear,
  dbQueries,
  dbQuery,
  dbQuerySave,
  dbQuerySavedEdit,
  dbTables,
  dbUpdate,
  errorMessage,
  type DbFilter,
  type DbOp,
  type DbQueries,
  type DbRequest,
  type DbResult,
  type DbTables,
  type DbUpdate,
  type Env,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { findServer } from "@/stores/config";
import { askConfirm, askText } from "@/stores/confirm";
import type { Tab } from "@/stores/tabs";
import { useToasts } from "@/stores/toasts";
import { agoS } from "@/stores/watch";

const PAGE = 100;

const OPS: { op: DbOp; label: string }[] = [
  { op: "eq", label: "=" },
  { op: "ne", label: "≠" },
  { op: "lt", label: "<" },
  { op: "gt", label: ">" },
  { op: "contains", label: "contains" },
  { op: "starts", label: "starts with" },
  { op: "null", label: "is NULL" },
  { op: "notnull", label: "is not NULL" },
];
const NO_VALUE: DbOp[] = ["null", "notnull"];

/** 14867 → "14.9k". */
function compact(n: number | null): string {
  if (n === null) return "";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** The statement the cursor is in (`;` outside quotes and comments ends
 *  one), or the selection when there is one. */
export function statementAt(doc: string, from: number, to: number): string {
  if (to > from) return doc.slice(from, to).trim();
  const parts: { start: number; end: number }[] = [];
  let start = 0;
  let q: string | null = null;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i];
    if (q) {
      if (q === "--" || q === "#") {
        if (c === "\n") q = null;
      } else if (q === "/*") {
        if (c === "*" && doc[i + 1] === "/") (q = null), i++;
      } else if (c === "\\" && q !== "`") i++;
      else if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === "`") q = c;
    else if (c === "-" && doc[i + 1] === "-") q = "--";
    else if (c === "#") q = "#";
    else if (c === "/" && doc[i + 1] === "*") q = "/*";
    else if (c === ";") {
      parts.push({ start, end: i });
      start = i + 1;
    }
  }
  parts.push({ start, end: doc.length });
  const nonEmpty = parts.filter((p) => doc.slice(p.start, p.end).trim() !== "");
  // The one the cursor is in; past the last `;`, the one before it.
  const at = nonEmpty.find((p) => from >= p.start && from <= p.end + 1) ?? [...nonEmpty].reverse().find((p) => p.end < from) ?? nonEmpty[0];
  return at ? doc.slice(at.start, at.end).trim() : "";
}

/** An app's database, read-only: its tables (browse a page at a time,
 *  sorted and filtered) and a query editor. Asked through the app itself
 *  over ssh; see db.rs. */
export function DatabaseView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const serverId = tab.serverId ?? "";
  const appId = tab.appId ?? "";
  const [tables, setTables] = useState<DbTables | null>(null);
  const [tablesErr, setTablesErr] = useState<string | null>(null);
  const [tablesBusy, setTablesBusy] = useState(false);
  const [find, setFind] = useState("");
  const [mode, setMode] = useState<"browse" | "query">("browse");
  const [table, setTable] = useState<string | null>(null);

  const loadTables = async () => {
    setTablesBusy(true);
    setTablesErr(null);
    try {
      setTables(await dbTables(serverId, appId));
    } catch (e) {
      setTablesErr(errorMessage(e));
    } finally {
      setTablesBusy(false);
    }
  };
  const asked = useRef(false);
  useEffect(() => {
    if (visible && !asked.current) {
      asked.current = true;
      void loadTables();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const shown = (tables?.tables ?? []).filter((t) => wordsMatch(find, t.name));
  const info = tables?.tables.find((t) => t.name === table) ?? null;
  const [toQuery, setToQuery] = useState<string | null>(null);

  return (
    <div className="light-ui absolute inset-0 flex bg-background text-foreground">
      <aside className="flex w-[250px] flex-none flex-col border-r border-divider bg-sidebar">
        <div className="flex h-11 flex-none items-center gap-2 border-b border-divider pr-1.5 pl-3">
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[13px] font-semibold">{tables?.database || "Database"}</span>
            <span className="truncate text-[10.5px] text-subtle-foreground">
              {tables ? `${tables.driver} ${tables.version.split("-")[0]} · ${tables.tables.length} tables` : tablesBusy ? "connecting…" : ""}
            </span>
          </span>
          <Tool size="sm" title="Read the table list again" onClick={() => void loadTables()} disabled={tablesBusy}>
            <RotateCw className={cn("size-[14px]", tablesBusy && "animate-spin")} strokeWidth={1.7} />
          </Tool>
        </div>
        <div className="flex-none p-2 pb-1">
          <input
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFind("")}
            placeholder="Find a table"
            spellCheck={false}
            className="h-7 w-full rounded-lg border border-control-border bg-muted px-2 text-[12.5px] outline-none placeholder:text-subtle-foreground focus:border-primary/60"
          />
        </div>
        <button
          onClick={() => setMode("query")}
          className={cn(
            "mx-1.5 flex h-8 flex-none cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12.5px]",
            mode === "query" ? "bg-accent font-medium" : "hover:bg-hover",
          )}
        >
          <SquareCode className="size-4 flex-none text-primary" strokeWidth={1.7} />
          Query
        </button>
        <div className="mx-3 my-1 border-t border-divider" />
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {tablesErr && <div className="m-1.5 rounded-md bg-env-prod/10 p-2 text-[12px] break-words text-env-prod-fg">{tablesErr}</div>}
          {!tables && !tablesErr && tablesBusy && (
            <div className="flex items-center gap-2 p-2 text-[12px] text-subtle-foreground">
              <Spinner /> Asking the app…
            </div>
          )}
          {shown.map((t) => (
            <button
              key={t.name}
              title={`${t.name}${t.kind === "view" ? " (view)" : ""}${t.rows !== null ? ` · about ${t.rows.toLocaleString()} rows` : ""}${t.bytes ? ` · ${bytes(t.bytes)}` : ""}`}
              onClick={() => {
                setTable(t.name);
                setMode("browse");
              }}
              className={cn(
                "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12.5px]",
                mode === "browse" && table === t.name ? "bg-accent font-medium" : "hover:bg-hover",
              )}
            >
              {t.kind === "view" ? (
                <Eye className="size-3.5 flex-none text-subtle-foreground" strokeWidth={1.7} />
              ) : (
                <Table2 className="size-3.5 flex-none text-primary/80" strokeWidth={1.7} />
              )}
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <span className="flex-none font-mono text-[10.5px] text-faint-foreground">{compact(t.rows)}</span>
            </button>
          ))}
          {tables && shown.length === 0 && <div className="p-2 text-[12px] text-subtle-foreground">No table matches “{find}”.</div>}
        </div>
      </aside>

      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-0" hidden={mode !== "browse"}>
          {table ? (
            <Browse key={table} serverId={serverId} appId={appId} table={table} estimate={info?.rows ?? null} view={info?.kind === "view"} onQuery={(sql) => {
              setToQuery(sql);
              setMode("query");
            }} />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-subtle-foreground">
              {tables ? "Pick a table on the left, or write a Query." : tablesErr ? "" : "Reading the app's database config…"}
            </div>
          )}
        </div>
        <div className="absolute inset-0" hidden={mode !== "query"}>
          <Query serverId={serverId} appId={appId} insert={toQuery} onInserted={() => setToQuery(null)} />
        </div>
      </div>
    </div>
  );
}

/** "Read-only" pill: what keeps this safe on production. */
function ReadOnly({ why }: { why?: string }) {
  return (
    <span
      title={
        why
          ? "Cells can only be changed in a table with a primary key (it names the one row to change)."
          : "Every query runs in a read-only transaction: the database itself refuses writes. Only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN are sent, each stopped after 10 s. To change data, edit a cell in a table."
      }
      className="flex h-6 flex-none items-center gap-1 rounded-full bg-muted px-2 text-[11px] whitespace-nowrap text-subtle-foreground"
    >
      <Lock className="size-3" strokeWidth={2} /> Read-only{why ? `: ${why}` : ""}
    </span>
  );
}

function EditHint() {
  return (
    <span
      title="Double-click a cell (or press Enter on it) to change it. You see the UPDATE before it runs; production asks you to type the server's name. Only that one row can change, and only if the cell still holds what was read."
      className="flex h-6 flex-none items-center gap-1 rounded-full bg-muted px-2 text-[11px] whitespace-nowrap text-subtle-foreground"
    >
      <Pencil className="size-3" strokeWidth={2} /> Double-click a cell to edit
    </span>
  );
}

/** The UPDATE as shown before it runs (and as History records it). */
function updateSql(u: DbUpdate): string {
  const lit = (v: string | null) => (v === null ? "NULL" : `'${(v.length > 200 ? `${v.slice(0, 200)}…` : v).replace(/'/g, "''")}'`);
  return `UPDATE ${u.table} SET ${u.column} = ${lit(u.value)} WHERE ${u.key.map((k) => `${k.column} = ${lit(k.value)}`).join(" AND ")}`;
}

/** Confirm a cell change: the UPDATE, and on production the server's
 *  name typed. */
function EditConfirm({ sql, env, word, busy, error, onCancel, onOk }: { sql: string; env: Env; word: string; busy: boolean; error: string | null; onCancel: () => void; onOk: () => void }) {
  const prod = env === "prod";
  const [text, setText] = useState("");
  const ok = !busy && (!prod || text === word);
  return (
    <Modal open onOpenChange={(o) => !o && !busy && onCancel()} title="Change this cell?" width={560}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onOk();
        }}
      >
        <ModalHeader>
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            Change this cell? <EnvTag env={env} />
          </span>
        </ModalHeader>
        <div className="flex flex-col gap-3 px-5 pb-4 text-[12.5px] leading-[18px] text-muted-foreground">
          <pre className="max-h-[40vh] overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[12px] break-words whitespace-pre-wrap text-foreground">{sql}</pre>
          <span>Only this row changes, and only if the cell still holds what was read; otherwise nothing changes. Recorded in History.</span>
          {prod && (
            <label className="flex flex-col gap-1.5">
              <span className="rounded-lg bg-env-prod/8 px-3 py-2 text-env-prod-fg">
                This is production. Type <span className="font-mono font-semibold">{word}</span> to change it.
              </span>
              <input
                autoFocus
                value={text}
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                className="h-8 rounded-md border border-control-border bg-background px-2 font-mono text-[12.5px] outline-none focus:border-primary/60"
              />
            </label>
          )}
          {error && <div className="rounded-lg bg-env-prod/8 px-3 py-2 break-words text-env-prod-fg">{error}</div>}
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={onCancel} disabled={busy}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant={prod ? "danger" : "primary"} disabled={!ok} autoFocus={!prod}>
            {busy ? "Changing…" : "Change"}
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function Pager({ offset, count, more, onPage, busy }: { offset: number; count: number; more: boolean; onPage: (o: number) => void; busy: boolean }) {
  return (
    <Group size="sm">
      <Tool size="sm" title="Previous page" onClick={() => onPage(Math.max(0, offset - PAGE))} disabled={busy || offset === 0}>
        <ChevronLeft className="size-[15px]" strokeWidth={1.7} />
      </Tool>
      <span className="px-1 font-mono text-[11px] whitespace-nowrap text-subtle-foreground">{count ? `${(offset + 1).toLocaleString()}–${(offset + count).toLocaleString()}` : "0 rows"}</span>
      <Tool size="sm" title="Next page" onClick={() => onPage(offset + PAGE)} disabled={busy || !more}>
        <ChevronRight className="size-[15px]" strokeWidth={1.7} />
      </Tool>
    </Group>
  );
}

/** Asks for one page; answers that come after a newer ask are dropped. */
function useAsk(serverId: string, appId: string) {
  const [result, setResult] = useState<DbResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState<DbRequest | null>(null);
  const seq = useRef(0);
  const ask = async (r: DbRequest) => {
    const n = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const res = await dbQuery(serverId, appId, r);
      if (n !== seq.current) return;
      setResult(res);
      setReq(r);
    } catch (e) {
      if (n === seq.current) setError(errorMessage(e));
    } finally {
      if (n === seq.current) setBusy(false);
    }
  };
  return { result, error, busy, req, ask };
}

function Browse({
  serverId,
  appId,
  table,
  estimate,
  view,
  onQuery,
}: {
  serverId: string;
  appId: string;
  table: string;
  estimate: number | null;
  view: boolean;
  onQuery: (sql: string) => void;
}) {
  const { result, error, busy, req, ask } = useAsk(serverId, appId);
  const [filters, setFilters] = useState<DbFilter[]>([]);
  const [applied, setApplied] = useState<DbFilter[]>([]);
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [offset, setOffset] = useState(0);
  const go = (g: { filters?: DbFilter[]; sort?: typeof sort; offset?: number }) => {
    const f = g.filters ?? applied;
    const s = g.sort !== undefined ? g.sort : sort;
    const o = g.offset ?? 0;
    setApplied(f);
    setSort(s);
    setOffset(o);
    void ask({ mode: "browse", table, filters: f, sort: s, offset: o, limit: PAGE });
  };
  useEffect(() => {
    go({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const columns = result?.columns.map((c) => c.name) ?? [];
  const apply = () => go({ filters: filters.filter((f) => f.column && (NO_VALUE.includes(f.op) || f.value !== "")) });
  const addFilter = (f?: DbFilter) => setFilters((fs) => [...fs, f ?? { column: columns[0] ?? "", op: "eq", value: "" }]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-3">
        <Table2 className="size-4 flex-none text-primary" strokeWidth={1.7} />
        <span className="truncate text-[13.5px] font-semibold">{table}</span>
        {estimate !== null && (
          <span className="flex-none text-[11.5px] text-subtle-foreground" title={view ? "" : "The database's estimate"}>
            ~{estimate.toLocaleString()} row{estimate === 1 ? "" : "s"}
          </span>
        )}
        {busy && <Spinner />}
        <span className="flex-1" />
        {result && (result.columns.some((c) => c.key) ? <EditHint /> : <ReadOnly why="no primary key" />)}
        <Group size="sm">
          <Tool size="sm" label="Filter" title="Add a filter (column, condition, value)" onClick={() => addFilter()} disabled={!result}>
            <Plus className="size-[14px]" strokeWidth={1.8} />
          </Tool>
          <Tool size="sm" title="Read this page again" onClick={() => go({ offset })} disabled={busy}>
            <RotateCw className="size-[14px]" strokeWidth={1.7} />
          </Tool>
        </Group>
        <Pager offset={offset} count={result?.rows.length ?? 0} more={!!result?.more} busy={busy} onPage={(o) => go({ offset: o })} />
      </div>
      {filters.length > 0 && (
        <div className="flex flex-none flex-col gap-1.5 border-b border-divider bg-muted/40 px-3 py-2">
          {filters.map((f, i) => {
            const set = (g: Partial<DbFilter>) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, ...g } : x)));
            return (
              <div key={i} className="flex items-center gap-1.5">
                <span className="w-10 flex-none text-right text-[11.5px] text-subtle-foreground">{i === 0 ? "where" : "and"}</span>
                <select value={f.column} onChange={(e) => set({ column: e.target.value })} className="h-7 max-w-[220px] rounded-md border border-control-border bg-background px-1.5 text-[12.5px]">
                  {columns.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <select value={f.op} onChange={(e) => set({ op: e.target.value as DbOp })} className="h-7 rounded-md border border-control-border bg-background px-1.5 text-[12.5px]">
                  {OPS.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {!NO_VALUE.includes(f.op) && (
                  <input
                    value={f.value}
                    autoFocus={i === filters.length - 1 && f.value === ""}
                    onChange={(e) => set({ value: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && apply()}
                    placeholder="value (Enter applies)"
                    spellCheck={false}
                    className="h-7 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 font-mono text-[12px] outline-none focus:border-primary/60"
                  />
                )}
                {NO_VALUE.includes(f.op) && <span className="flex-1" />}
                <button
                  aria-label="Remove this filter"
                  onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}
                  className="flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
          <div className="flex items-center gap-2 pl-[46px]">
            <button onClick={apply} className="h-6 cursor-pointer rounded-full bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:opacity-90">
              Apply
            </button>
            <button
              onClick={() => {
                setFilters([]);
                if (applied.length) go({ filters: [] });
              }}
              className="h-6 cursor-pointer rounded-full px-2 text-[12px] text-primary hover:bg-primary/10"
            >
              Clear
            </button>
          </div>
        </div>
      )}
      <Results
        serverId={serverId}
        appId={appId}
        table={table}
        result={result}
        req={req}
        error={error}
        offset={offset}
        sort={sort}
        onSort={(column) => go({ sort: sort?.column !== column ? { column, desc: false } : sort.desc ? null : { column, desc: true } })}
        onFilter={(f) => {
          const next = [...filters, f];
          setFilters(next);
          go({ filters: next });
        }}
        onQuery={onQuery}
      />
    </div>
  );
}

const DRAFT = (s: string, a: string) => `kemudi.dbQuery.${s}/${a}`;

const PANEL = "kemudi.dbPanel";

function Query({ serverId, appId, insert, onInserted }: { serverId: string; appId: string; insert: string | null; onInserted: () => void }) {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT(serverId, appId)) ?? "";
    } catch {
      return "";
    }
  });
  const textRef = useRef(text);
  const cursor = useRef({ from: 0, to: 0 });
  const { result, error, busy, req, ask } = useAsk(serverId, appId);
  const [offset, setOffset] = useState(0);
  const [ran, setRan] = useState("");
  const [qs, setQs] = useState<DbQueries | null>(null);
  const [panel, setPanelState] = useState<"history" | "saved" | "">(() => {
    try {
      const v = localStorage.getItem(PANEL);
      return v === "saved" || v === "" ? v : "history";
    } catch {
      return "history";
    }
  });
  const setPanel = (p: typeof panel) => {
    setPanelState(p);
    try {
      localStorage.setItem(PANEL, p);
    } catch {
      // Not kept; fine.
    }
  };
  const reload = () => dbQueries(serverId, appId).then(setQs, () => {});
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = (t: string) => {
    setText(t);
    textRef.current = t;
    try {
      localStorage.setItem(DRAFT(serverId, appId), t);
    } catch {
      // Not kept; fine.
    }
  };
  const run = (sql: string, o = 0) => {
    if (!sql.trim()) return;
    setRan(sql);
    setOffset(o);
    void ask({ mode: "sql", sql, offset: o, limit: PAGE }).then(() => {
      if (o === 0) void reload();
    });
  };
  /** Put a query in the editor (at the end, unless it's there already),
   *  and run it. */
  const use = (sql: string, go = true) => {
    const t = textRef.current;
    if (!t.includes(sql.trim())) save(t.trim() ? `${t.trimEnd()}\n\n${sql.trim()};\n` : `${sql.trim()};\n`);
    if (go) run(sql);
  };
  // "Edit as query" from a table.
  useEffect(() => {
    if (insert === null) return;
    use(insert);
    onInserted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insert]);
  const here = () => statementAt(textRef.current, cursor.current.from, cursor.current.to);
  const saveAs = async (sql: string, name = "") => {
    if (!sql.trim()) return;
    const names = (qs?.saved ?? []).map((q) => q.name);
    const guess = name || sql.replace(/\s+/g, " ").trim().slice(0, 48);
    const n = await askText("Save this query", "A name for it (an existing name replaces that query).", "Save", guess, names);
    if (!n?.trim()) return;
    try {
      setQs(await dbQuerySave(serverId, appId, n, sql));
      setPanel("saved");
    } catch (e) {
      useToasts.getState().push(errorMessage(e), "error");
    }
  };

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="h-[36%] min-h-[120px] flex-none border-b border-divider">
          <CodeEditor
            value={text}
            onChange={save}
            lang="sql"
            className="h-full"
            onRun={(p) => run(statementAt(p.doc, p.from, p.to))}
            onCursor={(from, to) => (cursor.current = { from, to })}
          />
        </div>
        <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-3">
          <button
            onClick={() => run(here())}
            disabled={busy || !text.trim()}
            title="Run the selection, or the statement the cursor is in (⌘↵)"
            className="flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3 text-[12.5px] font-medium text-primary-foreground shadow-sm hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          >
            <Play className="size-3.5" fill="currentColor" strokeWidth={0} /> Run
          </button>
          <Group size="sm">
            <Tool size="sm" label="Save…" title="Save the statement the cursor is in (or the selection) under a name" onClick={() => void saveAs(here())} disabled={!text.trim()}>
              <Bookmark className="size-[14px]" strokeWidth={1.7} />
            </Tool>
          </Group>
          <span className="min-w-0 truncate text-[11.5px] text-subtle-foreground">⌘↵ runs the statement the cursor is in, or the selection</span>
          {busy && <Spinner />}
          <span className="flex-1" />
          <ReadOnly />
          {result && !error && <Pager offset={offset} count={result.rows.length} more={result.more} busy={busy} onPage={(o) => run(ran, o)} />}
          <Group size="sm">
            <Tool size="sm" title="History: the queries you ran here" active={panel === "history"} onClick={() => setPanel(panel === "history" ? "" : "history")}>
              <History className="size-[15px]" strokeWidth={1.7} />
            </Tool>
            <Tool size="sm" title="Saved queries" active={panel === "saved"} onClick={() => setPanel(panel === "saved" ? "" : "saved")}>
              <Bookmark className="size-[14px]" strokeWidth={1.7} />
            </Tool>
          </Group>
        </div>
        <Results serverId={serverId} appId={appId} result={result} req={req} error={error} offset={offset} />
      </div>
      {panel && (
        <QueriesPanel
          kind={panel}
          qs={qs}
          onKind={setPanel}
          onUse={use}
          onSave={(sql) => void saveAs(sql)}
          onRename={async (id, name) => {
            const n = await askText("Rename this query", "Its new name.", "Rename", name);
            if (n?.trim()) setQs(await dbQuerySavedEdit(serverId, appId, id, n));
          }}
          onDelete={async (id, name) => {
            if (await askConfirm(`Delete “${name}”?`, "Only the saved query goes; nothing in the database changes.", "Delete")) setQs(await dbQuerySavedEdit(serverId, appId, id, null));
          }}
          onClear={async () => {
            if (await askConfirm("Clear this app's query history?", "Saved queries stay.", "Clear")) setQs(await dbHistoryClear(serverId, appId));
          }}
        />
      )}
    </div>
  );
}

/** History (newest first) or saved queries: click runs one (adding it to
 *  the editor); hover for more. */
function QueriesPanel({
  kind,
  qs,
  onKind,
  onUse,
  onSave,
  onRename,
  onDelete,
  onClear,
}: {
  kind: "history" | "saved";
  qs: DbQueries | null;
  onKind: (k: "history" | "saved") => void;
  onUse: (sql: string, run?: boolean) => void;
  onSave: (sql: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string, name: string) => void;
  onClear: () => void;
}) {
  const [find, setFind] = useState("");
  const history = [...(qs?.history ?? [])].reverse().filter((h) => wordsMatch(find, h.sql));
  const saved = [...(qs?.saved ?? [])].sort((a, b) => a.name.localeCompare(b.name)).filter((q) => wordsMatch(find, `${q.name} ${q.sql}`));
  const now = Date.now() / 1000;
  const act = "flex size-6 cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground";
  return (
    <aside className="flex w-[300px] flex-none flex-col border-l border-divider bg-sidebar">
      <div className="flex h-11 flex-none items-center gap-1 border-b border-divider px-2">
        {(["history", "saved"] as const).map((k) => (
          <button
            key={k}
            onClick={() => onKind(k)}
            className={cn("h-7 cursor-pointer rounded-full px-3 text-[12.5px]", kind === k ? "bg-hover-strong font-medium" : "text-subtle-foreground hover:bg-hover")}
          >
            {k === "history" ? `History ${qs?.history.length ?? ""}` : `Saved ${qs?.saved.length ?? ""}`}
          </button>
        ))}
        <span className="flex-1" />
        {kind === "history" && (qs?.history.length ?? 0) > 0 && (
          <button onClick={onClear} className="h-6 cursor-pointer rounded-full px-2 text-[11.5px] text-primary hover:bg-primary/10">
            Clear
          </button>
        )}
      </div>
      <div className="flex-none p-2 pb-1">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setFind("")}
          placeholder={kind === "history" ? "Find in history" : "Find a saved query"}
          spellCheck={false}
          className="h-7 w-full rounded-lg border border-control-border bg-muted px-2 text-[12.5px] outline-none placeholder:text-subtle-foreground focus:border-primary/60"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {kind === "history" &&
          history.map((h) => (
            <div key={`${h.at}${h.sql}`} title={`${h.sql}\n\nClick: run it again`} onClick={() => onUse(h.sql)} className="group relative cursor-pointer rounded-md px-2 py-1.5 hover:bg-hover">
              <div className="line-clamp-3 font-mono text-[11.5px] leading-[16px] break-words whitespace-pre-wrap">{h.sql}</div>
              <div className={cn("mt-0.5 truncate text-[10.5px]", h.error ? "text-env-prod-fg" : "text-faint-foreground")}>
                {agoS(Math.round(h.at / 1000), now)}
                {h.error ? ` · ${h.error}` : ` · ${h.rows ?? 0}${h.more ? "+" : ""} row${h.rows === 1 && !h.more ? "" : "s"} · ${h.ms ?? 0} ms`}
              </div>
              <span className="absolute top-1 right-1 hidden gap-0.5 rounded-md bg-sidebar shadow-sm group-hover:flex" onClick={(e) => e.stopPropagation()}>
                <button className={act} title="Put it in the editor without running it" onClick={() => onUse(h.sql, false)}>
                  <CornerDownLeft className="size-3.5" />
                </button>
                <button className={act} title="Save it under a name" onClick={() => onSave(h.sql)}>
                  <Bookmark className="size-3.5" />
                </button>
              </span>
            </div>
          ))}
        {kind === "saved" &&
          saved.map((q) => (
            <div key={q.id} title={`${q.sql}\n\nClick: run it`} onClick={() => onUse(q.sql)} className="group relative cursor-pointer rounded-md px-2 py-1.5 hover:bg-hover">
              <div className="truncate text-[12.5px] font-medium">{q.name}</div>
              <div className="line-clamp-2 font-mono text-[11px] leading-[15px] break-words whitespace-pre-wrap text-subtle-foreground">{q.sql}</div>
              <span className="absolute top-1 right-1 hidden gap-0.5 rounded-md bg-sidebar shadow-sm group-hover:flex" onClick={(e) => e.stopPropagation()}>
                <button className={act} title="Put it in the editor without running it" onClick={() => onUse(q.sql, false)}>
                  <CornerDownLeft className="size-3.5" />
                </button>
                <button className={act} title="Rename" onClick={() => onRename(q.id, q.name)}>
                  <Pencil className="size-3.5" />
                </button>
                <button className={act} title="Delete" onClick={() => onDelete(q.id, q.name)}>
                  <Trash2 className="size-3.5" />
                </button>
              </span>
            </div>
          ))}
        {qs && kind === "history" && history.length === 0 && (
          <div className="p-2 text-[12px] text-subtle-foreground">{find ? "Nothing matches." : "Queries you run here show up here (only the SQL, never rows)."}</div>
        )}
        {qs && kind === "saved" && saved.length === 0 && (
          <div className="p-2 text-[12px] text-subtle-foreground">{find ? "Nothing matches." : "Save a query with Save… (or the bookmark on a History entry) to keep it here."}</div>
        )}
      </div>
    </aside>
  );
}

/** Width of a column from its name and the first values (12px mono). */
function widths(r: DbResult): number[] {
  return r.columns.map((c, i) => {
    let n = c.name.length + (c.key ? 2 : 0);
    for (const row of r.rows.slice(0, 60)) n = Math.max(n, Math.min(42, (row[i] ?? "NULL").length));
    return Math.max(56, Math.min(340, Math.round(n * 7.3 + 22)));
  });
}

const oneLine = (v: string) => v.replace(/\r?\n/g, " ↵ ").replace(/\t/g, " ");

function Results({
  serverId,
  appId,
  table,
  result,
  req,
  error,
  offset,
  sort,
  onSort,
  onFilter,
  onQuery,
}: {
  serverId: string;
  appId: string;
  /** Browsing this table: cells can be changed (when it has a primary key). */
  table?: string;
  result: DbResult | null;
  req: DbRequest | null;
  error: string | null;
  offset: number;
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  onFilter?: (f: DbFilter) => void;
  onQuery?: (sql: string) => void;
}) {
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [whole, setWhole] = useState<Record<string, string | { error: string }>>({});
  /** Cells changed here: what the database has now. */
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [draft, setDraft] = useState<{ text: string; isNull: boolean } | null>(null);
  const [confirm, setConfirm] = useState<DbUpdate | null>(null);
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  useEffect(() => {
    setSel(null);
    setWhole({});
    setEdits({});
    setDraft(null);
  }, [result]);
  const server = findServer(serverId);
  const env: Env = server?.apps.find((a) => a.id === appId)?.env ?? server?.env ?? "dev";
  const w = useMemo(() => (result ? widths(result) : []), [result]);
  const cut = useMemo(() => new Map((result?.cut ?? []).map(([r, c, n]) => [`${r}:${c}`, n])), [result]);
  const bin = useMemo(() => new Set((result?.bin ?? []).map(([r, c]) => `${r}:${c}`)), [result]);

  const key = sel ? `${sel.r}:${sel.c}` : "";
  const raw = sel && result ? (result.rows[sel.r]?.[sel.c] ?? null) : null;
  const cutLen = sel ? cut.get(key) : undefined;
  const got = whole[key];
  // A cell cut short: fetch it whole once it's picked.
  useEffect(() => {
    if (!sel || cutLen === undefined || got !== undefined || !req) return;
    const k = key;
    dbQuery(serverId, appId, { ...req, full: { row: sel.r, col: sel.c } })
      .then((r) => setWhole((m) => ({ ...m, [k]: r.rows[0]?.[sel.c] ?? "" })))
      .catch((e) => setWhole((m) => ({ ...m, [k]: { error: errorMessage(e) } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cutLen, got]);
  const value = key in edits ? (edits[key] ?? null) : typeof got === "string" ? got : raw;
  const cellAt = (r: number, c: number) => {
    const k = `${r}:${c}`;
    return k in edits ? (edits[k] ?? null) : (result?.rows[r]?.[c] ?? null);
  };
  const pk = (result?.columns ?? []).map((c, i) => ({ name: c.name, i, key: c.key })).filter((x) => x.key);
  /** Why a cell can't be changed here (null: it can). */
  const noEdit = (r: number, c: number): string | null => {
    const k = `${r}:${c}`;
    if (!table) return "Change data in a table's view (Query is read-only)";
    if (pk.length === 0) return "This table has no primary key";
    if (pk.some((p) => cellAt(r, p.i) === null || cut.has(`${r}:${p.i}`) || bin.has(`${r}:${p.i}`))) return "This row's key can't be read whole";
    if (bin.has(k)) return "Binary values can't be edited here";
    if (cut.has(k) && !(k in edits) && typeof whole[k] !== "string") return "Loading the whole value first…";
    return null;
  };
  const startEdit = (r: number, c: number) => {
    setSel({ r, c });
    setEditErr(null);
    if (noEdit(r, c)) return;
    const k = `${r}:${c}`;
    const v = k in edits ? (edits[k] ?? null) : typeof whole[k] === "string" ? (whole[k] as string) : (result?.rows[r]?.[c] ?? null);
    setDraft({ text: v ?? "", isNull: v === null });
  };
  const askSave = () => {
    if (!sel || !draft || !result || !table) return;
    const now = draft.isNull ? null : draft.text;
    if (now === value) {
      setDraft(null);
      return;
    }
    setEditErr(null);
    setConfirm({
      table,
      key: pk.map((p) => ({ column: p.name, value: cellAt(sel.r, p.i) })),
      column: result.columns[sel.c]?.name ?? "",
      old: value,
      value: now,
    });
  };
  const doSave = async () => {
    if (!confirm || !sel) return;
    setSaving(true);
    try {
      const res = await dbUpdate(serverId, appId, confirm);
      const k = `${sel.r}:${sel.c}`;
      setEdits((m) => ({ ...m, [k]: res.value }));
      setConfirm(null);
      setDraft(null);
      useToasts.getState().push(`Changed ${confirm.table}.${confirm.column} (${res.ms} ms)`, "info");
    } catch (e) {
      setEditErr(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const copy = async (v: string | null) => {
    if (await copyText(v ?? "NULL")) useToasts.getState().push("Copied", "info");
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!sel || !result) return;
    if (e.key === "Enter" && table) {
      e.preventDefault();
      startEdit(sel.r, sel.c);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "c" && !window.getSelection()?.toString()) {
      e.preventDefault();
      void copy(value);
      return;
    }
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    const r = Math.max(0, Math.min(result.rows.length - 1, sel.r + m[0]));
    const c = Math.max(0, Math.min(result.columns.length - 1, sel.c + m[1]));
    setSel({ r, c });
    setDraft(null);
    document.getElementById(`dbcell-${r}-${c}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const pretty = useMemo(() => {
    if (!value || !/^\s*[[{]/.test(value)) return null;
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return null;
    }
  }, [value]);

  if (error) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div className="rounded-lg border border-env-prod/30 bg-env-prod/[0.06] p-3 font-mono text-[12px] break-words whitespace-pre-wrap text-env-prod-fg">{error}</div>
      </div>
    );
  }
  if (!result) return <div className="flex-1" />;
  const col = sel ? result.columns[sel.c] : null;

  return (
    <>
      <div tabIndex={0} onKeyDown={onKey} className="min-h-0 flex-1 overflow-auto outline-none">
        {result.columns.length === 0 ? (
          <div className="p-4 text-[12.5px] text-subtle-foreground">The statement ran; it gave no rows.</div>
        ) : (
          <table className="table-fixed border-separate border-spacing-0 text-[12px]" style={{ width: 52 + w.reduce((a, b) => a + b, 0) }}>
            <colgroup>
              <col style={{ width: 52 }} />
              {w.map((x, i) => (
                <col key={i} style={{ width: x }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-20 h-8 border-r border-b border-divider bg-sidebar" />
                {result.columns.map((c) => (
                  <th
                    key={c.name}
                    title={`${c.name}${c.type ? ` · ${c.type}` : ""}${c.key ? " · primary key" : ""}${onSort ? "\nClick: sort" : ""}`}
                    onClick={() => onSort?.(c.name)}
                    className={cn(
                      "sticky top-0 z-10 h-8 border-r border-b border-divider bg-sidebar px-2 text-left font-medium select-none",
                      onSort && "cursor-pointer hover:bg-hover-strong",
                    )}
                  >
                    <span className="flex items-center gap-1">
                      {c.key && <KeyRound className="size-3 flex-none text-env-staging" strokeWidth={2} />}
                      <span className="truncate">{c.name}</span>
                      {sort?.column === c.name &&
                        (sort.desc ? <ArrowDown className="size-3 flex-none text-primary" strokeWidth={2.2} /> : <ArrowUp className="size-3 flex-none text-primary" strokeWidth={2.2} />)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono">
              {result.rows.map((row, r) => (
                <tr key={r} className="even:bg-muted/45">
                  <td className="sticky left-0 border-r border-divider bg-sidebar px-2 text-right text-[10.5px] text-faint-foreground">{offset + r + 1}</td>
                  {row.map((v0, c) => {
                    const k = `${r}:${c}`;
                    const v = k in edits ? (edits[k] ?? null) : v0;
                    const on = sel?.r === r && sel.c === c;
                    return (
                      <td
                        key={c}
                        id={`dbcell-${r}-${c}`}
                        onClick={() => {
                          if (sel?.r !== r || sel.c !== c) setDraft(null);
                          setSel({ r, c });
                        }}
                        onDoubleClick={() => table && startEdit(r, c)}
                        className={cn(
                          "h-[26px] cursor-default truncate border-r border-divider/60 px-2 whitespace-pre",
                          on && "bg-primary/15 outline-2 -outline-offset-2 outline-primary",
                          v === null && "text-faint-foreground italic",
                          bin.has(k) && "text-subtle-foreground",
                          k in edits && "text-primary",
                        )}
                      >
                        {v === null ? "NULL" : oneLine(v)}
                        {cut.has(k) && !(k in edits) && "…"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result.columns.length > 0 && result.rows.length === 0 && <div className="p-4 text-[12.5px] text-subtle-foreground">No rows.</div>}
      </div>

      {sel && col && (
        <div className="flex h-[150px] flex-none flex-col border-t border-divider">
          <div className="flex h-8 flex-none items-center gap-2 border-b border-divider/70 px-3 text-[11.5px]">
            <span className="font-semibold">{col.name}</span>
            <span className="text-subtle-foreground">
              {col.type} · row {offset + sel.r + 1}
              {cutLen !== undefined && ` · ${bytes(cutLen)}`}
              {pretty && " · JSON"}
            </span>
            <span className="flex-1" />
            {table && !draft && (
              <button
                onClick={() => startEdit(sel.r, sel.c)}
                disabled={!!noEdit(sel.r, sel.c)}
                title={noEdit(sel.r, sel.c) ?? "Change this cell (Enter, or double-click it)"}
                className="flex h-6 cursor-pointer items-center gap-1 rounded-full px-2 text-[11.5px] text-primary hover:bg-primary/10 disabled:cursor-default disabled:opacity-40"
              >
                <Pencil className="size-3" /> Edit
              </button>
            )}
            {onFilter && !draft && (
              <button
                onClick={() => onFilter(value === null ? { column: col.name, op: "null", value: "" } : { column: col.name, op: "eq", value: value })}
                disabled={bin.has(key) || (cutLen !== undefined && typeof got !== "string")}
                className="h-6 cursor-pointer rounded-full px-2 text-[11.5px] text-primary hover:bg-primary/10 disabled:cursor-default disabled:opacity-40"
                title="Show only the rows with this value"
              >
                Filter by this
              </button>
            )}
            {!draft && (
              <button onClick={() => void copy(value)} className="flex h-6 cursor-pointer items-center gap-1 rounded-full px-2 text-[11.5px] text-primary hover:bg-primary/10" title="Copy (⌘C)">
                <Copy className="size-3" /> Copy
              </button>
            )}
            {draft && (
              <>
                <button
                  onClick={() => setDraft((d) => d && { ...d, isNull: !d.isNull })}
                  className={cn("h-6 cursor-pointer rounded-full px-2 text-[11.5px]", draft.isNull ? "bg-primary text-primary-foreground" : "text-primary hover:bg-primary/10")}
                  title="Set the cell to NULL (no value)"
                >
                  NULL
                </button>
                <button onClick={() => setDraft(null)} className="h-6 cursor-pointer rounded-full px-2 text-[11.5px] text-primary hover:bg-primary/10">
                  Cancel
                </button>
                <button onClick={askSave} className="flex h-6 cursor-pointer items-center gap-1 rounded-full bg-primary px-2.5 text-[11.5px] font-medium text-primary-foreground hover:opacity-90" title="⌘↵">
                  Save… <CornerDownLeft className="size-3" />
                </button>
              </>
            )}
            <button aria-label="Close" onClick={() => { setSel(null); setDraft(null); }} className="flex size-6 cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong">
              <X className="size-3.5" />
            </button>
          </div>
          {draft ? (
            <textarea
              autoFocus
              value={draft.isNull ? "" : draft.text}
              placeholder={draft.isNull ? "NULL" : ""}
              onChange={(e) => setDraft({ text: e.target.value, isNull: false })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setDraft(null);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  askSave();
                }
              }}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none bg-primary/[0.04] px-3 py-2 font-mono text-[12px] outline-none placeholder:text-faint-foreground placeholder:italic"
            />
          ) : (
          <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[12px] break-words whitespace-pre-wrap select-text">
            {got && typeof got !== "string" ? (
              <span className="text-env-prod-fg">{got.error}</span>
            ) : value === null ? (
              <span className="text-faint-foreground italic">NULL</span>
            ) : (
              <>
                {pretty ?? value}
                {cutLen !== undefined && got === undefined && !(key in edits) && <span className="text-subtle-foreground"> … loading the rest</span>}
              </>
            )}
          </pre>
          )}
          {editErr && !confirm && <div className="flex-none border-t border-divider px-3 py-1.5 text-[11.5px] break-words text-env-prod-fg">{editErr}</div>}
        </div>
      )}
      {confirm && (
        <EditConfirm
          sql={updateSql(confirm)}
          env={env}
          word={serverId}
          busy={saving}
          error={editErr}
          onCancel={() => setConfirm(null)}
          onOk={() => void doSave()}
        />
      )}

      <div className="flex h-7 flex-none items-center gap-2 border-t border-divider bg-sidebar px-3 text-[11px] text-subtle-foreground">
        <span className="min-w-0 flex-1 truncate font-mono" title={result.sql}>
          {result.sql}
        </span>
        <span className="flex-none">{result.ms} ms</span>
        <button onClick={() => void copy(result.sql)} className="flex-none cursor-pointer text-primary hover:underline">
          Copy SQL
        </button>
        {onQuery && (
          <button onClick={() => onQuery(result.sql)} className="flex-none cursor-pointer text-primary hover:underline">
            Edit as query
          </button>
        )}
      </div>
    </>
  );
}
