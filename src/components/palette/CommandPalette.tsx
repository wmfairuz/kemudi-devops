import { useWatch } from "@/stores/watch";
import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "react";

import { EnvTag } from "@/components/kit/EnvTag";
import { Kbd } from "@/components/kit/Kbd";
import { Modal } from "@/components/kit/Modal";
import { Glyph, Spinner } from "@/components/kit/Spinner";
import { StatusDot } from "@/components/kit/StatusDot";
import { SearchIcon } from "@/components/sidebar/SidebarFrame";
import { triggerAction } from "@/lib/actions";
import {
  actionRender,
  auditList,
  errorMessage,
  sshHostList,
  type Action,
  type App,
  type AuditRun,
  type HostRow,
  type Server,
  type ServerWatch,
  type Snippet,
  type WatchItem,
  type WorkflowStep,
} from "@/lib/ipc";
import { ENV_WORDS, highlight, rank, tokenize, type Searchable } from "@/lib/paletteSearch";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/stores/sidebar";
import { insertSnippet, useSnippets } from "@/stores/snippets";
import { snippetVisible, useTeam, useTeamServers } from "@/stores/team";
import { useStatus } from "@/stores/status";
import { openLocalShell, openServer, openSsh, toggleBroadcast, useTabs, type Tab } from "@/stores/tabs";
import { toastError } from "@/stores/toasts";
import { openServerShell, whereOf } from "@/lib/fleet";
import { useFleetUi } from "@/stores/fleetUi";
import { useConfig } from "@/stores/config";
import { useWorkflows } from "@/stores/workflows";
import { useUi } from "@/stores/ui";
import { reopenClosed } from "@/stores/session";
import { actionOf } from "@/components/watch/Watch";

type Item = Searchable & { key: string } & (
    | { type: "action"; server: Server; app: App | null; action: Action }
    | { type: "snippet"; snippet: Snippet }
    | { type: "tab"; tab: Tab }
    | { type: "app"; server: Server; app: App }
    | { type: "server"; server: Server; addr: string }
    | { type: "host"; alias: string; addr: string }
    | { type: "attention"; server: Server; item: WatchItem }
    | { type: "finding"; server: Server; level: "crit" | "warn"; text: string; detail: string[] }
    | { type: "command"; label: string; hint?: string; run: () => void }
    | { type: "history"; run: AuditRun; serverName: string }
  );

// Stable empty list: a fresh `[]` from a store selector re-renders forever.
const NO_WATCH: Record<string, ServerWatch> = {};
const NO_ITEMS: WatchItem[] = [];

const GROUPS: { type: Item["type"]; heading: string; limit: number }[] = [
  { type: "action", heading: "Actions", limit: 8 },
  { type: "snippet", heading: "Snippets · ↵ types it at the prompt", limit: 6 },
  { type: "tab", heading: "Open tabs", limit: 6 },
  { type: "app", heading: "Apps", limit: 5 },
  { type: "server", heading: "Servers", limit: 5 },
  { type: "host", heading: "SSH hosts (no server in Kemudi)", limit: 4 },
  { type: "attention", heading: "Needs attention", limit: 5 },
  { type: "finding", heading: "Security findings", limit: 5 },
  { type: "command", heading: "Commands", limit: 6 },
  { type: "history", heading: "History · ↵ shows it there", limit: 6 },
];

/** Where an ssh alias really goes: `hostname:port`, `user@` when set. */
function addrOf(row: HostRow | undefined): string {
  if (!row?.entry.hostname) return "";
  const { hostname, port, user } = row.entry;
  return `${user ? `${user}@` : ""}${hostname}${port && port !== 22 ? `:${port}` : ""}`;
}

/** Each crit/warn line of the last security check, with the info lines under it. */
function findingsOf(watch: ServerWatch | undefined): { level: "crit" | "warn"; text: string; detail: string[]; section: string }[] {
  const out: { level: "crit" | "warn"; text: string; detail: string[]; section: string }[] = [];
  for (const sec of watch?.security?.value.sections ?? []) {
    let last: (typeof out)[number] | null = null;
    for (const l of sec.lines) {
      if (l.level === "crit" || l.level === "warn") out.push((last = { level: l.level, text: l.text, detail: [], section: sec.title }));
      else if (l.level === "info" && last) last.detail.push(l.text);
      else last = null;
    }
  }
  return out;
}

