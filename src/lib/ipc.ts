// Typed wrappers around Kemudi's Tauri commands. Keep every `invoke` here.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { TabColor } from "@/lib/tabColors";

export type SpawnSpec = { kind: "local"; cwd?: string } | { kind: "ssh"; host: string; cwd?: string };

export type PtyEvent =
  | { type: "actionExit"; code: number; elapsedMs: number }
  | { type: "exit"; code: number | null }
  /** Frontend-only: an ended shell tab was started again (↵). */
  | { type: "restart" };

/** Shape of every error returned by a Kemudi command. */
export interface AppError {
  kind: string;
  message: string;
}

export function errorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as AppError).message);
  }
  return String(e);
}

export function spawnPty(
  spec: SpawnSpec,
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onEvent: (event: PtyEvent) => void,
): Promise<number> {
  const data = new Channel<ArrayBuffer>();
  data.onmessage = (buf) => onData(new Uint8Array(buf));
  const events = new Channel<PtyEvent>();
  events.onmessage = onEvent;
  return invoke<number>("pty_spawn", { spec, cols, rows, onData: data, onEvent: events });
}

/** `data` is text, or raw bytes for xterm's binary (legacy mouse) output. */
export function writePty(id: number, data: string | number[]): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function resizePty(id: number, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function killPty(id: number): Promise<void> {
  return invoke("pty_kill", { id });
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}

export interface ToolLocation {
  name: string;
  path: string | null;
}

export interface EnvReport {
  shell: string;
  path: string[];
  sshAuthSock: string | null;
  agent: string;
  agentState: "ok" | "empty" | "unavailable";
  tools: ToolLocation[];
  warning: string | null;
}

export function envReport(): Promise<EnvReport> {
  return invoke("env_report");
}

/** An SSH host Kemudi keeps in ~/.ssh/config.d/kemudi.conf. */
export interface HostEntry {
  alias: string;
  hostname: string;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  jump: string | null;
  /** Other ssh options, `Key value` per line, kept as written. */
  extra: string[];
}

export interface HostInfo {
  alias: string;
  known: boolean;
  /** Why "Manage in Kemudi" can't move one of the user's hosts (null: it can). */
  adoptBlocker: string | null;
  managed: HostEntry | null;
  /** The user's own Host block in ~/.ssh/config, as written. */
  external: HostEntry | null;
  resolved: { hostname: string | null; user: string | null; port: number | null; proxyjump: string | null } | null;
}

export const sshHostInfo = (alias: string): Promise<HostInfo> => invoke("ssh_host_info", { alias });
export const sshHostSave = (original: string | null, entry: HostEntry): Promise<void> =>
  invoke("ssh_host_save", { original, entry });
export const sshKeys = (): Promise<string[]> => invoke("ssh_keys");
export const sshManagedHosts = (): Promise<HostEntry[]> => invoke("ssh_managed_hosts");
export const sshHostDelete = (alias: string): Promise<void> => invoke("ssh_host_delete", { alias });
export const sshHostAdopt = (alias: string): Promise<HostEntry> => invoke("ssh_host_adopt", { alias });
export const sshConfigOpen = (): Promise<void> => invoke("ssh_config_open");
export const sshTest = (alias: string | null, entry: HostEntry | null): Promise<{ ok: boolean; message: string }> =>
  invoke("ssh_test", { alias, entry });

// ------------------------------------------------------------- tab configs

export interface PaneDef {
  id: string;
  type?: string;
  split?: string;
  children?: string[];
  directory?: string;
  commands?: string[];
}

export interface TabConfig {
  name: string;
  title?: string;
  color?: string;
  panes: PaneDef[];
  params?: Record<string, unknown>;
}

export type ConfigLayout =
  | { type: "pane"; id: string; directory: string | null; commands: string[] }
  | { type: "split"; dir: "row" | "col"; children: ConfigLayout[] };

export interface TabConfigEntry {
  file: string;
  /** kemudi: editable; warp: read from ~/.warp/tab_configs. */
  source: "kemudi" | "warp";
  config: TabConfig;
  layout: ConfigLayout | null;
  error: string | null;
}

export const tabConfigsList = (): Promise<TabConfigEntry[]> => invoke("tab_configs_list");
export const tabConfigSave = (file: string | null, config: TabConfig): Promise<string> =>
  invoke("tab_config_save", { file, config });
export const tabConfigDelete = (file: string): Promise<void> => invoke("tab_config_delete", { file });
export const tabConfigsReveal = (): Promise<void> => invoke("tab_configs_reveal");

// ----------------------------------------------------------------- monitor

export interface MonitorProc {
  pid: number;
  user: string;
  cpu: number;
  memPct: number;
  rssKb: number;
  time: string;
  command: string;
}

export interface MonitorDisk {
  mount: string;
  fs: string;
  sizeKb: number;
  usedKb: number;
  availKb: number;
}

export interface MonitorSample {
  uptimeS: number;
  load: [number, number, number];
  cores: number;
  cpuPct: number;
  memTotalKb: number;
  memAvailableKb: number;
  memCacheKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
  disks: MonitorDisk[];
  topCpu: MonitorProc[];
  topMem: MonitorProc[];
  os: string;
  kernel: string;
}

/** One read-only sample over ssh (~1 s of CPU measuring). */
export const monitorSample = (serverId: string): Promise<MonitorSample> => invoke("monitor_sample", { serverId });
/** The git remote (origin) of a folder on a server, read over ssh. */
export const appDetectRepo = (serverId: string, path: string): Promise<string> =>
  invoke("app_detect_repo", { serverId, path });

/** git@github.com:org/repo.git → https://github.com/org/repo (no credentials).
 *  An ssh alias like `github-app` (a deploy-key nickname in the server's ssh
 *  config) maps to the site it names. */
export function repoWebUrl(remote: string): string | null {
  const r = remote.trim();
  const site = (host: string) => {
    if (host.includes(".")) return host;
    const h = host.toLowerCase();
    if (h.includes("github")) return "github.com";
    if (h.includes("gitlab")) return "gitlab.com";
    if (h.includes("bitbucket")) return "bitbucket.org";
    return null;
  };
  const web = (host: string, path: string) => {
    const s = site(host);
    return s ? `https://${s}/${path}` : null;
  };
  let m = r.match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/);
  if (m) return web(m[1]!, m[2]!);
  m = r.match(/^(?:ssh|git\+ssh):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (m) return web(m[1]!, m[2]!);
  m = r.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return web(m[1]!, m[2]!);
  return null;
}

// ------------------------------------------------------------- app inspect

export interface Vhost {
  file: string;
  kind: "nginx" | "apache";
  serverNames: string[];
  listens: string[];
  root: string | null;
  ssl: boolean;
  phpSocket: string | null;
  phpVersion: string | null;
  /** The whole file. */
  config: string;
  /** Root uses a variable: one vhost for many apps. */
  wildcard: boolean;
}

export interface SupervisorProgram {
  file: string;
  name: string;
  command: string | null;
  numprocs: string | null;
  user: string | null;
  status: string[];
  /** The whole file it's in. */
  config: string;
}

export interface EnvVar {
  key: string;
  value: string;
  secret: boolean;
}

export interface Inspection {
  branch: string | null;
  lastCommit: string | null;
  laravel: string | null;
  vhosts: Vhost[];
  programs: SupervisorProgram[];
  cron: string[];
  /** Where the cron lines live: "user:<name>" or "file:<path>". */
  cronSources?: string[];
  env: EnvVar[] | null;
  envError: string | null;
  vhostCandidates: string[];
  supervisorCandidates: string[];
  missing: string[];
  /** Config files there that only root can read (no working sudo). */
  denied?: string[];
  /** "root" | "ok" | "needpw" | "badpw" | "none": how Kemudi got root. */
  sudo?: string;
  /** Why the .env secrets couldn't be kept (encrypted) for next launch. */
  secretCacheError: string | null;
}

/** What the server says about an app's folder (read-only on the server;
 *  .env secret values are kept encrypted on this Mac for next launch). */
export const appInspect = (serverId: string, path: string, vhostFiles: string[], supervisorFiles: string[]): Promise<Inspection> =>
  invoke("app_inspect", { serverId, path, vhostFiles, supervisorFiles });

/** The .env secret values the app's last Inspect kept (decrypted). */
export const inspectSecrets = (serverId: string, path: string): Promise<Record<string, string>> =>
  invoke("inspect_secrets", { serverId, path });
/** After the Keychain prompt was refused: ask again on the next read. */
export const inspectSecretsRetry = (): Promise<void> => invoke("inspect_secrets_retry");

/** Just the disks (background disk alerts). */
export const monitorDisks = (serverId: string): Promise<MonitorDisk[]> => invoke("monitor_disks", { serverId });

export function sshHosts(): Promise<string[]> {
  return invoke("ssh_hosts");
}

// ------------------------------------------------------------------ config

export type Env = "prod" | "staging" | "qa" | "dev";
export type Vpn = "none" | "openfortivpn" | "globalprotect";

export interface HostPort {
  host: string;
  port: number;
}

/** How much to ask before running: run on click / show the command / type the server name. */
export type Confirm = "none" | "warn" | "type";

/** Same rule as the backend's Confirm::default_for. */
export function defaultConfirm(env: Env, danger: boolean): Confirm {
  if (env === "prod") return danger ? "type" : "warn";
  return danger ? "warn" : "none";
}

export interface Action {
  id: string;
  label: string;
  run: string;
  danger: boolean;
  /** Explicit `confirm:` in servers.yaml (null = default). */
  confirm: Confirm | null;
  kind: "ssh" | "local";
  /** 1-based line of its definition in servers.yaml. */
  line: number | null;
  /** The command comes from the shared list (every app/server). */
  shared: boolean;
  /** It comes from this team's shared list (not the global one). */
  team: string | null;
  /** The id is in the shared list (shared, or changed here). */
  inherited: boolean;
}

export interface App {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  php: string | null;
  /** Default colour for this app's tabs (else the server's). */
  color: TabColor | null;
  /** The app's environment: its own, else the server's. */
  env: Env;
  /** The app sets its own environment (not inherited from the server). */
  envSet: boolean;
  /** Git remote URL. */
  repo: string | null;
  /** Where it is on the web. */
  url: string | null;
  /** Config files Inspect always reads (e.g. a wildcard vhost). */
  vhostFiles: string[];
  supervisorFiles: string[];
  vars: Record<string, string>;
  actions: Action[];
  /** Shared actions hidden on this app. */
  hidden: Action[];
}

export interface Server {
  id: string;
  name: string;
  /** Its team's id (null: no team). */
  team: string | null;
  host: string;
  env: Env;
  vpn: Vpn;
  vpnCheck: HostPort | null;
  vpnConnect: string | null;
  check: HostPort | null;
  /** Default colour for this server's tabs. */
  color: TabColor | null;
  /** Shell New app runs before the clone / after everything (after its team's). */
  newApp: NewAppHooks;
  apps: App[];
  actions: Action[];
  /** Shared server actions hidden on this server. */
  hidden: Action[];
}

export interface TerminalSettings {
  fontFamily?: string | null;
  fontSize?: number | null;
  lineHeight?: number | null;
  optionAsMeta?: boolean | null;
  scrollback?: number | null;
  shellIntegration?: boolean | null;
}

export type Editor = "sublime" | "vscode" | "phpstorm" | "system";

export interface SettingsForm {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  optionAsMeta: boolean;
  scrollback: number;
  shellIntegration: boolean;
  editor: Editor | null;
}

export const settingsSave = (settings: SettingsForm): Promise<ConfigSnapshot> => invoke("settings_save", { settings });

/** A team servers belong to (like DigitalOcean teams). */
export interface Team {
  id: string;
  name: string;
  color: TabColor | null;
  /** New app hooks for its servers (run before the server's own). */
  newApp: NewAppHooks;
}

export interface Config {
  teams: Team[];
  servers: Server[];
  terminal: TerminalSettings;
  editor: Editor | null;
}

export interface Diag {
  message: string;
  line: number | null;
  column: number | null;
  path: string | null;
  suggestion: string | null;
}

export interface ConfigSnapshot {
  path: string;
  displayPath: string;
  exists: boolean;
  config: Config | null;
  errors: Diag[];
  warnings: Diag[];
  stale: boolean;
  loadedAt: string | null;
}

export const CONFIG_CHANGED = "config://changed";

export const configGet = (): Promise<ConfigSnapshot> => invoke("config_get");
export const configReload = (): Promise<ConfigSnapshot> => invoke("config_reload");
export const configCreate = (): Promise<ConfigSnapshot> => invoke("config_create");
export const configOpen = (line?: number | null): Promise<void> => invoke("config_open", { line: line ?? null });
export const configReveal = (): Promise<void> => invoke("config_reveal");

// ----------------------------------------------------------------- actions

export interface ActionRef {
  serverId: string;
  appId: string | null;
  actionId: string;
  /** Values for the action's own variables (`{{ ip }}`). */
  values?: Record<string, string>;
}

/** A variable in an action's command that isn't from Kemudi's config,
 *  asked for at run time. */
export interface ActionParam {
  name: string;
  default: string | null;
  optional: boolean;
}

export interface RenderedAction extends ActionRef {
  label: string;
  title: string;
  command: string;
  rendered: string;
  kind: "ssh" | "local";
  danger: boolean;
  confirm: Confirm;
  confirmExplicit: boolean;
  env: Env;
  host: string;
  vpn: Vpn;
  cwd: string | null;
  params: ActionParam[];
  /** Required params with no value yet (shown as `<name>`). */
  missing: string[];
  values: Record<string, string>;
}

export interface RunInfo {
  ptyId: number;
  action: RenderedAction;
  edited: boolean;
  auditId: number | null;
}

export const actionRender = (action: ActionRef): Promise<RenderedAction> => invoke("action_render", { action });

/** Save how much this one action asks (null = back to the default). */
/** An action's command as written in servers.yaml. */
export interface ActionDefinition {
  /** The `run:` template, before `{{ … }}` is filled in. */
  run: string;
  line: number | null;
  /** e.g. `actions.app` when the command comes from the shared global entry. */
  shared: string | null;
}

export const actionDefinition = (action: ActionRef): Promise<ActionDefinition> =>
  invoke("action_definition", { action });

export const actionSetRun = (
  action: ActionRef,
  run: string,
  label: string | null,
  everywhere: boolean,
): Promise<ConfigSnapshot> => invoke("action_set_run", { action, run, label, everywhere });

/** Where a new action goes: one app or server, or a shared list. */
export type ActionScope =
  | { kind: "app"; serverId: string; appId: string }
  | { kind: "server"; serverId: string }
  | { kind: "sharedApp" }
  | { kind: "sharedServer" }
  | { kind: "teamApp"; teamId: string }
  | { kind: "teamServer"; teamId: string };

export interface NewAction {
  id: string;
  label: string | null;
  run: string;
  danger: boolean;
  local: boolean;
}

export type RemoveMode = "delete" | "reset" | "hide" | "unhide" | "deleteShared";

export const actionAdd = (scope: ActionScope, action: NewAction): Promise<ConfigSnapshot> =>
  invoke("action_add", { scope, action });
export const actionRemove = (action: ActionRef, mode: RemoveMode): Promise<ConfigSnapshot> =>
  invoke("action_remove", { action, mode });

// ------------------------------------------------- servers and apps (forms)

export interface ServerForm {
  id: string;
  name: string | null;
  team: string | null;
  host: string;
  env: Env;
  vpn: Vpn;
  vpnCheck: HostPort | null;
  vpnConnect: string | null;
  check: HostPort | null;
  color: TabColor | null;
}

export interface AppForm {
  id: string;
  name: string | null;
  path: string;
  branch: string | null;
  php: string | null;
  color: TabColor | null;
  /** null: the same as the server. */
  env: Env | null;
  repo: string | null;
  url?: string | null;
  vhostFiles: string[];
  supervisorFiles: string[];
}

/** Add (`original` null) or edit a team. */
export const teamSave = (original: string | null, team: { id: string; name: string | null; color: TabColor | null }): Promise<ConfigSnapshot> =>
  invoke("team_save", { original, team });
/** Delete a team: its servers stay (with no team); its shared actions go. */
export const teamDelete = (id: string): Promise<ConfigSnapshot> => invoke("team_delete", { id });

/** Add (`original` null) or edit a server; written to servers.yaml. */
export const serverSave = (original: string | null, server: ServerForm): Promise<ConfigSnapshot> =>
  invoke("server_save", { original, server });
export const serverDelete = (id: string): Promise<ConfigSnapshot> => invoke("server_delete", { id });
export const appSave = (serverId: string, original: string | null, form: AppForm): Promise<ConfigSnapshot> =>
  invoke("app_save", { serverId, original, form });
export const appDelete = (serverId: string, id: string): Promise<ConfigSnapshot> =>
  invoke("app_delete", { serverId, id });

export const actionSetDanger = (action: ActionRef, danger: boolean): Promise<ConfigSnapshot> =>
  invoke("action_set_danger", { action, danger });

export const actionSetConfirm = (action: ActionRef, confirm: Confirm | null): Promise<ConfigSnapshot> =>
  invoke("action_set_confirm", { action, confirm });

export function actionRun(
  action: ActionRef,
  commandOverride: string | null,
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onEvent: (event: PtyEvent) => void,
): Promise<RunInfo> {
  const data = new Channel<ArrayBuffer>();
  data.onmessage = (buf) => onData(new Uint8Array(buf));
  const events = new Channel<PtyEvent>();
  events.onmessage = onEvent;
  return invoke("action_run", { action, commandOverride, cols, rows, onData: data, onEvent: events });
}

export const actionSend = (ptyId: number, action: ActionRef, commandOverride: string | null): Promise<RenderedAction> =>
  invoke("action_send", { ptyId, action, commandOverride });

// ------------------------------------------------------------ reachability

export type ReachState = "up" | "down" | "unknown" | "checking";

export interface ServerStatus {
  serverId: string;
  state: ReachState;
  target: string | null;
  via: "vpn_check" | "check" | "ssh" | "jump" | null;
  latencyMs: number | null;
  error: string | null;
  checkedAt: string | null;
}

export const STATUS_CHANGED = "status://changed";
export const statusGet = (): Promise<ServerStatus[]> => invoke("status_get");
export const statusRefresh = (serverIds?: string[]): Promise<ServerStatus[]> =>
  invoke("status_refresh", { serverIds: serverIds ?? null });

export function vpnConnect(
  serverId: string,
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onEvent: (event: PtyEvent) => void,
): Promise<number> {
  const data = new Channel<ArrayBuffer>();
  data.onmessage = (buf) => onData(new Uint8Array(buf));
  const events = new Channel<PtyEvent>();
  events.onmessage = onEvent;
  return invoke("vpn_connect", { serverId, cols, rows, onData: data, onEvent: events });
}

// --------------------------------------------------------------- audit log

export interface AuditRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  serverId: string;
  appId: string | null;
  actionId: string;
  label: string;
  env: Env;
  kind: "ssh" | "local" | "send";
  command: string;
  edited: boolean;
  exitCode: number | null;
}

