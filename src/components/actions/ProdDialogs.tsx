import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { DangerBadge, EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { runAction } from "@/lib/actions";
import type { RenderedAction } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useActionFlow } from "@/stores/actionFlow";

import { ConfirmToggle } from "./ConfirmToggle";

function where(a: RenderedAction) {
  return a.appId ? `${a.appId} on ${a.serverId}` : a.serverId;
}

function hostLine(a: RenderedAction) {
  if (a.kind === "local") return `this Mac · local shell for ${a.serverId}`;
  return `ssh ${a.host}${a.vpn !== "none" ? ` · via VPN ${a.vpn}` : ""}`;
}

/** Red-framed command block (design 1e/1f). Editable on request. */
function CommandBlock({
  action,
  command,
  editing,
  onChange,
}: {
  action: RenderedAction;
  command: string;
  editing: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-env-prod/55 bg-env-prod/5">
      <div className="flex h-7 items-center gap-2 border-b border-env-prod/25 px-3 font-mono text-[11px] text-env-prod-fg">
        {hostLine(action)}
        {action.cwd && <span className="text-env-prod-fg/70">· {action.cwd}</span>}
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={command}
          spellCheck={false}
          onFocus={caretToEnd}
          onChange={(e) => onChange(e.target.value)}
          className="block h-[104px] w-full resize-none bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-[19px] text-foreground outline-none"
        />
      ) : (
        <div className="selectable px-3 py-2.5 font-mono text-[12.5px] leading-[19px] break-words whitespace-pre-wrap text-foreground">
          {command}
        </div>
      )}
    </div>
  );
}

/** Put the caret after the command, ready to type. */
export function caretToEnd(e: React.FocusEvent<HTMLTextAreaElement>) {
  const n = e.currentTarget.value.length;
  e.currentTarget.setSelectionRange(n, n);
}

function useCommand(open: boolean, action: RenderedAction | null, initial: string | null) {
  const edit = useActionFlow((s) => s.edit);
  const [command, setCommand] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (open && action) {
      setCommand(initial ?? action.rendered);
      setEditing(edit);
    }
  }, [open, action, initial, edit]);
  return { command, setCommand, editing, setEditing, edited: !!action && command.trim() !== action.rendered };
}

/** Design 1e: every prod action confirms with the full command. */
export function ProdConfirmDialog() {
  const open = useActionFlow((s) => s.dialog === "prodConfirm");
  const { action, command: initial, close } = useActionFlow();
  const c = useCommand(open, action, initial);
  if (!action) return null;

  const run = () => {
    if (!c.command.trim()) return;
    close();
    runAction(action, c.command);
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title="Run on production?">
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">Run on production?</span>
          <EnvTag env="prod" />
        </div>
        <span className="text-[12.5px] text-muted-foreground">
          {action.label} · {where(action)}
        </span>
      </ModalHeader>
      <div className="px-5 pb-[14px]">
        <CommandBlock action={action} command={c.command} editing={c.editing} onChange={c.setCommand} />
      </div>
      <ConfirmToggle action={action} command={c.command} />
      <ModalFooter>
        {!c.editing ? (
          <Btn variant="ghost" className="px-2.5" onClick={() => c.setEditing(true)}>
            Edit command
          </Btn>
        ) : (
          c.edited && <span className="text-[11.5px] text-env-staging-fg">Edited</span>
        )}
        <span className="flex-1 text-[11.5px] text-subtle-foreground">Opens in a new prod tab</span>
        <Btn variant="outline" className="pr-2.5" onClick={close}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn autoFocus={!c.editing} variant="danger" className="px-3.5" onClick={run}>
          Run on {action.serverId}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}

/** Design 1f: prod + danger also needs the server id typed. */
export function DangerConfirmDialog() {
  const open = useActionFlow((s) => s.dialog === "dangerConfirm");
  const { action, command: initial, close } = useActionFlow();
  const c = useCommand(open, action, initial);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  if (!action) return null;

  const canRun = typed === action.serverId && c.command.trim() !== "";
  const run = () => {
    if (!canRun) return;
    close();
    runAction(action, c.command);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && close()}
      title={`${action.label} on ${action.env === "prod" ? "production" : action.serverId}`}
      onOpenAutoFocus={(e) => {
        // Editing: the command textarea takes focus. Otherwise the
        // confirmation input does, not the first button.
        if (useActionFlow.getState().edit) return;
        e.preventDefault();
        document.getElementById("danger-confirm-input")?.focus();
      }}
    >
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">
            {action.label} on {action.env === "prod" ? "production" : action.serverId}
          </span>
          <EnvTag env={action.env} />
          {action.danger && <DangerBadge />}
        </div>
        <span className="text-[12.5px] text-muted-foreground">
          {where(action)} · type the server name to run
        </span>
      </ModalHeader>
      <div className="flex flex-col gap-3.5 px-5 pb-4">
        <CommandBlock action={action} command={c.command} editing={c.editing} onChange={c.setCommand} />
        <div className="flex flex-col gap-1.5">
          <div className="text-[12px] text-muted-foreground">
            Type <span className="rounded-sm bg-muted px-[5px] py-px font-mono text-foreground">{action.serverId}</span> to
            confirm
          </div>
          <input
            id="danger-confirm-input"
            value={typed}
            spellCheck={false}
            autoComplete="off"
            placeholder={action.serverId}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run();
            }}
            className={cn(
              "h-8 w-full rounded-lg border bg-background px-2.5 font-mono text-[12.5px] text-foreground outline-none placeholder:text-faint-foreground focus:shadow-[0_0_0_3px_rgba(255,85,85,0.18)]",
              typed === action.serverId ? "border-env-prod/70" : "border-control-border",
            )}
          />
        </div>
      </div>
      <ConfirmToggle action={action} command={c.command} />
      <ModalFooter>
        {!c.editing ? (
          <Btn variant="ghost" className="px-2.5" onClick={() => c.setEditing(true)}>
            Edit command
          </Btn>
        ) : (
          c.edited && <span className="text-[11.5px] text-env-staging-fg">Edited</span>
        )}
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={close}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn variant="danger" className="px-3.5" disabled={!canRun} onClick={run}>
          {action.label} {action.serverId}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}
