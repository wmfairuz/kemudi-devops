import { ChevronRight, Copy, RotateCcw, RotateCw, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { copyText } from "@/lib/clipboard";
import { errorMessage, queuesAct, queuesFailedDetail, queuesStatus, type FailedJob, type QueueAct, type QueueStatus } from "@/lib/ipc";
import { shortTime } from "@/lib/logParse";
import { cn } from "@/lib/utils";
import { findServer, useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { openLogs, type Tab } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

/** Refresh every this many ms while shown. */
const EVERY = 15000;

const STATE_STYLE: Record<string, string> = {
  RUNNING: "bg-emerald-500/12 text-emerald-700",
  STARTING: "bg-env-staging/15 text-env-staging-fg",
  BACKOFF: "bg-env-prod/12 text-env-prod-fg",
  FATAL: "bg-env-prod text-white",
  EXITED: "bg-env-prod/12 text-env-prod-fg",
  STOPPED: "bg-muted text-subtle-foreground",
  "NOT LOADED": "bg-env-staging/15 text-env-staging-fg",
};

function ago(secs: number): string {
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

/** `App\Jobs\SendInvoice` → name and namespace. */
function jobName(job: string): { name: string; ns: string } {
  const i = job.lastIndexOf("\\");
  return i < 0 ? { name: job, ns: "" } : { name: job.slice(i + 1), ns: job.slice(0, i + 1) };
}

interface Typed {
  title: string;
  message: string;
  word: string;
  confirm: string;
  resolve: (ok: boolean) => void;
}

/** A Queues tab: an app's workers, pending jobs, failed jobs (retry,
 *  forget, flush) and scheduler, refreshed while shown. */
export function QueuesView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const serverId = tab.serverId ?? "";
  const appId = tab.appId ?? "";
  const server = findServer(serverId);
  const app = server?.apps.find((a) => a.id === appId);
  const env = app?.env ?? server?.env ?? "dev";
  const prod = env === "prod";
  const term = useConfig((s) => s.snapshot?.config?.terminal);
  const font = { fontFamily: term?.fontFamily ?? 'Menlo, "SF Mono", monospace', fontSize: `${term?.fontSize ?? 14}px` };

  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, { exception: string; payload: string } | string>>({});
  const [showPayload, setShowPayload] = useState(false);
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState<Typed | null>(null);
  const [, tick] = useState(0);
  const inFlight = useRef(false);

  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const s = await queuesStatus(serverId, appId);
      setStatus(s);
      setError(null);
      setCheckedAt(Date.now());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  };

  // Refresh while shown; stop on an error (a refused sudo password must
  // not be retried every few seconds) until Refresh.
  useEffect(() => {
    if (!visible || error) return;
    if (!checkedAt || Date.now() - checkedAt > EVERY) void load();
    const t = setInterval(() => void load(), EVERY);
    const clock = setInterval(() => tick((n) => n + 1), 5000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, error]);

  const askTyped = (title: string, message: string, word: string, confirm: string) =>
    new Promise<boolean>((resolve) => setTyped({ title, message, word, confirm, resolve }));

  const act = async (what: QueueAct, args: string[], label: string) => {
    setBusy(label);
    try {
      const out = await queuesAct(serverId, appId, what, args);
      const line = out.split("\n").find((l) => l.trim())?.trim().replace(/^(INFO|DONE)\s+/, "");
      useToasts.getState().push(line || `${label}: done`, "info");
      if (what === "forget" || what === "flush") setOpen(null);
      await load();
    } catch (e) {
      toastError(`${label}: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const retry = async (j: FailedJob) => {
    if (prod && !(await askConfirm(`Retry ${jobName(j.job).name}?`, `It goes back onto the ${j.queue || "default"} queue on ${serverId} (production) and runs again.`, "Retry"))) return;
    await act("retry", [j.id], "Retry");
  };
  const forget = async (j: FailedJob) => {
    if (!(await askConfirm(`Forget ${jobName(j.job).name}?`, "Deletes this failed job (and its error) for good. It won't run again.", "Forget"))) return;
    await act("forget", [j.id], "Forget");
  };
  const retryAll = async () => {
    const n = status?.laravel?.failedTotal ?? 0;
    const msg = `Puts all ${n} failed jobs back onto their queues to run again.`;
    const ok = prod ? await askTyped(`Retry all failed jobs?`, `${msg} This is production.`, serverId, "Retry all") : await askConfirm("Retry all failed jobs?", msg, "Retry all");
    if (ok) await act("retryAll", [], "Retry all");
  };
  const flush = async () => {
    const n = status?.laravel?.failedTotal ?? 0;
    const msg = `Deletes all ${n} failed jobs and their errors for good.`;
    const ok = prod ? await askTyped("Flush all failed jobs?", `${msg} This is production.`, serverId, "Flush") : await askConfirm("Flush all failed jobs?", msg, "Flush");
    if (ok) await act("flush", [], "Flush");
  };
  const restartWorkers = async () => {
    if (prod && !(await askConfirm("Restart queue workers?", "Workers finish the job they're on, then restart with the current code (artisan queue:restart).", "Restart"))) return;
    await act("restart", [], "Restart workers");
  };
  const restartProgram = async (program: string) => {
    if (prod && !(await askConfirm(`Restart ${program}?`, "supervisorctl restart: running jobs are stopped and the workers start again.", "Restart"))) return;
    await act("restartProgram", [program], `Restart ${program}`);
  };

  const toggle = async (j: FailedJob) => {
    if (open === j.id) return setOpen(null);
    setOpen(j.id);
    setShowPayload(false);
    if (details[j.id] && typeof details[j.id] !== "string") return;
    try {
      const d = await queuesFailedDetail(serverId, appId, j.id);
      setDetails((m) => ({ ...m, [j.id]: d }));
    } catch (e) {
      setDetails((m) => ({ ...m, [j.id]: errorMessage(e) }));
    }
  };

  const L = status?.laravel ?? null;
  const failed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = L?.failed ?? [];
    return q ? list.filter((j) => `${j.job} ${j.queue} ${j.error}`.toLowerCase().includes(q)) : list;
  }, [L, query]);

  const workers = status?.workers ?? [];
  const up = workers.filter((w) => w.state === "RUNNING").length;
  const workerProcs = (status?.processes ?? []).filter((p) => !/schedule:work/.test(p.command));
  const pending = (L?.queues ?? []).reduce((n, q) => n + (q.size ?? 0), 0);
  const schedProc = (status?.processes ?? []).some((p) => /schedule:work/.test(p.command));
  const hasScheduler = (status?.scheduler.length ?? 0) > 0 || schedProc;
  const programs = [...new Set(workers.map((w) => w.program))];

  const Card = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "bad" | "warn" | "ok" }) => (
    <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border px-3 py-2", tone === "bad" ? "border-env-prod-line bg-env-prod/[0.05]" : tone === "warn" ? "border-env-staging/40 bg-env-staging/[0.06]" : "border-divider")}>
      <span className="text-[0.75em] tracking-wide text-subtle-foreground uppercase">{label}</span>
      <span className={cn("text-[1.25em] font-semibold", tone === "bad" && "text-env-prod-fg", tone === "ok" && "text-emerald-700")}>{value}</span>
      {sub && <span className="truncate text-[0.78em] text-subtle-foreground">{sub}</span>}
    </div>
  );

  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-3">
        <span className="text-[13px] font-semibold">Queues</span>
        <span className="text-[12.5px] text-subtle-foreground">{app?.name ?? appId} on {serverId}</span>
        {server && <EnvTag env={env} />}
        {L && (
          <span className="rounded bg-muted px-1.5 font-mono text-[11px] text-subtle-foreground" title={`queue.default = ${L.connection}; failed jobs: ${L.failedDriver}`}>
            {L.driver}
            {L.connection !== L.driver ? ` · ${L.connection}` : ""}
            {L.horizon && status?.processes.some((p) => /horizon/.test(p.command)) ? " · Horizon" : ""}
          </span>
        )}
        {status?.user && <span className="text-[11px] text-subtle-foreground" title="artisan runs as the owner of the app's storage/ folder">as {status.user}</span>}
        <span className="flex-1" />
        {checkedAt && <span className="text-[11px] text-subtle-foreground">{error ? "stopped" : `checked ${ago(Math.round((Date.now() - checkedAt) / 1000))} ago`}</span>}
        <Btn size="sm" variant="ghost" title="Refresh" aria-label="Refresh" onClick={() => {
          setError(null);
          void load();
        }}>
          <RotateCw className={cn("size-4", loading && "animate-spin")} />
        </Btn>
        {app && server && (
          <Btn size="sm" variant="ghost" title="The app's logs" onClick={() => openLogs(server, { appId, env, title: `${appId} · logs` })}>
            Logs
          </Btn>
        )}
        <Btn size="sm" variant="outline" disabled={!!busy || !status} onClick={() => void restartWorkers()} title="artisan queue:restart: workers finish their job, then restart with the current code">
          <RotateCcw className="size-3.5" /> Restart workers
        </Btn>
      </div>
      {error && (
        <div className="flex flex-none items-center gap-3 bg-env-prod/8 px-4 py-2 text-[12px] text-env-prod-fg">
          <span className="min-w-0 flex-1">{error}</span>
          <Btn size="sm" variant="outline" onClick={() => {
            setError(null);
            void load();
          }}>
            Try again
          </Btn>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" style={font}>
        {!status && !error && <div className="py-6 text-[0.9em] text-subtle-foreground">Asking {app?.name ?? appId}…</div>}
        {status && (
          <div className="flex flex-col gap-4">
            {status.laravelError && (
              <div className="rounded-lg bg-env-staging/10 px-3 py-2 text-[0.85em] text-env-staging-fg">
                Couldn't ask Laravel about its queues: <span className="selectable font-mono">{status.laravelError}</span>
              </div>
            )}
            <div className="flex gap-3">
              <Card
                label="Workers"
                value={workers.length ? `${up} / ${workers.length} running` : workerProcs.length ? `${workerProcs.length} running` : "none"}
                sub={
                  workers.length
                    ? `Supervisor: ${programs.join(", ")}`
                    : workerProcs.length
                      ? workerProcs.some((p) => p.unit)
                        ? `systemd: ${[...new Set(workerProcs.flatMap((p) => (p.unit ? [p.unit] : [])))].join(", ")}`
                        : "not under Supervisor or systemd"
                      : "no queue:work for this app"
                }
                tone={workers.length ? (up === workers.length ? "ok" : "bad") : workerProcs.length ? "ok" : L && L.driver !== "sync" ? "bad" : undefined}
              />
              <Card label="Waiting" value={L ? pending.toLocaleString() : "—"} sub={L ? (L.queues.map((q) => q.name).join(", ") || "no queues") : undefined} tone={pending > 100 ? "warn" : undefined} />
              <Card label="Failed" value={L ? L.failedTotal.toLocaleString() : "—"} sub={L?.failed[0] ? `last ${shortTime(L.failed[0].failedAt)}` : L ? "none" : undefined} tone={L && L.failedTotal > 0 ? "bad" : L ? "ok" : undefined} />
              <Card label="Scheduler" value={hasScheduler ? "on" : "off"} sub={hasScheduler ? (schedProc ? "schedule:work" : "cron: schedule:run") : "no schedule:run cron"} tone={hasScheduler ? "ok" : "warn"} />
            </div>

            <section className="flex flex-col gap-1">
              <h3 className="text-[0.8em] font-semibold tracking-wide text-subtle-foreground uppercase">Workers</h3>
              {workers.length === 0 && workerProcs.length === 0 && (
                <div className="text-[0.85em] text-subtle-foreground">
                  No Supervisor program or queue:work process for this app{L?.driver === "sync" ? " (its queue is sync: jobs run right away)" : ""}.
                </div>
              )}
              {workers.map((w, i) => (
                <div key={`${w.program}-${w.process ?? i}`} className="grid grid-cols-[7.5em_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-divider/60 py-1">
                  <span>
                    <span className={cn("inline-block rounded px-1.5 text-[0.72em] leading-[1.6] font-medium", STATE_STYLE[w.state] ?? "bg-muted text-subtle-foreground")}>{w.state}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="mr-2">{w.process ?? w.program}</span>
                    <span className="text-[0.85em] text-subtle-foreground">{w.info}</span>
                    <span className="block truncate text-[0.78em] text-subtle-foreground" title={`${w.command}\n${w.file}`}>
                      {w.command}
                    </span>
                  </span>
                  {workers.findIndex((x) => x.program === w.program) === i ? (
                    <Btn size="sm" variant="ghost" disabled={!!busy} onClick={() => void restartProgram(w.program)} title={`supervisorctl restart ${w.program}:*`}>
                      Restart
                    </Btn>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
              {workers.length === 0 &&
                workerProcs.map((p) => (
                  <div key={p.pid} className="grid grid-cols-[7.5em_minmax(0,1fr)] items-baseline gap-3 border-b border-divider/60 py-1">
                    <span className="text-[0.85em] text-subtle-foreground">pid {p.pid}</span>
                    <span className="min-w-0 truncate" title={p.command}>
                      <span className="text-[0.85em] text-subtle-foreground">up {ago(p.seconds)} · {p.user}{p.unit ? ` · ${p.unit}` : ""} · </span>
                      {p.command}
                    </span>
                  </div>
                ))}
            </section>

            {L && (
              <section className="flex flex-col gap-1">
                <h3 className="text-[0.8em] font-semibold tracking-wide text-subtle-foreground uppercase">Queues</h3>
                {L.queueError && <div className="text-[0.85em] text-env-staging-fg">{L.queueError}</div>}
                <div className="grid grid-cols-[minmax(0,14em)_7em_7em_7em] gap-x-3 text-subtle-foreground [&>span]:text-[0.78em]">
                  <span>Queue</span>
                  <span className="text-right">Waiting</span>
                  <span className="text-right">Delayed</span>
                  <span className="text-right">Running</span>
                </div>
                {L.queues.map((q) => (
                  <div key={q.name} className="grid grid-cols-[minmax(0,14em)_7em_7em_7em] gap-x-3 border-b border-divider/60 py-0.5">
                    <span className="truncate">{q.name}</span>
                    <span className={cn("text-right", (q.size ?? 0) > 100 && "text-env-staging-fg")}>{q.size ?? "?"}</span>
                    <span className="text-right text-subtle-foreground">{q.delayed ?? "—"}</span>
                    <span className="text-right text-subtle-foreground">{q.reserved ?? "—"}</span>
                  </div>
                ))}
              </section>
            )}

            {L && (
              <section className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-[0.8em] font-semibold tracking-wide text-subtle-foreground uppercase">
                    Failed jobs {L.failedTotal > 0 && <span className="text-env-prod-fg">{L.failedTotal.toLocaleString()}</span>}
                  </h3>
                  <span className="flex-1" />
                  {L.failed.length > 0 && (
                    <>
                      <div className="relative">
                        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
                        <input
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Filter"
                          spellCheck={false}
                          className="h-7 w-[14em] rounded-md border border-control-border bg-background pr-6 pl-7 text-[12px] outline-none focus:border-primary/60"
                        />
                        {query && (
                          <button className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer text-subtle-foreground" aria-label="Clear filter" onClick={() => setQuery("")}>
                            <X className="size-3.5" />
                          </button>
                        )}
                      </div>
                      <Btn size="sm" variant="outline" disabled={!!busy} onClick={() => void retryAll()}>
                        <RotateCcw className="size-3.5" /> Retry all
                      </Btn>
                      <Btn size="sm" variant="outline" className="text-env-prod-fg" disabled={!!busy} onClick={() => void flush()}>
                        <Trash2 className="size-3.5" /> Flush…
                      </Btn>
                    </>
                  )}
                </div>
                {L.failedError && <div className="text-[0.85em] text-env-staging-fg">{L.failedError}</div>}
                {L.failedTotal === 0 && !L.failedError && <div className="text-[0.85em] text-subtle-foreground">No failed jobs.</div>}
                {failed.map((j) => {
                  const { name, ns } = jobName(j.job);
                  const d = details[j.id];
                  return (
                    <div key={j.id} className="border-b border-divider/60">
                      <div
                        role="row"
                        onClick={() => {
                          if (!window.getSelection()?.toString()) void toggle(j);
                        }}
                        className="group grid cursor-pointer grid-cols-[1em_8.5em_minmax(8em,22em)_6em_minmax(0,1fr)] items-baseline gap-2 py-1 hover:bg-hover-strong/50"
                      >
                        <ChevronRight className={cn("size-3 self-center text-subtle-foreground transition-transform", open === j.id && "rotate-90")} />
                        <span className="truncate text-[0.85em] text-subtle-foreground" title={j.failedAt}>{shortTime(j.failedAt)}</span>
                        <span className="truncate" title={j.job}>
                          <span className="text-[0.85em] text-subtle-foreground">{ns}</span>
                          {name}
                        </span>
                        <span className="truncate text-[0.85em] text-subtle-foreground">{j.queue}</span>
                        <span className="truncate text-env-prod-fg">{j.error}</span>
                      </div>
                      {open === j.id && (
                        <div className="mb-2 ml-[1.5em] flex flex-col gap-2 rounded-md border border-divider bg-panel p-2">
                          <div className="flex items-center gap-2">
                            <Btn size="sm" variant="outline" disabled={!!busy} onClick={() => void retry(j)}>
                              <RotateCcw className="size-3.5" /> Retry
                            </Btn>
                            <Btn size="sm" variant="outline" disabled={!!busy} onClick={() => void forget(j)}>
                              <Trash2 className="size-3.5" /> Forget
                            </Btn>
                            {d && typeof d !== "string" && (
                              <>
                                <Btn size="sm" variant="ghost" onClick={() => void copyText(d.exception)}>
                                  <Copy className="size-3.5" /> Copy error
                                </Btn>
                                <Btn size="sm" variant="ghost" onClick={() => setShowPayload((s) => !s)}>
                                  {showPayload ? "Hide payload" : "Payload"}
                                </Btn>
                              </>
                            )}
                            <span className="flex-1" />
                            <span className="font-mono text-[11px] text-subtle-foreground selectable">{j.id}</span>
                          </div>
                          {!d && <div className="text-[0.85em] text-subtle-foreground">Loading…</div>}
                          {typeof d === "string" && <div className="text-[0.85em] text-env-prod-fg">{d}</div>}
                          {d && typeof d !== "string" && (
                            <pre className="selectable max-h-[50vh] overflow-auto text-[0.82em] leading-[1.45] break-words whitespace-pre-wrap">
                              {showPayload ? d.payload : d.exception}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {L.failedTotal > L.failed.length && (
                  <div className="text-[0.8em] text-subtle-foreground">Showing the newest {L.failed.length} of {L.failedTotal.toLocaleString()}.</div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
      {typed && <TypedConfirm ask={typed} onDone={() => setTyped(null)} />}
    </div>
  );
}

/** Production: type the server's name to go ahead. */
function TypedConfirm({ ask, onDone }: { ask: Typed; onDone: () => void }) {
  const [text, setText] = useState("");
  const close = (ok: boolean) => {
    ask.resolve(ok);
    onDone();
  };
  return (
    <Modal open onOpenChange={(o) => !o && close(false)} title={ask.title} width={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text === ask.word) close(true);
        }}
      >
        <ModalHeader>
          <span className="text-[15px] font-semibold">{ask.title}</span>
        </ModalHeader>
        <div className="flex flex-col gap-3 px-5 pb-4 text-[12.5px] leading-[18px] text-muted-foreground">
          <div className="rounded-lg bg-env-prod/8 px-3 py-2 text-env-prod-fg">{ask.message}</div>
          <label className="flex flex-col gap-1.5">
            <span>
              Type <span className="font-mono text-foreground">{ask.word}</span> to confirm
            </span>
            <input
              autoFocus
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              className="h-8 rounded-md border border-control-border bg-background px-2 font-mono text-[12.5px] outline-none focus:border-primary/60"
            />
          </label>
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" autoFocus={false} onClick={() => close(false)}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="danger" disabled={text !== ask.word}>
            {ask.confirm}
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
