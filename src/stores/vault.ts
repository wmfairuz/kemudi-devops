// Saved passwords (names only; values stay in Rust) and filling one into a
// terminal at its password prompt.
import { create } from "zustand";

import { errorMessage, vaultCopy, vaultDelete, vaultFill, vaultList, vaultSave, type VaultEntry, type VaultEntryInput } from "@/lib/ipc";
import type { PasswordPrompt } from "@/lib/terminalSession";
import type { Tab } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

interface VaultState {
  entries: VaultEntry[];
  loaded: boolean;
  error: string | null;
  /** The Fill picker, for this tab. */
  picker: Tab | null;
  openPicker(tab: Tab): void;
  closePicker(): void;
  load(): Promise<void>;
  save(input: VaultEntryInput): Promise<string | null>;
  remove(id: string): Promise<void>;
}

export const useVault = create<VaultState>((set, get) => ({
  entries: [],
  loaded: false,
  error: null,
  picker: null,
  openPicker: (picker) => {
    set({ picker });
    if (!get().loaded) void get().load();
  },
  closePicker: () => set({ picker: null }),
  async load() {
    try {
      set({ entries: await vaultList(), loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: errorMessage(e) });
    }
  },
  async save(input) {
    try {
      const id = await vaultSave(input);
      await get().load();
      return id;
    } catch (e) {
      toastError(errorMessage(e));
      return null;
    }
  },
  async remove(id) {
    try {
      await vaultDelete(id);
      await get().load();
    } catch (e) {
      toastError(errorMessage(e));
    }
  },
}));

/** Entries that fit the prompt best come first: the server's sudo password at
 *  a sudo prompt, the ssh user / host at an ssh login. */
export function suggested(entries: VaultEntry[], tab: Tab | null, prompt: PasswordPrompt): VaultEntry[] {
  const score = (e: VaultEntry) => {
    let n = 0;
    if (tab?.serverId && e.sudoFor.includes(tab.serverId)) n += prompt?.kind === "sudo" ? 4 : 1;
    if (prompt?.kind === "login") {
      const hay = `${e.name} ${e.username} ${e.notes}`.toLowerCase();
      if (prompt.host && hay.includes(prompt.host.toLowerCase())) n += 3;
      if (prompt.user && e.username === prompt.user) n += 2;
    }
    if (tab?.serverId && e.name.toLowerCase().includes(tab.serverId.toLowerCase())) n += 1;
    return n;
  };
  return entries
    .map((e) => [e, score(e)] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([e]) => e);
}

/** Type a saved password into the tab (the user picked it). */
export async function fillPassword(tab: Tab, entry: VaultEntry): Promise<void> {
  const ptyId = tab.session.ptyId;
  if (ptyId === null) {
    useToasts.getState().push("This tab isn't running", "info");
    return;
  }
  try {
    await vaultFill(ptyId, entry.id, tab.serverId ?? null);
    tab.session.clearPasswordPrompt();
    tab.session.focus();
  } catch (e) {
    toastError(errorMessage(e));
  }
}

export async function copyPassword(entry: VaultEntry): Promise<void> {
  try {
    const secs = await vaultCopy(entry.id);
    useToasts.getState().push(`Copied “${entry.name}” · clears in ${secs} s`, "info");
  } catch (e) {
    toastError(errorMessage(e));
  }
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
