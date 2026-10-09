// What happens when an action is clicked: the guardrail decision, running it
// in a new tab, or typing it into the current tab.
import {
  actionRender,
  actionRun,
  actionSend,
  errorMessage,
  vpnConnect,
  type ActionRef,
  type Confirm,
  type Env,
  type RenderedAction,
} from "@/lib/ipc";
import { findServer } from "@/stores/config";
import { askParams } from "@/stores/params";
import { useStatus } from "@/stores/status";
import { useActionFlow, type FlowDialog } from "@/stores/actionFlow";
import { activeTab, useTabs, type Tab } from "@/stores/tabs";
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

function intro(a: RenderedAction, command: string): string {
  const where = a.kind === "local" ? `${a.serverId} (local)` : `${a.serverId} (${a.host})`;
  return blockIntro([where, a.appId, a.label, localHms()].filter(Boolean).join(" · "), command);
}

/** The tab this action ran in before, if it's now idle at its shell's
 *  prompt: running it again there keeps its scrollback. */
function reusableTab(a: RenderedAction): Tab | undefined {
  return useTabs
    .getState()
    .tabs.find(
      (t) =>
        t.kind === "action" &&
        t.actionId === a.actionId &&
        t.serverId === a.serverId &&
        (t.appId ?? null) === (a.appId ?? null) &&
        t.state !== "running" &&
        t.session.status === "running" &&
        t.session.ptyId !== null &&
        t.session.blocks.inputStart() !== undefined,
    );
}

/** Type the action at that tab's prompt (audited like "send") and follow
 *  it to its exit code, so the tab shows ✓/✗ for this run. */
async function rerunInTab(tab: Tab, a: RenderedAction, override: string | null): Promise<void> {
  const ptyId = tab.session.ptyId;
  if (ptyId === null) return;
  const tabs = useTabs.getState();
  tabs.activate(tab.id);
  tabs.update(tab.id, { state: "running", exitCode: undefined, finishedAt: undefined, ...(tab.renamed ? {} : { title: a.title }) });
  // Clear anything half-typed at the prompt first (Ctrl+U).
  tab.session.send("\x15");
  const finished = tab.session.blocks.nextFinish();
  try {
    await actionSend(ptyId, refOf(a), override);
  } catch (e) {
    toastError(errorMessage(e));
    useTabs.getState().update(tab.id, { state: "ok" });
    return;
  }
  tab.session.focus();
  const code = await finished;
  if (useTabs.getState().tabs.some((t) => t.id === tab.id)) {
    useTabs.getState().update(tab.id, {
      state: code === undefined || code === 0 ? "ok" : "failed",
      exitCode: code,
      finishedAt: Date.now(),
    });
  }
}

/** Run an action: again in its earlier tab when that one is idle at the
 *  prompt, else in a new tab. `command` is the (possibly edited) command. */
export function runAction(a: RenderedAction, command?: string): string {
  const override = command !== undefined && command.trim() !== a.rendered ? command : null;
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
export function sendTarget(a: RenderedAction): { tab: Tab | null; reason: string | null } {
  const tab = activeTab(useTabs.getState()) ?? null;
  if (!tab || tab.session.ptyId === null || tab.session.status !== "running") {
    return { tab: null, reason: "No running tab" };
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

export async function sendAction(a: RenderedAction, command: string): Promise<boolean> {
  const { tab, reason } = sendTarget(a);
  const ptyId = tab?.session.ptyId;
  if (!tab || ptyId === null || ptyId === undefined) {
    toastError(reason ?? "No tab to send to");
    return false;
  }
  try {
    const override = command.trim() !== a.rendered ? command : null;
    await actionSend(ptyId, refOf(a), override);
    useTabs.getState().activate(tab.id);
    tab.session.focus();
    return true;
  } catch (e) {
    toastError(errorMessage(e));
    return false;
  }
}
