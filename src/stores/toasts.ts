import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  tone: "error" | "info";
  /** A button on the toast (e.g. "Show in Finder"). */
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  push(message: string, tone?: Toast["tone"], action?: Toast["action"]): void;
  dismiss(id: number): void;
}

let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(message, tone = "error", action) {
    const id = next++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, tone, action }] }));
    setTimeout(() => get().dismiss(id), tone === "error" || action ? 8000 : 4000);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const toastError = (message: string) => useToasts.getState().push(message, "error");

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
