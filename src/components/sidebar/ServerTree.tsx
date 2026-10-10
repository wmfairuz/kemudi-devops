import { ChevronRight, Plus, SquareTerminal } from "lucide-react";
import { useMemo } from "react";
import { create } from "zustand";

import { EnvTag, StaleBadge, VpnBadge } from "@/components/kit/EnvTag";
import { envBar } from "@/components/kit/env";
import { Glyph, Spinner } from "@/components/kit/Spinner";
import { StatusDot } from "@/components/kit/StatusDot";
import { appMove, errorMessage, type App, type Server } from "@/lib/ipc";
import { findServer } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { toastError, useToasts } from "@/stores/toasts";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/manage/Badge";
import { DiskBadge } from "@/components/monitor/DiskBadge";
import { SslBadge } from "@/components/health/SslBadge";
import { openDetails, useManage } from "@/stores/manage";
import { useSidebar } from "@/stores/sidebar";
import { useStatus } from "@/stores/status";
import { openSsh, useTabs } from "@/stores/tabs";

interface Props {
  servers: Server[];
  stale: boolean;
}

function matches(text: string, q: string) {
  return text.toLowerCase().includes(q);
}

// ------------------------------------------------------------ drag apps

interface Drag {
  serverId: string;
  appId: string;
  name: string;
  x: number;
  y: number;
  /** Where it would land: before `before` on `serverId` (null: the end). */
  over: { serverId: string; before: string | null } | null;
}

const useDrag = create<{ drag: Drag | null }>(() => ({ drag: null }));
/** Set right after a drop, so the row's click that follows is ignored. */
let justDropped = false;

/** Press on an app row and move: drag it (to another place in its server's
 *  list, or onto another server). A plain click still opens it. */
function startDrag(e: React.PointerEvent, server: Server, app: App) {
  if (e.button !== 0 || useSidebar.getState().filter.trim()) return;
  const start = { x: e.clientX, y: e.clientY };
  let dragging = false;
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
    dragging = true;
    document.body.style.userSelect = "none";
    useDrag.setState({ drag: { serverId: server.id, appId: app.id, name: app.name, x: ev.clientX, y: ev.clientY, over: dropAt(ev.clientX, ev.clientY) } });
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.userSelect = "";
    const d = useDrag.getState().drag;
    useDrag.setState({ drag: null });
    if (!dragging || !d) return;
    justDropped = true;
    setTimeout(() => (justDropped = false), 0);
    if (d.over) void drop(d.serverId, d.appId, d.over.serverId, d.over.before);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** The drop target under the pointer: an app row (its upper half: before it;
 *  lower half: before the next one) or a server row (the end of its list). */
function dropAt(x: number, y: number): Drag["over"] {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-server]");
  if (!el) return null;
  const serverId = el.dataset.dropServer!;
  const appId = el.dataset.dropApp;
  if (!appId) return { serverId, before: null };
  const r = el.getBoundingClientRect();
  return { serverId, before: y < r.top + r.height / 2 ? appId : (el.dataset.dropNext ?? null) };
}

async function drop(from: string, appId: string, to: string, before: string | null) {
  const src = findServer(from);
  const dst = findServer(to);
  const app = src?.apps.find((a) => a.id === appId);
  if (!src || !dst || !app) return;
  if (from === to) {
    const ids = src.apps.map((a) => a.id);
    const next = ids[ids.indexOf(appId) + 1] ?? null;
    if (before === appId || before === next) return; // where it already is
  } else if (
    !(await askConfirm(
      `Move ${app.name} to ${dst.name}?`,
      `Only Kemudi's record moves (with its own actions and settings): nothing on ${src.name} or ${dst.name} changes. Its path, vhost and Supervisor files stay as they are, so check they match ${dst.name}.`,
      "Move",
    ))
  ) {
    return;
  }
  try {
    const id = await appMove(from, appId, to, before);
    const sel = useSidebar.getState().selected;
    if (sel?.serverId === from && sel.appId === appId) useSidebar.getState().follow(to, id);
    if (from !== to) {
      if (!useSidebar.getState().expanded[to]) useSidebar.getState().toggle(to);
      useToasts.getState().push(`Moved ${app.name} to ${dst.name}${id !== appId ? ` (as ${id})` : ""}`, "info");
    }
  } catch (e) {
    toastError(errorMessage(e));
  }
}

/** The dragged app's name, following the pointer. */
function DragGhost() {
  const drag = useDrag((s) => s.drag);
  if (!drag) return null;
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-md border border-primary/50 bg-background px-2 py-1 text-[12px] font-medium text-foreground shadow-lg"
      style={{ left: drag.x + 12, top: drag.y + 8 }}
    >
      {drag.name}
    </div>
  );
}

