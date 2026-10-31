import { agoS, useWatch } from "@/stores/watch";
import { ChevronDown, ChevronRight, RotateCw, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { BaselineChips, HelpersEditor } from "@/components/baseline/Baseline";
import { Btn } from "@/components/kit/Btn";
import { CodeEditor } from "@/components/kit/CodeEditor";
import { EnvTag } from "@/components/kit/EnvTag";
import { Spinner } from "@/components/kit/Spinner";
import { isAsg } from "@/lib/fleet";
import { asgInstances, errorMessage, serverSetSetup, setupCheck, setupPlan, setupSave, setupSource, type Server, type SetupItem, type SetupStatus } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { openSetup, useTabs, WORKFLOWS_ID, type Tab } from "@/stores/tabs";
import { useCurrentTeam, useTeamServers } from "@/stores/team";
import { toastError, useToasts } from "@/stores/toasts";
import { useWorkflows } from "@/stores/workflows";

/** A start for `setup:` (your new-server list, as checks). */
const STARTER = `setup:
  # Servers that don't name a profile (setup: <id> on a server; setup: none
  # to leave one out) are checked against this one.
  default: web
  profiles:
    - id: web
      name: Laravel web server
      timezone: Asia/Kuala_Lumpur
      ntp: true
      updates: true
      unattended_upgrades: true
      packages: [software-properties-common, language-pack-en-base, net-tools, sysstat, ncdu, curl, git, unzip, nginx, mysql-client, mysql-server, supervisor, redis-server]
      php: { version: "8.4", extensions: [fpm, cli, common, bcmath, opcache, mysql, mbstring, soap, zip, gd, intl, xml, curl, imagick, redis, ldap] }
      composer: true
      mysql_secure: true
      folders: [{ path: /opt/www, owner: www-data, mode: 775 }]
      users: [{ name: deploy, sudo: true, password: true }]
      firewall: { allow: ["Nginx Full"] }
      fail2ban: { maxretry: 3, bantime: 1h, findtime: 10m }
      auditd: true
      lynis: true
      ssh: { port: 2222, password_auth: false }
    # A variant: starts from web; what's set here wins (lists replace).
    # - id: legacy
    #   extends: web
    #   php: { version: "8.1", extensions: [fpm, cli, mbstring, xml] }
`;

const KEYS: [string, string][] = [
  ["timezone", "Asia/Kuala_Lumpur"],
  ["ntp / updates / unattended_upgrades", "true"],
  ["packages", "[nginx, git, …]"],
  ["php", '{ version: "8.4", extensions: [fpm, …], ppa, default }'],
  ["composer / mysql_secure", "true"],
  ["ssh", "{ port: 2222, any_port: true (any but 22), password_auth: false }"],
  ["firewall", '{ allow: ["Nginx Full", 6379/tcp] }'],
  ["fail2ban", "true, or { maxretry, bantime, findtime }"],
  ["auditd / lynis", "true"],
  ["folders", "[{ path, owner, mode }]"],
  ["users", "[{ name, sudo, password }]"],
  ["helpers", "false to skip the Helpers below"],
  ["custom", "[{ name, check, fix, root }]"],
  ["extends", "another profile's id"],
];

type Result = { instance: string | null; status: SetupStatus | string };
type Row = { state: "busy" } | { state: "done"; results: Result[] } | { state: "fixing"; tabId: string };

/** Per server: checking, being fixed, or what came back. Kept while you
 *  switch tabs. */
const useSetupRows = create<{ rows: Record<string, Row> }>(() => ({ rows: {} }));
const setRow = (id: string, row: Row) => useSetupRows.setState((x) => ({ rows: { ...x.rows, [id]: row } }));

async function checkServer(s: Server) {
  setRow(s.id, { state: "busy" });
  let results: Result[];
  try {
    const list = isAsg(s) ? (await asgInstances(s.id)).map((i) => i.id) : [null];
    results = await Promise.all(list.map(async (instance) => ({ instance, status: await setupCheck(s.id, instance).catch((e: unknown) => errorMessage(e)) })));
  } catch (e) {
    results = [{ instance: null, status: errorMessage(e) }];
  }
  setRow(s.id, { state: "done", results });
}

/** Resolve when tab `id` stops running (or is closed). */
function ended(id: string): Promise<void> {
  return new Promise((resolve) => {
    const check = (st = useTabs.getState()) => {
      const tab = st.tabs.find((t) => t.id === id);
      if (!tab || tab.state !== "running") {
        off();
        resolve();
      }
    };
    const off = useTabs.subscribe((st) => check(st));
    check();
  });
}

/** A run's row in the Workflows tab, open. */
function showRun(tabId: string) {
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  useWorkflows.getState().expand(tab.groupId);
  useTabs.setState({ activeId: WORKFLOWS_ID });
}

/** Fix `ids` on a server: the steps as a workflow, in the run dialog
 *  (steps, the script, production's typed name), then a fresh check once
 *  it ends. */
async function fix(s: Server, ids: string[]) {
  try {
    const wf = await setupPlan(s.id, ids);
    const w = useWorkflows.getState();
    w.remember(wf);
    w.run(wf.id, 1, {
      by: "",
      start: (tabId) => {
        setRow(s.id, { state: "fixing", tabId });
        void ended(tabId).then(() => checkServer(s));
      },
      cancel: () => {},
    });
  } catch (e) {
    toastError(errorMessage(e));
  }
}

const TONE: Record<SetupItem["state"], string> = {
  ok: "text-[#17702a]",
  warn: "text-[#8a5a12]",
  bad: "text-env-prod-fg",
  unknown: "text-subtle-foreground",
};
const MARK: Record<SetupItem["state"], string> = { ok: "✓", warn: "!", bad: "✗", unknown: "?" };

function counts(st: SetupStatus) {
  const n = (k: SetupItem["state"]) => st.items.filter((i) => i.state === k).length;
  return { ok: n("ok"), warn: n("warn"), bad: n("bad"), unknown: n("unknown") };
}

/** All of a server's results, added up. */
function summary(results: Result[]) {
  const all = results.flatMap((r) => (typeof r.status === "string" ? [] : [counts(r.status)]));
  return all.reduce((a, c) => ({ ok: a.ok + c.ok, warn: a.warn + c.warn, bad: a.bad + c.bad, unknown: a.unknown + c.unknown }), { ok: 0, warn: 0, bad: 0, unknown: 0 });
}

function Counts({ results }: { results: Result[] }) {
  const sum = summary(results);
  const failed = results.find((r) => typeof r.status === "string");
  if (failed && typeof failed.status === "string") return <span className="truncate text-env-prod-fg">{failed.status}</span>;
  return (
    <span className="flex items-center gap-3">
      <span className="text-[#17702a]">✓ {sum.ok}</span>
      {sum.bad > 0 && <span className="text-env-prod-fg">✗ {sum.bad}</span>}
      {sum.warn > 0 && <span className="text-[#8a5a12]">! {sum.warn}</span>}
      {sum.unknown > 0 && <span className="text-subtle-foreground">? {sum.unknown}</span>}
      {sum.bad + sum.warn === 0 && <span className="text-[#17702a]">all as the profile says</span>}
    </span>
  );
}

function RowState({ server, row }: { server: Server; row: Row | undefined }) {
  // Not checked here yet: the background check's counts, if it has run.
  const bg = useWatch((x) => x.snapshot?.servers[server.id]?.setup);
  if (!row && bg)
    return (
      <span className="flex items-center gap-3" title="From the background checks; Check reads it again">
        <span className="text-[#17702a]">✓ {bg.value.ok}</span>
        {bg.value.bad > 0 && <span className="text-env-prod-fg">✗ {bg.value.bad}</span>}
        {bg.value.warn > 0 && <span className="text-[#8a5a12]">! {bg.value.warn}</span>}
        {bg.value.bad + bg.value.warn === 0 && <span className="text-[#17702a]">all as the profile says</span>}
        <span className="text-subtle-foreground">{agoS(bg.at)}</span>
      </span>
    );
  if (!row) return <span className="text-subtle-foreground">not checked yet</span>;
  if (row.state === "busy")
    return (
      <span className="flex items-center gap-1.5 text-subtle-foreground">
        <Spinner size={10} /> checking {server.name}…
      </span>
    );
  if (row.state === "fixing")
    return (
      <button
        className="flex cursor-pointer items-center gap-1.5 text-subtle-foreground hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          showRun(row.tabId);
        }}
      >
        <Spinner size={10} /> fixing (see its run) · checked again when it ends
      </button>
    );
  return <Counts results={row.results} />;
}

