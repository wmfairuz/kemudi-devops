// The New app wizard: which server it's open for, and each server's last
// filled-in form (so "Open setup again" after a failed run starts from it).
import { create } from "zustand";

export interface NewAppDraft {
  name: string;
  id: string;
  idTouched: boolean;
  domains: string;
  appEnv: string;
  repo: string;
  branch: string;
  path: string;
  pathTouched: boolean;
  php: string;
  owner: string;
  migrate: boolean;
  seed: boolean;
  npm: boolean;
  dbMode: "new" | "existing" | "none";
  dbName: string;
  dbUser: string;
  dbTouched: boolean;
  /** New vhost, a wildcard vhost that already serves the folder, or none. */
  web: "new" | "wildcard" | "none";
  webTouched: boolean;
  /** The wildcard vhost (`file|root`) and the app's subdomain in it. */
  wildcard: string;
  sub: string;
  subTouched: boolean;
  vhostName: string;
  https: "certbot" | "cert" | "none";
  httpsTouched: boolean;
  certName: string;
  maxBody: string;
  worker: boolean;
  processes: number;
  /** cron.d `schedule:run` every minute. */
  schedule: boolean;
}

interface NewAppState {
  serverId: string | null;
  drafts: Record<string, NewAppDraft>;
  open(serverId: string): void;
  close(): void;
  save(serverId: string, draft: NewAppDraft): void;
  forget(serverId: string): void;
}

export const useNewApp = create<NewAppState>((set) => ({
  serverId: null,
  drafts: {},
  open: (serverId) => set({ serverId }),
  close: () => set({ serverId: null }),
  save: (serverId, draft) => set((s) => ({ drafts: { ...s.drafts, [serverId]: draft } })),
  forget: (serverId) =>
    set((s) => {
      const drafts = { ...s.drafts };
      delete drafts[serverId];
      return { drafts };
    }),
}));

import.meta.hot?.accept(() => window.location.reload());
