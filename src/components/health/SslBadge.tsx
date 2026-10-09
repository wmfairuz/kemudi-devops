import { useSslAlerts } from "@/stores/sslAlerts";
import { openHealth } from "@/stores/tabs";

const NONE: never[] = [];

/** "🔒 9d" when one of the server's certificates expires within 14 days
 *  (red within 3, or expired); click opens its health checks. */
export function SslBadge({ server }: { server: { id: string; name: string; host: string; env: string } }) {
  const soon = useSslAlerts((s) => s.soon[server.id] ?? NONE);
  if (soon.length === 0) return null;
  const min = Math.min(...soon.map((c) => c.days));
  return (
    <button
      title={`Certificates expiring: ${soon.map((c) => `${c.name} ${c.days < 0 ? "expired" : `${c.days}d`}`).join(", ")}. Click for health checks.`}
      onClick={(e) => {
        e.stopPropagation();
        openHealth(server);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={
        min <= 3
          ? "flex h-[18px] flex-none cursor-pointer items-center gap-0.5 rounded-[4px] bg-env-prod px-1 font-mono text-[10px] font-semibold text-white hover:brightness-110"
          : "flex h-[18px] flex-none cursor-pointer items-center gap-0.5 rounded-[4px] bg-env-staging px-1 font-mono text-[10px] font-semibold text-white hover:brightness-110"
      }
    >
      🔒 {min < 0 ? "expired" : `${min}d`}
    </button>
  );
}
