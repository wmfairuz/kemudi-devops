import { Copy, Eye, EyeOff, KeyRound, RotateCw, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, TextInput } from "@/components/manage/fields";
import { Spinner } from "@/components/kit/Spinner";
import { dashboardRuns, errorMessage, type App, type AppSwitches, type BasicLogin, type LoginFile, type Runs, type Server } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { authOn, bypassUrl, changeLogin, dashBusy, ensureDash, goDown, loadDash, stoppedOf, toggleAuth, toggleLive, useDash } from "@/stores/dash";
import { useToasts } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";

/** A random password from the system's crypto source. */
function generate(length = 20): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

const OWN_DIR = "/etc/nginx/kemudi-auth/";

/** "team" or "team, qa" for a login file. */
const usersOf = (logins: LoginFile[], path: string | null) => (path ? (logins.find((l) => l.path === path)?.users ?? []).join(", ") : "");

/** On/off, like a settings switch. */
function Switch({ on, busy, disabled, onClick, label }: { on: boolean; busy?: boolean; disabled?: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "relative h-5 w-9 flex-none cursor-pointer rounded-full transition-colors disabled:cursor-default disabled:opacity-50",
        on ? "bg-primary" : "bg-control-border",
        busy && "animate-pulse",
      )}
    >
      <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

/** What the switches need for one app (null: not read yet, or not there). */
function useSwitches(server: Server, app: App) {
  const entry = useDash((s) => s.servers[server.id]);
  const busy = useDash((s) => dashBusy(s, server.id, app.id));
  const s = entry?.data?.apps.find((a) => a.appId === app.id) ?? null;
  return { entry, busy, s, data: entry?.data ?? null };
}

const authOnOf = (s: AppSwitches) => s.auth.state === "on" || s.auth.state === "partial";
/** The basic auth switch can't be used: why (null: it can). */
function authFixed(s: AppSwitches, nginx: boolean, app: App): string | null {
  const a = s.auth;
  if (!nginx) return "No nginx on this server";
  if (a.state === "novhost") return `No nginx server block with its root at ${app.path.replace(/\/+$/, "")}/public`;
  if (a.state === "manual" || a.state === "nourl") return a.notes[0] ?? "Set in its vhost by hand";
  return null;
}

/** On an app card (Apps section): Live / Maintenance and Basic auth, each a
 *  switch with a word; the details are in the app's Overview. */
export function AppSwitchesCompact({ server, app }: { server: Server; app: App }) {
  const { entry, busy, s, data } = useSwitches(server, app);
  if (!s || !data) return <span className="text-[11.5px] text-faint-foreground">{entry?.loading ? "Reading…" : entry?.error ? "Couldn't read" : "–"}</span>;
  const fixed = authFixed(s, data.nginx, app);
  const on = authOnOf(s);
  const stopped = s.down ? stoppedOf(server.id, app.id) : [];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]" onClick={(e) => e.stopPropagation()}>
      {s.laravel ? (
        <span className="flex items-center gap-2" title={s.down && stopped.length ? `Workers stopped: ${stopped.join(", ")}` : undefined}>
          <Switch on={!s.down} busy={busy === "laravel"} label={s.down ? `${app.name}: bring it back up` : `${app.name}: put it in maintenance mode`} onClick={() => toggleLive(server, app, s.down)} />
          <span className={s.down ? "text-[#8a5a12]" : "text-[#17702a]"}>{busy === "laravel" ? "…" : s.down ? "Maintenance" : "Live"}</span>
        </span>
      ) : (
        <span className="text-subtle-foreground" title={`No artisan in ${app.path}`}>
          Not Laravel
        </span>
      )}
      {fixed ? (
        <span className="truncate text-subtle-foreground" title={fixed}>
          Basic auth: by hand
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-2" title={[s.auth.via, ...s.auth.notes].filter(Boolean).join("\n") || undefined}>
          <Switch on={on} busy={busy === "auth"} label={on ? `${app.name}: turn basic auth off` : `${app.name}: turn basic auth on`} onClick={() => toggleAuth(server, app, on)} />
          <span className={cn("truncate", s.auth.state === "partial" ? "text-[#8a5a12]" : on ? "text-foreground" : "text-subtle-foreground")}>
            {busy === "auth" ? "…" : s.auth.state === "partial" ? "Auth: some blocks" : on ? `Auth${usersOf(data.logins, s.auth.file) ? `: ${usersOf(data.logins, s.auth.file)}` : " on"}` : "Auth off"}
          </span>
        </span>
      )}
    </div>
  );
}

