// Live reachability per server (sidebar dots, VPN gate).
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { create } from "zustand";

import { STATUS_CHANGED, statusGet, statusRefresh, type ReachState, type ServerStatus } from "@/lib/ipc";

interface StatusState {
  byServer: Record<string, ServerStatus>;
  init(): () => void;
  refresh(serverIds?: string[]): Promise<ServerStatus[]>;
}

export const useStatus = create<StatusState>((set, get) => ({
  byServer: {},
  init() {
    const put = (s: ServerStatus) => set((st) => ({ byServer: { ...st.byServer, [s.serverId]: s } }));
    void statusGet().then((all) => all.forEach(put), () => {});
    const unlisten = listen<ServerStatus>(STATUS_CHANGED, (e) => put(e.payload));
    // Re-probe when the window comes back to the front (VPN may have changed).
    let last = 0;
    const unfocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused && Date.now() - last > 5000) {
        last = Date.now();
        void get().refresh();
      }
    });
    return () => {
      void unlisten.then((f) => f());
      void unfocus.then((f) => f());
    };
  },
  refresh: (serverIds) => statusRefresh(serverIds).catch(() => []),
}));

export function reachOf(serverId: string): ReachState {
  return useStatus.getState().byServer[serverId]?.state ?? "unknown";
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