interface Sources {
  servers: Server[];
  tabs: Tab[];
  snippets: Snippet[];
  hosts: HostRow[];
  watch: Record<string, ServerWatch>;
  attention: WatchItem[];
}

function buildItems({ servers, tabs, snippets, hosts, watch, attention }: Sources, close: () => void): Item[] {
  const items: Item[] = [];
  const hostOf = new Map(hosts.map((h) => [h.alias, h]));
  for (const snippet of snippets) {
    items.push({ type: "snippet", key: `n:${snippet.id}`, snippet, fields: [snippet.name, snippet.command, snippet.notes] });
  }
  for (const server of servers) {
    const envWords = ENV_WORDS[server.env] ?? [];
    const prod = server.env === "prod";
    for (const action of server.actions) {
      items.push({
        type: "action", key: `a:${server.id}::${action.id}`, server, app: null, action, prod,
        fields: [action.label, action.id, server.id, server.name, ...envWords],
      });
    }
    for (const app of server.apps) {
      const appWords = ENV_WORDS[app.env] ?? [];
      const appProd = app.env === "prod";
      for (const action of app.actions) {
        items.push({
          type: "action", key: `a:${server.id}:${app.id}:${action.id}`, server, app, action, prod: appProd,
          fields: [action.label, action.id, app.id, app.name, server.id, server.name, ...appWords],
        });
      }
      items.push({
        type: "app", key: `p:${server.id}:${app.id}`, server, app, prod: appProd,
        fields: [app.id, app.name, server.id, server.name, ...appWords, app.url ?? "", app.path, app.repo ?? "", app.branch ?? ""],
      });
    }
    const row = hostOf.get(server.host);
    const addr = addrOf(row);
    items.push({
      type: "server", key: `s:${server.id}`, server, addr, prod,
      fields: [server.id, server.name, server.host, ...envWords, addr, row?.entry.hostname ?? "", server.check?.host ?? "", server.vpnCheck?.host ?? ""],
    });
    // The last security check's findings: search "xmrig", "3306", "PermitRootLogin"…
    for (const [i, f] of findingsOf(watch[server.id]).entries()) {
      items.push({
        type: "finding", key: `f:${server.id}:${i}`, server, level: f.level, text: f.text, detail: f.detail, prod,
        fields: [f.text, ...f.detail, f.section, server.id, server.name],
      });
    }
  }
  // ssh aliases no server uses (`ssh` them straight away).
  const used = new Set(servers.map((s) => s.host));
  for (const h of hosts) {
    if (used.has(h.alias) || /[*?]/.test(h.alias)) continue;
    const addr = addrOf(h);
    items.push({ type: "host", key: `h:${h.alias}`, alias: h.alias, addr, fields: [h.alias, addr, h.entry.hostname] });
  }
  // Needs attention (the security check's own lines are under Security findings).
  const byId = new Map(servers.map((s) => [s.id, s]));
  for (const a of attention) {
    const server = byId.get(a.serverId);
    if (!server || a.snoozedUntil || a.kind === "secops" || a.kind === "secops-warn") continue;
    items.push({
      type: "attention", key: `w:${a.key}`, server, item: a, prod: server.env === "prod",
      fields: [a.text, a.detail ?? "", a.kind, server.id, server.name, a.appId ?? ""],
    });
  }
  for (const tab of tabs) {
    items.push({ type: "tab", key: `t:${tab.id}`, tab, prod: tab.prod, fields: [tab.title, tab.serverId ?? "", tab.host ?? ""] });
  }
  const cmd = (label: string, run: () => void, hint?: string): Item => ({
    type: "command", key: `c:${label}`, label, hint, fields: [label], run: () => (close(), run()),
  });
  items.push(
    cmd("New local shell", () => openLocalShell(), "⌘T"),
    cmd("SSH to host…", () => useUi.getState().setOverlay("ssh"), "⌥⌘T"),
    cmd("Reopen closed tab", () => reopenClosed(), "⇧⌘T"),
    cmd("Server setup (profiles, check, fix, helpers)", () => useTabs.getState().openBaseline(), "⇧⌘B"),
    cmd("Check all servers now (disks, updates, certificates…)", () => void useWatch.getState().refresh()),
    cmd("Checks: how often, when to warn", () => useTabs.getState().openSettings("checks")),
    cmd("History", () => useTabs.getState().openHistory(), "⌘Y"),
    cmd("Settings", () => useTabs.getState().openSettings(), "⌘,"),
    cmd("Passwords…", () => useUi.getState().setOverlay("passwords"), "⇧⌘K"),
    cmd("Snippets…", () => useTabs.getState().openSnippets(), "⇧⌘S"),
    cmd("SSH hosts (list, edit, test)", () => useTabs.getState().openHosts(), "⇧⌘E"),
    cmd("Environment…", () => useUi.getState().setOverlay("environment")),
    cmd("New workflow…", () => useWorkflows.getState().edit(null)),
    cmd("Workflows (runs)", () => useTabs.getState().openWorkflows(), "⇧⌘R"),
    cmd("Type in all panes (on/off)", () => toggleBroadcast(), "⌥⌘I"),
  );
  // The security check (read-only; minutes on a big server).
  const checkable = servers.filter((s) => !s.asg);
  for (const server of checkable) {
    items.push(
      cmd(`Security check: ${server.name}`, () => {
        openServer(server, "security");
        void useWatch.getState().securityCheck([server.id]).catch((e) => toastError(errorMessage(e)));
      }, "malware, web shells, weak spots"),
    );
  }
  if (checkable.length > 1)
    items.push(
      cmd("Security check all servers", () => void useWatch.getState().securityCheck(checkable.map((s) => s.id)).catch((e) => toastError(errorMessage(e))), `${checkable.length} servers, 3 at a time`),
    );
  // AWS servers: one instance, and database forwarding.
  for (const server of servers.filter((s) => s.asg)) {
    items.push(
      cmd(`Shell on one instance: ${server.name}`, () => useFleetUi.getState().openPick(server)),
      cmd(`Forward a database port: ${server.name}`, () => useFleetUi.getState().openForward(server), "RDS → 127.0.0.1"),
    );
  }
  // Workflows first among the commands (the run dialog shows the steps).
  const workflows = useConfig.getState().snapshot?.config?.workflows ?? [];
  items.splice(
    items.findIndex((i) => i.type === "command"),
    0,
    ...workflows.map((w) => ({
      ...cmd(`Workflow: ${w.name}`, () => useWorkflows.getState().run(w.id), `${w.steps.length} steps`),
      fields: [`Workflow: ${w.name}`, ...w.steps.flatMap(stepWords)],
    })),
  );
  return items;
}