/** An app's Overview: maintenance mode and basic auth with their details
 *  (bypass link, stopped workers, which vhost, notes). */
export function AppSwitchesFull({ server, app }: { server: Server; app: App }) {
  const { entry, busy, s, data } = useSwitches(server, app);
  useEffect(() => ensureDash(server.id), [server.id]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">Maintenance and basic auth</span>
        {entry?.at && <span className="text-[11.5px] text-subtle-foreground">read {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
        <Btn size="sm" variant="outline" disabled={entry?.loading} onClick={() => void loadDash(server.id)} title={`Read ${server.name} again (read-only)`}>
          <RotateCw className={cn("size-3.5", entry?.loading && "animate-spin")} /> Read again
        </Btn>
      </div>
      {entry?.error && <div className="text-[12.5px] text-env-prod-fg">{entry.error}</div>}
      {!s && entry?.loading && <div className="text-[12.5px] text-subtle-foreground">Reading {server.name} (read-only)…</div>}
      {s && data && (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-divider bg-panel px-4 py-3">
          <LiveBlock server={server} app={app} s={s} busy={busy} />
          <AuthBlock server={server} app={app} s={s} nginx={data.nginx} logins={data.logins} busy={busy} />
        </div>
      )}
      {data && <ServerNotes server={server} compact />}
    </div>
  );
}

function LiveBlock({ server, app, s, busy }: { server: Server; app: App; s: AppSwitches; busy: "laravel" | "auth" | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">Laravel</span>
      {s.laravel ? (
        <>
          <div className="flex items-center gap-2.5">
            <Switch on={!s.down} busy={busy === "laravel"} label={`${app.name} live`} onClick={() => toggleLive(server, app, s.down)} />
            <span className={cn("text-[12.5px]", s.down ? "text-[#8a5a12]" : "text-[#17702a]")}>{busy === "laravel" ? "…" : s.down ? "Maintenance mode" : "Live"}</span>
          </div>
          {s.down && stoppedOf(server.id, app.id).length > 0 && (
            <span className="text-[11.5px] text-subtle-foreground">Workers stopped: {stoppedOf(server.id, app.id).join(", ")} (they start again when it goes live)</span>
          )}
          {s.down && s.secret && (
            <div className="flex items-center gap-1.5 text-[11.5px] text-subtle-foreground">
              <span className="truncate">Bypass: /{s.secret}</span>
              {app.url && (
                <button
                  className="cursor-pointer rounded p-0.5 hover:bg-hover-strong hover:text-foreground"
                  title="Copy the bypass link (opening it lets you past maintenance mode, in that browser)"
                  onClick={() => void navigator.clipboard.writeText(bypassUrl(app, s.secret!)).then(() => useToasts.getState().push("Bypass link copied", "info"))}
                >
                  <Copy className="size-3" />
                </button>
              )}
            </div>
          )}
          <span className="text-[11px] leading-4 text-subtle-foreground">
            <span className="font-mono">artisan down</span> / <span className="font-mono">up</span>, as the owner of its storage folder; down shows what keeps running first.
          </span>
        </>
      ) : (
        <span className="text-[12px] text-subtle-foreground">Not Laravel (no artisan in {app.path})</span>
      )}
    </div>
  );
}

function AuthBlock({ server, app, s, nginx, logins, busy }: { server: Server; app: App; s: AppSwitches; nginx: boolean; logins: LoginFile[]; busy: "laravel" | "auth" | undefined }) {
  const a = s.auth;
  const on = authOnOf(s);
  const fixed = authFixed(s, nginx, app);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">Basic auth</span>
      {fixed ? (
        <span className="text-[12px] text-subtle-foreground">{fixed}</span>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <Switch on={on} busy={busy === "auth"} label={`${app.name} basic auth`} onClick={() => toggleAuth(server, app, on)} />
            <span className="min-w-0 truncate text-[12.5px]" title={on && a.file ? a.file : undefined}>
              {busy === "auth" ? (
                "…"
              ) : a.state === "on" ? (
                <>
                  On
                  {a.file && (
                    <span className="text-subtle-foreground">
                      {" "}
                      · {usersOf(logins, a.file) ? <span className="font-mono text-foreground">{usersOf(logins, a.file)}</span> : <span className="font-mono">{a.file}</span>}
                    </span>
                  )}
                </>
              ) : a.state === "partial" ? (
                <span className="text-[#8a5a12]">On for some of its server blocks</span>
              ) : (
                <span className="text-subtle-foreground">Off</span>
              )}
            </span>
            {on && busy !== "auth" && !a.fixedFile && (
              <button className="flex-none cursor-pointer text-[11.5px] text-primary hover:underline" onClick={() => changeLogin(server, app)}>
                Change login…
              </button>
            )}
          </div>
          <span className="truncate text-[11px] text-subtle-foreground" title={a.files.join("\n")}>
            {a.via ?? a.files.map((f) => f.split("/").pop()).join(", ")}
            {a.mode === "kemudi" && a.shared && " · shared vhost, per app"}
          </span>
          {a.notes.map((n) => (
            <span key={n} className="text-[11px] leading-4 text-[#8a5a12]">
              {n}
            </span>
          ))}
        </>
      )}
    </div>
  );
}

/** What applies to the whole server: when it was read, the default login,
 *  sudo for nginx, notes about its vhosts (e.g. a map in two files). The
 *  Apps section reads it when it opens. */
export function ServerNotes({ server, compact }: { server: Server; compact?: boolean }) {
  const entry = useDash((s) => s.servers[server.id]);
  const data = entry?.data;
  const needsRoot = data && !["root", "ok"].includes(data.sudo);
  return (
    <div className="flex flex-col gap-2">
      {!compact && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-subtle-foreground">
          <span>
            Maintenance mode and basic auth:{" "}
            {entry?.loading ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size={10} /> reading (read-only)…
              </span>
            ) : entry?.at ? (
              `read ${new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            ) : (
              "not read yet"
            )}
          </span>
          <button className="cursor-pointer rounded-full px-1.5 text-primary hover:bg-primary/10 disabled:opacity-50" disabled={entry?.loading} onClick={() => void loadDash(server.id)}>
            Read again
          </button>
          <span className="flex-1" />
          <button
            className="flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-0.5 text-muted-foreground hover:bg-hover-strong hover:text-foreground"
            onClick={() => useDash.setState({ editDefault: server.id })}
            title="The login basic auth's Turn on uses unless you give one (kept in Passwords)"
          >
            <KeyRound className="size-3.5" />
            {data?.defaultUser ? (
              <>
                Default login: <span className="font-mono text-foreground">{data.defaultUser}</span>
              </>
            ) : (
              "Set a default login…"
            )}
          </button>
        </div>
      )}
      {!compact && entry?.error && <div className="text-[12px] text-env-prod-fg">Couldn't read maintenance mode and basic auth: {entry.error}</div>}
      {needsRoot && (
        <div className="flex items-center gap-3 rounded-lg border border-env-staging/40 bg-env-staging-tint px-3 py-2 text-[12px]">
          <span className="flex-1">
            {data.sudo === "none"
              ? "This ssh user can't use sudo here, so basic auth can't be changed (nginx is root's)."
              : data.sudo === "badpw"
                ? "sudo refused the saved password for this server."
                : "Basic auth changes nginx, which needs root: save this server's sudo password in Passwords."}
          </span>
          {data.sudo !== "none" && (
            <Btn size="sm" variant="outline" onClick={() => useUi.getState().setOverlay("passwords")}>
              Passwords…
            </Btn>
          )}
        </div>
      )}
      {data && data.notes.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-env-staging/40 bg-env-staging-tint px-3 py-2 text-[12px] leading-5">
          {data.notes.map((n) => (
            <span key={n}>{n}</span>
          ))}
        </div>
      )}
      {!compact && data && data.denied.length > 0 && <div className="text-[11.5px] text-subtle-foreground">Couldn't read (root only, no sudo): {data.denied.join(", ")}</div>}
    </div>
  );
}

/** The down, basic auth and default login dialogs (one host, in App). */
export function DashDialogs() {
  const { down, auth, editDefault, servers } = useDash();
  const all = useConfig((s) => s.snapshot?.config?.servers);
  const find = (r: { serverId: string; appId: string } | null) => {
    const server = r ? all?.find((x) => x.id === r.serverId) : undefined;
    const app = server && r ? server.apps.find((a) => a.id === r.appId) : undefined;
    return server && app ? { server, app } : null;
  };
  const d = find(down);
  const a = find(auth);
  const aData = a ? servers[a.server.id]?.data : null;
  const aS = a && aData ? aData.apps.find((x) => x.appId === a.app.id) : undefined;
  return (
    <>
      {d && <DownDialog server={d.server} app={d.app} onClose={() => useDash.setState({ down: null })} onConfirm={(withSecret, stop) => goDown(d.server, d.app, withSecret, stop)} />}
      {a && aData && aS && (
        <AuthDialog
          server={a.server}
          app={a.app}
          s={aS}
          defaultUser={aData.defaultUser}
          logins={aData.logins}
          onSetDefault={() => useDash.setState({ editDefault: a.server.id })}
          onClose={() => useDash.setState({ auth: null })}
          onConfirm={(login) => authOn(a.server, a.app, login)}
        />
      )}
      {editDefault && (
        <DefaultLoginDialog
          onClose={(saved) => {
            const id = editDefault;
            useDash.setState({ editDefault: null });
            if (saved) void loadDash(id);
          }}
        />
      )}
    </>
  );
}

function DownDialog({ server, app, onClose, onConfirm }: { server: Server; app: App; onClose: () => void; onConfirm: (withSecret: boolean, stop: string[]) => void }) {
  const [withSecret, setWithSecret] = useState(true);
  const [runs, setRuns] = useState<Runs | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [stop, setStop] = useState<string[]>([]);
  const prod = app.env === "prod";
  useEffect(() => {
    let live = true;
    dashboardRuns(server.id, app.id)
      .then((r) => {
        if (!live) return;
        setRuns(r);
        // Every running worker, unless sudo can't stop them.
        if (r.sudo !== "none") setStop(r.workers.filter((w) => w.running > 0).map((w) => w.program));
      })
      .catch((e) => live && setRunsError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [server.id, app.id]);
  const anyway = runs?.cron.filter((c) => !c.pauses) ?? [];
  const pausing = runs?.cron.filter((c) => c.pauses) ?? [];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Maintenance mode" width={580}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">Put {app.name} in maintenance mode?</span>
        <span className="text-[12.5px] leading-5 text-muted-foreground">
          <span className="font-mono">artisan down</span> on {server.name}
          {prod ? " (production)" : ""}: visitors get Laravel's 503 page until you bring it back up.
        </span>
      </ModalHeader>
      <div className="flex max-h-[min(60vh,520px)] flex-col gap-3 overflow-y-auto px-5 pb-4 text-[12.5px]">
        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" className="mt-0.5 accent-primary" checked={withSecret} onChange={(e) => setWithSecret(e.target.checked)} />
          <span>
            With a bypass link
            <span className="block text-[11.5px] text-subtle-foreground">
              A secret path that lets you (in that browser) past the 503 to check things{app.url ? "; it's copied for you" : ""}. Laravel 8 or later.
            </span>
          </span>
        </label>

        <div className="flex flex-col gap-2 rounded-lg border border-divider bg-panel px-3 py-2.5">
          <span className="text-[11px] font-semibold tracking-wide text-subtle-foreground uppercase">While it's down</span>
          {!runs && !runsError && (
            <span className="flex items-center gap-2 text-subtle-foreground">
              <Spinner size={11} /> Looking at its workers and cron…
            </span>
          )}
          {runsError && <span className="text-subtle-foreground">Couldn't look at its workers and cron: {runsError}</span>}
          {runs && (
            <>
              {runs.workers.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-[11.5px] text-subtle-foreground">
                    Supervisor workers: tick the ones to stop too (<span className="font-mono">supervisorctl stop</span>; they start again when it goes live).
                    {runs.sudo === "none" && " Stopping them needs sudo: save this server's sudo password in Passwords (⇧⌘K)."}
                  </span>
                  {runs.workers.map((w) => (
                    <label key={w.program} className={cn("flex items-start gap-2", runs.sudo !== "none" && w.running > 0 && "cursor-pointer")} title={w.command}>
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        disabled={runs.sudo === "none" || w.running === 0}
                        checked={stop.includes(w.program)}
                        onChange={(e) => setStop((list) => (e.target.checked ? [...list, w.program] : list.filter((x) => x !== w.program)))}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span>
                          <span className="font-mono">{w.program}</span>{" "}
                          <span className="text-subtle-foreground">
                            · {w.running === 0 ? (w.states.join(", ").toLowerCase() || "not running") : `${w.running} of ${w.total} running`}
                          </span>
                        </span>
                        <span className={cn("text-[11.5px]", w.runsWhileDown && w.running > 0 ? "text-[#8a5a12]" : "text-subtle-foreground")}>
                          {w.kind === "other"
                            ? "Not a Laravel worker: keeps running while it's down"
                            : w.runsWhileDown
                              ? "Runs with --force: keeps working while it's down"
                              : w.kind === "schedule"
                                ? "schedule:work: skips its tasks while it's down"
                                : "Pauses by itself while it's down (picks up no jobs; they wait in the queue)"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {pausing.map((c) => (
                <div key={c.source + c.line} className="flex flex-col">
                  <span className="truncate font-mono text-[11.5px]" title={`${c.source}: ${c.line}`}>
                    {c.line}
                  </span>
                  <span className="text-[11.5px] text-subtle-foreground">
                    {c.line.includes("schedule:run") ? "Its scheduler: Laravel skips the scheduled tasks while it's down" : "Pauses while it's down"} ({c.source})
                  </span>
                </div>
              ))}
              {runs.evenInMaintenance.length > 0 && (
                <div className="flex flex-col">
                  <span className="text-[11.5px] text-[#8a5a12]">Scheduled to run even in maintenance mode:</span>
                  {runs.evenInMaintenance.map((l) => (
                    <span key={l} className="truncate font-mono text-[11.5px]" title={l}>
                      {l}
                    </span>
                  ))}
                </div>
              )}
              {anyway.map((c) => (
                <div key={c.source + c.line} className="flex flex-col">
                  <span className="truncate font-mono text-[11.5px]" title={`${c.source}: ${c.line}`}>
                    {c.line}
                  </span>
                  <span className="text-[11.5px] text-[#8a5a12]">Cron runs this even while it's down: it doesn't go through the scheduler ({c.source})</span>
                </div>
              ))}
              {runs.workers.length === 0 && runs.cron.length === 0 && runs.evenInMaintenance.length === 0 ? (
                <span className="text-subtle-foreground">No Supervisor workers or cron lines name its folder.</span>
              ) : (
                runs.cron.length === 0 && <span className="text-[11.5px] text-subtle-foreground">No cron line names its folder: its scheduler isn't running anyway.</span>
              )}
            </>
          )}
        </div>
      </div>
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={onClose}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn autoFocus variant={prod ? "danger" : "primary"} onClick={() => onConfirm(withSecret, stop)}>
          {stop.length ? `Put it down, stop ${stop.length} worker${stop.length === 1 ? "" : "s"}` : "Put it down"}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}

function PasswordInput({ id, value, onChange, autoFocus }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <TextInput id={id} autoFocus={autoFocus} type={show ? "text" : "password"} autoComplete="new-password" value={value} onChange={(e) => onChange(e.target.value)} />
      <Btn size="sm" variant="ghost" className="h-8" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide" : "Show"}>
        {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Btn>
      <Btn
        size="sm"
        variant="outline"
        className="h-8"
        onClick={() => {
          onChange(generate());
          setShow(true);
        }}
        title="A random 20-character password"
      >
        <Wand2 className="size-3.5" /> Generate
      </Btn>
    </div>
  );
}

const USER_OK = /^[A-Za-z0-9._@-]{1,64}$/;

function AuthDialog({
  server,
  app,
  s,
  defaultUser,
  logins,
  onSetDefault,
  onClose,
  onConfirm,
}: {
  server: Server;
  app: App;
  s: AppSwitches;
  defaultUser: string | null;
  logins: LoginFile[];
  onSetDefault: () => void;
  onClose: () => void;
  onConfirm: (login: BasicLogin) => void;
}) {
  const on = s.auth.state === "on" || s.auth.state === "partial";
  const own = `${OWN_DIR}${app.id}`;
  const hasOwn = logins.some((l) => l.path === own);
  // Other login files on the server (e.g. a shared /etc/nginx/.htpasswd).
  const others = logins.filter((l) => l.path !== own && !(on && l.path === s.auth.file && !l.path.startsWith(OWN_DIR)));
  const [kind, setKind] = useState<BasicLogin["kind"]>(s.auth.fixedFile ? "keep" : defaultUser ? "default" : hasOwn && !on ? "keep" : "own");
  const [filePath, setFilePath] = useState(others[0]?.path ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(true);
  // The default may be set from here (its dialog on top), then picked.
  useEffect(() => {
    if (defaultUser && kind === "own" && !username) setKind("default");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultUser]);
  const ok = s.auth.fixedFile
    ? true
    : kind === "default"
      ? !!defaultUser
      : kind === "keep"
        ? hasOwn
        : kind === "file"
          ? !!filePath
          : USER_OK.test(username.trim()) && password !== "" && !/[\r\n]/.test(password);
  const login: BasicLogin =
    kind === "own" ? { kind, username: username.trim(), password, save } : kind === "file" ? { kind, path: filePath } : s.auth.fixedFile ? { kind: "default" } : { kind };
  const option = (k: BasicLogin["kind"], label: React.ReactNode, disabled = false) => (
    <label className={cn("flex items-center gap-2 text-[12.5px]", disabled ? "text-faint-foreground" : "cursor-pointer")}>
      <input type="radio" name="login" className="accent-primary" checked={kind === k} disabled={disabled} onChange={() => setKind(k)} />
      {label}
    </label>
  );
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Basic auth" width={500}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">{on ? `Change ${app.name}'s login` : `Basic auth for ${app.name}`}</span>
        <span className="text-[12.5px] leading-5 text-muted-foreground">
          The browser asks for this login before showing {app.url ? app.url.replace(/^https?:\/\//, "") : "the app"} ({server.name}
          {app.env === "prod" ? ", production" : ""}).
        </span>
      </ModalHeader>
      <form
        className="flex flex-col gap-2.5 px-5 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onConfirm(login);
        }}
      >
        {s.auth.mode === "map" && (
          <span className="text-[11.5px] leading-4 text-subtle-foreground">
            Its vhost switches by host: {on ? "" : "turning on adds "}
            <span className="font-mono">{s.auth.host}</span> {on ? "is" : "to"} the {s.auth.via}.
          </span>
        )}
        {s.auth.fixedFile ? (
          <span className="text-[12.5px]">
            Login: <span className="font-mono">{s.auth.file}</span> (the vhost names it){usersOf(logins, s.auth.file) && `, users ${usersOf(logins, s.auth.file)}`}.
          </span>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {option(
                "default",
                defaultUser ? (
                  <>
                    Default login (<span className="font-mono">{defaultUser}</span>)
                  </>
                ) : (
                  "Default login (none yet)"
                ),
                !defaultUser,
              )}
              <button type="button" className="cursor-pointer text-[11.5px] text-primary hover:underline" onClick={onSetDefault}>
                {defaultUser ? "Change…" : "Set one…"}
              </button>
            </div>
            {hasOwn &&
              option(
                "keep",
                <>
                  {on && s.auth.file === own ? "Keep the current one" : "The one it had before"} (<span className="font-mono">{usersOf(logins, own) || own}</span>)
                </>,
              )}
            {others.length > 0 && (
              <div className="flex items-center gap-2">
                {option("file", "Same login file as")}
                <select
                  value={filePath}
                  onChange={(e) => {
                    setFilePath(e.target.value);
                    setKind("file");
                  }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-control-border bg-background px-1.5 font-mono text-[12px] outline-none focus:border-primary/60"
                >
                  {others.map((l) => (
                    <option key={l.path} value={l.path}>
                      {l.path}
                      {l.users.length ? ` (${l.users.join(", ")})` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {option("own", "Its own login")}
            {kind === "own" && (
              <div className="ml-6 flex flex-col gap-2.5">
                <Field label="Username">{(id) => <TextInput id={id} autoFocus value={username} placeholder="team" onChange={(e) => setUsername(e.target.value)} invalid={username !== "" && !USER_OK.test(username.trim())} />}</Field>
                <Field label="Password">{(id) => <PasswordInput id={id} value={password} onChange={setPassword} />}</Field>
                <label className="flex cursor-pointer items-center gap-2 text-[12px]">
                  <input type="checkbox" className="accent-primary" checked={save} onChange={(e) => setSave(e.target.checked)} />
                  Keep it in Passwords (to copy it later; the server only gets a hash)
                </label>
              </div>
            )}
          </>
        )}
        <button type="submit" hidden />
      </form>
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={onClose}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn variant="primary" disabled={!ok} onClick={() => onConfirm(login)}>
          {on ? "Change login" : "Turn on"}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}

/** The default basic auth login: a Passwords entry marked as such. */
function DefaultLoginDialog({ onClose }: { onClose: (saved: boolean) => void }) {
  const { entries, loaded } = useVault();
  useEffect(() => {
    void useVault.getState().load();
  }, []);
  const current = entries.find((e) => e.basicAuth) ?? null;
  const [username, setUsername] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const user = (username ?? current?.username ?? "").trim();
  const ok = USER_OK.test(user) && (current !== null || password !== "") && !/[\r\n]/.test(password) && !busy;
  const save = async () => {
    if (!ok) return;
    setBusy(true);
    const id = await useVault.getState().save({
      id: current?.id ?? null,
      name: current?.name ?? "Basic auth default",
      username: user,
      notes: current?.notes ?? "",
      sudoFor: current?.sudoFor ?? [],
      basicAuth: true,
      password: password || null,
    });
    setBusy(false);
    if (id) onClose(true);
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose(false)} title="Default login" width={480}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">Default basic auth login</span>
        <span className="text-[12.5px] leading-5 text-muted-foreground">
          What Turn on uses unless you give an app its own. Kept in Passwords{current ? ` as “${current.name}”` : ""}. Apps that are already on keep their login until you
          change it there.
        </span>
      </ModalHeader>
      {!loaded ? (
        <div className="px-5 pb-4 text-[12px] text-subtle-foreground">Loading…</div>
      ) : (
        <form
          className="flex flex-col gap-2.5 px-5 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Username">
            {(id) => <TextInput id={id} autoFocus value={username ?? current?.username ?? ""} placeholder="team" onChange={(e) => setUsername(e.target.value)} invalid={user !== "" && !USER_OK.test(user)} />}
          </Field>
          <Field label={current ? "New password" : "Password"} hint={current ? "Leave empty to keep the saved one" : undefined}>
            {(id) => <PasswordInput id={id} value={password} onChange={setPassword} />}
          </Field>
          <button type="submit" hidden />
        </form>
      )}
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={() => onClose(false)}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn variant="primary" disabled={!ok} onClick={() => void save()}>
          Save
        </Btn>
      </ModalFooter>
    </Modal>
  );
}
