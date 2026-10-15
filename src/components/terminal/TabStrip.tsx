import { Activity, ChevronDown, Columns2, Keyboard, Workflow as WorkflowIcon, FolderOpen, Gauge, HeartPulse, House, ListChecks, ScrollText, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { Kbd } from "@/components/kit/Kbd";
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
import { DETAILS_ID, HISTORY_ID, HOME_ID, SNIPPETS_ID, WORKFLOWS_ID, groupOf, isViewTab, openLocalShell, toggleBroadcast, useTabs, type Group, type Tab } from "@/stores/tabs";
import { useUi } from "@/stores/ui";

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "monitor") return <Activity className="size-4 flex-none text-[#8be9fd]" strokeWidth={2} />;
  if (tab.kind === "files") return <FolderOpen className="size-4 flex-none text-[#f1fa8c]" strokeWidth={2} />;
  if (tab.kind === "logs") return <ScrollText className="size-4 flex-none text-[#ffb86c]" strokeWidth={2} />;
  if (tab.kind === "queues") return <ListChecks className="size-4 flex-none text-[#50fa7b]" strokeWidth={2} />;
  if (tab.kind === "health") return <HeartPulse className="size-4 flex-none text-[#ff79c6]" strokeWidth={2} />;
  if (tab.kind === "tune") return <Gauge className="size-4 flex-none text-[#bd93f9]" strokeWidth={2} />;
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
  // A coloured strip on top and a light tint; Dracula hue on the dark
  // active tab, the Alucard one on the light strip.
  const tint = color
    ? {
        backgroundImage: `linear-gradient(${active ? color.dark : color.light}${active ? "26" : "1a"}, ${active ? color.dark : color.light}${active ? "26" : "1a"})`,
        boxShadow: `inset 0 3px 0 ${active ? color.dark : color.light}${prod ? ", inset 0 -2px 0 var(--env-prod)" : ""}`,
      }
    : undefined;

  const shadow = prod
    ? "shadow-[inset_0_-2px_0_var(--env-prod)]"
    : active
      ? ""
      : "shadow-[inset_0_-1px_0_var(--divider)]";

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
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        activate(tab.id);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      style={tint}
      className={cn(
        "group flex h-11 max-w-[260px] min-w-0 flex-[0_1_auto] items-center gap-2.5 border-r border-divider pr-2.5 pl-3.5 text-[13px]",
        // The active tab is the same colour as the terminal under it.
        active ? "dracula bg-terminal text-foreground" : "text-dim-foreground hover:text-foreground",
        shadow,
      )}
    >
      <TabIcon tab={tab} />
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
        <span className="truncate">{tab.title}</span>
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
      <button
        aria-label={`Close ${tab.title}${panes.length > 1 ? ` and its ${panes.length} panes` : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => closeGroup(group.id)}
        className="size-5 flex-none rounded-md text-center text-[16px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
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
  const workflowsOpen = useTabs((s) => s.workflowsOpen);
  const workflowsFront = useTabs((s) => s.activeId === WORKFLOWS_ID || !!groupOf(s, s.activeId)?.workflow);
  const setOverlay = useUi((s) => s.setOverlay);

  // Everything after Home, in the order you dragged it to (new ones last).
  const stripOrder = useTabs((s) => s.stripOrder);
  const items: { key: string; node: React.ReactNode }[] = [];
  if (detailsOpen) items.push({ key: "details", node: <DetailsTab active={activeId === DETAILS_ID} /> });
  if (historyOpen) items.push({ key: "history", node: <HistoryTab active={activeId === HISTORY_ID} /> });
  if (snippetsOpen) items.push({ key: "snippets", node: <SnippetsTab active={activeId === SNIPPETS_ID} /> });
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
    <div role="tablist" className="flex h-11 flex-none bg-sidebar">
      <div className="flex min-w-0 flex-[0_1_auto] overflow-hidden">
        <HomeTab active={activeId === HOME_ID || activeId === null} />
        {ordered.map((o) => (
          <div
            key={o.key}
            data-strip-key={o.key}
            onPointerDown={(e) => drag.start(e, o.key)}
            className={cn("relative flex min-w-0 flex-[0_1_auto]", drag.dragging === o.key && "opacity-50")}
          >
            {o.node}
            {drag.over?.key === o.key && (
              <span className={cn("pointer-events-none absolute top-1.5 bottom-1.5 z-10 w-[3px] rounded bg-primary", drag.over.after ? "-right-[2px]" : "-left-[2px]")} />
            )}
          </div>
        ))}
      </div>
      <button
        title="New local shell (⌘T) · ⌥-click: SSH to host (⇧⌘T)"
        onClick={(e) => (e.altKey ? setOverlay("ssh") : openLocalShell())}
        className="flex h-11 w-9 flex-none items-center justify-center text-[19px] text-subtle-foreground shadow-[inset_0_-1px_0_var(--divider)] hover:text-foreground"
      >
        +
      </button>
      <TabConfigButton />
      <div
        data-tauri-drag-region
        className="flex flex-1 items-center justify-end gap-1.5 pr-3 shadow-[inset_0_-1px_0_var(--divider)]"
      >
        <button title="Command palette" onClick={() => setOverlay("palette")}>
          <Kbd className="border-control-border bg-transparent text-faint-foreground hover:text-muted-foreground">⌘K</Kbd>
        </button>
      </div>
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
        "flex h-11 flex-none items-center gap-2 border-r border-divider px-3.5 text-[13px]",
        active ? "bg-background text-foreground" : "text-dim-foreground shadow-[inset_0_-1px_0_var(--divider)] hover:text-foreground",
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
        className="-ml-1.5 flex h-11 w-6 flex-none items-center justify-center text-subtle-foreground shadow-[inset_0_-1px_0_var(--divider)] hover:text-foreground"
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
        "flex h-11 max-w-[240px] flex-none items-center gap-2.5 border-r border-divider pr-2.5 pl-3 text-[13px]",
        active ? "bg-background text-foreground" : "text-dim-foreground shadow-[inset_0_-1px_0_var(--divider)] hover:text-foreground",
      )}
    >
      <Badge id={badgeId} name={label} size={20} className="rounded-[5px]" />
      <span className="truncate">{label}</span>
      <button
        aria-label="Close details"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => useTabs.getState().closeDetails()}
        className="size-5 flex-none rounded-md text-center text-[16px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}

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
        "flex h-11 flex-none items-center gap-2.5 border-r border-divider pr-2.5 pl-3.5 text-[13px]",
        active ? "dracula bg-terminal text-foreground" : "text-dim-foreground shadow-[inset_0_-1px_0_var(--divider)] hover:text-foreground",
      )}
    >
      {running ? <Spinner size={11} /> : <WorkflowIcon className="size-3.5 text-muted-foreground" strokeWidth={1.75} />}
      <span>Workflows</span>
      <button
        aria-label="Close Workflows"
        title="Close: finished runs are cleared (they stay in History); a running one carries on"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={closeWorkflows}
        className="size-5 flex-none rounded-md text-center text-[16px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
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
        "flex h-11 flex-none items-center gap-2.5 border-r border-divider pr-2.5 pl-3.5 text-[13px]",
        active ? "bg-background text-foreground" : "text-dim-foreground shadow-[inset_0_-1px_0_var(--divider)] hover:text-foreground",
      )}
    >
      <Glyph className="text-muted-foreground">{"{}"}</Glyph>
      <span>Snippets</span>
      <button
        aria-label="Close Snippets"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={closeSnippets}
        className="size-5 flex-none rounded-md text-center text-[16px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
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
        "flex h-11 flex-none items-center gap-2.5 border-r border-divider pr-2.5 pl-3.5 text-[13px]",
        active ? "bg-background text-foreground" : "text-dim-foreground shadow-[inset_0_-1px_0_var(--divider)] hover:text-foreground",
      )}
    >
      <Glyph className="text-muted-foreground">↺</Glyph>
      <span>History</span>
      <button
        aria-label="Close History"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={closeHistory}
        className="size-5 flex-none rounded-md text-center text-[16px] leading-[19px] text-faint-foreground hover:bg-hover-strong hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}
