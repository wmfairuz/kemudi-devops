// When each app last saw activity, for the order of apps in a server's
// Apps view and in the sidebar (most recent first): its latest History row (actions, saves, database changes, fills),
// when its tab was last opened here, and the newest of its deploy and
// config files on the server (from the background checks).
import { useEffect } from "react";
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

export async function loadHistoryActivity() {
  try {
    useAppActivity.setState({ history: await auditAppActivity() });
  } catch {
    // No History: order by the rest.
  }
}

/** Keep History's times fresh while `on` (a view that sorts by them is
 *  shown): now, every 30 s, and whenever an app tab is opened. */
export function useHistoryActivity(on = true) {
  const opened = useAppActivity((s) => s.opened);
  useEffect(() => {
    if (!on) return;
    void loadHistoryActivity();
    const t = window.setInterval(() => void loadHistoryActivity(), 30_000);
    return () => window.clearInterval(t);
  }, [on, opened]);
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

/** Apps, most recent activity first; ones with none keep their order, after.
 *  `changedS`: an app's newest deploy/config file time on the server. */
export function byRecent<A extends { id: string }>(serverId: string, apps: A[], changedS: (id: string) => number | null | undefined, s: ActivityState): A[] {
  return apps
    .map((a, i) => [a, latest(serverId, a.id, changedS(a.id), s)?.at ?? 0, i] as const)
    .sort((x, y) => y[1] - x[1] || x[2] - y[2])
    .map(([a]) => a);
}

// Dev only: a hot-swapped store would be a second, empty copy; reload instead.
import.meta.hot?.accept(() => window.location.reload());
