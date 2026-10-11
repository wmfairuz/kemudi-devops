// AWS servers' dialogs: pick one instance for a shell, and forward a
// database port.
import { create } from "zustand";

import type { App, Server } from "@/lib/ipc";

interface FleetUiState {
  pick: { server: Server; app: App | null } | null;
  forward: Server | null;
  openPick(server: Server, app?: App | null): void;
  openForward(server: Server): void;
  close(): void;
}

export const useFleetUi = create<FleetUiState>((set) => ({
  pick: null,
  forward: null,
  openPick: (server, app = null) => set({ pick: { server, app }, forward: null }),
  openForward: (server) => set({ forward: server, pick: null }),
  close: () => set({ pick: null, forward: null }),
}));

import.meta.hot?.accept(() => window.location.reload());