/** Servers → apps → actions (design frame 1a sidebar). */
export function ServerTree({ servers, stale }: Props) {
  const filter = useSidebar((s) => s.filter.trim().toLowerCase());
  const appCount = servers.reduce((n, s) => n + s.apps.length, 0);

  const visible = useMemo(() => {
    if (!filter) return servers.map((s) => ({ server: s, apps: s.apps, forced: false }));
    return servers.flatMap((s) => {
      const serverHit = matches(s.id, filter) || matches(s.name, filter) || matches(s.env, filter);
      const apps = serverHit ? s.apps : s.apps.filter((a) => matches(a.id, filter) || matches(a.name, filter));
      return serverHit || apps.length ? [{ server: s, apps, forced: apps.length > 0 && !serverHit }] : [];
    });
  }, [servers, filter]);

  return (
    <>
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2 text-[11px] font-medium text-subtle-foreground">
        <span>Servers</span>
        <span className="font-mono text-[10.5px] text-faint-foreground">
          {servers.length} · {appCount} app{appCount === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        {stale && <StaleBadge />}
        <AddServerButton />
      </div>
      <div role="tree" className={cn("min-h-0 flex-1 overflow-y-auto pb-2", stale && "opacity-72")}>
        {visible.map(({ server, apps, forced }) => (
          <ServerGroup
            key={server.id}
            server={server}
            apps={apps}
            forceOpen={forced || (!!filter && apps.length > 0)}
          />
        ))}
        <DragGhost />
        {filter && visible.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-subtle-foreground">No servers or apps match “{filter}”.</div>
        )}
      </div>
    </>
  );
}

function statusTitle(s: ReturnType<typeof useStatus.getState>["byServer"][string] | undefined): string {
  if (!s) return "Not checked yet · click to check";
  const what = s.via === "vpn_check" ? "VPN check" : s.via === "jump" ? "jump host" : "TCP";
  const result =
    s.state === "up" ? `up (${s.latencyMs ?? "?"} ms)` : s.state === "checking" ? "checking…" : s.error ?? s.state;
  return `${what} ${s.target ?? ""}: ${result}${s.checkedAt ? ` · ${s.checkedAt}` : ""} · click to re-check`;
}

