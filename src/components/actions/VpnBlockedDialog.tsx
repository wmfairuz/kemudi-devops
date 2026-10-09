import { Btn } from "@/components/kit/Btn";
import { Modal, ModalFooter } from "@/components/kit/Modal";
import { connectVpn } from "@/lib/actions";
import { useActionFlow } from "@/stores/actionFlow";

/** Design 1g: the preflight probe failed for a VPN server. */
export function VpnBlockedDialog() {
  const open = useActionFlow((s) => s.dialog === "vpn");
  const { action, status, retry, close } = useActionFlow();
  if (!action) return null;
  const target = status?.target ?? "no probe target";
  const isGp = action.vpn === "globalprotect";

  return (
    <Modal open={open} onOpenChange={(o) => !o && close()} title={`${action.serverId} is unreachable`} width={520}>
      <div className="flex gap-3 px-5 pt-[18px] pb-4">
        <span className="flex size-7 flex-none items-center justify-center rounded-full bg-env-prod/14">
          <span className="size-2 rounded-full bg-env-prod" />
        </span>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-[14px] leading-5 font-semibold">
            {action.serverId} is unreachable ({target})
          </div>
          <div className="text-[12.5px] leading-[19px] text-pretty text-muted-foreground">
            This server is behind the <span className="font-mono text-foreground">{action.vpn}</span> VPN.{" "}
            {isGp ? "Connect GlobalProtect first, then retry." : "Connect the VPN, then retry."}
          </div>
          {status?.error && (
            <div className="selectable rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[11.5px] leading-[17px] text-dim-foreground">
              connect to {target}: {status.error}
            </div>
          )}
        </div>
      </div>
      <ModalFooter>
        <Btn variant="ghost" className="px-2.5" onClick={close}>
          Cancel
        </Btn>
        <span className="flex-1" />
        <Btn
          variant={isGp ? "primary" : "secondary"}
          onClick={() => {
            close();
            retry?.();
          }}
        >
          Retry
        </Btn>
        {!isGp && (
          <Btn
            variant="primary"
            className="px-3.5"
            onClick={() => {
              close();
              connectVpn(action.serverId);
            }}
          >
            Connect VPN
          </Btn>
        )}
      </ModalFooter>
    </Modal>
  );
}
