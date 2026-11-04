import { Check, Copy, Eye, EyeOff, Pencil, Plus, RotateCw, ScanSearch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { triggerAction } from "@/lib/actions";
import { copyText } from "@/lib/clipboard";
import { getCached, putCached, restoreSecrets, type Cached, type CachedEnvVar } from "@/lib/inspectCache";
import { cronChoices, useFileEditor } from "@/components/manage/FileEditor";
import { useVhostGenerator } from "@/components/manage/VhostGenerator";
import { appInspect, errorMessage, inspectSecretsRetry, openUrl, type Env, type EnvVar } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useServiceMenu } from "@/components/actions/ServiceMenu";
import { RunnerProposal, RunnersDialog, type RunnerKind } from "@/components/manage/RunnersDialog";
import { useConfig } from "@/stores/config";
import { toastError, useToasts } from "@/stores/toasts";

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date().toDateString() === d.toDateString()
    ? time
    : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** A server_name as a real host for this app. Plain names stay; for a
 *  wildcard (`~^(?<app>.+)\.staging\.example\.com$` or `*.staging.example.com`)
 *  the app's folder fills the variable when the root uses it (`…/$app/public`). */
export function hostFor(name: string, root: string | null, path: string): string | null {
  if (/^[a-z0-9.-]+$/i.test(name)) return name;
  const folder = path.replace(/\/+$/, "").split("/").pop() ?? "";
  const rootVar = root?.match(/\$(\w+)/)?.[1];
  if (!folder || !rootVar) return null;
  const regex = name.match(/^~\^?\(\?<(\w+)>[^)]*\)((?:\\\.|[a-z0-9-])+)\$?$/i);
  if (regex && regex[1] === rootVar) return `${folder}${regex[2]!.replace(/\\\./g, ".")}`;
  const star = name.match(/^\*(\.[a-z0-9.-]+)$/i);
  if (star) return `${folder}${star[1]}`;
  return null;
}

/** `KEY=value`, quoted when the value needs it. */
function envLine(e: EnvVar): string {
  return /[\s#"'$]/.test(e.value) || e.value === "" ? `${e.key}="${e.value.replace(/(["\\$])/g, "\\$1")}"` : `${e.key}=${e.value}`;
}

function CopyBtn({ text, label = "Copy", what, disabled }: { text: string; label?: string; what: string; disabled?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <Btn
      size="sm"
      variant="outline"
      disabled={disabled}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          useToasts.getState().push(`Copied ${what}`, "info");
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? <Check className="size-3.5 text-status-up" /> : <Copy className="size-3.5" />} {label}
    </Btn>
  );
}

/** Files Inspect always reads for this app, and a picker of the server's
 *  config files (saved with the app). */
