import { useDiskAlerts } from "@/stores/diskAlerts";
import { openMonitor } from "@/stores/tabs";

const NONE: never[] = [];

/** Red "⚠ 92%" when one of the server's disks is past the red threshold;
 *  click opens its monitor. */
export function DiskBadge({ server }: { server: { id: string; name: string; host: string; env: string } }) {
  const full = useDiskAlerts((s) => s.full[server.id] ?? NONE);
  if (full.length === 0) return null;
  const top = Math.max(...full.map((d) => d.pct));
  return (
    <button
      title={`Disk almost full: ${full.map((d) => `${d.mount} ${d.pct.toFixed(0)}%`).join(", ")}. Click to open the monitor.`}
      onClick={(e) => {
        e.stopPropagation();
        openMonitor(server);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="flex h-[18px] flex-none cursor-pointer items-center gap-0.5 rounded-[4px] bg-env-prod px-1 font-mono text-[10px] font-semibold text-white hover:brightness-110"
    >
      ⚠ {top.toFixed(0)}%
    </button>
  );
}
