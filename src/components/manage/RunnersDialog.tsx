import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Spinner } from "@/components/kit/Spinner";
import { errorMessage, runnersAdd, runnersPlan, type RunnersPlan } from "@/lib/ipc";
import { toastError, useToasts } from "@/stores/toasts";

export type RunnerKind = "cron" | "worker";

/** In an app's empty Cron or Supervisor section: what's missing, and a
 *  button that proposes it. */
export function RunnerProposal({ kind, onAdd }: { kind: RunnerKind; onAdd: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-primary/35 bg-primary/5 px-3 py-2 text-[12px]">
      <span className="min-w-0 flex-1 text-muted-foreground">
        {kind === "cron"
          ? "Its scheduler isn't running: Laravel needs a cron line that runs artisan schedule:run every minute."
          : "No queue worker: jobs pushed to a queue (not sync) wait until a worker runs artisan queue:work."}
      </span>
      <Btn size="sm" variant="primary" onClick={onAdd}>
        {kind === "cron" ? "Add the scheduler…" : "Add a queue worker…"}
      </Btn>
    </div>
  );
}

/** Shows the file Kemudi would write (editable), then writes it. */
export function RunnersDialog({
  serverId,
  serverName,
  appId,
  appName,
  prod,
  kind,
  onClose,
  onAdded,
}: {
  serverId: string;
  serverName: string;
  appId: string;
  appName: string;
  prod: boolean;
  kind: RunnerKind;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [plan, setPlan] = useState<RunnersPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    runnersPlan(serverId, appId)
      .then((p) => {
        if (!live) return;
        setPlan(p);
        setText(kind === "cron" ? p.cron : p.worker);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [serverId, appId, kind]);
  const file = plan ? (kind === "cron" ? plan.cronFile : plan.workerFile) : null;
  const blocked = !plan
    ? null
    : plan.sudo === "none"
      ? "Writing it needs sudo: save this server's sudo password in Passwords (⇧⌘K)."
      : kind === "worker" && !plan.supervisor
        ? "Supervisor isn't installed on this server (apt install supervisor)."
        : kind === "worker" && !plan.workerFile
          ? "Can't tell where Supervisor reads its programs from."
          : null;
  const add = async () => {
    setBusy(true);
    try {
      const out = await runnersAdd(serverId, appId, kind, text);
      useToasts.getState().push(`${appName}: ${kind === "cron" ? "scheduler added" : "queue worker added"}${out ? ` (${out.split("\n")[0]})` : ""}`, "info");
      onAdded();
      onClose();
    } catch (e) {
      toastError(`${appName}: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onOpenChange={(o) => !o && !busy && onClose()} title={kind === "cron" ? "Add the scheduler" : "Add a queue worker"} width={640}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">{kind === "cron" ? `Run ${appName}'s scheduler?` : `Add a queue worker for ${appName}?`}</span>
        <span className="text-[12.5px] leading-5 text-muted-foreground">
          {kind === "cron"
            ? "A cron.d file that runs artisan schedule:run every minute, as the owner of its storage folder, like New app does."
            : "A Supervisor program that keeps artisan queue:work running (restarted if it stops), as the owner of its storage folder; Supervisor then reads it (reread, update)."}
          {` On ${serverName}${prod ? " (production)" : ""}.`}
        </span>
      </ModalHeader>
      <div className="flex flex-col gap-2 px-5 pb-4 text-[12.5px]">
        {!plan && !error && (
          <span className="flex items-center gap-2 text-subtle-foreground">
            <Spinner size={11} /> Looking at the app on the server (read-only)…
          </span>
        )}
        {error && <span className="text-env-prod-fg">{error}</span>}
        {plan && (
          <>
            {file && (
              <span className="text-subtle-foreground">
                <span className="font-mono text-foreground">{file}</span> (new file; nothing else changes)
              </span>
            )}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={kind === "cron" ? 4 : 14}
              className="selectable w-full resize-y rounded-md border border-control-border bg-background px-2.5 py-2 font-mono text-[11.5px] leading-[1.5] outline-none focus:border-primary/60"
            />
            <span className="text-[11.5px] text-subtle-foreground">
              Runs as <span className="font-mono">{plan.owner}</span> with <span className="font-mono">{plan.php}</span> in <span className="font-mono">{plan.dir}</span>.{" "}
              {kind === "cron" ? "You can change it here before adding." : "You can change it here before adding (numprocs for more workers, --queue=… for other queues)."}
            </span>
            {blocked && <span className="text-[#8a5a12]">{blocked}</span>}
          </>
        )}
      </div>
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" disabled={busy} onClick={onClose}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn variant={prod ? "danger" : "primary"} disabled={!plan || !!blocked || busy || !text.trim()} onClick={() => void add()}>
          {busy ? "Adding…" : kind === "cron" ? "Add the scheduler" : "Add the worker"}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}
