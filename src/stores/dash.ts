import { create } from "zustand";

import { dashboardAuth, dashboardMaintenance, dashboardStatus, dashboardWorkers, errorMessage, type App, type BasicLogin, type Dashboard, type Server } from "@/lib/ipc";
import { askChoice } from "@/stores/confirm";
import { toastError, useToasts } from "@/stores/toasts";

/** Each app's maintenance mode and basic auth, per server (read-only to
 *  read: `dashboard_status`), shown on the Apps cards and an app's
 *  Overview; the dialogs (down, basic auth, default login) are one host. */
export interface DashEntry {
  data: Dashboard | null;
  error: string | null;
  loading: boolean;
  /** When it was read (ms). */
  at: number | null;
}

type Busy = "laravel" | "auth";
type Ref = { serverId: string; appId: string };

interface DashState {
  servers: Record<string, DashEntry>;
  /** `server/app` → what's changing. */
  busy: Record<string, Busy | undefined>;
  down: Ref | null;
  auth: Ref | null;
  /** The default login dialog (the server to read again after). */
  editDefault: string | null;
}

export const useDash = create<DashState>(() => ({ servers: {}, busy: {}, down: null, auth: null, editDefault: null }));

const key = (serverId: string, appId: string) => `${serverId}/${appId}`;
export const dashBusy = (s: DashState, serverId: string, appId: string) => s.busy[key(serverId, appId)];

const put = (serverId: string, e: Partial<DashEntry>) =>
  useDash.setState((s) => ({
    servers: { ...s.servers, [serverId]: { data: null, error: null, loading: false, at: null, ...s.servers[serverId], ...e } },
  }));

/** Read a server's switches (again). */
export async function loadDash(serverId: string): Promise<void> {
  if (useDash.getState().servers[serverId]?.loading) return;
  put(serverId, { loading: true });
  try {
    put(serverId, { data: await dashboardStatus(serverId), error: null, loading: false, at: Date.now() });
  } catch (e) {
    put(serverId, { error: errorMessage(e), loading: false });
  }
}

/** Read it once (when something first shows it). */
export function ensureDash(serverId: string): void {
  const e = useDash.getState().servers[serverId];
  if (!e || (!e.data && !e.loading && !e.error)) void loadDash(serverId);
}

// ------------------------------------------------- workers stopped by down

/** The workers Kemudi stopped when it put an app down, to start again when
 *  it goes back up (on this Mac). */
const STOPPED_KEY = "kemudi.stoppedWorkers";
function stoppedAll(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(STOPPED_KEY) ?? "{}") as Record<string, string[]>;
  } catch {
    return {};
  }
}
export const stoppedOf = (serverId: string, appId: string): string[] => stoppedAll()[key(serverId, appId)] ?? [];
function setStopped(serverId: string, appId: string, programs: string[]) {
  const all = stoppedAll();
  if (programs.length) all[key(serverId, appId)] = programs;
  else delete all[key(serverId, appId)];
  try {
    localStorage.setItem(STOPPED_KEY, JSON.stringify(all));
  } catch {
    // Not kept: going up won't start them; the switches still say so.
  }
}

export const bypassUrl = (app: App, secret: string) => `${(app.url ?? "").replace(/\/+$/, "")}/${secret}`;

// ------------------------------------------------------------- changes

/** Run a change for an app, then read the server again. */
async function change(server: Server, app: App, what: Busy, run: () => Promise<string>) {
  const k = key(server.id, app.id);
  useDash.setState((s) => ({ busy: { ...s.busy, [k]: what } }));
  try {
    useToasts.getState().push(await run(), "info");
  } catch (e) {
    toastError(`${app.name}: ${errorMessage(e)}`);
  } finally {
    useDash.setState((s) => ({ busy: { ...s.busy, [k]: undefined } }));
    // nginx swaps its workers a moment after a reload.
    setTimeout(() => void loadDash(server.id), what === "auth" ? 800 : 0);
  }
}

/** The live switch: down asks first (its dialog), up runs (prod confirms). */
export function toggleLive(server: Server, app: App, down: boolean): void {
  if (!down) {
    useDash.setState({ down: { serverId: server.id, appId: app.id } });
    return;
  }
  void goUp(server, app);
}

async function goUp(server: Server, app: App) {
  const stopped = stoppedOf(server.id, app.id);
  const workers = stopped.length ? `; then supervisorctl start ${stopped.join(", ")} (the workers Kemudi stopped)` : "";
  if (app.env === "prod" && !(await askChoice(`Bring ${app.name} back up?`, `artisan up on ${server.name} (production)${workers}.`, "Bring it up", "Cancel"))) return;
  void change(server, app, "laravel", async () => {
    await dashboardMaintenance(server.id, app.id, false, false);
    if (!stopped.length) return `${app.name} is live again`;
    try {
      await dashboardWorkers(server.id, app.id, true, stopped);
    } catch (e) {
      throw new Error(`it's live again, but its workers (${stopped.join(", ")}) didn't start: ${errorMessage(e)}`);
    }
    setStopped(server.id, app.id, []);
    return `${app.name} is live again; its workers (${stopped.join(", ")}) are started`;
  });
}

/** From the down dialog. */
export function goDown(server: Server, app: App, withSecret: boolean, stop: string[]): void {
  useDash.setState({ down: null });
  void change(server, app, "laravel", async () => {
    const r = await dashboardMaintenance(server.id, app.id, true, withSecret);
    if (r.secret && app.url) void navigator.clipboard.writeText(bypassUrl(app, r.secret)).catch(() => {});
    let msg = r.secret && app.url ? `${app.name} is in maintenance mode; the bypass link is copied` : `${app.name} is in maintenance mode`;
    if (stop.length) {
      try {
        await dashboardWorkers(server.id, app.id, false, stop);
      } catch (e) {
        throw new Error(`it's in maintenance mode, but its workers weren't stopped: ${errorMessage(e)}`);
      }
      // With any it stopped before (and hasn't started since).
      setStopped(server.id, app.id, [...new Set([...stoppedOf(server.id, app.id), ...stop])]);
      msg += `; its workers (${stop.join(", ")}) are stopped`;
    }
    return msg;
  });
}

/** The basic auth switch: on (or Change login…) asks for the login, off runs (prod confirms). */
export function toggleAuth(server: Server, app: App, on: boolean): void {
  if (!on) {
    useDash.setState({ auth: { serverId: server.id, appId: app.id } });
    return;
  }
  void authOff(server, app);
}

export const changeLogin = (server: Server, app: App) => useDash.setState({ auth: { serverId: server.id, appId: app.id } });

async function authOff(server: Server, app: App) {
  if (app.env === "prod" && !(await askChoice(`Turn basic auth off for ${app.name}?`, `Anyone can open it again (${server.name}, production).`, "Turn it off", "Cancel"))) return;
  void change(server, app, "auth", async () => {
    await dashboardAuth(server.id, app.id, false, null);
    return `Basic auth off for ${app.name}`;
  });
}

/** From the basic auth dialog. */
export function authOn(server: Server, app: App, login: BasicLogin): void {
  useDash.setState({ auth: null });
  void change(server, app, "auth", async () => {
    const r = await dashboardAuth(server.id, app.id, true, login);
    return `Basic auth on for ${app.name}${r.user ? ` (user ${r.user})` : ""}`;
  });
}
