// Asking for an action's own template variables (`{{ ip }}`) before it runs.
import { create } from "zustand";

import type { ActionRef, RenderedAction } from "@/lib/ipc";

interface Ask {
  action: RenderedAction;
  initial: Record<string, string>;
  resolve: (values: Record<string, string> | null) => void;
}

export const useParams = create<{ ask: Ask | null }>(() => ({ ask: null }));

const KEY = "kemudi.params";

/** Values that look like secrets are never remembered. */
export const isSecret = (name: string) => /pass|secret|token|key/i.test(name);

const keyOf = (r: ActionRef) => `${r.serverId}/${r.appId ?? ""}/${r.actionId}`;

function remembered(): Record<string, Record<string, string>> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function remember(r: ActionRef, values: Record<string, string>) {
  try {
    const all = remembered();
    all[keyOf(r)] = Object.fromEntries(Object.entries(values).filter(([k]) => !isSecret(k)));
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Not remembering is fine.
  }
}

/** Resolves the values to run with, or null when cancelled. Starts from the
 *  values given, else the last ones used for this action. */
export function askParams(action: RenderedAction): Promise<Record<string, string> | null> {
  const last = remembered()[keyOf(action)] ?? {};
  const initial: Record<string, string> = {};
  for (const p of action.params) initial[p.name] = action.values?.[p.name] ?? last[p.name] ?? "";
  return new Promise((resolve) =>
    useParams.setState({
      ask: {
        action,
        initial,
        resolve: (values) => {
          if (values) remember(action, values);
          resolve(values);
        },
      },
    }),
  );
}

import.meta.hot?.accept(() => window.location.reload());
