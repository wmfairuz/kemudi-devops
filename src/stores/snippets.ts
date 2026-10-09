// Command snippets (the Snippets tab of the right panel), saved by the
// backend to ~/.config/kemudi/snippets.yaml.
import { create } from "zustand";

import { errorMessage, snippetDelete, snippetSave, snippetsList, type Snippet, type SnippetInput } from "@/lib/ipc";
import { askConfirm } from "@/stores/confirm";
import { activeTab, useTabs } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

interface SnippetsState {
  list: Snippet[];
  loaded: boolean;
  /** snippets.yaml couldn't be read (it is then never overwritten). */
  error: string | null;
  /** The snippet open in the editor ("new" for a blank one, with an
   *  optional starting command). */
  /** The form: a snippet to edit, or a new one (maybe filled in: from a terminal, or Duplicate). */
  editing: Snippet | { id: null; command?: string; name?: string; notes?: string; team?: string | null } | null;
  setEditing(s: SnippetsState["editing"]): void;
  load(): Promise<void>;
  save(input: SnippetInput): Promise<boolean>;
  remove(id: string): Promise<void>;
}

export const useSnippets = create<SnippetsState>((set) => ({
  list: [],
  loaded: false,
  error: null,
  editing: null,
  setEditing: (editing) => set({ editing }),
  async load() {
    try {
      set({ list: await snippetsList(), loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: errorMessage(e) });
    }
  },
  async save(input) {
    try {
      set({ list: await snippetSave(input), error: null });
      return true;
    } catch (e) {
      toastError(errorMessage(e));
      return false;
    }
  },
  async remove(id) {
    try {
      set({ list: await snippetDelete(id) });
    } catch (e) {
      toastError(errorMessage(e));
    }
  },
}));

/** Type a snippet into the terminal in front: at the prompt, waiting for ↵,
 *  or (`run`) entered right away; a production tab asks first. */
export async function insertSnippet(s: Snippet, { run = false }: { run?: boolean } = {}): Promise<void> {
  const tab = activeTab(useTabs.getState());
  if (!tab || tab.session.status !== "running") {
    useToasts.getState().push("Open a terminal tab first, then insert the snippet there", "info");
    return;
  }
  if (run && tab.prod) {
    const ok = await askConfirm(
      `Run “${s.name}” on production?`,
      `In ${tab.title}:\n\n${s.command}`,
      "Run",
    );
    if (!ok) return;
  }
  tab.session.paste(s.command, { submit: run });
  tab.session.focus();
}

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
