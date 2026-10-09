// Terminal tabs and panes. Each `Tab` is one terminal (a pane): it owns a
// TerminalSession (xterm + PTY). Panes live in groups; the tab strip shows
// one tab per group, laid out as a split tree (lib/layout). `activeId` is
// the focused pane of the group in front.
import { create } from "zustand";

import type { ConfigLayout, PtyEvent } from "@/lib/ipc";
import { ptySpawner, TerminalSession, type SessionOptions, type Spawner } from "@/lib/terminalSession";
import { maybeNotifyFinished } from "@/lib/notify";
import { leaves, neighbour, remove, setRatio, split, type Dir, type Layout, type Side } from "@/lib/layout";
import type { TabColor } from "@/lib/tabColors";
import { useConfig } from "@/stores/config";

/** Design frame 1j, TerminalTab states. */
export type TabState = "shell" | "running" | "ok" | "failed";

export interface Tab {
  id: string;
  title: string;
  /** Set once the user renames the tab; later automatic titles don't apply. */
  renamed: boolean;
  /** Config server id, when the tab belongs to one. */
  serverId?: string;
  /** SSH host alias, for ssh and action tabs. */
  host?: string;
  /** For action tabs: which app/action ran. */
  appId?: string | null;
  actionId?: string;
  /** Local action tabs run on this Mac even though they belong to a server. */
  local?: boolean;
  /** Remote directory an ssh tab starts in (an app's path). */
  cwd?: string;
  /** Audit log row for action tabs. */
  auditId?: number;
  /** When the action (or shell) finished, for "4m ago". */
  finishedAt?: number;
  /** monitor: a server monitor (its session never starts). */
  kind: "local" | "ssh" | "action" | "monitor" | "files" | "logs" | "queues" | "health" | "tune";
  prod: boolean;
  state: TabState;
  exitCode?: number;
  session: TerminalSession;
  /** The tab-strip group (split layout) this pane is in. */
  groupId: string;
}

/** One entry in the tab strip: panes in a split layout. */
export interface Group {
  id: string;
  layout: Layout;
  /** The pane that has focus inside this group. */
  focus: string;
  /** Picked from the tab's right-click menu. */
  color?: TabColor;
}

export interface OpenOptions extends Pick<Tab, "title" | "kind">, Partial<Pick<Tab, "serverId" | "host" | "cwd" | "appId" | "actionId" | "local" | "prod" | "state">> {
  spawn: Spawner;
  intro?: string;
  /** Open without switching to it. */
  background?: boolean;
  /** Open as a pane next to `from` (split right = row, down = col). */
  into?: { from: string; dir: Dir };
}

/** activeId value while the pinned Home tab is in front (also the start). */
export const HOME_ID = "home";
/** activeId value while the pinned History tab is in front. */
export const HISTORY_ID = "history";
/** activeId value while the server/app details page is in front. */
export const DETAILS_ID = "details";

interface TabsState {
  tabs: Tab[];
  groups: Group[];
  activeId: string | null;
  historyOpen: boolean;
  openHistory(): void;
  closeHistory(): void;
  detailsOpen: boolean;
  openDetails(): void;
  closeDetails(): void;
  open(opts: OpenOptions): string;
  close(id: string): void;
  activate(id: string): void;
  activateIndex(index: number): void;
  activateRelative(delta: number): void;
  rename(id: string, title: string): void;
  update(id: string, patch: Partial<Omit<Tab, "id" | "session">>): void;
  /** Close every pane in a group (the tab's ×). */
  closeGroup(groupId: string): void;
  /** Split the focused pane (⌘D right, ⇧⌘D down). */
  splitActive(dir: Dir): void;
  /** Move focus to the pane on that side (⌥⌘ arrows). */
  focusSide(side: Side): void;
  setRatio(groupId: string, splitId: string, ratio: number): void;
  setColor(groupId: string, color: TabColor | null): void;
  /** A tab config: one tab of panes, each in a folder running commands. */
  openConfig(opts: { title: string; color?: TabColor; layout: ConfigLayout }): void;
  /** Session restore: replace groups (layouts over existing pane ids). */
  restoreGroups(groups: { layout: Layout; focus: string; color?: TabColor }[]): void;
}