export interface AuditQuery {
  query?: string;
  env?: Env | "all";
  exit?: "any" | "ok" | "failed" | "running";
  sinceMs?: number | null;
  limit?: number;
  offset?: number;
}

export const auditList = (query: AuditQuery): Promise<{ runs: AuditRun[]; total: number }> =>
  invoke("audit_list", { query });

// ----------------------------------------------------------------- session

export const sessionLoad = (): Promise<unknown> => invoke("session_load");
export const sessionSave = (session: unknown): Promise<void> => invoke("session_save", { session });

// ------------------------------------------------------------- snippets

/** A saved command with notes (~/.config/kemudi/snippets.yaml). */
export interface Snippet {
  id: string;
  name: string;
  command: string;
  notes: string;
  /** Shown only in this team (absent: every team). */
  team?: string | null;
}

export interface SnippetInput {
  /** null: a new snippet. */
  id: string | null;
  name: string;
  command: string;
  notes: string;
  team?: string | null;
}

export const snippetsList = (): Promise<Snippet[]> => invoke("snippets_list");
export const snippetSave = (snippet: SnippetInput): Promise<Snippet[]> => invoke("snippet_save", { snippet });
export const snippetDelete = (id: string): Promise<Snippet[]> => invoke("snippet_delete", { id });

