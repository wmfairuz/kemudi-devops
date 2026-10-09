import { ArrowDown, ChevronRight, Copy, Download, Eraser, FolderOpen, Pause, Play, RotateCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { copyText } from "@/lib/clipboard";
import { downloadDir, shortPath } from "@/lib/downloads";
import { errorMessage, filesDownload, filesReveal, logsRead, logsSources, type LogChunk, type LogSource } from "@/lib/ipc";
import { familyOf, LEVEL_RANK, parseChunk, prependEntries, shortTime, type Level, type LogEntry } from "@/lib/logParse";
import { cn } from "@/lib/utils";
import { findServer, useConfig } from "@/stores/config";
import { openFiles, useTabs, type Tab } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

/** Entries kept in memory; older ones are dropped while following. */
const KEEP = 20000;
/** Rows drawn at first (newest); "Show more" adds this many. */
const PAGE = 1500;

type MinLevel = "all" | "info" | "warning" | "error";
const MIN_RANK: Record<MinLevel, number> = { all: -1, info: 1, warning: 3, error: 4 };

const GROUP_LABEL: Record<string, string> = { web: "Web server", php: "PHP-FPM", workers: "Queue workers", system: "System" };

const keyOf = (s: { dir: string; base: string }) => `${s.dir.replace(/\/+$/, "")}/${s.base}`;

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function day(secs: number): string {
  return new Date(secs * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const LEVEL_STYLE: Record<Level, string> = {
  critical: "bg-env-prod text-white",
  error: "bg-env-prod/12 text-env-prod-fg",
  warning: "bg-env-staging/15 text-env-staging-fg",
  notice: "bg-sky-500/12 text-sky-700",
  info: "bg-emerald-500/12 text-emerald-700",
  debug: "bg-muted text-subtle-foreground",
};

/** Where the newest read left off in the file being followed. */
interface Cursor {
  path: string;
  inode: number;
  /** First and last byte shown from this file. */
  start: number;
  end: number;
  size: number;
  mtime: number;
  sudo: boolean;
}

/** A Logs tab: an app's (or a server's) logs, newest at the bottom, live.
 *  A log follows its newest file, so `laravel.log` with daily files moves on
 *  to the new day's file by itself. */
export function LogsView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const serverId = tab.serverId ?? "";
  const server = findServer(serverId);
  const appId = tab.appId ?? null;
  const term = useConfig((s) => s.snapshot?.config?.terminal);
  const font = { fontFamily: term?.fontFamily ?? 'Menlo, "SF Mono", monospace', fontSize: `${term?.fontSize ?? 14}px` };

  const [sources, setSources] = useState<LogSource[] | null>(null);
  const [sourceKey, setSourceKey] = useState<string | null>(null);
  /** A file of the family picked by hand (null: the newest, following new ones). */
  const [pin, setPin] = useState<string | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [following, setFollowing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [minLevel, setMinLevel] = useState<MinLevel>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [unseen, setUnseen] = useState(0);

  const entriesRef = useRef<LogEntry[]>([]);
  const setList = (list: LogEntry[]) => {
    entriesRef.current = list;
    setEntries(list);
  };
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;
  const cursorRef = useRef<Cursor | null>(null);
  cursorRef.current = cursor;
  /** Bumped on every source/file switch so late answers are dropped. */
  const genRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);

  const source = useMemo(() => {
    if (!sourceKey) return null;
    const found = sources?.find((s) => keyOf(s) === sourceKey);
    if (found) return found;
    // A log opened by path that the scan didn't list.
    const i = sourceKey.lastIndexOf("/");
    return { group: "other", dir: sourceKey.slice(0, i) || "/", base: sourceKey.slice(i + 1), files: [] } satisfies LogSource;
  }, [sources, sourceKey]);

  const envOf = (s: LogSource | null) => {
    const app = s?.group.startsWith("app:") ? server?.apps.find((a) => a.id === s.group.slice(4)) : appId ? server?.apps.find((a) => a.id === appId) : null;
    return app?.env ?? server?.env ?? "dev";
  };

  const groupLabel = (g: string) => (g.startsWith("app:") ? (server?.apps.find((a) => a.id === g.slice(4))?.name ?? g.slice(4)) : (GROUP_LABEL[g] ?? "Other"));

  // Find the logs, then pick one: the tab's (restored / opened by path), else
  // the app's laravel.log, else the first.
  const loadSources = async () => {
    setLoading(true);
    try {
      const list = await logsSources(serverId, appId);
      setSources(list);
      setError(null);
      setSourceKey((cur) => {
        if (cur) return cur;
        const want = tab.cwd;
        if (want) {
          const i = want.lastIndexOf("/");
          const dir = want.slice(0, i) || "/";
          const fam = familyOf(want.slice(i + 1)) ?? want.slice(i + 1);
          const name = want.slice(i + 1);
          const hit = list.find((s) => s.dir === dir && (s.base === fam || s.files.some((f) => f.name === name)));
          // An older file of the family opened by name: show that one.
          if (hit && name !== hit.base && hit.files[0]?.name !== name && hit.files.some((f) => f.name === name)) setPin(name);
          return hit ? keyOf(hit) : `${dir}/${fam}`;
        }
        const first = list.find((s) => s.base === "laravel.log") ?? list[0];
        return first ? keyOf(first) : null;
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible && !sources) void loadSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const addChunk = (c: LogChunk, prev: Cursor | null) => {
    const notes: LogEntry[] = [];
    const name = c.path.split("/").pop() ?? c.path;
    const mark = (head: string): LogEntry => ({ id: nextId(), time: null, level: null, head, body: "", where: null, raw: head, multiline: false, marker: true });
    if (prev && c.reset) notes.push(mark(prev.path !== c.path ? `Now following ${name}` : c.inode !== prev.inode ? `${name} was rotated: reading the new one` : `${name} was cut short: reading it again`));
    if (c.skipped > 0) notes.push(mark(`${size(c.skipped)} skipped (too much at once)`));
    const list = entriesRef.current;
    const last = list[list.length - 1] ?? null;
    const { last: updated, added } = parseChunk(c.text, notes.length ? null : last, nextId);
    let out = updated ? [...list.slice(0, -1), updated] : list;
    if (notes.length || added.length) out = [...out, ...notes, ...added];
    if (out.length > KEEP) out = out.slice(out.length - KEEP);
    setList(out);
    const grew = notes.length + added.length;
    if (grew && !stickRef.current) setUnseen((n) => n + grew);
    setCursor({
      path: c.path,
      inode: c.inode,
      start: prev && !c.reset ? Math.min(prev.start, c.start) : c.start,
      end: c.end,
      size: c.size,
      mtime: c.mtime,
      sudo: c.sudo,
    });
  };

  // First read of a log (or of the pinned file).
  const openLog = async (src: LogSource, pinned: string | null) => {
    const gen = ++genRef.current;
    setLoading(true);
    setList([]);
    setCursor(null);
    setExpanded(new Set());
    setLimit(PAGE);
    setUnseen(0);
    stickRef.current = true;
    try {
      const c = await logsRead(serverId, { dir: src.dir, base: src.base, pin: pinned });
      if (gen !== genRef.current) return;
      setError(null);
      addChunk(c, null);
    } catch (e) {
      if (gen === genRef.current) setError(errorMessage(e));
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!source) return;
    void openLog(source, pin);
    useTabs.getState().update(tab.id, { cwd: keyOf(source) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, pin]);

  // Following: ask for what's new every 2 s (4 s through sudo) while shown.
  useEffect(() => {
    if (!following || !visible || !source || error) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const cur = cursorRef.current;
      const gen = genRef.current;
      if (cur) {
        try {
          const c = await logsRead(serverId, { dir: source.dir, base: source.base, pin }, { from: cur.end, inode: cur.inode });
          if (stop || gen !== genRef.current) return;
          if (c.reset || c.end !== cur.end || c.size !== cur.size) addChunk(c, cur);
        } catch (e) {
          // Stop: a refused sudo password must not be retried every few seconds.
          if (!stop && gen === genRef.current) setError(errorMessage(e));
          return;
        }
      }
      if (!stop) timer = setTimeout(tick, cursorRef.current?.sudo ? 4000 : 2000);
    };
    timer = setTimeout(tick, 2000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, visible, sourceKey, pin, error, cursor === null]);

  // Keep the newest in view while following at the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, minLevel, query, visible]);

  // ⌘F: the search box.
  useEffect(() => {
    const onFind = (e: Event) => {
      if ((e as CustomEvent).detail === tab.id) searchRef.current?.focus();
    };
    window.addEventListener("kemudi:logs-find", onFind);
    return () => window.removeEventListener("kemudi:logs-find", onFind);
  }, [tab.id]);

  const loadEarlier = async () => {
    const cur = cursorRef.current;
    if (!source || !cur || cur.start <= 0) return;
    const gen = genRef.current;
    setLoading(true);
    try {
      const c = await logsRead(serverId, { dir: source.dir, base: source.base, pin: cur.path.split("/").pop() ?? null }, { before: cur.start, inode: cur.inode });
      if (gen !== genRef.current) return;
      const { added } = parseChunk(c.text, null, nextId);
      const el = listRef.current;
      const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
      stickRef.current = false;
      setList(prependEntries(added, entriesRef.current));
      setLimit((l) => l + added.length);
      setCursor((x) => (x ? { ...x, start: c.start } : x));
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - fromBottom;
      });
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const min = MIN_RANK[minLevel];
    return entries.filter((e) => {
      if (e.marker) return !q;
      if (min >= 0 && LEVEL_RANK[e.level ?? "info"] < min) return false;
      return !q || e.raw.toLowerCase().includes(q);
    });
  }, [entries, minLevel, query]);
  const visibleRows = shown.length > limit ? shown.slice(shown.length - limit) : shown;
  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const e of entries) {
      const r = e.level ? LEVEL_RANK[e.level] : -1;
      if (r >= 4) errors++;
      else if (r === 3) warnings++;
    }
    return { errors, warnings };
  }, [entries]);

  const download = async () => {
    if (!cursor) return;
    try {
      const local = await filesDownload(serverId, cursor.path, downloadDir());
      useToasts.getState().push(`Downloaded ${cursor.path.split("/").pop()} to ${shortPath(local)}`, "info", {
        label: "Show in Finder",
        run: () => void filesReveal(local).catch((err) => toastError(errorMessage(err))),
      });
    } catch (e) {
      toastError(errorMessage(e));
    }
  };

  const toggle = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const groups = useMemo(() => {
    const m = new Map<string, LogSource[]>();
    for (const s of sources ?? []) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    return [...m.entries()];
  }, [sources]);

  const listed = sources?.some((s) => keyOf(s) === sourceKey);
  const fileName = cursor?.path.split("/").pop();

  return (
    <div
      className="light-ui absolute inset-0 flex flex-col bg-background text-foreground"
      tabIndex={-1}
      onKeyDown={(ev) => {
        if (ev.key === "Escape" && query) {
          setQuery("");
          ev.stopPropagation();
        }
      }}
    >
      <div className="flex h-11 flex-none items-center gap-1.5 border-b border-divider px-3">
        <select
          aria-label="Log"
          value={sourceKey ?? ""}
          onChange={(ev) => {
            setPin(null);
            setError(null);
            setSourceKey(ev.target.value || null);
          }}
          className="h-7 max-w-[22em] min-w-0 rounded-md border border-control-border bg-background px-1.5 font-mono text-[12px] outline-none focus:border-primary/60"
        >
          {!sources && <option value="">{loading ? "Finding logs…" : "No logs"}</option>}
          {sources && sources.length === 0 && <option value="">No logs found</option>}
          {sourceKey && sources && !listed && <option value={sourceKey}>{sourceKey}</option>}
          {groups.map(([g, list]) => (
            <optgroup key={g} label={groupLabel(g)}>
              {list.map((s) => (
                <option key={keyOf(s)} value={keyOf(s)}>
                  {s.base}
                  {list.filter((o) => o.base === s.base).length > 1 ? ` — ${s.dir.replace(/\/(current\/)?storage\/logs$/, "").split("/").pop()}` : ""}
                  {s.files.length > 1 ? `  (${s.files.length} files)` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {source && source.files.length > 1 && (
          <select
            aria-label="File"
            value={pin ?? ""}
            onChange={(ev) => {
              setError(null);
              setPin(ev.target.value || null);
            }}
            className="h-7 max-w-[26em] min-w-0 rounded-md border border-control-border bg-background px-1.5 font-mono text-[12px] outline-none focus:border-primary/60"
            title="The newest file follows new days and rotations by itself"
          >
            <option value="">Newest ({source.files[0]?.name})</option>
            {source.files.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name} · {size(f.size)} · {day(f.mtime)}
              </option>
            ))}
          </select>
        )}
        {server && <EnvTag env={envOf(source)} />}
        {cursor?.sudo && <span className="rounded bg-env-staging/15 px-1.5 text-[10.5px] text-env-staging-fg" title="Only root can read this log: read with sudo">sudo</span>}
        <div className="flex-1" />
        <div className="flex h-7 flex-none items-center rounded-md border border-control-border p-0.5 text-[11.5px]" role="group" aria-label="Level">
          {(
            [
              ["all", "All"],
              ["info", "Info+"],
              ["warning", `Warn+${counts.warnings + counts.errors ? ` ${counts.warnings + counts.errors}` : ""}`],
              ["error", `Errors${counts.errors ? ` ${counts.errors}` : ""}`],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setMinLevel(v)}
              className={cn(
                "h-full cursor-pointer rounded px-2",
                minLevel === v ? (v === "error" ? "bg-env-prod/12 text-env-prod-fg" : "bg-selected text-foreground") : "text-subtle-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative flex-none">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Filter (⌘F)"
            spellCheck={false}
            aria-label="Filter"
            className="h-7 w-[13em] rounded-md border border-control-border bg-background pr-6 pl-7 font-mono text-[12px] outline-none focus:border-primary/60"
          />
          {query && (
            <button className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer text-subtle-foreground hover:text-foreground" aria-label="Clear filter" onClick={() => setQuery("")}>
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <Btn
          size="sm"
          variant={following && !error ? "outline" : "ghost"}
          title={following ? "Pause following" : "Follow new lines"}
          onClick={() => {
            if (error) {
              setError(null);
              setFollowing(true);
            } else setFollowing((f) => !f);
          }}
          disabled={!cursor}
        >
          {following && !error ? (
            <>
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> Live <Pause className="size-3.5" />
            </>
          ) : (
            <>
              <Play className="size-3.5" /> Follow
            </>
          )}
        </Btn>
        <Btn size="sm" variant="ghost" title="Reload" aria-label="Reload" onClick={() => {
          setError(null);
          void loadSources();
          if (source) void openLog(source, pin);
        }}>
          <RotateCw className={cn("size-4", loading && "animate-spin")} />
        </Btn>
        <Btn size="sm" variant="ghost" title="Clear the view (the file isn't touched)" aria-label="Clear the view" onClick={() => {
          setList([]);
          setExpanded(new Set());
          setUnseen(0);
          setCursor((c) => (c ? { ...c, start: c.end } : c));
        }} disabled={!entries.length}>
          <Eraser className="size-4" />
        </Btn>
        <Btn size="sm" variant="ghost" title="Download this file" aria-label="Download" onClick={() => void download()} disabled={!cursor}>
          <Download className="size-4" />
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          title="Open its folder in Files"
          aria-label="Open folder"
          disabled={!source || !server}
          onClick={() => server && source && openFiles(server, { appId, dir: source.dir, env: envOf(source), title: `${appId ?? serverId} · files` })}
        >
          <FolderOpen className="size-4" />
        </Btn>
      </div>
      {error && (
        <div className="flex flex-none items-center gap-3 bg-env-prod/8 px-4 py-2 text-[12px] text-env-prod-fg">
          <span className="min-w-0 flex-1">{error}</span>
          <Btn size="sm" variant="outline" onClick={() => {
            setError(null);
            if (!sources) void loadSources();
            else if (source && !cursor) void openLog(source, pin);
          }}>
            Try again
          </Btn>
        </div>
      )}
      <div
        ref={listRef}
        className="relative min-h-0 flex-1 overflow-y-auto"
        style={font}
        onScroll={(ev) => {
          const el = ev.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          stickRef.current = atBottom;
          if (atBottom && unseen) setUnseen(0);
        }}
      >
        {cursor && (
          <div className="flex items-center justify-center gap-2 py-2 text-[0.8em] text-subtle-foreground">
            {shown.length > limit ? (
              <button className="cursor-pointer text-primary hover:underline" onClick={() => setLimit((l) => l + PAGE)}>
                Show {Math.min(PAGE, shown.length - limit).toLocaleString()} more
              </button>
            ) : cursor.start > 0 ? (
              <button className="cursor-pointer text-primary hover:underline" onClick={() => void loadEarlier()} disabled={loading}>
                Load earlier ({size(cursor.start)} before this)
              </button>
            ) : (
              <span>Start of {fileName}</span>
            )}
          </div>
        )}
        {cursor && entries.length === 0 && !loading && (
          <div className="px-4 py-6 text-[0.9em] text-subtle-foreground">{fileName} is empty{following ? ": new lines show up here as they're written." : "."}</div>
        )}
        {entries.length > 0 && shown.length === 0 && <div className="px-4 py-6 text-[0.9em] text-subtle-foreground">Nothing matches.</div>}
        {visibleRows.map((e) =>
          e.marker ? (
            <div key={e.id} className="my-1 flex items-center gap-3 px-4 text-[0.78em] text-subtle-foreground">
              <span className="h-px flex-1 bg-divider" />
              {e.head}
              <span className="h-px flex-1 bg-divider" />
            </div>
          ) : (
            <Row key={e.id} e={e} open={expanded.has(e.id)} onToggle={() => toggle(e.id)} query={query.trim()} />
          ),
        )}
        {unseen > 0 && (
          <button
            className="sticky bottom-3 left-full mr-4 flex cursor-pointer items-center gap-1 rounded-full bg-primary px-3 py-1 text-[11.5px] text-primary-foreground shadow-md"
            onClick={() => {
              const el = listRef.current;
              stickRef.current = true;
              setUnseen(0);
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            <ArrowDown className="size-3.5" /> {unseen.toLocaleString()} new
          </button>
        )}
      </div>
      <div className="flex h-7 flex-none items-center gap-3 border-t border-divider px-4 text-[11px] text-subtle-foreground">
        <span className="min-w-0 truncate font-mono" title={cursor?.path}>
          {cursor?.path ?? (source ? keyOf(source) : "")}
        </span>
        {cursor && <span className="flex-none">{size(cursor.size)}</span>}
        {cursor && cursor.mtime > 0 && <span className="flex-none">written {day(cursor.mtime)}</span>}
        <span className="flex-1" />
        {cursor && <span className="flex-none">{shown.length.toLocaleString()} of {entries.filter((x) => !x.marker).length.toLocaleString()} entries</span>}
        {cursor && <span className="flex-none">{error ? "stopped" : following ? "following" : "paused"}</span>}
      </div>
    </div>
  );
}

function Mark({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let i = 0;
  for (let j = lower.indexOf(needle); j >= 0 && parts.length < 40; j = lower.indexOf(needle, i)) {
    parts.push(text.slice(i, j), <mark key={j} className="rounded-sm bg-yellow-300/70 text-inherit">{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}

function Row({ e, open, onToggle, query }: { e: LogEntry; open: boolean; onToggle: () => void; query: string }) {
  const lines = e.body ? e.body.split("\n").length : 0;
  const rank = e.level ? LEVEL_RANK[e.level] : -1;
  return (
    <div className={cn("border-b border-divider/60", rank >= 4 && "bg-env-prod/[0.04]", rank === 3 && "bg-env-staging/[0.05]")}>
      <div
        role="row"
        onClick={() => {
          // Selecting text shouldn't fold the entry.
          if (!window.getSelection()?.toString()) onToggle();
        }}
        className="group grid cursor-pointer grid-cols-[1em_8.5em_6em_minmax(0,1fr)_auto] items-baseline gap-2 px-3 py-[3px] hover:bg-hover-strong/50"
      >
        <ChevronRight className={cn("size-3 self-center text-subtle-foreground transition-transform", open && "rotate-90", !lines && !open && "opacity-0 group-hover:opacity-60")} />
        <span className="truncate text-[0.85em] text-subtle-foreground" title={e.time ?? undefined}>
          {e.time ? shortTime(e.time) : ""}
        </span>
        <span>
          {e.level && <span className={cn("inline-block rounded px-1.5 text-[0.75em] leading-[1.6] font-medium uppercase", LEVEL_STYLE[e.level])}>{e.level === "warning" ? "warn" : e.level === "critical" ? "crit" : e.level}</span>}
        </span>
        <span className={cn("min-w-0 truncate", rank >= 4 && "text-env-prod-fg")}>
          <Mark text={e.head} q={query} />
          {(e.where || e.extra) && <span className="ml-2 text-[0.85em] text-subtle-foreground">{e.where ?? e.extra}</span>}
        </span>
        <span className="text-[0.78em] text-subtle-foreground">{lines > 0 ? `+${lines}` : ""}</span>
      </div>
      {open && (
        <div className="relative mx-3 mb-2 ml-[2.4em] rounded-md border border-divider bg-panel">
          <button
            className="absolute top-1.5 right-1.5 flex cursor-pointer items-center gap-1 rounded border border-control-border bg-background px-1.5 py-0.5 text-[11px] text-subtle-foreground hover:text-foreground"
            onClick={() => void copyText(e.raw)}
            title="Copy this entry"
          >
            <Copy className="size-3" /> Copy
          </button>
          <pre className="selectable max-h-[60vh] overflow-auto px-3 py-2 pr-16 text-[0.85em] leading-[1.45] break-words whitespace-pre-wrap">
            <Mark text={e.raw} q={query} />
          </pre>
        </div>
      )}
    </div>
  );
}
