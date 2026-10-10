import { Activity, History, KeyRound, Plus, Settings, SquareTerminal, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { LogoMark } from "@/components/kit/Logo";
import { StatusDot } from "@/components/kit/StatusDot";
import { Badge } from "@/components/manage/Badge";
import { DiskBadge } from "@/components/monitor/DiskBadge";
import { SslBadge } from "@/components/health/SslBadge";
import { ColorDot, openTabConfig, useTabConfigs } from "@/components/tabconfigs/TabConfigs";
import { triggerAction } from "@/lib/actions";
import {
  auditList,
  errorMessage,
  sshConfigOpen,
  sshHosts,
  sshManagedHosts,
  tabConfigsList,
  type AuditRun,
  type TabConfigEntry,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { openDetails } from "@/stores/manage";
import { useCurrentTeam, useTeamServers } from "@/stores/team";
import { useStatus } from "@/stores/status";
import { openLocalShell, openMonitor, openSsh, useTabs } from "@/stores/tabs";
import { toastError } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useConfig } from "@/stores/config";
import { useWorkflows } from "@/stores/workflows";
import type { Workflow } from "@/lib/ipc";

import { SshHostDialog, useSshHostDialog } from "./SshHostDialog";


function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** The pinned Home tab: quick actions, tab configs, servers, SSH hosts and
 *  recent runs in one place. Also what shows with no terminals open. */
export function HomeView() {
  const servers = useTeamServers();
  const team = useCurrentTeam();
  const status = useStatus((s) => s.byServer);
  const saved = useSshHostDialog((s) => s.saved);
  const configsView = useTabConfigs((s) => s.view);
  const [configs, setConfigs] = useState<TabConfigEntry[] | null>(null);
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [managed, setManaged] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<AuditRun[] | null>(null);

  useEffect(() => {
    // Reload when a tab-config dialog closes.
    if (configsView === null) tabConfigsList().then(setConfigs, () => setConfigs([]));
  }, [configsView]);
  useEffect(() => {
    sshHosts().then(setHosts, () => setHosts([]));
    sshManagedHosts().then((m) => setManaged(new Set(m.map((h) => h.alias))), () => {});
  }, [saved]);
  useEffect(() => {
    auditList({ limit: 6 }).then((d) => setRuns(d.runs), () => setRuns([]));
  }, []);

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-8 pt-10 pb-12">
        <div className="flex flex-wrap items-center gap-4">
          <LogoMark className="h-10 self-center" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[22px] font-semibold tracking-[-0.01em]">Kemudi Devops</span>
            <span className="text-[12.5px] text-subtle-foreground">
              {servers.length} server{servers.length === 1 ? "" : "s"} ·{" "}
              {servers.reduce((n, s) => n + s.apps.length, 0)} apps
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn variant="primary" className="pr-2.5" onClick={() => openLocalShell()}>
              <SquareTerminal className="size-4" /> New terminal <Hint className="text-primary-foreground/60">⌘T</Hint>
            </Btn>
            <Btn variant="outline" className="pr-2.5" onClick={() => useUi.getState().setOverlay("ssh")}>
              SSH to host… <Hint>⇧⌘T</Hint>
            </Btn>
            <Btn variant="outline" onClick={() => openDetails({ kind: "server", serverId: null })}>
              <Plus className="size-4" /> Add server
            </Btn>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <WorkflowsCard />
          <Card
            title="Tab configs"
            action={{ label: "New", run: () => useTabConfigs.getState().show({ edit: null }) }}
            footer={
              <button className="hover:text-foreground" onClick={() => useTabConfigs.getState().show("list")}>
                Edit tab configs…
              </button>
            }
          >
            {configs === null ? (
              <Empty>Loading…</Empty>
            ) : configs.length === 0 ? (
              <Empty>None yet: a tab of panes that each open a folder and run commands (e.g. pull here, deploy there).</Empty>
            ) : (
              configs.map((c) => (
                <Row key={`${c.source}/${c.file}`} onClick={() => openTabConfig(c)} disabled={!c.layout}>
                  <ColorDot color={c.config.color} className="size-3" />
                  <span className="flex-1 truncate text-[13px] font-medium">{c.config.name}</span>
                  <span className="text-[11px] text-subtle-foreground">
                    {c.error ? "can't read" : c.source === "warp" ? "Warp" : ""}
                  </span>
                </Row>
              ))
            )}
          </Card>

          <Card title="Servers" action={{ label: "Add", run: () => openDetails({ kind: "server", serverId: null }) }}>
            {servers.length === 0 ? (
              <Empty>
                {team
                  ? `No servers in ${team.name} yet: add one, or pick ${team.name} as the team on a server's page.`
                  : "Add your first server: its SSH host, environment and apps."}
              </Empty>
            ) : (
              servers.map((s) => (
                <Row key={s.id} onClick={() => openDetails({ kind: "server", serverId: s.id })}>
                  <span className="relative flex-none">
                    <Badge id={s.id} name={s.name} size={26} />
                    <span className="absolute -right-1 -bottom-1 flex rounded-full bg-background p-[2px]">
                      <StatusDot status={status[s.id]?.state ?? "unknown"} />
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium">{s.name}</span>
                    <span className="truncate text-[11px] text-subtle-foreground">
                      {s.host} · {s.apps.length} app{s.apps.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <DiskBadge server={s} />
                  <SslBadge server={s} />
                  <EnvTag env={s.env} />
                  <Btn
                    size="sm"
                    variant="outline"
                    title="Monitor: CPU, memory, disks, top processes"
                    onClick={(e) => {
                      e.stopPropagation();
                      openMonitor(s);
                    }}
                  >
                    <Activity className="size-3.5" />
                  </Btn>
                  <Btn
                    size="sm"
                    variant="outline"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSsh(s.host, { serverId: s.id, prod: s.env === "prod", title: `${s.id} · ssh` });
                    }}
                  >
                    ssh
                  </Btn>
                </Row>
              ))
            )}
          </Card>

          <Card
            title="SSH hosts"
            action={{ label: "New", run: () => useSshHostDialog.getState().open(null) }}
            footer={
              <button className="hover:text-foreground" onClick={() => void sshConfigOpen().catch((e) => toastError(errorMessage(e)))}>
                Open ~/.ssh/config
              </button>
            }
          >
            {hosts === null ? (
              <Empty>Loading…</Empty>
            ) : hosts.length === 0 ? (
              <Empty>No SSH hosts yet. Add one here instead of editing ~/.ssh/config.</Empty>
            ) : (
              hosts.map((h) => (
                <Row key={h} onClick={() => useSshHostDialog.getState().open(h)}>
                  <TerminalSquare className="size-4 flex-none text-subtle-foreground" strokeWidth={1.75} />
                  <span className="flex-1 truncate font-mono text-[12.5px]">{h}</span>
                  {managed.has(h) && (
                    <span className="rounded-[4px] border border-primary/30 bg-primary/8 px-1.5 text-[10.5px] text-primary">Kemudi</span>
                  )}
                </Row>
              ))
            )}
          </Card>

          <Card
            title="Recent runs"
            footer={
              <button className="hover:text-foreground" onClick={() => useTabs.getState().openHistory()}>
                All history ⌘Y
              </button>
            }
          >
            {runs === null ? (
              <Empty>Loading…</Empty>
            ) : runs.length === 0 ? (
              <Empty>Nothing run yet. Actions you run show up here.</Empty>
            ) : (
              runs.map((r) => (
                <Row
                  key={r.id}
                  onClick={() =>
                    void triggerAction({ serverId: r.serverId, appId: r.appId, actionId: r.actionId }, { command: r.command })
                  }
                  title="Run again (asks first, like a click)"
                >
                  <span
                    className={cn(
                      "w-4 flex-none text-center text-[12px]",
                      r.exitCode === 0 ? "text-status-up" : r.exitCode === null ? "text-subtle-foreground" : "text-env-prod-fg",
                    )}
                  >
                    {r.exitCode === 0 ? "✓" : r.exitCode === null ? "·" : "✗"}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium">{r.label}</span>
                    <span className="truncate text-[11px] text-subtle-foreground">
                      {r.appId ? `${r.appId} on ` : ""}
                      {r.serverId}
                    </span>
                  </span>
                  <span className="text-[11px] text-subtle-foreground">{ago(r.startedAt)}</span>
                </Row>
              ))
            )}
          </Card>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-subtle-foreground">
          <LinkBtn onClick={() => useUi.getState().setOverlay("settings")}>
            <Settings className="size-3.5" /> Settings ⌘,
          </LinkBtn>
          <LinkBtn onClick={() => useTabs.getState().openHistory()}>
            <History className="size-3.5" /> History ⌘Y
          </LinkBtn>
          <LinkBtn onClick={() => useUi.getState().setOverlay("passwords")}>
            <KeyRound className="size-3.5" /> Passwords
          </LinkBtn>
          <LinkBtn onClick={() => useUi.getState().setOverlay("environment")}>Environment</LinkBtn>
          <LinkBtn onClick={() => void sshConfigOpen().catch((e) => toastError(errorMessage(e)))}>~/.ssh/config</LinkBtn>
        </div>
      </div>
      <SshHostDialog />
    </div>
  );
}

