// Transient UI state: which overlay is open, sidebar width, terminal search.
import { create } from "zustand";

const SIDEBAR_KEY = "kemudi.sidebarWidth";
const PANEL_KEY = "kemudi.actionsPanel";
const PANEL_TAB_KEY = "kemudi.panelTab";

export type PanelTab = "actions" | "snippets";

function storedPanelTab(): PanelTab {
  try {
    return localStorage.getItem(PANEL_TAB_KEY) === "snippets" ? "snippets" : "actions";
  } catch {
    return "actions";
  }
}

function storedPanel(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}
// Menlo is wider than a proportional UI font, so the sidebar is too.
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 460;
const SIDEBAR_DEFAULT = 300;

function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_KEY));
    return n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : SIDEBAR_DEFAULT;
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

import type { ActionRef, Confirm, Env } from "@/lib/ipc";

export type Overlay = "none" | "ssh" | "environment" | "palette" | "settings" | "passwords";

/** Right-click menu on an action button (for that one action). */
export interface ActionMenu {
  x: number;
  y: number;
  ref: ActionRef;
  label: string;
  title: string;
  line: number | null;
  env: Env;
  danger: boolean;
  /** Explicit `confirm:` (null = default). */
  confirm: Confirm | null;
  /** Command from the shared list / id in the shared list. */
  shared: boolean;
  inherited: boolean;
  /** From this team's shared list. */
  team?: string | null;
}

interface UiState {
  overlay: Overlay;
  searchOpen: boolean;
  sidebarWidth: number;
  actionMenu: ActionMenu | null;
  setActionMenu(menu: ActionMenu | null): void;
  /** The action open in the command editor (right-click → Edit command…). */
  editAction: ActionMenu | null;
  setEditAction(action: ActionMenu | null): void;
  setOverlay(overlay: Overlay): void;
  setSearchOpen(open: boolean): void;
  setSidebarWidth(width: number): void;
  /** The right-hand Actions panel (⌘J). */
  actionsPanel: boolean;
  toggleActionsPanel(): void;
  /** Which tab the right-hand panel shows. */
  panelTab: PanelTab;
  setPanelTab(tab: PanelTab): void;
  /** Add-action form, for this scope. */
  addAction: AddActionTarget | null;
  setAddAction(v: UiState["addAction"]): void;
}

export interface AddActionTarget {
  scope: import("@/lib/ipc").ActionScope;
  title: string;
  env: Env | null;
  /** Start with this name and command (Make action from a snippet, Duplicate). */
  prefill?: { label: string; run: string; danger?: boolean };
  /** Let the form pick where it goes (the first is `scope`). */
  choices?: { scope: import("@/lib/ipc").ActionScope; label: string; title: string; env: Env | null }[];
  /** The snippet it came from (offered to delete once added). */
  fromSnippet?: string;
}

export const useUi = create<UiState>((set) => ({
  panelTab: storedPanelTab(),
  setPanelTab: (panelTab) => {
    try {
      localStorage.setItem(PANEL_TAB_KEY, panelTab);
    } catch {
      // Not persisted; fine.
    }
    set({ panelTab, actionsPanel: true });
  },
  overlay: "none",
  searchOpen: false,
  sidebarWidth: storedWidth(),
  actionsPanel: storedPanel(),
  toggleActionsPanel: () =>
    set((s) => {
      try {
        localStorage.setItem(PANEL_KEY, s.actionsPanel ? "closed" : "open");
      } catch {
        // Not persisted; fine.
      }
      return { actionsPanel: !s.actionsPanel };
    }),
  addAction: null,
  setAddAction: (addAction) => set({ addAction }),
  actionMenu: null,
  setActionMenu: (actionMenu) => set({ actionMenu }),
  editAction: null,
  setEditAction: (editAction) => set({ editAction }),
  setOverlay: (overlay) => set({ overlay }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSidebarWidth: (width) => {
    const w = Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width)));
    try {
      localStorage.setItem(SIDEBAR_KEY, String(w));
    } catch {
      // Storage unavailable: width just won't persist.
    }
    set({ sidebarWidth: w });
  },
}));

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
