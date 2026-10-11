import { useEffect, useState } from "react";

import { instanceLabel } from "@/lib/fleet";
import { asgInstances, type Instance, type Server } from "@/lib/ipc";
import { useTabs, type Tab } from "@/stores/tabs";

/** Which instance of an AWS server a Logs tab reads (each writes its own
 *  logs); the first running one until another is picked. */
export function InstanceSwitch({ server, tab }: { server: Server; tab: Tab }) {
  const [list, setList] = useState<Instance[]>([]);
  useEffect(() => {
    // One retry: AWS sometimes throttles a burst of calls.
    const look = () => asgInstances(server.id).catch(() => new Promise<Instance[]>((r) => setTimeout(r, 2000)).then(() => asgInstances(server.id)));
    look().then(
      (l) => {
        setList(l);
        // Pin the one being shown, so shells opened from the view go there.
        const first = l[0];
        if (!tab.instance && first) useTabs.getState().update(tab.id, { instance: first.id });
      },
      () => setList([]),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);
  if (list.length < 2) return null;
  return (
    <select
      aria-label="Instance"
      title="Each instance writes its own logs"
      value={tab.instance ?? list[0]?.id ?? ""}
      onChange={(e) => useTabs.getState().update(tab.id, { instance: e.target.value })}
      className="h-7 min-w-0 rounded-md border border-control-border bg-background px-1.5 font-mono text-[12px] outline-none focus:border-primary/60"
    >
      {list.map((i) => (
        <option key={i.id} value={i.id}>
          {instanceLabel(i)}
        </option>
      ))}
    </select>
  );
}

/** Files on an AWS server: what it reads, and where changes go. */
export function FleetFilesNote({ server }: { server: Server }) {
  const [list, setList] = useState<Instance[] | null>(null);
  useEffect(() => {
    asgInstances(server.id).then(setList, () => setList(null));
  }, [server.id]);
  if (!list || list.length === 0) return null;
  const first = list[0]!;
  return (
    <span
      className="rounded bg-primary/10 px-1.5 text-[10.5px] whitespace-nowrap text-primary"
      title={`Reads ${instanceLabel(first)} (${first.id}); saving, uploading, renaming, deleting and permissions go to all ${list.length} instances, so they stay alike`}
    >
      {list.length > 1 ? `${instanceLabel(first)} · changes to all ${list.length}` : instanceLabel(first)}
    </span>
  );
}
