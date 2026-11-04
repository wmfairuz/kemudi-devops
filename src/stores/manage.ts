// The details page for a server or app (Querious-style, in the main area)
// and the right-click menu on sidebar rows.
import { create } from "zustand";

import { errorMessage, serverDuplicate, type App, type Server } from "@/lib/ipc";
import { useConfig } from "@/stores/config";
import { toastError, useToasts } from "@/stores/toasts";
import { useSidebar } from "@/stores/sidebar";
import { openServer, previewServer, useTabs } from "@/stores/tabs";

/** What the details page shows; a null id means "new". */
export type DetailsTarget =
  | { kind: "server"; serverId: string | null }
  | { kind: "app"; serverId: string; appId: string | null };

export interface EntityMenu {
  x: number;
  y: number;
  server: Server;
  app?: App;
}

interface ManageState {
  details: DetailsTarget | null;
  menu: EntityMenu | null;
  setMenu(menu: EntityMenu | null): void;
  /** The server whose Discover apps dialog is open. */
  discover: string | null;
  setDiscover(serverId: string | null): void;
}

export const useManage = create<ManageState>(() => ({
  details: null,
  menu: null,
  setMenu: (menu) => useManage.setState({ menu }),
  discover: null,
  setDiscover: (discover) => useManage.setState({ discover, menu: null }),
}));

/** Show an app's details (or a blank server or app to add) in the main
 *  area. A server's settings are its tab's Settings section. */
export function openDetails(target: DetailsTarget): void {
  if (target.serverId) useSidebar.getState().select(target.serverId, target.kind === "app" ? target.appId : null);
  if (target.kind === "server" && target.serverId) {
    useManage.setState({ menu: null });
    whenServer(target.serverId, (server) => openServer(server, "settings"));
    return;
  }
  useManage.setState({ details: target, menu: null });
  useTabs.getState().openDetails();
}

/** A plain click on a server in the sidebar: its tab (a preview tab when it
 *  has none). */
export function showServer(server: Server): void {
  useManage.setState({ menu: null });
  useSidebar.getState().select(server.id, null);
  previewServer(server);
}

/** `run` with the server once the config has it (one just added or
 *  duplicated may not be loaded yet); nothing after 5 s. */
function whenServer(id: string, run: (server: Server) => void): void {
  const find = () => useConfig.getState().snapshot?.config?.servers.find((s) => s.id === id);
  const now = find();
  if (now) return run(now);
  const stop = useConfig.subscribe(() => {
    const s = find();
    if (!s) return;
    stop();
    clearTimeout(timer);
    run(s);
  });
  const timer = setTimeout(stop, 5000);
}

/** Kemudi's key for something new, from its name: `slug(name)` (else
 *  `fallback`), with -2, -3… when it's taken. Never shown in forms. */
export function freeId(name: string, taken: string[], fallback: string): string {
  const base = slug(name) || fallback;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

/** Copy a server (its connection, apps and actions) as "<name> copy" right
 *  after it, then open the copy to change what differs (its group, profile,
 *  host…). */
export async function duplicateServer(server: Server): Promise<void> {
  const taken = useConfig.getState().snapshot?.config?.servers.map((s) => s.id) ?? [];
  const name = `${server.name} copy`;
  const id = freeId(name, taken, "server");
  try {
    await serverDuplicate(server.id, id, name);
    useToasts.getState().push(`Duplicated ${server.name}: change what differs, then Save`, "info");
    openDetails({ kind: "server", serverId: id });
  } catch (e) {
    toastError(errorMessage(e));
  }
}

/** Lower-case id from a display name: "NovaOS Staging" → "novaos-staging". */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "")
    .slice(0, 64);
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