/** Click: details page (and its actions on the right). Double-click: ssh. */
function ServerGroup({ server, apps, forceOpen }: { server: Server; apps: App[]; forceOpen: boolean }) {
  const expanded = useSidebar((s) => !!s.expanded[server.id]) || forceOpen;
  const toggle = useSidebar((s) => s.toggle);
  const selected = useSidebar((s) => s.selected?.serverId === server.id && s.selected.appId === null);
  const reach = useStatus((s) => s.byServer[server.id]);
  const status = reach?.state ?? "unknown";
  const down = status === "down";
  const dropHere = useDrag((s) => (s.drag?.over?.serverId === server.id ? s.drag.over.before : undefined));
  const dragging = useDrag((s) => !!s.drag);

  return (
    <div className={cn("mx-2 mb-2 flex flex-col gap-0.5", envBar[server.env])}>
      <div
        data-drop-server={server.id}
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={selected}
        title={`${server.name} · ${server.host}\nClick: details · double-click: ssh · right-click: more`}
        onClick={() => {
          openDetails({ kind: "server", serverId: server.id });
          if (!expanded) toggle(server.id);
        }}
        onDoubleClick={() => openShell(server)}
        onContextMenu={(e) => {
          e.preventDefault();
          useManage.getState().setMenu({ x: e.clientX, y: e.clientY, server });
        }}
        className={cn(
          "group flex h-[54px] cursor-default items-center gap-2.5 rounded-lg pr-2 pl-1.5",
          selected ? "bg-accent" : "hover:bg-hover",
          dragging && dropHere === null && "ring-2 ring-primary/60",
        )}
      >
        <button
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            toggle(server.id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          className="-ml-0.5 flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-4 transition-transform duration-150", expanded && "rotate-90")}
            strokeWidth={2.25}
            aria-hidden
          />
        </button>
        <span className="relative flex-none">
          <Badge id={server.id} name={server.name} size={34} className={cn(down && "opacity-55")} />
          <button
            title={statusTitle(reach)}
            onClick={(e) => {
              e.stopPropagation();
              void useStatus.getState().refresh([server.id]);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="absolute -right-1 -bottom-1 flex rounded-full bg-sidebar p-[2px]"
          >
            <StatusDot status={status} />
          </button>
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className={cn("truncate text-[13.5px] font-semibold", down ? "text-dim-foreground" : "text-foreground")}>
              {server.name}
            </span>
            {server.vpn !== "none" && <VpnBadge />}
          </span>
          <span className="mt-0.5 truncate text-[11.5px] text-subtle-foreground">
            {server.host}
            {!expanded && server.apps.length > 0 ? ` · ${server.apps.length} app${server.apps.length === 1 ? "" : "s"}` : ""}
          </span>
        </span>
        <DiskBadge server={server} />
        <SslBadge server={server} />
        <span className="flex flex-none flex-col items-end gap-1">
          <EnvTag env={server.env} />
        </span>
        <ShellButton server={server} />
      </div>
      {expanded &&
        apps.map((app, i) => (
          <AppItem
            key={app.id}
            server={server}
            app={app}
            down={down}
            next={apps[i + 1]?.id ?? null}
            lineAbove={dropHere === app.id}
            lineBelow={dropHere === null && i === apps.length - 1}
          />
        ))}
    </div>
  );
}

function AppItem({
  server,
  app,
  down,
  next,
  lineAbove,
  lineBelow,
}: {
  server: Server;
  app: App;
  down: boolean;
  next: string | null;
  lineAbove: boolean;
  lineBelow: boolean;
}) {
  const lifted = useDrag((s) => s.drag?.serverId === server.id && s.drag.appId === app.id);
  const selected = useSidebar((s) => s.selected?.serverId === server.id && s.selected.appId === app.id);
  // The most recent action tab for this app drives the row's status icon.
  const lastRun = useTabs((s) => {
    for (let i = s.tabs.length - 1; i >= 0; i--) {
      const t = s.tabs[i];
      if (t && t.kind === "action" && t.serverId === server.id && t.appId === app.id) return t.state;
    }
    return null;
  });

  return (
    <div
      id={`app-${server.id}-${app.id}`}
      data-drop-server={server.id}
      data-drop-app={app.id}
      data-drop-next={next ?? undefined}
      onPointerDown={(e) => startDrag(e, server, app)}
      onClickCapture={(e) => {
        if (justDropped) e.stopPropagation();
      }}
      role="treeitem"
      aria-selected={selected}
      title={`${app.name} · ${server.host}:${app.path}\nClick: details · double-click: ssh into it · right-click: more`}
      onClick={() => openDetails({ kind: "app", serverId: server.id, appId: app.id })}
      onDoubleClick={() => openShell(server, app)}
      onContextMenu={(e) => {
        e.preventDefault();
        useManage.getState().setMenu({ x: e.clientX, y: e.clientY, server, app });
      }}
      className={cn(
        "relative flex h-[48px] cursor-default items-center gap-2.5 rounded-lg pr-2 pl-[38px]",
        selected ? "bg-accent" : "hover:bg-hover",
        lifted && "opacity-40",
      )}
    >
      {lineAbove && <span className="pointer-events-none absolute -top-[2px] right-2 left-[38px] h-[3px] rounded bg-primary" />}
      {lineBelow && <span className="pointer-events-none absolute right-2 -bottom-[2px] left-[38px] h-[3px] rounded bg-primary" />}
      <Badge id={`${server.id}/${app.id}`} name={app.name} size={30} className={cn(down && "opacity-55")} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-[13px] font-medium", selected ? "text-foreground" : down ? "text-dim-foreground" : "text-sidebar-foreground")}>
          {app.name}
        </span>
        <span className="mt-0.5 truncate text-[11px] text-subtle-foreground">
          {app.path}
          {app.branch ? ` · ${app.branch}` : ""}
        </span>
      </span>
      {app.env !== server.env && <EnvTag env={app.env} />}
      {lastRun === "running" && <Spinner size={9} />}
      {lastRun === "failed" && <Glyph className="text-term-red">✗</Glyph>}
      <ShellButton server={server} app={app} />
    </div>
  );
}

function openShell(server: Server, app?: App) {
  openSsh(server.host, {
    serverId: server.id,
    prod: (app?.env ?? server.env) === "prod",
    title: app ? `${server.id} · ${app.id}` : `${server.id} · ssh`,
    cwd: app?.path,
    appId: app?.id,
  });
}

export function AddServerButton() {
  return (
    <button
      title="Add server"
      aria-label="Add server"
      onClick={() => openDetails({ kind: "server", serverId: null })}
      className="-my-1 flex size-5 cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
    >
      <Plus className="size-3.5" strokeWidth={2} aria-hidden />
    </button>
  );
}

/** Opens `ssh <host>` in a new tab; for an app it starts in the app's path. */
function ShellButton({ server, app }: { server: Server; app?: App }) {
  const where = app ? `${server.id}:${app.path}` : server.id;
  return (
    <button
      title={`Open a shell on ${where} (ssh ${server.host})`}
      aria-label={`Open a shell on ${where}`}
      onClick={(e) => {
        e.stopPropagation();
        openShell(server, app);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="flex h-5 flex-none cursor-pointer items-center gap-1 rounded-md border border-control-border bg-secondary px-1.5 text-[10.5px] text-soft-foreground shadow-[0_1px_1px_rgb(0_0_0/0.08)] transition-colors hover:border-primary/60 hover:bg-hover-strong hover:text-foreground active:translate-y-px"
    >
      <SquareTerminal className="size-3" strokeWidth={1.75} aria-hidden />
      ssh
    </button>
  );
}
