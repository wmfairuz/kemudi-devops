// Running a workflow: one terminal tab for all its steps. When a step fails
// the tab's exit code is 100 + that step's number, and a toast offers to run
// again from there.
import { blockIntro } from "@/lib/actions";
import { workflowRun, type Config, type Server, type Workflow, type WorkflowStep } from "@/lib/ipc";
import { StepTracker } from "@/lib/stepTracker";
import { localHms } from "@/lib/time";
import { useConfig } from "@/stores/config";
import { useTabs } from "@/stores/tabs";
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
  }
}

/** The servers a run from `from` touches, production first. */
export function serversTouched(config: Config | null | undefined, wf: Workflow, from = 1): Server[] {
  const ids = new Set<string>();
  for (const s of wf.steps.slice(from - 1)) if (s.kind === "server" || s.kind === "action") ids.add(s.server);
  const out = [...ids].map((id) => config?.servers.find((s) => s.id === id)).filter((s): s is Server => !!s);
  return out.sort((a, b) => Number(b.env === "prod") - Number(a.env === "prod"));
}

/** Pinned to this server (and app; a server's own: no app). */
export function pinnedHere(config: Config | null | undefined, serverId: string, appId: string | null): Workflow[] {
  return (config?.workflows ?? []).filter((w) => w.pinServer === serverId && (w.pinApp ?? null) === appId);
}

/** Open a tab running `wf` from step `from`. */
export function runWorkflow(wf: Workflow, from = 1): string {
  const config = useConfig.getState().snapshot?.config;
  const prod = serversTouched(config, wf, from).some((s) => s.env === "prod");
  const steps = wf.steps.length;
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
        if (info.auditId !== null && tabId) useTabs.getState().update(tabId, { auditId: info.auditId });
        return info.ptyId;
      }),
  });
  const id = tabId;
  const opened = useTabs.getState().tabs.find((t) => t.id === id);
  const tracker = opened ? new StepTracker(opened.session.term, steps, from) : null;
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
  const unsubscribe = useTabs.subscribe((s) => {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return unsubscribe();
    if (tab.state === "running") return;
    unsubscribe();
    const code = tab.exitCode ?? 0;
    tracker?.exited(code);
    if (tab.state === "failed" && code > 100 && code <= 100 + steps) {
      const n = code - 100;
      useToasts.getState().push(`${wf.name} stopped at step ${n}: ${stepTitle(config, wf.steps[n - 1]!)}`, "error", {
        label: `Run from step ${n}`,
        run: () => useWorkflows.getState().run(wf.id, n),
      });
    }
  });
  return id;
}
