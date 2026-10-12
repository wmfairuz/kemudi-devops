import { Check, Copy, CopyPlus, CornerDownLeft, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { makeAction } from "@/components/snippets/SnippetsPanel";
import { copyText } from "@/lib/clipboard";
import type { Snippet, Team } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { insertSnippet, useSnippets } from "@/stores/snippets";
import { useToasts } from "@/stores/toasts";

const NO_TEAMS: Team[] = [];
type Draft = { id: string | null; name: string; command: string; notes: string; team: string };

/** The Snippets tab: every snippet (all teams) in a list, the one picked in
 *  a full-size editor. The right panel's Snippets tab is for using them. */
export function SnippetsView() {
  const { list, loaded, error, editing } = useSnippets();
  const teams = useConfig((s) => s.snapshot?.config?.teams ?? NO_TEAMS);
  const [filter, setFilter] = useState("");
  // "" all, "-" no team (every team), else a team id.
  const [teamFilter, setTeamFilter] = useState("");
  useEffect(() => {
    if (!loaded) void useSnippets.getState().load();
  }, [loaded]);

  const q = filter.trim().toLowerCase();
  const shown = list.filter(
    (s) =>
      (!teamFilter || (teamFilter === "-" ? !s.team : s.team === teamFilter)) &&
      (!q || [s.name, s.command, s.notes].some((f) => f.toLowerCase().includes(q))),
  );
  const teamName = (id: string | null | undefined) => (id ? (teams.find((t) => t.id === id)?.name ?? id) : null);
  const selectedId = editing?.id ?? null;

  const [dirty, setDirty] = useState(false);
  /** Switch to another snippet (or a new one), asking first if this one has changes. */
  const pick = async (next: Parameters<ReturnType<typeof useSnippets.getState>["setEditing"]>[0]) => {
    if (dirty && !(await askConfirm("Discard your changes?", "The snippet you're editing has unsaved changes.", "Discard"))) return;
    setDirty(false);
    useSnippets.getState().setEditing(next);
  };

  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <div className="flex h-12 flex-none items-center gap-2 border-b border-divider px-4">
        <span className="text-[14px] font-semibold">Snippets</span>
        <span className="text-[12px] text-subtle-foreground">
          {list.length} saved · in ~/.config/kemudi/snippets.yaml · plain text, so no passwords
        </span>
        <span className="flex-1" />
        <Btn size="sm" variant="primary" onClick={() => void pick({ id: null })}>
          <Plus className="size-3.5" /> New snippet
        </Btn>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[340px] flex-none flex-col border-r border-divider">
          <div className="flex flex-none gap-2 border-b border-divider p-2.5">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, command, notes"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 text-[12px] outline-none placeholder:text-faint-foreground focus:border-primary/60"
            />
            {teams.length > 0 && (
              <select
                aria-label="Team"
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
                className="h-7 w-[110px] rounded-md border border-control-border bg-background px-1.5 text-[12px] outline-none focus:border-primary/60"
              >
                <option value="">All teams</option>
                <option value="-">Every team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {error && <div className="m-1 rounded-lg bg-env-prod/12 px-3 py-2 text-[12px] text-env-prod-fg">Can't read your snippets (nothing was changed): {error}</div>}
            {loaded && list.length === 0 && !error && (
              <div className="px-3 py-4 text-[12.5px] text-subtle-foreground">No snippets yet: New snippet, or right-click a command in a terminal ▸ Save command as snippet…</div>
            )}
            {list.length > 0 && shown.length === 0 && <div className="px-3 py-4 text-[12.5px] text-subtle-foreground">Nothing matches.</div>}
            {shown.map((s) => (
              <button
                key={s.id}
                onClick={() => s.id !== selectedId && void pick(s)}
                className={cn(
                  "flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left",
                  s.id === selectedId ? "bg-selected" : "hover:bg-hover",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium">{s.name}</span>
                  {teamName(s.team) && <span className="flex-none rounded bg-muted px-1 text-[10.5px] text-subtle-foreground">{teamName(s.team)}</span>}
                </span>
                <span className="truncate font-mono text-[11px] text-subtle-foreground">{s.command.split("\n")[0]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {editing ? (
            <Editor key={editing.id ?? `new:${editing.command ?? ""}`} teams={teams} onDirty={setDirty} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-subtle-foreground">
              Pick a snippet to edit it, or make a New snippet.
              <br />
              To use one, open the right panel's Snippets tab (⌘J) next to a terminal.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Editor({ teams, onDirty }: { teams: Team[]; onDirty: (d: boolean) => void }) {
  const editing = useSnippets((s) => s.editing)!;
  const existing = editing.id !== null ? (editing as Snippet) : null;
  const start: Draft = useMemo(
    () => ({
      id: existing?.id ?? null,
      name: existing?.name ?? ("name" in editing ? (editing.name ?? "") : ""),
      command: existing?.command ?? ("command" in editing ? (editing.command ?? "") : ""),
      notes: existing?.notes ?? ("notes" in editing ? (editing.notes ?? "") : ""),
      team: existing ? (existing.team ?? "") : "team" in editing && editing.team ? editing.team : "",
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [d, setD] = useState<Draft>(start);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const dirty = d.name !== start.name || d.command !== start.command || d.notes !== start.notes || d.team !== start.team || !existing;
  useEffect(() => onDirty(dirty && (d.name.trim() !== "" || d.command.trim() !== "")), [dirty, d.name, d.command, onDirty]);
  const canSave = d.name.trim() !== "" && d.command.trim() !== "" && !busy && dirty;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const ok = await useSnippets.getState().save({ id: d.id, name: d.name, command: d.command, notes: d.notes, team: d.team || null });
    setBusy(false);
    if (ok) {
      onDirty(false);
      useToasts.getState().push(existing ? `Saved ${d.name.trim()}` : `Added ${d.name.trim()}`, "info");
    }
  };
  const keys = (e: React.KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === "s") && e.metaKey) {
      e.preventDefault();
      void save();
    }
  };
  const remove = async () => {
    if (!existing || !(await askConfirm(`Delete “${existing.name}”?`, "It's deleted from your snippets."))) return;
    onDirty(false);
    await useSnippets.getState().remove(existing.id);
    useSnippets.getState().setEditing(null);
  };
  const area =
    "block w-full resize-y rounded-lg border border-control-border bg-background px-3 py-2 text-[13px] leading-[20px] outline-none placeholder:text-faint-foreground focus:border-primary/60";

  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-8 py-6" onKeyDown={keys}>
      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-muted-foreground" htmlFor="snip-name">
          Name
        </label>
        <input
          id="snip-name"
          autoFocus={!existing}
          value={d.name}
          onChange={(e) => setD({ ...d, name: e.target.value })}
          placeholder="Tail the Laravel log"
          className="h-9 rounded-lg border border-control-border bg-background px-3 text-[14px] font-medium outline-none focus:border-primary/60"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-muted-foreground" htmlFor="snip-cmd">
          Command <span className="text-subtle-foreground">· typed at the prompt as is; several lines are pasted together</span>
        </label>
        <textarea
          id="snip-cmd"
          value={d.command}
          spellCheck={false}
          onChange={(e) => setD({ ...d, command: e.target.value })}
          placeholder="tail -f storage/logs/laravel-$(date +%F).log"
          className={cn(area, "min-h-[220px] font-mono text-[12.5px]")}
        />
      </div>
      {teams.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="text-[12px] text-muted-foreground" htmlFor="snip-team">
            Team
          </label>
          <select
            id="snip-team"
            value={d.team}
            onChange={(e) => setD({ ...d, team: e.target.value })}
            className="h-[30px] w-[220px] rounded-lg border border-control-border bg-background px-2 text-[12.5px] outline-none focus:border-primary/60"
          >
            <option value="">Every team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="text-[11.5px] text-subtle-foreground">Shown only while that team is picked; Every team: always.</span>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label className="text-[12px] text-muted-foreground" htmlFor="snip-notes">
          Notes <span className="text-subtle-foreground">· optional: when to use it, what to watch for</span>
        </label>
        <textarea
          id="snip-notes"
          value={d.notes}
          onChange={(e) => setD({ ...d, notes: e.target.value })}
          placeholder="Use on staging when queue jobs fail silently…"
          className={cn(area, "min-h-[120px] font-sans")}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Btn variant="primary" className="pr-2.5" disabled={!canSave} onClick={() => void save()}>
          {existing ? "Save" : "Add snippet"} <Hint className="text-primary-foreground/60">⌘S</Hint>
        </Btn>
        {existing && dirty && (
          <Btn variant="ghost" onClick={() => setD(start)}>
            Revert
          </Btn>
        )}
        <span className="flex-1" />
        {existing && (
          <>
            <Btn variant="outline" onClick={() => void insertSnippet(existing)} title="Type it at the prompt of the last terminal you were in">
              <CornerDownLeft className="size-3.5" /> Insert
            </Btn>
            <Btn
              variant="outline"
              onClick={async () => {
                if (await copyText(existing.command)) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }
              }}
            >
              {copied ? <Check className="size-3.5 text-status-up" /> : <Copy className="size-3.5" />} Copy
            </Btn>
            <Btn
              variant="outline"
              onClick={() => useSnippets.getState().setEditing({ id: null, name: `${existing.name} copy`, command: existing.command, notes: existing.notes, team: existing.team ?? null })}
            >
              <CopyPlus className="size-3.5" /> Duplicate
            </Btn>
            <Btn variant="outline" onClick={() => makeAction(existing)} title="Turn it into an action button">
              <Zap className="size-3.5" /> Make action…
            </Btn>
            <Btn variant="ghost" className="text-env-prod-fg" onClick={() => void remove()}>
              <Trash2 className="size-3.5" /> Delete
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}
