// The background checks' results, shown: Needs attention (Home and a
// server's Overview), the fleet grid (Home) and a server's Overview.
import { AlertTriangle, BellOff, ExternalLink, Bug, Cpu, Database, HardDrive, Lock, MemoryStick, RefreshCw, RotateCw, ShieldAlert, Unplug, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { PopupMenu } from "@/components/kit/PopupMenu";
import { Spinner } from "@/components/kit/Spinner";
import { StatusDot } from "@/components/kit/StatusDot";
import { appsLog, errorMessage, openUrl, type App, type AppsLog, type AppSwitches, type Env, type Server, type ServerWatch, type WatchUpdates, type WatchItem, type WatchSettings } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/manage/Badge";
import { AppsList } from "@/components/manage/DetailsView";
import { Group, Tool, ToolSwitch } from "@/components/kit/Toolbar";
import { AppSwitchesCompact, ServerNotes } from "@/components/dashboard/AppSwitches";
import { ensureDash, useDash } from "@/stores/dash";
import { ChipGroup, ClearFilters, FilterChip, FilterSearch, PickedChip, wordsMatch } from "@/components/kit/Filters";
import { useFleetUi } from "@/stores/fleetUi";
import { openDetails, useManage } from "@/stores/manage";
import { useStatus } from "@/stores/status";
import { openServer, type ServerSection } from "@/stores/tabs";
import { loadShots, shotKey, takeShot, useShots } from "@/stores/shots";
import { toastError } from "@/stores/toasts";
import { agoS, useWatch } from "@/stores/watch";
import { ServerLogins } from "./ServerLogins";

/** Re-render every half minute, so "4 min ago" moves on. */
function useClock() {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return Date.now() / 1000;
}

function gb(kb: number): string {
  const g = kb / 1024 / 1024;
  return g >= 10 ? `${g.toFixed(0)} GB` : g >= 1 ? `${g.toFixed(1)} GB` : `${(kb / 1024).toFixed(0)} MB`;
}

const pct = (used: number, avail: number) => (used + avail > 0 ? Math.ceil((used * 100) / (used + avail)) : 0);

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const c = cn("size-4 flex-none", className);
  switch (kind) {
    case "disk":
    case "inodes":
      return <HardDrive className={c} />;
    case "memory":
    case "swap":
      return <MemoryStick className={c} />;
    case "load":
      return <Cpu className={c} />;
    case "cert":
    case "renew":
      return <Lock className={c} />;
    case "security":
    case "updates":
    case "secops":
    case "secops-app":
    case "secops-warn":
    case "secops-root":
      return <ShieldAlert className={c} />;
    case "reboot":
      return <RotateCw className={c} />;
    case "debug":
      return <Bug className={c} />;
    case "down":
    case "setup":
      return <Wrench className={c} />;
    case "unreachable":
      return <Unplug className={c} />;
    case "failed":
    case "restarting":
    case "supervisor":
    case "workers":
      return <Database className={c} />;
    default:
      return <AlertTriangle className={c} />;
  }
}

const SEV_TEXT = { urgent: "text-env-prod-fg", warn: "text-[#8a5a12]", info: "text-subtle-foreground" } as const;

/** Where an item is looked into (and fixed). */
export function actionOf(item: WatchItem, server: Server): { label: string; run: () => void } | null {
  const go = (section: ServerSection, label: string) => ({ label, run: () => void openServer(server, section) });
  switch (item.kind) {
    case "disk":
    case "inodes":
    case "memory":
    case "swap":
    case "load":
      return go("monitor", "Monitor");
    case "failed":
    case "restarting":
    case "supervisor":
    case "workers":
    case "security":
    case "updates":
    case "reboot":
    case "cert":
    case "renew":
      return go("health", "Health");
    case "down":
      return go("apps", "Apps");
    case "setup":
      return go("setup", "Setup");
    case "secops":
    case "secops-app":
    case "secops-warn":
    case "secops-root":
      return go("security", "Security");
    case "debug":
    case "missing":
      return item.appId ? { label: "App tab", run: () => openDetails({ kind: "app", serverId: server.id, appId: item.appId }) } : null;
    case "unreachable":
      return { label: "Probe again", run: () => void useStatus.getState().refresh([server.id]) };
    case "error":
      if (item.key.endsWith(":error:security")) return go("security", "Security");
      return { label: "Check again", run: () => void useWatch.getState().refresh([server.id]).catch((e) => toastError(errorMessage(e))) };
    default:
      return null;
  }
}

