import { Copy, MoreHorizontal, Pause, Play, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Segmented } from "@/components/manage/fields";
import { PopupMenu } from "@/components/kit/PopupMenu";
import { copyText } from "@/lib/clipboard";
import { ptySpawner } from "@/lib/terminalSession";
import { useTabs, type Tab } from "@/stores/tabs";
import { errorMessage, monitorSample, type MonitorProc, type MonitorSample } from "@/lib/ipc";
import { LEVEL_BAR, LEVEL_TEXT, levelOf, THRESHOLDS, worst, type Level, type Metric } from "@/lib/thresholds";
import { cn } from "@/lib/utils";
import { useDiskAlerts } from "@/stores/diskAlerts";

const EVERY_MS = 5000;
const KEEP = 60; // 5 minutes of 5 s samples

/** Sparkline history per server, kept while the app runs (tab switches). */
const history = new Map<string, { cpu: number[]; mem: number[] }>();

function size(kb: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  let v = kb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function uptime(s: number): string {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

const textColor = LEVEL_TEXT;
const barColor = LEVEL_BAR;
/** Disk/CPU-style percentages. */
const level = (pct: number, metric: Metric = "disk") => levelOf(metric, pct);

/** CPU, memory, disks and the top processes of one server, polled over ssh
 *  every 5 s while visible (read-only; see src-tauri/src/monitor.rs). */
export function MonitorView({ tab, title, visible }: { tab: Tab; title: string; visible: boolean }) {
  const serverId = tab.serverId ?? "";
  const [menu, setMenu] = useState<{ x: number; y: number; proc: MonitorProc } | null>(null);

  /** A shell on this server in a pane under the monitor, typing `cmds`. */
  const investigate = (what: string, cmds: string[], submit = true) => {
    const id = useTabs.getState().open({
      kind: "ssh",
      title: `${serverId} · ${what}`,
      host: tab.host,
      serverId,
      prod: tab.prod,
      spawn: ptySpawner({ kind: "ssh", host: tab.host ?? "" }),
      into: { from: tab.id, dir: "col" },
    });
    useTabs.getState().tabs.find((t) => t.id === id)?.session.typeAtPrompt(cmds, { submit });
  };
  const [sample, setSample] = useState<MonitorSample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const [sort, setSort] = useState<"cpu" | "mem">("cpu");
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!visible || paused) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      clearTimeout(timer);
      setBusy(true);
      try {
        const s = await monitorSample(serverId);
        if (!live) return;
        const h = history.get(serverId) ?? { cpu: [], mem: [] };
        h.cpu = [...h.cpu, s.cpuPct].slice(-KEEP);
        h.mem = [...h.mem, s.memTotalKb ? (1 - s.memAvailableKb / s.memTotalKb) * 100 : 0].slice(-KEEP);
        history.set(serverId, h);
        useDiskAlerts.getState().record(serverId, s.disks);
        setSample(s);
        setError(null);
        setAt(Date.now());
      } catch (e) {
        if (live) setError(errorMessage(e));
      } finally {
        if (live) {
          setBusy(false);
          timer = setTimeout(run, EVERY_MS);
        }
      }
    };
    kick.current = () => void run();
    void run();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [serverId, visible, paused]);

  // "updated 3 s ago"
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const h = history.get(serverId);
  const memUsedPct = sample && sample.memTotalKb ? (1 - sample.memAvailableKb / sample.memTotalKb) * 100 : 0;
  const procs: MonitorProc[] = sample ? (sort === "cpu" ? sample.topCpu : sample.topMem) : [];
  const cpuLevel = sample ? levelOf("cpu", sample.cpuPct) : "ok";
  const memLevel = levelOf("mem", memUsedPct);
  const loadPerCore = sample ? sample.load[0] / Math.max(1, sample.cores) : 0;
  const loadLevel = levelOf("load", loadPerCore);
  const swapPct = sample && sample.swapTotalKb ? (1 - sample.swapFreeKb / sample.swapTotalKb) * 100 : 0;
  const swapLevel = levelOf("swap", swapPct);
  const diskPcts = sample ? sample.disks.map((d) => (d.sizeKb ? (d.usedKb / d.sizeKb) * 100 : 0)) : [];
  const diskLevel = worst(...diskPcts.map((p) => levelOf("disk", p)));
  const fullDisks = sample ? sample.disks.filter((_, i) => diskPcts[i]! >= THRESHOLDS.disk.bad) : [];

  return (
    <div className="absolute inset-0 overflow-y-auto bg-terminal px-6 py-5 text-[13px] text-foreground">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[16px] font-semibold">{title}</span>
            <span className="truncate text-[11.5px] text-subtle-foreground">
              {sample
                ? `${sample.os || "Linux"} · ${sample.kernel} · up ${uptime(sample.uptimeS)} · ${sample.cores} core${sample.cores === 1 ? "" : "s"}`
                : "Connecting…"}
            </span>
          </div>
          <span className="text-[11.5px] text-subtle-foreground">
            {paused ? "paused" : busy && !sample ? "measuring…" : at ? `updated ${Math.max(0, Math.round((Date.now() - at) / 1000))}s ago` : ""}
          </span>
          <IconBtn title="Refresh now" onClick={() => kick.current()} disabled={paused}>
            <RefreshCw className={cn("size-4", busy && "animate-spin")} />
          </IconBtn>
          <IconBtn title={paused ? "Resume (every 5 s)" : "Pause"} onClick={() => setPaused((p) => !p)}>
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          </IconBtn>
        </div>

        {error && (
          <div className="rounded-lg border border-[#ff5555]/40 bg-[#ff5555]/10 px-3 py-2 text-[12.5px] text-[#ff8a8a]">
            {error}
            {sample && <span className="text-subtle-foreground"> · showing the last good sample</span>}
          </div>
        )}

        {fullDisks.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-[#ff5555]/50 bg-[#ff5555]/12 px-3 py-2 text-[12.5px] text-[#ff8a8a]">
            <span className="text-[15px]">⚠</span>
            <span>
              Disk almost full:{" "}
              {fullDisks.map((d) => `${d.mount} ${((d.usedKb / d.sizeKb) * 100).toFixed(0)}% (${size(d.availKb)} free)`).join(" · ")}
            </span>
          </div>
        )}

        {sample && (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Card title="CPU" level={worst(cpuLevel, loadLevel)}>
                <div className="flex items-baseline gap-2">
                  <span className={cn("text-[28px] font-semibold tabular-nums", textColor[cpuLevel])}>
                    {sample.cpuPct.toFixed(0)}%
                  </span>
                  <span
                    className="text-[11.5px] text-subtle-foreground"
                    title={`1-minute load per core: ${loadPerCore.toFixed(2)} (amber ≥ ${THRESHOLDS.load.warn}, red ≥ ${THRESHOLDS.load.bad})`}
                  >
                    load{" "}
                    <span className={textColor[loadLevel]}>{sample.load[0].toFixed(2)}</span>{" "}
                    {sample.load.slice(1).map((l) => l.toFixed(2)).join(" ")}
                  </span>
                </div>
                <Spark values={h?.cpu ?? []} />
                <span className="text-[11px] text-subtle-foreground">last 5 min</span>
              </Card>
              <Card title="Memory" level={worst(memLevel, swapLevel)}>
                <div className="flex items-baseline gap-2">
                  <span className={cn("text-[28px] font-semibold tabular-nums", textColor[memLevel])}>
                    {memUsedPct.toFixed(0)}%
                  </span>
                  <span className="text-[11.5px] text-subtle-foreground">
                    {size(sample.memTotalKb - sample.memAvailableKb)} / {size(sample.memTotalKb)}
                  </span>
                </div>
                <Spark values={h?.mem ?? []} />
                <span className="text-[11px] text-subtle-foreground">
                  cache {size(sample.memCacheKb)} · swap{" "}
                  {sample.swapTotalKb ? (
                    <span className={swapLevel === "ok" ? undefined : textColor[swapLevel]}>
                      {size(sample.swapTotalKb - sample.swapFreeKb)} / {size(sample.swapTotalKb)}
                    </span>
                  ) : (
                    "none"
                  )}
                </span>
              </Card>
              <Card title="Storage" level={diskLevel}>
                <div className="flex flex-col gap-2.5">
                  {sample.disks.map((d) => {
                    const pct = d.sizeKb ? (d.usedKb / d.sizeKb) * 100 : 0;
                    return (
                      <div key={d.mount} className="flex flex-col gap-1" title={d.fs}>
                        <div className="flex items-baseline gap-2 text-[12px]">
                          <span className="min-w-0 flex-1 truncate font-mono">{d.mount}</span>
                          <span className={cn("tabular-nums", textColor[level(pct)])}>{pct.toFixed(0)}%</span>
                          <span className="text-[11px] text-subtle-foreground">
                            {size(d.availKb)} free of {size(d.sizeKb)}
                          </span>
                        </div>
                        <Bar pct={pct} />
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.03]">
              <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
                <span className="flex-1 text-[12px] font-semibold tracking-wide text-subtle-foreground uppercase">Top 10 processes</span>
                <Segmented
                  label="Sort processes"
                  value={sort}
                  onChange={setSort}
                  options={[
                    { value: "cpu", label: "By CPU" },
                    { value: "mem", label: "By memory" },
                  ]}
                />
              </div>
              <table className="w-full table-fixed text-[12px]">
                <thead className="text-left text-[11px] text-subtle-foreground">
                  <tr>
                    <th className="w-[72px] px-4 py-1.5 font-medium">PID</th>
                    <th className="w-[110px] py-1.5 font-medium">User</th>
                    <th className="w-[70px] py-1.5 text-right font-medium">CPU%</th>
                    <th className="w-[70px] py-1.5 text-right font-medium">MEM%</th>
                    <th className="w-[84px] py-1.5 text-right font-medium">Memory</th>
                    <th className="w-[90px] py-1.5 pr-4 text-right font-medium" title={sort === "cpu" ? "CPU time" : "Running for"}>
                      {sort === "cpu" ? "CPU time" : "Running"}
                    </th>
                    <th className="py-1.5 font-medium">Command</th>
                    <th className="w-[40px] py-1.5 pr-2" />
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {procs.map((p) => (
                    <tr
                      key={p.pid}
                      className="group/row border-t border-white/5 hover:bg-white/[0.04]"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, proc: p });
                      }}
                    >
                      <td className="px-4 py-1">
                        <PidCell pid={p.pid} />
                      </td>
                      <td className="truncate py-1.5">{p.user}</td>
                      <td className={cn("py-1.5 text-right tabular-nums", level(p.cpu, "cpu") !== "ok" && textColor[level(p.cpu, "cpu")])}>
                        {p.cpu.toFixed(1)}
                      </td>
                      <td className={cn("py-1.5 text-right tabular-nums", level(p.memPct, "mem") !== "ok" && textColor[level(p.memPct, "mem")])}>
                        {p.memPct.toFixed(1)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{size(p.rssKb)}</td>
                      <td className="py-1.5 pr-4 text-right tabular-nums text-subtle-foreground">{p.time}</td>
                      <td className="selectable truncate py-1.5" title={p.command}>
                        {p.command}
                      </td>
                      <td className="py-1 pr-2 text-right">
                        <button
                          title="Investigate this process"
                          aria-label={`Investigate process ${p.pid}`}
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setMenu({ x: r.right - 240, y: r.bottom + 2, proc: p });
                          }}
                          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-subtle-foreground opacity-50 group-hover/row:opacity-100 hover:bg-white/10 hover:text-foreground"
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {procs.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-3 text-subtle-foreground">
                        No process list (top/ps not available?)
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          title={`PID ${menu.proc.pid} · ${menu.proc.command.slice(0, 48)}`}
          onClose={() => setMenu(null)}
          groups={processMenu(menu.proc, investigate)}
        />
      )}
    </div>
  );
}

/** What "investigate" can do with a process: commands typed into a shell
 *  on the same server, opened as a pane under the monitor. */
function processMenu(p: MonitorProc, investigate: (title: string, cmds: string[], submit?: boolean) => void) {
  const pid = p.pid;
  return [
    [
      { label: "Copy PID", hint: String(pid), run: () => void copyText(String(pid)) },
      { label: "Copy command", run: () => void copyText(p.command) },
    ],
    [
      {
        label: "Details",
        hint: "ps, folder, binary",
        run: () =>
          investigate("details", [
            `ps -o pid,ppid,user,%cpu,%mem,rss,etime,lstart,args -p ${pid}; ls -l /proc/${pid}/cwd /proc/${pid}/exe 2>&1`,
          ]),
      },
      { label: "Watch it live", hint: "top -p", run: () => investigate("top", [`top -p ${pid}`]) },
      {
        label: "Process tree",
        hint: "parents, children",
        run: () =>
          investigate("tree", [
            `pstree -aps ${pid} 2>/dev/null || ps -o pid,ppid,user,args --forest -g "$(ps -o sid= -p ${pid} | tr -d ' ')"`,
          ]),
      },
      {
        label: "Open files & connections",
        run: () =>
          investigate("files", [
            `ls -l /proc/${pid}/fd 2>&1 | head -60; echo; ss -tanp 2>/dev/null | grep "pid=${pid}," || echo "(no TCP connections visible; try with sudo)"`,
          ]),
      },
    ],
    [
      // Typed, not run: you look at it and press ↵ yourself.
      { label: "Trace system calls…", hint: "types strace", run: () => investigate("strace", [`sudo strace -f -tt -p ${pid}`], false) },
      { label: "Stop it…", hint: "types kill", run: () => investigate("kill", [`kill ${pid}`], false) },
    ],
  ];
}

const CARD_EDGE: Record<Level, string> = {
  ok: "border-white/10",
  warn: "border-[#ffb86c]/60 shadow-[inset_3px_0_0_#ffb86c]",
  bad: "border-[#ff5555]/70 shadow-[inset_3px_0_0_#ff5555]",
};

/** Click to copy the PID (for kill, strace, ps -p … in a shell). */
function PidCell({ pid }: { pid: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      title="Copy PID"
      onClick={async () => {
        if (await copyText(String(pid))) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }
      }}
      className={cn(
        "group -mx-1.5 flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 tabular-nums hover:bg-white/10 hover:text-foreground",
        copied ? "text-[#50fa7b]" : "text-subtle-foreground",
      )}
    >
      {copied ? "copied" : pid}
      {!copied && <Copy className="size-3 opacity-0 group-hover:opacity-70" />}
    </button>
  );
}