// ------------------------------------------------------- remote file edits

/** A file on a server Kemudi can edit. */
export type RemoteFileTarget =
  | { kind: "env"; appId: string }
  | { kind: "supervisor"; file: string }
  | { kind: "cronFile"; file: string }
  /** A user's crontab; null = the ssh user. */
  | { kind: "crontab"; user: string | null }
  | { kind: "vhost"; file: string; web: "nginx" | "apache" }
  /** Any file (from the file explorer). */
  | { kind: "path"; path: string };

export interface RemoteFile {
  path: string;
  content: string;
  sha: string;
  /** direct: as the ssh user · sudo: passwordless sudo · none: can't write. */
  access: "direct" | "sudo" | "none";
  /** Laravel config is cached: .env edits do nothing until re-cached. */
  configCached: boolean;
}

export type WriteResult =
  | {
      outcome: "saved";
      backup: string;
      summary: string;
      /** `supervisorctl reread` / `nginx -t` output. */
      check: string | null;
      /** The config test already failed before this change (so it stayed). */
      wasFailing: boolean;
    }
  /** The config test failed with the change: the old file is back. */
  | { outcome: "rejected"; check: string }
  | { outcome: "conflict" };

export const remoteFileRead = (serverId: string, target: RemoteFileTarget): Promise<RemoteFile> =>
  invoke("remote_file_read", { serverId, target });
