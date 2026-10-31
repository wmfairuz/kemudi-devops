// The background checks' results, shown: Needs attention (Home and a
// server's Overview), the fleet grid (Home) and a server's Overview.
import { AlertTriangle, BellOff, Bug, Cpu, Database, HardDrive, Lock, MemoryStick, RefreshCw, RotateCw, ShieldAlert, Unplug, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { PopupMenu } from "@/components/kit/PopupMenu";
import { Spinner } from "@/components/kit/Spinner";
import { StatusDot } from "@/components/kit/StatusDot";
import { errorMessage, type Server, type ServerWatch, type WatchItem, type WatchSettings } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { openDetails } from "@/stores/manage";
import { useStatus } from "@/stores/status";
import { openServer, type ServerSection } from "@/stores/tabs";
import { toastError } from "@/stores/toasts";
import { agoS, useWatch } from "@/stores/watch";

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
      return <Database className={c} />;
    default:
      return <AlertTriangle className={c} />;
  }
}

const SEV_TEXT = { urgent: "text-env-prod-fg", warn: "text-[#8a5a12]", info: "text-subtle-foreground" } as const;

/** Where an item is looked into (and fixed). */
function actionOf(item: WatchItem, server: Server): { label: string; run: () => void } | null {
  const go = (section: ServerSection, label: string) => ({ label, run: () => void openServer(server, section) });
  switch (item.kind) {
    case "disk":
    case "inodes":
    case "memory":
    case "swap":
    case "load":
      return go("monitor", "Monitor");
    case "failed":
    case "security":
    case "updates":
    case "reboot":
    case "cert":
    case "renew":
      return go("health", "Health");
    case "down":
      return go("dash", "Dashboard");
    case "setup":
      return go("setup", "Setup");
    case "debug":
    case "missing":
      return item.appId ? { label: "App page", run: () => openDetails({ kind: "app", serverId: server.id, appId: item.appId }) } : null;
    case "unreachable":
      return { label: "Probe again", run: () => void useStatus.getState().refresh([server.id]) };
    case "error":
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
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4 px-6 py-5">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">{server.name}</span>
          <EnvTag env={server.env} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-subtle-foreground">
            {skipped ? "Not checked in the background (Settings ▸ Checks)" : "From the background checks: nothing is read from the server to show this."}
          </span>
          <Btn size="sm" variant="outline" disabled={running} onClick={() => void useWatch.getState().refresh([server.id]).catch((e) => toastError(errorMessage(e)))}>
            {running ? <Spinner size={11} /> : <RefreshCw className="size-3.5" />} Check now
          </Btn>
        </div>

        <section className="overflow-hidden rounded-xl border border-divider bg-panel">
          <div className="flex h-10 items-center border-b border-divider px-3.5 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">Needs attention</div>
          <AttentionList servers={[server]} showServer={false} empty={w ? "Nothing: all checks are fine." : "Not checked yet. Check now reads it (read-only)."} />
        </section>

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
          <Card title="Apps" at={up?.at ?? null} section="dash" server={server}>
            {server.apps.length === 0 && <Dim>No apps</Dim>}
            {server.apps.map((a) => {
              const st = up?.value.apps.find((x) => x.id === a.id);
              return (
                <div key={a.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {!st ? (
                    <Dim>–</Dim>
                  ) : st.missing ? (
                    <span className="text-env-prod-fg">folder missing</span>
                  ) : (
                    <>
                      {st.downSince && <span className="text-[#8a5a12]">maintenance since {agoS(st.downSince, now)}</span>}
                      {st.appDebug && <span className={a.env === "prod" || st.appEnv === "production" ? "text-env-prod-fg" : "text-subtle-foreground"}>APP_DEBUG on</span>}
                      <Dim>{st.appEnv ?? "no .env"}</Dim>
                    </>
                  )}
                </div>
              );
            })}
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
