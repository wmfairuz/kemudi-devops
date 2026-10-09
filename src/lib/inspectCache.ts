// The last Inspect result per app (server + path). In memory it's kept as
// is; on disk (localStorage, for after a restart) .env secret values are
// left out. Those are kept by the backend, encrypted (see secret_cache.rs),
// and put back by restoreSecrets.
import { inspectSecrets, type EnvVar, type Inspection } from "@/lib/ipc";

export interface Cached {
  at: number;
  ins: Inspection;
}

const memory = new Map<string, Cached>();
const PREFIX = "kemudi.inspect.";
const key = (serverId: string, path: string) => `${serverId}|${path.trim().replace(/\/+$/, "")}`;

export type CachedEnvVar = EnvVar & { redacted?: boolean };

export function getCached(serverId: string, path: string): Cached | null {
  const k = key(serverId, path);
  const hit = memory.get(k);
  if (hit) return hit;
  try {
    const raw = localStorage.getItem(PREFIX + k);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}

/** Fill in secret values left out of the on-disk cache from the encrypted
 *  store. Ones it doesn't have stay redacted (Inspect again). */
export async function restoreSecrets(serverId: string, path: string, c: Cached): Promise<Cached> {
  const env = c.ins.env as CachedEnvVar[] | null;
  if (!env?.some((e) => e.redacted)) return c;
  const secrets = await inspectSecrets(serverId, path);
  const filled: Cached = {
    at: c.at,
    ins: {
      ...c.ins,
      env: env.map((e) => (e.redacted && e.key in secrets ? { key: e.key, value: secrets[e.key] ?? "", secret: e.secret } : e)),
    },
  };
  memory.set(key(serverId, path), filled);
  return filled;
}

export function putCached(serverId: string, path: string, ins: Inspection): Cached {
  const k = key(serverId, path);
  const entry = { at: Date.now(), ins };
  memory.set(k, entry);
  const redacted: Inspection = {
    ...ins,
    env: ins.env?.map((e) => (e.secret ? { ...e, value: "", redacted: true } : e)) ?? null,
  };
  try {
    localStorage.setItem(PREFIX + k, JSON.stringify({ at: entry.at, ins: redacted }));
  } catch {
    // Not persisted; the in-memory copy still works this session.
  }
  return entry;
}