/** Writes `content` only if the file still matches `original`; keeps a backup. */
export const remoteFileWrite = (
  serverId: string,
  target: RemoteFileTarget,
  original: string,
  content: string,
  appId: string | null,
): Promise<WriteResult> => invoke("remote_file_write", { serverId, target, original, content, appId });
/** Put back the backup a save made. */
export const remoteFileRestore = (serverId: string, target: RemoteFileTarget, backup: string, appId: string | null): Promise<{ check: string | null }> =>
  invoke("remote_file_restore", { serverId, target, backup, appId });

// ------------------------------------------------------------ saved passwords

/** A saved password, without the password (that stays in Rust). */
export interface VaultEntry {
  id: string;
  name: string;
  username: string;
  notes: string;
  /** Servers it's the sudo password for (used when saving root-owned files). */
  sudoFor: string[];
}

export interface VaultEntryInput {
  /** null: a new one. */
  id: string | null;
  name: string;
  username: string;
  notes: string;
  sudoFor: string[];
  /** null keeps the saved password (required for a new one). */
  password: string | null;
}

/** A test copy started with KEMUDI_QUIET=1: no background checks. */
export const appQuiet = (): Promise<boolean> => invoke("app_quiet");

export const vaultList = (): Promise<VaultEntry[]> => invoke("vault_list");
export const vaultSave = (entry: VaultEntryInput): Promise<string> => invoke("vault_save", { entry });
export const vaultDelete = (id: string): Promise<void> => invoke("vault_delete", { id });
/** Rust types the password (+ ↵) into the terminal; the value never comes here. */
export const vaultFill = (ptyId: number, id: string, serverId: string | null): Promise<void> =>
  invoke("vault_fill", { ptyId, id, serverId });
