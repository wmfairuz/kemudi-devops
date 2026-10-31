import { EyeOff, PanelRightClose, Plus, SquareTerminal, Workflow as WorkflowIcon } from "lucide-react";
import { useEffect } from "react";

import { whereOf } from "@/lib/fleet";
import { EnvTag } from "@/components/kit/EnvTag";
import { Badge } from "@/components/manage/Badge";
import { ActionButton } from "@/components/sidebar/ActionButton";
import { SnippetsList } from "@/components/snippets/SnippetsPanel";
import { runOnMac, triggerAction } from "@/lib/actions";
import {
  actionRemove,
  defaultConfirm,
  errorMessage,
  type Action,
  type Env,
  type ActionScope,
  type App,
  type Server,
  type Workflow,
} from "@/lib/ipc";
import { insertSnippet, useSnippets } from "@/stores/snippets";
import { snippetVisible, useTeam } from "@/stores/team";
import { useConfig } from "@/stores/config";
import { activeTab, HOSTS_ID, groupOf, SETTINGS_ID, HISTORY_ID, HOME_ID, SNIPPETS_ID, useTabs, WORKFLOWS_ID, type Tab } from "@/stores/tabs";
import { useSidebar } from "@/stores/sidebar";
import { toastError } from "@/stores/toasts";
import { cn } from "@/lib/utils";
import { useUi, type PanelTab } from "@/stores/ui";
import { useWorkflows } from "@/stores/workflows";
import { pinnedHere } from "@/lib/workflows";

const NO_SERVERS: Server[] = [];
const NO_WORKFLOWS: Workflow[] = [];

/** Wide pages with nothing to run actions in: a server's setup or
 *  dashboard (as a tab, or its server tab's section) and its Overview. */
const wide = (t: Tab | undefined) =>
  !!t && (t.kind === "setup" || t.kind === "dash" || (t.kind === "server" && ["overview", "dash", "setup"].includes(t.section ?? "overview")));

/** Right-hand panel (⌘J): the buttons for the app or server selected on the
 *  left, grouped by where they're defined, each group with "+ Add action". */
export function ActionsPanel() {
  const open = useUi((s) => s.actionsPanel);
  const tab = useUi((s) => s.panelTab);
  const selected = useSidebar((s) => s.selected);
  const servers = useConfig((s) => s.snapshot?.config?.servers ?? NO_SERVERS);
  // A shell on this Mac in front: the panel still shows what's selected on
  // the left, so say whose actions these are and where they run.
  const front = useTabs(activeTab);
  const localFront = front && (front.kind === "local" || front.local) && !front.workflow && !front.serverId ? front : null;
  // Pages with nothing to act on (Home, Workflows, Snippets, History): no
  // panel, whatever ⌘J is set to; it's back on tabs and server/app pages.
  const page = useTabs(
    (s) => s.activeId === null || [HOME_ID, HISTORY_ID, SNIPPETS_ID, WORKFLOWS_ID, HOSTS_ID, SETTINGS_ID].includes(s.activeId) || !!groupOf(s, s.activeId)?.workflow || wide(s.tabs.find((t) => t.id === s.activeId)),
  );
  if (!open || page) return null;
  const server = selected ? servers.find((s) => s.id === selected.serverId) : undefined;
  const app = server && selected?.appId ? server.apps.find((a) => a.id === selected.appId) : undefined;

  return (
    <aside className="flex w-[310px] min-h-0 flex-none flex-col border-l border-sidebar-border bg-sidebar">
      <div className="flex h-[60px] flex-none items-center gap-2.5 border-b border-divider pr-2 pl-3.5">
        {localFront ? (
          <>
            <span className="flex size-[34px] flex-none items-center justify-center rounded-lg bg-secondary text-subtle-foreground">
              <SquareTerminal className="size-[18px]" strokeWidth={1.75} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13.5px] font-semibold text-foreground">This Mac</span>
              <span className="mt-0.5 truncate text-[11px] text-subtle-foreground">{localFront.title}</span>
            </span>
          </>
        ) : server ? (
          <>
            <Badge id={app ? `${server.id}/${app.id}` : server.id} name={app ? app.name : server.name} size={34} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2">
                <span className="truncate text-[13.5px] font-semibold text-foreground">{app ? app.name : server.name}</span>
                <EnvTag env={app?.env ?? server.env} />
              </span>
              <span className="mt-0.5 truncate text-[11px] text-subtle-foreground" title={app ? `${whereOf(server)}:${app.path}` : whereOf(server)}>
                {app ? `on ${server.name}` : whereOf(server)}
              </span>
            </span>
          </>
        ) : (
          <span className="flex-1 text-[13px] font-semibold text-foreground">Actions</span>
        )}
        <button
          title="Hide actions (⌘J)"
          aria-label="Hide actions"
          onClick={() => useUi.getState().toggleActionsPanel()}
          className="flex size-8 flex-none cursor-pointer items-center justify-center rounded-lg text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
        >
          <PanelRightClose className="size-5" strokeWidth={1.75} />
        </button>
      </div>
      {server && !localFront && (
        <div className="selectable truncate border-b border-divider px-3.5 py-2 font-mono text-[11.5px] text-subtle-foreground">
          {whereOf(server)}
          {app ? `:${app.path}` : ""}
        </div>
      )}
      <div role="tablist" aria-label="Panel" className="flex flex-none gap-1 border-b border-divider px-3.5 py-1.5">
        {(["actions", "snippets"] as PanelTab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => useUi.getState().setPanelTab(t)}
            className={cn(
              "h-7 cursor-pointer rounded-md px-2.5 text-[12.5px] capitalize",
              tab === t ? "bg-selected font-medium text-foreground" : "text-subtle-foreground hover:bg-hover-strong hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {tab === "snippets" ? (
          <SnippetsList />
        ) : localFront ? (
          <MacView shell={localFront.title} />
        ) : !server ? (
          <div className="px-4 py-5 text-[13px] leading-5 text-subtle-foreground">
            Select a server or app on the left to see its actions.
          </div>
        ) : (
          <Groups server={server} app={app} />
        )}
      </div>
    </aside>
  );
}

