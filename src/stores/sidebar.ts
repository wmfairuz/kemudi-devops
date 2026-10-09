// Sidebar tree state: which servers are expanded and which app is selected.
// Persisted per machine so the tree looks the same after a restart.
import { create } from "zustand";

const KEY = "kemudi.sidebar";

interface Persisted {
  expanded: Record<string, boolean>;
  /** The app (or, with appId null, the server) the Actions panel shows. */
  selected: { serverId: string; appId: string | null } | null;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Persisted;
  } catch {
    // Corrupt or unavailable storage: start fresh.
  }
  return { expanded: {}, selected: null };
}

interface SidebarState extends Persisted {
  filter: string;
  setFilter(filter: string): void;
  toggle(serverId: string): void;
  select(serverId: string, appId: string | null): void;
  /** Expand, select and scroll to an app (palette). */
  reveal(serverId: string, appId: string): void;
}

export const useSidebar = create<SidebarState>((set, get) => {
  const save = () => {
    const { expanded, selected } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ expanded, selected }));
    } catch {
      // Not persisted; fine.
    }
  };
  return {
    ...load(),
    filter: "",
    setFilter: (filter) => set({ filter }),
    toggle(serverId) {
      set((s) => ({ expanded: { ...s.expanded, [serverId]: !s.expanded[serverId] } }));
      save();
    },
    reveal(serverId, appId) {
      set((s) => ({ expanded: { ...s.expanded, [serverId]: true }, selected: { serverId, appId }, filter: "" }));
      save();
      requestAnimationFrame(() =>
        document.getElementById(`app-${serverId}-${appId}`)?.scrollIntoView({ block: "nearest" }),
      );
    },
    select(serverId, appId) {
      set({ selected: { serverId, appId } });
      save();
    },
  };
});

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
