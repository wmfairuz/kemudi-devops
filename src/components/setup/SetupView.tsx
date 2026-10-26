import { ChevronDown, ChevronRight, RotateCw, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { HelpersEditor } from "@/components/baseline/Baseline";
import { Btn } from "@/components/kit/Btn";
import { CodeEditor } from "@/components/kit/CodeEditor";
import { EnvTag } from "@/components/kit/EnvTag";
import { Spinner } from "@/components/kit/Spinner";
import { isAsg } from "@/lib/fleet";
import { asgInstances, errorMessage, serverSetSetup, setupCheck, setupPlan, setupSave, setupSource, type Server, type SetupItem, type SetupStatus } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { useTabs, WORKFLOWS_ID } from "@/stores/tabs";
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
  ["ssh", "{ port: 2222, password_auth: false }"],
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
const useSetupRows = create<{ rows: Record<string, Row>; open: Record<string, boolean> }>(() => ({ rows: {}, open: {} }));
const setRow = (id: string, row: Row) => useSetupRows.setState((x) => ({ rows: { ...x.rows, [id]: row } }));
const setOpen = (id: string, open: boolean) => useSetupRows.setState((x) => ({ open: { ...x.open, [id]: open } }));

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
  // Something to look at: open it.
  if (results.some((r) => typeof r.status === "string" || r.status.items.some((i) => i.state !== "ok"))) setOpen(s.id, true);
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

/** One server's (or instance's) items, by section. */
function Items({ server, r }: { server: Server; r: Result }) {
  const fixing = useSetupRows((x) => x.rows[server.id]?.state === "fixing");
  if (typeof r.status === "string") return <div className="text-[12px] text-env-prod-fg">{r.status}</div>;
  const st = r.status;
  const sections = [...new Set(st.items.map((i) => i.section))];
  const canFix = !isAsg(server) && !fixing;
  return (
    <div className="flex flex-col gap-2">
      {r.instance && <span className="font-mono text-[11px] text-subtle-foreground">{r.instance}</span>}
      <div className="grid grid-cols-[110px_18px_minmax(160px,220px)_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 text-[12px]">
        {sections.map((sec) =>
          st.items
            .filter((i) => i.section === sec)
            .map((it, k) => (
              <div key={it.id} className="contents">
                <span className="text-[11px] font-medium tracking-wide text-subtle-foreground uppercase">{k === 0 ? sec : ""}</span>
                <span className={cn("text-center font-semibold", TONE[it.state])}>{MARK[it.state]}</span>
                <span className="truncate" title={it.id}>
                  {it.title}
                </span>
                <span className="min-w-0">
                  <span className={cn("font-mono text-[11.5px]", it.state === "ok" ? "text-muted-foreground" : TONE[it.state])}>{it.detail}</span>
                  {it.expected && it.state !== "ok" && <span className="ml-2 text-[11px] text-subtle-foreground">want: {it.expected}</span>}
                </span>
                <span>
                  {it.fixable && canFix && (
                    <button className="cursor-pointer text-[12px] text-primary hover:underline" onClick={() => void fix(server, [it.id])}>
                      Fix
                    </button>
                  )}
                </span>
              </div>
            )),
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle-foreground">
        {st.os && <span>{st.os}</span>}
        <span>Kemudi connects on port {st.portNow}</span>
        {!st.root && <span className="text-[#8a5a12]">Some checks need root: sign in as root, or let sudo work without a password, to see them.</span>}
        {!isAsg(server) && (
          <button className="cursor-pointer text-primary hover:underline" onClick={() => void fix(server, ["lynis-audit"])} title="lynis audit system --quick, in a terminal tab">
            Run a Lynis audit
          </button>
        )}
      </div>
    </div>
  );
}

function ServerRow({ server, profiles, defaultId }: { server: Server; profiles: { id: string; name: string | null }[]; defaultId: string | null }) {
  const row = useSetupRows((x) => x.rows[server.id]);
  const open = useSetupRows((x) => x.open[server.id] ?? false);
  const assigned = useConfig((s) => s.snapshot?.config?.setup.assigned[server.id] ?? "");
  const effective = assigned || defaultId;
  const none = !effective || effective === "none";
  const results = row?.state === "done" ? row.results : [];
  const fixIds = [...new Set(results.flatMap((r) => (typeof r.status === "string" ? [] : r.status.items.filter((i) => i.fixable).map((i) => i.id))))];
  const all = results.flatMap((r) => (typeof r.status === "string" ? [] : [counts(r.status)]));
  const sum = all.reduce((a, c) => ({ ok: a.ok + c.ok, warn: a.warn + c.warn, bad: a.bad + c.bad, unknown: a.unknown + c.unknown }), { ok: 0, warn: 0, bad: 0, unknown: 0 });
  const failed = results.find((r) => typeof r.status === "string");

  const setProfile = async (v: string) => {
    try {
      await serverSetSetup(server.id, v || null);
    } catch (e) {
      toastError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col px-3 py-2">
      <div className="flex items-center gap-3">
        <button
          aria-label={open ? "Collapse" : "Expand"}
          disabled={results.length === 0}
          onClick={() => setOpen(server.id, !open)}
          className="flex size-5 flex-none cursor-pointer items-center justify-center rounded text-subtle-foreground hover:bg-hover disabled:cursor-default disabled:opacity-30"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className="flex w-[210px] flex-none items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium">{server.name}</span>
          <EnvTag env={server.env} />
        </span>
        <select
          value={assigned}
          onChange={(e) => void setProfile(e.target.value)}
          className="h-7 w-[170px] flex-none rounded-md border border-control-border bg-background px-1.5 text-[12px] outline-none focus:border-primary/60"
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
        <span className="min-w-0 flex-1 truncate text-[12px]">
          {none && <span className="text-subtle-foreground">not checked (no profile)</span>}
          {!none && !row && <span className="text-subtle-foreground">not checked yet</span>}
          {row?.state === "busy" && (
            <span className="flex items-center gap-1.5 text-subtle-foreground">
              <Spinner size={10} /> checking…
            </span>
          )}
          {row?.state === "fixing" && (
            <button className="flex cursor-pointer items-center gap-1.5 text-subtle-foreground hover:text-foreground" onClick={() => showRun(row.tabId)}>
              <Spinner size={10} /> fixing (see its run) — checked again when it ends
            </button>
          )}
          {row?.state === "done" && failed && typeof failed.status === "string" && <span className="text-env-prod-fg">{failed.status}</span>}
          {row?.state === "done" && !failed && (
            <span className="flex items-center gap-3">
              <span className="text-[#17702a]">✓ {sum.ok}</span>
              {sum.bad > 0 && <span className="text-env-prod-fg">✗ {sum.bad}</span>}
              {sum.warn > 0 && <span className="text-[#8a5a12]">! {sum.warn}</span>}
              {sum.unknown > 0 && <span className="text-subtle-foreground">? {sum.unknown}</span>}
              {sum.bad + sum.warn === 0 && <span className="text-[#17702a]">all as the profile says</span>}
            </span>
          )}
        </span>
        <span className="flex flex-none gap-1">
          <Btn size="sm" variant="ghost" disabled={none || row?.state === "busy" || row?.state === "fixing"} onClick={() => void checkServer(server)}>
            Check
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            disabled={fixIds.length === 0 || isAsg(server) || row?.state !== "done"}
            onClick={() => void fix(server, fixIds)}
            title={isAsg(server) ? "An Auto Scaling group: set up its image (AMI) instead" : "Fix everything that's off, as one workflow (you see the steps first)"}
          >
            <Wrench className="size-3" /> Fix all{fixIds.length ? ` (${fixIds.length})` : ""}
          </Btn>
        </span>
      </div>
      {open && results.length > 0 && (
        <div className="mt-2 ml-8 flex flex-col gap-3 border-l border-divider pl-4">
          {results.map((r) => (
            <Items key={r.instance ?? "-"} server={server} r={r} />
          ))}
        </div>
      )}
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
                {servers.length} · AWS servers: each instance (checked only). A new server: add it, pick its profile, Check, Fix all.
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
