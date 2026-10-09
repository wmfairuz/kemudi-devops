import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { Btn } from "@/components/kit/Btn";
import { CodeEditor, DiffView, type CodeLanguage } from "@/components/kit/CodeEditor";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { EnvTable } from "@/components/manage/EnvTable";
import { Segmented } from "@/components/manage/fields";
import { triggerAction } from "@/lib/actions";
import { copyText } from "@/lib/clipboard";
import { cronProblems } from "@/lib/cron";
import { summarize } from "@/lib/envFile";
import { errorMessage, remoteFileRead, remoteFileRestore, remoteFileWrite, type Env, type RemoteFile, type RemoteFileTarget } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { askConfirm } from "@/stores/confirm";
import { toastError, useToasts } from "@/stores/toasts";

/** One choice of file (cron: which crontab / cron.d file). */
export interface FileChoice {
  label: string;
  target: RemoteFileTarget;
}

export interface EditRequest {
  serverId: string;
  env: Env;
  /** The app it's edited for (History; the .env's own app). */
  appId: string | null;
  /** "Edit .env · Billing" */
  title: string;
  /** The files offered (first one opens); usually just one. */
  choices: FileChoice[];
  /** A warning shown above the editor (e.g. a wildcard vhost). */
  note?: string;
  /** After a save or restore (Inspect reads the app again). */
  onSaved?: () => void;
}

export const useFileEditor = create<{ request: EditRequest | null; open(r: EditRequest): void; close(): void }>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export function FileEditorDialog() {
  const request = useFileEditor((s) => s.request);
  if (!request) return null;
  return <FileEditor key={JSON.stringify([request.serverId, request.choices[0]?.target])} request={request} />;
}

/** Labels for the cron sources Inspect found ("user:www-data", "file:/etc/cron.d/x"). */
export function cronChoices(sources: string[]): FileChoice[] {
  const out: FileChoice[] = sources.map((s) =>
    s.startsWith("user:")
      ? { label: `crontab · ${s.slice(5)}`, target: { kind: "crontab", user: s.slice(5) } }
      : { label: s.slice(5), target: { kind: "cronFile", file: s.slice(5) } },
  );
  if (out.length === 0) {
    out.push(
      { label: "your crontab", target: { kind: "crontab", user: null } },
      { label: "crontab · www-data", target: { kind: "crontab", user: "www-data" } },
    );
  }
  return out;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "edit" }
  | { kind: "review" }
  | { kind: "saving" }
  | { kind: "saved"; backup: string; summary: string; check: string | null; wasFailing?: boolean }
  | { kind: "restoring"; backup: string }
  | { kind: "restored"; check: string | null }
  /** The config test failed with the change; the server has the old file. */
  | { kind: "rejected"; check: string }
  | { kind: "conflict" };

