// Remember open tabs across restarts. Restored tabs are plain shells that
// connect when first shown; nothing is ever re-run.
import { sessionLoad, sessionSave } from "@/lib/ipc";
import { ptySpawner } from "@/lib/terminalSession";

import { closedTabs, openFiles, openHealth, openLogs, openMonitor, openQueues, openSetup, openTune, useTabs, type OpenOptions, type Tab } from "./tabs";
import { useToasts } from "./toasts";
import { leaves, load as loadLayout, save as saveLayout, type SavedLayout } from "@/lib/layout";
import { isTabColor } from "@/lib/tabColors";

interface SavedTab {
  kind: Tab["kind"];
  title: string;
  renamed: boolean;
  host?: string;
  instance?: string;
  cwd?: string;
  serverId?: string;
  appId?: string;
  local?: boolean;
  prod: boolean;
}

interface Saved {
  version: 1;
  tabs: SavedTab[];
  active: number;
  /** Split layouts over `tabs` indexes (absent: one pane per tab). */
  groups?: { layout: SavedLayout; focus: number; color?: string }[];
  /** The tab strip's order: pinned tabs by name, tabs as `g:<index in
   *  groups>`. */
  strip?: string[];
}

/** The pinned tabs' names in the strip order. */
const PINNED = ["details", "history", "snippets", "workflows", "baseline", "settings"];

function isSaved(v: unknown): v is Saved {
  return typeof v === "object" && v !== null && (v as Saved).version === 1 && Array.isArray((v as Saved).tabs);
}

function restoreTab(t: SavedTab, into?: OpenOptions["into"]): string {
  const { open, rename } = useTabs.getState();
  // A monitor comes back as a monitor (from what was saved; the config may
  // not be loaded yet).
  if (t.kind === "monitor" && t.serverId && t.host) {
    const name = t.title.replace(/ · monitor$/, "");
    return openMonitor({ id: t.serverId, name, host: t.host, env: t.prod ? "prod" : "dev" });
  }
  if (t.kind === "files" && t.serverId && t.host) {
    return openFiles(
      { id: t.serverId, host: t.host, env: t.prod ? "prod" : "dev" },
      { appId: t.appId ?? null, dir: t.cwd ?? "~", title: t.title },
    );
  }
  if (t.kind === "logs" && t.serverId && t.host) {
    return openLogs(
      { id: t.serverId, host: t.host, env: t.prod ? "prod" : "dev" },
      { appId: t.appId ?? null, path: t.cwd, title: t.title },
    );
  }
  if (t.kind === "queues" && t.serverId && t.host && t.appId) {
    const id = openQueues({ id: t.serverId, host: t.host, env: t.prod ? "prod" : "dev" }, { id: t.appId, env: t.prod ? "prod" : "dev" });
    if (t.renamed) useTabs.getState().rename(id, t.title);
    return id;
  }
  if (t.kind === "health" && t.serverId && t.host) {
    return openHealth({ id: t.serverId, name: t.title.replace(/ · health$/, ""), host: t.host, env: t.prod ? "prod" : "dev" });
  }
  if (t.kind === "setup" && t.serverId) {
    return openSetup({ id: t.serverId, name: t.title.replace(/ · setup$/, ""), host: t.host ?? "", env: t.prod ? "prod" : "dev" });
  }
  if (t.kind === "tune" && t.serverId && t.host) {
    return openTune({ id: t.serverId, name: t.title.replace(/ · tune$/, ""), host: t.host, env: t.prod ? "prod" : "dev" });
  }
  // A Session Manager pane (or an action that ran on an instance) comes
  // back as a shell on that instance; if it's gone, ↵ in the pane retries.
  if (t.instance && t.serverId && t.kind !== "local" && !t.local) {
    const id = open({
      kind: "ssh",
      title: t.renamed || t.kind === "ssh" ? t.title : `${t.serverId} · ${t.instance}`,
      serverId: t.serverId,
      instance: t.instance,
      appId: t.cwd && t.appId ? t.appId : undefined,
      cwd: t.cwd,
      prod: t.prod,
      background: !into,
      into,
      spawn: ptySpawner({ kind: "ssm", serverId: t.serverId, instance: t.instance, cwd: t.cwd }),
    });
    if (t.renamed) rename(id, t.title);
    return id;
  }
  // Action tabs come back as a shell where they ran, never re-running.
  const local = t.kind === "local" || t.local || !t.host;
  const title = t.renamed
    ? t.title
    : local
      ? t.kind === "local" ? t.title : `${t.serverId ?? "local"} · zsh`
      : t.kind === "ssh" ? t.title : `${t.serverId ?? t.host} · ssh`;
  const id = open({
    kind: local ? "local" : "ssh",
    title,
    host: local ? undefined : t.host,
    serverId: t.serverId,
    // An app's shell (it started in the app's folder) stays that app's, so
    // the Actions panel and "run in this shell" still know it.
    appId: !local && t.cwd && t.appId ? t.appId : undefined,
    prod: t.prod,
    background: !into,
    into,
    cwd: local ? undefined : t.cwd,
    // A local shell starts in its folder when one was kept (a tab config's,
    // or where a reopened shell was).
    spawn: ptySpawner(local ? { kind: "local", cwd: t.cwd } : { kind: "ssh", host: t.host ?? "", cwd: t.cwd }),
  });
  if (t.renamed) rename(id, t.title);
  return id;
}

