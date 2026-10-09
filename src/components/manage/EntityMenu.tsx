import { PopupMenu } from "@/components/kit/PopupMenu";
import { appDelete, errorMessage, openUrl, serverDelete, type App, type Server } from "@/lib/ipc";
import { askConfirm } from "@/stores/confirm";
import { openDetails, useManage } from "@/stores/manage";
import { useNewApp } from "@/stores/newApp";
import { useConfig } from "@/stores/config";
import { DiscoverDialog } from "./DiscoverDialog";
import { openFiles, openHealth, openLogs, openMonitor, openQueues, openTune, useTabs } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

async function removeServer(server: Server) {
  const n = server.apps.length;
  const ok = await askConfirm(
    `Delete ${server.id}?`,
    `Removes ${server.id}${n ? ` and its ${n} app${n === 1 ? "" : "s"}` : ""} from Kemudi. Nothing on the server changes.`,
  );
  if (!ok) return;
  try {
    await serverDelete(server.id);
    useToasts.getState().push(`Deleted ${server.id}`, "info");
    if (useManage.getState().details?.serverId === server.id) useTabs.getState().closeDetails();
  } catch (e) {
    toastError(errorMessage(e));
  }
}

async function removeApp(server: Server, app: App) {
  const ok = await askConfirm(`Delete ${app.name}?`, `Removes ${app.id} from ${server.id} in Kemudi. Nothing on the server changes.`);
  if (!ok) return;
  try {
    await appDelete(server.id, app.id);
    useToasts.getState().push(`Deleted ${app.id}`, "info");
  } catch (e) {
    toastError(errorMessage(e));
  }
}

/** Right-click on a server or app row. */
export function EntityMenu() {
  const menu = useManage((s) => s.menu);
  if (!menu) return null;
  const { server, app } = menu;
  const groups = app
    ? [
        [
          {
            label: "Files",
            hint: app.path,
            run: () => void openFiles(server, { appId: app.id, dir: app.path, env: app.env, title: `${app.id} · files` }),
          },
          { label: "Logs", hint: "laravel.log, live", run: () => void openLogs(server, { appId: app.id, env: app.env, title: `${app.id} · logs` }) },
          { label: "Queues", hint: "workers, failed jobs", run: () => void openQueues(server, app) },
          ...(app.url ? [{ label: "Open site", hint: app.url.replace(/^https?:\/\//, ""), run: () => void openUrl(app.url!).catch((e) => toastError(errorMessage(e))) }] : []),
          { label: "Details…", run: () => openDetails({ kind: "app", serverId: server.id, appId: app.id }) },
        ],
        [{ label: "Delete app…", run: () => removeApp(server, app) }],
      ]
    : [
        [
          { label: "Files", hint: "browse, edit, upload", run: () => void openFiles(server) },
          { label: "Logs", hint: "apps, nginx, PHP, workers", run: () => void openLogs(server) },
          { label: "Monitor", hint: "CPU, memory, disks", run: () => void openMonitor(server) },
          { label: "Health", hint: "SSL, updates, services", run: () => void openHealth(server) },
          { label: "Fine-tune", hint: "PHP-FPM, OPcache, MySQL, nginx", run: () => void openTune(server) },
          { label: "Details…", run: () => openDetails({ kind: "server", serverId: server.id }) },
          { label: "Add app…", run: () => openDetails({ kind: "app", serverId: server.id, appId: null }) },
          { label: "Discover apps…", hint: "find Laravel apps on it", run: () => useManage.getState().setDiscover(server.id) },
          { label: "New app…", hint: "set one up from git", run: () => useNewApp.getState().open(server.id) },
        ],
        [{ label: "Delete server…", run: () => removeServer(server) }],
      ];
  return (
    <PopupMenu
      x={menu.x}
      y={menu.y}
      title={app ? `${app.id} on ${server.id}` : server.id}
      groups={groups}
      onClose={() => useManage.getState().setMenu(null)}
    />
  );
}

/** Discover apps (from a server's right-click menu or its page). */
export function DiscoverHost() {
  const serverId = useManage((s) => s.discover);
  const server = useConfig((s) => s.snapshot?.config?.servers.find((x) => x.id === serverId));
  if (!serverId || !server) return null;
  return <DiscoverDialog server={server} onClose={() => useManage.getState().setDiscover(null)} />;
}
