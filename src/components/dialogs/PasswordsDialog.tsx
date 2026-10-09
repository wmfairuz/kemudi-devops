import { Copy, Eye, EyeOff, KeyRound, Plus, Trash2, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, TextInput } from "@/components/manage/fields";
import type { Server, VaultEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { useUi } from "@/stores/ui";
import { copyPassword, useVault } from "@/stores/vault";

const NO_SERVERS: Server[] = [];

/** A random password from the system's crypto source. */
function generate(length = 24): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%+=";
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

/** Kemudi Devops ▸ Passwords… (⇧⌘K): saved passwords to fill at any
 *  password prompt. Passwords are never shown again once saved. */
export function PasswordsDialog() {
  const open = useUi((s) => s.overlay === "passwords");
  const setOverlay = useUi((s) => s.setOverlay);
  const { entries, loaded, error } = useVault();
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (!open) return;
    void useVault.getState().load();
    setFilter("");
  }, [open]);
  // Nothing saved yet: start with the form.
  useEffect(() => {
    if (open && loaded && selected === null) setSelected(entries[0]?.id ?? "new");
  }, [open, loaded, entries, selected]);

  const q = filter.trim().toLowerCase();
  const list = q ? entries.filter((e) => `${e.name} ${e.username} ${e.notes}`.toLowerCase().includes(q)) : entries;
  const current = selected === "new" ? null : (entries.find((e) => e.id === selected) ?? null);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        setOverlay(o ? "passwords" : "none");
        if (!o) setSelected(null);
      }}
      title="Passwords"
      width={860}
    >
      <ModalHeader>
        <span className="text-[15px] font-semibold">Passwords</span>
        <span className="text-[12.5px] leading-[18px] text-muted-foreground">
          At any password prompt in a terminal (sudo, ssh, mysql…), click Fill or press ⌘⇧P and pick one. Encrypted on this Mac; never shown again,
          only filled or copied.
        </span>
      </ModalHeader>
      <div className="grid h-[min(56vh,480px)] grid-cols-[260px_minmax(0,1fr)] border-t border-divider">
        <div className="flex min-h-0 flex-col border-r border-divider">
          <div className="flex items-center gap-2 p-2.5">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter"
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 text-[12px] outline-none placeholder:text-faint-foreground focus:border-primary/60"
            />
            <Btn size="sm" variant="outline" onClick={() => setSelected("new")}>
              <Plus className="size-3.5" /> New
            </Btn>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {error && <div className="px-2 py-2 text-[12px] text-env-prod-fg">{error}</div>}
            {list.map((e) => (
              <button
                key={e.id}
                onClick={() => setSelected(e.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  selected === e.id ? "bg-selected" : "hover:bg-hover",
                )}
              >
                <KeyRound className="size-3.5 flex-none text-subtle-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] text-foreground">{e.name}</span>
                  {(e.username || e.sudoFor.length > 0) && (
                    <span className="truncate text-[11px] text-subtle-foreground">
                      {[e.username, e.sudoFor.length ? `sudo on ${e.sudoFor.join(", ")}` : ""].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
              </button>
            ))}
            {loaded && entries.length === 0 && <div className="px-2 py-2 text-[12px] text-subtle-foreground">None saved yet.</div>}
          </div>
        </div>
        {selected !== null && (
          <EntryForm
            key={selected}
            entry={current}
            onSaved={(id) => setSelected(id)}
            onDeleted={() => setSelected(entries.find((e) => e.id !== selected)?.id ?? "new")}
          />
        )}
      </div>
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={() => (setOverlay("none"), setSelected(null))}>
          Done <Hint>esc</Hint>
        </Btn>
      </ModalFooter>
    </Modal>
  );
}

function EntryForm({ entry, onSaved, onDeleted }: { entry: VaultEntry | null; onSaved: (id: string) => void; onDeleted: () => void }) {
  const servers = useConfig((s) => s.snapshot?.config?.servers ?? NO_SERVERS);
  const [name, setName] = useState(entry?.name ?? "");
  const [username, setUsername] = useState(entry?.username ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [sudoFor, setSudoFor] = useState<string[]>(entry?.sudoFor ?? []);
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const isNew = entry === null;
  const dirty =
    isNew ||
    password !== "" ||
    name !== entry.name ||
    username !== entry.username ||
    notes !== entry.notes ||
    sudoFor.join() !== entry.sudoFor.join();
  const canSave = name.trim() !== "" && (!isNew || password !== "") && dirty && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const id = await useVault.getState().save({ id: entry?.id ?? null, name, username, notes, sudoFor, password: password || null });
    setBusy(false);
    if (id) {
      setPassword("");
      onSaved(id);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          {(id) => <TextInput id={id} autoFocus={isNew} value={name} placeholder="Acme root" className="font-sans" onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Username" hint="Optional; helps suggest it at an ssh login">
          {(id) => <TextInput id={id} value={username} placeholder="root" onChange={(e) => setUsername(e.target.value)} />}
        </Field>
      </div>
      <Field label={isNew ? "Password" : "New password"} hint={isNew ? undefined : "Leave empty to keep the saved one (it's never shown)"}>
        {(id) => (
          <div className="flex gap-2">
            <TextInput
              id={id}
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={password}
              placeholder={isNew ? "" : "•••••••• saved"}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Btn size="sm" variant="ghost" className="h-[30px]" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide" : "Show"}>
              {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Btn>
            <Btn
              size="sm"
              variant="outline"
              className="h-[30px]"
              onClick={() => {
                setPassword(generate());
                setShow(true);
              }}
              title="A random 24-character password"
            >
              <Wand2 className="size-3.5" /> Generate
            </Btn>
          </div>
        )}
      </Field>
      <Field label="sudo password on" hint="Used when saving root-owned files (vhosts, Supervisor) on these servers, and suggested at their sudo prompts">
        {() => (
          <div className="flex flex-wrap gap-1.5">
            {servers.map((s) => {
              const on = sudoFor.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSudoFor(on ? sudoFor.filter((x) => x !== s.id) : [...sudoFor, s.id])}
                  className={cn(
                    "h-6 cursor-pointer rounded-md border px-2 text-[11.5px]",
                    on ? "border-primary bg-primary/10 text-foreground" : "border-control-border text-muted-foreground hover:bg-hover-strong",
                  )}
                >
                  {on ? "✓ " : ""}
                  {s.name}
                </button>
              );
            })}
          </div>
        )}
      </Field>
      <Field label="Notes">
        {(id) => (
          <textarea
            id={id}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional"
            className="block h-[64px] w-full resize-none rounded-lg border border-control-border bg-background px-2.5 py-2 text-[12.5px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary/60"
          />
        )}
      </Field>
      <div className="mt-auto flex items-center gap-2 pt-1">
        {!isNew && (
          <>
            <Btn size="sm" variant="outline" onClick={() => void copyPassword(entry)}>
              <Copy className="size-3.5" /> Copy password
            </Btn>
            <Btn
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (await askConfirm(`Delete “${entry.name}”?`, "The saved password is removed from this Mac.", "Delete")) {
                  await useVault.getState().remove(entry.id);
                  onDeleted();
                }
              }}
            >
              <Trash2 className="size-3.5" /> Delete
            </Btn>
          </>
        )}
        <span className="flex-1" />
        <Btn type="submit" variant="primary" disabled={!canSave}>
          {isNew ? "Save password" : "Save changes"}
        </Btn>
      </div>
    </form>
  );
}
