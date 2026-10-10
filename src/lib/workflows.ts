// Running a workflow: one terminal tab for all its steps. When a step fails
// the tab's exit code is 100 + that step's number, and a toast offers to run
// again from there.
import { blockIntro } from "@/lib/actions";
import { killPty, workflowBranchRun, workflowRun, workflowWatchRun, type Config, type Server, type Workflow, type WorkflowStep } from "@/lib/ipc";
import { StepTracker } from "@/lib/stepTracker";
import { localHms } from "@/lib/time";
import { useConfig } from "@/stores/config";
import { useTabs, type WorkflowRunState } from "@/stores/tabs";
import { useToasts } from "@/stores/toasts";
import { useWorkflows } from "@/stores/workflows";

const short = (s: string) => {
  const one = s.split("\n")[0]?.trim() ?? "";
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
};

/** A step's title: its label, else what it does and where. */
export function stepTitle(config: Config | null | undefined, step: WorkflowStep): string {
  if (step.label) return step.label;
  const server = (id: string) => config?.servers.find((s) => s.id === id);
  switch (step.kind) {
    case "local":
      return `this Mac · ${short(step.run)}`;
    case "server":
      return `${server(step.server)?.name ?? step.server}${step.root ? " (root)" : ""} · ${short(step.run)}`;
    case "action": {
      const srv = server(step.server);
      const app = step.app ? srv?.apps.find((a) => a.id === step.app) : undefined;
      const action = (app ? app.actions : srv?.actions)?.find((a) => a.id === step.action);
      return `${app?.name ?? srv?.name ?? step.server} · ${action?.label ?? step.action}`;
    }
    case "pause":
      return `pause · ${short(step.text)}`;
    case "parallel":
      return `${step.branches.length} at once`;
    case "watch":
      return `watch on ${step.server ? (server(step.server)?.name ?? step.server) : "this Mac"} · ${short(step.run)}`;
  }
}

/** The servers a run from `from` touches (parallel branches and watches
 *  too), production first. */
export function serversTouched(config: Config | null | undefined, wf: Workflow, from = 1): Server[] {
  const ids = new Set<string>();
  const add = (s: WorkflowStep) => {
    if (s.kind === "server" || s.kind === "action") ids.add(s.server);
    if (s.kind === "watch" && s.server) ids.add(s.server);
    if (s.kind === "parallel") s.branches.forEach(add);
  };
  wf.steps.slice(from - 1).forEach(add);
  const out = [...ids].map((id) => config?.servers.find((s) => s.id === id)).filter((s): s is Server => !!s);
  return out.sort((a, b) => Number(b.env === "prod") - Number(a.env === "prod"));
}

/** Pinned to this server (and app; a server's own: no app). */
export function pinnedHere(config: Config | null | undefined, serverId: string, appId: string | null): Workflow[] {
  return (config?.workflows ?? []).filter((w) => w.pinServer === serverId && (w.pinApp ?? null) === appId);
}

/** Call `done(exit code)` once tab `id` stops running (or is closed). */
function whenEnded(id: string, done: (code: number | undefined, closed: boolean) => void) {
  const unsubscribe = useTabs.subscribe((s) => {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) {
      unsubscribe();
      return done(undefined, true);
    }
    if (tab.state === "running") return;
    unsubscribe();
    done(tab.exitCode, false);
  });
}

function patchRun(id: string, patch: Partial<WorkflowRunState>) {
  const tab = useTabs.getState().tabs.find((t) => t.id === id);
  if (tab?.workflow) useTabs.getState().update(id, { workflow: { ...tab.workflow, ...patch } });
}

/** Open a tab running `wf` from step `from`. Parallel steps and watches open
 *  their own panes next to it when the run gets there. */
