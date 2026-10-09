import { useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { TextInput } from "@/components/manage/fields";
import { errorMessage, filesChmod, type Env, type FileEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { toastError, useToasts } from "@/stores/toasts";

const MODE = /^[0-7]{3,4}$/;
const WHO = ["Owner", "Group", "Others"] as const;
const BITS = [
  ["Read", 4],
  ["Write", 2],
  ["Execute", 1],
] as const;

/** `drwxr-sr-x` → "2755" (special bits only when set). */
export function octalOf(mode: string): string {
  const p = mode.slice(1, 10);
  let special = 0;
  const digit = (i: number) => {
    const r = p[i] === "r" ? 4 : 0;
    const w = p[i + 1] === "w" ? 2 : 0;
    const x = p[i + 2]!;
    const exec = x === "x" || x === "s" || x === "t" ? 1 : 0;
    if (x === "s" || x === "S") special |= i === 0 ? 4 : 2;
    if (x === "t" || x === "T") special |= 1;
    return r + w + exec;
  };
  const base = `${digit(0)}${digit(3)}${digit(6)}`;
  return special ? `${special}${base}` : base;
}

/** The three permission digits of a 3/4-digit mode. */
const digitsOf = (m: string) => m.slice(-3);
/** Files usually shouldn't be executable: the folder mode without x. */
const filesFrom = (m: string) => digitsOf(m).replace(/[1357]/g, (d) => String(Number(d) - 1));

/** Change permissions…: chmod with sudo when needed; for a folder,
 *  optionally everything inside (folders one mode, files another). */
export function ChmodDialog({
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
  const current = octalOf(entry.mode);
  const [mode, setMode] = useState(current);
  const [inside, setInside] = useState(false);
  const [filesMode, setFilesMode] = useState(filesFrom(current));
  const [filesTouched, setFilesTouched] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const isDir = entry.kind === "dir" || entry.toDir;
  const prod = env === "prod";
  const valid = MODE.test(mode) && (!inside || MODE.test(filesMode));
  const ok = valid && (mode !== current || inside) && (!prod || typed === serverId) && !busy;

  const setDigits = (m: string) => {
    setMode(m);
    if (!filesTouched && MODE.test(m)) setFilesMode(filesFrom(m));
  };
  const toggle = (who: number, bit: number) => {
    if (!MODE.test(mode)) return;
    const special = mode.length === 4 ? mode[0] : "";
    const d = digitsOf(mode).split("").map(Number);
    d[who] = d[who]! ^ bit;
    setDigits(`${special}${d.join("")}`);
  };

  const apply = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      const now = await filesChmod(serverId, path, mode, isDir && inside ? filesMode : null, appId);
      useToasts.getState().push(
        isDir && inside ? `${entry.name}: folders ${mode}, files ${filesMode}` : `${entry.name} is now ${now}`,
        "info",
      );
      onDone();
      onClose();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const digits = MODE.test(mode) ? digitsOf(mode).split("").map(Number) : [0, 0, 0];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Change permissions" width={520}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <ModalHeader>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">Change permissions</span>
            <span className="text-[12.5px] text-subtle-foreground">on {serverId}</span>
            <EnvTag env={env} />
          </div>
          <span className="selectable font-mono text-[11.5px] text-subtle-foreground">
            {path} · now {entry.mode} ({current}) · {entry.owner}:{entry.group}
          </span>
        </ModalHeader>
        <div className="flex flex-col gap-3.5 px-5 pb-4">
          <div className="grid grid-cols-[80px_repeat(3,1fr)] items-center gap-y-1.5 text-[12.5px]">
            <span />
            {BITS.map(([label]) => (
              <span key={label} className="text-center text-[11.5px] text-subtle-foreground">
                {label}
              </span>
            ))}
            {WHO.map((who, wi) => (
              <div key={who} className="contents">
                <span className="text-muted-foreground">{who}</span>
                {BITS.map(([label, bit]) => (
                  <label key={label} className="flex cursor-pointer justify-center">
                    <input
                      type="checkbox"
                      aria-label={`${who} ${label}`}
                      checked={(digits[wi]! & bit) !== 0}
                      onChange={() => toggle(wi, bit)}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            Mode
            <TextInput className="w-[90px] font-mono" value={mode} invalid={!MODE.test(mode)} onChange={(e) => setDigits(e.target.value.trim())} />
            <span className="text-[11.5px] text-subtle-foreground">e.g. 644 file · 755 folder · 2775 shared folder</span>
          </div>
          {isDir && (
            <div className="flex flex-col gap-2 rounded-lg bg-hover px-3 py-2.5">
              <label className="flex w-fit cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
                <input type="checkbox" checked={inside} onChange={(e) => setInside(e.target.checked)} />
                Also everything inside it
              </label>
              {inside && (
                <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  folders <span className="font-mono text-foreground">{mode}</span> · files
                  <TextInput
                    className="w-[80px] font-mono"
                    value={filesMode}
                    invalid={!MODE.test(filesMode)}
                    onChange={(e) => {
                      setFilesMode(e.target.value.trim());
                      setFilesTouched(true);
                    }}
                  />
                  <span className="text-[11px] text-subtle-foreground">(files without execute, unless you set it)</span>
                </div>
              )}
            </div>
          )}
          <div className="text-[11.5px] text-subtle-foreground">
            Runs{" "}
            <span className="font-mono">
              {isDir && inside ? `find … -type d chmod ${mode}; -type f chmod ${filesMode}` : `chmod ${mode}`}
            </span>{" "}
            as you if you own it, else with sudo. Links are left alone.
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
            {busy ? "Changing…" : "Change permissions"}
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
