import { ExternalLink, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";

import { DashboardView } from "@/components/dashboard/DashboardView";
import { FilesView } from "@/components/files/FilesView";
import { Btn } from "@/components/kit/Btn";
import { LogsView } from "@/components/logs/LogsView";
import { ServerSettings } from "@/components/manage/DetailsView";
import { HealthView } from "@/components/health/HealthView";
import { MonitorView } from "@/components/monitor/MonitorView";
import { SecurityView } from "@/components/security/SecurityView";
import { ServerSetupView } from "@/components/setup/SetupView";
import { TuneView } from "@/components/tune/TuneView";
import { openServerShell } from "@/lib/fleet";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { keepTab, openSectionAlone, SERVER_SECTIONS, setSection, type ServerSection, type Tab } from "@/stores/tabs";
import { useServerItems } from "@/stores/watch";

import { ServerApps, ServerOverview } from "./Watch";

/** A server's one tab, its home: a bar of sections (⌘-click, or ↗, opens one
 *  as a tab of its own) and Open shell. Sections you've looked at stay
 *  loaded while you switch, so going back doesn't read the server again. A
 *  preview tab (a plain click in the sidebar) is kept once you do something
 *  in it: pick a section, click or type in it. */
export function ServerTabView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const section = tab.section ?? "overview";
  const server = useConfig((s) => s.snapshot?.config?.servers.find((x) => x.id === tab.serverId));
  const [seen, setSeen] = useState<ServerSection[]>([section]);
  const items = useServerItems(tab.serverId ?? "").filter((i) => i.severity !== "info");
  useEffect(() => setSeen((s) => (s.includes(section) ? s : [...s, section])), [section]);

  if (!server) return <div className="light-ui absolute inset-0 bg-background p-4 text-[13px] text-subtle-foreground">{tab.serverId} isn't in Kemudi any more.</div>;

  const body = (sec: ServerSection, shown: boolean) => {
    switch (sec) {
      case "overview":
        return <ServerOverview server={server} />;
      case "apps":
        return <ServerApps server={server} />;
      case "dash":
        return <DashboardView tab={tab} visible={shown} />;
      case "files":
        return <FilesView tab={tab} visible={shown} field="filesDir" />;
      case "logs":
        return <LogsView tab={tab} visible={shown} field="logsPath" />;
      case "settings":
        return <ServerSettings server={server} />;
      case "monitor":
        return <MonitorView key={tab.instance ?? ""} tab={tab} title={server.name} visible={shown} />;
      case "health":
        return <HealthView tab={tab} visible={shown} />;
      case "security":
        return <SecurityView server={server} />;
      case "tune":
        return <TuneView tab={tab} visible={shown} />;
      case "setup":
        return <ServerSetupView tab={tab} visible={shown} />;
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="light-ui flex h-10 flex-none items-center gap-0.5 overflow-x-auto border-b border-divider bg-background px-2 text-foreground">
        {SERVER_SECTIONS.filter((x) => !server.asg || (x.id !== "health" && x.id !== "tune" && x.id !== "security")).map((x) => (
          <button
            key={x.id}
            title={alone(x.id) ? "⌘-click: in a tab of its own" : undefined}
            onClick={(e) => {
              if (e.metaKey && alone(x.id)) openSectionAlone(server, x.id, tab);
              else {
                setSection(tab.id, x.id);
                if (x.id !== section) keepTab(tab.id);
              }
            }}
            className={cn(
              "flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12.5px] whitespace-nowrap",
              x.id === section ? "bg-hover-strong font-medium text-foreground" : "text-subtle-foreground hover:bg-hover hover:text-foreground",
            )}
          >
            {x.label}
            {x.id === "apps" && server.apps.length > 0 && <span className="font-mono text-[10.5px] text-faint-foreground">{server.apps.length}</span>}
            {x.id === "overview" && items.length > 0 && (
              <span className={cn("rounded-[4px] px-1 font-mono text-[10px] font-semibold text-white", items.some((i) => i.severity === "urgent") ? "bg-env-prod" : "bg-env-staging")}>
                {items.length}
              </span>
            )}
          </button>
        ))}
        <span className="flex-1" />
        <Btn size="sm" variant="outline" onClick={() => openServerShell(server)} title={server.asg ? "A Session Manager shell on each running instance" : `ssh ${server.host}`}>
          <SquareTerminal className="size-3.5" /> {server.asg ? "Shells on all instances" : "Open shell"}
        </Btn>
        {alone(section) && (
          <button
            title="Open this section in a tab of its own"
            onClick={() => openSectionAlone(server, section, tab)}
            className="flex size-7 cursor-pointer items-center justify-center rounded-full text-subtle-foreground hover:bg-hover hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1" onMouseDownCapture={() => keepTab(tab.id)} onKeyDownCapture={() => keepTab(tab.id)}>
        {seen.map((sec) => (
          <div key={sec} className="absolute inset-0" hidden={sec !== section}>
            {body(sec, visible && sec === section)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Sections that can be a tab of their own (↗). */
const alone = (s: ServerSection) => s !== "overview" && s !== "apps" && s !== "security" && s !== "settings";
