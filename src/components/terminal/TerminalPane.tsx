import { useCallback, useRef, useState } from "react";

import type { Layout } from "@/lib/layout";
import { cn } from "@/lib/utils";
import { groupOf, isViewTab, useTabs, type Group, type Tab } from "@/stores/tabs";
import { useUi } from "@/stores/ui";

import { TerminalContextMenu, type MenuState } from "./TerminalContextMenu";
import { TerminalSearch } from "./TerminalSearch";
import { FilesView } from "@/components/files/FilesView";
import { LogsView } from "@/components/logs/LogsView";
import { QueuesView } from "@/components/queues/QueuesView";
import { HealthView } from "@/components/health/HealthView";
import { TuneView } from "@/components/tune/TuneView";
import { MonitorView } from "@/components/monitor/MonitorView";

import { PasswordChip } from "./PasswordChip";
import { WorkflowStepsView, setWorkflowView } from "@/components/workflows/WorkflowStepsView";
import { TerminalView } from "./TerminalView";

/** Every tab's panes, in split layouts; only the front tab is visible.
 *  The focused pane takes the keys; the others are dimmed a little. A prod
 *  pane gets a 1px red top border (design frame 1a). */
export function TerminalPane() {
  const tabs = useTabs((s) => s.tabs);
  const groups = useTabs((s) => s.groups);
  const activeId = useTabs((s) => s.activeId);
  const searchOpen = useUi((s) => s.searchOpen);
  const setSearchOpen = useUi((s) => s.setSearchOpen);
  const active = tabs.find((t) => t.id === activeId);
  const front = groupOf({ groups }, activeId ?? null);
  const [menu, setMenu] = useState<(MenuState & { unhighlight: () => void }) | null>(null);
  const closeMenu = useCallback(() => {
    setMenu((m) => {
      m?.unhighlight();
      return null;
    });
  }, []);
  // A tab only starts its PTYs once first shown, so restored sessions don't
  // open every SSH connection at launch.
  const shown = useRef(new Set<string>());
  if (front) shown.current.add(front.id);
  for (const id of shown.current) if (!groups.some((g) => g.id === id)) shown.current.delete(id);

  return (
    <div
      // Right button: no native selection; the block menu opens instead.
      onMouseDownCapture={(e) => {
        if (e.button === 2 && !(e.target as HTMLElement).closest(".selectable")) e.preventDefault();
      }}
      onContextMenuCapture={(e) => {
        // The pane under the pointer was just focused on mousedown.
        const s = useTabs.getState();
        const target = s.tabs.find((t) => t.id === s.activeId);
        // Monitors aren't terminals: their own (native) menu.
        if (!target || isViewTab(target.kind)) return;
        e.preventDefault();
        e.stopPropagation();
        const session = target.session;
        const row = session.rowAt(e.clientY);
        const block = row === null ? undefined : session.blocks.blockAt(row);
        menu?.unhighlight();
        setMenu({ x: e.clientX, y: e.clientY, session, block, unhighlight: block ? session.blocks.highlight(block) : () => {} });
      }}
      className="dracula relative min-h-0 flex-1 bg-terminal"
    >
      {groups
        .filter((g) => shown.current.has(g.id))
        .map((g) => (
          <div
            key={g.id}
            className="absolute inset-0 flex"
            style={{ visibility: g.id === front?.id ? "visible" : "hidden" }}
            aria-hidden={g.id !== front?.id}
          >
            <LayoutView group={g} layout={g.layout} tabs={tabs} visible={g.id === front?.id} activeId={activeId} />
          </div>
        ))}
      {menu && <TerminalContextMenu state={menu} onClose={closeMenu} />}
      {searchOpen && active && (
        <TerminalSearch key={active.id} session={active.session} onClose={() => setSearchOpen(false)} />
      )}
    </div>
  );
}

function LayoutView({
  group,
  layout,
  tabs,
  visible,
  activeId,
}: {
  group: Group;
  layout: Layout;
  tabs: Tab[];
  visible: boolean;
  activeId: string | null;
}) {
  if ("pane" in layout) {
    const tab = tabs.find((t) => t.id === layout.pane);
    if (!tab) return <div className="flex-1" />;
    const split = !("pane" in group.layout);
    const focused = tab.id === activeId;
    return (
      <div
        className={cn("relative min-h-0 min-w-0 flex-1 border-t", tab.prod ? "border-env-prod" : "border-terminal")}
        onMouseDown={() => {
          if (!focused) useTabs.getState().activate(tab.id);
        }}
      >
        {tab.kind === "monitor" && tab.serverId ? (
          <MonitorView tab={tab} title={tab.title.replace(/ · monitor$/, "")} visible={visible} />
        ) : tab.kind === "files" && tab.serverId ? (
          <FilesView tab={tab} visible={visible && focused} />
        ) : tab.kind === "logs" && tab.serverId ? (
          <LogsView tab={tab} visible={visible} />
        ) : tab.kind === "queues" && tab.serverId ? (
          <QueuesView tab={tab} visible={visible} />
        ) : tab.kind === "health" && tab.serverId ? (
          <HealthView tab={tab} visible={visible} />
        ) : tab.kind === "tune" && tab.serverId ? (
          <TuneView tab={tab} visible={visible} />
        ) : (
          <>
            <TerminalView session={tab.session} active={visible && focused && tab.workflow?.view !== "steps"} />
            {tab.workflow?.view !== "steps" && <PasswordChip tab={tab} />}
            {tab.workflow?.view === "steps" && <WorkflowStepsView tab={tab} />}
            {tab.workflow?.view === "output" && (
              <button
                onClick={() => setWorkflowView(tab, "steps")}
                className="absolute top-2 right-4 z-10 flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-white/15 bg-[#343746] px-2.5 font-mono text-[12px] text-[#b6b8c8] shadow hover:text-[#f8f8f2]"
                title="Back to the steps"
              >
                Steps ▸
              </button>
            )}
          </>
        )}
        {split && !focused && <div className="pointer-events-none absolute inset-0 bg-black/20" />}
      </div>
    );
  }
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1", layout.dir === "row" ? "flex-row" : "flex-col")}>
      <div className="flex min-h-0 min-w-0" style={{ flex: `${layout.ratio} 1 0` }}>
        <LayoutView group={group} layout={layout.a} tabs={tabs} visible={visible} activeId={activeId} />
      </div>
      <Divider groupId={group.id} splitId={layout.id} dir={layout.dir} />
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - layout.ratio} 1 0` }}>
        <LayoutView group={group} layout={layout.b} tabs={tabs} visible={visible} activeId={activeId} />
      </div>
    </div>
  );
}

/** Drag to resize the two sides; double-click to even them out. */
function Divider({ groupId, splitId, dir }: { groupId: string; splitId: string; dir: "row" | "col" }) {
  const row = dir === "row";
  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      className={cn(
        "relative z-10 flex-none bg-[#191a21] hover:bg-primary/60",
        row ? "w-[3px] cursor-col-resize" : "h-[3px] cursor-row-resize",
      )}
      onDoubleClick={() => useTabs.getState().setRatio(groupId, splitId, 0.5)}
      onPointerDown={(e) => {
        e.preventDefault();
        const parent = e.currentTarget.parentElement;
        if (!parent) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const box = parent.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          const ratio = row ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height;
          useTabs.getState().setRatio(groupId, splitId, ratio);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}
