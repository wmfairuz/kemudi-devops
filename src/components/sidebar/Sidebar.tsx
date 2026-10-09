import { useRef } from "react";

import { useConfig } from "@/stores/config";
import { useSidebar } from "@/stores/sidebar";
import { useTeamServers } from "@/stores/team";

import { ConfigBanner, ConfigWarnings } from "./ConfigBanner";
import { FooterRow, SidebarFrame } from "./SidebarFrame";
import { SidebarEmpty } from "./SidebarEmpty";
import { ServerTree } from "./ServerTree";
import { TeamSwitcher } from "./TeamSwitcher";

interface Props {
  onHistory: () => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
}

export function Sidebar({ onHistory, filterRef }: Props) {
  const snapshot = useConfig((s) => s.snapshot);
  const filter = useSidebar((s) => s.filter);
  const setFilter = useSidebar((s) => s.setFilter);
  const local = useRef(null);
  const all = snapshot?.config?.servers ?? [];
  const servers = useTeamServers();

  return (
    <SidebarFrame
      filter={filter}
      onFilter={setFilter}
      filterRef={filterRef ?? local}
      top={<TeamSwitcher />}
      footer={
        <>
          <FooterRow onClick={onHistory}>
            <span className="flex-1">History</span>
            <span className="font-mono text-[10.5px] text-faint-foreground">⌘Y</span>
          </FooterRow>
        </>
      }
    >
      {snapshot && <ConfigBanner snapshot={snapshot} />}
      {snapshot && <ConfigWarnings snapshot={snapshot} />}
      {snapshot && all.length > 0 && servers.length === 0 && (
        <div className="px-4 py-3 text-[12px] text-subtle-foreground">No servers in this team yet: pick a team on a server's page.</div>
      )}
      {snapshot && servers.length > 0 ? (
        <ServerTree servers={servers} stale={snapshot.stale} />
      ) : all.length > 0 ? (
        <div className="flex-1" />
      ) : (
        <>
          {snapshot && snapshot.errors.length === 0 && <SidebarEmpty snapshot={snapshot} />}
          <div className="flex-1" />
        </>
      )}
    </SidebarFrame>
  );
}
