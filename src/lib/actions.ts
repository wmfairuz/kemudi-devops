// What happens when an action is clicked: the guardrail decision, running it
// in a new tab, or typing it into the current tab.
import {
  actionRender,
  actionRenderMac,
  actionRun,
  actionSend,
  errorMessage,
  vpnConnect,
  type ActionRef,
  type Confirm,
  type Env,
  type RenderedAction,
} from "@/lib/ipc";
import { findServer, useConfig } from "@/stores/config";
import { useWorkflows } from "@/stores/workflows";
import { askParams } from "@/stores/params";
import { useStatus } from "@/stores/status";
import { useActionFlow, type FlowDialog } from "@/stores/actionFlow";
import { activeTab, groupOf, terminalPanes, useTabs, type Tab } from "@/stores/tabs";
import { instanceLabel, isAsg, runOnAsg } from "@/lib/fleet";
import { toastError, useToasts } from "@/stores/toasts";
import { escapeCommand } from "@/lib/blocks";
import { localHms } from "@/lib/time";

export type Decision = "run" | FlowDialog;

/**
 * What a click does, from the action's `confirm` level (explicit in
 * servers.yaml, else prod+danger → type, prod or danger → warn, else none):
 *   none: run;  warn: show the command (prod: red confirm);  type: also type
 *   the server name. ⌥-click or an edited command always shows it first.
 */
export function decide(confirm: Confirm, env: Env, alt: boolean): Decision {
  if (confirm === "type") return "dangerConfirm";
  if (confirm === "warn" || alt) return env === "prod" ? "prodConfirm" : "preview";
  return "run";
}

export function refOf(a: RenderedAction): ActionRef {
  return { serverId: a.serverId, appId: a.appId, actionId: a.actionId, values: a.values };
}

interface TriggerOptions {
  /** ⌥-click / "Edit command…": open with the command editable. */
  alt?: boolean;
  /** Start from this command instead of the rendered one (History re-run). */
  command?: string;
}

/** Sidebar/palette/History entry point: VPN gate, then the guardrails. */
export async function triggerAction(ref: ActionRef, opts: TriggerOptions = {}): Promise<void> {
  let rendered: RenderedAction;
  try {
    rendered = await actionRender(ref);
    // Its own variables (`{{ ip }}`) are asked for first; a History re-run
    // already has its whole command.
    if (rendered.params.length > 0 && opts.command === undefined) {
      const values = await askParams(rendered);
      if (!values) return;
      ref = { ...ref, values };
      rendered = await actionRender(ref);
    }
  } catch (e) {
    toastError(errorMessage(e));
    return;
  }
  // VPN servers are probed before anything else: no point confirming a
  // command that can't connect. (action_run enforces this again.)
  if (rendered.kind === "ssh" && rendered.vpn !== "none") {
    const [status] = await useStatus.getState().refresh([rendered.serverId]);
    if (status && status.state !== "up") {
      useActionFlow.getState().show("vpn", rendered, { status, retry: () => void triggerAction(ref, opts) });
      return;
    }
  }
  const edited = opts.command !== undefined && opts.command.trim() !== rendered.rendered;
  // An edited command (re-run) always gets a look before it runs.
  const decision = decide(rendered.confirm, rendered.env, (opts.alt ?? false) || edited);
  if (decision === "run") runAction(rendered);
  else
    useActionFlow.getState().show(decision, rendered, {
      command: edited ? (opts.command ?? null) : null,
      edit: opts.alt ?? false,
    });
}

/** The local shell in front (for "Type into …"), if any. */
export function localShellInFront(): Tab | null {
  const tab = activeTab(useTabs.getState());
  return tab && (tab.kind === "local" || tab.local) && tab.session.status === "running" && !tab.workflow ? tab : null;
}

/** Right-click ▸ Type into <local shell>: the action's command, editable,
 *  to type at that shell's prompt (on this Mac, not on the server). */
