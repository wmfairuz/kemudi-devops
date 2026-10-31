// What the background checks found (src-tauri/src/watch.rs): Home's Needs
// attention and fleet grid, the server tab's Overview and the sidebar's
// attention badge. Rust does the checking and keeps the results; this
// listens, and sends a macOS notification once when something turns urgent.
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  appQuiet,
  WATCH_CHANGED,
  watchGet,
  watchRefresh,
  watchSettingsGet,
  watchSettingsSet,
  watchSnooze,
  type WatchItem,
  type WatchSettings,
  type WatchSnapshot,
} from "@/lib/ipc";
import { notify } from "@/lib/notify";
import { useConfig } from "@/stores/config";

const NOTIFIED_KEY = "kemudi.watch.notified";

interface WatchState {
  snapshot: WatchSnapshot | null;
  settings: WatchSettings | null;
  init(): () => void;
  /** Check now (these servers, or all). */
  refresh(serverIds?: string[]): Promise<void>;
  snooze(key: string, days: number): Promise<void>;
  saveSettings(s: WatchSettings): Promise<void>;
}

/** Urgent items already notified (kept across launches: the results are). */
function loadNotified(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveNotified(keys: Set<string>) {
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...keys]));
  } catch {
    // Not kept; at worst one notification again after a restart.
  }
}

let quiet = true;
void appQuiet().then((q) => (quiet = q), () => {});
const notified = loadNotified();

function notifyNew(items: WatchItem[], settings: WatchSettings | null) {
  const urgent = items.filter((i) => i.severity === "urgent" && !i.snoozedUntil);
  const now = new Set(urgent.map((i) => i.key));
  let changed = false;
  // Fixed ones are forgotten, so they notify again if they come back.
  for (const k of notified)
    if (!now.has(k)) {
      notified.delete(k);
      changed = true;
    }
  for (const i of urgent) {
    if (notified.has(i.key)) continue;
    notified.add(i.key);
    changed = true;
    if (quiet || settings?.notify === false) continue;
    const server = useConfig.getState().snapshot?.config?.servers.find((s) => s.id === i.serverId);
    void notify(`${server?.name ?? i.serverId}: ${i.text}`, i.detail ?? "Home ▸ Needs attention");
  }
  if (changed) saveNotified(notified);
}

export const useWatch = create<WatchState>((set, get) => ({
  snapshot: null,
  settings: null,
  init() {
    const put = (s: WatchSnapshot) => {
      set({ snapshot: s });
      notifyNew(s.items, get().settings);
    };
    void watchSettingsGet().then((settings) => set({ settings }), () => {});
    void watchGet().then(put, () => {});
    const unlisten = listen<WatchSnapshot>(WATCH_CHANGED, (e) => put(e.payload));
    return () => void unlisten.then((f) => f());
  },
  async refresh(serverIds) {
    set((s) => (s.snapshot ? { snapshot: { ...s.snapshot, running: [...new Set([...s.snapshot.running, ...(serverIds ?? [])])] } } : {}));
    set({ snapshot: await watchRefresh(serverIds) });
  },
  async snooze(key, days) {
    set({ snapshot: await watchSnooze(key, days) });
  },
  async saveSettings(s) {
    set({ settings: await watchSettingsSet(s) });
  },
}));

const NO_ITEMS: WatchItem[] = [];

/** A server's items (not snoozed). */
export function useServerItems(serverId: string): WatchItem[] {
  return useWatch((s) => s.snapshot?.items ?? NO_ITEMS).filter((i) => i.serverId === serverId && !i.snoozedUntil);
}

/** "4 min ago" for an epoch-seconds time. */
export function agoS(at: number | null | undefined, now = Date.now() / 1000): string {
  if (!at) return "never";
  const s = Math.max(0, Math.round(now - at));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

// Dev only: a hot-swapped store would be a second, empty copy; reload instead.
import.meta.hot?.accept(() => window.location.reload());
