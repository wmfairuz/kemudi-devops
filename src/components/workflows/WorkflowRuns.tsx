import { Pencil, Play, RotateCcw, Square, SquareTerminal, TerminalSquare, Workflow as WorkflowIcon, X } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { createPortal } from "react-dom";

import { EnvTag } from "@/components/kit/EnvTag";
import { PopupMenu } from "@/components/kit/PopupMenu";
import { Glyph, Spinner } from "@/components/kit/Spinner";
import { StepsList, setWorkflowView } from "@/components/workflows/WorkflowStepsView";
import { isAsg, openServerShell } from "@/lib/fleet";
import { auditList, type App, type AuditRun, type Config, type Server, type Workflow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { serversTouched, stepTitle } from "@/lib/workflows";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { openSsh, useTabs, WORKFLOWS_ID, type Tab } from "@/stores/tabs";
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

const where = (config: Config | null | undefined, w: Workflow) => {
  const server = config?.servers.find((s) => s.id === w.pinServer);
  const app = w.pinApp ? server?.apps.find((a) => a.id === w.pinApp) : undefined;
  return app ? `${app.name} on ${server?.name}` : (server?.name ?? "");
};

/** Where to ssh after a run failed at step `failed`: that step's server
 *  (its app, or the folder it ran in), else where the workflow is pinned. */
function sshTarget(config: Config | null | undefined, wf: Workflow | undefined, failed: number | null): { server: Server; app: App | null; dir: string | null } | null {
  if (!config || !wf) return null;
  const step = failed ? wf.steps[failed - 1] : undefined;
  const serverId = step && (step.kind === "server" || step.kind === "action" || step.kind === "watch") && step.server ? step.server : wf.pinServer;
  const server = config.servers.find((s) => s.id === serverId);
  if (!server) return null;
  const dir = step && (step.kind === "server" || step.kind === "watch") ? step.dir : null;
  const app =
    (step?.kind === "action" && step.app ? server.apps.find((a) => a.id === step.app) : undefined) ??
    (dir ? server.apps.find((a) => a.path === dir) : undefined) ??
    (server.id === wf.pinServer && wf.pinApp ? server.apps.find((a) => a.id === wf.pinApp) : undefined) ??
    null;
  return { server, app, dir };
}

function SshButton({ target, compact = false }: { target: NonNullable<ReturnType<typeof sshTarget>>; compact?: boolean }) {
  const { server, app, dir } = target;
  const open = () => {
    if (app || !dir || isAsg(server)) openServerShell(server, app);
    else openSsh(server.host, { serverId: server.id, prod: server.env === "prod", title: `${server.id} · ssh`, cwd: dir });
  };
  const name = app?.name ?? server.name;
  return compact ? (
    <button
      title={`SSH into ${name}`}
      aria-label={`SSH into ${name}`}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md border border-control-border text-soft-foreground hover:bg-hover-strong hover:text-foreground"
    >
      <SquareTerminal className="size-3.5" />
    </button>
  ) : (
    <button onClick={open} className={darkBtn} title={`A shell on ${server.name}${app ? ` in ${app.name}'s folder` : dir ? ` in ${dir}` : ""}`}>
      <SquareTerminal className="size-3.5" /> SSH into {name}
    </button>
  );
}

const darkBtn =
  "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-white/15 px-2.5 font-mono text-[12px] text-[#b6b8c8] hover:bg-white/10 hover:text-[#f8f8f2]";

/** The Workflows tab's middle: your workflows as cards. ▶ (or a click)
 *  shows the run dialog; right-click: run, edit, duplicate. */
export function WorkflowCards() {
  const config = useConfig((s) => s.snapshot?.config);
  const workflows = config?.workflows ?? NO_WORKFLOWS;
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; w: Workflow } | null>(null);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = workflows.filter((w) => {
    const hay = `${w.name} ${where(config, w)}`.toLowerCase();
    return words.every((x) => hay.includes(x));
  });
  return (
    <div className="absolute inset-0 z-10 flex flex-col overflow-y-auto bg-background">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-divider bg-background px-5 py-3">
        <span className="text-[15px] font-semibold">Workflows</span>
        <span className="text-[12px] text-subtle-foreground">{workflows.length}</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) useWorkflows.getState().run(shown[0].id);
            if (e.key === "Escape") setQ("");
          }}
          placeholder="Find a workflow (↵ runs the first)"
          spellCheck={false}
          className="h-8 w-[300px] rounded-lg border border-control-border bg-background px-2.5 text-[12.5px] outline-none placeholder:text-faint-foreground focus:border-primary/60"
        />
        <span className="flex-1" />
        <button
          onClick={() => useWorkflows.getState().edit(null)}
          className="h-8 cursor-pointer rounded-lg border border-control-border px-3 text-[12.5px] font-medium text-foreground hover:bg-hover"
        >
          + New workflow
        </button>
      </div>
      {workflows.length === 0 && <div className="px-5 py-6 text-[13px] text-subtle-foreground">No workflows yet. A workflow runs steps in order: on this Mac, on servers, actions, pauses.</div>}
      {workflows.length > 0 && shown.length === 0 && <div className="px-5 py-6 text-[13px] text-subtle-foreground">Nothing matches.</div>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] content-start gap-3 p-5">
        {shown.map((w) => {
          const prod = serversTouched(config, w).some((s) => s.env === "prod");
          return (
            <div
              key={w.id}
              onClick={() => useWorkflows.getState().run(w.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, w });
              }}
              title="Click or ▶: run (shows the steps first) · right-click: edit, duplicate"
              className="group flex cursor-pointer flex-col gap-2 rounded-xl border border-control-border bg-background p-3.5 hover:border-primary/50 hover:bg-hover/40"
            >
              <div className="flex items-center gap-2">
                <WorkflowIcon className="size-4 flex-none text-primary" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{w.name}</span>
                {prod && <EnvTag env="prod" />}
                <button
                  title={`Edit ${w.name}`}
                  aria-label={`Edit ${w.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    useWorkflows.getState().edit(w);
                  }}
                  className="flex size-6 cursor-pointer items-center justify-center rounded-md text-subtle-foreground opacity-0 group-hover:opacity-100 hover:bg-hover-strong hover:text-foreground"
                >
                  <Pencil className="size-3.5" />
                </button>
              </div>
              <ol className="flex min-h-[34px] flex-col gap-0.5 font-mono text-[11.5px] text-soft-foreground">
                {w.steps.slice(0, 3).map((s, i) => (
                  <li key={i} className="truncate">
                    <span className="text-faint-foreground">{i + 1}.</span> {stepTitle(config, s)}
                  </li>
                ))}
                {w.steps.length > 3 && <li className="text-faint-foreground">+ {w.steps.length - 3} more</li>}
              </ol>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-subtle-foreground">
                  {where(config, w) || "not pinned"} · {w.steps.length} step{w.steps.length === 1 ? "" : "s"}
                </span>
                <button
                  title={`Run ${w.name}`}
                  aria-label={`Run ${w.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    useWorkflows.getState().run(w.id);
                  }}
                  className="flex size-8 flex-none cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground hover:brightness-110"
                >
                  <Play className="ml-0.5 size-3.5" fill="currentColor" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {menu &&
        createPortal(
          <PopupMenu
            x={menu.x}
            y={menu.y}
            title={menu.w.name}
            onClose={() => setMenu(null)}
            groups={[
              [
                { label: "Run…", run: () => useWorkflows.getState().run(menu.w.id) },
                { label: "Edit…", run: () => useWorkflows.getState().edit(menu.w) },
                { label: "Duplicate…", run: () => useWorkflows.getState().duplicate(menu.w) },
              ],
            ]}
          />,
          document.body,
        )}
    </div>
  );
}

