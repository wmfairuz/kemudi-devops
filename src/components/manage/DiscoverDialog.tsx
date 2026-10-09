import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { appSave, discoverApps, errorMessage, type DiscoveredApp } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { freeId } from "@/stores/manage";
import { useToasts } from "@/stores/toasts";

const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface Row extends DiscoveredApp {
  pick: boolean;
  error?: string;
  added?: boolean;
}

function Pill({ children, title, tone }: { children: React.ReactNode; title?: string; tone?: "warn" }) {
  return (
    <span title={title} className={cn("rounded px-1.5 text-[10.5px] leading-[1.6] whitespace-nowrap", tone === "warn" ? "bg-env-staging/15 text-env-staging-fg" : "bg-muted text-subtle-foreground")}>
      {children}
    </span>
  );
}

/** Server page ▸ Discover apps: look around the server for Laravel apps and
 *  add the ones you pick, filled in (name, id, branch, remote, PHP, env,
 *  vhost and Supervisor files). */
export function DiscoverDialog({ server, onClose }: { server: { id: string; name: string; env: string; apps: { id: string }[] }; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const scan = async () => {
    setRows(null);
    setError(null);
    try {
      const found = await discoverApps(server.id);
      setRows(found.map((f) => ({ ...f, pick: false })));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const fresh = (rows ?? []).filter((r) => !r.existing && !r.added);
  const known = (rows ?? []).filter((r) => r.existing || r.added);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? fresh.filter((r) => `${r.name} ${r.id} ${r.path} ${r.domains.join(" ")} ${r.appName ?? ""}`.toLowerCase().includes(q)) : fresh;
  }, [fresh, query]);
  const picked = fresh.filter((r) => r.pick);

  const taken = new Set(server.apps.map((a) => a.id));
  const bad = picked.some((r) => !r.name.trim());

  const update = (path: string, patch: Partial<Row>) => setRows((list) => (list ?? []).map((r) => (r.path === path ? { ...r, ...patch } : r)));

  const add = async () => {
    if (!picked.length || bad) return;
    setBusy(true);
    let ok = 0;
    // Each gets a free id (Kemudi's own key, never shown): the proposed one,
    // else -2, -3…
    const used = [...taken];
    for (const r of picked) {
      const id = freeId(ID_OK.test(r.id) ? r.id : r.name, used, "app");
      used.push(id);
      try {
        await appSave(server.id, null, {
          id,
          name: r.name.trim(),
          path: r.path,
          branch: r.branch,
          php: r.php,
          color: null,
          env: r.env,
          repo: r.repo,
          url: r.url,
          vhostFiles: r.vhostFiles,
          supervisorFiles: r.supervisorFiles,
        });
        ok++;
        update(r.path, { added: true, pick: false, error: undefined });
      } catch (e) {
        update(r.path, { error: errorMessage(e) });
      }
    }
    setBusy(false);
    if (ok) useToasts.getState().push(`Added ${ok} app${ok === 1 ? "" : "s"} to ${server.name}`, "info");
    if (ok === picked.length) onClose();
  };

  const allShownPicked = shown.length > 0 && shown.every((r) => r.pick);

  return (
    <Modal open onOpenChange={(o) => !o && !busy && onClose()} title="Discover apps" width={860}>
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">Discover apps</span>
          <span className="text-[12.5px] text-subtle-foreground">on {server.name}</span>
        </div>
        <span className="text-[11.5px] text-subtle-foreground">
          Laravel apps (an artisan file) under /var/www, /opt, /srv and /home, and what nginx, Apache, Supervisor and cron point at. Read-only.
        </span>
      </ModalHeader>
      <div className="flex max-h-[62vh] min-h-[200px] flex-col gap-2 px-5 pb-3 text-[12.5px]">
        {!rows && !error && <div className="py-8 text-center text-subtle-foreground">Looking around {server.name}…</div>}
        {error && (
          <div className="flex items-center gap-3 rounded-lg bg-env-prod/8 px-3 py-2 text-env-prod-fg">
            <span className="flex-1">{error}</span>
            <Btn size="sm" variant="outline" onClick={() => void scan()}>
              Try again
            </Btn>
          </div>
        )}
        {rows && fresh.length === 0 && <div className="py-6 text-center text-subtle-foreground">No new Laravel apps found{known.length ? `: all ${known.length} are already in Kemudi` : ""}.</div>}
        {rows && fresh.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-subtle-foreground">
              <input
                type="checkbox"
                checked={allShownPicked}
                onChange={(e) => {
                  const on = e.target.checked;
                  const ids = new Set(shown.map((r) => r.path));
                  setRows((list) => (list ?? []).map((r) => (ids.has(r.path) ? { ...r, pick: on } : r)));
                }}
              />
              {fresh.length} found
            </label>
            <span className="flex-1" />
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter"
                spellCheck={false}
                className="h-7 w-[16em] rounded-md border border-control-border bg-background pr-6 pl-7 text-[12px] outline-none focus:border-primary/60"
              />
              {query && (
                <button className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer text-subtle-foreground" aria-label="Clear filter" onClick={() => setQuery("")}>
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-divider empty:hidden">
          {shown.map((r) => {
            return (
              <div key={r.path} className={cn("flex gap-2.5 border-b border-divider px-3 py-2 last:border-b-0", r.pick && "bg-selected/40")}>
                <input type="checkbox" className="mt-1.5" checked={r.pick} onChange={(e) => update(r.path, { pick: e.target.checked })} aria-label={`Add ${r.name}`} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <input
                      value={r.name}
                      onChange={(e) => update(r.path, { name: e.target.value, pick: true })}
                      className="h-7 w-[16em] rounded-md border border-control-border bg-background px-2 text-[12.5px] outline-none focus:border-primary/60"
                      aria-label="Name"
                    />
                    {r.env && <EnvTag env={r.env} />}
                    <span className="min-w-0 truncate font-mono text-[11px] text-subtle-foreground" title={r.real && r.real !== r.path ? `${r.path} → ${r.real}` : r.path}>
                      {r.path}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {r.laravel && <Pill>Laravel {r.laravel}</Pill>}
                    {r.php && <Pill title={r.phpSource ?? undefined}>PHP {r.php}</Pill>}
                    {r.phpNote && (
                      <Pill tone="warn" title={r.phpNote}>
                        PHP?
                      </Pill>
                    )}
                    {r.appEnv && <Pill title={r.env ? `Kemudi environment: ${r.env}` : `Follows the server (${server.env})`}>APP_ENV={r.appEnv}</Pill>}
                    {r.branch && <Pill>{r.branch}</Pill>}
                    {r.url && <Pill title={`${r.urlSource ?? ""}${r.urls.length > 1 ? `\nAlso: ${r.urls.filter((u) => u !== r.url).join(", ")}` : ""}`}>{r.url}</Pill>}
                    {r.vhostFiles.length === 0 && <Pill tone="warn" title="No nginx/Apache vhost serves this folder">no vhost</Pill>}
                    {r.supervisorFiles.length > 0 && <Pill title={r.supervisorFiles.join("\n")}>Supervisor</Pill>}
                    {r.repo && (
                      <span className="min-w-0 truncate font-mono text-[10.5px] text-subtle-foreground" title={r.repo}>
                        {r.repo}
                      </span>
                    )}
                  </div>
                  {r.error && <span className="text-[11px] text-env-prod-fg">{r.error}</span>}
                </div>
              </div>
            );
          })}
        </div>
        {known.length > 0 && (
          <div className="text-[11.5px] text-subtle-foreground">
            Already in Kemudi: {known.map((r) => r.existing ?? r.id).join(", ")}
          </div>
        )}
      </div>
      <ModalFooter>
        {rows && (
          <Btn variant="ghost" onClick={() => void scan()} disabled={busy}>
            Look again
          </Btn>
        )}
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={onClose} disabled={busy}>
          Close <Hint>esc</Hint>
        </Btn>
        <Btn variant="primary" disabled={!picked.length || bad || busy} onClick={() => void add()}>
          {busy ? "Adding…" : picked.length ? `Add ${picked.length} app${picked.length === 1 ? "" : "s"}` : "Add"}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}