/** What a workflow step can be found by: its label, command, server, action. */
function stepWords(step: WorkflowStep): string[] {
  const own = [step.label ?? ""];
  switch (step.kind) {
    case "local":
      return [...own, step.run];
    case "server":
    case "watch":
      return [...own, step.run, step.server ?? ""];
    case "action":
      return [...own, step.server, step.app ?? "", step.action];
    case "pause":
      return [...own, step.text];
    case "parallel":
      return [...own, ...step.branches.flatMap(stepWords)];
  }
}

function Hl({ text, tokens, strong = "text-foreground" }: { text: string; tokens: string[]; strong?: string }) {
  return (
    <>
      {highlight(text, tokens).map(([part, hit], i) =>
        hit ? (
          <span key={i} className={cn("font-medium", strong)}>
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function ago(ms?: number): string {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** "14:05" today, else "3 Nov". */
function when(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

const itemClass =
  "flex min-h-[34px] items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-[13px] text-muted-foreground data-[selected=true]:bg-selected";

/** Design frame 1h: ⌘K over servers (and where they ssh to), apps, actions, tabs, commands, what needs attention,
 *  security findings and past commands. */
export function CommandPalette() {
  const open = useUi((s) => s.overlay === "palette");
  const setOverlay = useUi((s) => s.setOverlay);
  const servers = useTeamServers();
  const tabs = useTabs((s) => s.tabs);
  const allSnippets = useSnippets((s) => s.list);
  const teamPick = useTeam((s) => s.current);
  const snippets = useMemo(() => allSnippets.filter((s) => snippetVisible(s, teamPick)), [allSnippets, teamPick]);
  const reach = useStatus((s) => s.byServer);
  const watch = useWatch((s) => s.snapshot?.servers ?? NO_WATCH);
  const attention = useWatch((s) => s.snapshot?.items ?? NO_ITEMS);
  const [hosts, setHosts] = useState<HostRow[]>([]);
  const [history, setHistory] = useState<AuditRun[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<{ key: string; command: string } | null>(null);
  const close = () => setOverlay("none");

  useEffect(() => {
    if (open) setQuery("");
    if (open && !useSnippets.getState().loaded) void useSnippets.getState().load();
    // ~/.ssh/config can change outside Kemudi: read it each time.
    if (open) sshHostList().then(setHosts, () => setHosts([]));
  }, [open]);

  // Past commands: History's own search (3+ letters).
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 3) return setHistory([]);
    let stale = false;
    const t = setTimeout(() => {
      auditList({ query: q, limit: 6 }).then(
        (d) => !stale && setHistory(d.runs),
        () => !stale && setHistory([]),
      );
    }, 150);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, query]);

  const tokens = tokenize(query);
  const items = useMemo(
    () => [
      ...buildItems({ servers, tabs, snippets, hosts, watch, attention }, close),
      ...history.map((run): Item => {
        // A server removed since keeps its id.
        const serverName = servers.find((s) => s.id === run.serverId)?.name ?? run.serverId;
        return { type: "history", key: `r:${run.id}`, run, serverName, prod: run.env === "prod", fields: [run.label, run.command, run.serverId, serverName] };
      }),
    ],
    [servers, tabs, snippets, hosts, watch, attention, history],
  );
  const groups = useMemo(
    () =>
      GROUPS.map((g) => {
        let list = items.filter((i) => i.type === g.type);
        // With no query, skip the long action list and show tabs/commands/servers.
        if (tokens.length === 0 && g.type !== "tab" && g.type !== "server" && g.type !== "command") list = [];
        // History already matched in the database (the whole query as one phrase).
        if (g.type === "history") return { ...g, items: list.slice(0, g.limit) };
        return { ...g, items: rank(list, tokens, tokens.length ? g.limit : Infinity) };
      }),
    [items, tokens.join(" ")],
  );
  const results = groups.flatMap((g) => g.items);
  const current = results.find((i) => i.key === selected) ?? results[0];

  // Show the rendered command under the highlighted action.
  useEffect(() => {
    if (!open || current?.type !== "action") return;
    let stale = false;
    actionRender({ serverId: current.server.id, appId: current.app?.id ?? null, actionId: current.action.id }).then(
      (r) => !stale && setPreview({ key: current.key, command: r.rendered }),
      () => !stale && setPreview(null),
    );
    return () => {
      stale = true;
    };
  }, [open, current?.key]);

  const run = (item: Item, edit: boolean) => {
    switch (item.type) {
      case "action":
        close();
        void triggerAction(
          { serverId: item.server.id, appId: item.app?.id ?? null, actionId: item.action.id },
          { alt: edit },
        );
        break;
      case "snippet":
        close();
        void insertSnippet(item.snippet);
        break;
      case "tab":
        close();
        useTabs.getState().activate(item.tab.id);
        break;
      case "app":
        close();
        useSidebar.getState().reveal(item.server.id, item.app.id);
        break;
      case "server":
        close();
        openServerShell(item.server);
        break;
      case "host":
        close();
        openSsh(item.alias);
        break;
      case "attention": {
        close();
        const act = actionOf(item.item, item.server);
        if (act) act.run();
        else openServer(item.server, "overview");
        break;
      }
      case "finding":
        close();
        openServer(item.server, "security");
        break;
      case "history":
        close();
        useTabs.getState().openHistory(item.run.command.length > 80 ? item.run.label : item.run.command);
        break;
      case "command":
        item.run();
        break;
    }
  };

  return (
    <Modal open={open} onOpenChange={(o) => setOverlay(o ? "palette" : "none")} title="Command palette" width={640} top>
      <Command
        loop
        shouldFilter={false}
        value={current?.key ?? ""}
        onValueChange={setSelected}
        label="Command palette"
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey && current) {
            e.preventDefault();
            run(current, true);
          }
        }}
      >
        <div className="flex h-[50px] items-center gap-2.5 border-b border-border pr-3.5 pl-4">
          <SearchIcon size={15} className="text-subtle-foreground" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search actions, servers, IPs, apps, findings, history…"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-subtle-foreground"
          />
          <Kbd>esc</Kbd>
        </div>
        <Command.List className="max-h-[440px] overflow-y-auto p-1.5">
          <Command.Empty className="px-2.5 py-6 text-center text-[12.5px] text-subtle-foreground">
            Nothing matches “{query}”.
          </Command.Empty>
          {groups.map(
            (g) =>
              g.items.length > 0 && (
                <Command.Group
                  key={g.type}
                  heading={g.heading}
                  className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle-foreground"
                >
                  {g.items.map((item) => (
                    <Command.Item key={item.key} value={item.key} onSelect={() => run(item, false)} className={itemClass}>
                      <Row item={item} tokens={tokens} selected={item.key === current?.key} preview={preview} reachOf={(id) => reach[id]?.state ?? "unknown"} />
                    </Command.Item>
                  ))}
                </Command.Group>
              ),
          )}
        </Command.List>
        <div className="flex h-9 items-center gap-4 border-t border-border bg-dialog-footer px-4 text-[11.5px] text-subtle-foreground">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">↑↓</span>Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">↵</span>Run
          </span>
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">⌘↵</span>Edit command first
          </span>
          <span className="flex-1" />
          <span>
            {results.length} result{results.length === 1 ? "" : "s"}
          </span>
        </div>
      </Command>
    </Modal>
  );
}

function Row({
  item,
  tokens,
  selected,
  preview,
  reachOf,
}: {
  item: Item;
  tokens: string[];
  selected: boolean;
  preview: { key: string; command: string } | null;
  reachOf: (serverId: string) => "up" | "down" | "checking" | "unknown";
}) {
  const strong = selected ? "text-foreground font-medium" : "text-foreground";
  const enter = <Kbd className={cn("border-control-border bg-transparent text-muted-foreground", !selected && "invisible")}>↵</Kbd>;
  switch (item.type) {
    case "action": {
      const { server, app, action } = item;
      return (
        <>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="truncate">
              <Hl text={action.label} tokens={tokens} strong={strong} />
              {" · "}
              {app && (
                <>
                  <Hl text={app.name} tokens={tokens} strong={strong} /> on{" "}
                </>
              )}
              <Hl text={server.name} tokens={tokens} strong={strong} />
            </div>
            {selected && preview?.key === item.key && (
              <div className="truncate font-mono text-[11px] text-subtle-foreground">{preview.command}</div>
            )}
          </div>
          {(app?.env ?? server.env) === "prod" && <span className="text-[11px] text-env-prod-note">confirms</span>}
          <EnvTag env={app?.env ?? server.env} />
          {enter}
        </>
      );
    }
    case "snippet":
      return (
        <>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="truncate">
              <Hl text={item.snippet.name} tokens={tokens} strong={strong} />
            </div>
            <div className="truncate font-mono text-[11px] text-subtle-foreground">{item.snippet.command.split("\n")[0]}</div>
          </div>
          {enter}
        </>
      );
    case "tab": {
      const t = item.tab;
      const glyph =
        t.state === "running" ? <Spinner size={10} /> : t.state === "ok" ? <Glyph className="text-term-green">✓</Glyph> : t.state === "failed" ? <Glyph className="text-term-red">✗</Glyph> : <Glyph className="font-mono text-subtle-foreground">$</Glyph>;
      return (
        <>
          {glyph}
          <div className="min-w-0 flex-1 truncate">
            <Hl text={t.title} tokens={tokens} strong={strong} />
          </div>
          {t.exitCode !== undefined && t.finishedAt && (
            <span className="font-mono text-[11px] text-subtle-foreground">
              exit {t.exitCode} · {ago(t.finishedAt)}
            </span>
          )}
          {enter}
        </>
      );
    }
    case "app":
      return (
        <>
          <div className="min-w-0 flex-1 truncate">
            <Hl text={item.app.name} tokens={tokens} strong={strong} /> on <Hl text={item.server.name} tokens={tokens} strong={strong} />
          </div>
          {item.app.branch && <span className="font-mono text-[11px] text-faint-foreground">{item.app.branch}</span>}
          <EnvTag env={item.app.env} />
          {enter}
        </>
      );
    case "server":
      return (
        <>
          <StatusDot status={reachOf(item.server.id)} className="mx-0.5" />
          <div className="min-w-0 flex-1 truncate">
            <Hl text={item.server.name} tokens={tokens} strong={strong} />
            {/* The id too: it's what workflows and history use. */}
            <span className="ml-2 font-mono text-[11px] text-faint-foreground">
              <Hl text={item.server.id} tokens={tokens} strong="text-muted-foreground" />
            </span>
          </div>
          <span className="truncate font-mono text-[11px] text-faint-foreground">
            {item.server.asg ? `all instances of ${whereOf(item.server)}` : <>ssh {item.server.host}{item.addr && <> · <Hl text={item.addr} tokens={tokens} strong="text-muted-foreground" /></>}</>}
          </span>
          <EnvTag env={item.server.env} />
          {enter}
        </>
      );
    case "host":
      return (
        <>
          <Glyph className="font-mono text-subtle-foreground">$</Glyph>
          <div className="min-w-0 flex-1 truncate">
            ssh <Hl text={item.alias} tokens={tokens} strong={strong} />
          </div>
          {item.addr && (
            <span className="truncate font-mono text-[11px] text-faint-foreground">
              <Hl text={item.addr} tokens={tokens} strong="text-muted-foreground" />
            </span>
          )}
          {enter}
        </>
      );
    case "attention":
    case "finding": {
      const urgent = item.type === "finding" ? item.level === "crit" : item.item.severity === "urgent";
      const text = item.type === "finding" ? item.text : item.item.text;
      const sub = item.type === "finding" ? item.detail.join(" · ") : (item.item.detail ?? "");
      return (
        <>
          <span className={cn("w-9 flex-none font-mono text-[10.5px] font-semibold", urgent ? "text-term-red" : "text-term-yellow")}>
            {item.type === "finding" ? item.level.toUpperCase() : urgent ? "URGENT" : item.item.severity.toUpperCase()}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="truncate">
              <Hl text={text} tokens={tokens} strong={strong} /> · <Hl text={item.server.name} tokens={tokens} strong={strong} />
            </div>
            {sub && (
              <div className="truncate font-mono text-[11px] text-subtle-foreground">
                <Hl text={sub} tokens={tokens} strong="text-muted-foreground" />
              </div>
            )}
          </div>
          <EnvTag env={item.server.env} />
          {enter}
        </>
      );
    }
    case "command":
      return (
        <>
          <div className="min-w-0 flex-1 truncate">
            <Hl text={item.label} tokens={tokens} strong={strong} />
          </div>
          {item.hint && <span className="font-mono text-[11px] text-faint-foreground">{item.hint}</span>}
          {enter}
        </>
      );
    case "history": {
      const r = item.run;
      return (
        <>
          <Glyph className={cn("font-mono", r.exitCode === 0 ? "text-term-green" : r.exitCode === null ? "text-subtle-foreground" : "text-term-red")}>
            {r.exitCode === 0 ? "✓" : r.exitCode === null ? "·" : "✗"}
          </Glyph>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="truncate">
              <Hl text={r.label} tokens={tokens} strong={strong} /> · <Hl text={item.serverName} tokens={tokens} strong={strong} />
            </div>
            <div className="truncate font-mono text-[11px] text-subtle-foreground">
              <Hl text={r.command.split("\n")[0] ?? ""} tokens={tokens} strong="text-muted-foreground" />
            </div>
          </div>
          <span className="font-mono text-[11px] text-faint-foreground">{when(r.startedAt)}</span>
          {enter}
        </>
      );
    }
  }
}
