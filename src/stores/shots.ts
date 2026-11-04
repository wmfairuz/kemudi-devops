// Pictures of apps (their URL's front page, taken by headless Chrome on this
// Mac, src-tauri/src/shots.rs): the Apps section's Pictures view. Kept ones
// load first; missing or day-old ones are taken one at a time.
import { create } from "zustand";

import { appShot, appShotTake, errorMessage, type Shot } from "@/lib/ipc";

export type ShotEntry = { shot?: Shot; busy?: boolean; error?: string };

/** A picture is taken again when it's older than this (or its URL changed). */
const KEEP = 7 * 24 * 60 * 60;

export const useShots = create<{ map: Record<string, ShotEntry> }>(() => ({ map: {} }));

export const shotKey = (serverId: string, appId: string) => `${serverId}/${appId}`;

const put = (k: string, e: ShotEntry) => useShots.setState((s) => ({ map: { ...s.map, [k]: { ...s.map[k], ...e } } }));

const read = new Set<string>();
let queue: Promise<void> = Promise.resolve();

/** Takes a new picture of an app (queued: one browser at a time). */
export function takeShot(serverId: string, appId: string) {
  const k = shotKey(serverId, appId);
  if (useShots.getState().map[k]?.busy) return;
  put(k, { busy: true, error: undefined });
  queue = queue.then(async () => {
    try {
      put(k, { shot: await appShotTake(serverId, appId), busy: false });
    } catch (e) {
      put(k, { busy: false, error: errorMessage(e) });
    }
  });
}

/** Loads the kept pictures of a server's apps, then takes the ones missing,
 *  older than a week or of another URL (all of them with `again`). One that
 *  failed isn't tried again until asked. */
export async function loadShots(serverId: string, apps: { id: string; url?: string | null }[], again = false) {
  const withUrl = apps.filter((a) => a.url);
  await Promise.all(
    withUrl.map(async (a) => {
      const k = shotKey(serverId, a.id);
      if (read.has(k)) return;
      read.add(k);
      try {
        const shot = await appShot(serverId, a.id);
        if (shot) put(k, { shot });
      } catch {
        // Taken below.
      }
    }),
  );
  const now = Date.now() / 1000;
  for (const a of withUrl) {
    const e = useShots.getState().map[shotKey(serverId, a.id)];
    if (e?.busy) continue;
    if (!again && e?.error) continue;
    if (again || !e?.shot || e.shot.url !== a.url || now - e.shot.at > KEEP) takeShot(serverId, a.id);
  }
}