function Card({ title, level: lvl = "ok", children }: { title: string; level?: Level; children: React.ReactNode }) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2 rounded-xl border bg-white/[0.03] px-4 py-3", CARD_EDGE[lvl])}>
      <span className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-subtle-foreground uppercase">
        {title}
        {lvl !== "ok" && <span className={cn("text-[10.5px] normal-case", textColor[lvl])}>{lvl === "bad" ? "critical" : "high"}</span>}
      </span>
      {children}
    </section>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-white/10">
      <div className={cn("h-full rounded-full", barColor[level(pct)])} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const w = 240;
  const hgt = 44;
  if (values.length < 2) return <div style={{ height: hgt }} className="rounded-md bg-white/[0.03]" />;
  const step = w / (KEEP - 1);
  const x0 = w - (values.length - 1) * step;
  const pts = values.map((v, i) => `${(x0 + i * step).toFixed(1)},${(hgt - (Math.min(100, v) / 100) * (hgt - 2) - 1).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${w} ${hgt}`} preserveAspectRatio="none" className="h-11 w-full rounded-md bg-white/[0.03]">
      <polyline points={`${x0},${hgt} ${pts.join(" ")} ${w},${hgt}`} fill="rgb(189 147 249 / 0.18)" stroke="none" />
      <polyline points={pts.join(" ")} fill="none" stroke="#bd93f9" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function IconBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-subtle-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}
