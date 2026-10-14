import { RotateCcw, Workflow as WorkflowIcon, X } from "lucide-react";
import { useEffect, useReducer, useState } from "react";

import { Glyph, Spinner } from "@/components/kit/Spinner";
import { auditList, type AuditRun, type Workflow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { useTabs, type Tab } from "@/stores/tabs";
import { useWorkflows } from "@/stores/workflows";

const NO_WORKFLOWS: Workflow[] = [];

const hms = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const when = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? hms(ms) : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hms(ms)}`;
};
const took = (from?: number, to?: number | null) => {
  if (!from || !to) return "";
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
/** A run's exit code says where it stopped: 100 + the step. */
const failedStep = (code: number | null | undefined) => (code !== null && code !== undefined && code > 100 && code < 200 ? code - 100 : null);

/** Left of the Workflows tab: this session's runs (live: click to see one)
 *  and earlier ones from History, newest first. Running one again adds a
 *  new line. */
export function WorkflowRuns() {
  const tabs = useTabs((s) => s.tabs);
  const groups = useTabs((s) => s.groups);
  const activeId = useTabs((s) => s.activeId);
  const workflows = useConfig((s) => s.snapshot?.config?.workflows ?? NO_WORKFLOWS);
  const runs = groups
    .filter((g) => g.workflow)
    .map((g) => ({ g, main: tabs.find((t) => t.groupId === g.id && t.workflow && !t.workflow.part) }))
    .filter((r): r is { g: (typeof groups)[number]; main: Tab } => !!r.main)
    .reverse();
  const front = groups.find((g) => g.workflow && tabs.some((t) => t.id === activeId && t.groupId === g.id));

  // Earlier runs from History; again whenever a run here finishes.
  const [earlier, setEarlier] = useState<AuditRun[]>([]);
  const finished = runs.filter((r) => r.main.state !== "running").length;
  useEffect(() => {
    auditList({ query: "workflow:", limit: 80 }).then(
      (r) => setEarlier(r.runs.filter((x) => x.actionId.startsWith("workflow:") && !/ · (step \d|watch)/.test(x.label))),
      () => setEarlier([]),
    );
  }, [finished]);
  const live = new Set(runs.map((r) => r.main.auditId).filter((id): id is number => id !== undefined));
  const past = earlier.filter((r) => !live.has(r.id));
  const exists = (id: string) => workflows.some((w) => w.id === id);

  return (
    <aside className="flex w-[300px] min-h-0 flex-none flex-col border-r border-divider bg-sidebar">
      <div className="flex-none border-b border-divider px-3.5 py-3">
        <div className="mb-2 text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">Run</div>
        {workflows.length === 0 ? (
          <button onClick={() => useWorkflows.getState().edit(null)} className="text-[12px] text-primary hover:underline">
            + New workflow
          </button>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {workflows.map((w) => (
              <button
                key={w.id}
                onClick={() => useWorkflows.getState().run(w.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  useWorkflows.getState().edit(w);
                }}
                title={`${w.steps.length} step${w.steps.length === 1 ? "" : "s"} · click: run (shows the steps first) · right-click: edit`}
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/8 px-2 text-[12px] font-medium text-foreground hover:bg-primary/15"
              >
                <WorkflowIcon className="size-3.5 text-primary" strokeWidth={1.75} />
                {w.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {runs.length > 0 && <div className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">This session</div>}
        {runs.map(({ g, main }) => (
          <LiveRun key={g.id} tab={main} groupId={g.id} selected={front?.id === g.id} />
        ))}
        <div className="px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">Earlier</div>
        {past.length === 0 && <div className="px-2 py-1 text-[12px] text-subtle-foreground">Nothing yet.</div>}
        {past.map((r) => {
          const id = r.actionId.slice("workflow:".length);
          const step = failedStep(r.exitCode);
          const ok = exists(id);
          return (
            <div key={r.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] hover:bg-hover">
              <span className="w-4 flex-none text-center">
                {r.exitCode === 0 ? <Glyph className="text-term-green">✓</Glyph> : r.exitCode === null ? <Glyph className="text-subtle-foreground">·</Glyph> : <Glyph className="text-term-red">✗</Glyph>}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{r.label}</span>
                <span className="truncate text-[11px] text-subtle-foreground">
                  {when(r.startedAt)}
                  {r.finishedAt ? ` · ${took(r.startedAt, r.finishedAt)}` : ""}
                  {step ? ` · stopped at step ${step}` : r.exitCode !== null && r.exitCode !== 0 ? ` · exit ${r.exitCode}` : ""}
                </span>
              </span>
              {ok && (
                <span className="flex flex-none gap-1 opacity-0 group-hover:opacity-100">
                  {step && (
                    <button
                      title={`Run again from step ${step}`}
                      onClick={() => useWorkflows.getState().run(id, step)}
                      className="h-6 cursor-pointer rounded-md border border-control-border px-1.5 text-[11px] text-soft-foreground hover:bg-hover-strong hover:text-foreground"
                    >
                      From {step}
                    </button>
                  )}
                  <button
                    title="Run again (a new line at the top)"
                    aria-label={`Run ${r.label} again`}
                    onClick={() => useWorkflows.getState().run(id)}
                    className="flex size-6 cursor-pointer items-center justify-center rounded-md border border-control-border text-soft-foreground hover:bg-hover-strong hover:text-foreground"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** A run from this session: click shows it on the right. */
function LiveRun({ tab, groupId, selected }: { tab: Tab; groupId: string; selected: boolean }) {
  const run = tab.workflow!;
  // The tracker (current step, finish) lives outside the store.
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => run.tracker.subscribe(rerender), [run.tracker]);
  const t = run.tracker;
  const started = t.steps.map((s) => s.startedAt).find((x) => x !== undefined);
  const cur = t.current;
  const step = failedStep(tab.exitCode);
  const running = tab.state === "running";
  const close = async () => {
    if (running && !(await askConfirm(`Stop ${run.name}?`, "It's still running: closing it stops it.", "Stop and close"))) return;
    useTabs.getState().closeGroup(groupId);
  };
  return (
    <div
      onClick={() => useTabs.getState().activate(tab.id)}
      className={cn("group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px]", selected ? "bg-selected" : "hover:bg-hover")}
    >
      <span className="w-4 flex-none text-center">
        {running ? <Spinner size={10} /> : tab.state === "ok" ? <Glyph className="text-term-green">✓</Glyph> : <Glyph className="text-term-red">✗</Glyph>}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{run.name}{run.from > 1 ? ` · from ${run.from}` : ""}</span>
        <span className="truncate text-[11px] text-subtle-foreground">
          {started ? hms(started) : "starting…"}
          {running
            ? cur
              ? ` · step ${cur} of ${run.titles.length}${t.waiting ? " · waiting for you" : ""}`
              : ""
            : `${tab.finishedAt && started ? ` · ${took(started, tab.finishedAt)}` : ""}${step ? ` · stopped at step ${step}` : ""}`}
        </span>
      </span>
      <span className="flex flex-none gap-1 opacity-0 group-hover:opacity-100">
        {!running && (
          <button
            title="Run again (a new line at the top)"
            aria-label={`Run ${run.name} again`}
            onClick={(e) => {
              e.stopPropagation();
              useWorkflows.getState().run(run.id, step ?? undefined);
            }}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md border border-control-border text-soft-foreground hover:bg-hover-strong hover:text-foreground"
          >
            <RotateCcw className="size-3.5" />
          </button>
        )}
        <button
          title={running ? "Stop and close" : "Close (it stays in History)"}
          aria-label={`Close ${run.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void close();
          }}
          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </span>
    </div>
  );
}
