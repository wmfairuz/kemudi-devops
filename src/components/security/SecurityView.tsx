// A server tab's Security: your secops skill's read-only security check
// (src-tauri/src/secops.rs), run when you ask (or on its own interval,
// Settings ▸ Checks). What it found, worst first; the app table; and
// everything it looked at.
import { ChevronDown, ChevronRight, FolderOpen, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Spinner } from "@/components/kit/Spinner";
import { errorMessage, filesReveal, type SecApp, type SecLevel, type SecVerdict, type Server, type WatchSecurity } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useTabs } from "@/stores/tabs";
import { toastError } from "@/stores/toasts";
import { agoS, useWatch } from "@/stores/watch";

const VERDICT: Record<SecVerdict, { label: string; hint: string; className: string }> = {
  compromised: { label: "Compromised", hint: "Something planted or running that shouldn't be: check each critical finding", className: "bg-env-prod text-white" },
  "at-risk": { label: "At risk", hint: "Nothing active found, but an app can be taken over from outside", className: "bg-env-prod/15 text-env-prod-fg" },
  hardening: { label: "Hardening", hint: "No sign of compromise; only settings to tighten", className: "bg-env-staging/20 text-[#8a5a12]" },
  clean: { label: "Clean", hint: "Nothing found on any check", className: "bg-status-up/20 text-[#17702a]" },
};

const LEVEL_TEXT: Record<SecLevel, string> = { crit: "text-env-prod-fg", warn: "text-[#8a5a12]", ok: "text-[#17702a]", info: "text-subtle-foreground" };
const LEVEL_TAG: Record<SecLevel, string> = { crit: "CRIT", warn: "WARN", ok: "ok", info: "" };

/** Seconds since `since` (re-rendered every second while it's set). */
function useElapsed(since: number | null): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.round((Date.now() - since) / 1000);
}

interface Finding {
  section: string;
  level: "crit" | "warn";
  text: string;
  detail: string[];
}

/** Critical and warning lines, each with the detail lines under it. */
function findings(sec: WatchSecurity): Finding[] {
  const out: Finding[] = [];
  for (const s of sec.sections) {
    let cur: Finding | null = null;
    for (const l of s.lines) {
      if (l.level === "crit" || l.level === "warn") {
        cur = { section: s.title, level: l.level, text: l.text, detail: [] };
        out.push(cur);
      } else if (l.level === "info" && cur) {
        cur.detail.push(l.text.trim());
      } else {
        cur = null;
      }
    }
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "crit" ? -1 : 1));
}

function flagClass(f: string): string {
  if (/^(FAKE-WORDPRESS|PHP-IN-MEDIA|LIVEWIRE-EXPLOITED|LIVEWIRE-RCE|IGNITION-RCE)/.test(f)) return "bg-env-prod/15 text-env-prod-fg";
  if (f.startsWith("APP_DEBUG") || f.startsWith("git-untracked") || f.startsWith("livewire2")) return "bg-env-staging/20 text-[#8a5a12]";
  return "bg-hover-strong text-subtle-foreground";
}

const flagged = (a: SecApp) => a.flags.length > 0 || a.audit.length > 0;

function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-divider bg-panel">
      <div className="flex h-10 items-center gap-2 border-b border-divider px-3.5">
        <span className="flex-1 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

