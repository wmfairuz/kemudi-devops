import { Check, Copy, KeyRound, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { CodeEditor } from "@/components/kit/CodeEditor";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, Segmented, TextInput, VALID_ID } from "@/components/manage/fields";
import { blockIntro } from "@/lib/actions";
import { copyText } from "@/lib/clipboard";
import {
  appSave,
  certsList,
  errorMessage,
  newappCreateKey,
  newappProbe,
  newappRepoCheck,
  newappRun,
  newappScript,
  newAppHookSave,
  type NewAppHooks,
  type CertbotCert,
  type Env,
  type NewAppPlan,
  type NewAppProbe,
  type RepoCheck,
  type Server,
  type Wildcard,
} from "@/lib/ipc";
import { DOMAIN, SITE_NAME, generateVhost, socketFor } from "@/lib/nginxVhost";
import { localHms } from "@/lib/time";
import { cn } from "@/lib/utils";
import { findServer, useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { freeId, openDetails } from "@/stores/manage";
import { useNewApp, type NewAppDraft } from "@/stores/newApp";
import { useTabs } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

export function NewAppDialog() {
  const serverId = useNewApp((s) => s.serverId);
  const server = useConfig((s) => s.snapshot?.config?.servers.find((x) => x.id === serverId));
  if (!serverId || !server) return null;
  return <NewApp key={serverId} server={server} />;
}

const appEnvFor = (env: Env) => (env === "prod" ? "production" : env === "dev" ? "local" : "staging");

/** Where this server's apps live: the folder most of them share. */
function suggestedParent(server: Server): string {
  const counts = new Map<string, number>();
  for (const a of server.apps) {
    const parent = a.path.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? "/var/www";
}

const wildKey = (w: Wildcard) => `${w.file}|${w.root}`;
const wildLabel = (w: Wildcard) => `*${w.suffix} → ${w.root}/public`;

const dbName = (id: string) => id.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32);

/** A certificate whose names cover `domain` (exact or *.parent). */
function certFor(certs: CertbotCert[], domain: string): string {
  const parent = domain.split(".").slice(1).join(".");
  return certs.find((c) => c.domains.includes(domain))?.name ?? certs.find((c) => c.domains.includes(`*.${parent}`))?.name ?? "";
}

function blank(server: Server): NewAppDraft {
  return {
    name: "",
    id: "",
    idTouched: false,
    domains: "",
    appEnv: appEnvFor(server.env),
    repo: "",
    branch: "",
    path: "",
    pathTouched: false,
    php: "",
    owner: "",
    migrate: true,
    seed: false,
    npm: false,
    dbMode: "new",
    dbName: "",
    dbUser: "",
    dbTouched: false,
    web: "new",
    webTouched: false,
    wildcard: "",
    sub: "",
    subTouched: false,
    vhostName: "",
    https: "certbot",
    httpsTouched: false,
    certName: "",
    maxBody: "64M",
    worker: false,
    processes: 1,
    schedule: true,
  };
}

type Phase = { kind: "probing" } | { kind: "error"; message: string } | { kind: "form" };

/** Server ▸ New app…: set up a Laravel app on the server from a few choices,
 *  run as one script in a terminal tab, then add it to Kemudi. */
function NewApp({ server }: { server: Server }) {
  const serverId = server.id;
  const prod = server.env === "prod";
  const [d, setD] = useState<NewAppDraft>(() => useNewApp.getState().drafts[serverId] ?? blank(server));
  const set = (patch: Partial<NewAppDraft>) => setD((x) => ({ ...x, ...patch }));
  const [probe, setProbe] = useState<NewAppProbe | null>(null);
  const [certs, setCerts] = useState<CertbotCert[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: "probing" });
  const [repoCheck, setRepoCheck] = useState<RepoCheck | "checking" | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [script, setScript] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => useNewApp.getState().save(serverId, d), [serverId, d]);

  const load = () => {
    setPhase({ kind: "probing" });
    newappProbe(serverId).then(
      (p) => {
        setProbe(p);
        setD((x) => ({
          ...x,
          php: x.php || p.phpVersions[0] || "",
          owner: x.owner || p.owner || (p.root ? "www-data:www-data" : `${p.user}:www-data`),
          npm: x.npm && p.tools.includes("npm"),
          ...(x.webTouched ? {} : defaultWeb(server, p)),
          worker: x.worker && !!p.supervisorDir,
          dbMode: p.tools.includes("mysql") ? x.dbMode : "none",
          https: x.httpsTouched ? x.https : p.vhost.certbot ? "certbot" : "none",
        }));
        setPhase({ kind: "form" });
      },
      (e: unknown) => setPhase({ kind: "error", message: errorMessage(e) }),
    );
    certsList(serverId).then(
      (r) => setCerts(r.certs),
      () => {},
    );
  };
  useEffect(load, [serverId]);

  // Fields that follow others until they're typed in.
  // Kemudi's own key for it (never shown): from the name, free on the server.
  const id = d.name.trim() ? freeId(d.name, server.apps.map((a) => a.id), "app") : "";
  const wild = probe?.wildcards.find((w) => wildKey(w) === d.wildcard) ?? null;
  const web = d.web === "wildcard" && !wild ? "new" : d.web;
  const sub = d.subTouched ? d.sub : id;
  const wildDomain = wild && sub ? `${sub}${wild.suffix}`.toLowerCase() : "";
  const path =
    web === "wildcard" && wild ? (sub ? wild.root.replace(`$${wild.var}`, sub) : "") : d.pathTouched ? d.path : id ? `${suggestedParent(server)}/${id}` : "";
  const db = d.dbTouched ? d.dbName : dbName(id);
  const dbUser = d.dbTouched ? d.dbUser : dbName(id);
  const domains =
    web === "wildcard"
      ? [wildDomain].filter(Boolean)
      : d.domains
          .split(/[\s,]+/)
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean);
  const vhostName = d.vhostName || domains[0] || "";
  // The certificate that covers the main domain, if there is one.
  useEffect(() => {
    if (!domains[0] || d.httpsTouched) return;
    const c = certFor(certs, domains[0]);
    if (c) set({ https: "cert", certName: c });
    else if (d.https === "cert") set({ https: probe?.vhost.certbot ? "certbot" : "none", certName: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.domains, certs]);

  const https = web === "new" ? d.https : "none";
  const secure = web === "wildcard" ? !!wild?.ssl : https !== "none";
  const url = domains[0] ? `${secure ? "https" : "http"}://${domains[0]}` : null;
  // A wildcard vhost with per-site `if` blocks: one is added when the app's
  // PHP isn't what the site gets already.
  const wildPhp = web === "wildcard" && wild?.php.kind === "ifs" ? wild.php : null;
  const currentPhp = wildPhp ? (wildPhp.hosts.find(([h]) => h === wildDomain)?.[1] ?? wildPhp.default) : null;
  // Hooks: the team's, then the server's.
  const team = useConfig((s) => s.snapshot?.config?.teams.find((t) => t.id === server.team) ?? null);
  const hookOwners: HookOwner[] = [
    ...(team ? [{ who: `team ${team.name}`, scope: { kind: "team" as const, id: team.id }, hooks: team.newApp }] : []),
    { who: serverId, scope: { kind: "server" as const, id: serverId }, hooks: server.newApp },
  ];
  // Does a hook already take care of this vhost's PHP file?
  const phpHooked = !!wildPhp && hookOwners.some((o) => o.hooks.after?.includes(wildPhp.file));
  const phpNeedsHook = !!wildPhp && !!wildDomain && currentPhp !== d.php && !phpHooked;
  const [editing, setEditing] = useState<{ owner: HookOwner; which: "before" | "after"; text: string } | null>(null);
  const addPhpHook = () => {
    if (!wild?.hook) return;
    const current = server.newApp.after;
    const owner = hookOwners.find((o) => o.scope.kind === "server");
    if (!owner) return;
    setEditing({ owner, which: "after", text: current ? `${current}\n\n${wild.hook}` : wild.hook });
  };
  const vhostFiles = web === "wildcard" && wild ? [wild.file] : web === "new" && vhostName ? [`/etc/nginx/sites-available/${vhostName}`] : [];
  const socket = probe ? socketFor(probe.vhost.phpSockets, d.php) : "";
  const exactSocket = !!probe?.vhost.phpSockets.some((s) => s.endsWith(`/php${d.php}-fpm.sock`));
  const workerFile = probe?.supervisorDir ? `${probe.supervisorDir}/${id}-worker${probe.supervisorExt}` : "";

  const plan: NewAppPlan = useMemo(
    () => ({
      id,
      name: d.name.trim() || id,
      repo: d.repo.trim(),
      branch: d.branch.trim() || null,
      path: path.replace(/\/+$/, ""),
      php: d.php,
      owner: d.owner.trim(),
      appEnv: d.appEnv.trim(),
      url,
      npm: d.npm,
      migrate: d.migrate,
      seed: d.migrate && d.seed,
      db: d.dbMode === "none" ? { mode: "none" } : { mode: d.dbMode, database: db, user: dbUser },
      vhost:
        web === "new" && probe
          ? {
              name: vhostName,
              content: generateVhost({
                domains,
                root: `${path.replace(/\/+$/, "")}/public`,
                phpSocket: socket,
                https: https === "cert" ? "cert" : "none",
                certName: d.certName,
                certbotOptions: probe.vhost.certbotOptions,
                maxBody: d.maxBody,
                logs: true,
                logName: vhostName || "site",
              }),
            }
          : null,
      worker: d.worker && workerFile ? { file: workerFile, processes: d.processes } : null,
      certbot: https === "certbot" ? domains : [],
      schedule: d.schedule,
      domain: domains[0] ?? null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(d), id, path, db, dbUser, url, socket, probe, workerFile, web],
  );

  // Things that stop it, and things worth a second look.
  const problems: string[] = [];
  const notes: string[] = [];
  if (probe) {
    if (!d.name.trim()) problems.push("Give the app a name.");
    if (id && !VALID_ID.test(id)) problems.push("Give it a name with some letters or digits.");
    if (!plan.repo) problems.push("Add the repository.");
    if (!/^\/[A-Za-z0-9._/-]+$/.test(plan.path) || plan.path.split("/").length < 3) problems.push("The path must be a full path, two folders deep, without spaces.");
    else if (server.apps.some((a) => a.path.replace(/\/+$/, "") === plan.path)) problems.push(`${plan.path} is already an app in Kemudi.`);
    if (!d.php) problems.push("Pick a PHP version.");
    if (!/^[a-z_][a-z0-9_-]*(:[a-z_][a-z0-9_-]*)?$/i.test(plan.owner)) problems.push("The owner looks like www-data:www-data.");
    if (plan.db.mode !== "none") {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(db)) problems.push("The database name can use letters, digits and _.");
      if (!/^[A-Za-z0-9_]{1,32}$/.test(dbUser)) problems.push("The database user can use letters, digits and _ (up to 32).");
      if (plan.db.mode === "new" && probe.dbUsers.includes(dbUser)) notes.push(`MySQL user ${dbUser} already exists: pick “Existing user” (unless this is a re-run).`);
      if (plan.db.mode === "existing" && probe.mysql && probe.dbUsers.length && !probe.dbUsers.includes(dbUser)) notes.push(`There's no MySQL user ${dbUser} yet.`);
      if (probe.databases.includes(db)) notes.push(`Database ${db} already exists; it's used as it is.`);
      if (!probe.mysql) notes.push(`MySQL's root needs a password on ${serverId}: the terminal asks for it during the run (it isn't saved).`);
    }
    if (web === "wildcard" && wild) {
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(sub)) problems.push("The subdomain can use letters, digits and - (it's also the folder name).");
      if (!exactSocket) problems.push(`No PHP-FPM socket for ${d.php} on ${serverId} (php${d.php}-fpm).`);
      if (wild.php.kind === "fixed" && wild.php.version !== d.php) notes.push(`This vhost runs every site with PHP ${wild.php.version}, so this app will too.`);
      if (wild.php.kind === "other") notes.push(`PHP for ${wildDomain || "the site"}: ${wild.php.note}. Set it to ${d.php} by hand.`);
      if (wildPhp && currentPhp && wildPhp.hosts.some(([h]) => h === wildDomain) && currentPhp !== d.php)
        problems.push(`${wildPhp.file} already gives ${wildDomain} PHP ${currentPhp}: pick that, or change it there.`);
      if (phpNeedsHook) notes.push(`${wildDomain} gets PHP ${currentPhp ?? "the default"} from ${wildPhp?.file}, and no hook sets ${d.php}: add the suggested hook (Web), or pick ${currentPhp}.`);
    }
    if (web === "new") {
      if (domains.length === 0) problems.push("Add the domain for the vhost.");
      for (const x of domains) if (!DOMAIN.test(x)) problems.push(`“${x}” isn't a domain name.`);
      if (!SITE_NAME.test(vhostName)) problems.push("The vhost file name can use letters, digits, . _ -");
      else if (probe.vhost.sites.includes(vhostName)) notes.push(`${vhostName} is already in sites-available: it's kept if it's the same, else the run stops there.`);
      if (!socket) problems.push("No PHP-FPM socket on the server.");
      else if (!exactSocket) notes.push(`No PHP-FPM socket for ${d.php}; the vhost uses ${socket}.`);
      if (https === "cert" && !d.certName) problems.push("Pick the certificate.");
      if (https === "certbot" && domains.some((x) => x.startsWith("*."))) problems.push("certbot --nginx can't get a wildcard certificate.");
      if (d.maxBody && !/^\d+[kKmMgG]?$/.test(d.maxBody)) problems.push("Upload limit looks like 64M.");
    }
    if (repoCheck && repoCheck !== "checking" && !repoCheck.ok) notes.push("The server can't read the repository yet; the clone step will fail.");
  }
  // No list of what's missing before anything is typed.
  const pristine = !d.name.trim() && !d.repo.trim();
  const canCreate = phase.kind === "form" && problems.length === 0 && (!prod || typed === serverId);

  const checkRepo = async () => {
    if (!d.repo.trim()) return;
    setRepoCheck("checking");
    try {
      const r = await newappRepoCheck(serverId, d.repo.trim());
      setRepoCheck(r);
      if (r.ok && !d.branch && r.defaultBranch) set({ branch: r.defaultBranch });
    } catch (e) {
      setRepoCheck(null);
      toastError(errorMessage(e));
    }
  };

  const createKey = async () => {
    setKeyBusy(true);
    try {
      const k = await newappCreateKey(serverId);
      setProbe((p) => (p ? { ...p, keys: [...p.keys, k] } : p));
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setKeyBusy(false);
    }
  };

  const showScript = async () => {
    try {
      setScript(await newappScript(serverId, plan));
    } catch (e) {
      toastError(errorMessage(e));
    }
  };

  const create = () => {
    if (!canCreate) return;
    useNewApp.getState().close();
    runNewApp(server, plan, d.php, vhostFiles);
  };

  const close = async () => {
    if ((d.name || d.repo) && !(await askConfirm("Close the new app form?", "Nothing has been done on the server. The form is kept until you quit Kemudi.", "Close"))) return;
    useNewApp.getState().close();
  };

  const select =
    "h-8 w-full rounded-lg border border-control-border bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-primary/60";
  const check = "flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50";
  const has = (t: string) => !!probe?.tools.includes(t);

  return (
    <Modal open onOpenChange={(o) => !o && void close()} title={`New app on ${serverId}`} width={1060}>
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">New app</span>
          <span className="text-[12.5px] text-subtle-foreground">on {server.name}</span>
          <EnvTag env={server.env} />
        </div>
        <span className="text-[12.5px] text-muted-foreground">
          Sets up a Laravel app on the server and adds it to Kemudi. It runs as one script in a terminal tab, so you see every step and can answer sudo,
          certbot or a password there. Each step skips what's already done, so running it again after a fix is safe.
        </span>
      </ModalHeader>

      <div className="flex h-[min(68vh,640px)] border-t border-divider">
        {phase.kind === "probing" && <Center>Looking at {serverId}: PHP, tools, keys, MySQL, nginx and Supervisor…</Center>}
        {phase.kind === "error" && (
          <Center>
            <span className="max-w-[560px] text-center text-env-prod-fg">{phase.message}</span>
            <Btn size="sm" variant="outline" onClick={load}>
              Try again
            </Btn>
          </Center>
        )}
        {phase.kind === "form" && probe && (
          <>
            <div className="flex w-[470px] flex-none flex-col gap-5 overflow-y-auto border-r border-divider p-4">
              <Section title="App">
                <Field label="Name">
                  {(fid) => <TextInput id={fid} autoFocus className="font-sans" value={d.name} placeholder="Billing Staging" onChange={(e) => set({ name: e.target.value })} />}
                </Field>
                <div className="grid grid-cols-[1fr_130px] gap-3">
                  <Field
                    label="Domain"
                    hint={
                      url ? (
                        <span className="font-mono">APP_URL={url}</span>
                      ) : web === "wildcard" ? (
                        "From the wildcard vhost (Web, below)"
                      ) : (
                        "The main one first; more after a space"
                      )
                    }
                  >
                    {(fid) =>
                      web === "wildcard" ? (
                        <TextInput id={fid} value={wildDomain} disabled title="The wildcard vhost's name for the subdomain (Web, below)" />
                      ) : (
                        <TextInput id={fid} value={d.domains} placeholder="akaun.example.com" onChange={(e) => set({ domains: e.target.value })} />
                      )
                    }
                  </Field>
                  <Field label="APP_ENV">
                    {(fid) => (
                      <TextInput id={fid} list="kemudi-app-envs" value={d.appEnv} onChange={(e) => set({ appEnv: e.target.value })} />
                    )}
                  </Field>
                  <datalist id="kemudi-app-envs">
                    <option value="production" />
                    <option value="staging" />
                    <option value="local" />
                  </datalist>
                </div>
              </Section>

              <Section title="Code">
                <Field
                  label="Repository"
                  hint={
                    repoCheck === "checking" ? (
                      "Asking git from the server…"
                    ) : repoCheck?.ok ? (
                      <span className="text-status-up">
                        <Check className="inline size-3" /> {serverId} can read it · {repoCheck.branches.length} branches
                      </span>
                    ) : repoCheck ? (
                      <span className="selectable whitespace-pre-wrap text-env-prod-fg">{repoCheck.error}</span>
                    ) : (
                      "Cloned on the server with its own SSH key (below)."
                    )
                  }
                >
                  {(fid) => (
                    <div className="flex gap-2">
                      <TextInput
                        id={fid}
                        value={d.repo}
                        placeholder="git@git.example.com:team/app.git"
                        onChange={(e) => {
                          set({ repo: e.target.value });
                          setRepoCheck(null);
                        }}
                        onBlur={() => repoCheck === null && d.repo.trim() && void checkRepo()}
                      />
                      <Btn variant="outline" className="h-8" disabled={!d.repo.trim() || repoCheck === "checking"} onClick={() => void checkRepo()}>
                        <RefreshCw className={cn("size-3.5", repoCheck === "checking" && "animate-spin")} /> Check access
                      </Btn>
                    </div>
                  )}
                </Field>
                <DeployKeys probe={probe} serverId={serverId} busy={keyBusy} onCreate={() => void createKey()} failed={!!repoCheck && repoCheck !== "checking" && !repoCheck.ok} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Branch" hint={d.branch ? undefined : "Empty: the repository's default"}>
                    {(fid) => (
                      <>
                        <TextInput id={fid} list="kemudi-branches" value={d.branch} placeholder={repoCheck && repoCheck !== "checking" ? (repoCheck.defaultBranch ?? "") : "main"} onChange={(e) => set({ branch: e.target.value })} />
                        <datalist id="kemudi-branches">
                          {repoCheck && repoCheck !== "checking" && repoCheck.branches.map((b) => <option key={b} value={b} />)}
                        </datalist>
                      </>
                    )}
                  </Field>
                  <Field label="PHP" hint={probe.phpVersions.length ? undefined : "No /usr/bin/phpX.Y found"}>
                    {(fid) => (
                      <select id={fid} value={d.php} onChange={(e) => set({ php: e.target.value })} className={select}>
                        {probe.phpVersions.length === 0 && <option value="">(none)</option>}
                        {probe.phpVersions.map((v) => (
                          <option key={v} value={v}>
                            php{v}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                </div>
                <Field
                  label="Path"
                  hint={web === "wildcard" ? "The folder the wildcard vhost serves for the subdomain" : d.pathTouched ? undefined : "Next to this server's other apps"}
                >
                  {(fid) => (
                    <TextInput
                      id={fid}
                      value={path}
                      disabled={web === "wildcard"}
                      placeholder="/var/www/app"
                      onChange={(e) => set({ path: e.target.value, pathTouched: true })}
                    />
                  )}
                </Field>
                <Field label="Owner" hint={probe.owner ? `Like this server's other apps (${probe.owner}); Laravel commands run as this user` : "Laravel commands and the queue worker run as this user"}>
                  {(fid) => <TextInput id={fid} value={d.owner} onChange={(e) => set({ owner: e.target.value })} />}
                </Field>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  <label className={check}>
                    <input type="checkbox" checked={d.migrate} onChange={(e) => set({ migrate: e.target.checked })} /> Run migrations
                  </label>
                  <label className={check}>
                    <input type="checkbox" checked={d.migrate && d.seed} disabled={!d.migrate} onChange={(e) => set({ seed: e.target.checked })} /> Seed
                  </label>
                  <label className={check} title="* * * * * cd <path> && php artisan schedule:run, in /etc/cron.d, as the owner">
                    <input type="checkbox" checked={d.schedule} onChange={(e) => set({ schedule: e.target.checked })} /> Scheduler (cron)
                  </label>
                  <label className={check} title={has("npm") ? "npm ci && npm run build" : `npm isn't installed on ${serverId}`}>
                    <input type="checkbox" checked={d.npm} disabled={!has("npm")} onChange={(e) => set({ npm: e.target.checked })} /> Build front-end (npm)
                  </label>
                </div>
              </Section>

              <Section title="Database">
                {has("mysql") ? (
                  <>
                    <Segmented
                      label="Database"
                      value={d.dbMode}
                      onChange={(v) => set({ dbMode: v })}
                      options={[
                        { value: "new", label: "New user" },
                        { value: "existing", label: "Existing user" },
                        { value: "none", label: "Skip" },
                      ]}
                    />
                    {d.dbMode !== "none" && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="Database">
                            {(fid) => <TextInput id={fid} list="kemudi-dbs" value={db} onChange={(e) => set({ dbName: e.target.value, dbUser, dbTouched: true })} />}
                          </Field>
                          <Field label="User">
                            {(fid) => <TextInput id={fid} list={d.dbMode === "existing" ? "kemudi-db-users" : undefined} value={dbUser} onChange={(e) => set({ dbUser: e.target.value, dbName: db, dbTouched: true })} />}
                          </Field>
                          <datalist id="kemudi-dbs">{probe.databases.map((x) => <option key={x} value={x} />)}</datalist>
                          <datalist id="kemudi-db-users">{probe.dbUsers.map((x) => <option key={x} value={x} />)}</datalist>
                        </div>
                        <div className="text-[11px] leading-4 text-subtle-foreground">
                          {d.dbMode === "new"
                            ? "A new MySQL user with a password made on the server; the password goes only into the app's .env (never into Kemudi)."
                            : "You type the user's password in the terminal; it goes only into the app's .env. The database is created and granted to the user if needed."}
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <div className="text-[12px] text-subtle-foreground">The mysql client isn't installed on {serverId}; .env's database settings are left as they are.</div>
                )}
              </Section>

              <Section title="Web">
                <Segmented
                  label="Web"
                  value={web}
                  onChange={(v) => set({ web: v, webTouched: true })}
                  options={[
                    ...(probe.wildcards.length ? [{ value: "wildcard" as const, label: "Wildcard vhost" }] : []),
                    ...(probe.vhost.nginx ? [{ value: "new" as const, label: "New vhost" }] : []),
                    { value: "none", label: "None" },
                  ]}
                />
                {web === "wildcard" && wild && (
                  <>
                    {probe.wildcards.length > 1 && (
                      <Field label="Vhost">
                        {(fid) => (
                          <select id={fid} value={d.wildcard} onChange={(e) => set({ wildcard: e.target.value, webTouched: true })} className={select}>
                            {probe.wildcards.map((w) => (
                              <option key={wildKey(w)} value={wildKey(w)}>
                                {wildLabel(w)}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                    )}
                    <Field label="Subdomain" hint={<span className="font-mono">{wildDomain || `…${wild.suffix}`}</span>}>
                      {(fid) => <TextInput id={fid} value={sub} placeholder={id || "app"} onChange={(e) => set({ sub: e.target.value.toLowerCase(), subTouched: true })} />}
                    </Field>
                    <div className="text-[11px] leading-4 text-subtle-foreground">
                      <span className="font-mono">{wild.file}</span> already serves every <span className="font-mono">*{wild.suffix}</span> from{" "}
                      <span className="font-mono">{wild.root}/public</span>
                      {wild.ssl ? ", over HTTPS with its own certificate" : ""}. No new vhost.{" "}
                      {wild.php.kind === "ifs" &&
                        (phpHooked
                          ? `PHP: a hook below sets it in ${wild.php.file}.`
                          : `PHP: ${wildDomain || "the site"} gets ${currentPhp ?? "the default"} from ${wild.php.file}.`)}
                      {wild.php.kind === "fixed" && `PHP: ${wild.php.version} for every site.`}
                    </div>
                    {wild.hook && !phpHooked && (
                      <div className="flex items-start gap-2 rounded-lg border border-env-staging/40 bg-env-staging/6 px-3 py-2 text-[11.5px] leading-4 text-muted-foreground">
                        <span className="flex-1">
                          This vhost picks PHP per site with <span className="font-mono">if ($http_host = …)</span> blocks in{" "}
                          <span className="font-mono">{wild.php.kind === "ifs" ? wild.php.file : ""}</span>. Kemudi can write {serverId}'s <b>after</b> hook to add one
                          for each new app (only when its PHP isn't the default; nginx -t, put back if it fails). You can read and change it before it's saved.
                        </span>
                        <Btn size="sm" variant="outline" onClick={addPhpHook}>
                          Add as a hook…
                        </Btn>
                      </div>
                    )}
                  </>
                )}
                {web === "new" && (
                  <>
                    <div className="grid grid-cols-[1fr_90px] gap-3">
                      <Field label="File name" hint="In /etc/nginx/sites-available">
                        {(fid) => <TextInput id={fid} value={vhostName} placeholder="akaun.example.com" onChange={(e) => set({ vhostName: e.target.value })} />}
                      </Field>
                      <Field label="Upload limit">{(fid) => <TextInput id={fid} value={d.maxBody} onChange={(e) => set({ maxBody: e.target.value })} />}</Field>
                    </div>
                    <Field
                      label="HTTPS"
                      hint={
                        https === "certbot"
                          ? "certbot --nginx runs last (the terminal shows its questions); DNS must already point here. If it fails, the app still works over http."
                          : https === "cert"
                            ? "Uses a certificate already on the server; http redirects to https."
                            : "http only."
                      }
                    >
                      {() => (
                        <Segmented
                          label="HTTPS"
                          value={d.https}
                          onChange={(v) => set({ https: v, httpsTouched: true })}
                          options={[
                            ...(probe.vhost.certbot ? [{ value: "certbot" as const, label: "New (certbot)" }] : []),
                            ...(certs.length || probe.vhost.certs.length ? [{ value: "cert" as const, label: "Existing certificate" }] : []),
                            { value: "none", label: "None" },
                          ]}
                        />
                      )}
                    </Field>
                    {https === "cert" && (
                      <Field label="Certificate">
                        {(fid) => (
                          <select id={fid} value={d.certName} onChange={(e) => set({ certName: e.target.value, httpsTouched: true })} className={select}>
                            <option value="">Pick one…</option>
                            {(certs.length ? certs.map((c) => ({ name: c.name, label: `${c.name} — ${c.domains.join(" ")}` })) : probe.vhost.certs.map((c) => ({ name: c, label: c }))).map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                    )}
                  </>
                )}
              </Section>

              <Section title="Queue worker">
                <div className="flex items-center gap-4">
                  <label className={check}>
                    <input type="checkbox" checked={d.worker} disabled={!probe.supervisorDir} onChange={(e) => set({ worker: e.target.checked })} />
                    Supervisor queue:work {!probe.supervisorDir && `(no Supervisor on ${serverId})`}
                  </label>
                  {d.worker && (
                    <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                      <input
                        type="number"
                        min={1}
                        max={16}
                        value={d.processes}
                        onChange={(e) => set({ processes: Math.min(16, Math.max(1, Number(e.target.value) || 1)) })}
                        className="h-7 w-14 rounded-md border border-control-border bg-background px-2 font-mono text-[12px] text-foreground outline-none"
                      />
                      processes
                    </label>
                  )}
                </div>
                {d.worker && workerFile && <div className="font-mono text-[11px] text-subtle-foreground">{workerFile}</div>}
              </Section>

              <Section title="Hooks">
                <div className="text-[11px] leading-4 text-subtle-foreground">
                  Your own shell for every new app here: <b>before</b> runs after the checks, before the clone; <b>after</b> runs last, in the app's folder. The
                  team's run first, then the server's. Use <span className="font-mono">{"{{ app.domain }}"}</span>,{" "}
                  <span className="font-mono">{"{{ app.php }}"}</span>, <span className="font-mono">{"{{ app.path }}"}</span>,{" "}
                  <span className="font-mono">{"{{ server.id }}"}</span>…
                </div>
                {hookOwners.map((o) => (
                  <div key={o.who} className="flex flex-col gap-1">
                    <div className="text-[11.5px] font-medium text-muted-foreground">{o.who}</div>
                    {(["before", "after"] as const).map((which) => (
                      <div key={which} className="flex items-center gap-2">
                        <span className="w-12 flex-none text-[11.5px] text-subtle-foreground">{which}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-soft-foreground" title={o.hooks[which] ?? undefined}>
                          {o.hooks[which]?.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) ?? <span className="text-faint-foreground">none</span>}
                        </span>
                        <Btn size="sm" variant="ghost" onClick={() => setEditing({ owner: o, which, text: o.hooks[which] ?? "" })}>
                          {o.hooks[which] ? "Edit…" : "Add…"}
                        </Btn>
                      </div>
                    ))}
                  </div>
                ))}
              </Section>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              {script === null ? (
                <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                  <div className="text-[12px] font-medium text-muted-foreground">What happens on {serverId}</div>
                  <Steps plan={plan} owner={plan.owner} user={probe.user} wild={web === "wildcard" ? wild : null} hooks={hookOwners} />
                  {(problems.length > 0 || notes.length > 0) && (
                    <div className="flex flex-col gap-1.5">
                      {(pristine ? [] : problems).map((p) => (
                        <div key={p} className="rounded-md bg-env-prod/8 px-2.5 py-1.5 text-[12px] text-env-prod-fg">
                          {p}
                        </div>
                      ))}
                      {notes.map((p) => (
                        <div key={p} className="rounded-md bg-env-staging/10 px-2.5 py-1.5 text-[12px] text-env-staging-fg">
                          {p}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-9 flex-none items-center gap-2 border-b border-divider px-4 text-[12px] text-subtle-foreground">
                    <span>The script that runs (bash, in a terminal tab on {server.host})</span>
                    <span className="flex-1" />
                    <Btn size="sm" variant="ghost" onClick={() => setScript(null)}>
                      <X className="size-3.5" /> Back to the steps
                    </Btn>
                  </div>
                  <pre className="selectable min-h-0 flex-1 overflow-auto bg-background px-4 py-3 font-mono text-[11.5px] leading-[17px] whitespace-pre text-foreground">{script}</pre>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <ModalFooter>
        {phase.kind === "form" && (
          <Btn variant="ghost" disabled={problems.length > 0} onClick={() => void showScript()} title="Show the exact bash script">
            Show script
          </Btn>
        )}
        {prod && phase.kind === "form" && (
          <input
            value={typed}
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder={`type ${serverId} to create`}
            aria-label="Type the server name to create"
            className={cn(
              "h-[30px] w-[220px] rounded-lg border bg-background px-2.5 font-mono text-[12.5px] outline-none placeholder:text-faint-foreground",
              typed === serverId ? "border-env-prod/70" : "border-control-border",
            )}
          />
        )}
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={() => void close()}>
          Cancel <Hint>esc</Hint>
        </Btn>
        {phase.kind === "form" && (
          <Btn variant={prod ? "danger" : "primary"} disabled={!canCreate} onClick={create}>
            Set it up on {serverId}
          </Btn>
        )}
      </ModalFooter>
      {editing && <HookEditor {...editing} onClose={() => setEditing(null)} />}
    </Modal>
  );
}

interface HookOwner {
  who: string;
  scope: { kind: "server" | "team"; id: string };
  hooks: NewAppHooks;
}

/** Edit one New app hook (saved into Kemudi's config as a block). */
function HookEditor({ owner, which, text, onClose }: { owner: HookOwner; which: "before" | "after"; text: string; onClose: () => void }) {
  const saved = owner.hooks[which] ?? "";
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await newAppHookSave(owner.scope, which, value.trim() ? value : null);
      useToasts.getState().push(value.trim() ? `Saved ${owner.who}'s ${which} hook` : `Removed ${owner.who}'s ${which} hook`, "info");
      onClose();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${which} hook`} width={820}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">
          New app · {which} hook · {owner.who}
        </span>
        <span className="text-[12px] leading-[17px] text-muted-foreground">
          {which === "before" ? "Runs after the checks, before the clone (in the login user's home)." : "Runs last, in the app's folder."} Bash, in a subshell with{" "}
          <span className="font-mono">set -e</span> (its first failing command stops the run). Templates like actions:{" "}
          <span className="font-mono">{"{{ app.id }} {{ app.name }} {{ app.path }} {{ app.php }} {{ app.url }} {{ app.domain }} {{ app.branch }} {{ app.repo }} {{ app.app_env }} {{ app.owner }} {{ server.id }} {{ server.host }}"}</span>{" "}
          (shell-quoted; <span className="font-mono">| raw</span> to opt out). Kemudi's helpers work: <span className="font-mono">$S</span> (sudo, or nothing as root),{" "}
          <span className="font-mono">ok / note / warn / die "…"</span>, <span className="font-mono">$DIR $PHPBIN $OWNER</span>. A re-run runs it again, so make it safe to repeat.
        </span>
      </ModalHeader>
      <div className="h-[min(50vh,420px)] border-y border-divider">
        <CodeEditor value={value} onChange={setValue} lang="shell" onSave={() => void save()} autoFocus className="h-full" />
      </div>
      <ModalFooter>
        <span className="flex-1 text-[11.5px] text-subtle-foreground">Empty removes it.</span>
        <Btn variant="outline" className="pr-2.5" onClick={onClose}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn variant="primary" disabled={busy || value.trim() === saved.trim()} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"} <Hint>⌘S</Hint>
        </Btn>
      </ModalFooter>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">{title}</div>
      {children}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-4 text-[13px] text-muted-foreground">{children}</div>;
}

/** The server's public key(s): what to add on the git host. */
function DeployKeys({ probe, serverId, busy, onCreate, failed }: { probe: NewAppProbe; serverId: string; busy: boolean; onCreate: () => void; failed: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <div className={cn("flex flex-col gap-1.5 rounded-lg border px-3 py-2", failed ? "border-env-staging/50 bg-env-staging/6" : "border-divider")}>
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <KeyRound className="size-3.5" />
        <span className="flex-1">
          {serverId}'s key ({probe.user}) — add it as a read-only <b>deploy key</b> on the repository (or to an account that can read it)
        </span>
      </div>
      {probe.keys.length === 0 ? (
        <div className="flex items-center gap-2 text-[12px] text-subtle-foreground">
          <span className="flex-1">No key in ~/.ssh yet.</span>
          <Btn size="sm" variant="outline" disabled={busy} onClick={onCreate}>
            {busy ? "Creating…" : "Create one (ed25519)"}
          </Btn>
        </div>
      ) : (
        probe.keys.map((k) => (
          <div key={k.path} className="flex items-center gap-2">
            <span className="selectable min-w-0 flex-1 truncate font-mono text-[11px] text-soft-foreground" title={`${k.path}\n${k.key}`}>
              {k.key}
            </span>
            <Btn
              size="sm"
              variant="ghost"
              onClick={() =>
                void copyText(k.key).then((ok) => {
                  if (ok) {
                    setCopied(k.path);
                    setTimeout(() => setCopied(null), 1500);
                  }
                })
              }
            >
              {copied === k.path ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied === k.path ? "Copied" : "Copy"}
            </Btn>
          </div>
        ))
      )}
      <div className="text-[11px] leading-4 text-subtle-foreground">GitHub allows one repository per deploy key; for several, add the key to a machine user instead.</div>
    </div>
  );
}

/** The plan as a list (mirrors the script's steps). */
function Steps({ plan, owner, user, wild, hooks }: { plan: NewAppPlan; owner: string; user: string; wild: Wildcard | null; hooks: HookOwner[] }) {
  const php = `php${plan.php}`;
  const first = (h: string) => h.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"))?.trim() ?? "";
  const steps: [string, string][] = [
    ["Check the server", `${php}, composer, git${plan.npm ? ", npm" : ""}${plan.db.mode !== "none" ? ", mysql" : ""} are there`],
    ...hooks.filter((o) => o.hooks.before).map((o): [string, string] => [`before hook`, `(${o.who}) ${first(o.hooks.before ?? "")}`]),
    ["Clone", `${plan.repo || "…"}${plan.branch ? ` (${plan.branch})` : ""} → ${plan.path || "…"}`],
  ];
  if (plan.db.mode === "new") steps.push(["Database", `new MySQL user ${plan.db.user} + database ${plan.db.database} (utf8mb4)`]);
  if (plan.db.mode === "existing") steps.push(["Database", `log in as ${plan.db.user} (password typed in the terminal); create/grant ${plan.db.database} if needed`]);
  steps.push([".env", `from .env.example: APP_NAME, APP_ENV=${plan.appEnv}${plan.url ? `, APP_URL=${plan.url}` : ""}${plan.db.mode !== "none" ? ", DB_*" : ""}`]);
  steps.push(["composer install", `with ${php}${plan.appEnv === "production" ? ", --no-dev" : ""}`]);
  if (plan.npm) steps.push(["Front-end", "npm ci && npm run build"]);
  steps.push(["Owner", `chown -R ${owner}; storage/ and bootstrap/cache writable${user !== owner.split(":")[0] ? `; git marks it safe for ${user}` : ""}`]);
  steps.push(["Laravel", `key:generate, storage:link${plan.migrate ? `, migrate${plan.seed ? " --seed" : ""}` : ""} (as ${owner.split(":")[0]})`]);
  if (plan.vhost) steps.push(["nginx", `sites-available/${plan.vhost.name}, nginx -t (removed again if it fails), reload`]);
  if (wild) steps.push(["nginx", `nothing to change: ${wild.file} serves *${wild.suffix}`]);
  if (plan.worker) steps.push(["Queue worker", `${plan.worker.file} × ${plan.worker.processes}, supervisorctl update`]);
  if (plan.schedule) steps.push(["Scheduler", `/etc/cron.d/laravel-${plan.id.replace(/[^A-Za-z0-9_]/g, "-")}: schedule:run every minute`]);
  if (plan.certbot.length) steps.push(["HTTPS", `certbot --nginx -d ${plan.certbot.join(" -d ")} --redirect`]);
  for (const o of hooks.filter((x) => x.hooks.after)) steps.push(["after hook", `(${o.who}) ${first(o.hooks.after ?? "")}`]);
  steps.push(["Kemudi", "adds the app here when the script ends with exit 0"]);
  return (
    <ol className="flex flex-col gap-1.5">
      {steps.map(([t, detail], i) => (
        <li key={t} className="flex gap-2.5 text-[12.5px] leading-[18px]">
          <span className="w-5 flex-none text-right font-mono text-subtle-foreground">{i + 1}</span>
          <span className="w-[110px] flex-none font-medium text-foreground">{t}</span>
          <span className="min-w-0 flex-1 font-mono text-[11.5px] break-words text-soft-foreground">{detail}</span>
        </li>
      ))}
    </ol>
  );
}

/** Run the setup in a terminal tab; when it ends with exit 0, add the app to
 *  Kemudi. */
function runNewApp(server: Server, plan: NewAppPlan, php: string, vhostFiles: string[]) {
  const serverId = server.id;
  let tabId: string | null = null;
  tabId = useTabs.getState().open({
    kind: "action",
    title: `${serverId} · new ${plan.id}`,
    serverId,
    host: server.host,
    appId: null,
    actionId: `newapp:${plan.id}`,
    prod: server.env === "prod",
    state: "running",
    intro: blockIntro(`${serverId} (${server.host}) · New app ${plan.name} · ${localHms()}`, `# set up ${plan.id} in ${plan.path}`),
    spawn: (cols, rows, onData, onEvent) =>
      newappRun(serverId, plan, cols, rows, onData, onEvent).then((info) => {
        if (info.auditId !== null && tabId) useTabs.getState().update(tabId, { auditId: info.auditId });
        return info.ptyId;
      }),
  });
  const unsubscribe = useTabs.subscribe((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return unsubscribe();
    if (tab.state === "ok") {
      unsubscribe();
      void register(server, plan, php, vhostFiles);
    } else if (tab.state === "failed") {
      unsubscribe();
      useToasts.getState().push(`Setting up ${plan.name} stopped: see the tab. Fix it, then run it again (finished steps are skipped).`, "error", {
        label: "Open the form",
        run: () => useNewApp.getState().open(serverId),
      });
    }
  });
}

async function register(server: Server, plan: NewAppPlan, php: string, vhostFiles: string[]) {
  try {
    await appSave(server.id, null, {
      id: plan.id,
      name: plan.name !== plan.id ? plan.name : null,
      path: plan.path,
      branch: plan.branch,
      php,
      color: null,
      env: null,
      repo: plan.repo,
      url: plan.url,
      vhostFiles,
      supervisorFiles: plan.worker ? [plan.worker.file] : [],
    });
    useNewApp.getState().forget(server.id);
    const exists = () => !!findServer(server.id)?.apps.some((a) => a.id === plan.id);
    useToasts.getState().push(`${plan.name} is set up and added to Kemudi.`, "info", {
      label: "Open",
      run: () => exists() && openDetails({ kind: "app", serverId: server.id, appId: plan.id }),
    });
  } catch (e) {
    toastError(`${plan.name} is set up, but adding it to Kemudi failed: ${errorMessage(e)}`);
  }
}

/** A wildcard vhost that already serves this server's app folder, if any;
 *  else a new vhost (when nginx is there). */
function defaultWeb(server: Server, p: NewAppProbe): Pick<NewAppDraft, "web" | "wildcard"> {
  const parent = suggestedParent(server);
  const w = p.wildcards.find((x) => x.root.replace(/\/[^/]+$/, "") === parent);
  if (w) return { web: "wildcard", wildcard: wildKey(w) };
  return { web: p.vhost.nginx ? "new" : "none", wildcard: p.wildcards[0] ? wildKey(p.wildcards[0]) : "" };
}
