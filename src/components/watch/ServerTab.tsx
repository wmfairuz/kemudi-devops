import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { DashboardView } from "@/components/dashboard/DashboardView";
import { HealthView } from "@/components/health/HealthView";
import { MonitorView } from "@/components/monitor/MonitorView";
import { ServerSetupView } from "@/components/setup/SetupView";
import { TuneView } from "@/components/tune/TuneView";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { openSectionAlone, SERVER_SECTIONS, setSection, type ServerSection, type Tab } from "@/stores/tabs";
import { useServerItems } from "@/stores/watch";

import { ServerOverview } from "./Watch";

/** A server's one tab: a bar of sections (⌘-click, or ↗, opens one as a tab
 *  of its own). Sections you've looked at stay loaded while you switch, so
 *  going back doesn't read the server again. */
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
      case "dash":
        return <DashboardView tab={tab} visible={shown} />;
      case "monitor":
        return <MonitorView key={tab.instance ?? ""} tab={tab} title={server.name} visible={shown} />;
      case "health":
        return <HealthView tab={tab} visible={shown} />;
      case "tune":
        return <TuneView tab={tab} visible={shown} />;
      case "setup":
        return <ServerSetupView tab={tab} visible={shown} />;
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="light-ui flex h-10 flex-none items-center gap-0.5 border-b border-divider bg-background px-2 text-foreground">
        {SERVER_SECTIONS.filter((x) => !server.asg || (x.id !== "health" && x.id !== "tune")).map((x) => (
          <button
            key={x.id}
            title={x.id === "overview" ? undefined : "⌘-click: in a tab of its own"}
            onClick={(e) => {
              if (e.metaKey) openSectionAlone(server, x.id);
              else setSection(tab.id, x.id);
            }}
            className={cn(
              "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12.5px]",
              x.id === section ? "bg-hover-strong font-medium text-foreground" : "text-subtle-foreground hover:bg-hover hover:text-foreground",
            )}
          >
            {x.label}
            {x.id === "overview" && items.length > 0 && (
              <span className={cn("rounded-[4px] px-1 font-mono text-[10px] font-semibold text-white", items.some((i) => i.severity === "urgent") ? "bg-env-prod" : "bg-env-staging")}>
                {items.length}
              </span>
            )}
          </button>
        ))}
        <span className="flex-1" />
        {section !== "overview" && (
          <button
            title="Open this section in a tab of its own"
            onClick={() => openSectionAlone(server, section)}
            className="flex size-7 cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {seen.map((sec) => (
          <div key={sec} className="absolute inset-0" hidden={sec !== section}>
            {body(sec, visible && sec === section)}
          </div>
        ))}
      </div>
    </div>
  );
}