/** The list of what needs attention, worst first; snoozed ones on request. */
export function AttentionList({ servers, showServer = true, empty }: { servers: Server[]; showServer?: boolean; empty: React.ReactNode }) {
  const snap = useWatch((s) => s.snapshot);
  const now = useClock();
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; item: WatchItem } | null>(null);
  const byId = new Map(servers.map((s) => [s.id, s]));
  const all = (snap?.items ?? []).filter((i) => byId.has(i.serverId));
  const snoozed = all.filter((i) => i.snoozedUntil);
  const shown = showSnoozed ? all : all.filter((i) => !i.snoozedUntil);

  return (
    <div className="flex flex-col">
      {shown.length === 0 && <div className="px-4 py-3 text-[12.5px] leading-5 text-subtle-foreground">{empty}</div>}
      {shown.map((i) => {
        const server = byId.get(i.serverId)!;
        const act = actionOf(i, server);
        return (
          <div key={i.key} className={cn("group flex min-h-10 items-center gap-2.5 border-t border-divider px-3 py-1.5 first:border-t-0", i.snoozedUntil && "opacity-60")}>
            <KindIcon kind={i.kind} className={SEV_TEXT[i.severity]} />
            {showServer && (
              <button className="w-[150px] flex-none cursor-pointer truncate text-left text-[12.5px] font-medium hover:underline" onClick={() => openServer(server, "overview")}>
                {server.name}
              </button>
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[12.5px]">{i.text}</span>
              {i.detail && <span className="truncate text-[11px] text-subtle-foreground">{i.detail}</span>}
            </span>
            <span className="flex-none text-[11px] text-subtle-foreground" title={i.snoozedUntil ? `Snoozed until ${new Date(i.snoozedUntil * 1000).toLocaleString()}` : "When this was read"}>
              {i.snoozedUntil ? "snoozed" : agoS(i.at, now)}
            </span>
            {act && (
              <Btn size="sm" variant="outline" onClick={act.run}>
                {act.label}
              </Btn>
            )}
            <button
              title={i.snoozedUntil ? "Show it again" : "Snooze…"}
              onClick={(e) => {
                if (i.snoozedUntil) void useWatch.getState().snooze(i.key, 0);
                else setMenu({ x: e.clientX, y: e.clientY, item: i });
              }}
              className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover hover:text-foreground"
            >
              <BellOff className="size-3.5" />
            </button>
          </div>
        );
      })}
      {snoozed.length > 0 && (
        <button className="w-fit cursor-pointer border-t border-divider px-3 py-1.5 text-left text-[11.5px] text-subtle-foreground hover:text-foreground" onClick={() => setShowSnoozed(!showSnoozed)}>
          {showSnoozed ? "Hide snoozed" : `${snoozed.length} snoozed`}
        </button>
      )}
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          title="Snooze"
          onClose={() => setMenu(null)}
          groups={[[1, 7, 30].map((d) => ({ label: d === 1 ? "For a day" : `For ${d} days`, run: () => useWatch.getState().snooze(menu.item.key, d) }))]}
        />
      )}
    </div>
  );
}

/** One fleet-grid cell: a value, coloured by how bad it is; grey when old
 *  or the server isn't answering. */
function Cell({ tone, stale, title, onClick, children }: { tone: "ok" | "warn" | "bad" | "none"; stale?: boolean; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-9 cursor-pointer items-center justify-center truncate px-1.5 font-mono text-[12px] hover:bg-hover",
        stale || tone === "none" ? "text-subtle-foreground" : tone === "bad" ? "font-semibold text-env-prod-fg" : tone === "warn" ? "text-[#8a5a12]" : "text-[#17702a]",
      )}
    >
      {children}
    </button>
  );
}

function worstDisk(w: ServerWatch | undefined) {
  const disks = w?.system?.value.disks ?? [];
  return disks.reduce<{ mount: string; pct: number } | null>((top, d) => {
    const p = pct(d.usedKb, d.availKb);
    return !top || p > top.pct ? { mount: d.mount, pct: p } : top;
  }, null);
}

function minCertDays(w: ServerWatch | undefined, now: number) {
  const certs = (w?.certs?.value.certs ?? []).filter((c) => c.covers && !c.missing && c.notAfter);
  if (certs.length === 0) return null;
  return Math.min(...certs.map((c) => Math.floor((c.notAfter! - now) / 86_400)));
}

