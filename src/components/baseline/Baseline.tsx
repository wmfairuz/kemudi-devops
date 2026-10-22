import { Plus, RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Spinner } from "@/components/kit/Spinner";
import { Field, TextInput } from "@/components/manage/fields";
import { triggerAction } from "@/lib/actions";
import { isAsg } from "@/lib/fleet";
import { asgInstances, baselineCheck, baselineInstall, baselineSave, errorMessage, type Baseline, type BaselineInstall, type BaselineStatus, type Server } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { useCurrentTeam, useTeamServers } from "@/stores/team";
import { askChoice, askConfirm } from "@/stores/confirm";
import { toastError, useToasts } from "@/stores/toasts";

/** What it says about one repo or line, and how worrying. */
type Item = { text: string; tone: "ok" | "warn" | "bad" | "dim"; title?: string };

/** Where two lines part: "…-uifr -d'" vs "…-uifrc -d'" (from a word start). */
function differs(a: string, b: string): [string, string] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (p > 0 && !/[\s/'"=]/.test(a[p - 1]!)) p--;
  const tail = (x: string) => (p > 0 ? "…" : "") + x.slice(p);
  return [tail(a), tail(b)];
}

/** The aliases a check found yours (different, or defined twice), as
 *  "here vs baseline" lines for the Replace question. */
function ownAliases(statuses: (BaselineStatus | string)[]): string[] {
  const out = new Set<string>();
  for (const st of statuses) {
    if (typeof st === "string") continue;
    for (const l of st.lines) {
      const name = /^\s*alias\s+([\w-]+)=/.exec(l.line)?.[1];
      if (!name) continue;
      if (l.other) {
        const [here, base] = differs(l.other, l.line);
        out.add(`alias ${name}: here ${here}, baseline ${base}`);
      } else if (l.present && l.count > 1) out.add(`alias ${name}: defined ${l.count} times (the last one wins)`);
    }
  }
  return [...out];
}

function items(s: BaselineStatus): Item[] {
  const out: Item[] = s.repos.map((r) => {
    const at = r.at ? ` ${r.at}` : "";
    switch (r.state) {
      case "ok":
        return { text: `${r.name} ✓${at}`, tone: "ok" };
      case "behind":
        return { text: `${r.name}: update available${at ? ` (at${at})` : ""}`, tone: "warn" };
      case "ahead":
        return { text: `${r.name}: has local commits${at}`, tone: "warn" };
      case "missing":
        return { text: `${r.name}: missing`, tone: "bad" };
      case "notgit":
        return { text: `${r.name}: folder isn't a git clone`, tone: "bad" };
      default:
        return { text: `${r.name} ✓${at} (couldn't ask its remote)`, tone: "dim" };
    }
  });
  const cut = (t: string) => (t.length > 48 ? `${t.slice(0, 46)}…` : t);
  for (const l of s.lines) {
    const short = cut(l.line);
    const name = /^\s*alias\s+([\w-]+)=/.exec(l.line)?.[1];
    out.push(
      l.present === true && l.count > 1
        ? { text: `~/.bashrc: alias ${name} defined ${l.count} times (the last one wins)`, tone: "warn" }
        : l.present === true
          ? { text: `~/.bashrc: ${short} ✓`, tone: "ok" }
          : l.other
            ? (() => {
                const [here, base] = differs(l.other, l.line);
                return { text: `~/.bashrc: alias ${name} here ${here} · baseline ${base} (kept)`, tone: "warn" as const, title: `here:     ${l.other}\nbaseline: ${l.line}` };
              })()
            : l.present === false
              ? { text: `~/.bashrc: missing ${short}`, tone: "bad" }
              : { text: `~/.bashrc: couldn't read (needs root)`, tone: "dim" },
    );
  }
  return out;
}

const TONE: Record<Item["tone"], string> = {
  ok: "border-[#1f9d3a]/30 bg-[#1f9d3a]/8 text-[#17702a]",
  warn: "border-[#b7791f]/35 bg-[#b7791f]/10 text-[#8a5a12]",
  bad: "border-env-prod/35 bg-env-prod/8 text-env-prod-fg",
  dim: "border-control-border text-subtle-foreground",
};

export function BaselineChips({ status }: { status: BaselineStatus }) {
  return (
    <span className="flex flex-wrap gap-1">
      {items(status).map((it) => (
        <span key={it.text} title={it.title} className={cn("rounded-md border px-1.5 py-px font-mono text-[11px]", TONE[it.tone])}>
          {it.text}
        </span>
      ))}
    </span>
  );
}

/** Install / update in a terminal tab (an AWS server: a pane per
 *  instance), for where root needs a password. Production asks first. */
function installBaseline(serverId: string) {
  void triggerAction({ serverId, appId: null, actionId: "baseline" });
}

type Result = { instance: string | null; status: BaselineStatus | string; install?: BaselineInstall };
type Row = { state: "busy" | "installing" } | { state: "done"; results: Result[] };

/** Per server: checking, installing, or what came back. Kept while you
 *  switch tabs. */
const useBaselineRows = create<{ rows: Record<string, Row> }>(() => ({ rows: {} }));
const setRow = (id: string, row: Row) => useBaselineRows.setState((x) => ({ rows: { ...x.rows, [id]: row } }));

/** An AWS server's running instances (each checked and installed), else
 *  the server itself. */
async function targets(s: Server): Promise<(string | null)[]> {
  return isAsg(s) ? (await asgInstances(s.id)).map((i) => i.id) : [null];
}

async function checkServer(s: Server) {
  setRow(s.id, { state: "busy" });
  let results: Result[];
  try {
    results = await Promise.all(
      (await targets(s)).map(async (instance) => ({
        instance,
        status: await baselineCheck(s.id, instance).catch((e: unknown) => errorMessage(e)),
      })),
    );
  } catch (e) {
    results = [{ instance: null, status: errorMessage(e) }];
  }
  setRow(s.id, { state: "done", results });
}

/** Install / update in the background (no terminal), then check again.
 *  Production asks first. */
async function installServer(s: Server): Promise<void> {
  if (
    s.env === "prod" &&
    !(await askConfirm(
      `Install / update the baseline on ${s.name}?`,
      "Production. As root: clones the missing repos, pulls the others (fast-forward only: local changes stop it) and adds missing ~/.bashrc lines.",
      "Install",
    ))
  )
    return;
  setRow(s.id, { state: "installing" });
  let results: Result[];
  try {
    const list = await targets(s);
    // Aliases of its own: replace them with the baseline's, or keep them?
    const before = await Promise.all(list.map((i) => baselineCheck(s.id, i).catch((e: unknown) => errorMessage(e))));
    const own = ownAliases(before);
    const replace =
      own.length > 0 &&
      (await askChoice(
        `Replace ${s.name}'s alias${own.length > 1 ? "es" : ""} with the baseline's?`,
        `${own.join("\n")}\n\nReplace: root's ~/.bashrc is backed up, then the baseline's line takes the place of yours. Keep mine: everything else is installed, the alias stays as it is.`,
        "Replace",
        "Keep mine",
      ));
    results = await Promise.all(
      list.map(async (instance) => {
        const install = await baselineInstall(s.id, instance, replace).catch(
          (e: unknown): BaselineInstall => ({ ok: false, output: errorMessage(e), needsPassword: false }),
        );
        const status = await baselineCheck(s.id, instance).catch((e: unknown) => errorMessage(e));
        return { instance, status, install };
      }),
    );
  } catch (e) {
    results = [{ instance: null, status: errorMessage(e) }];
  }
  setRow(s.id, { state: "done", results });
  const failed = results.some((r) => r.install && !r.install.ok);
  useToasts.getState().push(failed ? `Baseline on ${s.name}: not all of it worked` : `Baseline in place on ${s.name}`, failed ? "error" : "info");
}

/** One server's (or instance's) outcome: the install's, then the check's. */
function ResultView({ r, server }: { r: Result; server: Server }) {
  const [open, setOpen] = useState(false);
  const link = "cursor-pointer text-primary hover:underline";
  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      {r.instance && <span className="font-mono text-[11px] text-subtle-foreground">{r.instance}</span>}
      {r.install && (
        <span className="flex flex-wrap items-center gap-x-2">
          {r.install.ok ? (
            <span className="text-[#17702a]">✓ installed / updated</span>
          ) : (
            <span className="text-env-prod-fg">{r.install.needsPassword ? "✗ root needs a password here" : "✗ didn't finish"}</span>
          )}
          {r.install.output && (
            <button className={link} onClick={() => setOpen(!open)}>
              {open ? "Hide details" : "Details"}
            </button>
          )}
          {r.install.needsPassword && (
            <button className={link} onClick={() => installBaseline(server.id)} title="In a terminal tab, where sudo can ask for the password">
              Open in terminal
            </button>
          )}
        </span>
      )}
      {open && r.install && (
        <pre className="selectable max-h-[260px] overflow-auto rounded-md bg-hover/60 px-2 py-1.5 font-mono text-[11px] leading-4 whitespace-pre-wrap">
          {r.install.output}
        </pre>
      )}
      {typeof r.status === "string" ? (
        <span className="text-env-prod-fg">{r.status}</span>
      ) : r.status.complete && r.status.repos.every((x) => x.state === "ok") && r.status.lines.every((l) => l.present === true && l.count <= 1) ? (
        <span className="text-[#17702a]">✓ all there, up to date</span>
      ) : (
        <BaselineChips status={r.status} />
      )}
    </div>
  );
}