/** The Workflows tab's right column: runs, newest first (this session's,
 *  then earlier ones from History). A run opens in its row: its steps,
 *  output on demand, answers; wider while one is open over the cards. */
export function WorkflowRuns() {
  const tabs = useTabs((s) => s.tabs);
  const groups = useTabs((s) => s.groups);
  const activeId = useTabs((s) => s.activeId);
  const expanded = useWorkflows((s) => s.expanded);
  const config = useConfig((s) => s.snapshot?.config);
  const extra = useWorkflows((s) => s.extra);
  const workflows = extra.length ? [...(config?.workflows ?? NO_WORKFLOWS), ...extra] : (config?.workflows ?? NO_WORKFLOWS);
  const runs = groups
    .filter((g) => g.workflow)
    .map((g) => ({ g, main: tabs.find((t) => t.groupId === g.id && t.workflow && !t.workflow.part) }))
    .filter((r): r is { g: (typeof groups)[number]; main: Tab } => !!r.main)
    .reverse();
  const cards = activeId === WORKFLOWS_ID;
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
  const wide = cards && runs.some((r) => r.g.id === expanded);

  return (
    <aside className={cn("flex min-h-0 flex-none flex-col border-l border-divider bg-sidebar", wide ? "w-[min(560px,50%)]" : "w-[340px]")}>
      <div className="flex flex-none items-center gap-2 px-3.5 pt-3 pb-2">
        <span className="text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">Runs</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {runs.length > 0 && <div className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">This session</div>}
        {runs.map(({ g, main }) => (
          <LiveRun
            key={g.id}
            tab={main}
            groupId={g.id}
            open={expanded === g.id}
            front={front?.id === g.id}
            wf={workflows.find((w) => w.id === main.workflow?.id)}
            config={config}
          />
        ))}
        <div className="px-2 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">Earlier</div>
        {past.length === 0 && <div className="px-2 py-1 text-[12px] text-subtle-foreground">Nothing yet.</div>}
        {past.map((r) => {
          const id = r.actionId.slice("workflow:".length);
          const step = failedStep(r.exitCode);
          const wf = workflows.find((w) => w.id === id);
          const failed = r.exitCode !== null && r.exitCode !== 0;
          const target = failed ? sshTarget(config, wf, step) : null;
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
                  {step ? ` · stopped at step ${step}` : failed ? ` · exit ${r.exitCode}` : ""}
                </span>
              </span>
              {wf && (
                <span className="flex flex-none gap-1 opacity-0 group-hover:opacity-100">
                  {target && <SshButton target={target} compact />}
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

/** A run from this session. Click: open it here (its steps); Terminal:
 *  its whole terminal over the cards. */
function LiveRun({
  tab,
  groupId,
  open,
  front,
  wf,
  config,
}: {
  tab: Tab;
  groupId: string;
  open: boolean;
  front: boolean;
  wf: Workflow | undefined;
  config: Config | null | undefined;
}) {
  const run = tab.workflow!;
  // The tracker (current step, finish) lives outside the store.
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => run.tracker.subscribe(rerender), [run.tracker]);
  const t = run.tracker;
  const started = t.steps.map((s) => s.startedAt).find((x) => x !== undefined);
  const cur = t.current;
  const running = tab.state === "running";
  const step = failedStep(tab.exitCode) ?? (t.steps.findIndex((s) => s.status === "failed") + 1 || null);
  const failed = !running && tab.state !== "ok";
  const target = failed ? sshTarget(config, wf, step) : null;
  const close = async () => {
    if (running && !(await askConfirm(`Stop ${run.name}?`, "It's still running: closing it stops it.", "Stop and close"))) return;
    useTabs.getState().closeGroup(groupId);
  };
  const terminal = () => {
    setWorkflowView(tab, "output");
    useTabs.getState().activate(tab.id);
  };
  return (
    <div className={cn("mb-1 rounded-lg", open && "bg-hover/60 pb-1.5", front && "ring-1 ring-primary/40")}>
      <div
        onClick={() => {
          useWorkflows.getState().expand(open ? null : groupId);
          if (!open) useTabs.setState({ activeId: WORKFLOWS_ID });
        }}
        className={cn("group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px]", open ? "" : "hover:bg-hover")}
        title={open ? "Close it" : "Open it: its steps and output"}
      >
        <span className="w-4 flex-none text-center">
          {running ? <Spinner size={10} /> : tab.state === "ok" ? <Glyph className="text-term-green">✓</Glyph> : <Glyph className="text-term-red">✗</Glyph>}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">
            {run.name}
            {run.from > 1 ? ` · from ${run.from}` : ""}
          </span>
          <span className={cn("truncate text-[11px]", t.waiting && running ? "text-[#b7791f]" : "text-subtle-foreground")}>
            {started ? hms(started) : "starting…"}
            {running
              ? cur
                ? ` · step ${cur} of ${run.titles.length}${t.waiting ? " · waiting for you" : ""}`
                : ""
              : `${tab.finishedAt && started ? ` · ${took(started, tab.finishedAt)}` : ""}${step ? ` · stopped at step ${step}` : ""}`}
          </span>
        </span>
        <span className={cn("flex flex-none gap-1", open ? "" : "opacity-0 group-hover:opacity-100")}>
          {!open && target && <SshButton target={target} compact />}
          {!running && (
            <button
              title={step ? `Run again from step ${step} (a new line at the top)` : "Run again (a new line at the top)"}
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
      {open && (
        <div className="dracula mx-1.5 rounded-lg bg-[#282a36] font-mono text-[12.5px] text-[#f8f8f2]">
          <StepsList tab={tab} compact />
          <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-3 py-2">
            {running && (
              <button onClick={() => tab.session.send("\x03")} className={darkBtn} title="Ctrl+C: stop the running step (later steps don't run)">
                <Square className="size-3" /> Stop
              </button>
            )}
            <button onClick={terminal} className={darkBtn} title="The run's whole terminal (scroll back, type into it)">
              <TerminalSquare className="size-3.5" /> Terminal
            </button>
            {target && <SshButton target={target} />}
          </div>
        </div>
      )}
    </div>
  );
}
