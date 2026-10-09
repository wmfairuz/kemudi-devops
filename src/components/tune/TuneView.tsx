import { ArrowRight, RotateCcw, RotateCw, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { errorMessage, tuneAnalyze, tuneApply, tuneUndo, type TuneChange, type Tuning } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { findServer, useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { type Tab } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

function gb(kb: number): string {
  return kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
}

/** "/root/.kemudi-tune/20261009-092357" → "Oct 9, 09:23". */
function tuneWhen(dir: string): string {
  const m = /(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)/.exec(dir);
  if (!m) return dir;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const LEVEL: Record<string, string> = {
  important: "bg-env-prod/12 text-env-prod-fg",
  suggested: "bg-env-staging/15 text-env-staging-fg",
  optional: "bg-muted text-subtle-foreground",
};

interface Result {
  done: string[];
  failed: [string, string][];
  notes: string[];
}

/** A Fine-tune tab: what the server has, suggested settings (PHP-FPM,
 *  OPcache, MySQL, nginx, swap) with why, applied with backups, tests and
 *  rollback; Undo puts the last tuning back. */
export function TuneView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const serverId = tab.serverId ?? "";
  const server = findServer(serverId);
  const term = useConfig((s) => s.snapshot?.config?.terminal);
  const font = { fontFamily: term?.fontFamily ?? 'Menlo, "SF Mono", monospace', fontSize: `${term?.fontSize ?? 14}px` };
  const [t, setT] = useState<Tuning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [typing, setTyping] = useState<((ok: boolean) => void) | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await tuneAnalyze(serverId);
      setT(r);
      setError(null);
      setPicked(new Set(r.suggestions.filter((s) => s.change && s.level !== "optional").map((s) => s.id)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (visible && !t && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const groups = useMemo(() => {
    const m = new Map<string, Tuning["suggestions"]>();
    for (const s of t?.suggestions ?? []) m.set(s.area, [...(m.get(s.area) ?? []), s]);
    return [...m.entries()];
  }, [t]);

  const chosen = (t?.suggestions ?? []).filter((s) => s.change && picked.has(s.id));
  const prod = server?.env === "prod";

  const apply = async () => {
    if (!chosen.length) return;
    const list = chosen.map((s) => `${s.area}: ${s.setting} ${s.current} → ${s.suggested}`).join("\n");
    const ok = prod
      ? await new Promise<boolean>((resolve) => setTyping(() => resolve))
      : await askConfirm(`Apply ${chosen.length} change${chosen.length === 1 ? "" : "s"} on ${server?.name ?? serverId}?`, `Each file is backed up; PHP and nginx are tested before they're reloaded and put back if the test fails. Undo last tuning restores it all.\n\n${list}`, "Apply");
    if (!ok) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await tuneApply(serverId, chosen.map((s) => [s.id, s.change as TuneChange]));
      setResult(r);
      useToasts.getState().push(r.failed.length ? `Applied ${r.done.length}, ${r.failed.length} rolled back` : `Applied ${r.done.length} change${r.done.length === 1 ? "" : "s"}`, r.failed.length ? "error" : "info");
      await load();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!t?.facts.lastTune) return;
    if (!(await askConfirm("Undo the last tuning?", `Puts back every file changed on ${tuneWhen(t.facts.lastTune)} (and MySQL / sysctl values, swap file), then tests and reloads PHP-FPM and nginx.`, "Undo"))) return;
    setBusy(true);
    try {
      const notes = await tuneUndo(serverId);
      useToasts.getState().push(`Undone${notes.length ? `: ${notes.join(", ")}` : ""}`, "info");
      setResult(null);
      await load();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const b = t?.budget;
  const label = (id: string) => {
    const s = t?.suggestions.find((x) => x.id === id);
    return s ? `${s.area} · ${s.setting}` : id;
  };

  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-3">
        <span className="text-[13px] font-semibold">Fine-tune</span>
        <span className="text-[12.5px] text-subtle-foreground">{server?.name ?? serverId}</span>
        {server && <EnvTag env={server.env} />}
        <span className="flex-1" />
        {t?.facts.lastTune && (
          <Btn size="sm" variant="ghost" onClick={() => void undo()} disabled={busy} title={t.facts.lastTune}>
            <Undo2 className="size-3.5" /> Undo last tuning ({tuneWhen(t.facts.lastTune)})
          </Btn>
        )}
        <Btn size="sm" variant="outline" onClick={() => void load()} disabled={loading || busy}>
          <RotateCw className={cn("size-3.5", loading && "animate-spin")} /> {loading ? "Analyzing…" : "Analyze again"}
        </Btn>
      </div>
      {error && <div className="flex-none bg-env-prod/8 px-4 py-2 text-[12px] text-env-prod-fg">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" style={font}>
        {!t && !error && <div className="py-6 text-[0.9em] text-subtle-foreground">Looking at {server?.name ?? serverId}: CPUs, memory, PHP-FPM pools and their workers, OPcache, MySQL, nginx… (read-only)</div>}
        {t && b && (
          <div className="flex flex-col gap-4">
            <div className="text-[0.9em]">
              {t.facts.cpus} CPUs · {gb(t.facts.memTotalKb)} RAM ({gb(t.facts.memAvailableKb)} available) · swap {t.facts.swapTotalKb ? gb(t.facts.swapTotalKb) : "none"} · load {t.facts.load}
              {t.facts.mysql?.version ? ` · ${t.facts.mysql.version}` : ""}
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex h-5 overflow-hidden rounded-md border border-divider text-[0.72em] text-white">
                {[
                  { kb: b.reserveKb, cls: "bg-slate-400", name: "system reserve" },
                  { kb: b.othersKb, cls: "bg-slate-500", name: "other services" },
                  { kb: b.mysqlKb, cls: "bg-sky-600", name: "MySQL" },
                  { kb: b.phpKb, cls: "bg-[#6b4fd8]", name: "PHP-FPM" },
                ].map((p) =>
                  p.kb > 0 ? (
                    <span key={p.name} className={cn("flex items-center justify-center truncate px-1", p.cls)} style={{ width: `${(p.kb / b.totalKb) * 100}%` }} title={`${p.name}: ${gb(p.kb)}`}>
                      {p.kb / b.totalKb > 0.1 ? `${p.name} ${gb(p.kb)}` : ""}
                    </span>
                  ) : null,
                )}
              </div>
              <span className="text-[0.8em] text-subtle-foreground">
                Memory plan: {gb(b.reserveKb)} kept for the system, {gb(b.othersKb)} used by other services now, {gb(b.mysqlKb)} for MySQL, {gb(b.phpKb)} for PHP-FPM workers
                (using {gb(b.phpNowKb)} now; up to {gb(b.phpPlannedKb)} if every suggested worker were busy at once).
              </span>
            </div>

            {t.notes.map((n) => (
              <div key={n} className="rounded-lg bg-env-staging/10 px-3 py-1.5 text-[0.85em] text-env-staging-fg">
                {n}
              </div>
            ))}

            {result && (result.failed.length > 0 || result.notes.length > 0) && (
              <div className="flex flex-col gap-1 rounded-lg border border-divider px-3 py-2 text-[0.85em]">
                {result.failed.map(([id, why]) => (
                  <span key={id} className="text-env-prod-fg">
                    ✗ {label(id)}: {why}
                  </span>
                ))}
                {result.notes.map((n) => (
                  <span key={n} className="text-subtle-foreground">
                    {n}
                  </span>
                ))}
              </div>
            )}

            {t.suggestions.length === 0 && <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-[0.9em] text-emerald-800">Nothing to change: this server's settings fit what it has.</div>}

            {groups.map(([area, list]) => (
              <section key={area} className="flex flex-col gap-1">
                <h3 className="text-[0.8em] font-semibold tracking-wide text-subtle-foreground uppercase">{area}</h3>
                {list.map((s) => (
                  <label key={s.id} className={cn("flex cursor-pointer gap-3 border-b border-divider/60 py-1.5", !s.change && "cursor-default")}>
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={!s.change || busy}
                      checked={picked.has(s.id)}
                      onChange={(e) =>
                        setPicked((p) => {
                          const n = new Set(p);
                          if (e.target.checked) n.add(s.id);
                          else n.delete(s.id);
                          return n;
                        })
                      }
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex flex-wrap items-baseline gap-2">
                        <span className="font-medium">{s.setting}</span>
                        <span className="text-subtle-foreground line-through decoration-subtle-foreground/50">{s.current}</span>
                        <ArrowRight className="size-3 self-center text-subtle-foreground" />
                        <span className="font-medium text-[#6b4fd8]">{s.suggested}</span>
                        <span className={cn("rounded px-1.5 text-[0.72em] leading-[1.6]", LEVEL[s.level])}>{s.level}</span>
                      </span>
                      <span className="text-[0.85em] text-muted-foreground">{s.why}</span>
                      <span className="text-[0.75em] text-subtle-foreground">{s.effect}</span>
                    </span>
                  </label>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
      {t && t.suggestions.length > 0 && (
        <div className="flex h-12 flex-none items-center gap-3 border-t border-divider px-4 text-[12px] text-subtle-foreground">
          <span>
            {chosen.length} of {t.suggestions.length} picked. Files are backed up; PHP and nginx are tested before reloading, and put back if the test fails.
          </span>
          <span className="flex-1" />
          <Btn variant="primary" disabled={!chosen.length || busy} onClick={() => void apply()}>
            <RotateCcw className={cn("size-3.5", busy && "animate-spin")} /> {busy ? "Applying…" : `Apply ${chosen.length} change${chosen.length === 1 ? "" : "s"}`}
          </Btn>
        </div>
      )}
      {typing && (
        <TypedConfirm
          word={serverId}
          count={chosen.length}
          onDone={(ok) => {
            typing(ok);
            setTyping(null);
          }}
        />
      )}
    </div>
  );
}

function TypedConfirm({ word, count, onDone }: { word: string; count: number; onDone: (ok: boolean) => void }) {
  const [text, setText] = useState("");
  return (
    <Modal open onOpenChange={(o) => !o && onDone(false)} title="Tune production" width={460}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text === word) onDone(true);
        }}
      >
        <ModalHeader>
          <span className="text-[15px] font-semibold">Apply {count} change{count === 1 ? "" : "s"} on production?</span>
        </ModalHeader>
        <div className="flex flex-col gap-3 px-5 pb-4 text-[12.5px] text-muted-foreground">
          <div className="rounded-lg bg-env-prod/8 px-3 py-2 text-env-prod-fg">PHP-FPM and nginx are reloaded (no dropped requests). Each file is backed up, and Undo last tuning puts it back.</div>
          <label className="flex flex-col gap-1.5">
            <span>
              Type <span className="font-mono text-foreground">{word}</span> to confirm
            </span>
            <input autoFocus value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} className="h-8 rounded-md border border-control-border bg-background px-2 font-mono text-[12.5px] outline-none focus:border-primary/60" />
          </label>
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={() => onDone(false)}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="danger" disabled={text !== word}>
            Apply
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
