// Which action dialog is open (preview / prod confirm / danger confirm / VPN).
import { create } from "zustand";

import type { RenderedAction, ServerStatus } from "@/lib/ipc";

export type FlowDialog = "preview" | "prodConfirm" | "dangerConfirm" | "vpn";

interface FlowState {
  dialog: FlowDialog | null;
  action: RenderedAction | null;
  /** Starting command when it differs from servers.yaml (History re-run). */
  command: string | null;
  /** For the VPN dialog: the failed probe. */
  status: ServerStatus | null;
  /** For the VPN dialog: re-run the click once reachable. */
  retry: (() => void) | null;
  /** Open with the command already editable (Edit command / ⌥-click). */
  edit: boolean;
  show(
    dialog: FlowDialog,
    action: RenderedAction,
    extra?: Partial<Pick<FlowState, "command" | "status" | "retry" | "edit">>,
  ): void;
  close(): void;
}

export const useActionFlow = create<FlowState>((set) => ({
  dialog: null,
  action: null,
  command: null,
  status: null,
  retry: null,
  edit: false,
  show: (dialog, action, extra = {}) =>
    set({
      dialog,
      action,
      command: extra.command ?? null,
      status: extra.status ?? null,
      retry: extra.retry ?? null,
      edit: extra.edit ?? false,
    }),
  close: () => set({ dialog: null }),
}));

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
