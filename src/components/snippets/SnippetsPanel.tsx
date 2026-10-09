import { Check, ChevronRight, Copy, CopyPlus, CornerDownLeft, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import { actionChoices } from "@/components/actions/AddActionDialog";
import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, TextInput } from "@/components/manage/fields";
import { copyText } from "@/lib/clipboard";
import type { Snippet } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { askConfirm } from "@/stores/confirm";
import { useSidebar } from "@/stores/sidebar";
import { insertSnippet, useSnippets } from "@/stores/snippets";
import { useToasts } from "@/stores/toasts";
import { useUi } from "@/stores/ui";
import { useConfig } from "@/stores/config";
import { snippetVisible, useTeam } from "@/stores/team";
import type { Team } from "@/lib/ipc";

const NO_TEAMS: Team[] = [];

/** The Snippets tab of the right-hand panel: saved commands with notes.
 *  Insert types one at the prompt of the terminal in front. */
export function SnippetsList() {
  const { list: everyTeam, loaded, error } = useSnippets();
  const current = useTeam((s) => s.current);
  const list = everyTeam.filter((s) => snippetVisible(s, current));
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded) void useSnippets.getState().load();
  }, [loaded]);

  const q = filter.trim().toLowerCase();
  const shown = q
    ? list.filter((s) => [s.name, s.command, s.notes].some((f) => f.toLowerCase().includes(q)))
    : list;

  return (
    <div className="flex flex-col gap-2 px-3.5 pt-3.5">
      <div className="flex items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter snippets"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 text-[12px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary/60"
        />
        <Btn size="sm" variant="outline" onClick={() => useSnippets.getState().setEditing({ id: null })}>
          <Plus className="size-3.5" /> New
        </Btn>
      </div>
      {error && (
        <div className="rounded-lg bg-env-prod/12 px-3 py-2 text-[12px] leading-[17px] text-env-prod-fg">
          Can't read your snippets (nothing was changed): {error}
        </div>
      )}
      {loaded && !error && list.length === 0 && (
        <button
          onClick={() => useSnippets.getState().setEditing({ id: null })}
          className="mt-1 w-full cursor-pointer rounded-lg border border-dashed border-control-border px-3 py-3 text-left text-[12.5px] leading-[18px] text-subtle-foreground hover:border-primary/50 hover:bg-hover hover:text-foreground"
        >
          + Save a command you use often, with notes. Insert it into any terminal, or turn it into an action.
        </button>
      )}
      {q && shown.length === 0 && list.length > 0 && (
        <div className="px-1 py-2 text-[12px] text-subtle-foreground">Nothing matches “{filter}”.</div>
      )}
      {shown.map((s) => (
        <SnippetRow key={s.id} s={s} open={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />
      ))}
    </div>
  );
}

function SnippetRow({ s, open, onToggle }: { s: Snippet; open: boolean; onToggle: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(s.command)) {
      setCopied(true);
      useToasts.getState().push(`Copied ${s.name}`, "info");
      setTimeout(() => setCopied(false), 1200);
    }
  };
  const remove = async () => {
    if (await askConfirm(`Delete “${s.name}”?`, "It's deleted from your snippets.")) {
      await useSnippets.getState().remove(s.id);
    }
  };

  return (
    <div className={cn("group rounded-lg border border-control-border bg-background", open && "border-primary/40")}>
      <div className="flex items-start gap-1.5 py-2 pr-1.5 pl-2">
        <button onClick={onToggle} className="flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 text-left" title={s.notes || undefined}>
          <ChevronRight className={cn("mt-px size-4 flex-none text-subtle-foreground transition-transform", open && "rotate-90")} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[12.5px] font-medium text-foreground">{s.name}</span>
            {!open && <span className="truncate font-mono text-[11px] text-subtle-foreground">{s.command.split("\n")[0]}</span>}
          </span>
        </button>
        <button
          title="Insert at the prompt of the terminal in front (doesn't press ↵)"
          aria-label={`Insert ${s.name}`}
          onClick={() => void insertSnippet(s)}
          className="flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-subtle-foreground opacity-0 group-hover:opacity-100 hover:bg-hover-strong hover:text-foreground focus-visible:opacity-100"
        >
          <CornerDownLeft className="size-3.5" />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-divider px-2.5 pt-2 pb-2.5">
          <pre className="selectable max-h-48 overflow-auto rounded-md bg-hover px-2 py-1.5 font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap break-all text-foreground">
            {s.command}
          </pre>
          {s.notes && (
            <div className="selectable text-[12px] leading-[18px] whitespace-pre-wrap text-muted-foreground">{s.notes}</div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Btn size="sm" variant="primary" onClick={() => void insertSnippet(s)} title="Type it at the prompt; you press ↵">
              <CornerDownLeft className="size-3.5" /> Insert
            </Btn>
            <Btn size="sm" variant="outline" onClick={() => void insertSnippet(s, { run: true })} title="Type it and press ↵ (asks first on production)">
              <Play className="size-3.5" /> Run
            </Btn>
            <Btn size="sm" variant="outline" onClick={() => void copy()}>
              {copied ? <Check className="size-3.5 text-status-up" /> : <Copy className="size-3.5" />} Copy
            </Btn>
            <Btn size="sm" variant="outline" onClick={() => useSnippets.getState().setEditing(s)}>
              <Pencil className="size-3.5" /> Edit
            </Btn>
            <Btn
              size="sm"
              variant="outline"
              onClick={() => useSnippets.getState().setEditing({ id: null, name: `${s.name} copy`, command: s.command, notes: s.notes, team: s.team ?? null })}
              title="A new snippet starting as a copy of this one"
            >
              <CopyPlus className="size-3.5" /> Duplicate
            </Btn>
            <Btn size="sm" variant="outline" onClick={() => makeAction(s)} title="Turn it into an action button">
              <Zap className="size-3.5" /> Make action…
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => void remove()} aria-label={`Delete ${s.name}`} title="Delete">
              <Trash2 className="size-3.5" />
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/** Open the Add-action form with the snippet's name and command, offering
 *  the places that fit what's selected on the left. */
function makeAction(s: Snippet) {
  const selected = useSidebar.getState().selected;
  const choices = actionChoices(selected?.serverId, selected?.appId ?? null);
  const first = choices[0]!;
  useUi.getState().setAddAction({
    scope: first.scope,
    title: first.title,
    env: first.env,
    choices,
    prefill: { label: s.name, run: s.command },
    fromSnippet: s.id,
  });
}

/** New / edit snippet form. */
export function SnippetDialog() {
  const editing = useSnippets((s) => s.editing);
  if (!editing) return null;
  return <SnippetForm key={editing.id ?? "new"} />;
}

function SnippetForm() {
  const editing = useSnippets((s) => s.editing)!;
  const existing = editing.id !== null ? (editing as Snippet) : null;
  const close = () => useSnippets.getState().setEditing(null);
  const [name, setName] = useState(existing?.name ?? ("name" in editing ? (editing.name ?? "") : ""));
  const [command, setCommand] = useState(existing?.command ?? ("command" in editing ? (editing.command ?? "") : ""));
  const [notes, setNotes] = useState(existing?.notes ?? ("notes" in editing ? (editing.notes ?? "") : ""));
  const teams = useConfig((s) => s.snapshot?.config?.teams ?? NO_TEAMS);
  // A new snippet starts in the team in front.
  const [team, setTeam] = useState<string>(
    existing ? (existing.team ?? "") : "team" in editing && editing.team ? editing.team : teams.some((t) => t.id === useTeam.getState().current) ? useTeam.getState().current : "",
  );
  const [busy, setBusy] = useState(false);
  const canSave = name.trim() !== "" && command.trim() !== "" && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const ok = await useSnippets.getState().save({ id: existing?.id ?? null, name, command, notes, team: team || null });
    setBusy(false);
    if (ok) close();
  };
  const cmdEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      void save();
    }
  };
  const area =
    "block w-full resize-y rounded-lg border border-control-border bg-background px-2.5 py-2 text-[12.5px] leading-[19px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary/60";

  return (
    <Modal open onOpenChange={(o) => !o && close()} title={existing ? "Edit snippet" : "New snippet"} width={560}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ModalHeader>
          <span className="text-[15px] font-semibold">{existing ? "Edit snippet" : "New snippet"}</span>
          <span className="text-[12.5px] text-muted-foreground">Stored as plain text, so no passwords or tokens</span>
        </ModalHeader>
        <div className="flex flex-col gap-3.5 px-5 pb-4">
          <Field label="Name">
            {(fid) => (
              <TextInput id={fid} autoFocus value={name} placeholder="Tail the Laravel log" className="font-sans" onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field label="Command" hint="Typed at the prompt as is; several lines are pasted together. ⌘↵ saves.">
            {(fid) => (
              <textarea
                id={fid}
                value={command}
                spellCheck={false}
                placeholder="tail -f storage/logs/laravel-$(date +%F).log"
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={cmdEnter}
                className={cn(area, "h-[96px] font-mono")}
              />
            )}
          </Field>
          {teams.length > 0 && (
            <Field label="Team" hint="Shown only when that team is in front; or in every team.">
              {(fid) => (
                <select
                  id={fid}
                  value={team}
                  onChange={(e) => setTeam(e.target.value)}
                  className="h-[30px] w-[220px] rounded-lg border border-control-border bg-background px-2 text-[12.5px] outline-none focus:border-primary/60"
                >
                  <option value="">Every team</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field label="Notes" hint="Optional: when to use it, what to watch for.">
            {(fid) => (
              <textarea
                id={fid}
                value={notes}
                placeholder="Use on staging when queue jobs fail silently…"
                onChange={(e) => setNotes(e.target.value)}
                onKeyDown={cmdEnter}
                className={cn(area, "h-[84px] font-sans")}
              />
            )}
          </Field>
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={close}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="primary" className="pr-2.5" disabled={!canSave}>
            {existing ? "Save" : "Add snippet"} <Hint className="text-primary-foreground/60">⌘↵</Hint>
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