let nextGroup = 1;

/** A new tab's colour: its app's, else its server's, else its team's (servers.yaml). */
function defaultColor(tab: Pick<Tab, "serverId" | "appId">): TabColor | undefined {
  const config = useConfig.getState().snapshot?.config;
  const server = tab.serverId ? config?.servers.find((s) => s.id === tab.serverId) : undefined;
  const app = tab.appId ? server?.apps.find((a) => a.id === tab.appId) : undefined;
  const team = server?.team ? config?.teams.find((t) => t.id === server.team) : undefined;
  return app?.color ?? server?.color ?? team?.color ?? undefined;
}

export function groupOf(state: Pick<TabsState, "groups">, paneId: string | null): Group | undefined {
  return paneId ? state.groups.find((g) => leaves(g.layout).includes(paneId)) : undefined;
}

/** What a new pane next to `t` should open: the same place, never re-running
 *  an action (an action pane gives a shell where it ran). */
function likeOptions(t: Tab): OpenOptions {
  const local = t.kind === "local" || t.local || !t.host;
  if (local) return { kind: "local", title: "local · zsh", spawn: ptySpawner({ kind: "local" }) };
  const cwd = t.cwd;
  return {
    kind: "ssh",
    title: t.kind === "ssh" && !t.renamed ? t.title : `${t.serverId ?? t.host} · ssh`,
    host: t.host,
    cwd,
    serverId: t.serverId,
    prod: t.prod,
    spawn: ptySpawner({ kind: "ssh", host: t.host ?? "", cwd }),
  };
}

let nextId = 1;

