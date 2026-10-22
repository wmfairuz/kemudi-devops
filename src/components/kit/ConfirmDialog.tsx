import { useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { useConfirm } from "@/stores/confirm";

export function ConfirmDialog() {
  const ask = useConfirm((s) => s.ask);
  if (!ask) return null;
  return <Ask key={ask.title + ask.message} />;
}

function Ask() {
  const ask = useConfirm((s) => s.ask)!;
  const [typed, setTyped] = useState(ask.input?.value ?? "");
  const done = (ok: boolean) => {
    useConfirm.setState({ ask: null });
    ask.resolve(ok, typed);
  };
  return (
    <Modal open onOpenChange={(o) => !o && done(false)} title={ask.title} width={440}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">{ask.title}</span>
        <span className="text-[12.5px] leading-5 whitespace-pre-line text-muted-foreground">{ask.message}</span>
      </ModalHeader>
      {ask.input && (
        <div className="px-5 pb-4">
          <input
            autoFocus
            value={typed}
            list="kemudi-ask-suggest"
            placeholder={ask.input.placeholder}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && typed.trim() && done(true)}
            className="h-[30px] w-full rounded-lg border border-control-border bg-background px-2.5 text-[13px] outline-none focus:border-primary/60"
          />
          <datalist id="kemudi-ask-suggest">
            {(ask.input.suggestions ?? []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
      )}
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={() => done(false)}>
          {ask.cancel ?? "Cancel"} <Hint>esc</Hint>
        </Btn>
        <Btn autoFocus={!ask.input} variant={ask.input || ask.plain ? "primary" : "danger"} disabled={!!ask.input && !typed.trim()} onClick={() => done(true)}>
          {ask.confirm}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}