export async function typeHere(ref: ActionRef): Promise<void> {
  try {
    let rendered = await actionRender(ref);
    if (rendered.params.length > 0) {
      const values = await askParams(rendered);
      if (!values) return;
      ref = { ...ref, values };
      rendered = await actionRender(ref);
    }
    useActionFlow.getState().show("preview", rendered, { edit: true, here: true });
  } catch (e) {
    toastError(errorMessage(e));
  }
}

/** A shared action in the shell on this Mac in front (This Mac panel): one
 *  that asks first (danger, or ⌥-click) opens the command to check; else it
 *  is typed and entered right away. */
export async function runOnMac(actionId: string, appLevel: boolean, alt: boolean): Promise<void> {
  const tab = localShellInFront();
  if (!tab) return;
  try {
    let r = await actionRenderMac(actionId, appLevel);
    if (r.params.length > 0) {
      const values = await askParams(r);
      if (!values) return;
      r = await actionRenderMac(actionId, appLevel, values);
    }
    if (alt || r.confirm !== "none") {
      useActionFlow.getState().show("preview", r, { edit: true, here: true });
      return;
    }
    tab.session.paste(r.command, { submit: true });
    tab.session.focus();
  } catch (e) {
    toastError(errorMessage(e));
  }
}

/** A workflow's run is recorded as action `workflow:<id>`: the id, else null. */
export function workflowOf(actionId: string): string | null {
  return actionId.startsWith("workflow:") ? actionId.slice("workflow:".length) : null;
}

/** Whether a History row can run again: a workflow or an action that still
 *  exists. (History also records things done from Kemudi's own screens:
 *  certificates, New app, queues, file permissions…; those don't re-run.) */
export function canRunAgain(r: { serverId: string; appId: string | null; actionId: string }): boolean {
  const config = useConfig.getState().snapshot?.config;
  const wf = workflowOf(r.actionId);
  if (wf !== null) return !!config?.workflows.some((w) => w.id === wf);
  const server = config?.servers.find((s) => s.id === r.serverId);
  const list = r.appId ? server?.apps.find((a) => a.id === r.appId)?.actions : server?.actions;
  return !!list?.some((a) => a.id === r.actionId);
}

/** Run again from History or Home's Recent runs: a workflow opens its run
 *  dialog (with its own confirmation); an action asks like a click, starting
 *  from the command that ran. */
export function runAgain(r: { serverId: string; appId: string | null; actionId: string; command: string }): void {
  const wf = workflowOf(r.actionId);
  if (wf !== null) {
    if (useConfig.getState().snapshot?.config?.workflows.some((w) => w.id === wf)) useWorkflows.getState().run(wf);
    else toastError(`The workflow ${wf} isn't in Kemudi any more`);
    return;
  }
  void triggerAction({ serverId: r.serverId, appId: r.appId, actionId: r.actionId }, { command: r.command });
}

/** "Connect VPN": a local tab running the server's `vpn_connect`, so the
 *  sudo prompt is right there. Re-probes until the server answers. */
export function connectVpn(serverId: string): void {
  const server = findServer(serverId);
  useTabs.getState().open({
    kind: "action",
    title: `${serverId} · vpn`,
    serverId,
    local: true,
    prod: server?.env === "prod",
    state: "running",
    intro: blockIntro(`connecting VPN for ${serverId} · ${localHms()}`, server?.vpnConnect ?? ""),
    spawn: (cols, rows, onData, onEvent) => vpnConnect(serverId, cols, rows, onData, onEvent),
  });
  // Poll every 3s for up to 2 minutes; tell the user when it's up.
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    const [s] = await useStatus.getState().refresh([serverId]);
    if (s?.state === "up") {
      clearInterval(timer);
      useToasts.getState().push(`${serverId} is reachable — VPN is up.`, "info");
    } else if (tries >= 40) {
      clearInterval(timer);
    }
  }, 3000);
}

/** Header + command line written by Kemudi into a tab that runs `command`,
 *  framed as one command block (OSC 133 A/E/C); the backend closes it with
 *  133;D. The command gets a neutral "›", not "$": it isn't the server's
 *  prompt (which may be "#" for root). */
