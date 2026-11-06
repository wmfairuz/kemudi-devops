// When each app last saw activity, for the Apps view's order (most recent
// first): its latest History row (actions, saves, database changes, fills),
// when its tab was last opened here, and the newest of its deploy and
// config files on the server (from the background checks).
import { create } from "zustand";

import { auditAppActivity } from "@/lib/ipc";

const KEY = "kemudi.appOpened";

function readOpened(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

interface ActivityState {
  /** "server/app" → ms its tab was last opened. */
  opened: Record<string, number>;
  /** server → app → ms of its latest History row. */
  history: Record<string, Record<string, number>>;
}

export const useAppActivity = create<ActivityState>(() => ({ opened: readOpened(), history: {} }));

/** Its tab was opened (or brought to the front). */
export function markOpened(serverId: string, appId: string) {
  const opened = { ...useAppActivity.getState().opened, [`${serverId}/${appId}`]: Date.now() };
  useAppActivity.setState({ opened });
  try {
    localStorage.setItem(KEY, JSON.stringify(opened));
  } catch {
    // Kept while the app runs, then.
  }
}

export async function loadHistoryActivity(serverId: string) {
  try {
    const got = await auditAppActivity(serverId);
    useAppActivity.setState((s) => ({ history: { ...s.history, [serverId]: got } }));
  } catch {
    // No History: order by the rest.
  }
}

export type Activity = { at: number; what: string } | null;

/** An app's latest activity (ms), and what it was. */
export function latest(serverId: string, appId: string, changedS: number | null | undefined, s: ActivityState): Activity {
  const all: [number | undefined, string][] = [
    [s.history[serverId]?.[appId], "in History"],
    [s.opened[`${serverId}/${appId}`], "opened here"],
    [changedS ? changedS * 1000 : undefined, "changed on the server (deploy, .env or composer)"],
  ];
  let best: Activity = null;
  for (const [at, what] of all) if (at && (!best || at > best.at)) best = { at, what };
  return best;
}

// Dev only: a hot-swapped store would be a second, empty copy; reload instead.
import.meta.hot?.accept(() => window.location.reload());
