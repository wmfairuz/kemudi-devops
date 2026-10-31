import { History, KeyRound, Plus, RefreshCw, Settings, SquareTerminal, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { LogoMark } from "@/components/kit/Logo";
import { ColorDot, openTabConfig, useTabConfigs } from "@/components/tabconfigs/TabConfigs";
import { AttentionList, FleetGrid } from "@/components/watch/Watch";
import { canRunAgain, runAgain } from "@/lib/actions";
import { auditList, errorMessage, sshConfigOpen, tabConfigsList, type AuditRun, type Server, type TabConfigEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { openDetails } from "@/stores/manage";
import { useCurrentTeam, useTeamServers } from "@/stores/team";
import { openLocalShell, useTabs } from "@/stores/tabs";
import { toastError } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useConfig } from "@/stores/config";
import { useWatch } from "@/stores/watch";
import { useWorkflows } from "@/stores/workflows";
import type { Workflow } from "@/lib/ipc";

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** The pinned Home tab: what needs attention and the fleet grid (from the
 *  background checks), then workflows, tab configs and recent runs. Also
 *  what shows with no terminals open. */
export function HomeView() {
  const servers = useTeamServers();
  const team = useCurrentTeam();
  const configsView = useTabConfigs((s) => s.view);
  const [configs, setConfigs] = useState<TabConfigEntry[] | null>(null);
  const [runs, setRuns] = useState<AuditRun[] | null>(null);

  useEffect(() => {
    // Reload when a tab-config dialog closes.
    if (configsView === null) tabConfigsList().then(setConfigs, () => setConfigs([]));
  }, [configsView]);
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
              SSH to host… <Hint>⌥⌘T</Hint>
            </Btn>
            <Btn variant="outline" onClick={() => openDetails({ kind: "server", serverId: null })}>
              <Plus className="size-4" /> Add server
            </Btn>
          </div>
        </div>

        <Workspace servers={servers} teamName={team?.name ?? null} />

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
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
                  onClick={() => runAgain(r)}
                  inert={!canRunAgain(r)}
                  title={canRunAgain(r) ? "Run again (asks first, like a click)" : "Done from Kemudi itself; nothing to run again"}
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
          <LinkBtn onClick={() => useTabs.getState().openSettings()}>
            <Settings className="size-3.5" /> Settings ⌘,
          </LinkBtn>
          <LinkBtn onClick={() => useTabs.getState().openHistory()}>
            <History className="size-3.5" /> History ⌘Y
          </LinkBtn>
          <LinkBtn onClick={() => useUi.getState().setOverlay("passwords")}>
            <KeyRound className="size-3.5" /> Passwords
          </LinkBtn>
          <LinkBtn onClick={() => useTabs.getState().openHosts()}>
            <TerminalSquare className="size-3.5" /> SSH hosts ⇧⌘E
          </LinkBtn>
          <LinkBtn onClick={() => useUi.getState().setOverlay("environment")}>Environment</LinkBtn>
          <LinkBtn onClick={() => void sshConfigOpen().catch((e) => toastError(errorMessage(e)))}>~/.ssh/config</LinkBtn>
        </div>
      </div>
    </div>
  );
}

