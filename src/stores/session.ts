// Remember open tabs across restarts. Restored tabs are plain shells that
// connect when first shown; nothing is ever re-run.
import { sessionLoad, sessionSave } from "@/lib/ipc";
import { ptySpawner } from "@/lib/terminalSession";

import { openFiles, openHealth, openLogs, openMonitor, openQueues, openTune, useTabs, type Tab } from "./tabs";
import { leaves, load as loadLayout, save as saveLayout, type SavedLayout } from "@/lib/layout";
import { isTabColor } from "@/lib/tabColors";

interface SavedTab {
  kind: Tab["kind"];
  title: string;
  renamed: boolean;
  host?: string;
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
}

function isSaved(v: unknown): v is Saved {
  return typeof v === "object" && v !== null && (v as Saved).version === 1 && Array.isArray((v as Saved).tabs);
}

function restoreTab(t: SavedTab): string {
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
  if (t.kind === "tune" && t.serverId && t.host) {
    return openTune({ id: t.serverId, name: t.title.replace(/ · tune$/, ""), host: t.host, env: t.prod ? "prod" : "dev" });
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
    prod: t.prod,
    background: true,
    cwd: local ? undefined : t.cwd,
    spawn: ptySpawner(local ? { kind: "local" } : { kind: "ssh", host: t.host ?? "", cwd: t.cwd }),
  });
  if (t.renamed) rename(id, t.title);
  return id;
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
      const ids = saved.tabs.map(restoreTab);
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
      const active = ids[saved.active];
      if (active) useTabs.getState().activate(active);
    }
  } catch {
    // No session to restore.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  useTabs.subscribe((state, prev) => {
    if (state.tabs === prev.tabs && state.activeId === prev.activeId && state.groups === prev.groups) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { tabs, activeId, groups } = useTabs.getState();
      const index = (id: string) => tabs.findIndex((t) => t.id === id);
      const data: Saved = {
        version: 1,
        tabs: tabs.map((t) => ({
          kind: t.kind,
          title: t.title,
          renamed: t.renamed,
          host: t.host,
          cwd: t.cwd,
          serverId: t.serverId,
          appId: t.appId ?? undefined,
          local: t.local,
          prod: t.prod,
        })),
        active: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
        groups: groups.map((g) => ({ layout: saveLayout(g.layout, index), focus: index(g.focus), color: g.color })),
      };
      void sessionSave(data).catch(() => {});
    }, 500);
  });
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