/** Servers × checks, from the last results. */
export function FleetGrid({ servers }: { servers: Server[] }) {
  const snap = useWatch((s) => s.snapshot);
  const settings = useWatch((s) => s.settings);
  const status = useStatus((s) => s.byServer);
  const now = useClock();
  if (!settings) return null;
  const cols = "grid-cols-[minmax(160px,1.6fr)_repeat(6,minmax(64px,1fr))_minmax(92px,1fr)_40px]";
  return (
    <div className="flex flex-col overflow-x-auto">
      <div className={cn("grid min-w-[760px] items-center border-b border-divider px-2 text-[11px] font-medium tracking-wide text-subtle-foreground uppercase", cols)}>
        <span className="px-1.5 py-2">Server</span>
        {["Disk", "Memory", "Updates", "SSL", "Services", "Setup", "Checked"].map((h) => (
          <span key={h} className="py-2 text-center">
            {h}
          </span>
        ))}
        <span />
      </div>
      {servers.map((s) => {
        const w = snap?.servers[s.id];
        const reach = status[s.id]?.state ?? "unknown";
        const stale = reach === "down";
        const running = snap?.running.includes(s.id) ?? false;
        const go = (section: ServerSection) => () => void openServer(s, section);
        const disk = worstDisk(w);
        const sys = w?.system?.value;
        const mem = sys && sys.memTotalKb > 0 ? 100 - Math.floor((sys.memAvailableKb * 100) / sys.memTotalKb) : null;
        const up = w?.updates?.value;
        const days = minCertDays(w, now);
        const setup = w?.setup?.value;
        const times = [w?.system?.at, w?.updates?.at, w?.certs?.at, w?.setup?.at].filter((t): t is number => !!t);
        const last = times.length ? Math.max(...times) : null;
        const errors = Object.entries(w?.errors ?? {});
        return (
          <div key={s.id} className={cn("grid min-w-[760px] items-center border-b border-divider px-2 last:border-b-0", cols)}>
            <button className="flex min-w-0 cursor-pointer items-center gap-2 px-1.5 py-1.5 text-left hover:underline" onClick={go("overview")}>
              <StatusDot status={reach} />
              <span className="truncate text-[12.5px] font-medium">{s.name}</span>
              <EnvTag env={s.env} />
            </button>
            <Cell
              tone={!disk ? "none" : disk.pct >= settings.diskUrgent ? "bad" : disk.pct >= settings.diskWarn ? "warn" : "ok"}
              stale={stale}
              title={disk ? `Fullest: ${disk.mount}` : "Not checked yet"}
              onClick={go("monitor")}
            >
              {disk ? `${disk.pct}%` : "–"}
            </Cell>
            <Cell tone={mem === null ? "none" : mem >= settings.memWarn ? "warn" : "ok"} stale={stale} onClick={go("monitor")}>
              {mem === null ? "–" : `${mem}%`}
            </Cell>
            <Cell
              tone={!up || up.updates === null ? "none" : (up.security ?? 0) > 0 || up.rebootRequired ? "warn" : "ok"}
              stale={stale}
              title={up ? `${up.updates ?? "?"} updates, ${up.security ?? "?"} security${up.rebootRequired ? ", restart needed" : ""}` : "Not checked yet"}
              onClick={go("health")}
            >
              {!up || up.updates === null ? "–" : (up.security ?? 0) > 0 ? `${up.security} sec` : up.updates > 0 ? String(up.updates) : "0"}
              {up?.rebootRequired ? " ↻" : ""}
            </Cell>
            <Cell
              tone={days === null ? "none" : days <= settings.certUrgentDays ? "bad" : days <= settings.certWarnDays ? "warn" : "ok"}
              stale={stale}
              title={days === null ? "No certificates seen" : "Days until the first certificate runs out"}
              onClick={go("health")}
            >
              {days === null ? "–" : days < 0 ? "expired" : `${days} d`}
            </Cell>
            <Cell tone={!sys ? "none" : sys.failedUnits.length ? "warn" : "ok"} stale={stale} title={sys?.failedUnits.join(", ") || undefined} onClick={go("health")}>
              {!sys ? "–" : sys.failedUnits.length ? `${sys.failedUnits.length} failed` : "ok"}
            </Cell>
            <Cell tone={!setup ? "none" : setup.bad ? "warn" : "ok"} stale={stale} title={setup ? `${setup.profile}: ✓ ${setup.ok} ✗ ${setup.bad} ! ${setup.warn}` : "No profile, or not checked yet"} onClick={go("setup")}>
              {!setup ? "–" : setup.bad ? `✗ ${setup.bad}` : `✓ ${setup.ok}`}
            </Cell>
            <span
              className={cn("truncate text-center text-[11px]", errors.length ? "text-env-prod-fg" : "text-subtle-foreground")}
              title={errors.length ? errors.map(([k, v]) => `${k}: ${v}`).join("\n") : last ? new Date(last * 1000).toLocaleString() : undefined}
            >
              {running ? "checking…" : errors.length ? "failed" : agoS(last, now)}
            </span>
            <button
              title="Check now (every check, read-only)"
              disabled={running}
              onClick={() => void useWatch.getState().refresh([s.id]).catch((e) => toastError(errorMessage(e)))}
              className="flex size-7 cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover hover:text-foreground disabled:cursor-default"
            >
              {running ? <Spinner size={11} /> : <RefreshCw className="size-3.5" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Card({ title, at, section, server, children }: { title: string; at?: number | null; section?: ServerSection; server: Server; children: React.ReactNode }) {
  const now = useClock();
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-divider bg-panel">
      <div className="flex h-10 flex-none items-center gap-2 border-b border-divider px-3.5">
        <span className="flex-1 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">{title}</span>
        {at !== undefined && <span className="text-[11px] text-subtle-foreground">{agoS(at, now)}</span>}
        {section && (
          <button className="cursor-pointer rounded-md px-1.5 text-[12px] text-primary hover:bg-primary/10" onClick={() => openServer(server, section)}>
            Open
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-3.5 py-2.5 text-[12.5px]">{children}</div>
    </section>
  );
}

const Dim = ({ children }: { children: React.ReactNode }) => <span className="text-subtle-foreground">{children}</span>;

function Bar({ value, warn, urgent }: { value: number; warn: number; urgent: number }) {
  return (
    <span className="h-1.5 w-24 flex-none overflow-hidden rounded-full bg-hover-strong">
      <span className={cn("block h-full", value >= urgent ? "bg-env-prod" : value >= warn ? "bg-env-staging" : "bg-status-up")} style={{ width: `${Math.min(100, value)}%` }} />
    </span>
  );
}

type AppsView = "list" | "pictures";
const VIEW_KEY = "kemudi.appsView";
function savedView(): AppsView {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "pictures";
  } catch {
    return "pictures";
  }
}

/** A server's Apps section: each app with what the background checks last
 *  found in it (its .env), as a list or as pictures of their front pages;
 *  + Add app / Discover apps… / New app…. */
export function ServerApps({ server }: { server: Server }) {
  const up = useWatch((s) => s.snapshot?.servers[server.id]?.updates);
  const now = useClock();
  const [view, setView] = useState<AppsView>(savedView);
  const urls = server.apps.map((a) => `${a.id}=${a.url ?? ""}`).join(" ");
  // Maintenance mode and basic auth on the cards (read-only to read).
  useEffect(() => ensureDash(server.id), [server.id]);
  useEffect(() => {
    if (view === "pictures") void loadShots(server.id, server.apps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, server.id, urls]);
  const pick = (v: AppsView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Just for now, then.
    }
  };
  const f = useAppsFilter((s) => s[server.id]) ?? NO_FILTER;
  const setF = (g: AppFilter) => useAppsFilter.setState({ [server.id]: g });
  const dash = useDash((s) => s.servers[server.id]?.data);
  const facts = (a: App) => appFacts(up?.value.apps.find((x) => x.id === a.id), dash?.apps.find((x) => x.appId === a.id));
  const shown = server.apps.filter((a) => matches(a, facts(a), f));
  const status = (a: App) => {
    const st = up?.value.apps.find((x) => x.id === a.id);
    if (!st) return <Dim>–</Dim>;
    if (st.missing) return <span className="text-env-prod-fg">folder missing</span>;
    return (
      <>
        {st.downSince && <span className="text-[#8a5a12]">maintenance since {agoS(st.downSince, now)}</span>}
        {st.appDebug && <span className={a.env === "prod" || st.appEnv === "production" ? "text-env-prod-fg" : "text-subtle-foreground"}>APP_DEBUG on</span>}
        <Dim>{st.appEnv ?? "no .env"}</Dim>
      </>
    );
  };
  return (
    <div className="light-ui absolute inset-0 overflow-y-auto bg-background text-foreground">
      <div className="flex w-full flex-col gap-4 px-5 py-5">
        <AppsStats server={server} now={now} f={f} onFilter={(g) => setF({ ...NO_FILTER, ...g })} />
        <ServerNotes server={server} />
        {server.apps.length > 0 && <AppsFilterBar apps={server.apps} facts={facts} f={f} setF={setF} />}
        <AppsList
          server={server}
          apps={shown}
          empty={
            <>
              No apps match.{" "}
              <button className="cursor-pointer text-primary hover:underline" onClick={() => setF(NO_FILTER)}>
                Clear the filter
              </button>
            </>
          }
          aside={
            <>
              <span className="text-[11px] text-subtle-foreground">{up ? `checked ${agoS(up.at, now)}` : "not checked yet"}</span>
              {view === "pictures" && server.apps.some((a) => a.url) && (
                <Group>
                  <Tool label="Retake pictures" onClick={() => void loadShots(server.id, server.apps, true)} title="Take every app's picture again (headless Chrome on this Mac opens each URL)">
                    <RefreshCw className="size-[16px]" strokeWidth={1.6} />
                  </Tool>
                </Group>
              )}
            </>
          }
          lead={<ToolSwitch<AppsView> label="Show apps as" value={view} options={[{ value: "pictures", label: "Pictures" }, { value: "list", label: "List" }]} onChange={pick} />}
          status={status}
          extra={(a) => <AppSwitchesCompact server={server} app={a} />}
          grid={view === "pictures" ? <AppsGrid server={server} apps={shown} status={status} /> : undefined}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ filter

type AppFilter = {
  q: string;
  env: Env | null;
  live: "live" | "down" | null;
  auth: "on" | "off" | null;
  look: boolean;
  /** One thing the checks flag (the Need a look tile's parts). */
  flag: "debug" | "missing" | null;
  url: boolean;
  /** Apps picked from the log (added in 30 days, by Discover). */
  ids: { label: string; set: string[] } | null;
};
const NO_FILTER: AppFilter = { q: "", env: null, live: null, auth: null, look: false, flag: null, url: false, ids: null };
/** Each server's Apps filter (kept while the app runs; the Overview's
 *  Apps card sets it too). */
const useAppsFilter = create<Record<string, AppFilter>>(() => ({}));
/** The server's Apps section showing just `g`. */
function showApps(server: Server, g: Partial<AppFilter>) {
  useAppsFilter.setState({ [server.id]: { ...NO_FILTER, ...g } });
  openServer(server, "apps");
}
const FLAG_LABEL = { debug: "APP_DEBUG on", missing: "Folder missing" } as const;
const filtering = (f: AppFilter) => f.q !== "" || !!f.env || !!f.live || !!f.auth || f.look || !!f.flag || f.url || !!f.ids;

/** What an app's filters look at: the background checks (its .env) and
 *  the switches (maintenance mode, basic auth) as last read. */
type Facts = { down: boolean | null; auth: boolean | null; look: boolean; debug: boolean; missing: boolean };
type ServerWatchApp = WatchUpdates["apps"][number];
function appFacts(st: ServerWatchApp | undefined, sw: AppSwitches | undefined): Facts {
  const down = sw?.laravel ? sw.down : st ? !!st.downSince : null;
  const auth = sw ? (sw.auth.state === "on" || sw.auth.state === "partial" ? true : sw.auth.state === "off" ? false : null) : null;
  return { down, auth, look: !!st && (st.missing || !!st.appDebug || !!st.downSince), debug: !!st?.appDebug, missing: !!st?.missing };
}

function matches(a: App, x: Facts, f: AppFilter): boolean {
  if (f.env && a.env !== f.env) return false;
  if (f.live && x.down !== (f.live === "down")) return false;
  if (f.auth && x.auth !== (f.auth === "on")) return false;
  if (f.look && !x.look) return false;
  if (f.flag && !x[f.flag]) return false;
  if (f.url && !a.url) return false;
  if (f.ids && !f.ids.set.includes(a.id)) return false;
  return wordsMatch(f.q, `${a.name} ${a.id} ${a.url ?? ""} ${a.path}`);
}

/** Find an app (name, URL, folder) and filter by environment, live or
 *  maintenance, basic auth, and what the checks flagged. A chip again
 *  clears it. */
function AppsFilterBar({ apps, facts, f, setF }: { apps: App[]; facts: (a: App) => Facts; f: AppFilter; setF: (f: AppFilter) => void }) {
  const all = apps.map((a) => [a, facts(a)] as const);
  const count = (g: Partial<AppFilter>) => all.filter(([a, x]) => matches(a, x, { ...NO_FILTER, ...g })).length;
  const envs = (["prod", "staging", "qa", "dev"] as Env[]).filter((e) => apps.some((a) => a.env === e));
  const chip = (label: string, on: boolean, g: Partial<AppFilter>, off: Partial<AppFilter>, title?: string) => (
    <FilterChip key={label} label={label} on={on} n={count(g)} onClick={() => setF({ ...f, ...(on ? off : g) })} title={title} />
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSearch value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="Find an app (name, URL, folder)" />
      {envs.length > 1 && <ChipGroup>{envs.map((e) => chip(ENV_LABEL[e], f.env === e, { env: e }, { env: null }))}</ChipGroup>}
      <ChipGroup>
        {chip("Live", f.live === "live", { live: "live" }, { live: null })}
        {chip("Maintenance", f.live === "down", { live: "down" }, { live: null })}
      </ChipGroup>
      <ChipGroup>
        {chip("Auth on", f.auth === "on", { auth: "on" }, { auth: null }, "Basic auth on (for all or some of its server blocks)")}
        {chip("Auth off", f.auth === "off", { auth: "off" }, { auth: null }, "Basic auth off (ones set by hand in the vhost aren't counted)")}
      </ChipGroup>
      <ChipGroup>{chip("Need a look", f.look, { look: true }, { look: false }, "Folder missing, APP_DEBUG on or in maintenance (the background checks)")}</ChipGroup>
      {f.flag && <PickedChip label={FLAG_LABEL[f.flag]} onClear={() => setF({ ...f, flag: null })} />}
      {f.url && <PickedChip label="With a URL" onClear={() => setF({ ...f, url: false })} />}
      {f.ids && <PickedChip label={f.ids.label} onClear={() => setF({ ...f, ids: null })} />}
      {filtering(f) && <ClearFilters onClick={() => setF(NO_FILTER)} />}
    </div>
  );
}

const DAY_S = 86400;

function Stat({
  label,
  value,
  sub,
  tone,
  onClick,
  title,
  active,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "warn" | "bad";
  onClick?: () => void;
  title?: string;
  /** Its filter is the one on. */
  active?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-xl border bg-panel px-3.5 py-2.5",
        active ? "border-primary/60 bg-primary/[0.06] ring-1 ring-primary/30" : "border-divider",
        onClick && "cursor-pointer transition-colors hover:border-primary/40 hover:bg-hover",
      )}
      onClick={onClick}
      title={title}
      role={onClick ? "button" : undefined}
    >
      <span className="text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">{label}</span>
      <span className={cn("truncate text-[18px] leading-6 font-semibold tabular-nums", tone === "bad" ? "text-env-prod-fg" : tone === "warn" ? "text-[#8a5a12]" : "text-foreground")}>{value}</span>
      {sub && <span className="truncate text-[11.5px] text-subtle-foreground">{sub}</span>}
    </div>
  );
}

const ENV_LABEL: Record<Env, string> = { prod: "prod", staging: "staging", qa: "QA", dev: "dev" };

/** The Apps section's numbers: how many, by environment, what the checks
 *  flagged, when Discover last looked and what was added or removed
 *  through Kemudi (its log on this Mac). */
function AppsStats({ server, now, f, onFilter }: { server: Server; now: number; f: AppFilter; onFilter: (f: Partial<AppFilter>) => void }) {
  const up = useWatch((s) => s.snapshot?.servers[server.id]?.updates);
  const discovering = useManage((s) => s.discover === server.id);
  const shots = useShots((s) => s.map);
  const [log, setLog] = useState<AppsLog | null>(null);
  const ids = server.apps.map((a) => a.id).join(" ");
  useEffect(() => {
    if (discovering) return;
    let live = true;
    appsLog(server.id).then(
      (l) => live && setLog(l),
      () => live && setLog(null),
    );
    return () => {
      live = false;
    };
  }, [server.id, ids, discovering]);

  const apps = server.apps;
  const withUrl = apps.filter((a) => a.url).length;
  const pictured = apps.filter((a) => shots[shotKey(server.id, a.id)]?.shot).length;
  const envs = (["prod", "staging", "qa", "dev"] as Env[])
    .map((e) => [e, apps.filter((a) => a.env === e).length] as const)
    .filter(([, n]) => n > 0);

  const st = up?.value.apps ?? [];
  const debug = st.filter((x) => x.appDebug).length;
  const down = st.filter((x) => x.downSince).length;
  const missing = st.filter((x) => x.missing).length;
  const flagged = new Set(st.filter((x) => x.appDebug || x.downSince || x.missing).map((x) => x.id)).size;

  const lastDiscover = log?.discovers.at(-1);
  const events = log?.events ?? [];
  const month = events.filter((e) => e.at >= now - 30 * DAY_S);
  const added = month.filter((e) => e.kind === "added");
  const removed = month.filter((e) => e.kind === "removed").length;
  const lastAdd = [...events].reverse().find((e) => e.kind === "added");
  const nameOf = (id: string) => apps.find((a) => a.id === id)?.name ?? id;
  const here = (list: { appId: string }[]) => [...new Set(list.map((e) => e.appId))].filter((id) => apps.some((a) => a.id === id));
  const addedIds = here(added);
  const discoveredIds = here(events.filter((e) => e.kind === "added" && e.via === "discover"));
  /** A part of a tile that filters on its own (the tile's click is the whole). */
  const part = (label: React.ReactNode, title: string, g: Partial<AppFilter>, on: boolean) => (
    <button
      className={cn("cursor-pointer rounded hover:text-primary hover:underline", on && "font-semibold text-primary")}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onFilter(on ? {} : g);
      }}
    >
      {label}
    </button>
  );
  const only = (g: Partial<AppFilter>) => {
    const want = { ...NO_FILTER, ...g };
    return (Object.keys(want) as (keyof AppFilter)[]).every((k) => JSON.stringify(want[k]) === JSON.stringify(f[k]));
  };

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
      <Stat
        label="Apps"
        value={apps.length}
        onClick={filtering(f) ? () => onFilter({}) : undefined}
        title={filtering(f) ? "Show them all" : undefined}
        sub={
          apps.length ? (
            <>
              {withUrl < apps.length ? part(`${withUrl} with a URL`, "Show the ones with a URL", { url: true }, only({ url: true })) : `${withUrl} with a URL`} · {pictured} pictured
            </>
          ) : (
            "none yet"
          )
        }
      />
      <Stat
        label="Environments"
        value={
          envs.length
            ? envs.map(([e, n], i) => (
                <span key={e}>
                  {i > 0 && " · "}
                  {part(`${n} ${ENV_LABEL[e]}`, `Show the ${ENV_LABEL[e]} apps`, { env: e }, only({ env: e }))}
                </span>
              ))
            : "–"
        }
      />
      <Stat
        label="Need a look"
        onClick={up && flagged ? () => onFilter(only({ look: true }) ? {} : { look: true }) : undefined}
        title={up && flagged ? "Show them" : undefined}
        active={only({ look: true }) || only({ flag: "debug" }) || only({ flag: "missing" }) || only({ live: "down" })}
        value={!up ? "–" : flagged}
        tone={missing || down ? "bad" : debug ? "warn" : undefined}
        sub={
          !up ? (
            "not checked yet"
          ) : flagged ? (
            <>
              {[
                missing > 0 && part(`${missing} folder missing`, "Show the ones whose folder is missing", { flag: "missing" }, only({ flag: "missing" })),
                debug > 0 && part(`${debug} APP_DEBUG on`, "Show the ones with APP_DEBUG on", { flag: "debug" }, only({ flag: "debug" })),
                down > 0 && part(`${down} in maintenance`, "Show the ones in maintenance mode", { live: "down" }, only({ live: "down" })),
              ]
                .filter(Boolean)
                .map((x, i) => (
                  <span key={i}>
                    {i > 0 && " · "}
                    {x}
                  </span>
                ))}
            </>
          ) : (
            `all fine · checked ${agoS(up.at, now)}`
          )
        }
      />
      <Stat
        label="Last discover"
        onClick={discoveredIds.length ? () => onFilter(f.ids?.label === "Added by Discover" ? {} : { ids: { label: "Added by Discover", set: discoveredIds } }) : undefined}
        title={discoveredIds.length ? `Show the ${discoveredIds.length} added by Discover` : undefined}
        active={f.ids?.label === "Added by Discover"}
        value={lastDiscover ? agoS(lastDiscover.at, now) : "never"}
        sub={
          lastDiscover ? (
            <span title={new Date(lastDiscover.at * 1000).toLocaleString()}>
              {lastDiscover.found ? `found ${lastDiscover.found} new` : "nothing new"} · {new Date(lastDiscover.at * 1000).toLocaleDateString()}
            </span>
          ) : (
            "not run here yet"
          )
        }
      />
      <Stat
        label="Added · 30 days"
        onClick={addedIds.length ? () => onFilter(f.ids?.label === "Added in 30 days" ? {} : { ids: { label: "Added in 30 days", set: addedIds } }) : undefined}
        title={addedIds.length ? `Show the ${addedIds.length} added in the last 30 days` : undefined}
        active={f.ids?.label === "Added in 30 days"}
        value={log?.since ? `${added.length}${removed ? ` · ${removed} removed` : ""}` : "–"}
        sub={
          lastAdd ? (
            <span title={new Date(lastAdd.at * 1000).toLocaleString()}>
              last: {nameOf(lastAdd.appId)}, {agoS(lastAdd.at, now)}
              {lastAdd.via ? ` (${lastAdd.via})` : ""}
            </span>
          ) : log?.since ? (
            `counted since ${new Date(log.since * 1000).toLocaleDateString()}`
          ) : (
            "counted from the next one added"
          )
        }
      />
    </div>
  );
}

function AppsGrid({ server, apps, status }: { server: Server; apps: App[]; status: (a: App) => React.ReactNode }) {
  const shots = useShots((s) => s.map);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-x-5 gap-y-6">
      {apps.map((a) => {
        const e = shots[shotKey(server.id, a.id)];
        const open = () => openDetails({ kind: "app", serverId: server.id, appId: a.id });
        return (
          <div key={a.id} className="group flex min-w-0 flex-col gap-2">
            <button
              onClick={open}
              title={`Open ${a.name}'s tab`}
              className="relative aspect-[16/10] cursor-pointer overflow-hidden rounded-xl border border-divider bg-panel shadow-sm transition-shadow hover:shadow-md"
            >
              {e?.shot ? (
                <img src={e.shot.data} alt="" draggable={false} className={cn("size-full object-cover object-top", e.busy && "opacity-60")} />
              ) : (
                <span className="flex size-full flex-col items-center justify-center gap-2 px-4 text-center">
                  <Badge id={`${server.id}/${a.id}`} name={a.name} size={40} />
                  <span className="line-clamp-2 text-[11px] text-subtle-foreground">
                    {!a.url ? "No URL: set one in its Settings for a picture" : e?.busy ? "Taking a picture…" : e?.error ? e.error : ""}
                  </span>
                </span>
              )}
              {e?.busy && (
                <span className="absolute top-2 right-2 rounded-full bg-background/90 p-1 shadow-sm">
                  <Spinner size={11} />
                </span>
              )}
              {a.url && !e?.busy && (
                <span
                  role="button"
                  tabIndex={-1}
                  title="Take its picture again"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    takeShot(server.id, a.id);
                  }}
                  className="absolute top-2 right-2 hidden rounded-full bg-background/90 p-1 text-subtle-foreground shadow-sm group-hover:block hover:text-foreground"
                >
                  <RotateCw className="size-3" />
                </span>
              )}
            </button>
            <div className="flex min-w-0 items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-semibold">{a.name}</span>
                {a.url ? (
                  <button
                    className="flex w-fit max-w-full cursor-pointer items-center gap-1 truncate text-[11.5px] text-primary hover:underline"
                    onClick={() => void openUrl(a.url!).catch((err) => toastError(errorMessage(err)))}
                  >
                    <span className="truncate">{a.url.replace(/^https?:\/\//, "")}</span>
                    <ExternalLink className="size-3 flex-none" />
                  </button>
                ) : (
                  <span className="truncate font-mono text-[10.5px] text-subtle-foreground">{a.path}</span>
                )}
                <span className="flex flex-wrap items-center gap-x-2 text-[11px]">{status(a)}</span>
                <div className="pt-1.5">
                  <AppSwitchesCompact server={server} app={a} />
                </div>
              </div>
              <Btn size="sm" variant="outline" onClick={open}>
                Open
              </Btn>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A server's Overview: what the background checks last found, with what
 *  needs attention first. Nothing is read from the server to show it. */
export function ServerOverview({ server }: { server: Server }) {
  const snap = useWatch((s) => s.snapshot);
  const settings = useWatch((s) => s.settings);
  const now = useClock();
  const w = snap?.servers[server.id];
  const running = snap?.running.includes(server.id) ?? false;
  const s: WatchSettings | null = settings;
  const sys = w?.system;
  const up = w?.updates;
  const certs = w?.certs;
  const setup = w?.setup;
  const skipped = s?.skip.includes(server.id);

  return (
    <div className="light-ui absolute inset-0 overflow-y-auto bg-background text-foreground">
      <div className="flex w-full flex-col gap-4 px-5 py-5">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">{server.name}</span>
          <EnvTag env={server.env} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-subtle-foreground">
            {skipped ? "Not checked in the background (Settings ▸ Checks)" : "From the background checks: nothing is read from the server to show this."}
          </span>
          <Group>
            <Tool label="Check now" title="Check now (every check, read-only)" disabled={running} onClick={() => void useWatch.getState().refresh([server.id]).catch((e) => toastError(errorMessage(e)))}>
              {running ? <Spinner size={13} /> : <RefreshCw className="size-[16px]" strokeWidth={1.6} />}
            </Tool>
          </Group>
        </div>

        <section className="overflow-hidden rounded-xl border border-divider bg-panel">
          <div className="flex h-10 items-center border-b border-divider px-3.5 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">Needs attention</div>
          <AttentionList servers={[server]} showServer={false} empty={w ? "Nothing: all checks are fine." : "Not checked yet. Check now reads it (read-only)."} />
        </section>

        <ServerLogins server={server} />

        {server.asg && (
          <div className="flex flex-wrap gap-2">
            <Btn size="sm" variant="outline" onClick={() => useFleetUi.getState().openPick(server)}>
              Shell on one instance…
            </Btn>
            <Btn size="sm" variant="outline" onClick={() => useFleetUi.getState().openForward(server)} title="Forward an RDS database to 127.0.0.1 through an instance">
              Forward DB…
            </Btn>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title="Disks" at={sys?.at ?? null} section="monitor" server={server}>
            {!sys && <Dim>Not checked yet</Dim>}
            {sys?.value.disks.map((d) => {
              const p = pct(d.usedKb, d.availKb);
              const inodes = sys.value.inodes.find(([m]) => m === d.mount)?.[1];
              return (
                <div key={d.mount} className="flex items-center gap-2">
                  <span className="w-[120px] truncate font-mono text-[12px]">{d.mount}</span>
                  <Bar value={p} warn={s?.diskWarn ?? 80} urgent={s?.diskUrgent ?? 90} />
                  <span className="w-10 text-right font-mono text-[12px]">{p}%</span>
                  <Dim>
                    {gb(d.availKb)} free of {gb(d.sizeKb)}
                    {inodes !== undefined && inodes >= 50 ? ` · inodes ${inodes}%` : ""}
                  </Dim>
                </div>
              );
            })}
          </Card>
          <Card title="Load and memory" at={sys?.at ?? null} section="monitor" server={server}>
            {!sys && <Dim>Not checked yet</Dim>}
            {sys && (
              <>
                <span>
                  Load {sys.value.load.map((l) => l.toFixed(2)).join(" · ")} <Dim>on {sys.value.cores} CPU{sys.value.cores === 1 ? "" : "s"}</Dim>
                </span>
                {sys.value.memTotalKb > 0 && (
                  <span className="flex items-center gap-2">
                    Memory
                    <Bar value={100 - (sys.value.memAvailableKb * 100) / sys.value.memTotalKb} warn={s?.memWarn ?? 90} urgent={101} />
                    <Dim>
                      {gb(sys.value.memAvailableKb)} free of {gb(sys.value.memTotalKb)}
                    </Dim>
                  </span>
                )}
                <span>{sys.value.swapTotalKb > 0 ? <>Swap {gb(sys.value.swapTotalKb - sys.value.swapFreeKb)} used of {gb(sys.value.swapTotalKb)}</> : <Dim>No swap</Dim>}</span>
                <span>{sys.value.failedUnits.length ? <span className="text-env-prod-fg">Failed: {sys.value.failedUnits.join(", ")}</span> : <Dim>No failed services</Dim>}</span>
              </>
            )}
          </Card>
          <Card title="Updates" at={up?.at ?? null} section="health" server={server}>
            {!up && <Dim>Not checked yet</Dim>}
            {up && (
              <>
                <span>
                  {up.value.os || "Linux"} <Dim>· up {Math.floor(up.value.uptimeS / 86_400)} days</Dim>
                </span>
                <span>
                  {up.value.updates === null ? (
                    <Dim>Pending updates aren't known here (apt-check isn't on it)</Dim>
                  ) : (
                    <>
                      {up.value.updates} pending, <span className={(up.value.security ?? 0) > 0 ? "text-env-prod-fg" : ""}>{up.value.security ?? 0} security</span>
                    </>
                  )}
                </span>
                {up.value.rebootRequired && <span className="text-[#8a5a12]">Restart needed{up.value.rebootSince ? ` (since ${agoS(up.value.rebootSince, now)})` : ""}</span>}
              </>
            )}
          </Card>
          <Card title="Certificates" at={certs?.at ?? null} section="health" server={server}>
            {!certs && <Dim>Not checked yet</Dim>}
            {certs && certs.value.certs.length === 0 && <Dim>No https sites found</Dim>}
            {certs?.value.certs.map((c) => {
              const d = c.notAfter ? Math.floor((c.notAfter - now) / 86_400) : null;
              return (
                <div key={c.name} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{c.name}</span>
                  <span
                    className={cn(
                      "font-mono text-[12px]",
                      c.missing || !c.covers ? "text-env-prod-fg" : d === null ? "" : d <= (s?.certUrgentDays ?? 7) ? "text-env-prod-fg" : d <= (s?.certWarnDays ?? 21) ? "text-[#8a5a12]" : "text-[#17702a]",
                    )}
                  >
                    {c.missing ? "none" : !c.covers ? "wrong name" : d === null ? "?" : d < 0 ? "expired" : `${d} d`}
                  </span>
                </div>
              );
            })}
            {certs && certs.value.certs.length > 0 && <Dim>{certs.value.renew.length ? `Renewed by ${certs.value.renew.join(", ")}` : "Nothing seems to renew them"}</Dim>}
          </Card>
          <Card title="Apps" at={up?.at ?? null} section="apps" server={server}>
            {server.apps.length === 0 && <Dim>No apps yet: Open ▸ Discover apps… or Add app</Dim>}
            {server.apps.length > 0 && (() => {
              const flagged = server.apps.flatMap((a) => {
                const st = up?.value.apps.find((x) => x.id === a.id);
                const what = !st ? [] : st.missing ? ["folder missing"] : [...(st.downSince ? ["maintenance"] : []), ...(st.appDebug ? ["APP_DEBUG on"] : [])];
                return what.length ? [{ a, what: what.join(", "), bad: !!st?.missing || (!!st?.appDebug && (a.env === "prod" || st.appEnv === "production")) }] : [];
              });
              const st = up?.value.apps ?? [];
              const n = { debug: st.filter((x) => x.appDebug).length, down: st.filter((x) => x.downSince).length, missing: st.filter((x) => x.missing).length };
              const envs = (["prod", "staging", "qa", "dev"] as Env[]).map((e) => [e, server.apps.filter((a) => a.env === e).length] as const).filter(([, c]) => c > 0);
              const link = (label: string, g: Partial<AppFilter>, title: string, tone?: string) => (
                <button key={label} className={cn("cursor-pointer rounded hover:text-primary hover:underline", tone)} title={title} onClick={() => showApps(server, g)}>
                  {label}
                </button>
              );
              const dot = (items: React.ReactNode[]) =>
                items.map((x, i) => (
                  <span key={i}>
                    {i > 0 && <Dim> · </Dim>}
                    {x}
                  </span>
                ));
              const MAX = 6;
              return (
                <>
                  <span>
                    {link(`${server.apps.length} app${server.apps.length === 1 ? "" : "s"}`, {}, "Show them all")}
                    {envs.length > 1 && (
                      <>
                        <Dim>: </Dim>
                        {dot(envs.map(([e, c]) => link(`${c} ${ENV_LABEL[e]}`, { env: e }, `Show the ${ENV_LABEL[e]} apps`)))}
                      </>
                    )}
                  </span>
                  {up && (
                    <span>
                      {flagged.length ? (
                        dot([
                          link(`${flagged.length} to look at`, { look: true }, "Show them"),
                          ...(n.missing ? [link(`${n.missing} folder missing`, { flag: "missing" }, "Show the ones whose folder is missing", "text-env-prod-fg")] : []),
                          ...(n.debug ? [link(`${n.debug} APP_DEBUG on`, { flag: "debug" }, "Show the ones with APP_DEBUG on", "text-[#8a5a12]")] : []),
                          ...(n.down ? [link(`${n.down} in maintenance`, { live: "down" }, "Show the ones in maintenance mode", "text-[#8a5a12]")] : []),
                        ])
                      ) : (
                        <Dim>nothing to look at</Dim>
                      )}
                    </span>
                  )}
                  {flagged.slice(0, MAX).map(({ a, what, bad }) => (
                    <div key={a.id} className="flex items-center gap-2">
                      <button className="w-[160px] cursor-pointer truncate text-left hover:text-primary hover:underline" title={`Open ${a.name}'s tab`} onClick={() => openDetails({ kind: "app", serverId: server.id, appId: a.id })}>
                        {a.name}
                      </button>
                      <span className={bad ? "text-env-prod-fg" : "text-subtle-foreground"}>{what}</span>
                    </div>
                  ))}
                  {flagged.length > MAX && <span>{link(`+${flagged.length - MAX} more`, { look: true }, "Show them all in Apps", "text-primary")}</span>}
                </>
              );
            })()}
          </Card>
          <Card title="Setup" at={setup?.at ?? null} section="setup" server={server}>
            {!setup && <Dim>No profile, or not checked yet</Dim>}
            {setup && (
              <>
                <span>
                  Profile {setup.value.profile}: <span className="text-[#17702a]">✓ {setup.value.ok}</span>
                  {setup.value.bad > 0 && <span className="text-env-prod-fg"> ✗ {setup.value.bad}</span>}
                  {setup.value.warn > 0 && <span className="text-[#8a5a12]"> ! {setup.value.warn}</span>}
                </span>
                {setup.value.failing.length > 0 && <Dim>{setup.value.failing.join(", ")}</Dim>}
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
