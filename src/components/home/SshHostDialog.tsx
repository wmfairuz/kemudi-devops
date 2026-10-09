import { useEffect, useState } from "react";
import { create } from "zustand";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, TextInput } from "@/components/manage/fields";
import {
  errorMessage,
  sshConfigOpen,
  sshHostInfo,
  sshHostAdopt,
  sshHostDelete,
  sshHostSave,
  sshKeys,
  sshTest,
  type HostEntry,
  type HostInfo,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { toastError, useToasts } from "@/stores/toasts";

/** Open with an alias (view/edit it) or null (new). */
export const useSshHostDialog = create<{
  target: { alias: string | null } | null;
  open(alias: string | null): void;
  close(): void;
  /** Bumped after a save so lists reload. */
  saved: number;
}>((set) => ({
  target: null,
  saved: 0,
  open: (alias) => set({ target: { alias } }),
  close: () => set({ target: null }),
}));

const portOf = (p: string) => (/^\d{1,5}$/.test(p) && Number(p) > 0 && Number(p) < 65536 ? Number(p) : null);

export function SshHostDialog() {
  const target = useSshHostDialog((s) => s.target);
  if (!target) return null;
  return <HostForm key={target.alias ?? "new"} alias={target.alias} />;
}

function HostForm({ alias: original }: { alias: string | null }) {
  const close = useSshHostDialog((s) => s.close);
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [alias, setAlias] = useState(original ?? "");
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [port, setPort] = useState("");
  const [key, setKey] = useState("");
  const [jump, setJump] = useState("");
  const [extra, setExtra] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [test, setTest] = useState<{ ok: boolean; message: string } | "testing" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sshKeys().then((k) => setKeys(k ?? []), () => {});
    if (!original) return;
    sshHostInfo(original).then(
      (i) => {
        setInfo(i);
        if (i.managed) {
          setAddress(i.managed.hostname);
          setUser(i.managed.user ?? "");
          setPort(i.managed.port ? String(i.managed.port) : "");
          setKey(i.managed.identityFile ?? "");
          setJump(i.managed.jump ?? "");
          setExtra(i.managed.extra.join("\n"));
        }
      },
      (e) => toastError(errorMessage(e)),
    );
  }, [original]);

  // Someone else's host (their own ~/.ssh/config): shown, not edited.
  const external = !!original && !!info && !info.managed;
  const entry: HostEntry = {
    alias: alias.trim(),
    hostname: address.trim(),
    user: user.trim() || null,
    port: port.trim() ? portOf(port.trim()) : null,
    identityFile: key.trim() || null,
    jump: jump.trim() || null,
    extra: extra.split("\n").map((l) => l.trim()).filter(Boolean),
  };
  const valid = entry.alias !== "" && entry.hostname !== "" && (port.trim() === "" || entry.port !== null);

  const save = async () => {
    if (!valid || busy || external) return;
    setBusy(true);
    try {
      await sshHostSave(original, entry);
      useToasts.getState().push(`Saved SSH host ${entry.alias}: ssh ${entry.alias} works in any terminal`, "info");
      useSshHostDialog.setState((s) => ({ saved: s.saved + 1 }));
      close();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const usedBy = (alias: string) =>
    (useConfig.getState().snapshot?.config?.servers ?? []).filter((s) => s.host === alias).map((s) => s.name);

  const remove = async () => {
    if (!original) return;
    const users = usedBy(original);
    const ok = await askConfirm(
      `Delete SSH host ${original}?`,
      `Removes it from ~/.ssh/config.d/kemudi.conf; ssh ${original} stops working.` +
        (users.length ? ` Still used by: ${users.join(", ")} (they won't connect until you pick another SSH host).` : ""),
    );
    if (!ok) return;
    setBusy(true);
    try {
      await sshHostDelete(original);
      useToasts.getState().push(`Deleted SSH host ${original}`, "info");
      useSshHostDialog.setState((s) => ({ saved: s.saved + 1 }));
      close();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const adopt = async () => {
    if (!original) return;
    const ok = await askConfirm(
      `Manage ${original} in Kemudi?`,
      `Moves its Host block from ~/.ssh/config into ~/.ssh/config.d/kemudi.conf (a timestamped backup of ~/.ssh/config is made first). ssh ${original} keeps working everywhere; you can then edit it here.`,
      "Move it",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await sshHostAdopt(original);
      useToasts.getState().push(`${original} is now managed in Kemudi`, "info");
      useSshHostDialog.setState((s) => ({ saved: s.saved + 1 }));
      // Reopen as Kemudi's host (editable).
      useSshHostDialog.getState().close();
      setTimeout(() => useSshHostDialog.getState().open(original), 0);
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = original ? (external ? original : `Edit ${original}`) : "New SSH host";
  const r = info?.resolved;

  return (
    <Modal open onOpenChange={(o) => !o && close()} title={title} width={540}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ModalHeader>
          <span className="text-[15px] font-semibold">{title}</span>
          <span className="text-[12.5px] text-muted-foreground">
            {external
              ? info?.adoptBlocker
                ? `From your ~/.ssh/config. Kemudi can't move it: ${info.adoptBlocker}.`
                : "From your ~/.ssh/config. Manage in Kemudi moves it here so you can edit it."
              : "Saved to ~/.ssh/config.d/kemudi.conf, so ssh <name> works in any terminal. No passwords are stored."}
          </span>
        </ModalHeader>
        <div className="flex flex-col gap-3 px-5 pb-4">
          {external ? (
            <div className="rounded-lg border border-divider bg-panel px-4 py-3 font-mono text-[12.5px]">
              {r ? `${r.user ? `${r.user}@` : ""}${r.hostname ?? original}:${r.port ?? 22}${r.proxyjump ? ` via ${r.proxyjump}` : ""}` : "…"}
            </div>
          ) : (
            <>
              <Field label="Name (what you type after ssh)" hint={original ? undefined : "e.g. stg-web4"}>
                {(fid) => (
                  <TextInput id={fid} autoFocus={!original} value={alias} placeholder="stg-web4" onChange={(e) => setAlias(e.target.value)} />
                )}
              </Field>
              <Field label="Address">
                {(fid) => (
                  <TextInput
                    id={fid}
                    autoFocus={!!original}
                    value={address}
                    placeholder="10.0.1.13 or server.example.com"
                    onChange={(e) => setAddress(e.target.value)}
                  />
                )}
              </Field>
              <div className="grid grid-cols-[1fr_100px] gap-3">
                <Field label="User">
                  {(fid) => <TextInput id={fid} value={user} placeholder="root (empty: your Mac user)" onChange={(e) => setUser(e.target.value)} />}
                </Field>
                <Field label="Port">
                  {(fid) => (
                    <TextInput
                      id={fid}
                      value={port}
                      placeholder="22"
                      invalid={port.trim() !== "" && entry.port === null}
                      onChange={(e) => setPort(e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Field label="Key" hint="Empty: your ssh-agent and default keys">
                {(fid) => (
                  <>
                    <TextInput id={fid} list="kemudi-ssh-keys-dlg" value={key} placeholder="~/.ssh/id_ed25519" onChange={(e) => setKey(e.target.value)} />
                    <datalist id="kemudi-ssh-keys-dlg">
                      {keys.map((k) => (
                        <option key={k} value={k} />
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
              <Field label="Jump host (optional)">
                {(fid) => <TextInput id={fid} value={jump} placeholder="bastion" onChange={(e) => setJump(e.target.value)} />}
              </Field>
              <Field label="Other options (optional)" hint="Any other ssh setting, one per line, e.g. ForwardAgent yes">
                {(fid) => (
                  <textarea
                    id={fid}
                    value={extra}
                    spellCheck={false}
                    placeholder={"ServerAliveInterval 30\nForwardAgent yes"}
                    onChange={(e) => setExtra(e.target.value)}
                    className="h-[64px] w-full resize-y rounded-lg border border-control-border bg-background px-2.5 py-2 font-mono text-[12.5px] leading-[19px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary/60"
                  />
                )}
              </Field>
            </>
          )}
          <div className="flex flex-col items-start gap-1.5">
            <Btn
              size="sm"
              variant="outline"
              disabled={test === "testing" || (!external && !valid)}
              onClick={() => {
                setTest("testing");
                sshTest(external ? original : null, external ? null : entry).then(setTest, (e) =>
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
        </div>
        <ModalFooter>
          {external && (
            <Btn variant="ghost" className="px-2.5" onClick={() => void sshConfigOpen().catch((e) => toastError(errorMessage(e)))}>
              Open ~/.ssh/config
            </Btn>
          )}
          {original && info?.managed && (
            <Btn variant="ghost" className="px-2.5 text-env-prod-fg" disabled={busy} onClick={() => void remove()}>
              Delete…
            </Btn>
          )}
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={close}>
            {external ? "Close" : "Cancel"} <Hint>esc</Hint>
          </Btn>
          {!external && (
            <Btn type="submit" variant="primary" disabled={!valid || busy}>
              {original ? "Save" : "Add SSH host"}
            </Btn>
          )}
          {external && (
            <Btn
              variant="primary"
              disabled={busy || !!info?.adoptBlocker}
              title={info?.adoptBlocker ?? "Move this host into Kemudi's file so you can edit it here"}
              onClick={() => void adopt()}
            >
              Manage in Kemudi
            </Btn>
          )}
        </ModalFooter>
      </form>
    </Modal>
  );
}
