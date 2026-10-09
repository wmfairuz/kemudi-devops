import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { useConfirm } from "@/stores/confirm";

export function ConfirmDialog() {
  const ask = useConfirm((s) => s.ask);
  if (!ask) return null;
  const done = (ok: boolean) => {
    useConfirm.setState({ ask: null });
    ask.resolve(ok);
  };
  return (
    <Modal open onOpenChange={(o) => !o && done(false)} title={ask.title} width={440}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">{ask.title}</span>
        <span className="text-[12.5px] leading-5 text-muted-foreground">{ask.message}</span>
      </ModalHeader>
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={() => done(false)}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn autoFocus variant="danger" onClick={() => done(true)}>
          {ask.confirm}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}
