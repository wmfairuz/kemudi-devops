import { useState } from "react";

import { PopupMenu, type MenuItem } from "@/components/kit/PopupMenu";
import { triggerAction } from "@/lib/actions";

type Kind = "service" | "supervisor";

const VERBS: { verb: string; label: string; hint: string }[] = [
  { verb: "status", label: "Status", hint: "" },
  { verb: "start", label: "Start", hint: "" },
  { verb: "stop", label: "Stop", hint: "asks first" },
  { verb: "restart", label: "Restart", hint: "asks first" },
];

/** A click menu for a systemd service (Health) or a Supervisor program
 *  (Inspect): Status / Start / Stop / Restart, each run as an action in a
 *  tab (guardrails, History; as root via sudo, or `sudo su` where that's
 *  the only passwordless way). */
export function useServiceMenu(serverId: string, appId: string | null = null) {
  const [menu, setMenu] = useState<{ x: number; y: number; kind: Kind; name: string } | null>(null);
  const open = (e: React.MouseEvent<HTMLElement>, kind: Kind, name: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, kind, name });
  };
  const items: MenuItem[] = menu
    ? VERBS.map(({ verb, label, hint }) => ({
        label,
        hint: hint || undefined,
        run: () => void triggerAction({ serverId, appId, actionId: `${menu.kind}:${verb}:${menu.name}` }),
      }))
    : [];
  const node = menu && (
    <PopupMenu
      x={menu.x}
      y={menu.y}
      title={menu.kind === "service" ? `${menu.name} (systemd)` : `${menu.name} (Supervisor)`}
      groups={[items]}
      onClose={() => setMenu(null)}
    />
  );
  return { open, node };
}
