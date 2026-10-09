import { Activity, FolderOpen, Gauge, HeartPulse, ListChecks, PackagePlus, ScanSearch, ScrollText } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { StatusDot } from "@/components/kit/StatusDot";
import {
  appDelete,
  appDetectPhp,
  appDetectRepo,
  appDetectUrl,
  appSave,
  errorMessage,
  openUrl,
  repoWebUrl,
  serverDelete,
  serverSave,
  sshConfigOpen,
  sshHostAdopt,
  sshHostInfo,
  sshHostSave,
  sshHosts,
  sshKeys,
  sshTest,
  type App,
  type HostEntry,
  type HostInfo,
  type Env,
  type Server,
  type Vpn,
} from "@/lib/ipc";
import { triggerAction } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { freeId, openDetails, useManage } from "@/stores/manage";
import { useNewApp } from "@/stores/newApp";
import { useTeam } from "@/stores/team";

const NO_TEAMS: import("@/lib/ipc").Team[] = [];
import { useStatus } from "@/stores/status";
import { openFiles, openHealth, openLogs, openMonitor, openQueues, openSsh, openTune, useTabs } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useVault } from "@/stores/vault";

import type { TabColor } from "@/lib/tabColors";

import { Badge } from "./Badge";
import { ColorPicker } from "./ColorPicker";
import { InspectPanel } from "./InspectPanel";
import { Segmented, TextInput, VALID_ID } from "./fields";

const NO_SERVERS: Server[] = [];

/** The details page (main area, like Querious): a server's or app's
 *  settings as an editable form, Save, Open shell, Delete. */
export function DetailsView() {
  const target = useManage((s) => s.details);
  const servers = useConfig((s) => s.snapshot?.config?.servers ?? NO_SERVERS);
  if (!target) return null;
  const server = target.serverId ? servers.find((s) => s.id === target.serverId) : undefined;
  let body: React.ReactNode;
  if (target.kind === "server") {
    body =
      target.serverId && !server ? (
        <Gone what={`Server ${target.serverId}`} />
      ) : (
        <ServerDetails key={target.serverId ?? "new"} server={server ?? null} />
      );
  } else {
    const app = target.appId && server ? server.apps.find((a) => a.id === target.appId) : undefined;
    body = !server || (target.appId && !app) ? <Gone what={`App ${target.appId ?? ""}`} /> : (
      <AppDetails key={`${server.id}/${target.appId ?? "new"}`} server={server} app={app ?? null} />
    );
  }
  return <div className="absolute inset-0 z-10 overflow-y-auto bg-background">{body}</div>;
}

function Gone({ what }: { what: string }) {
  return <div className="p-10 text-[13px] text-subtle-foreground">{what} no longer exists.</div>;
}

/** Badge + title over a grey card of right-aligned labels (Querious). */
function Page({
  badge,
  title,
  sub,
  children,
  footer,
  after,
  side,
}: {
  badge: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  children: React.ReactNode;
  footer: React.ReactNode;
  after?: React.ReactNode;
  /** Second column when there's room (else below), e.g. Inspect or apps. */
  side?: React.ReactNode;
}) {
  // Two columns once the main area (not the window) is wide enough.
  return (
    <div className="@container w-full">
      <div
        className={cn(
          "mx-auto grid w-full gap-x-8 gap-y-4 px-8 pt-12 pb-12",
          side ? "max-w-[1280px] @min-[960px]:grid-cols-[minmax(0,560px)_minmax(0,1fr)] @min-[960px]:items-start" : "max-w-[600px]",
        )}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <div className={cn("flex items-center gap-3", side ? "justify-center @min-[960px]:justify-start" : "justify-center")}>
            {badge}
            <div className="flex min-w-0 flex-col">
              <div className="flex items-center gap-2 truncate text-[19px] font-semibold tracking-[-0.01em]">{title}</div>
              {sub && <div className="truncate text-[12px] text-subtle-foreground">{sub}</div>}
            </div>
          </div>
          <div className="flex flex-col gap-2.5 rounded-xl border border-divider bg-panel px-6 py-5">{children}</div>
          <div className="flex items-center gap-2">{footer}</div>
          {after}
        </div>
        {side && <div className="flex min-w-0 flex-col gap-4 @min-[960px]:pt-[58px]">{side}</div>}
      </div>
    </div>
  );
}

function SubRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-2.5">
      <div className="text-right text-[12px] text-muted-foreground">{label}:</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-x-3">
      <div className="pt-[7px] text-right text-[12.5px] text-muted-foreground">{label}:</div>
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {hint && <div className="text-[11px] leading-4 text-subtle-foreground">{hint}</div>}
      </div>
    </div>
  );
}