export function blockIntro(header: string, command: string): string {
  const cmd = command.replace(/\r?\n/g, "\r\n  ");
  return (
    `\x1b]133;A\x07\x1b[36mkemudi\x1b[0m\x1b[2m ▸ ${header}\x1b[0m\r\n` +
    `\x1b]633;E;${escapeCommand(command)}\x07\x1b[2m›\x1b[0m ${cmd}\r\n\x1b]133;C\x07`
  );
}

function intro(a: RenderedAction, command: string, on?: string): string {
  const where = a.kind === "local" ? `${a.serverId} (local)` : `${a.serverId} (${on ?? a.host})`;
  return blockIntro([where, a.appId, a.label, localHms()].filter(Boolean).join(" · "), command);
}

/** Idle at its shell's prompt (nothing running, shell integration on). */
function idle(t: Tab): boolean {
  return t.state !== "running" && t.session.status === "running" && t.session.ptyId !== null && t.session.blocks.inputStart() !== undefined;
}

/** Where the action can run without a new tab:
 *  1. the tab in front, when it's an idle shell on the same server (for an
 *     app's action: that app's shell, opened from it), so clicking Deploy in
 *     your krsj shell runs it there;
 *  2. else the tab this action ran in before, if it's idle again (keeps its
 *     scrollback). */
function reusableTab(a: RenderedAction): Tab | undefined {
  const state = useTabs.getState();
  const front = activeTab(state);
  if (
    front &&
    a.kind === "ssh" &&
    front.kind === "ssh" &&
    !front.local &&
    front.serverId === a.serverId &&
    (a.appId === null || (front.appId ?? null) === a.appId) &&
    idle(front)
  ) {
    return front;
  }
  return state.tabs.find(
    (t) =>
      t.kind === "action" &&
      t.actionId === a.actionId &&
      t.serverId === a.serverId &&
      (t.appId ?? null) === (a.appId ?? null) &&
      idle(t),
  );
}

/** For an Auto Scaling group's action: the tab in front when it's this
 *  group's shells (one per instance, opened from the same app for an app's
 *  action), all idle at the prompt; the action is typed into each. */
function asgShellsInFront(a: RenderedAction): Tab[] | undefined {
  const state = useTabs.getState();
  const group = groupOf(state, state.activeId);
  if (!group) return undefined;
  const panes = terminalPanes(state, group.id);
  const ours = (t: Tab) =>
    t.kind === "ssh" && !!t.instance && t.serverId === a.serverId && (a.appId === null || (t.appId ?? null) === a.appId) && idle(t);
  return panes.length > 0 && panes.every(ours) ? panes : undefined;
}

/** Type the action at that tab's prompt (audited like "send") and follow
 *  it to its exit code, so the tab shows ✓/✗ for this run. */
async function rerunInTab(tab: Tab, a: RenderedAction, override: string | null): Promise<void> {
  const ptyId = tab.session.ptyId;
  if (ptyId === null) return;
  const tabs = useTabs.getState();
  tabs.activate(tab.id);
  // An action tab takes the action's name; your own shell keeps its name.
  tabs.update(tab.id, { state: "running", exitCode: undefined, finishedAt: undefined, ...(tab.renamed || tab.kind !== "action" ? {} : { title: a.title }) });
  // Clear anything half-typed at the prompt first (Ctrl+U).
  tab.session.send("\x15");
  const finished = tab.session.blocks.nextFinish();
  try {
    await actionSend(ptyId, refOf(a), override);
  } catch (e) {
    toastError(errorMessage(e));
    useTabs.getState().update(tab.id, { state: tab.kind === "action" ? "ok" : "shell" });
    return;
  }
  tab.session.focus();
  const code = await finished;
  if (useTabs.getState().tabs.some((t) => t.id === tab.id)) {
    useTabs.getState().update(tab.id, {
      // Your own shell goes back to being a shell; an action tab shows ✓/✗.
      state: tab.kind !== "action" ? "shell" : code === undefined || code === 0 ? "ok" : "failed",
      exitCode: code,
      finishedAt: Date.now(),
    });
  }
}

/** Run an action: again in its earlier tab when that one is idle at the
 *  prompt, else in a new tab. `command` is the (possibly edited) command. */
