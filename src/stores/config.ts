// servers.yaml as last loaded by the backend; updated live on file changes.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { CONFIG_CHANGED, configGet, errorMessage, type ConfigSnapshot, type Server } from "@/lib/ipc";

interface ConfigState {
  snapshot: ConfigSnapshot | null;
  loadError: string | null;
  init(): () => void;
}

export const useConfig = create<ConfigState>((set) => ({
  snapshot: null,
  loadError: null,
  init() {
    configGet().then(
      (snapshot) => set({ snapshot, loadError: null }),
      (e) => set({ loadError: errorMessage(e) }),
    );
    const unlisten = listen<ConfigSnapshot>(CONFIG_CHANGED, (e) => set({ snapshot: e.payload, loadError: null }));
    return () => void unlisten.then((f) => f());
  },
}));

export function findServer(id: string): Server | undefined {
  return useConfig.getState().snapshot?.config?.servers.find((s) => s.id === id);
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
