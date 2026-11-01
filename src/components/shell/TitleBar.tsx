import { KeyRound, Network, PanelRight, Plus, RefreshCw, Search, Server, Settings, SquareTerminal } from "lucide-react";

import { LogoMark } from "@/components/kit/Logo";
import { errorMessage } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { openDetails } from "@/stores/manage";
import { useTeamServers } from "@/stores/team";
import { openLocalShell, useTabs } from "@/stores/tabs";
import { toastError } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useWatch } from "@/stores/watch";

/** One icon button in a toolbar group. */
function Tool({ title, onClick, active, children }: { title: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "flex h-[26px] w-[30px] cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground",
        active && "bg-hover-strong text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Buttons that belong together, in one rounded box. */
function Group({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-px rounded-lg border border-border bg-background/60 p-px">{children}</div>;
}

const icon = "size-[15px]";

/** 38px title bar drawn under the native traffic lights (overlay style):
 *  the title on the left, a toolbar on the right (check all, new things,
 *  passwords / SSH hosts / settings, search, the actions panel). */
export function TitleBar({ title }: { title: string }) {
  const panel = useUi((s) => s.actionsPanel);
  const servers = useTeamServers();
  const checking = useWatch((s) => (s.snapshot?.running.length ?? 0) > 0);

  const checkAll = () =>
    void useWatch
      .getState()
      .refresh(servers.map((s) => s.id))
      .catch((e) => toastError(errorMessage(e)));

  return (
    <div data-tauri-drag-region className="relative flex h-[38px] flex-none items-center gap-2 border-b border-border bg-titlebar pr-2 pl-[84px]">
      <div className="pointer-events-none flex min-w-0 flex-1 items-center gap-2 text-[13px] font-semibold text-muted-foreground">
        <LogoMark className="h-[13px] flex-none" />
        <span className="truncate">{title}</span>
      </div>
      <Group>
        <Tool title={checking ? "Checking servers…" : "Check all servers now (disks, updates, certificates…)"} onClick={checkAll}>
          <RefreshCw className={cn(icon, checking && "animate-spin")} strokeWidth={1.75} />
        </Tool>
      </Group>
      <Group>
        <Tool title="New terminal (⌘T)" onClick={() => openLocalShell()}>
          <SquareTerminal className={icon} strokeWidth={1.75} />
        </Tool>
        <Tool title="SSH to host… (⌥⌘T)" onClick={() => useUi.getState().setOverlay("ssh")}>
          <Plus className={icon} strokeWidth={1.75} />
        </Tool>
        <Tool title="Add server" onClick={() => openDetails({ kind: "server", serverId: null })}>
          <Server className={icon} strokeWidth={1.75} />
        </Tool>
      </Group>
      <Group>
        <Tool title="Passwords (⇧⌘K)" onClick={() => useUi.getState().setOverlay("passwords")}>
          <KeyRound className={icon} strokeWidth={1.75} />
        </Tool>
        <Tool title="SSH hosts (⇧⌘E)" onClick={() => useTabs.getState().openHosts()}>
          <Network className={icon} strokeWidth={1.75} />
        </Tool>
        <Tool title="Settings (⌘,)" onClick={() => useTabs.getState().openSettings()}>
          <Settings className={icon} strokeWidth={1.75} />
        </Tool>
      </Group>
      <button
        title="Search servers, apps, tabs and commands (⌘K)"
        onClick={() => useUi.getState().setOverlay("palette")}
        className="flex h-[28px] w-[30px] flex-none cursor-pointer items-center gap-2 rounded-lg border border-border bg-background/60 px-2 text-[12.5px] text-subtle-foreground hover:text-foreground lg:w-[220px]"
      >
        <Search className="size-[14px] flex-none" strokeWidth={1.75} />
        <span className="hidden flex-1 text-left lg:inline">Search</span>
        <span className="hidden font-mono text-[11px] text-faint-foreground lg:inline">⌘K</span>
      </button>
      <Group>
        <Tool title={panel ? "Hide actions (⌘J)" : "Show actions (⌘J)"} active={panel} onClick={() => useUi.getState().toggleActionsPanel()}>
          <PanelRight className={icon} strokeWidth={1.75} />
        </Tool>
      </Group>
    </div>
  );
}
