import { Btn } from "@/components/kit/Btn";
import type { ConfigSnapshot } from "@/lib/ipc";
import { openDetails } from "@/stores/manage";

/** Design frame 1b: dashed card when there's nothing to show. */
export function SidebarEmpty(_: { snapshot: ConfigSnapshot }) {
  return (
    <div className="m-2.5 flex flex-col gap-1.5 rounded-xl border border-dashed border-input p-3.5">
      <div className="text-[12.5px] font-medium text-foreground">No servers</div>
      <div className="text-[11.5px] leading-4 text-subtle-foreground">Add one with its SSH host, environment and apps.</div>
      <div className="mt-1 flex gap-1.5">
        <Btn size="sm" variant="primary" onClick={() => openDetails({ kind: "server", serverId: null })}>
          Add server
        </Btn>
      </div>
    </div>
  );
}
