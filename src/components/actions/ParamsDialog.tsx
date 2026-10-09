import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, TextInput } from "@/components/manage/fields";
import { refOf } from "@/lib/actions";
import { actionRender } from "@/lib/ipc";
import { isSecret, useParams } from "@/stores/params";

/** Asks for an action's own variables (`{{ ip }}`, `{{ port }}`), with the
 *  command it will run shown live underneath. */
export function ParamsDialog() {
  const ask = useParams((s) => s.ask);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState("");

  useEffect(() => {
    if (ask) {
      setValues(ask.initial);
      setPreview(ask.action.command);
    }
  }, [ask]);

  // Re-render the command as values change (local, cheap).
  useEffect(() => {
    if (!ask) return;
    let live = true;
    const t = setTimeout(() => {
      actionRender({ ...refOf(ask.action), values })
        .then((r) => live && setPreview(r.command))
        .catch(() => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ask, values]);

  if (!ask) return null;
  const { action } = ask;
  const missing = action.params.filter((p) => !p.optional && !values[p.name]?.trim());
  const done = (ok: boolean) => {
    useParams.setState({ ask: null });
    ask.resolve(ok ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])) : null);
  };
  const where = action.appId ? `${action.appId} on ${action.serverId}` : action.serverId;

  return (
    <Modal open onOpenChange={(o) => !o && done(false)} title={`${action.label} values`} width={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.length === 0) done(true);
        }}
      >
        <ModalHeader>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold">{action.label}</span>
            <EnvTag env={action.env} />
          </div>
          <span className="text-[12.5px] text-muted-foreground">{where}</span>
        </ModalHeader>
        <div className="flex flex-col gap-3.5 px-5 pb-4">
          <div className="grid grid-cols-2 gap-3">
            {action.params.map((p, i) => (
              <Field key={p.name} label={p.name} hint={p.optional ? (p.default ? `default ${p.default}` : "optional") : undefined}>
                {(fid) => (
                  <TextInput
                    id={fid}
                    autoFocus={i === 0}
                    type={isSecret(p.name) ? "password" : "text"}
                    value={values[p.name] ?? ""}
                    placeholder={p.default ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-subtle-foreground">Command</span>
            <div className="rounded-lg border border-control-border bg-muted px-3 py-2 font-mono text-[12px] break-all whitespace-pre-wrap text-soft-foreground">
              {preview}
            </div>
          </div>
        </div>
        <ModalFooter>
          <span className="flex-1 text-[12px] text-subtle-foreground">
            {missing.length ? `Needs ${missing.map((p) => p.name).join(", ")}` : ""}
          </span>
          <Btn variant="outline" className="pr-2.5" onClick={() => done(false)}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="primary" disabled={missing.length > 0} className="pr-2.5">
            Continue <Hint>↵</Hint>
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