/** Copies it to the clipboard (cleared after the returned seconds). */
export const vaultCopy = (id: string): Promise<number> => invoke("vault_copy", { id });

// ------------------------------------------------------------ new nginx vhost

/** What a server offers for a new vhost (read-only probe). */
export interface VhostProbe {
  nginx: boolean;
  phpSockets: string[];
  /** Names already in sites-available. */
  sites: string[];
  /** Let's Encrypt certificate names. */
  certs: string[];
  certbot: boolean;
  certbotOptions: boolean;
}

export type VhostCreated =
  | { outcome: "created"; path: string; check: string; wasFailing: boolean }
  /** nginx -t failed with it, so it was removed again. */
  | { outcome: "rejected"; check: string };

export const vhostProbe = (serverId: string): Promise<VhostProbe> => invoke("vhost_probe", { serverId });
export const vhostCreate = (serverId: string, appId: string | null, name: string, content: string): Promise<VhostCreated> =>
  invoke("vhost_create", { serverId, appId, name, content });

// ------------------------------------------------------------ file explorer

export interface FileEntry {
  name: string;
  kind: "dir" | "file" | "link" | "other";
  /** A link that points at a folder. */
  toDir: boolean;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  mode: string;
  owner: string;
  group: string;
  target: string | null;
}

export interface FileListing {
  dir: string;
  entries: FileEntry[];
  /** Listed with sudo. */
  sudo: boolean;
  truncated: boolean;
}

/** `dir` "~" is the ssh user's home. */
export const filesList = (serverId: string, dir: string): Promise<FileListing> => invoke("files_list", { serverId, dir });
/** Copies to `to` (else ~/Downloads); returns the local path. */
/** A folder (`folder`) comes down as name.tar.gz; `lean` leaves out vendor, node_modules and .git. */
export const filesDownload = (serverId: string, path: string, to: string | null, folder = false, lean = false): Promise<string> =>
  invoke("files_download", { serverId, path, to, folder, lean });