export function runAction(a: RenderedAction, command?: string): string {
  const override = command !== undefined && command.trim() !== a.rendered ? command : null;
  // An Auto Scaling group: in its shells in front, else a new pane per
  // instance.
  if (a.kind === "ssh" && isAsg(findServer(a.serverId))) {
    const shells = asgShellsInFront(a);
    if (shells) {
      for (const t of shells) void rerunInTab(t, a, override);
      return shells[0]!.id;
    }
    void runOnAsg(a, override, (i) => intro(a, override ?? a.rendered, `${instanceLabel(i)}, ${i.id}`));
    return useTabs.getState().activeId ?? "";
  }
  const again = reusableTab(a);
  if (again) {
    void rerunInTab(again, a, override);
    return again.id;
  }
  const ref = refOf(a);
  let tabId: string | null = null;
  try {
    tabId = useTabs.getState().open({
      kind: "action",
      title: a.title,
      serverId: a.serverId,
      host: a.host,
      appId: a.appId,
      actionId: a.actionId,
      local: a.kind === "local",
      prod: a.env === "prod",
      state: "running",
      intro: intro(a, override ?? a.rendered),
      spawn: (cols, rows, onData, onEvent) =>
        actionRun(ref, override, cols, rows, onData, onEvent).then((info) => {
          if (info.auditId !== null && tabId) useTabs.getState().update(tabId, { auditId: info.auditId });
          return info.ptyId;
        }),
    });
  } catch (e) {
    // Something reacting to the new tab failed; the tab itself still runs.
    console.error(e);
    toastError(`Opening the tab: ${errorMessage(e)}`);
  }
  return tabId ?? useTabs.getState().activeId ?? "";
}

/** The tab "Send to current tab" would type into, or why there isn't one. */
export function sendTarget(a: RenderedAction, here = false): { tab: Tab | null; reason: string | null } {
  const tab = activeTab(useTabs.getState()) ?? null;
  if (!tab || tab.session.ptyId === null || tab.session.status !== "running") {
    return { tab: null, reason: "No running tab" };
  }
  // Asked for: a server's action typed into a shell on this Mac.
  if (here) {
    return tab.kind === "local" || tab.local
      ? { tab, reason: null }
      : { tab: null, reason: "The tab in front isn't a shell on this Mac" };
  }
  if (a.kind === "local") {
    return tab.kind === "local" || tab.local
      ? { tab, reason: null }
      : { tab: null, reason: "This action runs on your Mac; the current tab is a remote shell" };
  }
  const sameServer = (tab.serverId === a.serverId && !tab.local) || (tab.kind === "ssh" && tab.host === a.host);
  if (sameServer) return { tab, reason: null };
  const where = tab.kind === "local" || tab.local ? "a local shell" : `on ${tab.serverId ?? tab.host ?? "another host"}`;
  return { tab: null, reason: `The current tab is ${where}, not ${a.serverId}` };
}

export async function sendAction(a: RenderedAction, command: string, here = false): Promise<boolean> {
  const { tab, reason } = sendTarget(a, here);
  // Into a shell on this Mac: exactly what the dialog shows, entered.
  if (here && tab) {
    tab.session.paste(command, { submit: true });
    useTabs.getState().activate(tab.id);
    tab.session.focus();
    return true;
  }
  const ptyId = tab?.session.ptyId;
  if (!tab || ptyId === null || ptyId === undefined) {
    toastError(reason ?? "No tab to send to");
    return false;
  }
  try {
    const override = command.trim() !== a.rendered ? command : null;
    // Typing in all panes: into each of them.
    const state = useTabs.getState();
    const group = groupOf(state, tab.id);
    const panes = group?.broadcast ? terminalPanes(state, group.id) : [tab];
    for (const p of panes) {
      if (p.session.ptyId !== null && p.session.status === "running") await actionSend(p.session.ptyId, refOf(a), override);
    }
    useTabs.getState().activate(tab.id);
    tab.session.focus();
    return true;
  } catch (e) {
    toastError(errorMessage(e));
    return false;
  }
}