export const useTabs = create<TabsState>((set, get) => {
  const watch = (id: string, session: TerminalSession) =>
    session.onEvent((event: PtyEvent) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      if (event.type === "restart") {
        get().update(id, { state: "shell", exitCode: undefined, finishedAt: undefined });
      } else if (event.type === "actionExit") {
        get().update(id, { state: event.code === 0 ? "ok" : "failed", exitCode: event.code, finishedAt: Date.now() });
        void maybeNotifyFinished(tab.title, event.code, event.elapsedMs, get().activeId === id);
      } else if (event.type === "exit" && (tab.kind !== "action" || tab.state === "running")) {
        // A shell that ended, or an action that never reported (failed to
        // start, connection dropped): show how it ended.
        const code = event.code;
        get().update(id, { state: code === 0 ? "ok" : "failed", exitCode: code ?? undefined, finishedAt: Date.now() });
      }
    });

  const insert = (tab: Tab, background?: boolean, into?: OpenOptions["into"]) => {
    set((s) => {
      const host = into ? groupOf(s, into.from) : undefined;
      if (host && into) {
        const groups = s.groups.map((g) =>
          g.id === host.id ? { ...g, layout: split(g.layout, into.from, tab.id, into.dir), focus: tab.id } : g,
        );
        return { tabs: [...s.tabs, { ...tab, groupId: host.id }], groups, activeId: tab.id };
      }
      const group: Group = { id: `g${nextGroup++}`, layout: { pane: tab.id }, focus: tab.id, color: defaultColor(tab) };
      return {
        tabs: [...s.tabs, { ...tab, groupId: group.id }],
        groups: [...s.groups, group],
        activeId: background && s.activeId ? s.activeId : tab.id,
      };
    });
    watch(tab.id, tab.session);
    return tab.id;
  };

  /** Drop panes from the store (sessions already disposed), fixing groups
   *  and focus: a closed focused pane hands focus to a neighbour, a group
   *  with no panes left goes, and its tab's right (else left) neighbour
   *  comes to the front. */
  const drop = (ids: string[]) => {
    const s = get();
    const gone = new Set(ids);
    const oldIndex = s.groups.findIndex((g) => g.id === groupOf(s, s.activeId)?.id);
    const groups: Group[] = [];
    for (const g of s.groups) {
      let layout: Layout | null = g.layout;
      let focus = g.focus;
      for (const id of ids) {
        if (!layout || !leaves(layout).includes(id)) continue;
        if (focus === id) {
          const sides: Side[] = ["left", "up", "right", "down"];
          focus = sides.map((side) => neighbour(layout!, id, side)).find((n) => n && !gone.has(n)) ?? focus;
        }
        layout = remove(layout, id);
      }
      if (layout) groups.push({ ...g, layout, focus: leaves(layout).includes(focus) ? focus : leaves(layout)[0]! });
    }
    let activeId = s.activeId;
    if (activeId && gone.has(activeId)) {
      const same = groups.find((g) => g.id === groupOf(s, activeId)?.id);
      const next = same ?? groups[oldIndex] ?? groups[oldIndex - 1] ?? null;
      activeId = next?.focus ?? HOME_ID;
    }
    set({ tabs: s.tabs.filter((t) => !gone.has(t.id)), groups, activeId });
  };

  return {
    tabs: [],
    groups: [],
    activeId: HOME_ID,
    historyOpen: false,
    detailsOpen: false,

    openDetails() {
      set({ detailsOpen: true, activeId: DETAILS_ID });
    },

    closeDetails() {
      const { activeId, groups, historyOpen } = get();
      set({
        detailsOpen: false,
        activeId: activeId === DETAILS_ID ? (groups[groups.length - 1]?.focus ?? (historyOpen ? HISTORY_ID : HOME_ID)) : activeId,
      });
    },

    openHistory() {
      set({ historyOpen: true, activeId: HISTORY_ID });
    },

    closeHistory() {
      const { activeId, groups } = get();
      set({
        historyOpen: false,
        activeId: activeId === HISTORY_ID ? (groups[groups.length - 1]?.focus ?? HOME_ID) : activeId,
      });
    },

    open({ spawn, intro, background, into, prod = false, state = "shell", ...meta }) {
      const options: SessionOptions = {
        intro,
        settings: useConfig.getState().snapshot?.config?.terminal,
        restartable: meta.kind === "local" || meta.kind === "ssh",
      };
      const session = new TerminalSession(spawn, options);
      return insert({ ...meta, id: `t${nextId++}`, renamed: false, prod, state, session, groupId: "" }, background, into);
    },

    /** Close one pane (⌘W); the tab goes with its last pane. */
    close(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      tab.session.dispose();
      drop([id]);
    },

    closeGroup(groupId) {
      const g = get().groups.find((x) => x.id === groupId);
      if (!g) return;
      const ids = leaves(g.layout);
      for (const t of get().tabs) if (ids.includes(t.id)) t.session.dispose();
      drop(ids);
    },

    activate(id) {
      const s = get();
      const g = groupOf(s, id);
      if (!g) return;
      set({ activeId: id, groups: s.groups.map((x) => (x.id === g.id ? { ...x, focus: id } : x)) });
    },

    activateIndex(index) {
      const { groups } = get();
      const g = index < 0 ? groups[groups.length - 1] : groups[index];
      if (g) set({ activeId: g.focus });
    },

    activateRelative(delta) {
      const s = get();
      if (s.groups.length === 0) return;
      const i = s.groups.findIndex((g) => g.id === groupOf(s, s.activeId)?.id);
      const g = s.groups[(i + delta + s.groups.length) % s.groups.length];
      if (g) set({ activeId: g.focus });
    },

    splitActive(dir) {
      const s = get();
      const t = s.tabs.find((x) => x.id === s.activeId);
      if (!t) return;
      get().open({ ...likeOptions(t), into: { from: t.id, dir } });
    },

    focusSide(side) {
      const s = get();
      const g = groupOf(s, s.activeId);
      if (!g || !s.activeId) return;
      const n = neighbour(g.layout, s.activeId, side);
      if (n) get().activate(n);
    },

    openConfig({ title, color, layout }) {
      const created: Tab[] = [];
      const build = (l: ConfigLayout): Layout => {
        if (l.type === "pane") {
          const session = new TerminalSession(ptySpawner({ kind: "local", cwd: l.directory ?? undefined }), {
            settings: useConfig.getState().snapshot?.config?.terminal,
            restartable: true,
          });
          session.typeAtPrompt(l.commands);
          const tab: Tab = {
            id: `t${nextId++}`,
            title,
            renamed: true,
            kind: "local",
            cwd: l.directory ?? undefined,
            prod: false,
            state: "shell",
            session,
            groupId: "",
          };
          created.push(tab);
          return { pane: tab.id };
        }
        // Warp splits into any number of panes; ours are binary: nest with
        // shares that keep the panes equal.
        const parts = l.children.map(build);
        const nest = (xs: Layout[]): Layout =>
          xs.length === 1 ? xs[0]! : { id: `c${nextId++}`, dir: l.dir, ratio: 1 / xs.length, a: xs[0]!, b: nest(xs.slice(1)) };
        return nest(parts);
      };
      const tree = build(layout);
      const first = created[0];
      if (!first) return;
      const group: Group = { id: `g${nextGroup++}`, layout: tree, focus: first.id, color };
      set((s) => ({
        tabs: [...s.tabs, ...created.map((t) => ({ ...t, groupId: group.id }))],
        groups: [...s.groups, group],
        activeId: first.id,
      }));
      for (const t of created) watch(t.id, t.session);
    },

    setColor(groupId, color) {
      set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, color: color ?? undefined } : g)) }));
    },

    setRatio(groupId, splitId, ratio) {
      set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, layout: setRatio(g.layout, splitId, ratio) } : g)) }));
    },

    restoreGroups(saved) {
      set((s) => {
        const groups: Group[] = saved.map((g) => ({ id: `g${nextGroup++}`, layout: g.layout, focus: g.focus, color: g.color }));
        const owner = new Map<string, string>();
        for (const g of groups) for (const id of leaves(g.layout)) owner.set(id, g.id);
        // Any pane not in a saved layout keeps a group of its own.
        for (const t of s.tabs) {
          if (owner.has(t.id)) continue;
          const g: Group = { id: `g${nextGroup++}`, layout: { pane: t.id }, focus: t.id };
          groups.push(g);
          owner.set(t.id, g.id);
        }
        return { groups, tabs: s.tabs.map((t) => ({ ...t, groupId: owner.get(t.id) ?? t.groupId })) };
      });
    },

    rename(id, title) {
      const trimmed = title.trim();
      if (trimmed) get().update(id, { title: trimmed, renamed: true });
    },

    update(id, patch) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    },
  };
});

