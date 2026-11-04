import { ExternalLink, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";

import { FilesView } from "@/components/files/FilesView";
import { Btn } from "@/components/kit/Btn";
import { LogsView } from "@/components/logs/LogsView";
import { QueuesView } from "@/components/queues/QueuesView";
import { openServerShell } from "@/lib/fleet";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { APP_SECTIONS, keepTab, openFiles, openLogs, openQueues, setAppSection, type AppSection, type Tab } from "@/stores/tabs";

import { AppParts } from "./DetailsView";

/** Sections that are views of their own (and can be a tab of their own, ↗). */
const VIEWS: AppSection[] = ["files", "logs", "queues"];

/** An app's one tab, like a server's: a bar of sections (⌘-click, or ↗,
 *  opens Files, Logs or Queues as a tab of its own) and Open shell. What
 *  Inspect found and the Settings form stay loaded while you switch. A
 *  preview tab is kept once you pick a section, click or type in it. */
export function AppTabView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const section = tab.appSection ?? "overview";
  const server = useConfig((s) => s.snapshot?.config?.servers.find((x) => x.id === tab.serverId));
  const app = server?.apps.find((a) => a.id === tab.appId);
  const [seen, setSeen] = useState<AppSection[]>([section]);
  useEffect(() => setSeen((s) => (s.includes(section) ? s : [...s, section])), [section]);

  if (!server || !app) {
    return <div className="light-ui absolute inset-0 bg-background p-4 text-[13px] text-subtle-foreground">{tab.appId} isn't in Kemudi any more.</div>;
  }

  const go = (to: AppSection) => {
    setAppSection(tab.id, to);
    if (to !== section) keepTab(tab.id);
  };
  const alone = (to: AppSection) => {
    if (to === "files") openFiles(server, { appId: app.id, dir: tab.filesDir ?? app.path, env: app.env, title: `${app.id} · files` });
    else if (to === "logs") openLogs(server, { appId: app.id, path: tab.logsPath, env: app.env, title: `${app.id} · logs` });
    else if (to === "queues") openQueues(server, app);
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="light-ui flex h-10 flex-none items-center gap-0.5 overflow-x-auto border-b border-divider bg-background px-2 text-foreground">
        {APP_SECTIONS.map((x) => (
          <button
            key={x.id}
            title={VIEWS.includes(x.id) ? "⌘-click: in a tab of its own" : undefined}
            onClick={(e) => {
              if (e.metaKey && VIEWS.includes(x.id)) alone(x.id);
              else go(x.id);
            }}
            className={cn(
              "flex h-7 flex-none cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12.5px] whitespace-nowrap",
              x.id === section ? "bg-hover-strong font-medium text-foreground" : "text-subtle-foreground hover:bg-hover hover:text-foreground",
            )}
          >
            {x.label}
          </button>
        ))}
        <span className="flex-1" />
        <Btn size="sm" variant="outline" onClick={() => openServerShell(server, app)} title={server.asg ? "A Session Manager shell on each running instance, in its folder" : `ssh ${server.host}, in ${app.path}`}>
          <SquareTerminal className="size-3.5" /> {server.asg ? "Shells on all instances" : "Open shell"}
        </Btn>
        {VIEWS.includes(section) && (
          <button
            title="Open this section in a tab of its own"
            onClick={() => alone(section)}
            className="flex size-7 cursor-pointer items-center justify-center rounded-full text-subtle-foreground hover:bg-hover hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1" onMouseDownCapture={() => keepTab(tab.id)} onKeyDownCapture={() => keepTab(tab.id)}>
        {/* Overview, Web server, Supervisor, Cron, .env and Settings: one
            component, so the form and Inspect are shared. */}
        <div className="absolute inset-0" hidden={VIEWS.includes(section)}>
          <AppParts server={server} app={app} section={VIEWS.includes(section) ? "overview" : section} onGo={go} />
        </div>
        {seen
          .filter((s) => VIEWS.includes(s))
          .map((s) => (
            <div key={s} className="absolute inset-0" hidden={s !== section}>
              {s === "files" && <FilesView tab={tab} visible={visible && s === section} field="filesDir" />}
              {s === "logs" && <LogsView tab={tab} visible={visible && s === section} field="logsPath" />}
              {s === "queues" && <QueuesView tab={tab} visible={visible && s === section} />}
            </div>
          ))}
      </div>
    </div>
  );
}
