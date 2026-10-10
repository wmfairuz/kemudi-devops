// Which workflow the editor / run dialog is open for.
import { create } from "zustand";

import type { Workflow } from "@/lib/ipc";

interface WorkflowsState {
  /** The editor: a workflow, or a new one (optionally pinned). */
  editing: { workflow: Workflow | null; pin?: { server: string; app: string | null } } | null;
  /** The run dialog, starting at step `from` (1-based). */
  running: { id: string; from: number } | null;
  edit(workflow: Workflow | null, pin?: { server: string; app: string | null }): void;
  run(id: string, from?: number): void;
  close(): void;
}

export const useWorkflows = create<WorkflowsState>((set) => ({
  editing: null,
  running: null,
  edit: (workflow, pin) => set({ editing: { workflow, pin }, running: null }),
  run: (id, from = 1) => set({ running: { id, from }, editing: null }),
  close: () => set({ editing: null, running: null }),
}));

import.meta.hot?.accept(() => window.location.reload());
