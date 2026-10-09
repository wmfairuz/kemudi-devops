import { CommandPreviewDialog } from "./CommandPreviewDialog";
import { EditActionDialog } from "./EditActionDialog";
import { DangerConfirmDialog, ProdConfirmDialog } from "./ProdDialogs";
import { VpnBlockedDialog } from "./VpnBlockedDialog";

/** All action dialogs; at most one is open (see stores/actionFlow). */
export function ActionDialogs() {
  return (
    <>
      <CommandPreviewDialog />
      <ProdConfirmDialog />
      <DangerConfirmDialog />
      <VpnBlockedDialog />
      <EditActionDialog />
    </>
  );
}