/** ⇧⌘T: open the last closed tab again (its panes and splits; a pane
 *  closed out of a split goes back next to its old neighbour). Shells start
 *  fresh where they were: nothing is re-run, and scrollback is gone. */
export function reopenClosed(): void {
  const c = closedTabs.pop();
  if (!c) {
    useToasts.getState().push("No closed tabs to reopen", "info");
    return;
  }
  const s = useTabs.getState();
  if (c.beside && c.panes[0] && s.tabs.some((t) => t.id === c.beside)) {
    const id = restoreTab(c.panes[0], { from: c.beside, dir: "row" });
    useTabs.getState().activate(id);
    return;
  }
  const ids = c.panes.map((p) => restoreTab(p));
  const layout = c.layout ? loadLayout(c.layout, (i) => ids[i]) : null;
  const focus = ids[c.focus] ?? ids[0];
  if (!focus) return;
  if (layout) useTabs.getState().adoptGroup(layout, focus, c.color);
  else {
    if (c.color) {
      const g = useTabs.getState().groups.find((x) => leaves(x.layout).includes(focus));
      if (g) useTabs.getState().setColor(g.id, c.color);
    }
    useTabs.getState().activate(focus);
  }
}

let started = false;

/** Restore once (StrictMode runs effects twice), then keep saving for the
 *  app's lifetime. */
export async function initSession(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const saved = await sessionLoad();
    if (isSaved(saved) && useTabs.getState().tabs.length === 0) {
      const ids = saved.tabs.map((t) => restoreTab(t));
      if (saved.groups) {
        const groups = saved.groups.flatMap((g) => {
          const layout = loadLayout(g.layout, (i) => ids[i]);
          const focus = ids[g.focus];
          if (!layout) return [];
          const color = isTabColor(g.color) ? g.color : undefined;
          return [{ layout, focus: focus && leaves(layout).includes(focus) ? focus : leaves(layout)[0]!, color }];
        });
        useTabs.getState().restoreGroups(groups);
      }
      // Where you'd dragged the tabs, pinned ones included.
      if (saved.strip) {
        const gs = useTabs.getState().groups.filter((g) => !g.workflow);
        const keys = saved.strip.flatMap((k) => {
          const m = /^g:(\d+)$/.exec(k);
          if (m) return gs[Number(m[1])] ? [gs[Number(m[1])]!.id] : [];
          return PINNED.includes(k) ? [k] : [];
        });
        useTabs.getState().setStripOrder(keys);
      }
      const active = ids[saved.active];
      if (active) useTabs.getState().activate(active);
    }
  } catch {
    // No session to restore.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  useTabs.subscribe((state, prev) => {
    if (state.tabs === prev.tabs && state.activeId === prev.activeId && state.groups === prev.groups && state.stripOrder === prev.stripOrder) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const all = useTabs.getState();
      const activeId = all.activeId;
      // Workflow runs aren't restored (their record is in History).
      const groups = all.groups.filter((g) => !g.workflow);
      const tabs = all.tabs.filter((t) => groups.some((g) => g.id === t.groupId));
      const index = (id: string) => tabs.findIndex((t) => t.id === id);
      const data: Saved = {
        version: 1,
        tabs: tabs.map((t) => ({
          kind: t.kind,
          title: t.title,
          renamed: t.renamed,
          host: t.host,
          instance: t.instance,
          cwd: t.cwd,
          serverId: t.serverId,
          appId: t.appId ?? undefined,
          local: t.local,
          prod: t.prod,
        })),
        active: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
        groups: groups.map((g) => ({ layout: saveLayout(g.layout, index), focus: index(g.focus), color: g.color })),
        strip: all.stripOrder.flatMap((k) => {
          const i = groups.findIndex((g) => g.id === k);
          return i >= 0 ? [`g:${i}`] : PINNED.includes(k) ? [k] : [];
        }),
      };
      void sessionSave(data).catch(() => {});
    }, 500);
  });
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
