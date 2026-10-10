import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { errorMessage, updateCheck, updateInstall, type UpdateInfo } from "@/lib/ipc";
import { useUpdates } from "@/stores/updates";

type Phase =
  | { kind: "checking" }
  | { kind: "error"; message: string }
  | { kind: "ready"; info: UpdateInfo }
  | { kind: "installing"; done: number; total: number | null; verifying: boolean };

/** Menu ▸ Check for Updates… (or Settings ▸ About). */
export function UpdateDialog() {
  const open = useUpdates((s) => s.open);
  if (!open) return null;
  return <Updates />;
}

function Updates() {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const close = () => useUpdates.getState().close();
  const check = () => {
    setPhase({ kind: "checking" });
    updateCheck().then(
      (info) => setPhase({ kind: "ready", info }),
      (e: unknown) => setPhase({ kind: "error", message: errorMessage(e) }),
    );
  };
  useEffect(check, []);

  const install = () => {
    setPhase({ kind: "installing", done: 0, total: null, verifying: false });
    updateInstall((p) =>
      setPhase(p.kind === "downloading" ? { kind: "installing", done: p.done, total: p.total, verifying: false } : { kind: "installing", done: 0, total: null, verifying: true }),
    ).catch((e: unknown) => setPhase({ kind: "error", message: errorMessage(e) }));
  };

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const info = phase.kind === "ready" ? phase.info : null;
  return (
    <Modal open onOpenChange={(o) => !o && phase.kind !== "installing" && close()} title="Check for updates" width={500}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">
          {phase.kind === "checking"
            ? "Checking for updates…"
            : phase.kind === "error"
              ? "Couldn't update"
              : phase.kind === "installing"
                ? "Updating Kemudi…"
                : info?.version
                  ? `Kemudi ${info.version} is available`
                  : "Kemudi is up to date"}
        </span>
        <span className="text-[12.5px] text-muted-foreground">
          {phase.kind === "ready" && info
            ? info.version
              ? `You have ${info.current}.${info.date ? ` Released ${info.date.slice(0, 10)}.` : ""}`
              : `You have the latest version, ${info.current}.`
            : phase.kind === "error"
              ? phase.message
              : "Asks GitHub for the latest release. Nothing else is sent."}
        </span>
      </ModalHeader>
      <div className="px-5 pb-4">
        {info?.version && info.notes && (
          <pre className="selectable max-h-[260px] overflow-auto rounded-lg border border-divider bg-background px-3 py-2 font-sans text-[12.5px] leading-5 whitespace-pre-wrap text-foreground">
            {info.notes}
          </pre>
        )}
        {phase.kind === "installing" && (
          <div className="flex flex-col gap-1.5">
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: phase.verifying ? "100%" : phase.total ? `${Math.min(100, (phase.done / phase.total) * 100)}%` : "30%" }}
              />
            </div>
            <span className="text-[12px] text-subtle-foreground">
              {phase.verifying
                ? "Checking its signature and installing; Kemudi restarts when it's done…"
                : `Downloading ${mb(phase.done)}${phase.total ? ` of ${mb(phase.total)}` : ""}`}
            </span>
          </div>
        )}
      </div>
      <ModalFooter>
        <span className="flex-1" />
        {phase.kind !== "installing" && (
          <Btn variant="outline" className="pr-2.5" onClick={close}>
            {info?.version ? "Later" : "Close"} <Hint>esc</Hint>
          </Btn>
        )}
        {phase.kind === "error" && (
          <Btn variant="primary" onClick={check}>
            Try again
          </Btn>
        )}
        {info?.version && (
          <Btn variant="primary" onClick={install}>
            Update and restart
          </Btn>
        )}
      </ModalFooter>
    </Modal>
  );
}
