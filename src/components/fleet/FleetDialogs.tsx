import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { instanceLabel, openAsgShells, openForward, openInstanceShell, whereOf } from "@/lib/fleet";
import { asgInstances, errorMessage, rdsDatabases, type Database, type Instance, type Server } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useFleetUi } from "@/stores/fleetUi";

type Load<T> = T | "loading" | { error: string };
const failed = <T,>(l: Load<T>): l is { error: string } => typeof l === "object" && l !== null && "error" in l;

function useInstances(server: Server): Load<Instance[]> {
  const [list, setList] = useState<Load<Instance[]>>("loading");
  useEffect(() => {
    asgInstances(server.id).then(setList, (e: unknown) => setList({ error: errorMessage(e) }));
  }, [server.id]);
  return list;
}

function InstanceRow({ i, selected, onClick, children }: { i: Instance; selected?: boolean; onClick?: () => void; children?: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2 text-[12.5px]",
        onClick && "cursor-pointer hover:bg-hover",
        selected ? "border-primary/60 bg-primary/8" : "border-divider",
      )}
    >
      <span className="font-mono text-foreground">{instanceLabel(i)}</span>
      <span className="min-w-0 flex-1 truncate text-subtle-foreground">
        {i.id}
        {i.name ? ` · ${i.name}` : ""}
        {i.az ? ` · ${i.az}` : ""}
      </span>
      {children}
    </div>
  );
}

/** Right-click ▸ Shell on one instance… */
function PickInstance({ server, app }: { server: Server; app: Server["apps"][number] | null }) {
  const list = useInstances(server);
  const close = () => useFleetUi.getState().close();
  return (
    <Modal open onOpenChange={(o) => !o && close()} title="Shell on one instance" width={560}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">A shell on one instance</span>
        <span className="text-[12.5px] text-muted-foreground">
          {app ? `${app.name} on ` : ""}
          {server.name} · {whereOf(server)}
        </span>
      </ModalHeader>
      <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto px-5 pb-4">
        {list === "loading" && <span className="text-[12.5px] text-subtle-foreground">Looking up the running instances…</span>}
        {failed(list) && <span className="text-[12.5px] whitespace-pre-wrap text-env-prod-fg">{list.error}</span>}
        {Array.isArray(list) && list.length === 0 && <span className="text-[12.5px] text-subtle-foreground">No running instances.</span>}
        {Array.isArray(list) &&
          list.map((i) => (
            <InstanceRow
              key={i.id}
              i={i}
              onClick={() => {
                close();
                openInstanceShell(server, i, app);
              }}
            >
              <span className="text-[11.5px] text-primary">Shell ▸</span>
            </InstanceRow>
          ))}
      </div>
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={close}>
          Cancel <Hint>esc</Hint>
        </Btn>
        {Array.isArray(list) && list.length > 1 && (
          <Btn
            variant="primary"
            onClick={() => {
              close();
              void openAsgShells(server, app);
            }}
          >
            All {list.length}, typing in all
          </Btn>
        )}
      </ModalFooter>
    </Modal>
  );
}

const lastKey = (serverId: string) => `kemudi.forward.${serverId}`;
interface Last {
  db: string;
  instance: string;
  port: number;
}
function readLast(serverId: string): Partial<Last> {
  try {
    return JSON.parse(localStorage.getItem(lastKey(serverId)) ?? "{}") as Partial<Last>;
  } catch {
    return {};
  }
}

/** Right-click ▸ Forward a database port… (like aws-db-fwdport): an RDS
 *  database, an instance to go through, a local port. */
