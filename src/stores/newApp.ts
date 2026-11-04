// The New app wizard: which server it's open for, and each server's last
// filled-in form (so running it again after a failed run starts from it).
// The forms are kept on disk (no secrets in them: the database password is
// made on the server) until the app is set up or Start over.
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
  /** History ▸ Re-run: the form that run came from, open. */
  reopen(serverId: string, script: string): boolean;
}

const KEY = "kemudi.newApp.drafts";

function stored(): Record<string, Partial<NewAppDraft>> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function store(drafts: Record<string, Partial<NewAppDraft>>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    // Kept until quit, then.
  }
}

/** The form as kept in the script (`# form: <base64 JSON>`). */
export function encodeForm(d: NewAppDraft): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(d))));
}

const unquote = (v: string) => (v.startsWith("'") && v.endsWith("'") && v.length > 1 ? v.slice(1, -1).replaceAll("'\\''", "'") : v);

/** The form a New app run came from: its `# form:` line, else (a run from
 *  before it was kept) what the script's settings and steps say. */
export function formOfScript(script: string): Partial<NewAppDraft> | null {
  const kept = /^# form: ([A-Za-z0-9+/=]+)$/m.exec(script)?.[1];
  if (kept) {
    try {
      const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(kept), (c) => c.charCodeAt(0))));
      if (v && typeof v === "object") return v as Partial<NewAppDraft>;
    } catch {
      // Read the settings below instead.
    }
  }
  const head: Record<string, string> = {};
  for (const l of script.split("\n").slice(0, 40)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(l);
    if (m?.[1] && m[2] !== undefined) head[m[1]] = unquote(m[2]);
  }
  if (!head.ID || !head.DIR) return null;
  let host = "";
  try {
    host = head.URL ? new URL(head.URL).hostname : "";
  } catch {
    // No domain, then.
  }
  const procs = /^numprocs=(\d+)$/m.exec(
    (/^wf=.*\n[\s\S]*?<<'KEMUDI_B64'\n([\s\S]*?)\nKEMUDI_B64/m.exec(script)?.[1] ?? "")
      .split("\n")
      .map((b) => {
        try {
          return atob(b);
        } catch {
          return "";
        }
      })
      .join(""),
  )?.[1];
  return {
    name: head.NAME ?? head.ID,
    id: head.ID,
    idTouched: true,
    repo: head.REPO ?? "",
    branch: head.BRANCH ?? "",
    path: head.DIR,
    pathTouched: true,
    php: head.PHPV ?? "",
    owner: head.OWNER ?? "",
    appEnv: head.APPENV ?? "",
    domains: host,
    dbMode: !head.DB ? "none" : script.includes("Password for MySQL user") ? "existing" : "new",
    dbName: head.DB ?? "",
    dbUser: head.DBUSER ?? "",
    dbTouched: true,
    migrate: script.includes("art migrate"),
    seed: script.includes("--seed"),
    npm: script.includes("npm ci"),
    worker: /^wf=/m.test(script),
    ...(procs ? { processes: Number(procs) } : {}),
    schedule: /^cf=\/etc\/cron\.d\//m.test(script),
    https: script.includes("certbot --nginx") ? "certbot" : "none",
    httpsTouched: true,
  };
}

export const useNewApp = create<NewAppState>((set) => ({
  serverId: null,
  // Partial: one saved by an older Kemudi lacks newer fields (the form
  // fills them in).
  drafts: stored() as Record<string, NewAppDraft>,
  open: (serverId) => set({ serverId }),
  close: () => set({ serverId: null }),
  save: (serverId, draft) =>
    set((s) => {
      const drafts = { ...s.drafts, [serverId]: draft };
      store(drafts);
      return { drafts };
    }),
  reopen: (serverId, script) => {
    const form = formOfScript(script);
    if (!form) return false;
    set((s) => {
      const drafts = { ...s.drafts, [serverId]: form as NewAppDraft };
      store(drafts);
      return { drafts, serverId };
    });
    return true;
  },
  forget: (serverId) =>
    set((s) => {
      const drafts = { ...s.drafts };
      delete drafts[serverId];
      store(drafts);
      return { drafts };
    }),
}));

import.meta.hot?.accept(() => window.location.reload());
