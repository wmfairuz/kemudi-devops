import { useMemo, useRef, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { wordsMatch } from "@/components/kit/Filters";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { ToolSwitch } from "@/components/kit/Toolbar";
import {
  dbDump,
  dbDumpCancel,
  errorMessage,
  filesChooseFolder,
  filesReveal,
  type DbColumn,
  type DbNewValue,
  type DbTables,
  type DumpDone,
  type DumpProgress,
  type Env,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** `'it''s'`, or NULL: SQL as shown (History records the same). */
export const lit = (v: string | null) => (v === null ? "NULL" : `'${(v.length > 200 ? `${v.slice(0, 200)}…` : v).replace(/'/g, "''")}'`);

/** The typed-name box production asks for. */
function ProdWord({ word, text, onText }: { word: string; text: string; onText: (t: string) => void }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="rounded-lg bg-env-prod/8 px-3 py-2 text-env-prod-fg">
        This is production. Type <span className="font-mono font-semibold">{word}</span> to go ahead.
      </span>
      <input
        autoFocus
        value={text}
        spellCheck={false}
        onChange={(e) => onText(e.target.value)}
        className="h-8 rounded-md border border-control-border bg-background px-2 font-mono text-[12.5px] outline-none focus:border-primary/60"
      />
    </label>
  );
}

/** Confirm a change to the database: the SQL, what it does, and on
 *  production the server's name typed. */
export function ChangeConfirm({
  title,
  sql,
  notes,
  warn,
  env,
  word,
  busy,
  error,
  okLabel = "Change",
  onCancel,
  onOk,
}: {
  title: string;
  sql: string;
  notes: string;
  /** Said in red above the notes (e.g. no WHERE). */
  warn?: string | null;
  env: Env;
  word: string;
  busy: boolean;
  error: string | null;
  okLabel?: string;
  onCancel: () => void;
  /** None: nothing to do (just Close). */
  onOk?: () => void;
}) {
  const prod = env === "prod";
  const [text, setText] = useState("");
  const ok = !!onOk && !busy && (!prod || text === word);
  return (
    <Modal open onOpenChange={(o) => !o && !busy && onCancel()} title={title} width={600}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onOk?.();
        }}
      >
        <ModalHeader>
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            {title} <EnvTag env={env} />
          </span>
        </ModalHeader>
        <div className="flex flex-col gap-3 px-5 pb-4 text-[12.5px] leading-[18px] text-muted-foreground">
          <pre className="max-h-[36vh] overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[12px] break-words whitespace-pre-wrap text-foreground">{sql}</pre>
          {warn && <div className="rounded-lg bg-env-prod/8 px-3 py-2 font-medium text-env-prod-fg">{warn}</div>}
          <span>{notes}</span>
          {prod && onOk && <ProdWord word={word} text={text} onText={setText} />}
          {error && <div className="rounded-lg bg-env-prod/8 px-3 py-2 break-words text-env-prod-fg">{error}</div>}
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={onCancel} disabled={busy}>
            {onOk ? "Cancel" : "Close"} <Hint>esc</Hint>
          </Btn>
          {onOk && (
            <Btn type="submit" variant={prod ? "danger" : "primary"} disabled={!ok} autoFocus={!prod}>
              {busy ? "Working…" : okLabel}
            </Btn>
          )}
        </ModalFooter>
      </form>
    </Modal>
  );
}

const isTime = (t: string) => /\b(timestamp|datetime|date|time)\b/i.test(t);

/** A new row: a value (or NULL / its default / now) for each column, the
 *  INSERT it makes, and on production the server's name typed. */
