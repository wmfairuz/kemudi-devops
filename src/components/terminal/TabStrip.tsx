import { Activity, ChevronDown, Plus, ClipboardCheck, Server as ServerIcon, Settings, Columns2, Keyboard, Workflow as WorkflowIcon, FolderOpen, Gauge, HeartPulse, House, LayoutDashboard, ListChecks, Network, ScrollText, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { Glyph, Spinner } from "@/components/kit/Spinner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/manage/Badge";
import { useConfig } from "@/stores/config";
import { useManage } from "@/stores/manage";
import { PopupMenu } from "@/components/kit/PopupMenu";
import { leaves } from "@/lib/layout";
import { saveTabAsConfig } from "@/lib/saveTabConfig";
import { TAB_COLORS, type TabColor } from "@/lib/tabColors";
import { ColorDot, openTabConfig, useTabConfigs } from "@/components/tabconfigs/TabConfigs";
import { errorMessage, tabConfigsList, type TabConfigEntry } from "@/lib/ipc";
import { toastError } from "@/stores/toasts";
import { PILL, PILL_OFF, PILL_ON, PILL_ON_DARK } from "@/components/kit/capsule";
import { HOSTS_ID, SETTINGS_ID, DETAILS_ID, HISTORY_ID, HOME_ID, SNIPPETS_ID, WORKFLOWS_ID, groupOf, isViewTab, keepTab, openLocalShell, toggleBroadcast, useTabs, type Group, type Tab } from "@/stores/tabs";
import { useUi } from "@/stores/ui";

/** Dracula hues on a dark tab, the Alucard (light Dracula) ones on a light
 *  pill, where the pale Dracula ones disappear. */
const HUE = {
  cyan: ["#8be9fd", "#036a96"],
  yellow: ["#f1fa8c", "#846e15"],
  orange: ["#ffb86c", "#a34d14"],
  green: ["#50fa7b", "#14710a"],
  pink: ["#ff79c6", "#a3144d"],
  purple: ["#bd93f9", "#644ac9"],
} as const;

const VIEW_ICONS: Partial<Record<Tab["kind"], [typeof Activity, keyof typeof HUE]>> = {
  monitor: [Activity, "cyan"],
  files: [FolderOpen, "yellow"],
  logs: [ScrollText, "orange"],
  queues: [ListChecks, "green"],
  health: [HeartPulse, "pink"],
  setup: [ClipboardCheck, "green"],
  dash: [LayoutDashboard, "orange"],
  tune: [Gauge, "purple"],
  server: [ServerIcon, "cyan"],
};

function TabIcon({ tab, dark }: { tab: Tab; dark: boolean }) {
  const view = VIEW_ICONS[tab.kind];
  if (view) {
    const [Icon, hue] = view;
    return <Icon className="size-4 flex-none" style={{ color: HUE[hue][dark ? 0 : 1] }} strokeWidth={2} />;
  }
  switch (tab.state) {
    case "running":
      return <Spinner size={12} />;
    case "ok":
      return <Glyph className="text-term-green">✓</Glyph>;
    case "failed":
      return <Glyph className="text-term-red">✗</Glyph>;
    default:
      return <span className="w-3.5 shrink-0 text-center font-mono text-[12.5px] text-subtle-foreground">$</span>;
  }
}

/** One tab: a group of panes, shown as its focused pane. × closes them all. */
function TabItem({ tab, group, panes, active }: { tab: Tab; group: Group; panes: Tab[]; active: boolean }) {
  const { activate, closeGroup, rename } = useTabs.getState();
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const prod = panes.some((p) => p.prod);
  const terminals = panes.filter((p) => !isViewTab(p.kind)).length;
  const broadcast = !!group.broadcast && terminals > 1;
  const color = group.color ? TAB_COLORS[group.color] : null;
  // Its colour as a soft tint, nothing more (Dracula hue on a dark
  // terminal tab in front, Alucard otherwise).
  const dark = active && !isViewTab(tab.kind);
  const tint = color
    ? { backgroundImage: `linear-gradient(${dark ? color.dark : color.light}${active ? "33" : "24"}, ${dark ? color.dark : color.light}${active ? "33" : "24"})` }
    : undefined;

  return (
    <div
      role="tab"
      aria-selected={active}
      title={panes.length > 1 ? `${tab.title} · ${panes.length} panes` : tab.title}
      onMouseDown={(e) => {
        if (e.button === 0) activate(tab.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) closeGroup(group.id);
      }}
      onDoubleClick={() => (tab.preview ? keepTab(tab.id) : setEditing(true))}
      onContextMenu={(e) => {
        e.preventDefault();
        activate(tab.id);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      style={tint}
      className={cn(
        PILL,
        "group max-w-[260px] min-w-0 flex-[0_1_auto] pr-1.5 pl-3",
        // The active tab is the colour of what's under it: a terminal's dark,
        // a page's (server, monitor, files…) white.
        active ? (isViewTab(tab.kind) ? PILL_ON : PILL_ON_DARK) : PILL_OFF,
      )}
    >
      <TabIcon tab={tab} dark={dark} />
      {editing ? (
        <input
          autoFocus
          defaultValue={tab.title}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            rename(tab.id, e.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-36 min-w-0 rounded-sm bg-muted px-1 text-foreground outline-none ring-1 ring-ring"
        />
      ) : (
        <span className={cn("truncate", tab.preview && "italic")} title={tab.preview ? `${tab.title} · preview: the next server you click takes its place; double-click to keep it` : undefined}>
          {tab.title}
        </span>
      )}
      {tab.state === "failed" && tab.exitCode !== undefined && (
        <span className="font-mono text-[10.5px] text-term-red">{tab.exitCode}</span>
      )}
      {broadcast ? (
        <span
          title={`Typing in all ${terminals} panes · ⌥⌘I to stop`}
          className="flex h-[18px] flex-none items-center gap-1 rounded-[5px] bg-broadcast px-1 font-mono text-[10.5px] font-semibold text-background"
        >
          <Keyboard className="size-3" strokeWidth={2.25} aria-hidden />
          {terminals}
        </span>
      ) : panes.length > 1 && (
        <span
          title={`${panes.length} panes`}
          className="flex h-[18px] flex-none items-center gap-1 rounded-[5px] border border-current/25 px-1 font-mono text-[10.5px] opacity-70"
        >
          <Columns2 className="size-3" strokeWidth={2} aria-hidden />
          {panes.length}
        </span>
      )}
      {prod && <span title="Production" aria-label="Production" className="size-[7px] flex-none rounded-full bg-env-prod" />}
      <button
        aria-label={`Close ${tab.title}${panes.length > 1 ? ` and its ${panes.length} panes` : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => closeGroup(group.id)}
        className="size-5 flex-none rounded-full text-center text-[15px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
      >
        ×
      </button>
      {menu &&
        // Outside the tab: the active tab is Dracula-dark, menus are light.
        createPortal(
        <PopupMenu
          x={menu.x}
          y={menu.y}
          title={tab.title}
          onClose={() => setMenu(null)}
          groups={[
            [
              ...(tab.preview ? [{ label: "Keep tab", run: () => keepTab(tab.id) }] : []),
              { label: "Rename tab…", run: () => setEditing(true) },
              ...(terminals > 0 ? [{ label: "Save as tab config…", run: () => void saveTabAsConfig(group.id) }] : []),
            ],
            [
              ...(Object.keys(TAB_COLORS) as TabColor[]).map((c) => ({
                label: TAB_COLORS[c].label,
                checked: group.color === c,
                icon: <span className="size-3 rounded-full" style={{ background: TAB_COLORS[c].light }} />,
                run: () => useTabs.getState().setColor(group.id, c),
              })),
              {
                label: "No colour",
                checked: !group.color,
                icon: <span className="size-3 rounded-full border border-control-border" />,
                run: () => useTabs.getState().setColor(group.id, null),
              },
            ],
            [
              { label: "Split right", hint: "⌘D", run: () => useTabs.getState().splitActive("row") },
              { label: "Split down", hint: "⇧⌘D", run: () => useTabs.getState().splitActive("col") },
              { label: "Split right: local shell", hint: "⇧⌘L", run: () => useTabs.getState().splitActive("row", true) },
              { label: "Split down: local shell", hint: "⌥⇧⌘L", run: () => useTabs.getState().splitActive("col", true) },
              { label: "Type in all panes", hint: "⌥⌘I", checked: !!group.broadcast, run: toggleBroadcast },
            ],
            [{ label: panes.length > 1 ? `Close tab (${panes.length} panes)` : "Close tab", run: () => closeGroup(group.id) }],
          ]}
        />,
          document.body,
        )}
    </div>
  );
}

export function TabStrip() {
  const tabs = useTabs((s) => s.tabs);
  const groups = useTabs((s) => s.groups);
  const activeId = useTabs((s) => s.activeId);
  const historyOpen = useTabs((s) => s.historyOpen);
  const detailsOpen = useTabs((s) => s.detailsOpen);
  const snippetsOpen = useTabs((s) => s.snippetsOpen);
  const hostsOpen = useTabs((s) => s.hostsOpen);
  const settingsOpen = useTabs((s) => s.settingsOpen);
  const workflowsOpen = useTabs((s) => s.workflowsOpen);
  const workflowsFront = useTabs((s) => s.activeId === WORKFLOWS_ID || !!groupOf(s, s.activeId)?.workflow);
  const setOverlay = useUi((s) => s.setOverlay);

  // Everything after Home, in the order you dragged it to (new ones last).
  const stripOrder = useTabs((s) => s.stripOrder);
  const items: { key: string; node: React.ReactNode }[] = [];
  if (detailsOpen) items.push({ key: "details", node: <DetailsTab active={activeId === DETAILS_ID} /> });
  if (historyOpen) items.push({ key: "history", node: <HistoryTab active={activeId === HISTORY_ID} /> });
  if (snippetsOpen) items.push({ key: "snippets", node: <SnippetsTab active={activeId === SNIPPETS_ID} /> });
  if (hostsOpen) items.push({ key: "hosts", node: <HostsTab active={activeId === HOSTS_ID} /> });
  if (settingsOpen) items.push({ key: "settings", node: <SettingsTab active={activeId === SETTINGS_ID} /> });
  if (workflowsOpen) items.push({ key: "workflows", node: <WorkflowsTab active={workflowsFront} /> });
  for (const g of groups.filter((x) => !x.workflow)) {
    const ids = leaves(g.layout);
    const panes = tabs.filter((t) => ids.includes(t.id));
    const tab = panes.find((t) => t.id === g.focus) ?? panes[0];
    if (tab) items.push({ key: g.id, node: <TabItem tab={tab} group={g} panes={panes} active={!!activeId && ids.includes(activeId)} /> });
  }
  const rank = (key: string, i: number) => {
    const at = stripOrder.indexOf(key);
    return at < 0 ? 100_000 + i : at;
  };
  const ordered = items.map((it, i) => ({ ...it, r: rank(it.key, i) })).sort((a, b) => a.r - b.r);
  const drag = useStripDrag(ordered.map((o) => o.key));

  return (
    <div role="tablist" className="flex h-[46px] flex-none items-center gap-1 border-b border-divider bg-sidebar pl-2">
      <div className="flex min-w-0 flex-[0_1_auto] items-center gap-1 overflow-hidden py-1.5 pr-1">
        <HomeTab active={activeId === HOME_ID || activeId === null} />
        {ordered.map((o) => (
          <div
            key={o.key}
            data-strip-key={o.key}
            onPointerDown={(e) => drag.start(e, o.key)}
            // History, Snippets and Workflows keep their size (their tab
            // can't shrink); terminal tabs and a details page shrink.
            className={cn(
              "relative flex",
              FIXED.includes(o.key) ? "flex-none" : "min-w-0 flex-[0_1_auto]",
              drag.dragging === o.key && "opacity-50",
            )}
          >
            {o.node}
            {drag.over?.key === o.key && (
              <span className={cn("pointer-events-none absolute top-1.5 bottom-1.5 z-10 w-[3px] rounded bg-primary", drag.over.after ? "-right-[3px]" : "-left-[3px]")} />
            )}
          </div>
        ))}
      </div>
      <button
        title="New local shell (⌘T) · ⌥-click: SSH to host (⌥⌘T)"
        onClick={(e) => (e.altKey ? setOverlay("ssh") : openLocalShell())}
        className="flex size-[30px] flex-none cursor-pointer items-center justify-center rounded-full text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
      >
        <Plus className="size-[17px]" strokeWidth={1.75} aria-hidden />
      </button>
      <TabConfigButton />
      <div data-tauri-drag-region className="h-full flex-1" />
    </div>
  );
}

/** The pinned Home tab (always first, can't be closed). */
function HomeTab({ active }: { active: boolean }) {
  return (
    <div
      role="tab"
      aria-selected={active}
      title="Home"
      onMouseDown={(e) => {
        if (e.button === 0) useTabs.setState({ activeId: HOME_ID });
      }}
      className={cn(
        PILL,
        "flex-none px-3.5",
        active ? PILL_ON : PILL_OFF,
      )}
    >
      <House className="size-4" strokeWidth={1.75} aria-hidden />
      <span>Home</span>
    </div>
  );
}

/** ⌄ next to +: open a tab config (Warp-style), or make one. */
function TabConfigButton() {
  const [menu, setMenu] = useState<{ x: number; y: number; list: TabConfigEntry[] } | null>(null);
  return (
    <>
      <button
        title="Tab configs"
        aria-label="Tab configs"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          tabConfigsList().then(
            (list) => setMenu({ x: r.left, y: r.bottom + 4, list }),
            (err) => toastError(errorMessage(err)),
          );
        }}
        className="-ml-1 flex size-[26px] flex-none cursor-pointer items-center justify-center rounded-full text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
      >
        <ChevronDown className="size-4" strokeWidth={2} aria-hidden />
      </button>
      {menu &&
        createPortal(
          <PopupMenu
            x={menu.x}
            y={menu.y}
            title="Tab configs"
            onClose={() => setMenu(null)}
            groups={[
              [
                { label: "Terminal", hint: "⌘T", icon: <SquareTerminal className="size-3.5" />, run: () => void openLocalShell() },
                ...menu.list.map((e) => ({
                  label: e.config.name,
                  hint: e.error ? "can't read" : e.source === "warp" ? "Warp" : undefined,
                  disabled: !e.layout,
                  icon: <ColorDot color={e.config.color} />,
                  run: () => openTabConfig(e),
                })),
              ],
              [
                { label: "New tab config…", run: () => useTabConfigs.getState().show({ edit: null }) },
                { label: "Edit tab configs…", run: () => useTabConfigs.getState().show("list") },
              ],
            ]}
          />,
          document.body,
        )}
    </>
  );
}

/** The details page's tab: the selected server/app, or "New …". */
function DetailsTab({ active }: { active: boolean }) {
  const target = useManage((s) => s.details);
  const servers = useConfig((s) => s.snapshot?.config?.servers);
  const server = target?.serverId ? servers?.find((s) => s.id === target.serverId) : undefined;
  const app = target?.kind === "app" && target.appId ? server?.apps.find((a) => a.id === target.appId) : undefined;
  const label =
    target?.kind === "app"
      ? app
        ? app.name
        : "New app"
      : server
        ? server.name
        : "New server";
  const badgeId = app && server ? `${server.id}/${app.id}` : (server?.id ?? "new");
  return (
    <div
      role="tab"
      aria-selected={active}
      onMouseDown={(e) => {
        if (e.button === 0) useTabs.getState().openDetails();
      }}
      className={cn(
        PILL,
        "max-w-[240px] min-w-0 flex-[0_1_auto] pr-1.5 pl-2",
        active ? PILL_ON : PILL_OFF,
      )}
    >
      <Badge id={badgeId} name={label} size={20} className="flex-none rounded-[5px]" />
      <span className="truncate">{label}</span>
      <button
        aria-label="Close details"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => useTabs.getState().closeDetails()}
        className="size-5 flex-none rounded-full text-center text-[15px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

/** Pinned tabs that never shrink in a full strip. */
const FIXED = ["history", "snippets", "workflows", "settings"];

/** Drag a tab along the strip to reorder it (a short press still just
 *  picks the tab). */
function useStripDrag(keys: string[]) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; after: boolean } | null>(null);
  const start = (e: React.PointerEvent, key: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
    const x0 = e.clientX;
    let moving = false;
    let target: { key: string; after: boolean } | null = null;
    const move = (ev: PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - x0) < 6) return;
      moving = true;
      document.body.style.userSelect = "none";
      setDragging(key);
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-strip-key]");
      if (el && el.dataset.stripKey !== key) {
        const r = el.getBoundingClientRect();
        target = { key: el.dataset.stripKey!, after: ev.clientX > r.left + r.width / 2 };
      } else target = null;
      setOver(target);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      setDragging(null);
      setOver(null);
      if (!moving || !target) return;
      const rest = keys.filter((k) => k !== key);
      const at = rest.indexOf(target.key) + (target.after ? 1 : 0);
      rest.splice(at, 0, key);
      useTabs.getState().setStripOrder(rest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { start, dragging, over };
}

/** The pinned Workflows tab: every run (this session's live, earlier ones
 *  from History). A spinner while one is running. */
function WorkflowsTab({ active }: { active: boolean }) {
  const { openWorkflows, closeWorkflows } = useTabs.getState();
  const running = useTabs((s) => s.tabs.some((t) => t.workflow && !t.workflow.part && t.state === "running" && !!groupOf(s, t.id)?.workflow));
  return (
    <div
      role="tab"
      aria-selected={active}
      onMouseDown={(e) => {
        if (e.button === 0 && !active) openWorkflows();
      }}
      className={cn(
        PILL,
        "flex-none pr-1.5 pl-3",
        active ? PILL_ON_DARK : PILL_OFF,
      )}
    >
      {running ? <Spinner size={11} /> : <WorkflowIcon className="size-3.5 text-muted-foreground" strokeWidth={1.75} />}
      <span>Workflows</span>
      <button
        aria-label="Close Workflows"
        title="Close: finished runs are cleared (they stay in History); a running one carries on"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={closeWorkflows}
        className="size-5 flex-none rounded-full text-center text-[15px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

/** The pinned Settings tab. */
function SettingsTab({ active }: { active: boolean }) {
  const { openSettings, closeSettings } = useTabs.getState();
  return (
    <div
      role="tab"
      aria-selected={active}
      onMouseDown={(e) => {
        if (e.button === 0) openSettings();
      }}
      className={cn(
        PILL,
        "flex-none pr-1.5 pl-3",
        active ? PILL_ON : PILL_OFF,
      )}
    >
      <Settings className="size-4 text-muted-foreground" strokeWidth={1.75} />
      <span>Settings</span>
      <button
        aria-label="Close Settings"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={closeSettings}
        className="size-5 flex-none rounded-full text-center text-[15px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

/** The pinned SSH hosts tab. */
function HostsTab({ active }: { active: boolean }) {
  const { openHosts, closeHosts } = useTabs.getState();
  return (
    <div
      role="tab"
      aria-selected={active}
      onMouseDown={(e) => {
        if (e.button === 0) openHosts();
      }}
      className={cn(
        PILL,
        "flex-none pr-1.5 pl-3",
        active ? PILL_ON : PILL_OFF,
      )}
    >
      <Network className="size-4 text-muted-foreground" strokeWidth={1.75} />
      <span>SSH hosts</span>
      <button
        aria-label="Close SSH hosts"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={closeHosts}
        className="size-5 flex-none rounded-full text-center text-[15px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

/** The pinned Snippets tab (managing them). */
function SnippetsTab({ active }: { active: boolean }) {
  const { openSnippets, closeSnippets } = useTabs.getState();
  return (
    <div
      role="tab"
      aria-selected={active}
      onMouseDown={(e) => {
        if (e.button === 0) openSnippets();
      }}
      className={cn(
        PILL,
        "flex-none pr-1.5 pl-3",
        active ? PILL_ON : PILL_OFF,
      )}
    >
      <Glyph className="text-muted-foreground">{"{}"}</Glyph>
      <span>Snippets</span>
      <button
        aria-label="Close Snippets"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={closeSnippets}
        className="size-5 flex-none rounded-full text-center text-[15px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

/** The pinned History tab (design 1i). */
function HistoryTab({ active }: { active: boolean }) {
  const { openHistory, closeHistory } = useTabs.getState();
  return (
    <div
      role="tab"
      aria-selected={active}
      onMouseDown={(e) => {
        if (e.button === 0) openHistory();
      }}
      className={cn(
        PILL,
        "flex-none pr-1.5 pl-3",
        active ? PILL_ON : PILL_OFF,
      )}
    >
      <Glyph className="text-muted-foreground">↺</Glyph>
      <span>History</span>
      <button
        aria-label="Close History"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={closeHistory}
        className="size-5 flex-none rounded-full text-center text-[15px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}