/** Needs attention and the fleet grid, for the team in front. */
function Workspace({ servers, teamName }: { servers: Server[]; teamName: string | null }) {
  const snap = useWatch((x) => x.snapshot);
  const settings = useWatch((x) => x.settings);
  const [busy, setBusy] = useState(false);
  const ids = new Set(servers.map((s) => s.id));
  const items = (snap?.items ?? []).filter((i) => ids.has(i.serverId) && !i.snoozedUntil);
  const urgent = items.filter((i) => i.severity === "urgent").length;
  const warn = items.filter((i) => i.severity === "warn").length;
  const running = (snap?.running ?? []).filter((id) => ids.has(id)).length;
  const checkAll = async () => {
    setBusy(true);
    try {
      await useWatch.getState().refresh(servers.map((s) => s.id));
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const checks = () => useTabs.getState().openSettings("checks");
  return (
    <>
      <section className="flex flex-col overflow-hidden rounded-xl border border-divider bg-panel">
        <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-4">
          <span className="text-[12px] font-semibold tracking-wide text-subtle-foreground uppercase">Needs attention</span>
          {urgent > 0 && <span className="rounded-[4px] bg-env-prod px-1.5 font-mono text-[11px] font-semibold text-white">{urgent} urgent</span>}
          {warn > 0 && <span className="rounded-[4px] bg-env-staging px-1.5 font-mono text-[11px] font-semibold text-white">{warn} soon</span>}
          <span className="min-w-0 flex-1 truncate text-right text-[11.5px] text-subtle-foreground">
            {running > 0 ? `checking ${running} server${running === 1 ? "" : "s"}…` : settings && !settings.enabled ? "background checks are off" : ""}
          </span>
          <button onClick={checks} className="flex h-7 cursor-pointer items-center rounded-md px-2 text-[12px] text-primary hover:bg-primary/10">
            Checks…
          </button>
          <button
            onClick={() => void checkAll()}
            disabled={busy || servers.length === 0}
            title="Every check on every server now (read-only)"
            className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] text-primary hover:bg-primary/10 disabled:cursor-default disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> Check all
          </button>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          <AttentionList
            servers={servers}
            empty={
              Object.keys(snap?.servers ?? {}).some((id) => ids.has(id))
                ? "Nothing needs attention."
                : "Nothing checked yet: servers are checked in the background once they answer (Checks… sets how often), or press Check all."
            }
          />
        </div>
      </section>

      <section className="flex flex-col overflow-hidden rounded-xl border border-divider bg-panel">
        <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-4">
          <span className="flex-1 text-[12px] font-semibold tracking-wide text-subtle-foreground uppercase">Servers{teamName ? ` · ${teamName}` : ""}</span>
          <button
            onClick={() => openDetails({ kind: "server", serverId: null })}
            className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[12px] text-primary hover:bg-primary/10"
          >
            <Plus className="size-3.5" /> Add
          </button>
        </div>
        {servers.length === 0 ? (
          <Empty>{teamName ? `No servers in ${teamName} yet: add one, or pick ${teamName} as the team on a server's page.` : "Add your first server: its SSH host, environment and apps."}</Empty>
        ) : (
          <FleetGrid servers={servers} />
        )}
      </section>
    </>
  );
}

function Card({
  title,
  action,
  link,
  footer,
  children,
}: {
  title: string;
  action?: { label: string; run: () => void };
  /** A plain link next to the action (no +). */
  link?: { label: string; run: () => void };
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-[180px] flex-col overflow-hidden rounded-xl border border-divider bg-panel">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-4">
        <span className="flex-1 text-[12px] font-semibold tracking-wide text-subtle-foreground uppercase">{title}</span>
        {link && (
          <button onClick={link.run} className="flex h-7 cursor-pointer items-center rounded-md px-2 text-[12px] text-primary hover:bg-primary/10">
            {link.label}
          </button>
        )}
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
  inert,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Not clickable, but not dimmed either. */
  inert?: boolean;
  title?: string;
}) {
  const off = disabled || inert;
  return (
    <div
      role="button"
      tabIndex={0}
      title={title}
      aria-disabled={off}
      onClick={() => !off && onClick()}
      onKeyDown={(e) => e.key === "Enter" && !off && onClick()}
      className={cn(
        "mx-1.5 flex min-h-10 cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1.5",
        disabled ? "opacity-50" : inert ? "" : "hover:bg-hover",
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
    <Card
      title="Workflows"
      link={{ label: "Runs ⇧⌘R", run: () => useTabs.getState().openWorkflows() }}
      action={{ label: "New", run: () => useWorkflows.getState().edit(null) }}
    >
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
