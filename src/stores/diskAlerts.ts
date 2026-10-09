// Disk alerts: every 15 minutes (and shortly after launch) each reachable
// server's disks are checked over ssh (`df`, read-only). A disk at or above
// the red threshold (90%) gets a macOS notification once, and a badge on
// the server until it drops back under 85%. Monitor tabs feed it too.
import { create } from "zustand";

import { appQuiet, monitorDisks, type MonitorDisk } from "@/lib/ipc";
import { THRESHOLDS } from "@/lib/thresholds";
import { notify } from "@/lib/notify";
import { useConfig } from "@/stores/config";
import { useStatus } from "@/stores/status";

const EVERY_MS = 15 * 60_000;
const FIRST_MS = 20_000;
const CLEAR_BELOW = 85;
const KEY = "kemudi.diskAlerts";

export interface FullDisk {
  mount: string;
  pct: number;
  availKb: number;
}

interface DiskAlertsState {
  enabled: boolean;
  /** Disks at or above the red threshold, per server. */
  full: Record<string, FullDisk[]>;
  setEnabled(on: boolean): void;
  /** Take in a server's disks (from a check or a monitor sample). */
  record(serverId: string, disks: MonitorDisk[]): void;
  init(): void;
}

const notified = new Set<string>();
let started = false;
/** KEMUDI_QUIET (a test copy): never notify, Monitor tabs included. */
let quietNow = false;
void appQuiet().then((q) => (quietNow = q), () => {});

function storedEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

function gb(kb: number) {
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

export const useDiskAlerts = create<DiskAlertsState>((set, get) => ({
  enabled: storedEnabled(),
  full: {},

  setEnabled(on) {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      // Not persisted; fine.
    }
    set({ enabled: on });
    if (!on) set({ full: {} });
  },

  record(serverId, disks) {
    const server = useConfig.getState().snapshot?.config?.servers.find((s) => s.id === serverId);
    const full: FullDisk[] = [];
    for (const d of disks) {
      const pct = d.sizeKb ? (d.usedKb / d.sizeKb) * 100 : 0;
      const key = `${serverId}:${d.mount}`;
      if (pct >= THRESHOLDS.disk.bad) {
        full.push({ mount: d.mount, pct, availKb: d.availKb });
        if (get().enabled && !quietNow && !notified.has(key)) {
          notified.add(key);
          void notify(`⚠ ${server?.name ?? serverId}: disk ${d.mount} is ${pct.toFixed(0)}% full`, `${gb(d.availKb)} free`);
        }
      } else if (pct < CLEAR_BELOW) {
        notified.delete(key);
      }
    }
    set((s) => ({ full: { ...s.full, [serverId]: full } }));
  },

  init() {
    if (started) return;
    started = true;
    const quiet = appQuiet().catch(() => false);
    const check = async () => {
      if (!get().enabled || (await quiet)) return;
      const servers = useConfig.getState().snapshot?.config?.servers ?? [];
      const status = useStatus.getState().byServer;
      // Only servers that answered the reachability probe; one at a time.
      for (const s of servers) {
        if (status[s.id]?.state !== "up") continue;
        try {
          get().record(s.id, await monitorDisks(s.id));
        } catch {
          // Unreachable or not Linux right now: try again next round.
        }
      }
    };
    setTimeout(() => void check(), FIRST_MS);
    setInterval(() => void check(), EVERY_MS);
  },
}));

// Dev only: a hot-swapped store would be a second, empty copy that
// shortcuts and menus still use (⌘W/⌘A "stop working"); reload instead.
import.meta.hot?.accept(() => window.location.reload());
