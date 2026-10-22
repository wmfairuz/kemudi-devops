// Which workflow the editor / run dialog is open for.
import { create } from "zustand";

import type { Workflow } from "@/lib/ipc";

/** A run someone else asked for (Claude, over MCP): told whether you ran
 *  it (and which tab) or not. */
export interface RunRequest {
  by: string;
  start(tabId: string): void;
  cancel(): void;
}

interface WorkflowsState {
  /** The editor: a workflow, or a new one (optionally pinned). */
  editing: { workflow: Workflow | null; pin?: { server: string; app: string | null }; copyOf?: Workflow } | null;
  /** The run dialog, starting at step `from` (1-based). */
  running: { id: string; from: number; request?: RunRequest } | null;
  /** The run open (expanded) in the Workflows tab's runs column: a run's
   *  group id, or `a<audit id>` for an earlier one. */
  expanded: string | null;
  edit(workflow: Workflow | null, pin?: { server: string; app: string | null }): void;
  /** A new workflow starting as a copy of `w` (saved only on Add). */
  duplicate(w: Workflow): void;
  run(id: string, from?: number, request?: RunRequest): void;
  close(): void;
  expand(id: string | null): void;
}

export const useWorkflows = create<WorkflowsState>((set, get) => {
  // The run dialog going away without Run: an asked-for run wasn't run.
  const leaving = () => get().running?.request?.cancel();
  return {
    editing: null,
    running: null,
    expanded: null,
    expand: (expanded) => set({ expanded }),
    edit: (workflow, pin) => {
      leaving();
      set({ editing: { workflow, pin }, running: null });
    },
    duplicate: (w) => {
      leaving();
      set({ editing: { workflow: null, copyOf: w }, running: null });
    },
    run: (id, from = 1, request) => {
      leaving();
      set({ running: { id, from, request }, editing: null });
    },
    close: () => {
      leaving();
      set({ editing: null, running: null });
    },
  };
});

import.meta.hot?.accept(() => window.location.reload());