/** Highlighting for a file by its name (file explorer). */
function langOfPath(path: string): CodeLanguage {
  const name = path.split("/").pop() ?? "";
  if (name === ".env" || name.startsWith(".env.")) return "env";
  if (/\.(sh|bash|zsh)$/.test(name) || name === ".bashrc" || name === ".profile" || name === "crontab") return "shell";
  if (/\.(ini|cnf)$/.test(name) || /supervisor/.test(path)) return "ini";
  if (/\/(nginx|sites-(available|enabled))\//.test(path) || name === "nginx.conf") return "nginx";
  if (/\.conf$/.test(name)) return "ini";
  return "plain";
}

const langOf = (t: RemoteFileTarget): CodeLanguage =>
  t.kind === "path"
    ? langOfPath(t.path)
    : t.kind === "env"
      ? "env"
      : t.kind === "supervisor"
        ? "ini"
        : t.kind === "vhost"
          ? t.web === "nginx"
            ? "nginx"
            : "plain"
          : "shell";

const testName = (t: RemoteFileTarget) => (t.kind === "vhost" && t.web === "apache" ? "apachectl configtest" : "nginx -t");

/** Line-count summary like the backend's ("+2 −1 lines"). */
function linesSummary(before: string, after: string): string {
  const counts = new Map<string, number>();
  for (const l of before.split("\n")) counts.set(l, (counts.get(l) ?? 0) - 1);
  for (const l of after.split("\n")) counts.set(l, (counts.get(l) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  for (const n of counts.values()) n > 0 ? (added += n) : (removed -= n);
  return added || removed ? `+${added} −${removed} lines` : "no line changes";
}

function FileEditor({ request }: { request: EditRequest }) {
  const { serverId, env, appId, title } = request;
  const prod = env === "prod";
  const [choice, setChoice] = useState(0);
  const target = request.choices[choice]!.target;
  const kind = target.kind;
  const [file, setFile] = useState<RemoteFile | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [mode, setMode] = useState<"table" | "text">(kind === "env" ? "table" : "text");
  const [typed, setTyped] = useState("");

  const load = async (t: RemoteFileTarget = target) => {
    setPhase({ kind: "loading" });
    try {
      const f = await remoteFileRead(serverId, t);
      setFile(f);
      setText(f.content);
      setPhase({ kind: "edit" });
    } catch (e) {
      setFile(null);
      setPhase({ kind: "error", message: errorMessage(e) });
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice]);

  const dirty = file !== null && text !== file.content;
  const summary = file ? (kind === "env" ? summarize(file.content, text) : linesSummary(file.content, text)) : "";
  const problems = useMemo(
    () => (kind === "crontab" || kind === "cronFile" ? cronProblems(text, kind === "cronFile") : []),
    [kind, text],
  );
  const discardOk = async () =>
    !dirty || phase.kind === "saved" || (await askConfirm("Discard your changes?", "Nothing has been saved to the server.", "Discard"));
  const close = async () => {
    if (await discardOk()) useFileEditor.getState().close();
  };
  const pick = async (i: number) => {
    if (i !== choice && (await discardOk())) setChoice(i);
  };

  // cron needs a newline after the last line.
  const content = (kind === "crontab" || kind === "cronFile") && text !== "" && !text.endsWith("\n") ? `${text}\n` : text;

  const save = async () => {
    if (!file) return;
    setPhase({ kind: "saving" });
    try {
      const r = await remoteFileWrite(serverId, target, file.content, content, appId);
      if (r.outcome === "conflict") return setPhase({ kind: "conflict" });
      // Rolled back: the server kept the old file; your text stays here.
      if (r.outcome === "rejected") return setPhase({ kind: "rejected", check: r.check });
      setFile({ ...file, content });
      setText(content);
      setPhase({ kind: "saved", backup: r.backup, summary: r.summary, check: r.check, wasFailing: r.wasFailing });
      request.onSaved?.();
    } catch (e) {
      toastError(errorMessage(e));
      setPhase({ kind: "review" });
    }
  };

  const restore = async (backup: string) => {
    setPhase({ kind: "restoring", backup });
    try {
      const r = await remoteFileRestore(serverId, target, backup, appId);
      setPhase({ kind: "restored", check: r.check });
      request.onSaved?.();
    } catch (e) {
      toastError(errorMessage(e));
      setPhase((p) => (p.kind === "restoring" ? { kind: "saved", backup, summary: "", check: null } : p));
    }
  };

  const readOnly = file?.access === "none";
  const canReview = dirty && !readOnly && problems.length === 0;
  const canSave = !prod || typed === serverId;
  const lang = langOf(target);

  return (
    <Modal open onOpenChange={(o) => !o && void close()} title={title} width={920}>
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">{title}</span>
          <span className="text-[12.5px] text-subtle-foreground">on {serverId}</span>
          <EnvTag env={env} />
          <span className="flex-1" />
          {phase.kind === "edit" && kind === "env" && (
            <Segmented
              label="View"
              value={mode}
              onChange={setMode}
              options={[
                { value: "table", label: "Table" },
                { value: "text", label: "Text" },
              ]}
            />
          )}
        </div>
        {request.choices.length > 1 && (phase.kind === "edit" || phase.kind === "loading" || phase.kind === "error") && (
          <div className="flex flex-wrap gap-1.5">
            {request.choices.map((c, i) => (
              <button
                key={c.label}
                onClick={() => void pick(i)}
                className={cn(
                  "h-6 cursor-pointer rounded-md border px-2 font-mono text-[11.5px]",
                  i === choice ? "border-primary bg-primary/10 text-foreground" : "border-control-border text-muted-foreground hover:bg-hover-strong",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {request.note && <span className="text-[12px] text-env-staging-fg">{request.note}</span>}
        {file && (
          <span className="selectable font-mono text-[11.5px] text-subtle-foreground">
            {file.path} ·{" "}
            {file.access === "direct" ? "saved as your ssh user" : file.access === "sudo" ? "saved with sudo" : "read-only: sudo needs a password here"}
          </span>
        )}
      </ModalHeader>

      <div className="flex h-[min(62vh,560px)] flex-col border-t border-divider">
        {phase.kind === "loading" && <Center>Reading from {serverId}…</Center>}
        {phase.kind === "error" && (
          <Center>
            <span className="max-w-[620px] text-center text-env-prod-fg">{phase.message}</span>
            <Btn size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Btn>
          </Center>
        )}
        {phase.kind === "edit" && file && (
          <>
            {readOnly && (
              <div className="bg-env-staging/12 px-5 py-2 text-[12px] text-env-staging-fg">
                You can read this but not save it: writing needs sudo, and sudo asks for a password on {serverId}. Save the sudo password on the
                server's page (Passwords) to edit it here.
              </div>
            )}
            {(kind === "crontab" || kind === "cronFile") && (
              <div className="border-b border-divider px-5 py-1.5 font-mono text-[11px] text-subtle-foreground">
                minute hour day month weekday {kind === "cronFile" ? "user " : ""}command · e.g. * * * * * {kind === "cronFile" ? "www-data " : ""}cd /app &&
                php artisan schedule:run
              </div>
            )}
            {kind === "env" && mode === "table" ? (
              <EnvTable text={text} onChange={setText} />
            ) : (
              <CodeEditor value={text} onChange={setText} lang={lang} className="flex-1" autoFocus onSave={() => canReview && setPhase({ kind: "review" })} />
            )}
            {problems.length > 0 && (
              <div className="max-h-[96px] overflow-y-auto border-t border-divider bg-env-prod/8 px-5 py-1.5 text-[12px] text-env-prod-fg">
                {problems.map((p) => (
                  <div key={p.line}>
                    Line {p.line}: {p.message}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {(phase.kind === "review" || phase.kind === "saving") && file && (
          <>
            <div className="px-5 py-2 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">{summary}</span>
              {" · "}a backup of the current version is kept on the server.
            </div>
            <DiffView original={file.content} value={content} lang={lang} className="flex-1 border-t border-divider" />
          </>
        )}
        {phase.kind === "saved" && file && (
          <AfterSave
            kind={kind}
            file={file}
            phase={phase}
            onRestore={() => void restore(phase.backup)}
            onApplySupervisor={() => {
              useFileEditor.getState().close();
              void triggerAction({ serverId, appId: null, actionId: "supervisor-update" });
            }}
            onReloadWeb={() => {
              useFileEditor.getState().close();
              if (target.kind === "vhost") void triggerAction({ serverId, appId: null, actionId: `web-reload:${target.web}` });
            }}
            testName={testName(target)}
            onRecache={() => {
              useFileEditor.getState().close();
              if (appId) void triggerAction({ serverId, appId, actionId: "laravel:config-cache" });
            }}
          />
        )}
        {phase.kind === "rejected" && (
          <Center>
            <div className="max-w-[600px] text-center text-[13px] leading-5 text-env-prod-fg">
              <span className="font-medium">{testName(target)} failed with your change, so Kemudi put the old file straight back.</span> Nothing changed on{" "}
              {serverId}; your edit is still here to fix.
            </div>
            <CheckOutput text={phase.check} />
          </Center>
        )}
        {phase.kind === "restoring" && <Center>Putting the backup back…</Center>}
        {phase.kind === "restored" && (
          <Center>
            <div className="text-[13px] font-medium text-status-up">Restored the previous version</div>
            {phase.check && <CheckOutput text={phase.check} />}
          </Center>
        )}
        {phase.kind === "conflict" && (
          <Center>
            <div className="max-w-[520px] text-center text-[13px] leading-5 text-env-prod-fg">
              It changed on {serverId} since you opened it, so nothing was saved. Reload to see the new version (your edits here are dropped; copy them
              first if you need them).
            </div>
            <div className="flex gap-2">
              <Btn size="sm" variant="outline" onClick={() => void copyText(text).then(() => useToasts.getState().push("Copied your version", "info"))}>
                Copy my version
              </Btn>
              <Btn size="sm" variant="primary" onClick={() => void load()}>
                Reload from server
              </Btn>
            </div>
          </Center>
        )}
      </div>

      <ModalFooter>
        {phase.kind === "edit" && (
          <>
            <span className="min-w-0 flex-1 truncate text-[12px] text-subtle-foreground">
              {problems.length ? `${problems.length} line${problems.length === 1 ? "" : "s"} to fix first` : dirty ? summary : "No changes yet"}
            </span>
            <Btn variant="outline" className="pr-2.5" onClick={() => void close()}>
              Cancel <Hint>esc</Hint>
            </Btn>
            <Btn variant="primary" disabled={!canReview} onClick={() => setPhase({ kind: "review" })}>
              Review changes
            </Btn>
          </>
        )}
        {(phase.kind === "review" || phase.kind === "saving") && (
          <>
            {prod ? (
              <input
                autoFocus
                value={typed}
                spellCheck={false}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && canSave && void save()}
                placeholder={`type ${serverId} to save`}
                aria-label="Type the server name to save"
                className={cn(
                  "h-[30px] w-[240px] rounded-lg border bg-background px-2.5 font-mono text-[12.5px] outline-none placeholder:text-faint-foreground",
                  typed === serverId ? "border-env-prod/70" : "border-control-border",
                )}
              />
            ) : null}
            <span className="flex-1" />
            <Btn variant="outline" onClick={() => setPhase({ kind: "edit" })} disabled={phase.kind === "saving"}>
              Back to editing
            </Btn>
            <Btn variant={prod ? "danger" : "primary"} disabled={!canSave || phase.kind === "saving"} onClick={() => void save()}>
              {phase.kind === "saving" ? "Saving…" : `Save to ${serverId}`}
            </Btn>
          </>
        )}
        {phase.kind === "rejected" && (
          <>
            <span className="flex-1" />
            <Btn variant="outline" onClick={() => void close()}>
              Close
            </Btn>
            <Btn variant="primary" onClick={() => setPhase({ kind: "edit" })}>
              Back to editing
            </Btn>
          </>
        )}
        {phase.kind !== "edit" && phase.kind !== "review" && phase.kind !== "saving" && phase.kind !== "rejected" && (
          <>
            <span className="flex-1" />
            <Btn variant="outline" disabled={phase.kind === "restoring"} onClick={() => void close()}>
              {phase.kind === "saved" || phase.kind === "restored" ? "Done" : "Close"}
            </Btn>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

function AfterSave({
  kind,
  file,
  phase,
  onRestore,
  onApplySupervisor,
  onRecache,
  onReloadWeb,
  testName,
}: {
  kind: RemoteFileTarget["kind"];
  file: RemoteFile;
  phase: Extract<Phase, { kind: "saved" }>;
  onRestore: () => void;
  onApplySupervisor: () => void;
  onRecache: () => void;
  onReloadWeb: () => void;
  testName: string;
}) {
  const check = phase.check ?? "";
  const broken = /error/i.test(check);
  const changed = /:\s*(changed|added|removed|available)/i.test(check);
  return (
    <Center>
      <div className="max-w-[600px] text-center text-[13px] leading-5">
        <div className="font-medium text-status-up">Saved {file.path}</div>
        {phase.summary && <div className="mt-1 text-muted-foreground">{phase.summary}</div>}
        <div className="selectable mt-1 font-mono text-[11.5px] text-subtle-foreground">backup: {phase.backup}</div>
      </div>
      {kind === "supervisor" && (
        <div
          className={cn(
            "flex w-[600px] max-w-full flex-col items-center gap-2 rounded-lg px-4 py-3 text-center text-[12.5px] leading-[18px]",
            broken ? "bg-env-prod/10 text-env-prod-fg" : "bg-hover text-muted-foreground",
          )}
        >
          <span>
            {broken
              ? "Supervisor can't read the config now. Nothing restarted; put the old version back or fix it."
              : changed
                ? "Supervisor sees the change. Nothing restarts until you apply it (only the changed programs restart)."
                : "Supervisor reports no program changes."}
          </span>
          {check && <CheckOutput text={check} />}
          <div className="flex gap-2">
            {changed && !broken && (
              <Btn size="sm" variant="primary" onClick={onApplySupervisor}>
                Apply (supervisorctl update)
              </Btn>
            )}
            <Btn size="sm" variant={broken ? "danger" : "outline"} onClick={onRestore}>
              Restore the backup
            </Btn>
          </div>
        </div>
      )}
      {kind === "vhost" && (
        <div
          className={cn(
            "flex w-[600px] max-w-full flex-col items-center gap-2 rounded-lg px-4 py-3 text-center text-[12.5px] leading-[18px]",
            phase.wasFailing ? "bg-env-staging/12 text-env-staging-fg" : "bg-hover text-muted-foreground",
          )}
        >
          <span>
            {phase.wasFailing
              ? `${testName} was already failing before this change, so Kemudi kept it. Check the output before reloading.`
              : `${testName} passes. The web server still runs the old config until it reloads.`}
          </span>
          {check && <CheckOutput text={check} />}
          <div className="flex gap-2">
            {!phase.wasFailing && (
              <Btn size="sm" variant="primary" onClick={onReloadWeb}>
                Reload now
              </Btn>
            )}
            <Btn size="sm" variant="outline" onClick={onRestore}>
              Restore the backup
            </Btn>
          </div>
        </div>
      )}
      {kind === "env" && file.configCached && (
        <div className="flex max-w-[560px] flex-col items-center gap-2 rounded-lg bg-env-staging/12 px-4 py-3 text-center text-[12.5px] leading-[18px] text-env-staging-fg">
          Laravel's config is cached on this server, so the app keeps using the old values until it's cached again.
          <Btn size="sm" variant="primary" onClick={onRecache}>
            Re-cache config now
          </Btn>
        </div>
      )}
      {kind === "env" && (
        <div className="max-w-[560px] text-center text-[12px] text-subtle-foreground">
          Queue workers and other long-running processes keep the old values until they restart (Supervisor › Restart in Inspect).
        </div>
      )}
      {kind === "path" && (
        <Btn size="sm" variant="outline" onClick={onRestore}>
          Restore the backup
        </Btn>
      )}
      {(kind === "crontab" || kind === "cronFile") && (
        <div className="flex flex-col items-center gap-2 text-center text-[12px] text-subtle-foreground">
          Cron picks it up within a minute.
          <Btn size="sm" variant="outline" onClick={onRestore}>
            Restore the backup
          </Btn>
        </div>
      )}
    </Center>
  );
}

function CheckOutput({ text }: { text: string }) {
  return (
    <pre className="selectable max-h-[140px] w-full overflow-auto rounded-md border border-divider bg-background px-3 py-2 text-left font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap text-foreground">
      {text}
    </pre>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-4 text-[13px] text-muted-foreground">{children}</div>;
}