/** A server's Health tab: is the baseline there? (read-only) */
export function BaselineSection({ server, instance }: { server: Server; instance: string | null }) {
  const baseline = useConfig((s) => s.snapshot?.config?.baseline);
  const [state, setState] = useState<BaselineStatus | string | "busy" | null>(null);
  const check = async () => {
    setState("busy");
    try {
      setState(await baselineCheck(server.id, instance));
    } catch (e) {
      setState(errorMessage(e));
    }
  };
  useEffect(() => {
    if (baseline) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, server.id, instance]);
  const row = useBaselineRows((x) => x.rows[server.id]);
  const installing = row?.state === "installing";
  const mine = row?.state === "done" ? (row.results.find((r) => r.instance === instance) ?? row.results[0]) : undefined;
  if (!baseline) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[0.8em] font-semibold tracking-wide text-subtle-foreground uppercase">Baseline</h3>
        {typeof state === "object" && state && (
          <span className={cn("text-[0.8em]", state.complete ? "text-[#17702a]" : "text-env-prod-fg")}>{state.complete ? "all there" : "incomplete"}</span>
        )}
        <span className="flex-1" />
        <Btn size="sm" variant="ghost" onClick={() => void check()} disabled={state === "busy"}>
          <RotateCw className={cn("size-3", state === "busy" && "animate-spin")} /> Check
        </Btn>
        <Btn
          size="sm"
          variant="outline"
          disabled={installing}
          onClick={() => void installServer(server).then(() => check())}
        >
          {installing ? <Spinner size={10} /> : null} {installing ? "Installing…" : "Install / update"}
        </Btn>
      </div>
      {mine?.install && <ResultView r={{ ...mine, status: typeof state === "object" && state ? state : mine.status, instance: null }} server={server} />}
      {state === "busy" && <span className="text-[0.85em] text-subtle-foreground">Checking {baseline.repos.map((r) => r.name).join(", ")}…</span>}
      {typeof state === "string" && state !== "busy" && <span className="text-[0.85em] text-env-prod-fg">{state}</span>}
      {!mine?.install && typeof state === "object" && state && <BaselineChips status={state} />}
    </section>
  );
}

