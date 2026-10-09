import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, TextInput } from "@/components/manage/fields";
import { errorMessage, filesChown, filesPrincipals, type Env, type FileEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { toastError, useToasts } from "@/stores/toasts";

const NAME = /^[a-z_][a-z0-9_.-]{0,31}$/;

/** Change owner…: chown [-R] owner:group with sudo; prod asks for the
 *  server name. Suggests the server's own users and groups. */
export function ChownDialog({
  serverId,
  env,
  appId,
  path,
  entry,
  onClose,
  onDone,
}: {
  serverId: string;
  env: Env;
  appId: string | null;
  path: string;
  entry: FileEntry;
  onClose: () => void;
  onDone: () => void;
}) {
  const [owner, setOwner] = useState(entry.owner);
  const [group, setGroup] = useState(entry.group);
  const [recursive, setRecursive] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState<{ users: string[]; groups: string[] }>({ users: [], groups: [] });
  useEffect(() => {
    filesPrincipals(serverId).then(setKnown, () => {});
  }, [serverId]);
  const prod = env === "prod";
  const isDir = entry.kind === "dir" || entry.toDir;
  const changed = owner !== entry.owner || group !== entry.group;
  const ok = NAME.test(owner) && NAME.test(group) && (changed || recursive) && (!prod || typed === serverId) && !busy;

  const apply = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      const now = await filesChown(serverId, path, owner, group, isDir && recursive, appId);
      useToasts.getState().push(`${entry.name} is now ${now}${isDir && recursive ? ", with everything inside" : ""}`, "info");
      onDone();
      onClose();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Change owner" width={520}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <ModalHeader>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">Change owner</span>
            <span className="text-[12.5px] text-subtle-foreground">on {serverId}</span>
            <EnvTag env={env} />
          </div>
          <span className="selectable font-mono text-[11.5px] text-subtle-foreground">
            {path} · now {entry.owner}:{entry.group}
          </span>
        </ModalHeader>
        <div className="flex flex-col gap-3.5 px-5 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Owner">
              {(id) => (
                <>
                  <TextInput id={id} list="kemudi-users" autoFocus value={owner} invalid={!NAME.test(owner)} onChange={(e) => setOwner(e.target.value.trim())} />
                  <datalist id="kemudi-users">
                    {known.users.map((u) => (
                      <option key={u} value={u} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field label="Group">
              {(id) => (
                <>
                  <TextInput id={id} list="kemudi-groups" value={group} invalid={!NAME.test(group)} onChange={(e) => setGroup(e.target.value.trim())} />
                  <datalist id="kemudi-groups">
                    {known.groups.map((g) => (
                      <option key={g} value={g} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
          </div>
          {isDir && (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
              <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
              Also everything inside it (chown -R)
            </label>
          )}
          <div className="text-[11.5px] text-subtle-foreground">
            Runs <span className="font-mono">sudo chown {isDir && recursive ? "-R " : ""}{owner}:{group}</span>; links themselves change, never what they point to.
          </div>
        </div>
        <ModalFooter>
          {prod && (
            <input
              value={typed}
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`type ${serverId} to apply`}
              aria-label="Type the server name to apply"
              className={cn(
                "h-[30px] w-[220px] rounded-lg border bg-background px-2.5 font-mono text-[12.5px] outline-none placeholder:text-faint-foreground",
                typed === serverId ? "border-env-prod/70" : "border-control-border",
              )}
            />
          )}
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={onClose}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant={prod ? "danger" : "primary"} disabled={!ok}>
            {busy ? "Changing…" : "Change owner"}
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
