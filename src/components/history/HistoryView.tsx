import { useCallback, useEffect, useMemo, useState } from "react";

import { EnvTag } from "@/components/kit/EnvTag";
import { Spinner } from "@/components/kit/Spinner";
import { SearchIcon } from "@/components/sidebar/SidebarFrame";
import { triggerAction } from "@/lib/actions";
import { auditList, errorMessage, type AuditQuery, type AuditRun, type Env } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { useTabs } from "@/stores/tabs";

const COLS = "grid grid-cols-[84px_170px_128px_118px_minmax(0,1fr)_80px_66px_64px] items-center gap-x-3 px-5";

type Range = "today" | "7d" | "30d" | "all";

function sinceMs(range: Range): number | null {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === "today") return d.getTime();
  if (range === "7d") return d.getTime() - 6 * 86_400_000;
  if (range === "30d") return d.getTime() - 29 * 86_400_000;
  return null;
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

const two = (n: number) => String(n).padStart(2, "0");
const hms = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

function duration(r: AuditRun): string {
  if (r.finishedAt === null) return "—";
  const s = (r.finishedAt - r.startedAt) / 1000;
  if (r.kind === "send") return "—";
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${two(Math.floor(s % 60))}s`;
}

function Exit({ run }: { run: AuditRun }) {
  if (run.finishedAt === null) {
    return (
      <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
        <Spinner size={9} />
        running
      </span>
    );
  }
  if (run.exitCode === null) {
    return (
      <span className="font-mono text-[11.5px] text-faint-foreground" title={run.kind === "send" ? "Typed into a tab" : "Not detectable"}>
        {run.kind === "send" ? "sent" : "—"}
      </span>
    );
  }
  const tone = run.exitCode === 0 ? "text-term-green" : run.exitCode === 130 ? "text-dim-foreground" : "text-term-red";
  return (
    <span className={cn("font-mono text-[11.5px]", tone)}>
      {run.exitCode}
      {run.exitCode === 130 ? " ^C" : ""}
    </span>
  );
}

const selectClass =
  "h-7 appearance-none rounded-lg border border-input bg-transparent pr-6 pl-2.5 text-[12px] text-muted-foreground outline-none hover:text-foreground focus:border-ring bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%228%22 height=%225%22><path d=%22M0 0l4 5 4-5z%22 fill=%22%236272a4%22/></svg>')] bg-[position:right_9px_center] bg-no-repeat";

/** Design frame 1i: searchable run history with Re-run. */
export function HistoryView() {
  const [query, setQuery] = useState("");
  const [env, setEnv] = useState<Env | "all">("all");
  const [exit, setExit] = useState<NonNullable<AuditQuery["exit"]>>("any");
  const [range, setRange] = useState<Range>("7d");
  const [data, setData] = useState<{ runs: AuditRun[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const config = useConfig((s) => s.snapshot?.config);
  const tabs = useTabs((s) => s.tabs);

  const load = useCallback(() => {
    auditList({ query, env, exit, sinceMs: sinceMs(range), limit: 500 }).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  }, [query, env, exit, range]);

  useEffect(() => {
    const t = setTimeout(load, 120);
    // Cheap local query; keeps running/finished rows current.
    const poll = setInterval(load, 2000);
    return () => {
      clearTimeout(t);
      clearInterval(poll);
    };
  }, [load]);

  const rows = useMemo(() => {
    const out: ({ sep: string } | { run: AuditRun })[] = [];
    let last = "";
    for (const run of data?.runs ?? []) {
      const label = dayLabel(run.startedAt);
      if (label !== last) out.push({ sep: label });
      last = label;
      out.push({ run });
    }
    return out;
  }, [data]);

  const actionExists = (r: AuditRun) => {
    const server = config?.servers.find((s) => s.id === r.serverId);
    if (!server) return false;
    const list = r.appId ? server.apps.find((a) => a.id === r.appId)?.actions : server.actions;
    return !!list?.some((a) => a.id === r.actionId);
  };

  return (
    <div className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2.5 border-b border-divider px-5 py-3.5">
        <div className="text-[15px] font-semibold">History</div>
        <div className="font-mono text-[11px] text-subtle-foreground">
          {data ? `${data.total.toLocaleString()} run${data.total === 1 ? "" : "s"}` : ""}
        </div>
        <div className="flex-1" />
        <label className="flex h-7 w-[280px] items-center gap-2 rounded-lg border border-control-border bg-muted px-2 text-[12.5px] text-subtle-foreground">
          <SearchIcon />
          <input
            autoFocus
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search command, app, server…"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-subtle-foreground"
          />
        </label>
        <select aria-label="Environment" value={env} onChange={(e) => setEnv(e.target.value as Env | "all")} className={selectClass}>
          <option value="all">All envs</option>
          <option value="prod">Prod</option>
          <option value="staging">Staging</option>
          <option value="dev">Dev</option>
        </select>
        <select aria-label="Exit status" value={exit} onChange={(e) => setExit(e.target.value as typeof exit)} className={selectClass}>
          <option value="any">Any exit</option>
          <option value="ok">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
        </select>
        <select aria-label="Date range" value={range} onChange={(e) => setRange(e.target.value as Range)} className={selectClass}>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All time</option>
        </select>
      </div>
      <div className={cn(COLS, "h-[30px] border-b border-divider text-[11px] font-medium text-subtle-foreground")}>
        <span>Time</span>
        <span>Server</span>
        <span>App</span>
        <span>Action</span>
        <span>Command</span>
        <span>Exit</span>
        <span className="text-right">Duration</span>
        <span />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <div className="px-5 py-4 text-[12.5px] text-env-prod-fg">{error}</div>}
        {data && data.runs.length === 0 && !error && (
          <div className="px-5 py-6 text-[12.5px] text-subtle-foreground">
            {query || env !== "all" || exit !== "any" ? "No runs match these filters." : "No runs yet. Actions you run appear here."}
          </div>
        )}
        {rows.map((row) =>
          "sep" in row ? (
            <div key={`sep-${row.sep}`} className="px-5 pt-3 pb-1.5 text-[11px] font-medium text-subtle-foreground">
              {row.sep}
            </div>
          ) : (
            <HistoryRow
              key={row.run.id}
              run={row.run}
              tabId={tabs.find((t) => t.auditId === row.run.id)?.id ?? null}
              canRerun={actionExists(row.run)}
            />
          ),
        )}
      </div>
    </div>
  );
}

function HistoryRow({ run, tabId, canRerun }: { run: AuditRun; tabId: string | null; canRerun: boolean }) {
  const running = run.finishedAt === null;
  const open = running && tabId !== null;
  return (
    <div
      className={cn(
        COLS,
        "h-[34px] border-b border-divider text-[12.5px] hover:bg-hover",
        run.env === "prod" && "shadow-[inset_2px_0_0_rgb(255_85_85/0.6)]",
      )}
    >
      <span className="font-mono text-[11.5px] text-dim-foreground">{hms(run.startedAt)}</span>
      <span className="flex min-w-0 items-center gap-[7px]">
        <EnvTag env={run.env} />
        <span className="truncate">{run.serverId}</span>
      </span>
      <span className={cn("truncate", run.appId ? "text-foreground" : "text-faint-foreground")}>{run.appId ?? "—"}</span>
      <span className="truncate text-soft-foreground" title={run.kind === "local" ? "Ran on this Mac" : undefined}>
        {run.label}
        {run.edited && <span className="ml-1 text-[10.5px] text-env-staging-fg">edited</span>}
      </span>
      <span className="selectable truncate font-mono text-[11.5px] text-dim-foreground" title={run.command}>
        {run.command.replace(/\s*\n\s*/g, " ")}
      </span>
      <Exit run={run} />
      <span className="text-right font-mono text-[11.5px] text-subtle-foreground">{duration(run)}</span>
      <button
        disabled={!open && !canRerun}
        title={!open && !canRerun ? "This action no longer exists" : undefined}
        onClick={() => {
          if (open && tabId) useTabs.getState().activate(tabId);
          else void triggerAction({ serverId: run.serverId, appId: run.appId, actionId: run.actionId }, { command: run.command });
        }}
        className="h-6 justify-self-end rounded-md border border-input bg-transparent px-2 text-[11.5px] font-medium text-soft-foreground enabled:hover:bg-secondary enabled:hover:text-foreground disabled:opacity-40"
      >
        {open ? "Open" : "Re-run"}
      </button>
    </div>
  );
}
