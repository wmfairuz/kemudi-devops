import { Check, Copy, Plus, RotateCw, Search, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Spinner } from "@/components/kit/Spinner";
import { errorMessage, sshConfigOpen, sshHostDelete, sshHostList, sshTest, type HostRow, type Server } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { openDetails } from "@/stores/manage";
import { openSsh } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

import { useSshHostDialog } from "./SshHostDialog";

const NO_SERVERS: Server[] = [];

type Test = "testing" | { ok: boolean; message: string };

/** `user@alias` or `alias` → alias. */
const aliasOf = (host: string) => host.split("@").pop() ?? host;

const where = (r: HostRow) => (r.source === "kemudi" ? "Kemudi" : r.source === "config" ? "~/.ssh/config" : r.file);

/** The pinned SSH hosts tab (⇧⌘E): every host ssh knows, from Kemudi's
 *  file, ~/.ssh/config and what it includes, with the servers using each. */
export function SshHostsView() {
  const servers = useConfig((s) => s.snapshot?.config?.servers ?? NO_SERVERS);
  const saved = useSshHostDialog((s) => s.saved);
  const [rows, setRows] = useState<HostRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [tests, setTests] = useState<Record<string, Test>>({});

  const load = () =>
    sshHostList().then(
      (r) => {
        setRows(r);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  useEffect(() => {
    void load();
  }, [saved]);

  const usedBy = useMemo(() => {
    const m = new Map<string, Server[]>();
    for (const s of servers) {
      if (!s.host) continue;
      const a = aliasOf(s.host);
      m.set(a, [...(m.get(a) ?? []), s]);
    }
    return m;
  }, [servers]);

  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return (rows ?? []).filter((r) => {
      const hay = [r.alias, r.entry.hostname, r.entry.user, r.entry.port, r.entry.identityFile, r.entry.jump, where(r), ...r.entry.extra, ...(usedBy.get(r.alias) ?? []).map((s) => s.name)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [rows, filter, usedBy]);

  const test = async (alias: string) => {
    setTests((t) => ({ ...t, [alias]: "testing" }));
    let r: Test;
    try {
      r = await sshTest(alias, null);
    } catch (e) {
      r = { ok: false, message: errorMessage(e) };
    }
    setTests((t) => ({ ...t, [alias]: r }));
  };
  /** Every shown host, four at a time. */
  const testAll = async () => {
    const queue = shown.map((r) => r.alias);
    const worker = async () => {
      for (let a = queue.shift(); a !== undefined; a = queue.shift()) await test(a);
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  };

  const remove = async (r: HostRow) => {
    const users = usedBy.get(r.alias) ?? [];
    const ok = await askConfirm(
      `Delete SSH host ${r.alias}?`,
      users.length
        ? `${users.map((s) => s.name).join(", ")} ${users.length === 1 ? "uses" : "use"} it: ${users.length === 1 ? "it" : "they"} can't connect until you pick another host.`
        : `It's taken out of Kemudi's file (${r.file}).`,
    );
    if (!ok) return;
    try {
      await sshHostDelete(r.alias);
      useToasts.getState().push(`Deleted SSH host ${r.alias}`, "info");
      useSshHostDialog.setState((s) => ({ saved: s.saved + 1 }));
    } catch (e) {
      toastError(errorMessage(e));
    }
  };

  const counts = { kemudi: 0, config: 0, include: 0 };
  for (const r of rows ?? []) counts[r.source]++;

  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-divider px-3">
        <span className="text-[13px] font-semibold">SSH hosts</span>
        {rows && (
          <span className="text-[12px] text-subtle-foreground">
            {rows.length} · {counts.kemudi} Kemudi's · {counts.config} in ~/.ssh/config{counts.include ? ` · ${counts.include} included` : ""}
          </span>
        )}
        <span className="flex-1" />
        <label className="flex h-7 w-[240px] items-center gap-1.5 rounded-md border border-control-border px-2 focus-within:border-primary/60">
          <Search className="size-3.5 flex-none text-subtle-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter: name, address, user, server…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint-foreground"
          />
          {filter && (
            <button aria-label="Clear filter" onClick={() => setFilter("")} className="text-subtle-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>
        <Btn size="sm" variant="ghost" disabled={!shown.length} onClick={() => void testAll()} title="A non-interactive login to each shown host">
          Test all
        </Btn>
        <Btn size="sm" variant="ghost" onClick={() => void sshConfigOpen().catch((e) => toastError(errorMessage(e)))}>
          ~/.ssh/config
        </Btn>
        <Btn size="sm" variant="outline" onClick={() => void load()} aria-label="Reload">
          <RotateCw className="size-3.5" />
        </Btn>
        <Btn size="sm" variant="primary" onClick={() => useSshHostDialog.getState().open(null)}>
          <Plus className="size-3.5" /> New host
        </Btn>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {error && <div className="mb-3 text-[12.5px] text-env-prod-fg">{error}</div>}
        {rows === null && !error && <div className="text-[13px] text-subtle-foreground">Loading…</div>}
        {rows && rows.length === 0 && (
          <div className="text-[13px] text-subtle-foreground">No SSH hosts yet. New host adds one without editing ~/.ssh/config by hand.</div>
        )}
        {rows && rows.length > 0 && (
          <table className="w-full min-w-[980px] border-separate border-spacing-0 text-[12.5px]">
            <thead>
              <tr className="text-left text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">
                {["Host", "Address", "User", "Port", "Key", "Jump", "In", "Used by", ""].map((h, i) => (
                  <th key={i} className="sticky top-0 z-[1] border-b border-divider bg-background px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const t = tests[r.alias];
                const users = usedBy.get(r.alias) ?? [];
                const e = r.entry;
                return (
                  <tr
                    key={r.alias}
                    onClick={() => useSshHostDialog.getState().open(r.alias)}
                    className="group cursor-pointer hover:bg-hover/60"
                    title={r.source === "kemudi" ? "Edit" : r.adoptBlocker ? `Shown as written. ${r.adoptBlocker}` : "Shown as written; open it to move it into Kemudi and edit it"}
                  >
                    <td className="border-b border-divider px-2 py-2">
                      <div className="flex items-center gap-1.5">
                        <TestDot t={t} />
                        <span className="font-mono font-medium">{r.alias}</span>
                      </div>
                      {t && t !== "testing" && !t.ok && <div className="mt-0.5 max-w-[260px] text-[11px] leading-4 text-env-prod-fg">{t.message}</div>}
                    </td>
                    <td className="border-b border-divider px-2 py-2 font-mono">{e.hostname}</td>
                    <td className="border-b border-divider px-2 py-2 font-mono">{e.user ?? <Dim>—</Dim>}</td>
                    <td className="border-b border-divider px-2 py-2 font-mono">{e.port ?? <Dim>22</Dim>}</td>
                    <td className="max-w-[160px] truncate border-b border-divider px-2 py-2 font-mono" title={e.identityFile ?? "ssh-agent and ssh's default keys"}>
                      {e.identityFile?.replace(/^~\/\.ssh\//, "") ?? <Dim>default</Dim>}
                    </td>
                    <td className="border-b border-divider px-2 py-2 font-mono">
                      {e.jump ?? <Dim>—</Dim>}
                      {e.extra.length > 0 && (
                        <span className="ml-1.5 rounded-[4px] border border-divider px-1 font-sans text-[10.5px] text-subtle-foreground" title={e.extra.join("\n")}>
                          +{e.extra.length}
                        </span>
                      )}
                    </td>
                    <td className="border-b border-divider px-2 py-2">
                      <span
                        className={cn(
                          "rounded-[4px] border px-1.5 text-[10.5px] whitespace-nowrap",
                          r.source === "kemudi" ? "border-primary/30 bg-primary/8 text-primary" : "border-divider text-subtle-foreground",
                        )}
                        title={r.file}
                      >
                        {where(r)}
                      </span>
                    </td>
                    <td className="border-b border-divider px-2 py-2">
                      <div className="flex flex-wrap gap-1">
                        {users.map((s) => (
                          <button
                            key={s.id}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              openDetails({ kind: "server", serverId: s.id });
                            }}
                            className="rounded-[4px] bg-hover px-1.5 text-[11px] hover:bg-hover-strong"
                          >
                            {s.name}
                          </button>
                        ))}
                        {users.length === 0 && <Dim>—</Dim>}
                      </div>
                    </td>
                    <td className="border-b border-divider px-2 py-2" onClick={(ev) => ev.stopPropagation()}>
                      <div className="flex items-center justify-end gap-0.5 opacity-60 group-hover:opacity-100">
                        <Icon label="Test connection" onClick={() => void test(r.alias)} disabled={t === "testing"}>
                          <Check className="size-3.5" />
                        </Icon>
                        <Icon label={`ssh ${r.alias}`} onClick={() => openSsh(r.alias, { title: r.alias })}>
                          <SquareTerminal className="size-3.5" />
                        </Icon>
                        <Icon
                          label="Duplicate (a new host with these settings)"
                          onClick={() => {
                            const taken = new Set((rows ?? []).map((x) => x.alias));
                            let name = `${r.alias}-copy`;
                            for (let n = 2; taken.has(name); n++) name = `${r.alias}-copy${n}`;
                            useSshHostDialog.getState().open(null, { ...e, alias: name });
                          }}
                        >
                          <Copy className="size-3.5" />
                        </Icon>
                        <Icon
                          label={r.source === "kemudi" ? "Delete…" : "Only Kemudi's hosts can be deleted here (open it to move it into Kemudi first)"}
                          disabled={r.source !== "kemudi"}
                          onClick={() => void remove(r)}
                        >
                          <Trash2 className="size-3.5" />
                        </Icon>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {rows && rows.length > 0 && shown.length === 0 && <div className="mt-3 text-[12.5px] text-subtle-foreground">Nothing matches “{filter}”.</div>}
        <div className="mt-4 max-w-[760px] text-[11.5px] leading-5 text-subtle-foreground">
          Click a host to see or edit it. Kemudi's hosts live in ~/.ssh/config.d/kemudi.conf, which ~/.ssh/config includes, so <span className="font-mono">ssh &lt;host&gt;</span> works
          in any terminal. A host from your own ~/.ssh/config is shown as written; editing it moves its block into Kemudi's file (your config is backed up first). Hosts from
          other included files stay where they are. Wildcard blocks (<span className="font-mono">Host *</span>) aren't listed. Passwords are never stored.
        </div>
      </div>
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-faint-foreground">{children}</span>;
}

function TestDot({ t }: { t: Test | undefined }) {
  if (t === "testing") return <Spinner size={10} />;
  if (!t) return <span className="size-2 flex-none rounded-full bg-control-border" title="Not tested" />;
  return <span className={cn("size-2 flex-none rounded-full", t.ok ? "bg-status-up" : "bg-status-down")} title={t.message} />;
}

function Icon({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-hover-strong hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
