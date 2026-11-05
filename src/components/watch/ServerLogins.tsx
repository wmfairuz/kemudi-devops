import { Copy, KeyRound, Pencil, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Spinner } from "@/components/kit/Spinner";
import { copyText } from "@/lib/clipboard";
import { errorMessage, sshHostInfo, vaultServerNotes, vaultServerNotesSave, type HostInfo, type Server, type VaultEntry, type VaultKind } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { openServer } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";
import { copyPassword, KIND_LABEL, kindOf, useVault } from "@/stores/vault";

const ORDER: VaultKind[] = ["os", "db", "web", "other"];

/** A server's Overview ▸ Logins: how ssh reaches it, the saved passwords
 *  that are logins on it (OS users, databases, web logins…), and notes.
 *  Passwords and notes are encrypted on this Mac; passwords are never shown,
 *  only copied or filled at a prompt (⌘⇧P). */
export function ServerLogins({ server }: { server: Server }) {
  const entries = useVault((s) => s.entries);
  const loaded = useVault((s) => s.loaded);
  const error = useVault((s) => s.error);
  useEffect(() => {
    if (!loaded) void useVault.getState().load();
  }, [loaded]);
  const mine = entries
    .filter((e) => e.servers.includes(server.id) || e.sudoFor.includes(server.id))
    .sort((a, b) => ORDER.indexOf(kindOf(a)) - ORDER.indexOf(kindOf(b)) || a.name.localeCompare(b.name));
  const show = useVault.getState().show;

  return (
    <section className="flex flex-col overflow-hidden rounded-xl border border-divider bg-panel">
      <div className="flex h-10 flex-none items-center gap-1 border-b border-divider px-3.5">
        <span className="flex-1 text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">Logins</span>
        <span className="mr-1 text-[11px] text-subtle-foreground">Encrypted on this Mac</span>
        {ORDER.map((k) => (
          <button
            key={k}
            className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] text-primary hover:bg-primary/10"
            title={`Save a ${KIND_LABEL[k].toLowerCase()} password for ${server.name}`}
            onClick={() => show({ server: server.id, kind: k })}
          >
            <Plus className="size-3" /> {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col border-divider lg:border-r">
          <SshRow server={server} />
          {error && <div className="px-3.5 py-2 text-[12px] text-env-prod-fg">{error}</div>}
          {!loaded && !error && (
            <div className="flex items-center gap-2 px-3.5 py-2 text-[12px] text-subtle-foreground">
              <Spinner size={10} /> Reading Passwords…
            </div>
          )}
          {mine.map((e) => (
            <LoginRow key={e.id} entry={e} server={server} />
          ))}
          {loaded && !error && mine.length === 0 && (
            <div className="px-3.5 py-2.5 text-[12px] text-subtle-foreground">
              No saved logins. + OS user (e.g. ubuntu, with its sudo password), + Database (e.g. MySQL root)…
            </div>
          )}
        </div>
        <Notes server={server} />
      </div>
    </section>
  );
}

/** How ssh reaches it (from ~/.ssh/config); edited in Settings. */
function SshRow({ server }: { server: Server }) {
  const [info, setInfo] = useState<HostInfo | null>(null);
  useEffect(() => {
    if (server.asg) return;
    let live = true;
    sshHostInfo(server.host)
      .then((i) => live && setInfo(i))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [server.host, server.asg]);
  const r = info?.resolved;
  const key = info?.managed?.identityFile ?? info?.external?.identityFile ?? null;
  return (
    <div className="flex min-h-[38px] items-center gap-2.5 border-b border-divider px-3.5 py-1.5 text-[12.5px]">
      <Kind label="SSH" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
        {server.asg ? (
          <span className="font-sans text-subtle-foreground">Session Manager · {server.asg.name || server.asg.instances.join(", ")}</span>
        ) : r ? (
          <>
            {r.user ?? "?"}@{r.hostname ?? server.host}
            <span className="text-subtle-foreground">
              {" "}
              · port {r.port ?? 22}
              {r.proxyjump && r.proxyjump !== "none" ? ` · via ${r.proxyjump}` : ""}
              {key ? ` · ${key.replace(/^~\/\.ssh\//, "")}` : ""}
            </span>
          </>
        ) : (
          <span className="text-subtle-foreground">{server.host}</span>
        )}
      </span>
      <button className="cursor-pointer rounded-md px-1.5 text-[12px] text-primary hover:bg-primary/10" title="Address, user, port, key: the server's Settings" onClick={() => openServer(server, "settings")}>
        Edit
      </button>
    </div>
  );
}

function LoginRow({ entry, server }: { entry: VaultEntry; server: Server }) {
  const sudo = entry.sudoFor.includes(server.id);
  return (
    <div className="group flex min-h-[38px] items-center gap-2.5 border-b border-divider px-3.5 py-1.5 text-[12.5px] last:border-b-0">
      <Kind label={KIND_LABEL[kindOf(entry)]} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{entry.name}</span>
          {sudo && <span className="flex-none rounded bg-hover-strong px-1 text-[10.5px] text-subtle-foreground" title="Its sudo password: used when saving root-owned files here">sudo</span>}
        </span>
        {entry.notes && <span className="truncate text-[11px] text-subtle-foreground" title={entry.notes}>{entry.notes.split("\n")[0]}</span>}
      </span>
      {entry.username && (
        <button
          className="max-w-[40%] flex-none cursor-pointer truncate rounded-md px-1.5 font-mono text-[12px] hover:bg-hover-strong"
          title="Copy the username"
          onClick={() =>
            void copyText(entry.username).then((ok) => useToasts.getState().push(ok ? `Copied ${entry.username}` : "Couldn't copy", ok ? "info" : "error"))
          }
        >
          {entry.username}
        </button>
      )}
      <Btn size="sm" variant="outline" className="h-6 px-2 text-[11.5px]" title="Copy the password (the clipboard clears after 45 s)" onClick={() => void copyPassword(entry)}>
        <Copy className="size-3" /> Password
      </Btn>
      <button
        className="flex size-6 flex-none cursor-pointer items-center justify-center rounded-md text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
        title="Edit in Passwords"
        aria-label="Edit in Passwords"
        onClick={() => useVault.getState().show({ id: entry.id })}
      >
        <Pencil className="size-3.5" />
      </button>
    </div>
  );
}

function Kind({ label }: { label: string }) {
  return (
    <span className="flex w-[74px] flex-none items-center gap-1.5 text-[11px] text-subtle-foreground">
      {label === "SSH" ? null : <KeyRound className="size-3 flex-none" />}
      {label}
    </span>
  );
}

/** Free-text notes for the server, encrypted with the passwords. */
function Notes({ server }: { server: Server }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSaved(null);
    vaultServerNotes(server.id)
      .then((n) => {
        if (!live) return;
        setSaved(n);
        setText(n);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [server.id]);
  const dirty = saved !== null && text.trimEnd() !== saved;
  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      await vaultServerNotesSave(server.id, text);
      setSaved(text.trimEnd());
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-t border-divider px-3.5 py-2.5 lg:border-t-0">
      <div className="flex h-6 items-center gap-2">
        <span className="flex-1 text-[11px] text-subtle-foreground">Notes</span>
        {dirty && (
          <>
            <button className="cursor-pointer rounded-md px-1.5 text-[12px] text-subtle-foreground hover:bg-hover-strong" onClick={() => setText(saved ?? "")}>
              Undo
            </button>
            <Btn size="sm" variant="primary" className="h-6 px-2.5 text-[11.5px]" disabled={busy} onClick={() => void save()}>
              Save <span className="opacity-70">⌘S</span>
            </Btn>
          </>
        )}
      </div>
      {error ? (
        <div className="text-[12px] text-env-prod-fg">{error}</div>
      ) : (
        <textarea
          value={text}
          disabled={saved === null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.metaKey && (e.key === "s" || e.key === "Enter")) {
              e.preventDefault();
              e.stopPropagation();
              void save();
            }
          }}
          spellCheck={false}
          placeholder={saved === null ? "Reading…" : "MySQL on 3307, only from localhost\nPanel: https://…\nOwner: …"}
          className={cn(
            "block min-h-[96px] w-full flex-1 resize-y rounded-lg border bg-background px-2.5 py-2 font-mono text-[12px] leading-[18px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary/60",
            dirty ? "border-primary/40" : "border-control-border",
          )}
        />
      )}
    </div>
  );
}
