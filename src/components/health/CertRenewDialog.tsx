import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { copyText } from "@/lib/clipboard";
import {
  certsDnsCheck,
  certsRenewContinue,
  certsRenewFinish,
  certsRenewStart,
  certsRenewStatus,
  errorMessage,
  type CertbotCert,
  type DnsCheck,
  type RenewStatus,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { askConfirm } from "@/stores/confirm";
import { useToasts } from "@/stores/toasts";

type Phase = "intro" | "starting" | "running" | "finishing" | "done" | "failed";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-[4.5em] flex-none text-[11.5px] text-subtle-foreground">{label}</span>
      <span className="selectable min-w-0 flex-1 truncate rounded-md border border-control-border bg-panel px-2 py-1 font-mono text-[12px]" title={value}>
        {value}
      </span>
      <Btn
        size="sm"
        variant="outline"
        onClick={() =>
          void copyText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
      </Btn>
    </div>
  );
}

/** Guided renewal of a certificate issued with a manual DNS challenge:
 *  certbot runs on the server and waits at each challenge; you add the TXT
 *  record at your DNS host, Kemudi checks the domain's nameservers, you go
 *  on. Then the web server is reloaded. */
export function CertRenewDialog({ serverId, cert, onClose, onDone }: { serverId: string; cert: CertbotCert; onClose: () => void; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [dir, setDir] = useState<string | null>(null);
  const [status, setStatus] = useState<RenewStatus | null>(null);
  const [dns, setDns] = useState<{ n: number; check: DnsCheck | null; busy: boolean; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const finishing = useRef(false);

  const current = status?.challenges.find((c) => !c.released) ?? null;
  const earlier = status?.challenges.filter((c) => c.released) ?? [];

  const start = async () => {
    setPhase("starting");
    setError(null);
    try {
      const d = await certsRenewStart(serverId, cert.name, cert.domains);
      setDir(d);
      setPhase("running");
    } catch (e) {
      setError(errorMessage(e));
      setPhase("intro");
    }
  };

  const finish = async (ok: boolean) => {
    if (!dir || finishing.current) return;
    finishing.current = true;
    setPhase("finishing");
    try {
      const reloaded = await certsRenewFinish(serverId, dir, cert.name, ok);
      if (ok) {
        setResult(reloaded ? `${reloaded} reloaded: it serves the new certificate now.` : "No running nginx or Apache to reload.");
        setPhase("done");
        useToasts.getState().push(`Renewed ${cert.name}`, "info");
        onDone();
      } else {
        setPhase("failed");
      }
    } catch (e) {
      setError(errorMessage(e));
      setPhase(ok ? "done" : "failed");
      if (ok) onDone();
    }
  };

  // Follow certbot while it runs.
  useEffect(() => {
    if (phase !== "running" || !dir) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await certsRenewStatus(serverId, dir);
        if (stop) return;
        setStatus(s);
        if (s.rc != null) return void finish(s.rc === 0);
      } catch (e) {
        if (!stop) setError(errorMessage(e));
      }
      if (!stop) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, dir]);

  // Check DNS for the challenge in front, now and every 15 s.
  const checkDns = async (n: number, record: string, value: string) => {
    setDns((d) => ({ n, check: d?.n === n ? d.check : null, busy: true }));
    try {
      const check = await certsDnsCheck(serverId, record, value);
      setDns({ n, check, busy: false });
    } catch (e) {
      setDns({ n, check: null, busy: false, error: errorMessage(e) });
    }
  };
  useEffect(() => {
    if (!current) return;
    void checkDns(current.n, current.record, current.value);
    const t = setInterval(() => void checkDns(current.n, current.record, current.value), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.n, current?.value]);

  const go = async () => {
    if (!dir || !current) return;
    const live = dns?.n === current.n && dns.check && dns.check.nameservers.length > 0 && dns.check.nameservers.every(([, y]) => y);
    if (!live && !(await askConfirm("Continue without seeing it?", "Not every nameserver has the TXT record yet. Let's Encrypt may not see it and the renewal would fail (you can try again).", "Continue"))) return;
    try {
      await certsRenewContinue(serverId, dir, current.n);
      setStatus((s) => (s ? { ...s, challenges: s.challenges.map((c) => (c.n === current.n ? { ...c, released: true } : c)) } : s));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const close = async () => {
    if (phase === "running" || phase === "starting") {
      if (!(await askConfirm("Stop this renewal?", "certbot is stopped; the certificate stays as it is. You can start again later.", "Stop"))) return;
      await finish(false);
    }
    onClose();
  };

  const live = current && dns?.n === current.n && dns.check ? dns.check.nameservers.length > 0 && dns.check.nameservers.every(([, y]) => y) : false;

  return (
    <Modal open onOpenChange={(o) => !o && void close()} title={`Renew ${cert.name}`} width={660}>
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">Renew {cert.name}</span>
          <span className="text-[12.5px] text-subtle-foreground">on {serverId}</span>
        </div>
        <span className="font-mono text-[11.5px] text-subtle-foreground">{cert.domains.join(", ")}</span>
      </ModalHeader>
      <div className="flex flex-col gap-3 px-5 pb-4 text-[12.5px] leading-[18px] text-muted-foreground">
        {phase === "intro" && (
          <>
            <p>
              This certificate was issued with a manual DNS challenge{cert.domains.some((d) => d.startsWith("*.")) ? " (a wildcard)" : ""}, so certbot can't renew it by itself.
              Kemudi runs certbot on the server; for each domain Let's Encrypt asks for a <b>TXT record</b>, which you add at your DNS host. Kemudi checks the
              domain's nameservers until it's there, then you continue. Afterwards nginx is reloaded.
            </p>
            <p className="text-subtle-foreground">
              A wildcard and its plain domain use the same record name with two values: keep both. Set the TTL as low as your DNS host allows (e.g. 300).
            </p>
          </>
        )}
        {phase === "starting" && <p>Starting certbot on {serverId}…</p>}
        {(phase === "running" || phase === "finishing") && (
          <>
            {!current && (status?.challenges.length ?? 0) === 0 && <p>Waiting for Let's Encrypt's first challenge…</p>}
            {!current && (status?.challenges.length ?? 0) > 0 && <p>Let's Encrypt is checking the records…</p>}
            {current && (
              <div className="flex flex-col gap-2 rounded-lg border border-divider p-3">
                <span className="font-medium text-foreground">
                  Add this TXT record at your DNS host{dns?.check?.zone ? ` (zone ${dns.check.zone})` : ""}
                </span>
                <CopyField label="Name" value={current.record} />
                <CopyField label="Value" value={current.value} />
                <span className="text-[11.5px] text-subtle-foreground">
                  Type TXT. Some DNS hosts want only <span className="font-mono">_acme-challenge{dns?.check?.zone && current.domain !== dns.check.zone ? `.${current.domain.slice(0, -dns.check.zone.length - 1)}` : ""}</span> as the name (without the zone).
                </span>
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="text-subtle-foreground">Nameservers:</span>
                  {dns?.check?.nameservers.map(([ns, y]) => (
                    <span key={ns} className={cn("flex items-center gap-1 rounded px-1.5", y ? "bg-emerald-500/12 text-emerald-700" : "bg-muted text-subtle-foreground")}>
                      {y ? <Check className="size-3" /> : <X className="size-3" />} {ns}
                    </span>
                  ))}
                  {dns?.check && (
                    <span className={cn("rounded px-1.5", dns.check.google ? "bg-emerald-500/12 text-emerald-700" : "bg-muted text-subtle-foreground")} title="Google's public DNS (may cache the old answer for a while; Let's Encrypt asks the nameservers)">
                      Google {dns.check.google ? "✓" : "–"}
                    </span>
                  )}
                  {dns?.busy && <span className="text-subtle-foreground">checking…</span>}
                  {dns?.error && <span className="text-env-prod-fg">{dns.error}</span>}
                  <button className="cursor-pointer text-primary hover:underline" onClick={() => void checkDns(current.n, current.record, current.value)}>
                    Check now
                  </button>
                </div>
              </div>
            )}
            {earlier.length > 0 && (
              <div className="text-[11.5px] text-subtle-foreground">
                Keep {earlier.length === 1 ? "the earlier record" : "the earlier records"} until this is done:
                {earlier.map((c) => (
                  <span key={c.n} className="ml-1 font-mono">
                    {c.record} = {c.value.slice(0, 10)}…
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        {phase === "done" && (
          <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-emerald-800">
            Renewed {cert.name}. {result} You can delete the _acme-challenge TXT records now.
          </div>
        )}
        {phase === "failed" && (
          <div className="rounded-lg bg-env-prod/8 px-3 py-2 text-env-prod-fg">
            {status?.rc != null ? `certbot failed (exit ${status.rc}). The certificate is unchanged; see its output below.` : "Stopped. The certificate is unchanged."}
          </div>
        )}
        {error && <div className="rounded-lg bg-env-prod/8 px-3 py-2 text-env-prod-fg">{error}</div>}
        {status?.log && (phase === "failed" || showLog) && (
          <pre className="selectable max-h-[30vh] overflow-auto rounded-md bg-panel p-2 font-mono text-[11px] leading-[1.45] whitespace-pre-wrap">{status.log}</pre>
        )}
        {status?.log && phase !== "failed" && (
          <button className="self-start cursor-pointer text-[11.5px] text-primary hover:underline" onClick={() => setShowLog((s) => !s)}>
            {showLog ? "Hide certbot's output" : "certbot's output"}
          </button>
        )}
      </div>
      <ModalFooter>
        <span className="flex-1" />
        {phase === "intro" && (
          <>
            <Btn variant="outline" className="pr-2.5" onClick={onClose}>
              Cancel <Hint>esc</Hint>
            </Btn>
            <Btn variant="primary" onClick={() => void start()}>
              Start
            </Btn>
          </>
        )}
        {(phase === "running" || phase === "starting" || phase === "finishing") && (
          <>
            <Btn variant="outline" onClick={() => void close()} disabled={phase === "finishing"}>
              Stop
            </Btn>
            <Btn variant={live ? "primary" : "outline"} disabled={!current || phase !== "running"} onClick={() => void go()}>
              {current ? (live ? "It's there: continue" : "Continue") : "Waiting…"}
            </Btn>
          </>
        )}
        {(phase === "done" || phase === "failed") && (
          <>
            {phase === "failed" && (
              <Btn
                variant="outline"
                onClick={() => {
                  finishing.current = false;
                  setStatus(null);
                  setDir(null);
                  setDns(null);
                  setError(null);
                  setPhase("intro");
                }}
              >
                Try again
              </Btn>
            )}
            <Btn variant="primary" onClick={onClose}>
              Close
            </Btn>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
