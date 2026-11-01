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

/** One icon button in a toolbar capsule. */
function Tool({ title, onClick, active, children }: { title: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "flex size-[30px] cursor-pointer items-center justify-center rounded-full text-foreground/80 transition-colors hover:bg-hover-strong hover:text-foreground active:scale-95",
        active && "bg-hover-strong text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** The capsule look (macOS 26 style): white, round, a hairline and a soft
 *  shadow. */
const capsule = "rounded-full border border-black/[0.06] bg-background shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.05)]";

/** Buttons that belong together, in one capsule. */
function Group({ children }: { children: React.ReactNode }) {
  return <div className={cn("flex h-[38px] flex-none items-center gap-0.5 px-[3px]", capsule)}>{children}</div>;
}

const icon = "size-[18px]";

/** 52px title bar drawn under the native traffic lights (overlay style,
 *  trafficLightPosition y 28 in tauri.conf.json centres them):
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
    <div data-tauri-drag-region className="relative flex h-[52px] flex-none items-center gap-2.5 border-b border-border bg-titlebar pr-3 pl-[92px]">
      <div className="pointer-events-none flex min-w-0 flex-1 items-center gap-2 text-[14px] font-semibold text-muted-foreground">
        <LogoMark className="h-[14px] flex-none" />
        <span className="truncate">{title}</span>
      </div>
      <Group>
        <Tool title={checking ? "Checking servers…" : "Check all servers now (disks, updates, certificates…)"} onClick={checkAll}>
          <RefreshCw className={cn(icon, checking && "animate-spin")} strokeWidth={1.6} />
        </Tool>
      </Group>
      <Group>
        <Tool title="New terminal (⌘T)" onClick={() => openLocalShell()}>
          <SquareTerminal className={icon} strokeWidth={1.6} />
        </Tool>
        <Tool title="SSH to host… (⌥⌘T)" onClick={() => useUi.getState().setOverlay("ssh")}>
          <Plus className={icon} strokeWidth={1.6} />
        </Tool>
        <Tool title="Add server" onClick={() => openDetails({ kind: "server", serverId: null })}>
          <Server className={icon} strokeWidth={1.6} />
        </Tool>
      </Group>
      <Group>
        <Tool title="Passwords (⇧⌘K)" onClick={() => useUi.getState().setOverlay("passwords")}>
          <KeyRound className={icon} strokeWidth={1.6} />
        </Tool>
        <Tool title="SSH hosts (⇧⌘E)" onClick={() => useTabs.getState().openHosts()}>
          <Network className={icon} strokeWidth={1.6} />
        </Tool>
        <Tool title="Settings (⌘,)" onClick={() => useTabs.getState().openSettings()}>
          <Settings className={icon} strokeWidth={1.6} />
        </Tool>
      </Group>
      <button
        title="Search servers, apps, tabs and commands (⌘K)"
        onClick={() => useUi.getState().setOverlay("palette")}
        className={cn(
          "flex h-[38px] w-[38px] flex-none cursor-pointer items-center justify-center gap-2 px-3 text-[13.5px] text-subtle-foreground hover:text-foreground lg:w-[300px] lg:justify-start",
          capsule,
        )}
      >
        <Search className="size-[16px] flex-none" strokeWidth={1.6} />
        <span className="hidden flex-1 text-left lg:inline">Search</span>
        <span className="hidden font-mono text-[11.5px] text-faint-foreground lg:inline">⌘K</span>
      </button>
      <Group>
        <Tool title={panel ? "Hide actions (⌘J)" : "Show actions (⌘J)"} active={panel} onClick={() => useUi.getState().toggleActionsPanel()}>
          <PanelRight className={icon} strokeWidth={1.6} />
        </Tool>
      </Group>
    </div>
  );
}
