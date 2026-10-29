import { Copy, ExternalLink, Eye, EyeOff, KeyRound, RotateCw, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, TextInput } from "@/components/manage/fields";
import { dashboardAuth, dashboardMaintenance, dashboardStatus, errorMessage, openUrl, type App, type AppSwitches, type BasicLogin, type Dashboard, type LoginFile, type Server } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { askChoice } from "@/stores/confirm";
import type { Tab } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";
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

const bypassUrl = (app: App, secret: string) => `${(app.url ?? "").replace(/\/+$/, "")}/${secret}`;

/** On/off, like a settings switch. */
function Switch({ on, busy, disabled, onClick, label }: { on: boolean; busy?: boolean; disabled?: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled || busy}
      onClick={onClick}
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

type Busy = Record<string, "laravel" | "auth" | undefined>;

/** A server's dashboard tab: each app's maintenance mode and basic auth. */
export function DashboardView({ tab, visible }: { tab: Tab; visible: boolean }) {
  const serverId = tab.serverId ?? "";
  const server = useConfig((s) => s.snapshot?.config?.servers.find((x) => x.id === serverId));
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>({});
  const [downFor, setDownFor] = useState<App | null>(null);
  const [authFor, setAuthFor] = useState<App | null>(null);
  const [editDefault, setEditDefault] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setData(await dashboardStatus(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (visible && !data && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, serverId]);

  if (!server) return <div className="light-ui absolute inset-0 bg-background p-4 text-[13px] text-subtle-foreground">{serverId} isn't in Kemudi any more.</div>;

  /** Run a change for an app, then read everything again. */
  const change = async (app: App, what: "laravel" | "auth", run: () => Promise<string>) => {
    setBusy((b) => ({ ...b, [app.id]: what }));
    try {
      useToasts.getState().push(await run(), "info");
    } catch (e) {
      toastError(`${app.name}: ${errorMessage(e)}`);
    } finally {
      setBusy((b) => ({ ...b, [app.id]: undefined }));
      // nginx swaps its workers a moment after a reload.
      setTimeout(() => void load(), what === "auth" ? 800 : 0);
    }
  };

  const goUp = async (app: App) => {
    if (app.env === "prod" && !(await askChoice(`Bring ${app.name} back up?`, `artisan up on ${server.name} (production).`, "Bring it up", "Cancel"))) return;
    void change(app, "laravel", async () => {
      await dashboardMaintenance(server.id, app.id, false, false);
      return `${app.name} is live again`;
    });
  };
  const authOff = async (app: App) => {
    if (app.env === "prod" && !(await askChoice(`Turn basic auth off for ${app.name}?`, `Anyone can open it again (${server.name}, production).`, "Turn it off", "Cancel"))) return;
    void change(app, "auth", async () => {
      await dashboardAuth(server.id, app.id, false, null);
      return `Basic auth off for ${app.name}`;
    });
  };

  const needsRoot = data && !["root", "ok"].includes(data.sudo);
  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-3">
        <span className="text-[13px] font-semibold">Dashboard</span>
        <span className="text-[12.5px] text-subtle-foreground">{server.name}</span>
        <EnvTag env={server.env} />
        <span className="flex-1" />
        <button
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-hover-strong hover:text-foreground"
          onClick={() => setEditDefault(true)}
          title="The login Turn on uses unless you give one (kept in Passwords)"
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
        <Btn size="sm" variant="outline" disabled={loading} onClick={() => void load()}>
          <RotateCw className={cn("size-3.5", loading && "animate-spin")} /> Refresh
        </Btn>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && <div className="mb-3 text-[12.5px] text-env-prod-fg">{error}</div>}
        {needsRoot && (
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-env-staging/40 bg-env-staging-tint px-3 py-2 text-[12px]">
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
          <div className="mb-3 flex flex-col gap-1 rounded-lg border border-env-staging/40 bg-env-staging-tint px-3 py-2 text-[12px] leading-5">
            {data.notes.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        )}
        {server.apps.length === 0 && <div className="text-[13px] text-subtle-foreground">{server.name} has no apps in Kemudi yet (Discover apps… or Add app… in its menu).</div>}
        {!data && loading && server.apps.length > 0 && <div className="text-[13px] text-subtle-foreground">Reading {server.name} (read-only)…</div>}
        {data && server.apps.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-divider">
            <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-4 border-b border-divider bg-panel px-4 py-2 text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">
              <span>App</span>
              <span>Laravel</span>
              <span>Basic auth</span>
            </div>
            {server.apps.map((app) => {
              const s = data.apps.find((a) => a.appId === app.id);
              return s ? (
                <AppRow
                  key={app.id}
                  server={server}
                  app={app}
                  s={s}
                  nginx={data.nginx}
                  logins={data.logins}
                  busy={busy[app.id]}
                  onDown={() => setDownFor(app)}
                  onUp={() => void goUp(app)}
                  onAuthOn={() => setAuthFor(app)}
                  onAuthOff={() => void authOff(app)}
                />
              ) : null;
            })}
          </div>
        )}
        {data && data.denied.length > 0 && (
          <div className="mt-3 text-[11.5px] text-subtle-foreground">Couldn't read (root only, no sudo): {data.denied.join(", ")}</div>
        )}
        <div className="mt-4 max-w-[760px] text-[11.5px] leading-5 text-subtle-foreground">
          Maintenance mode is <span className="font-mono">artisan down</span> / <span className="font-mono">up</span>, run as the owner of the app's storage folder. Basic auth
          goes where the vhost keeps it: a vhost with <span className="font-mono">map $host</span> lines gets the app's host added or taken out (in the map nginx uses);
          one without any gets Kemudi's lines in the app's server block (marked <span className="font-mono"># kemudi:auth</span>, per app on a shared vhost). Every change
          is checked with <span className="font-mono">nginx -t</span> and put back if that fails. New logins go in <span className="font-mono">/etc/nginx/kemudi-auth</span>;
          passwords are hashed on this Mac and never sent to the server.
        </div>
      </div>
      {downFor && (
        <DownDialog
          server={server}
          app={downFor}
          onClose={() => setDownFor(null)}
          onConfirm={(withSecret) => {
            const app = downFor;
            setDownFor(null);
            void change(app, "laravel", async () => {
              const r = await dashboardMaintenance(server.id, app.id, true, withSecret);
              if (r.secret && app.url) void navigator.clipboard.writeText(bypassUrl(app, r.secret)).catch(() => {});
              return r.secret && app.url ? `${app.name} is in maintenance mode; the bypass link is copied` : `${app.name} is in maintenance mode`;
            });
          }}
        />
      )}
      {authFor && data && (
        <AuthDialog
          server={server}
          app={authFor}
          s={data.apps.find((a) => a.appId === authFor.id)!}
          defaultUser={data.defaultUser}
          logins={data.logins}
          onSetDefault={() => setEditDefault(true)}
          onClose={() => setAuthFor(null)}
          onConfirm={(login) => {
            const app = authFor;
            setAuthFor(null);
            void change(app, "auth", async () => {
              const r = await dashboardAuth(server.id, app.id, true, login);
              return `Basic auth on for ${app.name}${r.user ? ` (user ${r.user})` : ""}`;
            });
          }}
        />
      )}
      {editDefault && (
        <DefaultLoginDialog
          onClose={(saved) => {
            setEditDefault(false);
            if (saved) void load();
          }}
        />
      )}
    </div>
  );
}

function AppRow({
  server,
  app,
  s,
  nginx,
  logins,
  busy,
  onDown,
  onUp,
  onAuthOn,
  onAuthOff,
}: {
  server: Server;
  app: App;
  s: AppSwitches;
  nginx: boolean;
  logins: LoginFile[];
  busy: "laravel" | "auth" | undefined;
  onDown: () => void;
  onUp: () => void;
  onAuthOn: () => void;
  onAuthOff: () => void;
}) {
  const a = s.auth;
  const authOn = a.state === "on" || a.state === "partial";
  return (
    <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)] items-start gap-4 border-b border-divider px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{app.name}</span>
          {app.env !== server.env && <EnvTag env={app.env} />}
        </div>
        {app.url && (
          <button
            className="flex w-fit max-w-full cursor-pointer items-center gap-1 truncate text-[12px] text-primary hover:underline"
            onClick={() => void openUrl(app.url!).catch((e) => toastError(errorMessage(e)))}
          >
            <span className="truncate">{app.url.replace(/^https?:\/\//, "")}</span>
            <ExternalLink className="size-3 flex-none" />
          </button>
        )}
        <span className="truncate font-mono text-[11px] text-subtle-foreground">{app.path}</span>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        {s.laravel ? (
          <>
            <div className="flex items-center gap-2.5">
              <Switch on={!s.down} busy={busy === "laravel"} label={`${app.name} live`} onClick={s.down ? onUp : onDown} />
              <span className={cn("text-[12.5px]", s.down ? "text-[#8a5a12]" : "text-[#17702a]")}>{busy === "laravel" ? "…" : s.down ? "Maintenance mode" : "Live"}</span>
            </div>
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
          </>
        ) : (
          <span className="text-[12px] text-subtle-foreground">Not Laravel (no artisan in {app.path})</span>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        {!nginx ? (
          <span className="text-[12px] text-subtle-foreground">No nginx on this server</span>
        ) : a.state === "novhost" ? (
          <span className="text-[12px] text-subtle-foreground">No nginx server block with its root at {app.path.replace(/\/+$/, "")}/public</span>
        ) : a.state === "manual" || a.state === "nourl" ? (
          <span className="text-[12px] text-subtle-foreground">{a.notes[0] ?? "Set in its vhost by hand"}</span>
        ) : (
          <>
            <div className="flex items-center gap-2.5">
              <Switch on={authOn} busy={busy === "auth"} label={`${app.name} basic auth`} onClick={authOn ? onAuthOff : onAuthOn} />
              <span className="min-w-0 truncate text-[12.5px]" title={authOn && a.file ? a.file : undefined}>
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
              {authOn && busy !== "auth" && !a.fixedFile && (
                <button className="flex-none cursor-pointer text-[11.5px] text-primary hover:underline" onClick={onAuthOn}>
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
    </div>
  );
}

function DownDialog({ server, app, onClose, onConfirm }: { server: Server; app: App; onClose: () => void; onConfirm: (withSecret: boolean) => void }) {
  const [withSecret, setWithSecret] = useState(true);
  const prod = app.env === "prod";
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Maintenance mode" width={460}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">Put {app.name} in maintenance mode?</span>
        <span className="text-[12.5px] leading-5 text-muted-foreground">
          <span className="font-mono">artisan down</span> on {server.name}
          {prod ? " (production)" : ""}: visitors get Laravel's 503 page until you bring it back up.
        </span>
      </ModalHeader>
      <div className="px-5 pb-4">
        <label className="flex cursor-pointer items-start gap-2 text-[12.5px]">
          <input type="checkbox" className="mt-0.5 accent-primary" checked={withSecret} onChange={(e) => setWithSecret(e.target.checked)} />
          <span>
            With a bypass link
            <span className="block text-[11.5px] text-subtle-foreground">
              A secret path that lets you (in that browser) past the 503 to check things{app.url ? "; it's copied for you" : ""}. Laravel 8 or later.
            </span>
          </span>
        </label>
      </div>
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={onClose}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn autoFocus variant={prod ? "danger" : "primary"} onClick={() => onConfirm(withSecret)}>
          Put it down
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