/** Copy (or `cut`: move) into `dir`; into its own folder it becomes "name copy". Returns the new path. */
export const filesPaste = (serverId: string, src: string, dir: string, cut: boolean, appId: string | null): Promise<string> =>
  invoke("files_paste", { serverId, src, dir, cut, appId });
export interface FoundFile {
  path: string;
  kind: string;
  line: number | null;
  text: string | null;
}
export const filesFind = (
  serverId: string,
  dir: string,
  query: string,
  contents: boolean,
  skipDeps: boolean,
): Promise<{ found: FoundFile[]; more: boolean; timedOut: boolean; sudo: boolean }> => invoke("files_find", { serverId, dir, query, contents, skipDeps });
/** The macOS folder picker; null when cancelled. */
export const filesChooseFolder = (start: string | null): Promise<string | null> => invoke("files_choose_folder", { start });
/** Uploads a local file into `dir`; returns the remote path. */
export const filesUpload = (serverId: string, local: string, dir: string, replace: boolean, appId: string | null): Promise<string> =>
  invoke("files_upload", { serverId, local, dir, replace, appId });
export const filesReveal = (path: string): Promise<void> => invoke("files_reveal", { path });
/** Users and groups worth offering for Change owner. */
export const filesPrincipals = (serverId: string): Promise<{ users: string[]; groups: string[] }> =>
  invoke("files_principals", { serverId });
/** chown [-R] owner:group (with sudo); returns the new owner:group. */
export const filesChown = (serverId: string, path: string, owner: string, group: string, recursive: boolean, appId: string | null): Promise<string> =>
  invoke("files_chown", { serverId, path, owner, group, recursive, appId });
/** chmod (`filesMode`: recursive, folders get `mode`, files `filesMode`); returns the new octal mode. */
export const filesChmod = (serverId: string, path: string, mode: string, filesMode: string | null, appId: string | null): Promise<string> =>
  invoke("files_chmod", { serverId, path, mode, filesMode, appId });
/** Rename in place (never over an existing name); returns the new path. */
export const filesRename = (serverId: string, path: string, name: string, appId: string | null): Promise<string> =>
  invoke("files_rename", { serverId, path, name, appId });
/** Delete a file, or a folder with everything in it. */
export const filesDelete = (serverId: string, path: string, appId: string | null): Promise<void> =>
  invoke("files_delete", { serverId, path, appId });
/** A new folder or empty file in `dir`; returns its path. */
export const filesCreate = (serverId: string, dir: string, name: string, folder: boolean, appId: string | null): Promise<string> =>
  invoke("files_create", { serverId, dir, name, folder, appId });

export interface LogFile {
  name: string;
  size: number;
  mtime: number;
}

/** A log and its daily files / rotations (newest first). */
export interface LogSource {
  /** `app:<id>`, `web`, `php`, `workers`, `system`. */
  group: string;
  dir: string;
  /** `laravel.log`, `error.log`, `syslog`. */
  base: string;
  files: LogFile[];
}

export interface LogChunk {
  path: string;
  size: number;
  inode: number;
  mtime: number;
  start: number;
  end: number;
  text: string;
  /** Not a continuation: first read, another file (new day, rotated) or cut short. */
  reset: boolean;
  /** Following: bytes jumped over. */
  skipped: number;
  sudo: boolean;
}

export interface QueueSize {
  name: string;
  size: number | null;
  reserved?: number | null;
  delayed?: number | null;
}

export interface FailedJob {
  id: string;
  connection: string;
  queue: string;
  failedAt: string;
  job: string;
  error: string;
}

export interface QueueStatus {
  /** Who artisan ran as. */
  user: string;
  workers: { program: string; process: string | null; state: string; info: string; command: string; file: string }[];
  processes: { pid: number; seconds: number; user: string; unit: string | null; command: string }[];
  /** Cron lines running schedule:run. */
  scheduler: string[];
  laravel: {
    connection: string;
    driver: string;
    queues: QueueSize[];
    queueError: string | null;
    failedDriver: string;
    failedTotal: number;
    failed: FailedJob[];
    failedError: string | null;
    horizon: boolean;
  } | null;
  laravelError: string | null;
}

export type QueueAct = "retry" | "retryAll" | "forget" | "flush" | "restart" | "restartProgram";

export const queuesStatus = (serverId: string, appId: string): Promise<QueueStatus> => invoke("queues_status", { serverId, appId });
export const queuesFailedDetail = (serverId: string, appId: string, id: string): Promise<{ exception: string; payload: string }> =>
  invoke("queues_failed_detail", { serverId, appId, id });
export const queuesAct = (serverId: string, appId: string, act: QueueAct, args: string[] = []): Promise<string> =>
  invoke("queues_act", { serverId, appId, act, args });

export interface HealthCert {
  name: string;
  file: string;
  appId: string | null;
  missing: boolean;
  via: string;
  notAfter: number | null;
  daysLeft: number | null;
  issuer: string;
  subject: string;
  sans: string[];
  covers: boolean;
  /** Expiry of a newer copy on disk: renewed, not reloaded. */
  newerOnDisk: number | null;
}

