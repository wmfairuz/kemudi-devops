import { useMemo, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, Segmented, TextInput, VALID_ID } from "@/components/manage/fields";
import { actionAdd, errorMessage } from "@/lib/ipc";
import { freeId } from "@/stores/manage";
import { useConfig } from "@/stores/config";
import { useSnippets } from "@/stores/snippets";
import { toastError, useToasts } from "@/stores/toasts";
import { useUi, type AddActionTarget } from "@/stores/ui";

/** Where a new action can go, for a server / app (first: the narrowest). */
export function actionChoices(serverId: string | undefined, appId: string | null): NonNullable<AddActionTarget["choices"]> {
  const servers = useConfig.getState().snapshot?.config?.servers ?? [];
  const server = serverId ? servers.find((x) => x.id === serverId) : undefined;
  const app = server && appId ? server.apps.find((a) => a.id === appId) : undefined;
  const choices: NonNullable<AddActionTarget["choices"]> = [];
  if (server && app) {
    choices.push({ scope: { kind: "app", serverId: server.id, appId: app.id }, label: `Only ${app.name}`, title: `Add action to ${app.name}`, env: app.env });
  }
  const team = server?.team ? useConfig.getState().snapshot?.config?.teams.find((t) => t.id === server.team) : undefined;
  if (team) {
    choices.push({ scope: { kind: "teamApp", teamId: team.id }, label: `All apps in ${team.name}`, title: `Add a shared action (every app in ${team.name})`, env: null });
  }
  choices.push({ scope: { kind: "sharedApp" }, label: "All apps", title: "Add a shared action (every app)", env: null });
  if (server) {
    choices.push({ scope: { kind: "server", serverId: server.id }, label: `Only server ${server.id}`, title: `Add action to server ${server.id}`, env: server.env });
  }
  if (team) {
    choices.push({ scope: { kind: "teamServer", teamId: team.id }, label: `All servers in ${team.name}`, title: `Add a shared server action (every server in ${team.name})`, env: null });
  }
  choices.push({ scope: { kind: "sharedServer" }, label: "All servers", title: "Add a shared server action (every server)", env: null });
  return choices;
}

/** "+ Add action" in the Actions panel: a new button for one app/server or
 *  a shared one, saved to servers.yaml. */
export function AddActionDialog() {
  const target = useUi((s) => s.addAction);
  if (!target) return null;
  return <AddActionForm key={JSON.stringify([target.scope, target.fromSnippet ?? null, target.prefill ?? null])} />;
}

function AddActionForm() {
  const target = useUi((s) => s.addAction)!;
  const close = () => useUi.getState().setAddAction(null);
  const [choice, setChoice] = useState(0);
  const picked = target.choices?.[choice];
  const scope = picked?.scope ?? target.scope;
  const title = picked?.title ?? target.title;
  const env = picked ? picked.env : target.env;
  const forApps = scope.kind === "app" || scope.kind === "sharedApp" || scope.kind === "teamApp";
  const [label, setLabel] = useState(target.prefill?.label ?? "");
  // Kemudi's own key for it, from the name, unlike any action already there
  // (the same id would replace a shared action instead of adding one).
  const taken = useMemo(() => {
    const servers = useConfig.getState().snapshot?.config?.servers ?? [];
    return servers.flatMap((sv) => [...sv.actions, ...sv.hidden, ...sv.apps.flatMap((a) => [...a.actions, ...a.hidden])]).map((a) => a.id);
  }, []);
  const id = freeId(label, taken, "action");
  const [run, setRun] = useState(target.prefill?.run ?? "");
  const [dropSnippet, setDropSnippet] = useState(false);
  const [where, setWhere] = useState<"ssh" | "local">("ssh");
  const [danger, setDanger] = useState(target.prefill?.danger ?? false);
  const [busy, setBusy] = useState(false);

  const idOk = VALID_ID.test(id);
  const canSave = idOk && label.trim() !== "" && run.trim() !== "" && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      await actionAdd(scope, {
        id,
        label: label.trim(),
        run,
        danger,
        local: forApps && where === "local",
      });
      useToasts.getState().push(`Added ${label.trim()}`, "info");
      if (target.fromSnippet && dropSnippet) await useSnippets.getState().remove(target.fromSnippet);
      close();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onOpenChange={(o) => !o && close()} title={title} width={560}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ModalHeader>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">{title}</span>
            {env && <EnvTag env={env} />}
          </div>
          <span className="text-[12.5px] text-muted-foreground">Nothing runs yet</span>
        </ModalHeader>
        <div className="flex flex-col gap-3.5 px-5 pb-4">
          {target.choices && (
            <Field label="Add to">
              {() => (
                <div role="radiogroup" aria-label="Add to" className="grid grid-cols-2 gap-1.5">
                  {target.choices!.map((c, i) => (
                    <button
                      key={c.label}
                      type="button"
                      role="radio"
                      aria-checked={i === choice}
                      onClick={() => setChoice(i)}
                      className={
                        i === choice
                          ? "h-8 truncate rounded-lg border border-primary bg-primary/10 px-2.5 text-left text-[12.5px] text-foreground"
                          : "h-8 cursor-pointer truncate rounded-lg border border-control-border px-2.5 text-left text-[12.5px] text-muted-foreground hover:bg-hover-strong hover:text-foreground"
                      }
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </Field>
          )}
          <Field label="Name">
            {(fid) => (
              <TextInput
                id={fid}
                autoFocus
                value={label}
                placeholder="Seed database"
                className="font-sans"
                onChange={(e) => setLabel(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Command"
            hint={
              <>
                Runs in a new tab{forApps && where === "ssh" ? " on the server" : ""}. Use{" "}
                <span className="font-mono text-soft-foreground">{forApps ? "{{ app.path }}" : "{{ server.host }}"}</span>,{" "}
                <span className="font-mono text-soft-foreground">{"{{ server.env }}"}</span> and the like; any other name, like{" "}
                <span className="font-mono text-soft-foreground">{"{{ port }}"}</span>, is asked for when it runs. ⌘↵ saves.
              </>
            }
          >
            {(fid) => (
              <textarea
                id={fid}
                value={run}
                spellCheck={false}
                placeholder={forApps ? "cd {{ app.path }} && php artisan db:seed" : "sudo systemctl status nginx"}
                onChange={(e) => setRun(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.metaKey) {
                    e.preventDefault();
                    void save();
                  }
                }}
                className="block h-[84px] w-full resize-none rounded-lg border border-control-border bg-background px-2.5 py-2 font-mono text-[12.5px] leading-[19px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary/60"
              />
            )}
          </Field>
          {forApps && (
            <Field label="Runs">
              {() => (
                <Segmented
                  label="Runs"
                  value={where}
                  onChange={setWhere}
                  options={[
                    { value: "ssh", label: "On the server (ssh)" },
                    { value: "local", label: "On this Mac" },
                  ]}
                />
              )}
            </Field>
          )}
          <label className="flex w-fit cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" checked={danger} onChange={(e) => setDanger(e.target.checked)} className="accent-env-prod" />
            Danger ◆ <span className="text-subtle-foreground">(asks before running by default)</span>
          </label>
          {target.fromSnippet && (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
              <input type="checkbox" checked={dropSnippet} onChange={(e) => setDropSnippet(e.target.checked)} />
              Delete the snippet once the action is added
            </label>
          )}
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={close}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="primary" className="pr-2.5" disabled={!canSave}>
            Add action <Hint className="text-primary-foreground/60">↵</Hint>
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