export function activeTab(state: Pick<TabsState, "tabs" | "activeId">): Tab | undefined {
  return state.tabs.find((t) => t.id === state.activeId);
}

/** New local login shell tab (⌘T). */
export function openLocalShell(): string {
  return useTabs.getState().open({ spawn: ptySpawner({ kind: "local" }), kind: "local", title: "local · zsh" });
}

/** New `ssh <host>` tab. */
/** A server monitor (CPU, memory, disks, top processes) as a tab. */
export function openMonitor(server: { id: string; name: string; host: string; env: string }): string {
  return useTabs.getState().open({
    kind: "monitor",
    title: `${server.name} · monitor`,
    serverId: server.id,
    host: server.host,
    prod: server.env === "prod",
    // Never attached as a terminal, so this never runs.
    spawn: () => Promise.reject(new Error("monitor tabs have no terminal")),
  });
}

/** A file explorer on a server (starting in an app's folder, or home). */
export function openFiles(
  server: { id: string; host: string; env: string },
  opts: { appId?: string | null; dir?: string; env?: string; title?: string } = {},
): string {
  return useTabs.getState().open({
    kind: "files",
    title: opts.title ?? `${server.id} · files`,
    serverId: server.id,
    host: server.host,
    appId: opts.appId ?? undefined,
    cwd: opts.dir ?? "~",
    prod: (opts.env ?? server.env) === "prod",
    // Never attached as a terminal, so this never runs.
    spawn: () => Promise.reject(new Error("file tabs have no terminal")),
  });
}

