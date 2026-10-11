// AWS Auto Scaling group servers: their running instances are looked up
// when used, and each gets a Session Manager pane in one tab, with Type in
// all panes on (⇧⌘I), so one command or answer goes to all of them.
import {
  actionRun,
  asgInstances,
  errorMessage,
  type App,
  type Instance,
  type RenderedAction,
  type Server,
} from "@/lib/ipc";
import { ptySpawner } from "@/lib/terminalSession";
import { findServer } from "@/stores/config";
import { openSsh, useTabs } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

export const isAsg = (server: Server | null | undefined): boolean => !!server?.asg;

/** How an instance is named in pane titles: its private IP, else its id. */
export const instanceLabel = (i: Instance) => i.ip ?? i.id;

/** The group's running instances, or null (told why). */
async function lookUp(server: Server): Promise<Instance[] | null> {
  try {
    const list = await asgInstances(server.id);
    if (list.length === 0) {
      toastError(`${server.name}: no running instances in ${server.asg?.name ?? "the group"}`);
      return null;
    }
    return list;
  } catch (e) {
    toastError(`${server.name}: ${errorMessage(e)}`);
    return null;
  }
}

/** A shell on every instance, one pane each (in the app's folder for an
 *  app). */
export async function openAsgShells(server: Server, app?: App | null): Promise<void> {
  const list = await lookUp(server);
  if (!list) return;
  const prod = (app?.env ?? server.env) === "prod";
  useTabs.getState().openGrid(
    list.map((i) => ({
      kind: "ssh",
      title: `${app?.name ?? server.name} · ${instanceLabel(i)}`,
      serverId: server.id,
      instance: i.id,
      appId: app?.id,
      cwd: app?.path,
      prod,
      spawn: ptySpawner({ kind: "ssm", serverId: server.id, instance: i.id, cwd: app?.path }),
    })),
    { broadcast: list.length > 1 },
  );
  if (list.length > 1) {
    useToasts.getState().push(`${list.length} instances of ${server.name}: typing goes to all of them (⇧⌘I to stop).`, "info");
  }
}

/** A shell on a server (or in an app's folder): ssh, or a pane per
 *  instance for an Auto Scaling group. */
export function openServerShell(server: Server, app?: App | null): void {
  if (isAsg(server)) {
    void openAsgShells(server, app);
    return;
  }
  openSsh(server.host, {
    serverId: server.id,
    prod: (app?.env ?? server.env) === "prod",
    title: app ? `${server.id} · ${app.id}` : `${server.id} · ssh`,
    cwd: app?.path,
    appId: app?.id ?? undefined,
  });
}

/** Run an action on every instance, one pane each; Type in all panes is on
 *  so a prompt (a password, a yes/no) is answered once for all. */
export async function runOnAsg(a: RenderedAction, override: string | null, intro: (instance: Instance) => string): Promise<void> {
  const server = findServer(a.serverId);
  if (!server) return;
  const list = await lookUp(server);
  if (!list) return;
  const ref = { serverId: a.serverId, appId: a.appId, actionId: a.actionId, values: a.values };
  const ids: string[] = [];
  const opened = useTabs.getState().openGrid(
    list.map((i, k) => ({
      kind: "action",
      title: `${a.title} · ${instanceLabel(i)}`,
      serverId: a.serverId,
      instance: i.id,
      appId: a.appId,
      actionId: a.actionId,
      prod: a.env === "prod",
      state: "running",
      intro: intro(i),
      spawn: (cols, rows, onData, onEvent) =>
        actionRun(ref, override, cols, rows, onData, onEvent, i.id).then((info) => {
          const id = ids[k];
          if (info.auditId !== null && id) useTabs.getState().update(id, { auditId: info.auditId });
          return info.ptyId;
        }),
    })),
    { broadcast: list.length > 1 },
  );
  ids.push(...opened);
}

/** Where a server is, for display: its ssh host, or its group. */
export const whereOf = (server: Pick<Server, "host" | "asg">): string => (server.asg ? `ASG ${server.asg.name}` : server.host);
