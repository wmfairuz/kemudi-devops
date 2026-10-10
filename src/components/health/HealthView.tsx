import { RotateCw, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { certsList, errorMessage, healthCheck, healthComposerAudit, openUrl, type CertbotCert, type ComposerAudit, type Health, type HealthCert } from "@/lib/ipc";
import { CertRenewDialog } from "./CertRenewDialog";
import { useServiceMenu } from "@/components/actions/ServiceMenu";
import { cn } from "@/lib/utils";
import { findServer, useConfig } from "@/stores/config";
import { useSslAlerts } from "@/stores/sslAlerts";
import { openLogs, openQueues, type Tab } from "@/stores/tabs";
import { toastError } from "@/stores/toasts";

type Tone = "ok" | "warn" | "bad" | "dim";

const TONE: Record<Tone, string> = {
  ok: "bg-emerald-500/12 text-emerald-700",
  warn: "bg-env-staging/15 text-env-staging-fg",
  bad: "bg-env-prod/12 text-env-prod-fg",
  dim: "bg-muted text-subtle-foreground",
};

function Pill({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-block rounded px-1.5 text-[0.75em] leading-[1.6] font-medium whitespace-nowrap", TONE[tone])}>
      {children}
    </span>
  );
}

function date(secs: number): string {
  return new Date(secs * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function uptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "Let's Encrypt", or the issuer's CN. */
function issuerName(i: string, subject: string): string {
  if (i && i === subject) return "self-signed";
  const o = /O\s*=\s*([^,]+)/.exec(i)?.[1]?.trim();
  return o ?? /CN\s*=\s*([^,]+)/.exec(i)?.[1]?.trim() ?? i;
}

function certTone(c: HealthCert): Tone {
  if (c.missing || !c.covers) return "bad";
  const d = c.daysLeft ?? 0;
  return d <= 7 ? "bad" : d <= 21 ? "warn" : "ok";
}

/** A Health tab for a server: SSL certificates (what's served and what's on
 *  disk), updates, reboot, services and each app's PHP / Laravel / debug. */
export function HealthView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const serverId = tab.serverId ?? "";
  const server = findServer(serverId);
  const term = useConfig((s) => s.snapshot?.config?.terminal);
  const font = { fontFamily: term?.fontFamily ?? 'Menlo, "SF Mono", monospace', fontSize: `${term?.fontSize ?? 14}px` };
  const [health, setHealth] = useState<Health | null>(null);
  const serviceMenu = useServiceMenu(serverId);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [audits, setAudits] = useState<Record<string, ComposerAudit | string | "busy">>({});
  const [certbot, setCertbot] = useState<{ certs: CertbotCert[]; note: string | null } | string | null>(null);
  const [renewing, setRenewing] = useState<CertbotCert | null>(null);

  const loadCertbot = async () => {
    try {
      setCertbot(await certsList(serverId));
    } catch (e) {
      setCertbot(errorMessage(e));
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const h = await healthCheck(serverId);
      setHealth(h);
      setError(null);
      setCheckedAt(Date.now());
      useSslAlerts.getState().record(serverId, h);
      void loadCertbot();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (visible && !health && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const audit = async (appId: string) => {
    setAudits((a) => ({ ...a, [appId]: "busy" }));
    try {
      const r = await healthComposerAudit(serverId, appId);
      setAudits((a) => ({ ...a, [appId]: r }));
    } catch (e) {
      setAudits((a) => ({ ...a, [appId]: errorMessage(e) }));
    }
  };

  const appName = (id: string | null) => (id ? (server?.apps.find((a) => a.id === id)?.name ?? id) : null);
  const h = health;
  const le = h?.certs.some((c) => /Let's Encrypt|R1[0-9]|E[5-9]/.test(c.issuer));
  const Section = ({ title, children, extra }: { title: string; children: React.ReactNode; extra?: React.ReactNode }) => (
    <section className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h3 className="text-[0.8em] font-semibold tracking-wide text-subtle-foreground uppercase">{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  );

  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-3">
        <span className="text-[13px] font-semibold">Health</span>
        <span className="text-[12.5px] text-subtle-foreground">{server?.name ?? serverId}</span>
        {server && <EnvTag env={server.env} />}
        <span className="flex-1" />
        {checkedAt && <span className="text-[11px] text-subtle-foreground">checked {new Date(checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
        <Btn size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RotateCw className={cn("size-3.5", loading && "animate-spin")} /> {loading ? "Checking…" : "Check again"}
        </Btn>
      </div>
      {error && <div className="flex-none bg-env-prod/8 px-4 py-2 text-[12px] text-env-prod-fg">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" style={font}>
        {!h && !error && <div className="py-6 text-[0.9em] text-subtle-foreground">Checking {server?.name ?? serverId}: certificates, updates, services, apps…</div>}
        {h && (
          <div className="flex flex-col gap-5">
            <Section
              title="SSL certificates"
              extra={
                <span className="text-[0.8em] text-subtle-foreground">
                  {h.renew.length ? `renewed by ${h.renew.join(", ")}` : h.certs.length ? "" : ""}
                </span>
              }
            >
              {h.sslError && <div className="text-[0.85em] text-env-staging-fg">{h.sslError}</div>}
              {h.certs.length > 0 && h.renew.length === 0 && le && (
                <div className="flex items-center gap-2 rounded-lg bg-env-staging/10 px-3 py-1.5 text-[0.85em] text-env-staging-fg">
                  <ShieldAlert className="size-4 flex-none" /> Nothing seems to renew these Let's Encrypt certificates (no certbot timer or cron, no acme.sh).
                </div>
              )}
              {h.renewErrors.length > 0 && (() => {
                const lines = h.renewErrors.filter((l) => l !== "certbot.service failed");
                const fails = lines.filter((l) => l.startsWith("Failed to renew"));
                // Only manual-DNS certificates failing is expected: they're renewed with Renew… below.
                const onlyManual = fails.length > 0 && lines.filter((l) => l.startsWith("The error was")).every((l) => /manual-auth-hook|manual plugin/.test(l));
                return onlyManual ? (
                  <div className="rounded-lg bg-muted px-3 py-1.5 text-[0.85em] text-subtle-foreground" title={lines.join("\n")}>
                    certbot's daily run skips {fails.length} manual-DNS certificate{fails.length === 1 ? "" : "s"} (expected: they renew with <b>Renew…</b> under Let's Encrypt below; the 🔒 badge warns 14 days ahead).
                  </div>
                ) : (
                  <div className="flex flex-col gap-1 rounded-lg bg-env-prod/8 px-3 py-2 text-[0.85em] text-env-prod-fg">
                    <span className="flex items-center gap-2 font-medium">
                      <ShieldAlert className="size-4 flex-none" /> certbot's last renewal run failed: certificates won't renew by themselves.
                    </span>
                    {lines.some((l) => /manual plugin|manual-auth-hook/.test(l)) && (
                      <span>Some were issued with a manual DNS challenge: renew those with <b>Renew…</b> under Let's Encrypt below. The others failed for the reasons shown.</span>
                    )}
                    <pre className="selectable mt-1 text-[0.95em] break-words whitespace-pre-wrap text-env-prod-fg/90">{lines.join("\n") || "See: sudo journalctl -u certbot -n 50"}</pre>
                  </div>
                );
              })()}
              {h.certs.length === 0 && !h.sslError && <div className="text-[0.85em] text-subtle-foreground">No HTTPS sites in the web server's config.</div>}
              {h.certs.map((c) => {
                const tone = certTone(c);
                return (
                  <div key={c.name} className="grid grid-cols-[7.5em_minmax(0,26em)_minmax(0,9em)_9em_minmax(0,1fr)] items-baseline gap-3 border-b border-divider/60 py-1">
                    <span>
                      <Pill tone={tone}>
                        {c.missing ? "no cert" : !c.covers ? "wrong cert" : (c.daysLeft ?? 0) < 0 ? "expired" : `${c.daysLeft} days`}
                      </Pill>
                    </span>
                    <span className="truncate" title={`${c.name}\n${c.file}`}>
                      {c.name}
                    </span>
                    <span className="truncate text-[0.85em] text-subtle-foreground">{appName(c.appId) ?? ""}</span>
                    <span className="text-[0.85em] text-subtle-foreground">{c.notAfter ? date(c.notAfter) : "—"}</span>
                    <span className="min-w-0 text-[0.85em] text-subtle-foreground">
                      {c.missing
                        ? "nothing came back on port 443 for this name"
                        : !c.covers
                          ? `the certificate served is for ${c.sans.slice(0, 3).join(", ") || c.subject}`
                          : issuerName(c.issuer, c.subject)}
                      {c.newerOnDisk && (
                        <span className="ml-2 text-env-staging-fg" title="The certificate file was renewed but nginx/Apache still serves the old one">
                          renewed on disk (to {date(c.newerOnDisk)}): reload the web server
                        </span>
                      )}
                      {c.via === "public" && <span className="ml-2" title="127.0.0.1:443 didn't answer for it; asked the name itself from the server">· via its address</span>}
                    </span>
                  </div>
                );
              })}
              {h.moreNames > 0 && <div className="text-[0.8em] text-subtle-foreground">{h.moreNames} more names not checked.</div>}
            </Section>

            {certbot && (typeof certbot === "string" || certbot.certs.length > 0) && (
              <Section title="Let's Encrypt (certbot)">
                {typeof certbot === "string" && <div className="text-[0.85em] text-env-staging-fg">{certbot}</div>}
                {typeof certbot !== "string" &&
                  certbot.certs.map((c) => {
                    const d = c.daysLeft ?? 0;
                    return (
                      <div key={c.name} className="grid grid-cols-[7.5em_minmax(0,16em)_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-divider/60 py-1">
                        <span>
                          <Pill tone={c.daysLeft == null ? "dim" : d <= 7 ? "bad" : d <= 21 ? "warn" : "ok"}>{c.daysLeft == null ? "?" : d < 0 ? "expired" : `${d} days`}</Pill>
                        </span>
                        <span className="truncate" title={c.name}>
                          {c.name}
                        </span>
                        <span className="min-w-0 truncate text-[0.85em] text-subtle-foreground" title={c.domains.join(", ")}>
                          {c.domains.join(", ")}
                          {" · "}
                          {c.needsYou ? <span className="text-env-staging-fg">manual DNS: renews only with you</span> : `renews by itself (${c.authenticator})`}
                        </span>
                        {c.needsYou ? (
                          <Btn size="sm" variant={d <= 30 ? "primary" : "outline"} onClick={() => setRenewing(c)}>
                            Renew…
                          </Btn>
                        ) : (
                          <span />
                        )}
                      </div>
                    );
                  })}
              </Section>
            )}

            {!h.sslOnly && (
              <Section title="System">
                <div className="grid grid-cols-[9em_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.92em]">
                  <span className="text-subtle-foreground">OS</span>
                  <span>
                    {h.os || "?"} <span className="text-subtle-foreground">· kernel {h.kernel} · up {uptime(h.uptimeS)}</span>
                  </span>
                  <span className="text-subtle-foreground">Updates</span>
                  <span>
                    {h.updates == null ? (
                      <span className="text-subtle-foreground">unknown (no apt-check)</span>
                    ) : h.updates === 0 ? (
                      <Pill tone="ok">up to date</Pill>
                    ) : (
                      <>
                        <Pill tone={h.securityUpdates ? "warn" : "dim"}>{h.updates} pending</Pill>{" "}
                        {h.securityUpdates ? <Pill tone="bad">{h.securityUpdates} security</Pill> : null}
                      </>
                    )}
                  </span>
                  <span className="text-subtle-foreground">Reboot</span>
                  <span>
                    {h.rebootRequired ? (
                      <>
                        <Pill tone="warn">needed</Pill>
                        {h.rebootPkgs.length > 0 && <span className="ml-2 text-[0.85em] text-subtle-foreground">for {h.rebootPkgs.slice(0, 4).join(", ")}{h.rebootPkgs.length > 4 ? "…" : ""}</span>}
                      </>
                    ) : (
                      <Pill tone="ok">not needed</Pill>
                    )}
                  </span>
                  <span className="text-subtle-foreground">Services</span>
                  <span className="flex flex-wrap gap-1.5">
                    {h.services.length === 0 && <span className="text-subtle-foreground">—</span>}
                    {h.services.map((s) => (
                      <button
                        key={s.name}
                        type="button"
                        className="cursor-pointer rounded hover:ring-1 hover:ring-control-border"
                        title={`${s.active} (${s.sub}) · click for Status / Start / Stop / Restart`}
                        onClick={(e) => serviceMenu.open(e, "service", s.name)}
                      >
                        <Pill tone={s.active === "active" ? "ok" : s.active === "failed" ? "bad" : "dim"}>
                          {s.name}
                          {s.active !== "active" ? ` · ${s.active}` : ""}
                        </Pill>
                      </button>
                    ))}
                    {serviceMenu.node}
                  </span>
                  {h.failedUnits.length > 0 && (
                    <>
                      <span className="text-env-prod-fg">Failed units</span>
                      <span className="text-env-prod-fg">{h.failedUnits.join(", ")}</span>
                    </>
                  )}
                </div>
              </Section>
            )}

            {!h.sslOnly && h.apps.length > 0 && (
              <Section title="Apps">
                {h.apps.map((a) => {
                  const app = server?.apps.find((x) => x.id === a.id);
                  const prod = app?.env === "prod";
                  const res = audits[a.id];
                  return (
                    <div key={a.id} className="border-b border-divider/60 py-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-[10em] font-medium">{app?.name ?? a.id}</span>
                        {app && <EnvTag env={app.env} />}
                        {a.missing ? (
                          <Pill tone="bad">folder missing</Pill>
                        ) : (
                          <>
                            {a.php && <Pill tone="dim">PHP {a.php}</Pill>}
                            {a.laravel && <Pill tone="dim">Laravel {a.laravel}</Pill>}
                            {a.noEnv && <Pill tone="warn">no .env</Pill>}
                            {a.appEnv && (
                              <Pill tone={prod && a.appEnv !== "production" ? "warn" : "dim"} title={prod && a.appEnv !== "production" ? "Kemudi has this app as production" : undefined}>
                                APP_ENV={a.appEnv}
                              </Pill>
                            )}
                            {a.appDebug != null && (
                              <Pill tone={a.appDebug ? (prod || a.appEnv === "production" ? "bad" : "dim") : "ok"} title={a.appDebug && (prod || a.appEnv === "production") ? "Debug pages show code, queries and secrets to visitors" : undefined}>
                                APP_DEBUG={a.appDebug ? "true" : "false"}
                              </Pill>
                            )}
                          </>
                        )}
                        <span className="flex-1" />
                        {server && app && (
                          <>
                            <Btn size="sm" variant="ghost" onClick={() => openQueues(server, app)}>
                              Queues
                            </Btn>
                            <Btn size="sm" variant="ghost" onClick={() => openLogs(server, { appId: app.id, env: app.env, title: `${app.id} · logs` })}>
                              Logs
                            </Btn>
                          </>
                        )}
                        {!a.missing && (
                          <Btn size="sm" variant="outline" disabled={res === "busy"} onClick={() => void audit(a.id)} title="composer audit: known vulnerabilities in composer.lock (asks packagist from the server)">
                            {res === "busy" ? "Auditing…" : "composer audit"}
                          </Btn>
                        )}
                      </div>
                      {typeof res === "string" && res !== "busy" && <div className="mt-1 text-[0.85em] text-env-prod-fg">{res}</div>}
                      {res && typeof res === "object" && (
                        <div className="mt-1 flex flex-col gap-0.5 text-[0.85em]">
                          {res.advisories.length === 0 && <span className="text-emerald-700">No known vulnerabilities in composer.lock.</span>}
                          {res.advisories.map((v, i) => (
                            <div key={`${v.package}-${i}`} className="flex min-w-0 items-baseline gap-2">
                              <Pill tone={v.severity === "critical" || v.severity === "high" ? "bad" : "warn"}>{v.severity ?? "advisory"}</Pill>
                              <span className="font-medium">{v.package}</span>
                              <span className="min-w-0 truncate" title={v.title}>
                                {v.title}
                              </span>
                              <span className="flex-none text-subtle-foreground">{v.affected}</span>
                              {v.link ? (
                                <button className="flex-none cursor-pointer text-primary hover:underline" onClick={() => void openUrl(v.link!).catch((e) => toastError(errorMessage(e)))}>
                                  {v.cve ?? "details"}
                                </button>
                              ) : (
                                v.cve && <span className="flex-none">{v.cve}</span>
                              )}
                            </div>
                          ))}
                          {res.abandoned.length > 0 && (
                            <span className="text-subtle-foreground">
                              Abandoned: {res.abandoned.map(([p, r]) => (r ? `${p} (use ${r})` : p)).join(", ")}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </Section>
            )}
          </div>
        )}
      </div>
      {renewing && (
        <CertRenewDialog
          serverId={serverId}
          cert={renewing}
          onClose={() => setRenewing(null)}
          onDone={() => {
            void loadCertbot();
            void load();
          }}
        />
      )}
    </div>
  );
}
