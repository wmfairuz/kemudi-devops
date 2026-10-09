// The details page for a server or app (Querious-style, in the main area)
// and the right-click menu on sidebar rows.
import { create } from "zustand";

import type { App, Server } from "@/lib/ipc";
import { useSidebar } from "@/stores/sidebar";
import { useTabs } from "@/stores/tabs";

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

/** Show a server's/app's details (or a blank one to add) in the main area. */
export function openDetails(target: DetailsTarget): void {
  useManage.setState({ details: target, menu: null });
  if (target.serverId) useSidebar.getState().select(target.serverId, target.kind === "app" ? target.appId : null);
  useTabs.getState().openDetails();
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
