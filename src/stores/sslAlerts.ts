// SSL expiry: every 6 hours (and a couple of minutes after launch) each
// reachable server's certificates are checked over ssh (what nginx/Apache
// serves, read-only). One that expires within 14 days gets a macOS
// notification once, and the server a badge until it's renewed. Health
// tabs feed it too.
import { create } from "zustand";

import { appQuiet, healthCheck, type Health, type HealthCert } from "@/lib/ipc";
import { notify } from "@/lib/notify";
import { useConfig } from "@/stores/config";
import { useStatus } from "@/stores/status";

const EVERY_MS = 6 * 3600_000;
const FIRST_MS = 120_000;
/** Notify and badge at or under this many days. */
export const SSL_WARN_DAYS = 14;
const KEY = "kemudi.sslAlerts";

export interface Expiring {
  name: string;
  days: number;
}

interface SslAlertsState {
  enabled: boolean;
  /** Certificates expiring soon (or expired), per server. */
  soon: Record<string, Expiring[]>;
  setEnabled(on: boolean): void;
  record(serverId: string, health: Health): void;
  init(): void;
}

const notified = new Set<string>();
let started = false;
let quietNow = false;
void appQuiet().then((q) => (quietNow = q), () => {});

function storedEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/** A real expiry problem: the certificate is for the name and runs out soon. */
export const expiringSoon = (c: HealthCert) => !c.missing && c.covers && c.daysLeft != null && c.daysLeft <= SSL_WARN_DAYS;

export const useSslAlerts = create<SslAlertsState>((set, get) => ({
  enabled: storedEnabled(),
  soon: {},

  setEnabled(on) {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      // Not persisted; fine.
    }
    set({ enabled: on });
    if (!on) set({ soon: {} });
  },

  record(serverId, health) {
    const server = useConfig.getState().snapshot?.config?.servers.find((s) => s.id === serverId);
    const soon = health.certs.filter(expiringSoon).map((c) => ({ name: c.name, days: c.daysLeft ?? 0 }));
    for (const c of health.certs.filter(expiringSoon)) {
      const key = `${serverId}:${c.name}:${c.notAfter}`;
      if (get().enabled && !quietNow && !notified.has(key)) {
        notified.add(key);
        const days = c.daysLeft ?? 0;
        void notify(
          `🔒 ${c.name}: certificate ${days < 0 ? `expired ${-days} day${days === -1 ? "" : "s"} ago` : days === 0 ? "expires today" : `expires in ${days} day${days === 1 ? "" : "s"}`}`,
          `On ${server?.name ?? serverId}${health.renew.length ? "" : ": nothing seems to renew it"}`,
        );
      }
    }
    set((s) => ({ soon: { ...s.soon, [serverId]: soon } }));
  },

  init() {
    if (started) return;
    started = true;
    const quiet = appQuiet().catch(() => false);
    const check = async () => {
      if (!get().enabled || (await quiet)) return;
      const servers = useConfig.getState().snapshot?.config?.servers ?? [];
      const status = useStatus.getState().byServer;
      for (const s of servers) {
        if (status[s.id]?.state !== "up") continue;
        try {
          get().record(s.id, await healthCheck(s.id, true));
        } catch {
          // Unreachable right now: next round.
        }
      }
    };
    setTimeout(() => void check(), FIRST_MS);
    setInterval(() => void check(), EVERY_MS);
  },
}));

// Dev only: a hot-swapped store would be a second, empty copy; reload instead.
import.meta.hot?.accept(() => window.location.reload());
