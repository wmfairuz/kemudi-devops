import { openServer } from "@/stores/tabs";
import { useServerItems } from "@/stores/watch";

/** "⚠ 2" when the background checks found something on the server (red:
 *  urgent, amber: a warning; info items don't show); click opens the
 *  server's Overview. */
export function AttentionBadge({ server }: { server: { id: string; name: string; host: string; env: string } }) {
  const items = useServerItems(server.id).filter((i) => i.severity !== "info");
  if (items.length === 0) return null;
  const urgent = items.some((i) => i.severity === "urgent");
  return (
    <button
      title={`${items.map((i) => i.text).join("\n")}\n\nClick for the server's overview.`}
      onClick={(e) => {
        e.stopPropagation();
        openServer(server, "overview");
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={
        urgent
          ? "flex h-[18px] flex-none cursor-pointer items-center gap-0.5 rounded-[4px] bg-env-prod px-1 font-mono text-[10px] font-semibold text-white hover:brightness-110"
          : "flex h-[18px] flex-none cursor-pointer items-center gap-0.5 rounded-[4px] bg-env-staging px-1 font-mono text-[10px] font-semibold text-white hover:brightness-110"
      }
    >
      ⚠ {items.length}
    </button>
  );
}
