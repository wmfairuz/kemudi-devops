import { useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { TextInput } from "@/components/manage/fields";
import { errorMessage, filesCreate, filesDelete, filesRename, type Env, type FileEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { toastError, useToasts } from "@/stores/toasts";

interface Props {
  serverId: string;
  env: Env;
  appId: string | null;
  path: string;
  entry: FileEntry;
  onClose: () => void;
  onDone: () => void;
}

const isDir = (e: FileEntry) => e.kind === "dir" || e.toDir;

/** Rename… (F2): a new name in the same folder; never over an existing one. */
export function RenameDialog({ serverId, env, appId, path, entry, onClose, onDone }: Props) {
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const valid = name.trim() !== "" && name !== "." && name !== ".." && !name.includes("/");
  const ok = valid && name.trim() !== entry.name && !busy;
  const apply = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await filesRename(serverId, path, name.trim(), appId);
      useToasts.getState().push(`Renamed to ${name.trim()}`, "info");
      onDone();
      onClose();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // Select the name without its extension, like Finder.
  const selectStem = (el: HTMLInputElement | null) => {
    if (!el) return;
    const dot = entry.name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 && !isDir(entry) ? dot : entry.name.length);
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Rename" width={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <ModalHeader>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">Rename {isDir(entry) ? "folder" : "file"}</span>
            <span className="text-[12.5px] text-subtle-foreground">on {serverId}</span>
            <EnvTag env={env} />
          </div>
          <span className="selectable truncate font-mono text-[11.5px] text-subtle-foreground">{path}</span>
        </ModalHeader>
        <div className="px-5 pb-4">
          <TextInput autoFocus ref={selectStem} value={name} invalid={!valid} onChange={(e) => setName(e.target.value)} />
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={onClose}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="primary" disabled={!ok}>
            {busy ? "Renaming…" : "Rename"}
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** Delete… (⌘⌫): a folder goes with everything in it, and a folder or
 *  anything on production needs its name typed. */
export function DeleteDialog({ serverId, env, appId, path, entry, onClose, onDone }: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const dir = isDir(entry) && entry.kind !== "link";
  const mustType = dir || env === "prod";
  const ok = (!mustType || typed === entry.name) && !busy;
  const apply = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await filesDelete(serverId, path, appId);
      useToasts.getState().push(`Deleted ${entry.name}`, "info");
      onDone();
      onClose();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Delete" width={500}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <ModalHeader>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">Delete {entry.name}?</span>
            <EnvTag env={env} />
          </div>
          <span className="selectable truncate font-mono text-[11.5px] text-subtle-foreground">
            {path} on {serverId}
          </span>
        </ModalHeader>
        <div className="flex flex-col gap-3 px-5 pb-4 text-[12.5px] leading-[18px] text-muted-foreground">
          <div className="rounded-lg bg-env-prod/8 px-3 py-2 text-env-prod-fg">
            {entry.kind === "link"
              ? "Removes the link only; what it points to stays."
              : dir
                ? "Deletes the folder and everything inside it, for good: there's no trash on the server."
                : "Deletes the file for good: there's no trash on the server."}
          </div>
          {mustType && (
            <label className="flex flex-col gap-1.5">
              <span>
                Type <span className="font-mono text-foreground">{entry.name}</span> to confirm
              </span>
              <input
                autoFocus
                value={typed}
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
                aria-label="Type the name to confirm"
                className={cn(
                  "h-[30px] rounded-lg border bg-background px-2.5 font-mono text-[12.5px] outline-none",
                  typed === entry.name ? "border-env-prod/70" : "border-control-border",
                )}
              />
            </label>
          )}
        </div>
        <ModalFooter>
          <span className="flex-1" />
          {/* Cancel is focused, so ⌘⌫ then ↵ doesn't delete by accident. */}
          <Btn variant="outline" className="pr-2.5" onClick={onClose} autoFocus={!mustType}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="danger" disabled={!ok}>
            {busy ? "Deleting…" : "Delete"}
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** New folder… / New file…: a name in the folder shown. A new file then
 *  opens in the editor (`onCreated` gets its path). */
export function NewItemDialog({
  serverId,
  env,
  appId,
  dir,
  folder,
  onClose,
  onCreated,
}: {
  serverId: string;
  env: Env;
  appId: string | null;
  dir: string;
  folder: boolean;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = name.trim() !== "" && name.trim() !== "." && name.trim() !== ".." && !name.includes("/");
  const apply = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const path = await filesCreate(serverId, dir, name.trim(), folder, appId);
      onClose();
      onCreated(path);
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={folder ? "New folder" : "New file"} width={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <ModalHeader>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">{folder ? "New folder" : "New file"}</span>
            <span className="text-[12.5px] text-subtle-foreground">on {serverId}</span>
            <EnvTag env={env} />
          </div>
          <span className="selectable truncate font-mono text-[11.5px] text-subtle-foreground">in {dir}</span>
        </ModalHeader>
        <div className="flex flex-col gap-1.5 px-5 pb-4">
          <TextInput
            autoFocus
            value={name}
            placeholder={folder ? "backups" : "notes.txt"}
            invalid={name !== "" && !valid}
            onChange={(e) => setName(e.target.value)}
          />
          <span className="text-[11px] text-subtle-foreground">
            {folder ? "Mode 755." : "Empty, mode 644; it opens in the editor."} Owned like this folder when made with sudo.
          </span>
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={onClose}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="primary" disabled={!valid || busy}>
            {busy ? "Creating…" : folder ? "Create folder" : "Create file"}
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