const blank: Baseline = { dir: "/opt/www", repos: [], bashrc: [] };

/** The Baseline tab (Settings ▸ Server baseline, ⌘K): what every server
 *  should have, and a check of every server against it. */
export function BaselineView() {
  const config = useConfig((s) => s.snapshot?.config);
  const saved = config?.baseline ?? null;
  // The team in front (the sidebar's switcher), like the sidebar and Home.
  const servers = useTeamServers();
  const team = useCurrentTeam();
  const [dir, setDir] = useState(saved?.dir ?? blank.dir);
  const [repos, setRepos] = useState(saved?.repos.length ? saved.repos : [{ name: "", url: "" }]);
  const [lines, setLines] = useState((saved?.bashrc ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const rows = useBaselineRows((x) => x.rows);

  const form: Baseline = {
    dir: dir.trim() || "/opt/www",
    repos: repos.filter((r) => r.name.trim() || r.url.trim()).map((r) => ({ name: r.name.trim(), url: r.url.trim() })),
    bashrc: lines
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim()),
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(saved ?? blank);

  const save = async () => {
    setBusy(true);
    try {
      await baselineSave(form);
      useToasts.getState().push("Server baseline saved", "info");
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const checkOne = checkServer;

  const checkAll = async () => {
    // Four at a time: each is an ssh (or Session Manager) connection.
    const queue = [...servers];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) await checkOne(s);
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  };

  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <div className="flex h-12 flex-none items-center gap-2 border-b border-divider px-4">
        <span className="text-[14px] font-semibold">Server baseline</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-subtle-foreground">
          What every server should have. Checking is read-only; Install / update clones what's missing, pulls what's there (fast-forward
          only) and adds missing lines, as root.
        </span>
        <Btn size="sm" variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? "Saving…" : dirty ? "Save" : "Saved"}
        </Btn>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-6 py-5">
          <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-4">
            <Field label="Folder" hint="Created when missing">
              {(fid) => <TextInput id={fid} value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/opt/www" />}
            </Field>
            <Field label="Lines in root's ~/.bashrc" hint="One per line; added when missing">
              {(fid) => (
                <textarea
                  id={fid}
                  value={lines}
                  onChange={(e) => setLines(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  placeholder="alias deploy='/opt/www/laravel-helper/laravel-helper -uifr -d'"
                  className="w-full resize-y rounded-lg border border-control-border bg-background px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-primary/60"
                />
              )}
            </Field>
          </div>
          <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">Repos (each in Folder/name)</span>
              {repos.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <TextInput
                    aria-label="Name"
                    className="w-[200px] flex-none"
                    value={r.name}
                    placeholder="server-helper"
                    onChange={(e) => setRepos((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  />
                  <TextInput
                    aria-label="Git URL"
                    value={r.url}
                    placeholder="https://github.com/you/server-helper.git"
                    onChange={(e) => setRepos((l) => l.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                  />
                  <button
                    aria-label="Remove repo"
                    onClick={() => setRepos((l) => l.filter((_, j) => j !== i))}
                    className="flex size-7 flex-none cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setRepos((l) => [...l, { name: "", url: "" }])}
                className="flex w-fit cursor-pointer items-center gap-1 text-[12px] text-primary hover:underline"
              >
                <Plus className="size-3.5" /> Add repo
              </button>
            </div>

          <div className="flex items-center gap-2 border-t border-divider pt-4">
            <span className="text-[13px] font-semibold">Servers</span>
            <span className="text-[12px] text-subtle-foreground">
              {team ? `${team.name} · ` : ""}
              {servers.length} · {dirty ? "save first to check against these changes" : "AWS servers: each instance"}
            </span>
            <span className="flex-1" />
            <Btn size="sm" variant="outline" disabled={!saved || dirty} onClick={() => void checkAll()}>
              <RotateCw className="size-3" /> Check all servers
            </Btn>
          </div>
          <div className="flex flex-col divide-y divide-divider rounded-lg border border-divider">
            {servers.map((s) => {
              const row = rows[s.id];
              return (
                <div key={s.id} className="flex items-start gap-3 px-3 py-2">
                  <span className="flex w-[220px] flex-none items-center gap-1.5 pt-0.5">
                    <span className="truncate text-[12.5px] font-medium">{s.name}</span>
                    <EnvTag env={s.env} />
                  </span>
                  <span className="min-w-0 flex-1 text-[12px]">
                    {!row && <span className="text-subtle-foreground">not checked</span>}
                    {row?.state === "busy" && <span className="text-subtle-foreground">checking…</span>}
                    {row?.state === "installing" && (
                      <span className="flex items-center gap-1.5 text-subtle-foreground">
                        <Spinner size={10} /> installing / updating, then checking again…
                      </span>
                    )}
                    {row?.state === "done" && row.results.map((r) => <ResultView key={r.instance ?? "-"} r={r} server={s} />)}
                  </span>
                  <span className="flex flex-none gap-1">
                    <Btn size="sm" variant="ghost" disabled={!saved || dirty || row?.state === "busy"} onClick={() => void checkOne(s)}>
                      Check
                    </Btn>
                    <Btn
                      size="sm"
                      variant="outline"
                      disabled={!saved || dirty || row?.state === "installing" || row?.state === "busy"}
                      onClick={() => void installServer(s)}
                    >
                      Install / update
                    </Btn>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