function Forward({ server }: { server: Server }) {
  const instances = useInstances(server);
  const [dbs, setDbs] = useState<Load<Database[]>>("loading");
  const last = readLast(server.id);
  const [db, setDb] = useState<string | null>(last.db ?? null);
  const [via, setVia] = useState<string | null>(last.instance ?? null);
  const [port, setPort] = useState(String(last.port ?? 33060));
  const close = () => useFleetUi.getState().close();
  useEffect(() => {
    rdsDatabases(server.id).then(setDbs, (e: unknown) => setDbs({ error: errorMessage(e) }));
  }, [server.id]);

  const dbList = Array.isArray(dbs) ? dbs : [];
  const instList = Array.isArray(instances) ? instances : [];
  // The last ones when they're still there, else the first.
  const pickedDb = dbList.find((d) => d.id === db) ?? (dbList.length === 1 ? dbList[0] : undefined);
  const pickedVia = instList.find((i) => i.id === via) ?? instList[0];
  const localPort = /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) < 65536 ? Number(port) : null;
  const ok = !!pickedDb && !!pickedVia && localPort !== null;
  const start = () => {
    if (!ok || !pickedDb || !pickedVia || localPort === null) return;
    try {
      localStorage.setItem(lastKey(server.id), JSON.stringify({ db: pickedDb.id, instance: pickedVia.id, port: localPort }));
    } catch {
      // Not remembered; fine.
    }
    close();
    openForward(server, pickedVia, pickedDb, localPort);
  };

  return (
    <Modal open onOpenChange={(o) => !o && close()} title="Forward a database port" width={600}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">Forward a database port</span>
        <span className="text-[12.5px] text-muted-foreground">
          127.0.0.1:{localPort ?? "…"} on this Mac reaches the database through one of {server.name}'s instances (Session Manager). The tab
          keeps it open; close it to stop.
        </span>
      </ModalHeader>
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 pb-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium tracking-wide text-faint-foreground uppercase">Database</span>
          {dbs === "loading" && <span className="text-[12.5px] text-subtle-foreground">Looking up RDS databases…</span>}
          {failed(dbs) && <span className="text-[12.5px] whitespace-pre-wrap text-env-prod-fg">{dbs.error}</span>}
          {Array.isArray(dbs) && dbs.length === 0 && <span className="text-[12.5px] text-subtle-foreground">No RDS databases in this profile and region.</span>}
          {dbList.map((d) => (
            <div
              key={d.id}
              onClick={() => setDb(d.id)}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-[12.5px] hover:bg-hover",
                pickedDb?.id === d.id ? "border-primary/60 bg-primary/8" : "border-divider",
              )}
            >
              <span className="font-mono text-foreground">{d.id}</span>
              <span className="min-w-0 flex-1 truncate text-subtle-foreground">
                {d.host}:{d.port}
              </span>
              <span className="text-[11px] text-subtle-foreground">
                {[d.cluster ? "cluster" : null, d.engine, d.status].filter(Boolean).join(" · ")}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium tracking-wide text-faint-foreground uppercase">Through</span>
          {instances === "loading" && <span className="text-[12.5px] text-subtle-foreground">Looking up the running instances…</span>}
          {failed(instances) && <span className="text-[12.5px] whitespace-pre-wrap text-env-prod-fg">{instances.error}</span>}
          {instList.map((i) => (
            <InstanceRow key={i.id} i={i} selected={pickedVia?.id === i.id} onClick={() => setVia(i.id)} />
          ))}
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          Local port
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && start()}
            className={cn(
              "h-[30px] w-[100px] rounded-lg border bg-background px-2.5 font-mono text-[12.5px] outline-none",
              localPort === null ? "border-env-prod/70" : "border-control-border",
            )}
          />
          <span className="text-[11.5px] text-subtle-foreground">127.0.0.1:{localPort ?? "?"} → {pickedDb ? `${pickedDb.host}:${pickedDb.port}` : "…"}</span>
        </label>
      </div>
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={close}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn variant="primary" disabled={!ok} onClick={start}>
          Forward
        </Btn>
      </ModalFooter>
    </Modal>
  );
}

export function FleetDialogs() {
  const pick = useFleetUi((s) => s.pick);
  const forward = useFleetUi((s) => s.forward);
  if (pick) return <PickInstance key={pick.server.id} server={pick.server} app={pick.app} />;
  if (forward) return <Forward key={forward.id} server={forward} />;
  return null;
}