function Card({
  title,
  action,
  footer,
  children,
}: {
  title: string;
  action?: { label: string; run: () => void };
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-[180px] flex-col overflow-hidden rounded-xl border border-divider bg-panel">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-4">
        <span className="flex-1 text-[12px] font-semibold tracking-wide text-subtle-foreground uppercase">{title}</span>
        {action && (
          <button
            onClick={action.run}
            className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] text-primary hover:bg-primary/10"
          >
            <Plus className="size-3.5" /> {action.label}
          </button>
        )}
      </div>
      <div className="flex max-h-[280px] flex-1 flex-col overflow-y-auto py-1">{children}</div>
      {footer && <div className="flex-none border-t border-divider px-4 py-2 text-[12px] text-subtle-foreground">{footer}</div>}
    </section>
  );
}

function Row({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      title={title}
      aria-disabled={disabled}
      onClick={() => !disabled && onClick()}
      onKeyDown={(e) => e.key === "Enter" && !disabled && onClick()}
      className={cn(
        "mx-1.5 flex min-h-10 cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5",
        disabled ? "opacity-50" : "hover:bg-hover",
      )}
    >
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-3 text-[12.5px] leading-5 text-subtle-foreground">{children}</div>;
}

function LinkBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex cursor-pointer items-center gap-1.5 hover:text-foreground">
      {children}
    </button>
  );
}