/** The Actions tab with a shell on this Mac in front: what runs here (your
 *  workflows, your snippets as one-click commands), and the server picked on
 *  the left folded away (its actions run there; right-click ▸ Type into …). */
function MacView({ shell }: { shell: string }) {
  const workflows = useConfig((s) => s.snapshot?.config?.workflows ?? NO_WORKFLOWS);
  const { list: snippets, loaded } = useSnippets();
  const current = useTeam((s) => s.current);
  useEffect(() => {
    if (!loaded) void useSnippets.getState().load();
  }, [loaded]);
  const mine = snippets.filter((s) => snippetVisible(s, current));
  // The shared actions (global, and the team in front's), once each.
  const servers = useConfig((s) => s.snapshot?.config?.servers ?? NO_SERVERS);
  const sharedOf = (lists: Action[][]) => {
    const seen = new Map<string, Action>();
    for (const a of lists.flat()) if (a.shared && snippetVisible(a, current) && !seen.has(a.id)) seen.set(a.id, a);
    return [...seen.values()];
  };
  const sharedApp = sharedOf(servers.flatMap((s) => s.apps.map((a) => a.actions)));
  const sharedServer = sharedOf(servers.map((s) => s.actions));
  const head = "mb-2 flex items-center text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase";
  return (
    <div className="flex flex-col gap-5 px-3.5 pt-3.5">
      {workflows.length > 0 && (
        <section>
          <div className={head}>Workflows</div>
          <div className="flex flex-wrap gap-2">
            {workflows.map((w) => (
              <button
                key={w.id}
                title={`${w.steps.length} step${w.steps.length === 1 ? "" : "s"} · click: run (shows the steps first) · right-click: edit`}
                onClick={() => useWorkflows.getState().run(w.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  useWorkflows.getState().edit(w);
                }}
                className="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/8 px-2.5 text-[12.5px] font-medium text-foreground hover:bg-primary/15"
              >
                <WorkflowIcon className="size-4 text-primary" strokeWidth={1.75} />
                {w.name}
              </button>
            ))}
          </div>
        </section>
      )}
      <section>
        <div className={head}>
          <span className="flex-1">Commands</span>
          <button
            title="New snippet"
            aria-label="New snippet"
            onClick={() => useSnippets.getState().setEditing({ id: null })}
            className="flex size-7 cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
          >
            <Plus className="size-4" strokeWidth={2} />
          </button>
        </div>
        {mine.length === 0 ? (
          <button
            onClick={() => useSnippets.getState().setEditing({ id: null })}
            className="w-full cursor-pointer rounded-lg border border-dashed border-control-border px-3 py-2 text-left text-[12px] text-subtle-foreground hover:border-primary/50 hover:bg-hover hover:text-foreground"
          >
            + Your snippets show here as buttons for this shell
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            {mine.map((s) => (
              <button
                key={s.id}
                title={`${s.command}${s.notes ? `\n\n${s.notes}` : ""}\n\nclick: type it into ${shell} · ⌥-click: and press ↵ · right-click: edit`}
                onClick={(e) => void insertSnippet(s, { run: e.altKey })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  useSnippets.getState().setEditing(s);
                }}
                className="flex h-[30px] max-w-full cursor-pointer items-center gap-1.5 rounded-lg border border-control-border bg-background px-2.5 text-[12.5px] text-foreground hover:bg-hover-strong"
              >
                <SquareTerminal className="size-3.5 flex-none text-subtle-foreground" strokeWidth={1.75} />
                <span className="truncate">{s.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-1.5 text-[11px] text-subtle-foreground">From your snippets: click types one into {shell}; ⌥-click also presses ↵.</div>
      </section>
      <SharedForMac title="All apps" note="shared" list={sharedApp} appLevel shell={shell} />
      <SharedForMac title="All servers" note="shared" list={sharedServer} appLevel={false} shell={shell} />
    </div>
  );
}

/** Shared actions as buttons for the shell on this Mac: a click types one in
 *  (`{{ app.path }}` is the shell's folder); one that asks first, or ⌥-click,
 *  shows the command to check. */
function SharedForMac({ title, note, list, appLevel, shell }: { title: string; note: string; list: Action[]; appLevel: boolean; shell: string }) {
  if (list.length === 0) return null;
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">
        {title} <span className="font-normal tracking-normal normal-case">· {note}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {list.map((a) => (
          <button
            key={a.id}
            title={`${a.run}\n\nclick: run it in ${shell} (in its folder)${a.danger ? " · asks first" : ""} · ⌥-click: check the command first`}
            onClick={(e) => void runOnMac(a.id, appLevel, e.altKey)}
            className={cn(
              "flex h-[30px] max-w-full cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] hover:bg-hover-strong",
              a.danger ? "border-env-prod/40 text-env-prod-fg" : "border-control-border bg-background text-foreground",
            )}
          >
            <span className="truncate">{a.label}</span>
            {a.danger && <span className="text-[10px]">◆</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

function Groups({ server, app }: { server: Server; app?: App }) {
  const own = (list: Action[]) => list.filter((a) => !a.shared);
  const shared = (list: Action[]) => list.filter((a) => a.shared && !a.team);
  const teamShared = (list: Action[]) => list.filter((a) => a.shared && a.team);
  const team = useConfig((s) => (server.team ? s.snapshot?.config?.teams.find((t) => t.id === server.team) : undefined));
  const hidden = [...(app?.hidden ?? []).map((a) => ({ a, app })), ...server.hidden.map((a) => ({ a, app: undefined }))];
  return (
    <>
      <PinnedWorkflows server={server} app={app} />
      {app && (
        <>
          <Group
            title={`Only ${app.name}`}
            server={server}
            app={app}
            actions={own(app.actions)}
            scope={{ kind: "app", serverId: server.id, appId: app.id }}
            addTitle={`Add action to ${app.name}`}
          />
          {team && (
            <Group
              title={`All apps in ${team.name}`}
              note="team"
              server={server}
              app={app}
              actions={teamShared(app.actions)}
              scope={{ kind: "teamApp", teamId: team.id }}
              addTitle={`Add a shared action (every app in ${team.name})`}
            />
          )}
          <Group
            title="All apps"
            note="shared"
            server={server}
            app={app}
            actions={shared(app.actions)}
            scope={{ kind: "sharedApp" }}
            addTitle="Add a shared action (every app)"
          />
        </>
      )}
      <Group
        title={`Only server ${server.id}`}
        server={server}
        actions={own(server.actions)}
        scope={{ kind: "server", serverId: server.id }}
        addTitle={`Add action to server ${server.id}`}
      />
      {team && (
        <Group
          title={`All servers in ${team.name}`}
          note="team"
          server={server}
          actions={teamShared(server.actions)}
          scope={{ kind: "teamServer", teamId: team.id }}
          addTitle={`Add a shared server action (every server in ${team.name})`}
        />
      )}
      <Group
        title="All servers"
        note="shared"
        server={server}
        actions={shared(server.actions)}
        scope={{ kind: "sharedServer" }}
        addTitle="Add a shared server action (every server)"
      />
      {hidden.length > 0 && (
        <div className="mx-3.5 mt-4 flex flex-col gap-1.5 border-t border-divider pt-3.5">
          <div className="mb-0.5 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">Hidden here</div>
          {hidden.map(({ a, app: owner }) => (
            <div key={`${owner?.id ?? "srv"}-${a.id}`} className="flex h-7 items-center gap-2 text-[12.5px] text-muted-foreground">
              <EyeOff className="size-4 flex-none" strokeWidth={1.75} />
              <span className="flex-1 truncate">{a.label}</span>
              <button
                className="h-6 cursor-pointer rounded-md border border-control-border px-2 text-[11.5px] text-soft-foreground hover:bg-hover-strong hover:text-foreground"
                onClick={() =>
                  void actionRemove({ serverId: server.id, appId: owner?.id ?? null, actionId: a.id }, "unhide").catch((e) =>
                    toastError(errorMessage(e)),
                  )
                }
              >
                Show
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Group({
  title,
  note,
  server,
  app,
  actions,
  scope,
  addTitle,
}: {
  title: string;
  note?: string;
  server: Server;
  app?: App;
  actions: Action[];
  scope: ActionScope;
  addTitle: string;
}) {
  // App groups go by the app's environment, server groups by the server's.
  const env = app?.env ?? server.env;
  const add = () => useUi.getState().setAddAction({ scope, title: addTitle, env: scope.kind.startsWith("shared") || scope.kind.startsWith("team") ? null : env });
  return (
    <section className="px-3.5 pt-4">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="truncate text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">{title}</span>
        {note && <span className="text-[11px] text-faint-foreground">· {note}</span>}
        <span className="flex-1" />
        <button
          title={addTitle}
          aria-label={addTitle}
          onClick={add}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
        >
          <Plus className="size-4" strokeWidth={2} />
        </button>
      </div>
      {actions.length === 0 ? (
        <button
          onClick={add}
          className="w-full cursor-pointer rounded-lg border border-dashed border-control-border px-3 py-2.5 text-left text-[12.5px] text-subtle-foreground hover:border-primary/50 hover:bg-hover hover:text-foreground"
        >
          + Add action
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => {
            const ref = { serverId: server.id, appId: app?.id ?? null, actionId: a.id };
            return (
              <ActionButton
                key={a.id}
                id={a.id}
                env={env}
                label={a.label}
                danger={a.danger}
                title={actionTitle(env, a)}
                onRun={(alt) => void triggerAction(ref, { alt })}
                onMenu={(x, y) =>
                  useUi.getState().setActionMenu({
                    x,
                    y,
                    ref,
                    label: a.label,
                    title: `${a.label} · ${app ? `${app.id} on ` : ""}${server.id}`,
                    line: a.line,
                    env,
                    danger: a.danger,
                    confirm: a.confirm,
                    shared: a.shared,
                    inherited: a.inherited,
                    team: a.team,
                  })
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Tooltip: where it runs, what a click does, and right-click. */
function actionTitle(env: Env, a: Action): string {
  const where = a.kind === "local" ? "Runs on this Mac. " : "";
  const level = a.confirm ?? defaultConfirm(env, a.danger);
  const click =
    level === "type"
      ? "Click: confirm by typing the server name."
      : level === "warn"
        ? "Click: confirm, then run."
        : "Click: run · ⌥-click: edit command first.";
  return `${where}${click} Right-click: options`;
}

/** Workflows pinned to this app (or, for a server, to the server itself). */
function PinnedWorkflows({ server, app }: { server: Server; app?: App }) {
  const config = useConfig((s) => s.snapshot?.config);
  const list = pinnedHere(config, server.id, app?.id ?? null);
  const add = () => useWorkflows.getState().edit(null, { server: server.id, app: app?.id ?? null });
  const where = app ? app.name : server.name;
  return (
    <section className="px-3.5 pt-4">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="truncate text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">Workflows</span>
        <span className="flex-1" />
        <button
          title={`New workflow pinned to ${where}`}
          aria-label={`New workflow pinned to ${where}`}
          onClick={add}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
        >
          <Plus className="size-4" strokeWidth={2} />
        </button>
      </div>
      {list.length === 0 ? (
        <button
          onClick={add}
          className="w-full cursor-pointer rounded-lg border border-dashed border-control-border px-3 py-2 text-left text-[12px] text-subtle-foreground hover:border-primary/50 hover:bg-hover hover:text-foreground"
        >
          + Add workflow
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          {list.map((w) => (
            <button
              key={w.id}
              title={`${w.steps.length} step${w.steps.length === 1 ? "" : "s"} · click: run (shows the steps first) · right-click: edit`}
              onClick={() => useWorkflows.getState().run(w.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                useWorkflows.getState().edit(w);
              }}
              className="flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/8 px-2.5 text-[12.5px] font-medium text-foreground hover:bg-primary/15"
            >
              <WorkflowIcon className="size-4 text-primary" strokeWidth={1.75} />
              {w.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