/** Server setup ▸ Servers: one line per server; it opens the server's
 *  Setup tab. */
function ServerRow({ server, profiles, defaultId }: { server: Server; profiles: { id: string; name: string | null }[]; defaultId: string | null }) {
  const row = useSetupRows((x) => x.rows[server.id]);
  const assigned = useConfig((s) => s.snapshot?.config?.setup.assigned[server.id] ?? "");
  const effective = assigned || defaultId;
  const none = !effective || effective === "none";
  const open = () => void openSetup(server);

  return (
    <div role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-hover/60">
      <span className="flex w-[230px] flex-none items-center gap-1.5">
        <span className="truncate text-[12.5px] font-medium">{server.name}</span>
        <EnvTag env={server.env} />
      </span>
      <span onClick={(e) => e.stopPropagation()}>
        <ProfileSelect server={server} assigned={assigned} profiles={profiles} defaultId={defaultId} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px]">{none ? <span className="text-subtle-foreground">not checked (no profile)</span> : <RowState server={server} row={row} />}</span>
      <span className="flex flex-none items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Btn size="sm" variant="ghost" disabled={none || row?.state === "busy" || row?.state === "fixing"} onClick={() => void checkServer(server)}>
          Check
        </Btn>
        <Btn size="sm" variant="outline" onClick={open} title="Its own tab: every item, what was found, Fix">
          Open <ChevronRight className="size-3" />
        </Btn>
      </span>
    </div>
  );
}