export interface Health {
  now: number;
  certs: HealthCert[];
  moreNames: number;
  renew: string[];
  /** certbot's last run failed: "certbot.service failed" and lines from its log. */
  renewErrors: string[];
  sslError: string | null;
  os: string;
  kernel: string;
  uptimeS: number;
  updates: number | null;
  securityUpdates: number | null;
  rebootRequired: boolean;
  rebootPkgs: string[];
  services: { name: string; active: string; sub: string }[];
  failedUnits: string[];
  apps: { id: string; missing: boolean; php: string | null; laravel: string | null; appEnv: string | null; appDebug: boolean | null; noEnv: boolean }[];
  sslOnly: boolean;
}

export interface ComposerAudit {
  advisories: { package: string; title: string; cve: string | null; link: string | null; severity: string | null; affected: string }[];
  abandoned: [string, string | null][];
}

export const healthCheck = (serverId: string, sslOnly = false): Promise<Health> => invoke("health_check", { serverId, sslOnly });
export const healthComposerAudit = (serverId: string, appId: string): Promise<ComposerAudit> => invoke("health_composer_audit", { serverId, appId });

export interface CertbotCert {
  name: string;
  domains: string[];
  notAfter: number | null;
  daysLeft: number | null;
  authenticator: string;
  /** Manual DNS challenge with no hook: needs you each time. */
  needsYou: boolean;
}
export interface RenewChallenge {
  n: number;
  domain: string;
  record: string;
  value: string;
  released: boolean;
}
export interface RenewStatus {
  challenges: RenewChallenge[];
  rc: number | null;
  log: string;
  running: boolean;
}
export interface DnsCheck {
  nameservers: [string, boolean][];
  google: boolean;
  zone: string;
}
export const certsList = (serverId: string): Promise<{ certs: CertbotCert[]; note: string | null }> => invoke("certs_list", { serverId });
export const certsRenewStart = (serverId: string, name: string, domains: string[]): Promise<string> => invoke("certs_renew_start", { serverId, name, domains });
export const certsRenewStatus = (serverId: string, dir: string): Promise<RenewStatus> => invoke("certs_renew_status", { serverId, dir });
export const certsRenewContinue = (serverId: string, dir: string, n: number): Promise<void> => invoke("certs_renew_continue", { serverId, dir, n });
/** Stops certbot if it's waiting, removes Kemudi's hook and session; `reload`: the web server (after a renewal that worked). */
export const certsRenewFinish = (serverId: string, dir: string, name: string, reload: boolean): Promise<string | null> =>
  invoke("certs_renew_finish", { serverId, dir, name, reload });
export const certsDnsCheck = (serverId: string, record: string, value: string): Promise<DnsCheck> => invoke("certs_dns_check", { serverId, record, value });

export interface DiscoveredApp {
  path: string;
  real: string;
  name: string;
  id: string;
  laravel: string | null;
  appName: string | null;
  appEnv: string | null;
  appUrl: string | null;
  branch: string | null;
  repo: string | null;
  php: string | null;
  phpSource: string | null;
  phpNote: string | null;
  composerPhp: string | null;
  url: string | null;
  urlSource: string | null;
  urls: string[];
  env: Env | null;
  vhostFiles: string[];
  supervisorFiles: string[];
  domains: string[];
  owner: string | null;
  /** Already in Kemudi as this app id. */
  existing: string | null;
}
export const discoverApps = (serverId: string): Promise<DiscoveredApp[]> => invoke("discover_apps", { serverId });
/** Where an app is on the web: APP_URL when its vhost serves that name, else the vhost's own name (https with TLS). */
export const appDetectUrl = (serverId: string, path: string): Promise<{ url: string | null; source: string | null; urls: string[] }> =>
  invoke("app_detect_url", { serverId, path });
/** The PHP version an app runs with: what nginx uses for it (socket, `set`/`if`, `map`), else its workers / cron, else composer.json. */
export const appDetectPhp = (
  serverId: string,
  path: string,
): Promise<{ version: string | null; source: string | null; note: string | null; composer: string | null; installed: string[] }> =>
  invoke("app_detect_php", { serverId, path });

export type TuneChange =
  | { kind: "pool"; version: string; file: string; key: string; value: string }
  | { kind: "phpIni"; version: string; key: string; value: string }
  | { kind: "mysql"; cnfDir: string; key: string; value: string }
  | { kind: "nginx"; context: string; key: string; value: string }
  | { kind: "sysctl"; key: string; value: string }
  | { kind: "swapfile"; mb: number };
export interface TuneSuggestion {
  id: string;
  area: string;
  setting: string;
  current: string;
  suggested: string;
  why: string;
  effect: string;
  level: "important" | "suggested" | "optional";
  change: TuneChange | null;
}
export interface Tuning {
  facts: {
    cpus: number;
    memTotalKb: number;
    memAvailableKb: number;
    swapTotalKb: number;
    swappiness: number | null;
    load: string;
    diskFreeKb: number;
    lastTune: string | null;
    fpm: { version: string; running: boolean; pools: { file: string; name: string }[]; workersKb: number[]; warnings: number }[];
    mysql: { rssKb: number; version: string | null; noLogin: boolean } | null;
    phpFiles: number;
    appsCounted: number;
  };
  budget: { totalKb: number; reserveKb: number; othersKb: number; mysqlKb: number; phpKb: number; phpNowKb: number; phpPlannedKb: number };
  suggestions: TuneSuggestion[];
  notes: string[];
}
export const tuneAnalyze = (serverId: string): Promise<Tuning> => invoke("tune_analyze", { serverId });
export const tuneApply = (serverId: string, changes: [string, TuneChange][]): Promise<{ done: string[]; failed: [string, string][]; notes: string[]; dir: string | null }> =>
  invoke("tune_apply", { serverId, changes });