export function InsertRowDialog({
  table,
  columns,
  env,
  word,
  onCancel,
  onSubmit,
}: {
  table: string;
  columns: DbColumn[];
  env: Env;
  word: string;
  onCancel: () => void;
  onSubmit: (values: DbNewValue[]) => Promise<void>;
}) {
  const [vals, setVals] = useState<DbNewValue[]>(() =>
    columns.map((c) => ({
      column: c.name,
      kind: c.auto || c.default !== null ? "default" : c.nullable ? "null" : "value",
      value: "",
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const prod = env === "prod";
  const set = (i: number, g: Partial<DbNewValue>) => setVals((vs) => vs.map((v, j) => (j === i ? { ...v, ...g } : v)));
  const sql = useMemo(() => {
    const on = vals.filter((v) => v.kind !== "default");
    const show = (v: DbNewValue) => (v.kind === "null" ? "NULL" : v.kind === "now" ? "CURRENT_TIMESTAMP" : lit(v.value));
    return `INSERT INTO ${table} (${on.map((v) => v.column).join(", ")})\nVALUES (${on.map(show).join(", ")})`;
  }, [vals, table]);
  const ok = !busy && (!prod || text === word);
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(vals);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const chip = (on: boolean) =>
    cn("h-6 flex-none cursor-pointer rounded-full px-2 text-[11px]", on ? "bg-primary font-medium text-primary-foreground" : "text-subtle-foreground hover:bg-hover-strong");

  return (
    <Modal open onOpenChange={(o) => !o && !busy && onCancel()} title={`Add a row to ${table}`} width={720}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ModalHeader>
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            Add a row to {table} <EnvTag env={env} />
          </span>
        </ModalHeader>
        <div className="flex max-h-[44vh] flex-col gap-1 overflow-y-auto px-5 pb-3">
          {columns.map((c, i) => {
            const v = vals[i];
            if (!v) return null;
            return (
              <div key={c.name} className="flex items-center gap-2">
                <span className="w-[170px] flex-none truncate text-[12.5px]" title={`${c.name} · ${c.type}${c.default !== null ? ` · default ${c.default}` : ""}`}>
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-1.5 font-mono text-[10.5px] text-faint-foreground">{c.type.replace(/\(.*$/, "")}</span>
                </span>
                <input
                  value={v.kind === "value" ? v.value : ""}
                  placeholder={v.kind === "default" ? (c.auto ? "filled by the database" : `default${c.default !== null ? `: ${c.default}` : ""}`) : v.kind === "null" ? "NULL" : v.kind === "now" ? "now (the database's clock)" : ""}
                  onChange={(e) => set(i, { kind: "value", value: e.target.value })}
                  spellCheck={false}
                  className="h-7 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 font-mono text-[12px] outline-none placeholder:text-faint-foreground placeholder:italic focus:border-primary/60"
                />
                <span className="flex flex-none items-center gap-0.5">
                  {(c.auto || c.default !== null || c.nullable) && (
                    <button type="button" className={chip(v.kind === "default")} onClick={() => set(i, { kind: "default" })}>
                      Default
                    </button>
                  )}
                  {c.nullable && (
                    <button type="button" className={chip(v.kind === "null")} onClick={() => set(i, { kind: "null" })}>
                      NULL
                    </button>
                  )}
                  {isTime(c.type) && (
                    <button type="button" className={chip(v.kind === "now")} onClick={() => set(i, { kind: "now" })}>
                      Now
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-3 border-t border-divider px-5 py-3 text-[12.5px] leading-[18px] text-muted-foreground">
          <pre className="max-h-[16vh] overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[12px] break-words whitespace-pre-wrap text-foreground">{sql}</pre>
          <span>Added in its own transaction, kept only if exactly one row went in. Recorded in History.</span>
          {prod && <ProdWord word={word} text={text} onText={setText} />}
          {error && <div className="rounded-lg bg-env-prod/8 px-3 py-2 break-words text-env-prod-fg">{error}</div>}
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={onCancel} disabled={busy}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant={prod ? "danger" : "primary"} disabled={!ok}>
            {busy ? "Adding…" : "Add row"}
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Export the database as an SQL file on this Mac: which tables, with or
 *  without data, DROP statements, gzip; always one consistent snapshot. */
export function ExportDialog({ serverId, appId, tables, onClose }: { serverId: string; appId: string; tables: DbTables; onClose: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(tables.tables.map((t) => t.name)));
  const [find, setFind] = useState("");
  const [data, setData] = useState(true);
  const [drop, setDrop] = useState(true);
  const [gzip, setGzip] = useState(true);
  const [folder, setFolder] = useState<string | null>(null);
  const [phase, setPhase] = useState<"form" | "running" | "done">("form");
  const [progress, setProgress] = useState<DumpProgress | null>(null);
  const [done, setDone] = useState<DumpDone | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useRef(`dump-${Date.now()}`);
  const pg = tables.driver === "pgsql";
  const all = picked.size === tables.tables.length;
  const fileName = `${tables.database || appId}-${stamp()}${all ? "" : "-part"}.sql${gzip ? ".gz" : ""}`;
  const shown = tables.tables.filter((t) => wordsMatch(find, t.name));
  const size = tables.tables.filter((t) => picked.has(t.name)).reduce((n, t) => n + (t.bytes ?? 0), 0);

  const start = async () => {
    setPhase("running");
    setError(null);
    setProgress(null);
    try {
      const d = await dbDump(serverId, appId, id.current, { tables: all ? null : [...picked], data, drop, gzip, fileName, folder }, setProgress);
      setDone(d);
      setPhase("done");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("form");
    }
  };
  const toggle = (n: string) =>
    setPicked((s) => {
      const t = new Set(s);
      if (t.has(n)) t.delete(n);
      else t.add(n);
      return t;
    });

  return (
    <Modal open onOpenChange={(o) => !o && phase !== "running" && onClose()} title="Export the database" width={640}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">Export {tables.database || "the database"} as SQL</span>
        <span className="text-[12px] text-subtle-foreground">
          One consistent snapshot (a single read-only transaction{pg ? ", by pg_dump on the server" : ""}): every table as it was at the same moment, without locking InnoDB tables. Saved straight to this Mac; nothing is left on the server.
        </span>
      </ModalHeader>
      {phase === "form" && (
        <div className="flex flex-col gap-3 px-5 pb-4 text-[12.5px]">
          <div className="flex flex-col overflow-hidden rounded-lg border border-divider">
            <div className="flex items-center gap-2 border-b border-divider bg-muted/50 px-2 py-1.5">
              <input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder="Find a table"
                spellCheck={false}
                className="h-6 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 text-[12px] outline-none focus:border-primary/60"
              />
              <span className="text-[11.5px] text-subtle-foreground">
                {picked.size} of {tables.tables.length}
                {size > 0 && ` · ${bytes(size)} in the database`}
              </span>
              <button type="button" className="cursor-pointer text-[11.5px] text-primary hover:underline" onClick={() => setPicked(new Set(tables.tables.map((t) => t.name)))}>
                All
              </button>
              <button type="button" className="cursor-pointer text-[11.5px] text-primary hover:underline" onClick={() => setPicked(new Set())}>
                None
              </button>
            </div>
            <div className="max-h-[26vh] overflow-y-auto py-1">
              {shown.map((t) => (
                <label key={t.name} className="flex h-6 cursor-pointer items-center gap-2 px-2 hover:bg-hover">
                  <input type="checkbox" checked={picked.has(t.name)} onChange={() => toggle(t.name)} />
                  <span className="min-w-0 flex-1 truncate">
                    {t.name}
                    {t.kind === "view" && <span className="ml-1 text-[11px] text-subtle-foreground">view</span>}
                  </span>
                  <span className="font-mono text-[10.5px] text-faint-foreground">{t.bytes ? bytes(t.bytes) : ""}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <ToolSwitch
              size="sm"
              label="What to export"
              value={data ? "data" : "structure"}
              options={[
                { value: "data", label: "Structure and data" },
                { value: "structure", label: "Structure only" },
              ]}
              onChange={(v) => setData(v === "data")}
            />
            <ToolSwitch
              size="sm"
              label="Compression"
              value={gzip ? "gzip" : "none"}
              options={[
                { value: "gzip", label: "gzip" },
                { value: "none", label: "No compression" },
              ]}
              onChange={(v) => setGzip(v === "gzip")}
            />
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={drop} onChange={(e) => setDrop(e.target.checked)} />
              DROP … IF EXISTS before each CREATE
            </label>
          </div>
          <div className="flex items-center gap-2 text-[12px] text-subtle-foreground">
            <span className="min-w-0 flex-1 truncate">
              Saves <span className="font-mono text-foreground">{fileName}</span> in {folder ?? "Downloads"}
            </span>
            <button
              type="button"
              className="cursor-pointer text-primary hover:underline"
              onClick={() => void filesChooseFolder(folder).then((f) => f && setFolder(f))}
            >
              Change folder…
            </button>
          </div>
          <span className="text-[11.5px] text-faint-foreground">
            {pg
              ? "Postgres: pg_dump has to be on the server (postgresql-client)."
              : "MyISAM tables aren't covered by the snapshot; a schema change during the export spoils it. Triggers, routines and events aren't included."}
          </span>
          {error && <div className="rounded-lg bg-env-prod/8 px-3 py-2 break-words text-env-prod-fg">{error}</div>}
        </div>
      )}
      {phase === "running" && (
        <div className="flex flex-col gap-2 px-5 pb-5 text-[12.5px]">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${progress?.total ? Math.round(((progress.index - 1) / progress.total) * 100) : 2}%` }} />
          </div>
          <span className="text-muted-foreground">
            {progress?.table ? (
              <>
                {progress.total > 1 && `${progress.index} of ${progress.total} · `}
                <span className="font-mono text-foreground">{progress.table}</span>
                {progress.rows > 0 && ` · ${progress.rows.toLocaleString()} rows`}
              </>
            ) : (
              "Starting…"
            )}
          </span>
          <span className="text-[12px] text-subtle-foreground">{bytes(progress?.bytes ?? 0)} saved</span>
        </div>
      )}
      {phase === "done" && done && (
        <div className="flex flex-col gap-1.5 px-5 pb-5 text-[12.5px]">
          <span className="font-medium text-foreground">Exported {done.tables} tables{done.rows ? `, ${done.rows.toLocaleString()} rows` : ""}.</span>
          <span className="font-mono text-[12px] break-all text-muted-foreground">{done.path}</span>
          <span className="text-subtle-foreground">{bytes(done.bytes)}</span>
        </div>
      )}
      <ModalFooter>
        <span className="flex-1" />
        {phase === "form" && (
          <>
            <Btn variant="outline" className="pr-2.5" onClick={onClose}>
              Cancel <Hint>esc</Hint>
            </Btn>
            <Btn variant="primary" disabled={picked.size === 0} onClick={() => void start()}>
              Export
            </Btn>
          </>
        )}
        {phase === "running" && (
          <Btn variant="outline" onClick={() => void dbDumpCancel(id.current)}>
            Stop
          </Btn>
        )}
        {phase === "done" && done && (
          <>
            <Btn variant="outline" onClick={() => void filesReveal(done.path)}>
              Show in Finder
            </Btn>
            <Btn variant="primary" onClick={onClose}>
              Done
            </Btn>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
