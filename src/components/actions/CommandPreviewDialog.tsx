import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { runAction, sendAction, sendTarget } from "@/lib/actions";
import { useActionFlow } from "@/stores/actionFlow";

import { ConfirmToggle } from "./ConfirmToggle";
import { caretToEnd } from "./ProdDialogs";
import { activeTab, useTabs } from "@/stores/tabs";

/** Design frame 1d: editable command preview. ⌘↵ runs, ⌥↵ sends. */
export function CommandPreviewDialog() {
  const open = useActionFlow((s) => s.dialog === "preview");
  const action = useActionFlow((s) => s.action);
  const initial = useActionFlow((s) => s.command);
  const close = useActionFlow((s) => s.close);
  const currentTitle = useTabs((s) => activeTab(s)?.title ?? "none");
  const [cmd, setCmd] = useState("");

  useEffect(() => {
    if (open && action) setCmd(initial ?? action.rendered);
  }, [open, action, initial]);

  if (!action) return null;
  const edited = cmd.trim() !== action.rendered;
  const target = sendTarget(action);
  const where = action.appId ? `${action.appId} on ${action.serverId}` : action.serverId;

  const run = () => {
    if (!cmd.trim()) return;
    close();
    runAction(action, cmd);
  };
  const send = async () => {
    if (!cmd.trim() || !target.tab) return;
    close();
    await sendAction(action, cmd);
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title={`${action.label} preview`}>
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">{action.label}</span>
          <EnvTag env={action.env} />
        </div>
        <span className="text-[12.5px] text-muted-foreground">{where}</span>
      </ModalHeader>
      <div className="flex flex-col gap-3 px-5 pb-4">
        <div className="grid grid-cols-[72px_1fr] gap-y-1.5 text-[12px]">
          <span className="text-subtle-foreground">Target</span>
          <span className="font-mono text-[11.5px] text-soft-foreground">
            {action.kind === "local" ? "this Mac · local shell" : `ssh ${action.host}`}
          </span>
          <span className="text-subtle-foreground">Directory</span>
          <span className="font-mono text-[11.5px] text-soft-foreground">{action.cwd ?? "~"}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center text-[12px] text-subtle-foreground">
            <span className="flex-1">Command</span>
            {edited && <span className="mr-2.5 text-env-staging-fg">Edited</span>}
          </div>
          <textarea
            autoFocus
            onFocus={caretToEnd}
            value={cmd}
            spellCheck={false}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                run();
              } else if (e.key === "Enter" && e.altKey) {
                e.preventDefault();
                void send();
              }
            }}
            className="h-[104px] w-full resize-none rounded-xl border border-input bg-background px-3 py-2.5 font-mono text-[12.5px] leading-[19px] text-foreground outline-none focus:border-ring focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]"
          />
        </div>
      </div>
      <ConfirmToggle action={action} command={cmd} />
      <ModalFooter>
        <Btn variant="ghost" className="px-2.5" onClick={() => setCmd(action.rendered)} disabled={!edited}>
          Reset
        </Btn>
        <span className="flex-1 truncate text-[11.5px] text-subtle-foreground">Current tab: {currentTitle}</span>
        <Btn className="pr-2.5" disabled={!target.tab} title={target.reason ?? undefined} onClick={() => void send()}>
          Send to current tab <Hint>⌥↵</Hint>
        </Btn>
        <Btn variant="primary" className="pr-2.5 pl-3.5" onClick={run}>
          Run <Hint className="text-faint-foreground">⌘↵</Hint>
        </Btn>
      </ModalFooter>
    </Modal>
  );
}
