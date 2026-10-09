import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { actionDefinition, actionSetRun, errorMessage, type ActionDefinition } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { toastError, useToasts } from "@/stores/toasts";
import { useUi } from "@/stores/ui";

import { Field, TextInput } from "@/components/manage/fields";

import { caretToEnd } from "./ProdDialogs";

/** Right-click → "Edit…": change an action's name and command, saved to
 *  servers.yaml. Nothing runs from here, so there's nothing to confirm. */
export function EditActionDialog() {
  const target = useUi((s) => s.editAction);
  const setTarget = useUi((s) => s.setEditAction);
  const [def, setDef] = useState<ActionDefinition | null>(null);
  const [run, setRun] = useState("");
  const [label, setLabel] = useState("");
  const [everywhere, setEverywhere] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDef(null);
    setEverywhere(false);
    if (!target) return;
    setLabel(target.label);
    let live = true;
    actionDefinition(target.ref)
      .then((d) => {
        if (!live) return;
        setDef(d);
        setRun(d.run);
      })
      .catch((e) => {
        toastError(errorMessage(e));
        setTarget(null);
      });
    return () => {
      live = false;
    };
  }, [target, setTarget]);

  if (!target) return null;
  const close = () => setTarget(null);
  const { ref } = target;
  const scope = ref.appId ?? ref.serverId;
  const changed = def !== null && (run.trimEnd() !== def.run || label.trim() !== target.label);
  const canSave = changed && run.trim() !== "" && label.trim() !== "" && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await actionSetRun(ref, run, label.trim() || null, everywhere && def?.shared != null);
      useToasts.getState().push(`Saved ${target.label} for ${everywhere && def?.shared ? "every app using it" : scope}`, "info");
      close();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onOpenChange={(o) => !o && close()} title={`Edit ${target.label}`} width={560}>
      <ModalHeader>
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">Edit {target.label}</span>
          <EnvTag env={target.env} />
        </div>
        <span className="text-[12.5px] text-muted-foreground">
          {ref.appId ? `${ref.appId} on ${ref.serverId}` : ref.serverId} · nothing runs
        </span>
      </ModalHeader>
      <div className="flex flex-col gap-3 px-5 pb-4">
        <Field label="Name">
          {(fid) => <TextInput id={fid} value={label} className="font-sans" onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        <div className="-mb-1.5 text-[11.5px] text-muted-foreground">Command</div>
        <div className="overflow-hidden rounded-xl border border-control-border bg-background focus-within:border-primary/60">
          {def ? (
            <textarea
              autoFocus
              value={run}
              spellCheck={false}
              onFocus={caretToEnd}
              onChange={(e) => setRun(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.metaKey) {
                  e.preventDefault();
                  void save();
                }
              }}
              className="block h-[104px] w-full resize-none bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-[19px] text-foreground outline-none"
            />
          ) : (
            <div className="h-[104px]" />
          )}
        </div>
        <div className="text-[11.5px] leading-[17px] text-subtle-foreground">
          Use <span className="font-mono text-soft-foreground">{"{{ app.path }}"}</span>,{" "}
          <span className="font-mono text-soft-foreground">{"{{ server.env }}"}</span> and the like; they're filled in
          when it runs. Any other name, like <span className="font-mono text-soft-foreground">{"{{ port }}"}</span>, is asked
          for when it runs.
        </div>
        {def?.shared && (
          <div className="flex items-center gap-2 text-[11.5px] text-subtle-foreground">
            <span>Save for:</span>
            <div role="radiogroup" aria-label="Save for" className="flex rounded-md border border-control-border p-0.5">
              {[
                { on: !everywhere, label: `Only ${scope}`, set: false },
                { on: everywhere, label: `Everywhere (${def.shared})`, set: true },
              ].map((o) => (
                <button
                  key={o.label}
                  role="radio"
                  aria-checked={o.on}
                  onClick={() => setEverywhere(o.set)}
                  className={cn(
                    "h-6 rounded-[4px] px-2 text-[11.5px] transition-colors",
                    o.on
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-hover-strong hover:text-foreground",
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <ModalFooter>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={close}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn variant="primary" className="pr-2.5" disabled={!canSave} onClick={() => void save()}>
          Save <Hint className="text-primary-foreground/60">⌘↵</Hint>
        </Btn>
      </ModalFooter>
    </Modal>
  );
}