export function runWorkflow(wf: Workflow, from = 1): string {
  const config = useConfig.getState().snapshot?.config;
  const prod = serversTouched(config, wf, from).some((s) => s.env === "prod");
  const steps = wf.steps.length;
  let token = "";
  let tabId: string | null = null;
  tabId = useTabs.getState().open({
    kind: "action",
    title: `${wf.name}${from > 1 ? ` · from ${from}` : ""}`,
    serverId: wf.pinServer ?? undefined,
    appId: wf.pinApp,
    actionId: `workflow:${wf.id}`,
    local: true,
    prod,
    state: "running",
    intro: blockIntro(
      `workflow ${wf.name} · ${steps} step${steps === 1 ? "" : "s"}${from > 1 ? ` · from step ${from}` : ""} · ${localHms()}`,
      wf.steps
        .slice(from - 1)
        .map((s, i) => `${from + i}. ${stepTitle(config, s)}`)
        .join("\n"),
    ),
    spawn: (cols, rows, onData, onEvent) =>
      workflowRun(wf.id, from, cols, rows, onData, onEvent).then((info) => {
        token = info.token;
        if (info.auditId !== null && tabId) useTabs.getState().update(tabId, { auditId: info.auditId });
        return info.ptyId;
      }),
  });
  const id = tabId;

  // A parallel step: a pane per branch (the first to the right, the rest
  // under it), each with its own Steps view (and answer box).
  const openBranches = (k: number) => {
    const step = wf.steps[k - 1];
    if (step?.kind !== "parallel" || !token) return;
    const ids: string[] = [];
    step.branches.forEach((b, i) => {
      const n = i + 1;
      const title = `${k}.${n} · ${stepTitle(config, b)}`;
      let bid: string | null = null;
      bid = useTabs.getState().open({
        kind: "action",
        title,
        serverId: wf.pinServer ?? undefined,
        appId: wf.pinApp,
        actionId: `workflow:${wf.id}`,
        local: true,
        prod,
        state: "running",
        into: { from: i === 0 ? id : ids[i - 1]!, dir: i === 0 ? "row" : "col" },
        intro: blockIntro(`workflow ${wf.name} · step ${k}.${n} · ${localHms()}`, stepTitle(config, b)),
        spawn: (cols, rows, onData, onEvent) =>
          workflowBranchRun(wf.id, k, n, token, cols, rows, onData, onEvent).then((info) => {
            if (info.auditId !== null && bid) useTabs.getState().update(bid, { auditId: info.auditId });
            return info.ptyId;
          }),
      });
      ids.push(bid);
      const pane = useTabs.getState().tabs.find((t) => t.id === bid);
      if (pane) {
        const tracker = new StepTracker(pane.session.term, 1, 1);
        useTabs.getState().update(bid, {
          workflow: { id: wf.id, name: title, from: 1, titles: [stepTitle(config, b)], kinds: [b.kind], tracker, view: "steps", part: true },
        });
        whenEnded(bid, (code) => tracker.exited(code));
      }
    });
    const run = useTabs.getState().tabs.find((t) => t.id === id)?.workflow;
    patchRun(id, { branches: { ...(run?.branches ?? {}), [k]: ids } });
    useTabs.getState().activate(id);
  };

  // A watch step: its command in a pane under the run.
  const openWatch = (k: number) => {
    const step = wf.steps[k - 1];
    if (step?.kind !== "watch") return;
    const wid = useTabs.getState().open({
      kind: "action",
      title: `watch · ${stepTitle(config, step)}`,
      serverId: step.server ?? wf.pinServer ?? undefined,
      appId: wf.pinApp,
      actionId: `workflow:${wf.id}`,
      local: true,
      prod,
      state: "running",
      into: { from: id, dir: "col" },
      intro: blockIntro(`workflow ${wf.name} · watch (step ${k}) · ${localHms()}`, step.run),
      spawn: (cols, rows, onData, onEvent) => workflowWatchRun(wf.id, k, cols, rows, onData, onEvent).then((info) => info.ptyId),
    });
    const run = useTabs.getState().tabs.find((t) => t.id === id)?.workflow;
    patchRun(id, { watches: { ...(run?.watches ?? {}), [k]: { tab: wid, keep: step.keep } } });
    useTabs.getState().activate(id);
  };

  const opened = useTabs.getState().tabs.find((t) => t.id === id);
  const tracker = opened ? new StepTracker(opened.session.term, steps, from, { group: openBranches, watch: openWatch }) : null;
  if (tracker) {
    useTabs.getState().update(id, {
      workflow: {
        id: wf.id,
        name: wf.name,
        from,
        titles: wf.steps.map((s) => stepTitle(config, s)),
        kinds: wf.steps.map((s) => s.kind),
        tracker,
        view: wf.view === "terminal" ? "output" : "steps",
      },
    });
  }
  whenEnded(id, (code, closed) => {
    tracker?.exited(code);
    // Watches stop with the run (unless kept).
    const run = useTabs.getState().tabs.find((t) => t.id === id)?.workflow;
    for (const w of Object.values(run?.watches ?? {})) {
      if (w.keep) continue;
      const pty = useTabs.getState().tabs.find((t) => t.id === w.tab)?.session.ptyId;
      if (pty !== null && pty !== undefined) void killPty(pty).catch(() => {});
    }
    if (closed) return;
    const c = code ?? 0;
    if (c > 100 && c <= 100 + steps) {
      const n = c - 100;
      useToasts.getState().push(`${wf.name} stopped at step ${n}: ${stepTitle(config, wf.steps[n - 1]!)}`, "error", {
        label: `Run from step ${n}`,
        run: () => useWorkflows.getState().run(wf.id, n),
      });
    }
  });
  return id;
}