function Findings({ sec }: { sec: WatchSecurity }) {
  const list = findings(sec);
  if (list.length === 0) return <div className="px-4 py-3 text-[12.5px] text-subtle-foreground">Nothing critical and no warnings.</div>;
  return (
    <div className="flex flex-col divide-y divide-divider">
      {list.map((f, i) => (
        <div key={i} className="flex gap-3 px-3.5 py-2 text-[12.5px]">
          <span className={cn("w-9 flex-none pt-px font-mono text-[10.5px] font-semibold", LEVEL_TEXT[f.level])}>{LEVEL_TAG[f.level]}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="break-words">{f.text}</span>
            {f.detail.length > 0 && (
              <pre className="overflow-x-auto font-mono text-[11px] leading-[17px] whitespace-pre text-subtle-foreground">{f.detail.join("\n")}</pre>
            )}
            <span className="text-[11px] text-faint-foreground">{f.section}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Apps({ apps }: { apps: SecApp[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? apps : apps.filter(flagged);
  const hidden = apps.length - apps.filter(flagged).length;
  return (
    <Panel
      title={`Laravel apps · ${apps.length}`}
      right={
        hidden > 0 && (
          <button className="cursor-pointer rounded-md px-1.5 text-[12px] text-primary hover:bg-primary/10" onClick={() => setAll(!all)}>
            {all ? "Only flagged" : `All ${apps.length}`}
          </button>
        )
      }
    >
      {shown.length === 0 ? (
        <div className="px-4 py-3 text-[12.5px] text-subtle-foreground">No app is flagged{apps.length === 0 ? " (none found under /opt/www or /var/www)" : ""}.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[11px] text-subtle-foreground">
                <th className="px-3.5 py-1.5 font-medium">App</th>
                <th className="px-2 py-1.5 font-medium">Laravel</th>
                <th className="px-2 py-1.5 font-medium">Livewire</th>
                <th className="px-2 py-1.5 font-medium">Ignition</th>
                <th className="px-2 py-1.5 font-medium" title=".php files in public/ besides index.php">PHP+</th>
                <th className="px-2 py-1.5 font-medium" title="Media files with PHP in them">Media</th>
                <th className="px-2 py-1.5 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.name} className="border-t border-divider align-top">
                  <td className="px-3.5 py-1.5 font-mono text-[11.5px] break-all">{a.name}</td>
                  <td className="px-2 py-1.5 font-mono text-[11.5px]">{a.laravel ?? "–"}</td>
                  <td className="px-2 py-1.5 font-mono text-[11.5px]">{a.livewire ?? "–"}</td>
                  <td className="px-2 py-1.5 font-mono text-[11.5px]">{a.ignition ?? "–"}</td>
                  <td className={cn("px-2 py-1.5 font-mono text-[11.5px]", a.extraPhp > 0 && "text-[#8a5a12]")}>{a.extraPhp}</td>
                  <td className={cn("px-2 py-1.5 font-mono text-[11.5px]", a.phpMedia > 0 && "text-env-prod-fg")}>{a.phpMedia}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {a.flags.map((f) => (
                        <span key={f} className={cn("rounded-[4px] px-1.5 py-px font-mono text-[10.5px]", flagClass(f))}>
                          {f}
                        </span>
                      ))}
                    </div>
                    {a.audit.map((l, i) => (
                      <div key={i} className="mt-0.5 font-mono text-[10.5px] text-subtle-foreground">
                        {l}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Every part of the check, ok lines too; one open at a time. */
function Everything({ sec }: { sec: WatchSecurity }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel title="Everything it checked">
      <div className="flex flex-col divide-y divide-divider">
        {sec.sections
          .filter((s) => s.lines.length > 0)
          .map((s) => {
            const crit = s.lines.filter((l) => l.level === "crit").length;
            const warn = s.lines.filter((l) => l.level === "warn").length;
            const isOpen = open === s.title;
            return (
              <div key={s.title}>
                <button className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-1.5 text-left text-[12.5px] hover:bg-hover" onClick={() => setOpen(isOpen ? null : s.title)}>
                  {isOpen ? <ChevronDown className="size-3.5 text-subtle-foreground" /> : <ChevronRight className="size-3.5 text-subtle-foreground" />}
                  <span className="flex-1">{s.title}</span>
                  {crit > 0 && <span className="font-mono text-[11px] text-env-prod-fg">{crit} crit</span>}
                  {warn > 0 && <span className="font-mono text-[11px] text-[#8a5a12]">{warn} warn</span>}
                  {crit + warn === 0 && <span className="font-mono text-[11px] text-[#17702a]">ok</span>}
                </button>
                {isOpen && (
                  <pre className="overflow-x-auto bg-background px-3.5 py-2 font-mono text-[11px] leading-[17px] whitespace-pre">
                    {s.lines.map((l, i) => (
                      <div key={i} className={LEVEL_TEXT[l.level]}>
                        {l.level === "info" ? l.text : `[${LEVEL_TAG[l.level]}] ${l.text}`}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            );
          })}
      </div>
    </Panel>
  );
}

export function SecurityView({ server }: { server: Server }) {
  const w = useWatch((s) => s.snapshot?.servers[server.id]);
  const running = useWatch((s) => s.snapshot?.securityRunning.includes(server.id) ?? false);
  const [audit, setAudit] = useState(false);
  const started = useRef<number | null>(null);
  if (running && started.current === null) started.current = Date.now();
  if (!running) started.current = null;
  const elapsed = useElapsed(started.current);
  const sc = w?.security ?? null;
  const sec = sc?.value ?? null;
  const error = w?.errors.security;
  const v = sec ? VERDICT[sec.verdict] : null;

  const run = () => void useWatch.getState().securityCheck([server.id], audit).catch((e) => toastError(errorMessage(e)));

  return (
    <div className="light-ui absolute inset-0 overflow-y-auto bg-background text-foreground">
      <div className="flex w-full flex-col gap-4 px-5 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">{server.name}</span>
          <EnvTag env={server.env} />
          {v && (
            <span title={v.hint} className={cn("rounded-full px-2.5 py-0.5 text-[12px] font-medium", v.className)}>
              {v.label}
            </span>
          )}
          {sec && (
            <span className="text-[12px] text-subtle-foreground">
              {sec.crit} critical · {sec.warn} warning{sec.warn === 1 ? "" : "s"} · {agoS(sc?.at)}
              {sec.audit ? " · with composer audit" : ""}
            </span>
          )}
          <span className="flex-1" />
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground" title="Also run composer audit in every app (slower; needs internet on the server)">
            <input type="checkbox" checked={audit} onChange={(e) => setAudit(e.target.checked)} disabled={running} />
            composer audit
          </label>
          {sec?.report && (
            <Btn size="sm" variant="outline" title={sec.report} onClick={() => void filesReveal(sec.report!).catch((e) => toastError(errorMessage(e)))}>
              <FolderOpen className="size-3.5" /> Report
            </Btn>
          )}
          <Btn size="sm" variant="primary" disabled={running} onClick={run}>
            {running ? (
              <>
                <Spinner size={11} /> Checking… {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
              </>
            ) : (
              <>
                <ShieldCheck className="size-3.5" /> {sec ? "Check again" : "Run security check"}
              </>
            )}
          </Btn>
        </div>

        {sec?.host && <div className="-mt-2 font-mono text-[11.5px] text-subtle-foreground">{sec.host}</div>}

        {error && (
          <div className="rounded-lg border border-env-prod/30 bg-env-prod/5 px-3.5 py-2.5 text-[12.5px] text-env-prod-fg">
            The last check didn't work ({agoS(w?.tried.security)}): {error}
            {error.includes("Settings ▸ Checks") && (
              <button className="ml-2 cursor-pointer text-primary underline" onClick={() => useTabs.getState().openSettings("checks")}>
                Open Checks
              </button>
            )}
          </div>
        )}

        {sec && !sec.root && (
          <div className="rounded-lg border border-env-staging/40 bg-env-staging/10 px-3.5 py-2.5 text-[12.5px] text-[#8a5a12]">
            It ran without root, so other users' processes, crontabs and configs were only partly seen. Passwordless sudo, or a saved sudo password (Passwords), lets it see
            everything.
          </div>
        )}

        {!sec && !error && (
          <Panel title="Security check">
            <div className="flex gap-3 px-4 py-3 text-[12.5px] leading-5 text-muted-foreground">
              <ShieldQuestion className="mt-0.5 size-5 flex-none text-subtle-foreground" />
              <div>
                Runs your secops skill's <span className="font-mono text-[12px]">secops-check.sh</span> on {server.name}: miners, backdoors, web shells, bad cron, dropped files,
                open database ports, firewall and SSH, pending patches, old PHP, certificates, vulnerable Livewire / Ignition, APP_DEBUG, planted PHP, tampered system files.
                <br />
                It changes nothing and prints no secrets; nothing is copied to the server. It takes from seconds to a few minutes, depending on how many apps there are. The
                raw output is saved with the skill's reports, so <span className="font-mono text-[12px]">/secops {server.host} --fix</span> in Claude Code can pick it up.
              </div>
            </div>
          </Panel>
        )}

        {sec && (
          <>
            {v && sec.verdict !== "clean" && (
              <div className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
                <ShieldAlert className={cn("mt-0.5 size-4 flex-none", sec.verdict === "hardening" ? "text-[#8a5a12]" : "text-env-prod-fg")} />
                <span>
                  {v.hint}. To clean up step by step, run <span className="font-mono text-[12px]">/secops {server.host} --fix</span> in Claude Code: it reads this report.
                </span>
              </div>
            )}
            <Panel title="Findings">
              <Findings sec={sec} />
            </Panel>
            <Apps apps={sec.apps} />
            <Everything sec={sec} />
          </>
        )}
      </div>
    </div>
  );
}