const ENVS: { value: Env; label: string }[] = [
  { value: "prod", label: "Production" },
  { value: "staging", label: "Staging" },
  { value: "qa", label: "QA" },
  { value: "dev", label: "Dev" },
];
const ENV_NAMES: Record<Env, string> = { prod: "Production", staging: "Staging", qa: "QA", dev: "Dev" };
const envLabelShort = (e: Env) => ({ prod: "Prod", staging: "Stg", qa: "QA", dev: "Dev" })[e];
const VPNS: { value: Vpn; label: string }[] = [
  { value: "none", label: "None" },
  { value: "openfortivpn", label: "openfortivpn" },
  { value: "globalprotect", label: "GlobalProtect" },
];
const portOf = (p: string) => (/^\d{1,5}$/.test(p) && Number(p) > 0 && Number(p) < 65536 ? Number(p) : null);
const done = (msg: string) => useToasts.getState().push(msg, "info");

function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (what: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await what();
      return true;
    } catch (e) {
      toastError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function shellFor(server: Server, app?: App) {
  openSsh(server.host, {
    serverId: server.id,
    prod: (app?.env ?? server.env) === "prod",
    title: app ? `${server.id} · ${app.id}` : `${server.id} · ssh`,
    cwd: app?.path,
    appId: app?.id,
  });
}

// ------------------------------------------------------------------ server

function ServerDetails({ server }: { server: Server | null }) {
  const [name, setName] = useState(server?.name ?? "");
  const servers = useConfig((s) => s.snapshot?.config?.servers ?? NO_SERVERS);
  // Kemudi's own key for it, from the name when it's added; never changed.
  const id = server ? server.id : freeId(name, servers.map((s) => s.id), "server");
  const [host, setHost] = useState(server?.host ?? "");
  const [env, setEnv] = useState<Env>(server?.env ?? "staging");
  const [vpn, setVpn] = useState<Vpn>(server?.vpn ?? "none");
  const [vpnHost, setVpnHost] = useState(server?.vpnCheck?.host ?? "");
  const [vpnPort, setVpnPort] = useState(String(server?.vpnCheck?.port ?? 22));
  const [vpnConnect, setVpnConnect] = useState(server?.vpnConnect ?? "");
  const [checkHost, setCheckHost] = useState(server?.check?.host ?? "");
  const [checkPort, setCheckPort] = useState(String(server?.check?.port ?? 22));
  const [color, setColor] = useState<TabColor | null>(server?.color ?? null);
  const teams = useConfig((s) => s.snapshot?.config?.teams ?? NO_TEAMS);
  // A new server starts in the team in front.
  const [team, setTeam] = useState<string>(server ? (server.team ?? "") : teams.some((t) => t.id === useTeam.getState().current) ? useTeam.getState().current : "");
  const [hosts, setHosts] = useState<string[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const reach = useStatus((s) => (server ? s.byServer[server.id] : undefined));
  const { busy, run } = useBusy();
  // The SSH host behind the alias (Kemudi's own entries are editable).
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [key, setKey] = useState("");
  const [jump, setJump] = useState("");
  const [test, setTest] = useState<{ ok: boolean; message: string } | "testing" | null>(null);
  const [infoTick, setInfoTick] = useState(0);

  useEffect(() => {
    sshHosts().then(setHosts, () => setHosts([]));
    sshKeys().then(setKeys, () => setKeys([]));
  }, []);

  useEffect(() => {
    setTest(null);
    const alias = host.trim();
    if (!alias || alias.includes("@")) {
      setInfo(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      sshHostInfo(alias).then(
        (i) => {
          if (!live) return;
          setInfo(i);
          // Kemudi's own entry, else the user's own block, else what ssh makes of it.
          const e = i.managed ?? i.external;
          if (e) {
            setAddress(e.hostname);
            setUser(e.user ?? "");
            setSshPort(e.port ? String(e.port) : "");
            setKey(e.identityFile ?? "");
            setJump(e.jump ?? "");
          } else if (i.resolved) {
            setAddress(i.resolved.hostname ?? "");
            setUser(i.resolved.user ?? "");
            setSshPort(i.resolved.port && i.resolved.port !== 22 ? String(i.resolved.port) : "");
            setKey("");
            setJump(i.resolved.proxyjump ?? "");
          }
        },
        () => live && setInfo(null),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [host, infoTick]);

  const alias = host.trim();
  const mode: "empty" | "direct" | "loading" | "external" | "managed" | "new" = !alias
    ? "empty"
    : alias.includes("@")
      ? "direct"
      : !info || info.alias !== alias
        ? "loading"
        : info.managed
          ? "managed"
          : info.known
            ? "external"
            : "new";
  const entry: HostEntry = {
    alias,
    hostname: address.trim(),
    user: user.trim() || null,
    port: sshPort.trim() ? portOf(sshPort.trim()) : null,
    identityFile: key.trim() || null,
    jump: jump.trim() || null,
    // Options the form has no field for stay as they are.
    extra: info?.managed?.extra ?? info?.external?.extra ?? [],
  };
  // The user's own host, editable when its block can move into Kemudi's file.
  const movable = mode === "external" && !!info?.external && !info.adoptBlocker;
  const m = info?.managed ?? (movable ? info?.external : null);
  const entryDirty =
    mode === "new" ||
    ((mode === "managed" || movable) &&
      !!m &&
      (entry.hostname !== m.hostname ||
        entry.user !== m.user ||
        entry.port !== m.port ||
        entry.identityFile !== m.identityFile ||
        entry.jump !== m.jump));
  const entryOk =
    (mode !== "new" && mode !== "managed" && !movable) ||
    (entry.hostname !== "" && (sshPort.trim() === "" || entry.port !== null));

  const idOk = server ? true : name.trim() !== "" && VALID_ID.test(id);
  const vpnOk =
    vpn === "none" ||
    (vpnHost.trim() !== "" && portOf(vpnPort) !== null && (vpn !== "openfortivpn" || vpnConnect.trim() !== ""));
  const checkOk = checkHost.trim() === "" || portOf(checkPort) !== null;
  const form = {
    id,
    name: name.trim() && name.trim() !== id ? name.trim() : null,
    host: host.trim(),
    env,
    vpn,
    vpnCheck: vpn !== "none" && vpnHost.trim() && portOf(vpnPort) ? { host: vpnHost.trim(), port: portOf(vpnPort)! } : null,
    vpnConnect: vpn === "openfortivpn" ? vpnConnect.trim() || null : null,
    check: checkHost.trim() && portOf(checkPort) ? { host: checkHost.trim(), port: portOf(checkPort)! } : null,
    color,
    team: team || null,
  };
  const dirty =
    entryDirty ||
    !server ||
    form.id !== server.id ||
    (form.name ?? form.id) !== server.name ||
    form.host !== server.host ||
    form.env !== server.env ||
    form.vpn !== server.vpn ||
    JSON.stringify(form.vpnCheck) !== JSON.stringify(server.vpnCheck) ||
    form.vpnConnect !== server.vpnConnect ||
    JSON.stringify(form.check) !== JSON.stringify(server.check) ||
    form.color !== server.color ||
    form.team !== (server.team ?? null);
  const valid = idOk && form.host !== "" && vpnOk && checkOk && entryOk && mode !== "loading";

  const save = async () => {
    if (!valid || busy) return;
    const ok = await run(async () => {
      // The SSH host first, so the server can use it straight away.
      if (entryDirty && movable) {
        // Into Kemudi's file first (your ~/.ssh/config is backed up), then the edit.
        await sshHostAdopt(alias);
        await sshHostSave(alias, entry);
      } else if (entryDirty) await sshHostSave(mode === "managed" ? alias : null, entry);
      await serverSave(server?.id ?? null, form);
    });
    if (ok && entryDirty) {
      setInfoTick((n) => n + 1);
      sshHosts().then(setHosts, () => {});
    }
    if (ok) {
      done(server ? `Saved ${form.name ?? form.id}` : `Added ${form.name ?? form.id}`);
      openDetails({ kind: "server", serverId: form.id });
    }
  };
  const remove = async () => {
    if (!server) return;
    const n = server.apps.length;
    const ok = await askConfirm(
      `Delete ${server.name}?`,
      `Removes it${n ? ` and its ${n} app${n === 1 ? "" : "s"}` : ""} from Kemudi. Nothing on the server changes.`,
    );
    if (ok && (await run(() => serverDelete(server.id)))) {
      done(`Deleted ${server.name}`);
      useTabs.getState().closeDetails();
    }
  };

  const title = server ? server.name : name.trim() || "New server";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Page
        badge={<Badge id={server?.id ?? (id || "new")} name={title} size={40} />}
        title={
          <>
            <span className="truncate">{title}</span>
            {server && <EnvTag env={server.env} />}
          </>
        }
        sub={
          server ? (
            <span className="flex items-center gap-1.5">
              <StatusDot status={reach?.state ?? "unknown"} />
              {reach?.state === "up"
                ? `reachable · ${reach.latencyMs ?? "?"} ms`
                : reach?.state === "down"
                  ? `unreachable · ${reach.error ?? ""}`
                  : "not checked yet"}
            </span>
          ) : (
            "SSH uses your ~/.ssh/config."
          )
        }
        footer={
          <>
            {server && (
              <Btn variant="ghost" className="px-2.5 text-env-prod-fg" disabled={busy} onClick={() => void remove()}>
                Delete…
              </Btn>
            )}
            <span className="flex-1" />
            {server ? (
              <>
                <Btn type="submit" variant="outline" disabled={!dirty || !valid || busy}>
                  Save
                </Btn>
                <Btn variant="outline" onClick={() => openFiles(server)}>
                  <FolderOpen className="size-4" /> Files
                </Btn>
                <Btn variant="outline" onClick={() => openLogs(server)}>
                  <ScrollText className="size-4" /> Logs
                </Btn>
                <Btn variant="outline" onClick={() => openMonitor(server)}>
                  <Activity className="size-4" /> Monitor
                </Btn>
                <Btn variant="outline" onClick={() => openHealth(server)}>
                  <HeartPulse className="size-4" /> Health
                </Btn>
                <Btn variant="outline" onClick={() => openTune(server)}>
                  <Gauge className="size-4" /> Fine-tune
                </Btn>
                <Btn variant="primary" className="px-4" onClick={() => shellFor(server)}>
                  Open shell
                </Btn>
              </>
            ) : (
              <Btn type="submit" variant="primary" className="px-4" disabled={!valid || busy}>
                Add server
              </Btn>
            )}
          </>
        }
        side={server && <AppsList server={server} />}
      >
        <Row label="Name">
          <TextInput
            autoFocus={!server}
            value={name}
            placeholder="NovaOS"
            className="font-sans"
            onChange={(e) => setName(e.target.value)}
          />
        </Row>
        <Row label="SSH host" hint="Pick one from your SSH config, or type a new name to create it">
          <TextInput list="kemudi-ssh-hosts" value={host} placeholder="nova-gw" onChange={(e) => setHost(e.target.value)} />
          <datalist id="kemudi-ssh-hosts">
            {hosts.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </Row>
        {mode !== "empty" && (
          <div className="ml-[144px] flex flex-col gap-2.5 rounded-lg border border-divider bg-background px-4 py-3">
            {mode === "external" && info && (
              <div className="flex flex-col gap-1 text-[12px]">
                <span className="text-muted-foreground">
                  From your ~/.ssh/config.
                  {movable
                    ? entryDirty
                      ? " Saving moves this host into ~/.ssh/config.d/kemudi.conf (your config is backed up first) with these changes; ssh " + alias + " keeps working in any terminal."
                      : " Change a field to edit it: Kemudi then moves it into its own file."
                    : info.adoptBlocker
                      ? ` Kemudi can't edit it here (${info.adoptBlocker}).`
                      : ""}
                </span>
                {!movable && (
                  <span className="font-mono text-foreground">
                    {info.resolved
                      ? `${info.resolved.user ? `${info.resolved.user}@` : ""}${info.resolved.hostname ?? alias}:${info.resolved.port ?? 22}${info.resolved.proxyjump ? ` via ${info.resolved.proxyjump}` : ""}`
                      : alias}
                  </span>
                )}
                <button
                  type="button"
                  className="w-fit cursor-pointer text-[11.5px] text-primary underline-offset-2 hover:underline"
                  onClick={() => void sshConfigOpen().catch((e) => toastError(errorMessage(e)))}
                >
                  Open ~/.ssh/config
                </button>
              </div>
            )}
            {mode === "direct" && (
              <div className="text-[12px] text-muted-foreground">Connects straight to {alias} (no SSH config entry).</div>
            )}
            {mode === "loading" && <div className="text-[12px] text-subtle-foreground">Looking it up…</div>}
            {(mode === "new" || mode === "managed" || movable) && (
              <>
                {mode !== "external" && <div className="text-[12px] text-muted-foreground">
                  {mode === "new" ? (
                    <>
                      <span className="font-medium text-foreground">New SSH host “{alias}”.</span> Saved to
                      ~/.ssh/config.d/kemudi.conf, so <span className="font-mono">ssh {alias}</span> works in any terminal.
                    </>
                  ) : (
                    <>SSH host added in Kemudi (~/.ssh/config.d/kemudi.conf).</>
                  )}
                </div>}
                <SubRow label="Address">
                  <TextInput value={address} placeholder="10.0.1.13 or server.example.com" invalid={address.trim() === ""} onChange={(e) => setAddress(e.target.value)} />
                </SubRow>
                <SubRow label="User">
                  <TextInput value={user} placeholder="root (empty: your Mac user name)" onChange={(e) => setUser(e.target.value)} />
                </SubRow>
                <SubRow label="Port">
                  <TextInput
                    className="w-[90px]"
                    value={sshPort}
                    placeholder="22"
                    invalid={sshPort.trim() !== "" && entry.port === null}
                    onChange={(e) => setSshPort(e.target.value)}
                  />
                </SubRow>
                <SubRow label="Key">
                  <TextInput list="kemudi-ssh-keys" value={key} placeholder="(ssh-agent / your default keys)" onChange={(e) => setKey(e.target.value)} />
                  <datalist id="kemudi-ssh-keys">
                    {keys.map((k) => (
                      <option key={k} value={k} />
                    ))}
                  </datalist>
                </SubRow>
                <SubRow label="Jump host">
                  <TextInput value={jump} placeholder="(optional) bastion" onChange={(e) => setJump(e.target.value)} />
                </SubRow>
              </>
            )}
            {mode !== "loading" && (
              <div className="flex flex-col items-start gap-1.5">
                <Btn
                  size="sm"
                  variant="outline"
                  disabled={test === "testing" || ((mode === "new" || mode === "managed" || movable) && !entryOk)}
                  onClick={() => {
                    setTest("testing");
                    const useEntry = mode === "new" || ((mode === "managed" || movable) && entryDirty);
                    sshTest(useEntry ? null : alias, useEntry ? entry : null).then(setTest, (e) =>
                      setTest({ ok: false, message: errorMessage(e) }),
                    );
                  }}
                >
                  {test === "testing" ? "Testing…" : "Test connection"}
                </Btn>
                {test && test !== "testing" && (
                  <span className={cn("text-[11.5px] leading-4", test.ok ? "text-status-up" : "text-env-prod-fg")}>
                    {test.ok ? "✓ " : "✗ "}
                    {test.message}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {server && (
          <Row
            label="SSH key"
            hint="So ssh stops asking for a password: copies one of your public keys to the server (ssh-copy-id, in a tab; it asks for the server's password once). Then Test connection."
          >
            <InstallKey serverId={server.id} host={server.host} />
          </Row>
        )}
        {(teams.length > 0 || server?.team) && (
          <Row label="Team" hint="Its team's shared actions and snippets apply to it; the sidebar shows it under that team">
            <select
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              className="h-[30px] w-[220px] rounded-lg border border-control-border bg-background px-2 text-[12.5px] outline-none focus:border-primary/60"
            >
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Row>
        )}
        <Row
          label="Environment"
          hint={(() => {
            // The server's environment guards what touches every app on it
            // (its ssh tab, vhosts, Supervisor): it should be the strictest.
            const rank: Record<Env, number> = { dev: 0, qa: 1, staging: 2, prod: 3 };
            const stricter = (server?.apps ?? []).filter((a) => rank[a.env] > rank[env]);
            return stricter.length
              ? `${stricter.map((a) => a.name).join(", ")} ${stricter.length === 1 ? "is" : "are"} ${ENV_NAMES[stricter[0]!.env]}: the server's ssh tab, vhosts and Supervisor affect ${stricter.length === 1 ? "it" : "them"} too, so ${ENV_NAMES[stricter[0]!.env]} fits the server better.`
              : "Apps can set their own (e.g. a staging app on a production server)";
          })()}
        >
          <Segmented label="Environment" value={env} options={ENVS} onChange={setEnv} />
        </Row>
        <Row label="VPN">
          <Segmented label="VPN" value={vpn} options={VPNS} onChange={setVpn} />
        </Row>
        {vpn !== "none" && (
          <>
            <Row label="VPN check" hint="Something only reachable over the VPN; Kemudi tries a TCP connect">
              <div className="flex gap-2">
                <TextInput value={vpnHost} placeholder="10.0.0.5" invalid={vpnHost.trim() === ""} onChange={(e) => setVpnHost(e.target.value)} />
                <TextInput className="w-[76px] flex-none" value={vpnPort} invalid={portOf(vpnPort) === null} onChange={(e) => setVpnPort(e.target.value)} />
              </div>
            </Row>
            {vpn === "openfortivpn" && (
              <Row label="Connect with" hint="Runs in a local tab when you click Connect VPN">
                <TextInput
                  value={vpnConnect}
                  invalid={vpnConnect.trim() === ""}
                  placeholder="sudo openfortivpn -c ~/.config/openfortivpn/client.conf"
                  onChange={(e) => setVpnConnect(e.target.value)}
                />
              </Row>
            )}
          </>
        )}
        <Row label="Tab colour" hint="New tabs for this server (its apps can pick their own)">
          <ColorPicker value={color} onChange={setColor} />
        </Row>
        <Row label="Reachability" hint="Optional: probe this instead of what ssh resolves the host to">
          <div className="flex gap-2">
            <TextInput value={checkHost} placeholder="(from ssh -G)" onChange={(e) => setCheckHost(e.target.value)} />
            <TextInput
              className="w-[76px] flex-none"
              value={checkPort}
              invalid={checkHost.trim() !== "" && portOf(checkPort) === null}
              onChange={(e) => setCheckPort(e.target.value)}
            />
          </div>
        </Row>
        {server && (
          <Row label="sudo password" hint="Used when saving root-owned files here, and suggested at sudo's prompt in its tabs">
            <SudoPassword serverId={server.id} />
          </Row>
        )}
      </Page>
    </form>
  );
}


/** Install one of my SSH keys on the server (ssh-copy-id), or make one. */
function InstallKey({ serverId, host }: { serverId: string; host: string }) {
  const [keys, setKeys] = useState<string[] | null>(null);
  const [key, setKey] = useState("");
  useEffect(() => {
    sshKeys().then(
      (k) => {
        const names = (k ?? []).map((p) => p.replace(/^~\/\.ssh\//, ""));
        setKeys(names);
        // The usual default key first (ssh tries these by itself).
        const usual = ["id_ed25519", "id_ecdsa", "id_rsa"].find((n) => names.includes(n));
        setKey(usual ?? names[0] ?? "");
      },
      () => setKeys([]),
    );
  }, []);
  if (keys === null) return <div className="pt-[7px] text-[12px] text-subtle-foreground">Looking for your keys…</div>;
  if (keys.length === 0) {
    return (
      <div className="flex items-center gap-2 pt-[3px]">
        <span className="text-[12.5px] text-subtle-foreground">You have no SSH key in ~/.ssh yet.</span>
        <Btn size="sm" variant="outline" onClick={() => void triggerAction({ serverId, appId: null, actionId: "ssh-keygen" })}>
          Create a key
        </Btn>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <select
        value={key}
        onChange={(e) => setKey(e.target.value)}
        aria-label="Which key"
        className="h-[30px] min-w-0 flex-1 rounded-lg border border-control-border bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-primary/60"
      >
        {keys.map((k) => (
          <option key={k} value={k}>
            ~/.ssh/{k}.pub
          </option>
        ))}
      </select>
      <Btn size="sm" variant="outline" className="h-[30px]" disabled={!key} onClick={() => void triggerAction({ serverId, appId: null, actionId: `ssh-copy-id:${key}` })}>
        Install on {host}
      </Btn>
    </div>
  );
}

/** Which saved password is this server's sudo password (set in Passwords). */
function SudoPassword({ serverId }: { serverId: string }) {
  const entry = useVault((s) => s.entries.find((e) => e.sudoFor.includes(serverId)));
  const loaded = useVault((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useVault.getState().load();
  }, [loaded]);
  return (
    <div className="flex items-center gap-2 pt-[3px]">
      <span className={cn("text-[12.5px]", entry ? "text-foreground" : "text-subtle-foreground")}>{entry ? entry.name : "None"}</span>
      <span className="flex-1" />
      <Btn size="sm" variant="outline" onClick={() => useUi.getState().setOverlay("passwords")}>
        Passwords…
      </Btn>
    </div>
  );
}

function AppsList({ server }: { server: Server }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">Apps on {server.name}</div>
      <div className="flex flex-col overflow-hidden rounded-xl border border-divider">
        {server.apps.map((a) => (
          <button
            key={a.id}
            onClick={() => openDetails({ kind: "app", serverId: server.id, appId: a.id })}
            className="flex cursor-pointer items-center gap-2.5 border-b border-divider px-3 py-2 text-left last:border-b-0 hover:bg-hover"
          >
            <Badge id={`${server.id}/${a.id}`} name={a.name} size={24} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[12.5px] text-foreground">{a.name}</span>
              <span className="truncate font-mono text-[10.5px] text-subtle-foreground">{a.path}</span>
            </span>
          </button>
        ))}
        <div className="flex items-center gap-2 px-3 py-2">
          <Btn size="sm" variant="outline" onClick={() => openDetails({ kind: "app", serverId: server.id, appId: null })}>
            + Add app
          </Btn>
          <Btn size="sm" variant="primary" onClick={() => useManage.getState().setDiscover(server.id)} title="Look around the server for Laravel apps and add the ones you pick">
            <ScanSearch className="size-3.5" /> Discover apps…
          </Btn>
          <Btn size="sm" variant="outline" onClick={() => useNewApp.getState().open(server.id)} title="Set up a new Laravel app on this server: clone, .env, database, nginx, queue worker, HTTPS">
            <PackagePlus className="size-3.5" /> New app…
          </Btn>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- app

function AppDetails({ server, app }: { server: Server; app: App | null }) {
  const [name, setName] = useState(app?.name ?? "");
  // Kemudi's own key for it, from the name when it's added; never changed.
  const id = app ? app.id : freeId(name, server.apps.map((a) => a.id), "app");
  const [path, setPath] = useState(app?.path ?? "");
  const [branch, setBranch] = useState(app?.branch ?? "");
  const [php, setPhp] = useState(app?.php ?? "");
  const [color, setColor] = useState<TabColor | null>(app?.color ?? null);
  // "same": follow the server's environment.
  const [appEnv, setAppEnv] = useState<Env | "same">(app?.envSet ? app.env : "same");
  const [repo, setRepo] = useState(app?.repo ?? "");
  const [url, setUrl] = useState(app?.url ?? "");
  const [urlNote, setUrlNote] = useState<{ text: string; others: string[] } | null>(null);
  const [detectingUrl, setDetectingUrl] = useState(false);
  const [vhostFiles, setVhostFiles] = useState<string[]>(app?.vhostFiles ?? []);
  const [supervisorFiles, setSupervisorFiles] = useState<string[]>(app?.supervisorFiles ?? []);
  const [detecting, setDetecting] = useState(false);
  const [repoNote, setRepoNote] = useState<string | null>(null);
  const [phpNote, setPhpNote] = useState<{ text: string; warn: boolean } | null>(null);
  const [detectingPhp, setDetectingPhp] = useState(false);
  const { busy, run } = useBusy();

  const idOk = app ? true : name.trim() !== "" && VALID_ID.test(id);
  const form = {
    id,
    name: name.trim() && name.trim() !== id ? name.trim() : null,
    path: path.trim(),
    branch: branch.trim() || null,
    php: php.trim() || null,
    color,
    env: appEnv === "same" ? null : appEnv,
    repo: repo.trim() || null,
    url: url.trim().replace(/\/+$/, "") || null,
    vhostFiles,
    supervisorFiles,
  };
  const dirty =
    !app ||
    form.id !== app.id ||
    (form.name ?? form.id) !== app.name ||
    form.path !== app.path ||
    form.branch !== app.branch ||
    form.php !== app.php ||
    form.color !== app.color ||
    form.env !== (app.envSet ? app.env : null) ||
    form.repo !== app.repo ||
    (form.url ?? null) !== (app.url ?? null) ||
    JSON.stringify(vhostFiles) !== JSON.stringify(app.vhostFiles) ||
    JSON.stringify(supervisorFiles) !== JSON.stringify(app.supervisorFiles);
  const valid = idOk && form.path !== "";

  const save = async () => {
    if (!valid || busy) return;
    if (await run(() => appSave(server.id, app?.id ?? null, form))) {
      done(app ? `Saved ${form.name ?? form.id}` : `Added ${form.name ?? form.id} to ${server.name}`);
      openDetails({ kind: "app", serverId: server.id, appId: form.id });
    }
  };
  const remove = async () => {
    if (!app) return;
    const ok = await askConfirm(
      `Delete ${app.name}?`,
      `Removes it from ${server.name} in Kemudi. Nothing on the server changes.`,
    );
    if (ok && (await run(() => appDelete(server.id, app.id)))) {
      done(`Deleted ${app.name}`);
      openDetails({ kind: "server", serverId: server.id });
    }
  };

  const title = app ? app.name : name.trim() || "New app";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Page
        badge={<Badge id={`${server.id}/${app?.id ?? (id || "new")}`} name={title} size={40} />}
        title={
          <>
            <span className="truncate">{title}</span>
            <EnvTag env={appEnv === "same" ? server.env : appEnv} />
          </>
        }
        sub={
          <button
            type="button"
            className="cursor-pointer hover:text-foreground"
            onClick={() => openDetails({ kind: "server", serverId: server.id })}
          >
            on {server.name} ({server.host})
          </button>
        }
        footer={
          <>
            {app && (
              <Btn variant="ghost" className="px-2.5 text-env-prod-fg" disabled={busy} onClick={() => void remove()}>
                Delete…
              </Btn>
            )}
            <span className="flex-1" />
            {app ? (
              <>
                <Btn type="submit" variant="outline" disabled={!dirty || !valid || busy}>
                  Save
                </Btn>
                <Btn
                  variant="outline"
                  onClick={() => openFiles(server, { appId: app.id, dir: app.path, env: app.env, title: `${app.id} · files` })}
                >
                  <FolderOpen className="size-4" /> Files
                </Btn>
                <Btn variant="outline" onClick={() => openLogs(server, { appId: app.id, env: app.env, title: `${app.id} · logs` })}>
                  <ScrollText className="size-4" /> Logs
                </Btn>
                <Btn variant="outline" onClick={() => openQueues(server, app)}>
                  <ListChecks className="size-4" /> Queues
                </Btn>
                <Btn variant="primary" className="px-4" onClick={() => shellFor(server, app)}>
                  Open shell
                </Btn>
              </>
            ) : (
              <Btn type="submit" variant="primary" className="px-4" disabled={!valid || busy}>
                Add app
              </Btn>
            )}
          </>
        }
        after={
          app && (
            <div className="text-center text-[11.5px] text-subtle-foreground">
              This app's actions are in the panel on the right (⌘J).
            </div>
          )
        }
        side={
          <>
            <InspectPanel
              serverId={server.id}
              appId={app?.id ?? null}
              path={path}
              prod={(app?.env ?? server.env) === "prod"}
              env={app?.env ?? server.env}
              serverEnv={server.env}
              appName={app?.name ?? (name || "app")}
              branch={branch}
              php={php}
              onUseBranch={setBranch}
              onUsePhp={setPhp}
              vhostFiles={vhostFiles}
              supervisorFiles={supervisorFiles}
              onVhostFiles={setVhostFiles}
              onSupervisorFiles={setSupervisorFiles}
            />
          </>
        }
      >
        <Row label="Name">
          <TextInput
            autoFocus={!app}
            value={name}
            placeholder="Billing"
            className="font-sans"
            onChange={(e) => setName(e.target.value)}
          />
        </Row>
        <Row label="Path" hint="Where the app lives on the server; actions and Open shell start here">
          <TextInput value={path} placeholder={`/var/www/${id || "app"}`} onChange={(e) => setPath(e.target.value)} />
        </Row>
        <Row
          label="URL"
          hint={
            urlNote ? (
              <span className="flex flex-wrap items-center gap-1.5">
                {urlNote.text}
                {urlNote.others.map((u) => (
                  <button key={u} type="button" className="cursor-pointer font-mono text-primary hover:underline" onClick={() => setUrl(u)}>
                    {u}
                  </button>
                ))}
              </span>
            ) : (
              "Optional. Where it is on the web; Detect reads APP_URL and the names its vhost serves; usable as {{ app.url }}"
            )
          }
        >
          <div className="flex items-center gap-2">
            <TextInput value={url} placeholder="https://app.example.com" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
            <Btn
              size="sm"
              variant="outline"
              disabled={detectingUrl || !path.trim()}
              title={path.trim() ? `Ask ${server.id} where ${path.trim()} is served` : "Set the path first"}
              onClick={async () => {
                setDetectingUrl(true);
                setUrlNote(null);
                try {
                  const r = await appDetectUrl(server.id, path.trim());
                  if (r.url) setUrl(r.url);
                  const others = r.urls.filter((u) => u !== r.url);
                  setUrlNote({
                    text: r.url ? `From ${r.source ?? "the server"}.${r.url !== (app?.url ?? "") ? " Save to keep it." : ""}${others.length ? " Also answers on:" : ""}` : `No vhost or APP_URL says where it's served.`,
                    others,
                  });
                } catch (e) {
                  setUrlNote({ text: errorMessage(e), others: [] });
                } finally {
                  setDetectingUrl(false);
                }
              }}
            >
              {detectingUrl ? "Detecting…" : "Detect"}
            </Btn>
            {/^https?:\/\/\S+$/.test(url.trim()) && (
              <Btn size="sm" variant="ghost" title={`Open ${url.trim()} in the browser`} onClick={() => void openUrl(url.trim()).catch((e) => toastError(errorMessage(e)))}>
                Open ↗
              </Btn>
            )}
          </div>
        </Row>
        <Row label="Branch" hint="Optional. Git pull uses it; empty = the current branch">
          <TextInput value={branch} placeholder="main" onChange={(e) => setBranch(e.target.value)} />
        </Row>
        <Row
          label="Git remote"
          hint={
            repoNote ??
            "Optional. Detect asks the server (git remote get-url origin in the path above); usable as {{ app.repo }}"
          }
        >
          <TextInput
            value={repo}
            title={repo || undefined}
            placeholder="git@github.com:org/repo.git"
            onChange={(e) => setRepo(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Btn
              size="sm"
              variant="outline"
              disabled={detecting || !path.trim()}
              title={path.trim() ? `Read origin from ${path.trim()} on ${server.id}` : "Set the path first"}
              onClick={async () => {
                setDetecting(true);
                setRepoNote(null);
                try {
                  const url = await appDetectRepo(server.id, path.trim());
                  setRepo(url);
                  setRepoNote(`Found on ${server.id}. Save to keep it.`);
                } catch (e) {
                  setRepoNote(errorMessage(e));
                } finally {
                  setDetecting(false);
                }
              }}
            >
              {detecting ? "Detecting…" : "Detect"}
            </Btn>
            {repoWebUrl(repo) && (
              <Btn
                size="sm"
                variant="ghost"
                title={repoWebUrl(repo) ?? undefined}
                onClick={() => void openUrl(repoWebUrl(repo)!).catch((e) => toastError(errorMessage(e)))}
              >
                Open on {new URL(repoWebUrl(repo)!).host} ↗
              </Btn>
            )}
          </div>
        </Row>
        <Row
          label="PHP"
          hint={
            phpNote ? (
              <span className={cn(phpNote.warn && "text-env-staging-fg")}>{phpNote.text}</span>
            ) : (
              "Optional. 8.4 runs php8.4; empty = php. Detect asks the server what the web server runs it with"
            )
          }
        >
          <div className="flex items-center gap-2">
            <TextInput className="w-[120px]" value={php} placeholder="8.4" onChange={(e) => setPhp(e.target.value)} />
            <Btn
              size="sm"
              variant="outline"
              disabled={detectingPhp || !path.trim()}
              title={path.trim() ? `Ask ${server.id} which PHP runs ${path.trim()}` : "Set the path first"}
              onClick={async () => {
                setDetectingPhp(true);
                setPhpNote(null);
                try {
                  const r = await appDetectPhp(server.id, path.trim());
                  if (r.version) setPhp(r.version);
                  const parts = [
                    r.version ? `PHP ${r.version} from ${r.source ?? "the server"}.` : `Nothing on ${server.id} says which PHP runs it.`,
                    r.note,
                    r.composer && !r.note ? `composer.json: ${r.composer}.` : null,
                    r.installed.length ? `Installed: ${r.installed.join(", ")}.` : null,
                    r.version && r.version !== (app?.php ?? "") ? "Save to keep it." : null,
                  ];
                  setPhpNote({ text: parts.filter(Boolean).join(" "), warn: !!r.note || !r.version });
                } catch (e) {
                  setPhpNote({ text: errorMessage(e), warn: true });
                } finally {
                  setDetectingPhp(false);
                }
              }}
            >
              {detectingPhp ? "Detecting…" : "Detect"}
            </Btn>
          </div>
        </Row>
        <Row
          label="Environment"
          hint={
            appEnv === "same"
              ? "This app's actions, .env and cron get the server's guardrails"
              : "For this app's actions, .env and cron. The server's own (its ssh tab, vhosts, Supervisor) stays " + ENV_NAMES[server.env]
          }
        >
          <Segmented
            label="Environment"
            value={appEnv}
            onChange={setAppEnv}
            options={[{ value: "same" as const, label: `Server's (${envLabelShort(server.env)})` }, ...ENVS]}
          />
        </Row>
        <Row
          label="Tab colour"
          hint={server.color && !color ? `Empty: the server's colour (${server.color})` : "New tabs for this app"}
        >
          <ColorPicker value={color} onChange={setColor} />
        </Row>
      </Page>
    </form>
  );
}
