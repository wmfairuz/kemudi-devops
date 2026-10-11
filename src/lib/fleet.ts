// AWS Auto Scaling group servers: their running instances are looked up
// when used, and each gets a Session Manager pane in one tab, with Type in
// all panes on (⌥⌘I), so one command or answer goes to all of them.
import { blockIntro } from "@/lib/actions";
import { localHms } from "@/lib/time";
import {
  actionRun,
  asgInstances,
  errorMessage,
  type App,
  type Asg,
  type Database,
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
export async function lookUp(server: Server): Promise<Instance[] | null> {
  try {
    const list = await asgInstances(server.id);
    if (list.length === 0) {
      toastError(`${server.name}: no running instances${server.asg ? ` (${targetOf(server.asg)})` : ""}`);
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
export async function openAsgShells(server: Server, app?: App | null, dir?: string): Promise<void> {
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
      cwd: dir ?? app?.path,
      prod,
      spawn: ptySpawner({ kind: "ssm", serverId: server.id, instance: i.id, cwd: dir ?? app?.path }),
    })),
    { broadcast: list.length > 1 },
  );
  if (list.length > 1) {
    useToasts.getState().push(`${list.length} instances of ${server.name}: typing goes to all of them (⌥⌘I to stop).`, "info");
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
export const whereOf = (server: Pick<Server, "host" | "asg">): string => (server.asg ? targetOf(server.asg) : server.host);

/** An AWS server's target: `ASG name`, or its fixed instances. */
export function targetOf(asg: Asg): string {
  if (asg.instances.length === 0) return `ASG ${asg.name}`;
  return asg.instances.length === 1 ? (asg.instances[0] ?? "") : `${asg.instances.length} EC2 instances`;
}

/** A shell on one instance (in the app's folder for an app). */
export function openInstanceShell(server: Server, instance: Instance, app?: App | null): void {
  useTabs.getState().open({
    kind: "ssh",
    title: `${app?.name ?? server.name} · ${instanceLabel(instance)}`,
    serverId: server.id,
    instance: instance.id,
    appId: app?.id,
    cwd: app?.path,
    prod: (app?.env ?? server.env) === "prod",
    spawn: ptySpawner({ kind: "ssm", serverId: server.id, instance: instance.id, cwd: app?.path }),
  });
}

/** Forward 127.0.0.1:`localPort` to a database through an instance, in a
 *  tab of its own (close it, or Ctrl+C, to stop). */
export function openForward(server: Server, instance: Instance, db: Database, localPort: number): void {
  const client = /postgres/i.test(db.engine ?? "") ? `psql -h 127.0.0.1 -p ${localPort}` : `mysql -h 127.0.0.1 -P ${localPort} -u …`;
  useTabs.getState().open({
    kind: "action",
    title: `${server.name} · ${db.id} → :${localPort}`,
    serverId: server.id,
    instance: instance.id,
    actionId: "forward",
    local: true,
    prod: server.env === "prod",
    state: "running",
    intro: blockIntro(
      `${db.id} on 127.0.0.1:${localPort} (through ${instanceLabel(instance)}) · ${localHms()}`,
      `# ${db.host}:${db.port} → 127.0.0.1:${localPort}; connect with: ${client}\n# close this tab (or Ctrl+C) to stop`,
    ),
    spawn: ptySpawner({ kind: "ssmForward", serverId: server.id, instance: instance.id, host: db.host, port: db.port, localPort }),
  });
}

/** The name in `names` that best fits `hint` (e.g. a server's name): the
 *  only one, else the one sharing the most words with it (none on a tie or
 *  no match). Words like asg/aws/app/db don't count. */
export function bestMatch(hint: string, names: string[]): string | null {
  if (names.length === 1) return names[0]!;
  const noise = new Set(["asg", "aws", "app", "db", "rds", "server", "mysql", "postgres", "staging", "prod", "qa", "dev"]);
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !noise.has(w)));
  const mine = words(hint);
  const scored = names.map((n) => ({ n, k: [...words(n)].filter((w) => mine.has(w)).length })).sort((a, b) => b.k - a.k);
  const [best, next] = scored;
  return best && best.k > 0 && best.k !== next?.k ? best.n : null;
}