const NO_WORKFLOWS: Workflow[] = [];

/** Workflows: click to run (the dialog lists the steps first); ✎ edits. */
function WorkflowsCard() {
  const workflows = useConfig((s) => s.snapshot?.config?.workflows ?? NO_WORKFLOWS);
  const servers = useConfig((s) => s.snapshot?.config?.servers);
  return (
    <Card title="Workflows" action={{ label: "New", run: () => useWorkflows.getState().edit(null) }}>
      {workflows.length === 0 ? (
        <Empty>None yet: steps that run one after another in one tab, e.g. merge and push here, then deploy on the server as root.</Empty>
      ) : (
        workflows.map((w) => {
          const srv = servers?.find((s) => s.id === w.pinServer);
          const app = w.pinApp ? srv?.apps.find((a) => a.id === w.pinApp) : undefined;
          return (
            <div key={w.id} className="group flex items-center">
              <div className="min-w-0 flex-1">
                <Row onClick={() => useWorkflows.getState().run(w.id)} title={`Run ${w.name}`}>
                  <span className="flex-1 truncate text-[13px] font-medium">{w.name}</span>
                  <span className="text-[11px] text-subtle-foreground">
                    {w.steps.length} step{w.steps.length === 1 ? "" : "s"}
                    {srv ? ` · ${app?.name ?? srv.name}` : ""}
                  </span>
                </Row>
              </div>
              <button
                title={`Edit ${w.name}`}
                onClick={() => useWorkflows.getState().edit(w)}
                className="mr-2 hidden h-7 cursor-pointer rounded-md px-2 text-[12px] text-subtle-foreground group-hover:block hover:bg-hover-strong hover:text-foreground"
              >
                Edit
              </button>
            </div>
          );
        })
      )}
    </Card>
  );
}
