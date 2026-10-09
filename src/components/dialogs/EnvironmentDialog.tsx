import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { StatusDot } from "@/components/kit/StatusDot";
import { envReport, errorMessage, type EnvReport } from "@/lib/ipc";
import { useUi } from "@/stores/ui";

// An empty agent is normal when ssh reads keys from ~/.ssh or the Keychain.
const agentDot = { ok: "up", empty: "unknown", unavailable: "down" } as const;

/** Kemudi ▸ Environment…: what every terminal and action runs with. Proves
 *  PATH and the ssh-agent survive a launch from Finder. */
export function EnvironmentDialog() {
  const open = useUi((s) => s.overlay === "environment");
  const setOverlay = useUi((s) => s.setOverlay);
  const [report, setReport] = useState<EnvReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReport(null);
    setError(null);
    envReport().then(setReport, (e) => setError(errorMessage(e)));
  }, [open]);

  return (
    <Modal open={open} onOpenChange={(o) => setOverlay(o ? "environment" : "none")} title="Environment">
      <ModalHeader>
        <span className="text-[15px] font-semibold">Environment</span>
        <span className="text-[12.5px] text-muted-foreground">
          Captured once from your login shell; every terminal and action uses it.
        </span>
      </ModalHeader>
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 pb-4">
        {error && <p className="text-[12.5px] text-env-prod-fg">{error}</p>}
        {!report && !error && <p className="text-[12.5px] text-subtle-foreground">Reading…</p>}
        {report && (
          <>
            {report.warning && (
              <div className="rounded-[7px] border border-env-prod-line bg-env-prod/8 p-2.5 font-mono text-[11.5px] leading-4 text-env-prod-btn-fg">
                {report.warning}
              </div>
            )}
            <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-[12px]">
              <dt className="text-subtle-foreground">Shell</dt>
              <dd className="selectable font-mono text-[11.5px] text-soft-foreground">{report.shell}</dd>
              <dt className="text-subtle-foreground">ssh-agent</dt>
              <dd className="flex items-start gap-2 font-mono text-[11.5px] text-soft-foreground">
                <StatusDot status={agentDot[report.agentState]} className="mt-[5px]" />
                <span className="selectable break-all whitespace-pre-wrap">{report.agent || "—"}</span>
              </dd>
              <dt className="text-subtle-foreground">SSH_AUTH_SOCK</dt>
              <dd className="selectable font-mono text-[11.5px] break-all text-soft-foreground">
                {report.sshAuthSock ?? <span className="text-env-prod-fg">not set</span>}
              </dd>
              {report.tools.map((t) => (
                <div key={t.name} className="contents">
                  <dt className="font-mono text-[11.5px] text-subtle-foreground">{t.name}</dt>
                  <dd className="selectable font-mono text-[11.5px] text-soft-foreground">
                    {t.path ?? <span className="text-faint-foreground">not found</span>}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-subtle-foreground">PATH</span>
              <div className="selectable rounded-xl border border-border bg-background px-3 py-2 font-mono text-[11.5px] leading-[18px] text-soft-foreground">
                {report.path.map((p, i) => (
                  <div key={`${i}-${p}`} className="truncate">
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      <ModalFooter>
        <span className="flex-1" />
        <Btn onClick={() => setOverlay("none")}>Close</Btn>
      </ModalFooter>
    </Modal>
  );
}
