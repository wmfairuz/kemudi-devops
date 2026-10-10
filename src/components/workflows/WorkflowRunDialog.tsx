import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { errorMessage, workflowScript, type Workflow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { runWorkflow, serversTouched, stepTitle } from "@/lib/workflows";
import { useConfig } from "@/stores/config";
import { useWorkflows } from "@/stores/workflows";

export function WorkflowRunDialog() {
  const running = useWorkflows((s) => s.running);
  const wf = useConfig((s) => s.snapshot?.config?.workflows.find((w) => w.id === running?.id));
  if (!running || !wf) return null;
  return <RunDialog key={`${wf.id}/${running.from}`} wf={wf} from={running.from} />;
}

const KIND: Record<string, string> = { local: "this Mac", server: "server", action: "action", pause: "pause", parallel: "at once", watch: "watch" };

/** Run a workflow: its steps (click one to start there), the exact script,
 *  and on production the server's name typed first. */
function RunDialog({ wf, from: initialFrom }: { wf: Workflow; from: number }) {
  const config = useConfig((s) => s.snapshot?.config);
  const [from, setFrom] = useState(initialFrom);
  const [script, setScript] = useState<string | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const close = () => useWorkflows.getState().close();
  const touched = serversTouched(config, wf, from);
  const prodServer = touched.find((s) => s.env === "prod");
  const ok = wf.steps.length > 0 && (!prodServer || typed.trim() === prodServer.id);

  useEffect(() => {
    if (script === null) return;
    workflowScript(wf.id, from).then(
      (s) => {
        setScript(s);
        setScriptError(null);
      },
      (e: unknown) => setScriptError(errorMessage(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

  const showScript = () =>
    workflowScript(wf.id, from).then(
      (s) => {
        setScript(s);
        setScriptError(null);
      },
      (e: unknown) => setScriptError(errorMessage(e)),
    );

  const run = () => {
    if (!ok) return;
    close();
    runWorkflow(wf, from);
  };

  return (
    <Modal open onOpenChange={(o) => !o && close()} title={`Run ${wf.name}`} width={760}>
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">{wf.name}</span>
          {prodServer && <EnvTag env="prod" />}
          <span className="flex-1" />
          <Btn size="sm" variant="ghost" onClick={() => useWorkflows.getState().edit(wf)}>
            <Pencil className="size-3.5" /> Edit
          </Btn>
        </div>
        <span className="text-[12.5px] text-muted-foreground">
          Runs in one terminal tab, top to bottom; answer prompts (passwords, questions) there. Steps at once and watches open their own panes
          beside it. The first step that fails stops it, and you can run again from that step. Click a step to start there.
        </span>
      </ModalHeader>
      <div className="flex max-h-[min(60vh,560px)] flex-col gap-3 overflow-y-auto px-5 pb-4">
        <ol className="flex flex-col gap-1">
          {wf.steps.map((s, i) => {
            const n = i + 1;
            const skipped = n < from;
            return (
              <li key={n}>
                <button
                  type="button"
                  onClick={() => setFrom(n)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-left",
                    n === from ? "border-primary/60 bg-primary/8" : "border-transparent hover:bg-hover",
                    skipped && "opacity-45",
                  )}
                  title={n === from ? "Starts here" : `Start at step ${n}`}
                >
                  <span className="w-5 flex-none text-right font-mono text-[12px] text-subtle-foreground">{n}</span>
                  <span className="w-[68px] flex-none text-[11px] text-subtle-foreground uppercase">{KIND[s.kind]}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{stepTitle(config, s)}</span>
                  {(s.kind === "local" || s.kind === "server" || s.kind === "watch") && (
                    <span className="max-w-[45%] truncate font-mono text-[11px] text-soft-foreground" title={s.run}>
                      {s.run}
                    </span>
                  )}
                  {n === from && from > 1 && <span className="text-[11px] text-primary">start</span>}
                </button>
                {s.kind === "parallel" && (
                  <ol className={cn("ml-[60px] flex flex-col gap-0.5 border-l border-divider pl-3", skipped && "opacity-45")}>
                    {s.branches.map((b, j) => (
                      <li key={j} className="flex items-center gap-2.5 py-1 text-[12.5px]">
                        <span className="font-mono text-[11px] text-subtle-foreground">
                          {n}.{j + 1}
                        </span>
                        <span className="w-[68px] flex-none text-[11px] text-subtle-foreground uppercase">{KIND[b.kind]}</span>
                        <span className="min-w-0 flex-1 truncate">{stepTitle(config, b)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ol>
        {wf.steps.length === 0 && <div className="text-[12.5px] text-subtle-foreground">No steps yet: Edit to add some.</div>}
        {touched.length > 0 && (
          <div className="text-[12px] text-subtle-foreground">
            Connects to {touched.map((s) => s.name).join(", ")} (each checked to be reachable first).
          </div>
        )}
        {scriptError && <div className="rounded-md bg-env-prod/8 px-2.5 py-1.5 text-[12px] text-env-prod-fg">{scriptError}</div>}
        {script !== null && !scriptError && (
          <pre className="selectable max-h-[260px] overflow-auto rounded-lg border border-divider bg-background px-3 py-2 font-mono text-[11px] leading-[16px] whitespace-pre text-foreground">
            {script}
          </pre>
        )}
      </div>
      <ModalFooter>
        <Btn variant="ghost" onClick={() => (script === null ? void showScript() : setScript(null))}>
          {script === null ? "Show script" : "Hide script"}
        </Btn>
        {prodServer && (
          <input
            value={typed}
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder={`type ${prodServer.id} to run`}
            aria-label="Type the production server's name to run"
            className={cn(
              "h-[30px] w-[220px] rounded-lg border bg-background px-2.5 font-mono text-[12.5px] outline-none placeholder:text-faint-foreground",
              typed.trim() === prodServer.id ? "border-env-prod/70" : "border-control-border",
            )}
          />
        )}
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={close}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn variant={prodServer ? "danger" : "primary"} disabled={!ok} onClick={run}>
          {from > 1 ? `Run from step ${from}` : "Run"}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}