function ProfileSelect({ server, assigned, profiles, defaultId }: { server: Server; assigned: string; profiles: { id: string; name: string | null }[]; defaultId: string | null }) {
  const setProfile = async (v: string) => {
    try {
      await serverSetSetup(server.id, v || null);
      useSetupRows.setState((x) => {
        const rows = { ...x.rows };
        delete rows[server.id];
        return { rows };
      });
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  return (
    <select
      value={assigned}
      onChange={(e) => void setProfile(e.target.value)}
      className="h-7 w-[180px] flex-none rounded-md border border-control-border bg-background px-1.5 text-[12px] outline-none focus:border-primary/60"
      title="Its setup profile (saved as setup: on the server)"
    >
      <option value="">{defaultId ? `Default (${defaultId})` : "No default"}</option>
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name ? `${p.name} (${p.id})` : p.id}
        </option>
      ))}
      <option value="none">Not set up</option>
    </select>
  );
}

/** One section's items (System, PHP, SSH…), as a card. */
function SectionCard({ name, items, picked, toggle, onFix, canFix }: { name: string; items: SetupItem[]; picked: Set<string>; toggle: (id: string) => void; onFix: (id: string) => void; canFix: boolean }) {
  const bad = items.filter((i) => i.state === "bad" || i.state === "warn").length;
  return (
    <div className="flex flex-col rounded-lg border border-divider">
      <div className="flex items-center gap-2 border-b border-divider px-3 py-2">
        <span className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{name}</span>
        <span className={cn("text-[12px]", bad ? "text-env-prod-fg" : "text-[#17702a]")}>{bad ? `${bad} to fix` : "✓"}</span>
      </div>
      <div className="flex flex-col divide-y divide-divider/70">
        {items.map((it) => (
          <div key={it.id} className="flex items-start gap-2.5 px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-[3px] flex-none"
              disabled={!it.fixable || !canFix}
              checked={picked.has(it.id)}
              onChange={() => toggle(it.id)}
              aria-label={`Fix ${it.title}`}
              title={it.fixable ? "Include in Fix selected" : it.state === "ok" ? "Nothing to fix" : "Kemudi can't fix this one"}
            />
            <span className={cn("w-4 flex-none text-center text-[14px] leading-5 font-semibold", TONE[it.state])}>{MARK[it.state]}</span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13px] font-medium">{it.title}</span>
              <span className={cn("font-mono text-[12px] break-words", it.state === "ok" ? "text-muted-foreground" : TONE[it.state])}>{it.detail}</span>
              {it.expected && it.state !== "ok" && <span className="text-[11.5px] break-words text-subtle-foreground">want: {it.expected}</span>}
            </div>
            {it.fixable && canFix && (
              <Btn size="sm" variant="ghost" onClick={() => onFix(it.id)}>
                Fix
              </Btn>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One server's (or instance's) results: sections as cards. */
function Results({ server, r, picked, toggle, canFix }: { server: Server; r: Result; picked: Set<string>; toggle: (id: string) => void; canFix: boolean }) {
  if (typeof r.status === "string") return <div className="rounded-lg bg-env-prod/8 px-3 py-2 text-[12.5px] text-env-prod-fg">{r.status}</div>;
  const st = r.status;
  const sections = [...new Set(st.items.map((i) => i.section))];
  const hasSsh = st.items.some((i) => i.id.startsWith("ssh-") && i.fixable);
  return (
    <div className="flex flex-col gap-3">
      {r.instance && <span className="font-mono text-[12px] text-subtle-foreground">{r.instance}</span>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-subtle-foreground">
        {st.os && <span>{st.os}</span>}
        <span>profile {st.profile}</span>
        <span>Kemudi connects on port {st.portNow}</span>
        {!st.root && <span className="text-[#8a5a12]">Some checks need root: sign in as root, or let sudo work without a password, to see them (they show as ?).</span>}
      </div>
      {hasSsh && canFix && (
        <div className="rounded-lg border border-primary/25 bg-primary/6 px-3 py-2 text-[12px] text-muted-foreground">
          SSH fixes go in an order that can't lock you out: a key login checked first; the new port opened and tried before the old one closes; a pause for you to set
          its Port in ~/.ssh/config; passwords off last, then checked from this Mac.
        </div>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(440px,1fr))] items-start gap-3">
        {sections.map((sec) => (
          <SectionCard
            key={sec}
            name={sec}
            items={st.items.filter((i) => i.section === sec)}
            picked={picked}
            toggle={toggle}
            canFix={canFix}
            onFix={(id) => void fix(server, [id])}
          />
        ))}
      </div>
      {st.helpers && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Helpers in detail</span>
          <BaselineChips status={st.helpers} />
        </div>
      )}
    </div>
  );
}

/** A server's Setup tab: every item of its profile, what was found, and
 *  Fix (one, the ones ticked, or all). */
export function ServerSetupView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const serverId = tab.serverId ?? "";
  const server = useConfig((s) => s.snapshot?.config?.servers.find((x) => x.id === serverId));
  const setup = useConfig((s) => s.snapshot?.config?.setup);
  const row = useSetupRows((x) => x.rows[serverId]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const assigned = setup?.assigned[serverId] ?? "";
  const effective = assigned || setup?.default;
  const none = !effective || effective === "none";
  const results = row?.state === "done" ? row.results : [];
  const fixable = [...new Set(results.flatMap((r) => (typeof r.status === "string" ? [] : r.status.items.filter((i) => i.fixable))).map((i) => i.id))];

  useEffect(() => {
    if (visible && server && !none && !row) void checkServer(server);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, server?.id, none]);
  // After each check: what's wrong (not just a warning) is ticked.
  useEffect(() => {
    if (row?.state !== "done") return;
    setPicked(new Set(row.results.flatMap((r) => (typeof r.status === "string" ? [] : r.status.items.filter((i) => i.fixable && i.state === "bad").map((i) => i.id)))));
  }, [row]);

  if (!server) return <div className="light-ui absolute inset-0 bg-background p-4 text-[13px] text-subtle-foreground">{serverId} isn't in Kemudi any more.</div>;
  const canFix = !isAsg(server) && row?.state === "done";
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const chosen = fixable.filter((id) => picked.has(id));

  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-3">
        <span className="text-[13px] font-semibold">Setup</span>
        <span className="text-[12.5px] text-subtle-foreground">{server.name}</span>
        <EnvTag env={server.env} />
        <ProfileSelect server={server} assigned={assigned} profiles={setup?.profiles ?? []} defaultId={setup?.default ?? null} />
        <span className="min-w-0 flex-1 truncate pl-2 text-[12px]">{!none && <RowState server={server} row={row} />}</span>
        {!isAsg(server) && (
          <Btn size="sm" variant="ghost" disabled={none} onClick={() => void fix(server, ["lynis-audit"])} title="lynis audit system --quick, in a terminal">
            Lynis audit
          </Btn>
        )}
        <Btn size="sm" variant="outline" disabled={none || row?.state === "busy" || row?.state === "fixing"} onClick={() => void checkServer(server)}>
          <RotateCw className={cn("size-3.5", row?.state === "busy" && "animate-spin")} /> Check again
        </Btn>
        <Btn
          size="sm"
          variant="primary"
          disabled={!canFix || chosen.length === 0}
          onClick={() => void fix(server, chosen)}
          title={isAsg(server) ? "An Auto Scaling group: set up its image (AMI) instead" : "The ticked items as one workflow (you see its steps first)"}
        >
          <Wrench className="size-3.5" /> Fix {chosen.length ? `${chosen.length} ticked` : "ticked"}
        </Btn>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {none && (
          <div className="text-[13px] text-subtle-foreground">
            {server.name} has no setup profile. Pick one above (or set a default in Settings ▸ Server setup ▸ Edit profiles).
          </div>
        )}
        {!none && row?.state === "busy" && results.length === 0 && (
          <div className="text-[13px] text-subtle-foreground">Checking {server.name} against {effective} (read-only)…</div>
        )}
        {fixable.length > 0 && canFix && (
          <div className="mb-3 flex items-center gap-3 text-[12px] text-subtle-foreground">
            <span>
              {fixable.length} can be fixed; the ✗ ones are ticked. Fix shows the steps (and the script) before anything runs
              {server.env === "prod" ? ", and asks for the server's name" : ""}.
            </span>
            <button className="cursor-pointer text-primary hover:underline" onClick={() => setPicked(new Set(fixable))}>
              Tick all
            </button>
            <button className="cursor-pointer text-primary hover:underline" onClick={() => setPicked(new Set())}>
              None
            </button>
          </div>
        )}
        <div className="flex flex-col gap-6">
          {results.map((r) => (
            <Results key={r.instance ?? "-"} server={server} r={r} picked={picked} toggle={toggle} canFix={canFix} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The `setup:` block of servers.yaml, edited as YAML. */
function ProfilesEditor({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setupSource().then(
      (t) => {
        setSaved(t);
        setText(t || STARTER);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  }, []);
  const save = async () => {
    if (text === null) return;
    setBusy(true);
    try {
      await setupSave(text);
      setSaved(text);
      setError(null);
      useToasts.getState().push("Setup profiles saved", "info");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (text === null) return <div className="text-[12px] text-subtle-foreground">{error ?? "Loading…"}</div>;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4">
        <CodeEditor value={text} onChange={setText} lang="plain" onSave={() => void save()} autoFocus className="h-[420px] rounded-lg border border-control-border" />
        <div className="flex flex-col gap-1 text-[11.5px] text-muted-foreground">
          <span className="text-[12px] font-medium text-foreground">What a profile can say</span>
          {KEYS.map(([k, v]) => (
            <span key={k}>
              <span className="font-mono text-foreground">{k}</span>: <span className="font-mono">{v}</span>
            </span>
          ))}
          <span className="mt-2">Left out: not checked. Passwords never go here: Kemudi asks for them in the terminal.</span>
        </div>
      </div>
      {error && <div className="text-[12px] text-env-prod-fg">{error}</div>}
      <div className="flex items-center gap-2">
        {!saved && <span className="text-[12px] text-subtle-foreground">A start from a typical new-server list: change it to yours, then Save.</span>}
        <span className="flex-1" />
        <Btn size="sm" variant="ghost" onClick={onClose}>
          Close
        </Btn>
        <Btn size="sm" variant="primary" disabled={busy || text === saved} onClick={() => void save()}>
          {busy ? "Saving…" : "Save ⌘S"}
        </Btn>
      </div>
    </div>
  );
}

/** The Server setup tab (View ▸ Server Setup ⇧⌘B, Settings, ⌘K): what a
 *  server should have, by profile; a read-only check of every server, and
 *  fixes that run as workflows. */
export function SetupView() {
  const setup = useConfig((s) => s.snapshot?.config?.setup);
  const hasHelpers = useConfig((s) => !!s.snapshot?.config?.baseline);
  const servers = useTeamServers();
  const team = useCurrentTeam();
  const [editing, setEditing] = useState(false);
  const [helpersOpen, setHelpersOpen] = useState(false);
  const profiles = setup?.profiles ?? [];
  const defaultId = setup?.default ?? null;
  const checkable = servers.filter((s) => {
    const p = setup?.assigned[s.id] ?? defaultId;
    return p && p !== "none";
  });

  const checkAll = async () => {
    // Four at a time: each is an ssh (or Session Manager) connection.
    const queue = [...checkable];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) await checkServer(s);
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  };

  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <div className="flex h-12 flex-none items-center gap-2 border-b border-divider px-4">
        <span className="text-[14px] font-semibold">Server setup</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-subtle-foreground">
          What a server should have, by profile. Checking is read-only; Fix runs the steps as a workflow you watch (and confirm on production).
        </span>
        <Btn size="sm" variant="outline" disabled={checkable.length === 0} onClick={() => void checkAll()}>
          <RotateCw className="size-3" /> Check all servers
        </Btn>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1240px] flex-col gap-5 px-6 py-5">
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold">Profiles</span>
              <span className="flex flex-wrap gap-1.5">
                {profiles.map((p) => (
                  <span key={p.id} className="rounded-md border border-control-border px-2 py-0.5 text-[12px]" title={p.extends ? `extends ${p.extends}` : undefined}>
                    {p.name ?? p.id}
                    {p.name && <span className="ml-1 font-mono text-[11px] text-subtle-foreground">{p.id}</span>}
                    {p.id === defaultId && <span className="ml-1 text-[11px] text-primary">default</span>}
                  </span>
                ))}
                {profiles.length === 0 && <span className="text-[12px] text-subtle-foreground">None yet: Edit profiles starts you from a typical new-server list.</span>}
              </span>
              <span className="flex-1" />
              {!editing && (
                <Btn size="sm" variant="outline" onClick={() => setEditing(true)}>
                  Edit profiles
                </Btn>
              )}
            </div>
            {editing && <ProfilesEditor onClose={() => setEditing(false)} />}
          </section>

          <section className="flex flex-col gap-2 border-t border-divider pt-4">
            <button className="flex w-fit cursor-pointer items-center gap-1.5" onClick={() => setHelpersOpen(!helpersOpen)}>
              {helpersOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              <span className="text-[13px] font-semibold">Helpers</span>
              <span className="text-[12px] text-subtle-foreground">
                repos cloned into one folder and lines in root's ~/.bashrc{hasHelpers ? " (checked on every profile unless it says helpers: false)" : ""}
              </span>
            </button>
            {helpersOpen && <HelpersEditor />}
          </section>

          <section className="flex flex-col gap-2 border-t border-divider pt-4">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold">Servers</span>
              <span className="text-[12px] text-subtle-foreground">
                {team ? `${team.name} · ` : ""}
                {servers.length} · click one for its Setup tab · AWS servers: each instance, checked only · a new server: add it, pick its profile, open it, Fix
              </span>
            </div>
            <div className="flex flex-col divide-y divide-divider rounded-lg border border-divider">
              {servers.map((s) => (
                <ServerRow key={s.id} server={s} profiles={profiles} defaultId={defaultId} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
