// One "Are you sure?" dialog for destructive menu items.
import { create } from "zustand";

interface Ask {
  title: string;
  message: string;
  confirm: string;
  resolve: (ok: boolean) => void;
}

export const useConfirm = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** Resolves true when the user confirms. */
export function askConfirm(title: string, message: string, confirm = "Delete"): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ ask: { title, message, confirm, resolve } }));
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
