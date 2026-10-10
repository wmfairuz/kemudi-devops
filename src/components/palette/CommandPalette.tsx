import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "react";

import { EnvTag } from "@/components/kit/EnvTag";
import { Kbd } from "@/components/kit/Kbd";
import { Modal } from "@/components/kit/Modal";
import { Glyph, Spinner } from "@/components/kit/Spinner";
import { StatusDot } from "@/components/kit/StatusDot";
import { SearchIcon } from "@/components/sidebar/SidebarFrame";
import { triggerAction } from "@/lib/actions";
import { actionRender, type Action, type App, type Server, type Snippet } from "@/lib/ipc";
import { ENV_WORDS, highlight, rank, tokenize, type Searchable } from "@/lib/paletteSearch";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/stores/sidebar";
import { insertSnippet, useSnippets } from "@/stores/snippets";
import { snippetVisible, useTeam, useTeamServers } from "@/stores/team";
import { useStatus } from "@/stores/status";
import { openLocalShell, openSsh, useTabs, type Tab } from "@/stores/tabs";
import { useConfig } from "@/stores/config";
import { useWorkflows } from "@/stores/workflows";
import { useUi } from "@/stores/ui";

type Item = Searchable & { key: string } & (
    | { type: "action"; server: Server; app: App | null; action: Action }
    | { type: "snippet"; snippet: Snippet }
    | { type: "tab"; tab: Tab }
    | { type: "app"; server: Server; app: App }
    | { type: "server"; server: Server }
    | { type: "command"; label: string; hint?: string; run: () => void }
  );

// Stable empty list: a fresh `[]` from a store selector re-renders forever.

const GROUPS: { type: Item["type"]; heading: string; limit: number }[] = [
  { type: "action", heading: "Actions", limit: 8 },
  { type: "snippet", heading: "Snippets · ↵ types it at the prompt", limit: 6 },
  { type: "tab", heading: "Open tabs", limit: 6 },
  { type: "app", heading: "Apps", limit: 5 },
  { type: "server", heading: "Servers", limit: 5 },
  { type: "command", heading: "Commands", limit: 6 },
];

function buildItems(servers: Server[], tabs: Tab[], snippets: Snippet[], close: () => void): Item[] {
  const items: Item[] = [];
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
        fields: [app.id, app.name, server.id, server.name, ...appWords],
      });
    }
    items.push({
      type: "server", key: `s:${server.id}`, server, prod,
      fields: [server.id, server.name, server.host, ...envWords],
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
    cmd("SSH to host…", () => useUi.getState().setOverlay("ssh"), "⇧⌘T"),
    cmd("History", () => useTabs.getState().openHistory(), "⌘Y"),
    cmd("Settings…", () => useUi.getState().setOverlay("settings"), "⌘,"),
    cmd("Passwords…", () => useUi.getState().setOverlay("passwords"), "⇧⌘K"),
    cmd("Environment…", () => useUi.getState().setOverlay("environment")),
    cmd("New workflow…", () => useWorkflows.getState().edit(null)),
  );
  // Workflows first among the commands (the run dialog shows the steps).
  const workflows = useConfig.getState().snapshot?.config?.workflows ?? [];
  items.splice(
    items.findIndex((i) => i.type === "command"),
    0,
    ...workflows.map((w) => cmd(`Workflow: ${w.name}`, () => useWorkflows.getState().run(w.id), `${w.steps.length} steps`)),
  );
  return items;
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

const itemClass =
  "flex min-h-[34px] items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-[13px] text-muted-foreground data-[selected=true]:bg-selected";

/** Design frame 1h: ⌘K over servers, apps, actions, tabs and commands. */
export function CommandPalette() {
  const open = useUi((s) => s.overlay === "palette");
  const setOverlay = useUi((s) => s.setOverlay);
  const servers = useTeamServers();
  const tabs = useTabs((s) => s.tabs);
  const allSnippets = useSnippets((s) => s.list);
  const teamPick = useTeam((s) => s.current);
  const snippets = useMemo(() => allSnippets.filter((s) => snippetVisible(s, teamPick)), [allSnippets, teamPick]);
  const reach = useStatus((s) => s.byServer);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<{ key: string; command: string } | null>(null);
  const close = () => setOverlay("none");

  useEffect(() => {
    if (open) setQuery("");
    if (open && !useSnippets.getState().loaded) void useSnippets.getState().load();
  }, [open]);

  const tokens = tokenize(query);
  const items = useMemo(() => buildItems(servers, tabs, snippets, close), [servers, tabs, snippets]);
  const groups = useMemo(
    () =>
      GROUPS.map((g) => {
        let list = items.filter((i) => i.type === g.type);
        // With no query, skip the long action list and show tabs/commands/servers.
        if (tokens.length === 0 && (g.type === "action" || g.type === "app" || g.type === "snippet")) list = [];
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
        openSsh(item.server.host, { serverId: item.server.id, prod: item.server.env === "prod", title: `${item.server.id} · ssh` });
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
            placeholder="Run an action, jump to an app, server or tab…"
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
                  <Hl text={app.id} tokens={tokens} strong={strong} /> on{" "}
                </>
              )}
              <Hl text={server.id} tokens={tokens} strong={strong} />
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
            <Hl text={item.app.id} tokens={tokens} strong={strong} /> on <Hl text={item.server.id} tokens={tokens} strong={strong} />
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
            <Hl text={item.server.id} tokens={tokens} strong={strong} />
          </div>
          <span className="font-mono text-[11px] text-faint-foreground">ssh {item.server.host}</span>
          <EnvTag env={item.server.env} />
          {enter}
        </>
      );
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
  }
}