export const tuneUndo = (serverId: string): Promise<string[]> => invoke("tune_undo", { serverId });

export const logsSources = (serverId: string, appId: string | null): Promise<LogSource[]> =>
  invoke("logs_sources", { serverId, appId });

/** No from/before: the last part. `from`: what's new (following). `before`: the part before. */
export const logsRead = (
  serverId: string,
  src: { dir: string; base: string; pin?: string | null },
  at: { from?: number; before?: number; inode?: number } = {},
): Promise<LogChunk> =>
  invoke("logs_read", { serverId, dir: src.dir, base: src.base, pin: src.pin ?? null, from: at.from ?? null, before: at.before ?? null, inode: at.inode ?? null });

// ------------------------------------------------------------------ new app

export interface PublicKey {
  path: string;
  key: string;
}

export interface NewAppProbe {
  vhost: VhostProbe;
  /** The SSH login user. */
  user: string;
  root: boolean;
  /** "8.4", "8.3"… */
  phpVersions: string[];
  /** Which of git, composer, node, npm, mysql, supervisorctl are there. */
  tools: string[];
  /** The login user's public keys: what the git host sees. */
  keys: PublicKey[];
  /** The most common owner of the server's apps' storage/. */
  owner: string | null;
  supervisorDir: string | null;
  supervisorExt: string;
  /** MySQL answers as root. */
  mysql: boolean;
  dbUsers: string[];
  databases: string[];
  /** Wildcard vhosts (one folder per subdomain) a new app can join. */
  wildcards: Wildcard[];
}

/** How a wildcard vhost picks PHP for a site. */
export type WildPhp =
  | { kind: "fixed"; version: string }
  /** `if ($http_host = "…") { set $var "8.4"; }` blocks in `file`. */
  | { kind: "ifs"; file: string; var: string; default: string | null; hosts: [string, string][] }
  | { kind: "other"; note: string };

/** `server_name ~^(?<sub>[^.]+).example.com` + `root /x/$sub/public`. */
export interface Wildcard {
  file: string;
  /** `/opt/www/x/$sub` */
  root: string;
  var: string;
  /** `.example.com` */
  suffix: string;
  ssl: boolean;
  php: WildPhp;
  /** A suggested `after` hook that sets a site's PHP the way this vhost does. */
  hook: string | null;
}

export interface NewAppHooks {
  before: string | null;
  after: string | null;
}

/** Save (or, blank, remove) a server's or team's New app hook. */
export const newAppHookSave = (
  scope: { kind: "server" | "team"; id: string },
  which: "before" | "after",
  text: string | null,
): Promise<ConfigSnapshot> => invoke("new_app_hook_save", { scope, which, text });

export interface RepoCheck {
  ok: boolean;
  branches: string[];
  defaultBranch: string | null;
  error: string | null;
}

export type NewAppDb = { mode: "none" } | { mode: "new" | "existing"; database: string; user: string };

export interface NewAppPlan {
  id: string;
  name: string;
  repo: string;
  branch: string | null;
  path: string;
  php: string;
  owner: string;
  appEnv: string;
  url: string | null;
  npm: boolean;
  migrate: boolean;
  seed: boolean;
  db: NewAppDb;
  vhost: { name: string; content: string } | null;
  worker: { file: string; processes: number } | null;
  certbot: string[];
  /** A cron.d entry for `artisan schedule:run` every minute. */
  schedule: boolean;
  /** The site's main name (`{{ app.domain }}` in hooks). */
  domain: string | null;
}

export const newappProbe = (serverId: string): Promise<NewAppProbe> => invoke("newapp_probe", { serverId });
/** git ls-remote on the server, with its own key. */
export const newappRepoCheck = (serverId: string, repo: string): Promise<RepoCheck> => invoke("newapp_repo_check", { serverId, repo });
export const newappCreateKey = (serverId: string): Promise<PublicKey> => invoke("newapp_create_key", { serverId });
export const newappScript = (serverId: string, plan: NewAppPlan): Promise<string> => invoke("newapp_script", { serverId, plan });

export function newappRun(
  serverId: string,
  plan: NewAppPlan,
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onEvent: (event: PtyEvent) => void,
): Promise<{ ptyId: number; auditId: number | null }> {
  const data = new Channel<ArrayBuffer>();
  data.onmessage = (buf) => onData(new Uint8Array(buf));
  const events = new Channel<PtyEvent>();
  events.onmessage = onEvent;
  return invoke("newapp_run", { serverId, plan, cols, rows, onData: data, onEvent: events });
}