function Pins({
  files,
  candidates,
  missing,
  onChange,
  what,
}: {
  files: string[];
  candidates: string[];
  missing: string[];
  onChange: (files: string[]) => void;
  what: string;
}) {
  const options = candidates.filter((c) => !files.includes(c));
  return (
    <div className="flex flex-col gap-1.5 border-t border-divider pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11.5px] text-muted-foreground">Pinned:</span>
        {files.length === 0 && <span className="text-[11.5px] text-subtle-foreground">none</span>}
        {files.map((f) => (
          <span
            key={f}
            className={cn(
              "flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px]",
              missing.includes(f) ? "border-env-prod/50 text-env-prod-fg" : "border-control-border",
            )}
            title={missing.includes(f) ? "Couldn't read this file on the server" : f}
          >
            {f}
            <button aria-label={`Unpin ${f}`} className="cursor-pointer text-subtle-foreground hover:text-foreground" onClick={() => onChange(files.filter((x) => x !== f))}>
              ×
            </button>
          </span>
        ))}
        {options.length > 0 && (
          <select
            value=""
            onChange={(e) => e.target.value && onChange([...files, e.target.value])}
            className="h-6 max-w-[260px] cursor-pointer rounded-md border border-control-border bg-background px-1.5 font-mono text-[11px] outline-none"
          >
            <option value="">+ Pin a {what} file…</option>
            {options.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="text-[11px] text-subtle-foreground">Pinned files are always read, even if they don't name this path. Save to keep, then Inspect again.</div>
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-divider bg-panel px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

/** `tall`: on a section of its own (an app tab's), down to the window's bottom. */
function ConfigBlock({ file, config, onEdit, tall }: { file: string; config: string; onEdit?: () => void; tall?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={file}>
          {file}
        </span>
        <Btn size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide config" : "Show config"}
        </Btn>
        <CopyBtn text={config} label="Copy config" what={file} />
        {onEdit && (
          <Btn size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="size-3.5" /> Edit
          </Btn>
        )}
      </div>
      {open && (
        <pre className={cn("selectable overflow-auto", tall ? "max-h-[max(320px,calc(100vh-300px))]" : "max-h-[320px]", " rounded-lg border border-divider bg-background p-3 font-mono text-[11.5px] leading-[17px] whitespace-pre text-foreground")}>
          {config}
        </pre>
      )}
    </div>
  );
}

/** "Inspect" on an app's page: what the server says about its folder.
 *  Read-only, except the .env editor (Edit) and the restart buttons. */
export function InspectPanel({
  serverId,
  appId,
  path,
  prod,
  env,
  serverEnv,
  appName,
  branch,
  php,
  onUseBranch,
  onUsePhp,
  vhostFiles,
  supervisorFiles,
  onVhostFiles,
  onSupervisorFiles,
  only,
  onGo,
}: {
  serverId: string;
  /** The saved app (for Restart's tab and History); null while adding. */
  appId: string | null;
  path: string;
  prod: boolean;
  /** The app's environment (.env, cron). */
  env: Env;
  /** The server's (vhosts, Supervisor: they affect every app on it). */
  serverEnv: Env;
  appName: string;
  branch: string;
  php: string;
  onUseBranch: (b: string) => void;
  onUsePhp: (v: string) => void;
  vhostFiles: string[];
  supervisorFiles: string[];
  onVhostFiles: (f: string[]) => void;
  onSupervisorFiles: (f: string[]) => void;
  /** Just one part (an app tab's section); "overview": Code and a line for
   *  each of the others. Default: all of them. */
  only?: InspectPart;
  /** The overview's lines open their section. */
  onGo?: (part: Exclude<InspectPart, "overview">) => void;
}) {
  // A part on its own (an app tab's section) gets the window's height.
  const tall = !!only && only !== "overview";
  const show = (p: Exclude<InspectPart, "overview">) => !only || only === p || (only === "overview" && p === "code");
  const [cached, setCached] = useState<Cached | null>(() => getCached(serverId, path));
  const programMenu = useServiceMenu(serverId, appId);
  const ins = cached?.ins ?? null;
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  // Keep "2m ago" fresh.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  // Show what's cached for this path, if anything, with its secrets
  // decrypted from the encrypted store.
  useEffect(() => {
    const c = getCached(serverId, path);
    setCached(c);
    setSecretsError(null);
    if (!c) return;
    let live = true;
    restoreSecrets(serverId, path, c).then(
      (r) => live && setCached(r),
      (e: unknown) => live && setSecretsError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [serverId, path]);

  const [runner, setRunner] = useState<RunnerKind | null>(null);
  const serverName = useConfig((st) => st.snapshot?.config?.servers.find((x) => x.id === serverId)?.name) ?? serverId;
  const run = async () => {
    setBusy(true);
    try {
      const fresh = await appInspect(serverId, path, vhostFiles, supervisorFiles);
      setCached(putCached(serverId, path, fresh));
      setSecretsError(fresh.secretCacheError);
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const newVhost = () =>
    useVhostGenerator.getState().open({
      serverId,
      env: serverEnv,
      appId,
      appName,
      path,
      php: php.trim() || phpFromVhost || null,
      onCreated: () => void run(),
    });

  // Keychain refused earlier: ask again. Restores cached secrets, or (after
  // a fresh Inspect couldn't save them) inspects again so they're saved.
  const retrySecrets = async () => {
    setSecretsError(null);
    await inspectSecretsRetry();
    const redacted = (cached?.ins.env as CachedEnvVar[] | null)?.some((e) => e.redacted);
    if (cached && redacted) {
      restoreSecrets(serverId, path, cached).then(setCached, (e: unknown) => setSecretsError(errorMessage(e)));
    } else {
      await run();
    }
  };

  const phpFromVhost = ins?.vhosts.map((v) => v.phpVersion).find(Boolean) ?? null;
  const supervisorFileList = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of ins?.programs ?? []) if (!m.has(p.file)) m.set(p.file, p.config);
    return [...m.entries()];
  }, [ins]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">On the server</span>
        {cached && (
          <span className="text-[11.5px] text-subtle-foreground" title={new Date(cached.at).toLocaleString()}>
            Inspected {ago(cached.at)} · {stamp(cached.at)}
          </span>
        )}
        <Btn variant="outline" disabled={busy || !path.trim()} onClick={() => void run()} title={`Read-only look at ${path} on ${serverId}`}>
          <ScanSearch className="size-4" /> {busy ? "Inspecting…" : ins ? "Inspect again" : "Inspect"}
        </Btn>
      </div>
      {!ins && !busy && (
        <div className="text-[12px] leading-5 text-subtle-foreground">
          Finds the Nginx/Apache vhost and Supervisor programs that use this folder, its .env, git branch, Laravel
          version and cron lines. Read-only; nothing is saved.
        </div>
      )}
      {ins && (ins.denied?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-env-staging/40 bg-env-staging/8 px-3 py-2 text-[12px] leading-[18px] text-muted-foreground">
          <span className="font-medium text-env-staging-fg">
            {ins.denied!.length} config file{ins.denied!.length === 1 ? " is" : "s are"} root-only
          </span>{" "}
          and Kemudi has no working sudo on {serverId}
          {ins.sudo === "badpw"
            ? ": the saved sudo password was refused."
            : ins.sudo === "none"
              ? ": this login user isn't allowed sudo."
              : ": sudo asks for a password. Save it on the server's page (sudo password), or allow passwordless sudo (or just /bin/su) for this user, then Inspect again."}
          <div className="selectable mt-1 truncate font-mono text-[11px] text-subtle-foreground" title={ins.denied!.join("\n")}>
            {ins.denied!.slice(0, 4).join("  ")}
            {ins.denied!.length > 4 ? `  +${ins.denied!.length - 4} more` : ""}
          </div>
        </div>
      )}
      {ins && (
        <>
          {only === "overview" && <Summary ins={ins} path={path} onGo={onGo} />}
          {show("code") && <Section title="Code">
            <div className="flex flex-col gap-1 text-[12.5px]">
              <div className="flex items-center gap-2">
                <span className="w-[72px] text-muted-foreground">Branch</span>
                <span className="font-mono">{ins.branch ?? "—"}</span>
                {ins.branch && ins.branch !== branch.trim() && (
                  <Btn size="sm" variant="ghost" className="text-primary" onClick={() => onUseBranch(ins.branch!)}>
                    Use as branch
                  </Btn>
                )}
              </div>
              {ins.lastCommit && (
                <div className="flex gap-2">
                  <span className="w-[72px] flex-none text-muted-foreground">Last commit</span>
                  <span className="selectable min-w-0 truncate font-mono text-[12px]" title={ins.lastCommit}>
                    {ins.lastCommit}
                  </span>
                </div>
              )}
              <div className="flex gap-2">
                <span className="w-[72px] flex-none text-muted-foreground">Laravel</span>
                <span>{ins.laravel ?? "—"}</span>
              </div>
            </div>
          </Section>}

          {show("web") && <Section
            title={`Web server${ins.vhosts.length ? ` · ${ins.vhosts.length}` : ""}`}
            right={
              <>
                {phpFromVhost && phpFromVhost !== php.trim() && (
                  <Btn size="sm" variant="ghost" className="text-primary" onClick={() => onUsePhp(phpFromVhost)}>
                    Use PHP {phpFromVhost}
                  </Btn>
                )}
                <Btn size="sm" variant={ins.vhosts.length ? "outline" : "primary"} onClick={newVhost} title="Create an nginx vhost for this app">
                  <Plus className="size-3.5" /> New vhost
                </Btn>
              </>
            }
          >
            {ins.vhosts.length === 0 && (
              <div className="text-[12px] text-subtle-foreground">
                No Nginx or Apache config mentions {path}. Create one with New vhost, or if a wildcard or shared vhost serves it, pin that file below.
              </div>
            )}
            {[...new Set(ins.vhosts.map((v) => v.kind))].map((kind) => {
              const name = kind === "nginx" ? "nginx" : "Apache";
              const run = (verb: "reload" | "restart") =>
                void triggerAction({ serverId, appId, actionId: `web-${verb}:${kind}` });
              const why = appId ? undefined : "Save the app first";
              return (
                <div key={kind} className="flex flex-wrap items-center gap-2">
                  <Btn
                    size="sm"
                    variant="outline"
                    disabled={!appId}
                    title={why ?? `Checks the config (${kind === "nginx" ? "nginx -t" : "apachectl configtest"}), then reloads ${name} without dropping connections. Asks first; runs in a tab.`}
                    onClick={() => run("reload")}
                  >
                    <RotateCw className="size-3.5" /> Test & reload {name}
                  </Btn>
                  <Btn
                    size="sm"
                    variant="outline"
                    disabled={!appId}
                    title={why ?? `Checks the config, then fully restarts ${name} (drops open connections). Asks first; runs in a tab.`}
                    onClick={() => run("restart")}
                  >
                    Restart {name}
                  </Btn>
                </div>
              );
            })}
            {ins.vhosts.map((v) => (
              <div key={v.file} className="flex flex-col gap-1.5 border-t border-divider pt-2 first:border-t-0 first:pt-0">
                <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                  <span className="rounded-[4px] bg-hover-strong px-1.5 text-[10.5px] uppercase">{v.kind}</span>
                  {v.serverNames.map((n) => {
                    const host = hostFor(n, v.root, path);
                    return host ? (
                      <button
                        key={n}
                        className="cursor-pointer font-mono text-primary hover:underline"
                        title={host === n ? `Open ${v.ssl ? "https" : "http"}://${host}` : `${n} → ${host}`}
                        onClick={() => void openUrl(`${v.ssl ? "https" : "http"}://${host}`).catch((e) => toastError(errorMessage(e)))}
                      >
                        {host} ↗
                      </button>
                    ) : (
                      <span key={n} className="selectable font-mono text-muted-foreground" title="A pattern, not a single host">
                        {n}
                      </span>
                    );
                  })}
                  {v.ssl && <span className="text-[11px] text-status-up">HTTPS</span>}
                  {v.wildcard && (
                    <span className="rounded-[4px] bg-primary/10 px-1.5 text-[10.5px] text-primary" title="Its root uses a variable: one vhost for many apps">
                      wildcard
                    </span>
                  )}
                  {vhostFiles.includes(v.file) && <span className="text-[10.5px] text-subtle-foreground">pinned</span>}
                </div>
                <div className="text-[11.5px] text-subtle-foreground">
                  {v.root && <>root {v.root} · </>}
                  {v.listens.length > 0 && <>listen {v.listens.join(", ")}</>}
                  {v.phpSocket && <> · PHP {v.phpVersion ?? "?"} ({v.phpSocket})</>}
                </div>
                <ConfigBlock
                  tall={tall}
                  file={v.file}
                  config={v.config}
                  onEdit={() =>
                    useFileEditor.getState().open({
                      serverId,
                      env: serverEnv,
                      appId,
                      title: `Edit vhost · ${v.file.split("/").pop()}`,
                      choices: [{ label: v.file, target: { kind: "vhost", file: v.file, web: v.kind } }],
                      note: v.wildcard
                        ? "A wildcard vhost: it serves every app that matches it, not just this one."
                        : undefined,
                      onSaved: () => void run(),
                    })
                  }
                />
              </div>
            ))}
            <Pins files={vhostFiles} candidates={ins.vhostCandidates ?? []} missing={ins.missing ?? []} onChange={onVhostFiles} what="vhost" />
          </Section>}

          {programMenu.node}
          {runner && appId && (
            <RunnersDialog
              serverId={serverId}
              serverName={serverName}
              appId={appId}
              appName={appName}
              prod={prod}
              kind={runner}
              onClose={() => setRunner(null)}
              onAdded={() => void run()}
            />
          )}
          {show("supervisor") && <Section title={`Supervisor${ins.programs.length ? ` · ${ins.programs.length}` : ""}`}>
            {ins.programs.length === 0 && (
              <div className="text-[12px] text-subtle-foreground">No Supervisor program mentions {path}. Pin its file below if it uses another path.</div>
            )}
            {ins.programs.length === 0 && appId && <RunnerProposal kind="worker" onAdd={() => setRunner("worker")} />}
            {ins.programs.map((p) => (
              <div key={`${p.file}:${p.name}`} className="flex flex-col gap-1 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="cursor-pointer rounded font-mono font-medium hover:underline"
                    title="Status / Start / Stop / Restart"
                    onClick={(e) => programMenu.open(e, "supervisor", p.name)}
                  >
                    {p.name} ▾
                  </button>
                  {p.numprocs && <span className="text-[11px] text-subtle-foreground">×{p.numprocs}</span>}
                  {p.user && <span className="text-[11px] text-subtle-foreground">as {p.user}</span>}
                  {p.status.length === 0 && <span className="text-[11px] text-subtle-foreground">status unknown</span>}
                  <span className="flex-1" />
                  <Btn
                    size="sm"
                    variant="outline"
                    disabled={!appId}
                    title={
                      appId
                        ? `sudo supervisorctl restart '${p.name}:*' in a new tab (asks first; recorded in History)`
                        : "Save the app first"
                    }
                    onClick={() => void triggerAction({ serverId, appId, actionId: `supervisor-restart:${p.name}` })}
                  >
                    <RotateCw className="size-3.5" /> Restart
                  </Btn>
                  {[...new Set(p.status.map((st) => st.split(" ")[0]))].map((st) => (
                    <span
                      key={st}
                      className={cn(
                        "rounded-[4px] px-1.5 text-[10.5px] font-semibold",
                        st === "RUNNING" ? "bg-status-up/15 text-status-up" : "bg-env-prod/15 text-env-prod-fg",
                      )}
                    >
                      {st}
                      {p.status.length > 1 ? ` ${p.status.filter((x) => x.startsWith(st!)).length}/${p.status.length}` : ""}
                    </span>
                  ))}
                </div>
                {p.command && (
                  <div className="selectable truncate font-mono text-[11.5px] text-muted-foreground" title={p.command}>
                    {p.command}
                  </div>
                )}
              </div>
            ))}
            {supervisorFileList.map(([file, config]) => (
              <ConfigBlock
                tall={tall}
                key={file}
                file={file}
                config={config}
                onEdit={() =>
                  useFileEditor.getState().open({
                    serverId,
                    env: serverEnv,
                    appId,
                    title: `Edit Supervisor · ${file.split("/").pop()}`,
                    choices: [{ label: file, target: { kind: "supervisor", file } }],
                    onSaved: () => void run(),
                  })
                }
              />
            ))}
            <Pins
              files={supervisorFiles}
              candidates={ins.supervisorCandidates ?? []}
              missing={ins.missing ?? []}
              onChange={onSupervisorFiles}
              what="Supervisor"
            />
          </Section>}

          {show("cron") && <Section
            title={`Cron${ins.cron.length ? ` · ${ins.cron.length}` : ""}`}
            right={
              <>
                <Btn
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    useFileEditor.getState().open({
                      serverId,
                      env,
                      appId,
                      title: "Edit cron",
                      choices: cronChoices(ins.cronSources ?? []),
                      onSaved: () => void run(),
                    })
                  }
                >
                  <Pencil className="size-3.5" /> {ins.cron.length ? "Edit" : "Add"}
                </Btn>
                {ins.cron.length > 0 && <CopyBtn text={ins.cron.join("\n")} what="cron lines" />}
              </>
            }
          >
            {ins.cron.length === 0 && <div className="text-[12px] text-subtle-foreground">No cron line mentions {path}.</div>}
            {appId && !ins.cron.some((c) => c.includes("schedule:run") || c.includes("schedule:work")) && <RunnerProposal kind="cron" onAdd={() => setRunner("cron")} />}
            {ins.cron.map((c) => (
              <div key={c} className="selectable truncate font-mono text-[11.5px]" title={c}>
                {c}
              </div>
            ))}
          </Section>}

          {show("env") && <EnvSection
            tall={tall}
            env={ins.env}
            error={ins.envError}
            secretsError={secretsError}
            onRetrySecrets={() => void retrySecrets()}
            onEdit={
              appId
                ? () =>
                    useFileEditor.getState().open({
                      serverId,
                      env,
                      appId,
                      title: `Edit .env · ${appName}`,
                      choices: [{ label: ".env", target: { kind: "env", appId } }],
                      onSaved: () => void run(),
                    })
                : undefined
            }
            prod={prod}
            path={path}
          />}
        </>
      )}
    </div>
  );
}

export type InspectPart = "overview" | "code" | "web" | "supervisor" | "cron" | "env";

/** An app tab's Overview: one line for each part, opening its section. */
function Summary({ ins, path, onGo }: { ins: Cached["ins"]; path: string; onGo?: (part: Exclude<InspectPart, "overview">) => void }) {
  const states = ins.programs.flatMap((p) => p.status.map((st) => st.split(" ")[0] ?? ""));
  const down = states.filter((st) => st !== "RUNNING").length;
  const vars = ins.env?.length ?? 0;
  const lines: { part: Exclude<InspectPart, "overview">; label: string; text: React.ReactNode }[] = [
    {
      part: "web",
      label: "Web server",
      text: ins.vhosts.length ? (
        <span className="truncate font-mono">{[...new Set(ins.vhosts.flatMap((v) => v.serverNames))].join(" ") || ins.vhosts.map((v) => v.file).join(" ")}</span>
      ) : (
        <span className="text-env-staging-fg">no vhost mentions {path}</span>
      ),
    },
    {
      part: "supervisor",
      label: "Supervisor",
      text: ins.programs.length === 0 ? (
        <span className="text-subtle-foreground">no worker</span>
      ) : down ? (
        <span className="text-env-prod-fg">{down} of {states.length} not running</span>
      ) : (
        <span className="text-status-up">{ins.programs.map((p) => p.name).join(", ")} running</span>
      ),
    },
    { part: "cron", label: "Cron", text: <span className="text-subtle-foreground">{ins.cron.length ? `${ins.cron.length} line${ins.cron.length === 1 ? "" : "s"}` : "no cron line"}</span> },
    {
      part: "env",
      label: ".env",
      text: ins.envError ? <span className="text-env-prod-fg">{ins.envError}</span> : <span className="text-subtle-foreground">{ins.env ? `${vars} variables` : "none"}</span>,
    },
  ];
  return (
    <Section title="Summary">
      <div className="flex flex-col text-[12.5px]">
        {lines.map((l) => (
          <button
            key={l.part}
            type="button"
            onClick={() => onGo?.(l.part)}
            className="-mx-2 flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-hover"
          >
            <span className="w-[88px] flex-none text-muted-foreground">{l.label}</span>
            <span className="flex min-w-0 flex-1 truncate">{l.text}</span>
            <span className="text-[11.5px] text-primary">Open</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

function EnvSection({
  env,
  error,
  secretsError,
  onRetrySecrets,
  onEdit,
  prod,
  path,
  tall,
}: {
  /** On a section of its own: the list goes down to the window's bottom. */
  tall?: boolean;
  env: CachedEnvVar[] | null;
  error: string | null;
  /** The encrypted secret store couldn't be read or written. */
  secretsError: string | null;
  onRetrySecrets: () => void;
  /** Open the .env editor (null until the app is saved). */
  onEdit?: () => void;
  prod: boolean;
  path: string;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  if (!env) {
    return (
      <Section title=".env">
        <div className="text-[12px] text-subtle-foreground">{error ?? "Not read."}</div>
      </Section>
    );
  }
  const list = env.filter((e) => !filter || e.key.toLowerCase().includes(filter.toLowerCase()));
  const val = (k: string) => env.find((e) => e.key === k)?.value;
  const warnings: { level: "warn" | "bad"; text: string }[] = [];
  if (prod && /^(true|1)$/i.test(val("APP_DEBUG") ?? "")) warnings.push({ level: "bad", text: "APP_DEBUG is true on a production server" });
  if (prod && val("APP_ENV") && val("APP_ENV") !== "production") warnings.push({ level: "warn", text: `APP_ENV is "${val("APP_ENV")}" on a production server` });
  // From the on-disk cache, and not in the encrypted store (or it couldn't
  // be read): Inspect again.
  const redacted = env.filter((e) => e.redacted).length;
  const copyable = env.filter((e) => !e.redacted);
  const selected = copyable.filter((e) => picked.has(e.key));
  const toggle = (set: Set<string>, k: string) => {
    const n = new Set(set);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    return n;
  };
  const allPicked = list.length > 0 && list.every((e) => picked.has(e.key));

  return (
    <Section
      title={`.env · ${env.length}`}
      right={
        <>
          <Btn size="sm" variant="outline" disabled={!onEdit} onClick={onEdit} title={onEdit ? "Edit this .env on the server" : "Save the app first"}>
            <Pencil className="size-3.5" /> Edit
          </Btn>
          <CopyBtn
            text={selected.map(envLine).join("\n")}
            label={`Copy selected${selected.length ? ` (${selected.length})` : ""}`}
            what={`${selected.length} .env ${selected.length === 1 ? "entry" : "entries"}`}
            disabled={selected.length === 0}
          />
          <CopyBtn
            text={copyable.map(envLine).join("\n")}
            label="Copy all"
            what={redacted ? `${copyable.length} entries (secrets need Inspect again)` : `all of ${path}/.env`}
          />
        </>
      }
    >
      {redacted > 0 && (
        <div className="rounded-lg bg-hover px-3 py-1.5 text-[12px] text-muted-foreground">
          {redacted} secret value{redacted === 1 ? "" : "s"} couldn't be restored: Inspect again to read or copy{" "}
          {redacted === 1 ? "it" : "them"}.
        </div>
      )}
      {secretsError && (
        <div className="flex items-start gap-3 rounded-lg bg-env-staging/12 px-3 py-2 text-[12px] leading-[17px] text-env-staging-fg">
          <span className="flex-1">{secretsError}</span>
          <Btn size="sm" variant="outline" onClick={onRetrySecrets}>
            Try again
          </Btn>
        </div>
      )}
      {warnings.map((w) => (
        <div
          key={w.text}
          className={cn(
            "rounded-lg px-3 py-1.5 text-[12px]",
            w.level === "bad" ? "bg-env-prod/12 text-env-prod-fg" : "bg-env-staging/12 text-env-staging-fg",
          )}
        >
          ⚠ {w.text}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Select all shown"
          checked={allPicked}
          onChange={() =>
            setPicked((s) => {
              const n = new Set(s);
              for (const e of list) {
                if (allPicked) n.delete(e.key);
                else n.add(e.key);
              }
              return n;
            })
          }
        />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter keys (e.g. DB_, MAIL)"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 font-mono text-[12px] outline-none focus:border-primary/60"
        />
      </div>
      <div className={cn("flex flex-col overflow-y-auto rounded-lg border border-divider bg-background", tall ? "max-h-[max(360px,calc(100vh-290px))]" : "max-h-[360px]")}>
        {list.map((e) => {
          const hidden = e.redacted || (e.secret && !shown.has(e.key));
          return (
            <div key={e.key} className="group/env flex items-center gap-2 border-b border-divider px-2 py-1 last:border-b-0 hover:bg-hover">
              <input
                type="checkbox"
                aria-label={`Select ${e.key}`}
                checked={picked.has(e.key)}
                onChange={() => setPicked((s) => toggle(s, e.key))}
              />
              <span className="w-[42%] flex-none truncate font-mono text-[12px]" title={e.key}>
                {e.key}
              </span>
              <span
                className={cn("selectable min-w-0 flex-1 truncate font-mono text-[12px]", hidden ? "text-faint-foreground" : "text-foreground")}
                title={hidden ? "Hidden (looks like a secret); click the eye to show" : e.value}
              >
                {e.redacted ? "Inspect again to read" : hidden ? "••••••••" : e.value || <span className="text-faint-foreground">(empty)</span>}
              </span>
              {e.secret && !e.redacted && (
                <button
                  title={hidden ? "Show" : "Hide"}
                  aria-label={hidden ? `Show ${e.key}` : `Hide ${e.key}`}
                  onClick={() => setShown((s) => toggle(s, e.key))}
                  className="flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
                >
                  {hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                </button>
              )}
              <button
                disabled={e.redacted}
                title={`Copy ${e.key}=…`}
                aria-label={`Copy ${e.key}`}
                onClick={async () => {
                  if (await copyText(envLine(e))) useToasts.getState().push(`Copied ${e.key}`, "info");
                }}
                className="flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-subtle-foreground opacity-0 group-hover/env:opacity-100 hover:bg-hover-strong hover:text-foreground"
              >
                <Copy className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="text-[11px] text-subtle-foreground">Kept on this Mac with the last Inspect. Secret values (keys, passwords, tokens) are encrypted; the key is in your Keychain as “Kemudi Devops cache key”.</div>
    </Section>
  );
}
