// One "Are you sure?" dialog for destructive menu items.
import { create } from "zustand";

interface Ask {
  title: string;
  message: string;
  confirm: string;
  /** The other button (default Cancel). */
  cancel?: string;
  /** Confirm isn't dangerous (not red). */
  plain?: boolean;
  /** `typed`: what was typed (askText). */
  resolve: (ok: boolean, typed?: string) => void;
  /** A text to type (askText): its starting value and suggestions. */
  input?: { value: string; suggestions?: string[]; placeholder?: string };
}

export const useConfirm = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** Resolves true when the user confirms. */
export function askConfirm(title: string, message: string, confirm = "Delete"): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ ask: { title, message, confirm, resolve } }));
}

/** Two ways forward (e.g. Replace / Keep mine): true for `confirm`,
 *  false for `cancel` (also esc). */
export function askChoice(title: string, message: string, confirm: string, cancel: string): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ ask: { title, message, confirm, cancel, plain: true, resolve } }));
}

/** A name to type (rename, new group…): the text, or null if cancelled. */
export function askText(title: string, message: string, confirm: string, value = "", suggestions: string[] = [], placeholder = ""): Promise<string | null> {
  return new Promise((resolve) =>
    useConfirm.setState({
      ask: {
        title,
        message,
        confirm,
        input: { value, suggestions, placeholder },
        resolve: (ok, typed) => resolve(ok ? (typed ?? value).trim() || null : null),
      },
    }),
  );
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