/** The log viewer on a server: an app's logs (or every app's and the
 *  server's). `path` opens that log (its family) instead of the default. */
export function openLogs(
  server: { id: string; host: string; env: string },
  opts: { appId?: string | null; path?: string; env?: string; title?: string } = {},
): string {
  const { tabs, activate } = useTabs.getState();
  const same = tabs.find((t) => t.kind === "logs" && t.serverId === server.id && (t.appId ?? null) === (opts.appId ?? null) && (!opts.path || t.cwd === opts.path));
  if (same) {
    activate(same.id);
    return same.id;
  }
  return useTabs.getState().open({
    kind: "logs",
    title: opts.title ?? `${opts.appId ?? server.id} · logs`,
    serverId: server.id,
    host: server.host,
    appId: opts.appId ?? undefined,
    cwd: opts.path,
    prod: (opts.env ?? server.env) === "prod",
    // Never attached as a terminal, so this never runs.
    spawn: () => Promise.reject(new Error("log tabs have no terminal")),
  });
}

/** Queue health of an app: workers, pending and failed jobs. */
export function openQueues(server: { id: string; host: string; env: string }, app: { id: string; env: string }): string {
  const { tabs, activate } = useTabs.getState();
  const same = tabs.find((t) => t.kind === "queues" && t.serverId === server.id && t.appId === app.id);
  if (same) {
    activate(same.id);
    return same.id;
  }
  return useTabs.getState().open({
    kind: "queues",
    title: `${app.id} · queues`,
    serverId: server.id,
    host: server.host,
    appId: app.id,
    prod: app.env === "prod",
    // Never attached as a terminal, so this never runs.
    spawn: () => Promise.reject(new Error("queue tabs have no terminal")),
  });
}

/** Health checks of a server: SSL, updates, services, apps. */
export function openHealth(server: { id: string; name: string; host: string; env: string }): string {
  const { tabs, activate } = useTabs.getState();
  const same = tabs.find((t) => t.kind === "health" && t.serverId === server.id);
  if (same) {
    activate(same.id);
    return same.id;
  }
  return useTabs.getState().open({
    kind: "health",
    title: `${server.name} · health`,
    serverId: server.id,
    host: server.host,
    prod: server.env === "prod",
    // Never attached as a terminal, so this never runs.
    spawn: () => Promise.reject(new Error("health tabs have no terminal")),
  });
}

/** Fine-tune a server: suggested PHP-FPM / OPcache / MySQL / nginx / swap settings. */
export function openTune(server: { id: string; name: string; host: string; env: string }): string {
  const { tabs, activate } = useTabs.getState();
  const same = tabs.find((t) => t.kind === "tune" && t.serverId === server.id);
  if (same) {
    activate(same.id);
    return same.id;
  }
  return useTabs.getState().open({
    kind: "tune",
    title: `${server.name} · tune`,
    serverId: server.id,
    host: server.host,
    prod: server.env === "prod",
    // Never attached as a terminal, so this never runs.
    spawn: () => Promise.reject(new Error("tune tabs have no terminal")),
  });
}

/** Tabs that show a view of their own, not a terminal. */
export const isViewTab = (kind: Tab["kind"]) =>
  kind === "monitor" || kind === "files" || kind === "logs" || kind === "queues" || kind === "health" || kind === "tune";

/** New `ssh <host>` tab, optionally starting in a remote directory. */
export function openSsh(
  host: string,
  opts: { serverId?: string; appId?: string; prod?: boolean; title?: string; cwd?: string; background?: boolean } = {},
): string {
  return useTabs.getState().open({
    spawn: ptySpawner({ kind: "ssh", host, cwd: opts.cwd }),
    kind: "ssh",
    host,
    cwd: opts.cwd,
    title: opts.title ?? `${host} · ssh`,
    serverId: opts.serverId,
    appId: opts.appId,
    prod: opts.prod,
    background: opts.background,
  });
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
