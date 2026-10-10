import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, Segmented, TextInput } from "@/components/manage/fields";
import { errorMessage, workflowDelete, workflowSave, type Server, type Workflow, type WorkflowStep } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { stepTitle } from "@/lib/workflows";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { freeId } from "@/stores/manage";
import { toastError, useToasts } from "@/stores/toasts";
import { useWorkflows } from "@/stores/workflows";

export function WorkflowEditor() {
  const editing = useWorkflows((s) => s.editing);
  if (!editing) return null;
  return <Editor key={editing.workflow?.id ?? "new"} workflow={editing.workflow} pin={editing.pin} />;
}

type Kind = WorkflowStep["kind"];
type Row = WorkflowStep & { key: number };

let nextKey = 1;
const blank = (kind: Kind, server: string): WorkflowStep => {
  switch (kind) {
    case "local":
      return { kind, label: null, run: "", dir: null };
    case "server":
      return { kind, label: null, server, run: "", root: false, dir: null };
    case "action":
      return { kind, label: null, server, app: null, action: "" };
    case "pause":
      return { kind, label: null, text: "Continue?" };
  }
};

const NO_SERVERS: Server[] = [];
const select =
  "h-8 w-full rounded-lg border border-control-border bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-primary/60";
const area =
  "min-h-[34px] w-full resize-y rounded-lg border border-control-border bg-background px-2.5 py-1.5 font-mono text-[12.5px] leading-[18px] text-foreground outline-none focus:border-primary/60";

/** New / edit a workflow: a name, where it's pinned, and its steps. */
function Editor({ workflow, pin }: { workflow: Workflow | null; pin?: { server: string; app: string | null } }) {
  const config = useConfig((s) => s.snapshot?.config);
  const servers = config?.servers ?? NO_SERVERS;
  const [name, setName] = useState(workflow?.name ?? "");
  const [pinServer, setPinServer] = useState<string>(workflow?.pinServer ?? pin?.server ?? "");
  const [pinApp, setPinApp] = useState<string>(workflow?.pinApp ?? pin?.app ?? "");
  const [steps, setSteps] = useState<Row[]>(() => (workflow?.steps ?? []).map((s) => ({ ...s, key: nextKey++ })));
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const id = workflow ? workflow.id : freeId(name, (config?.workflows ?? []).map((w) => w.id), "workflow");
  const firstServer = pinServer || servers[0]?.id || "";

  const update = (i: number, patch: Partial<WorkflowStep>) =>
    setSteps((list) => list.map((s, j) => (j === i ? ({ ...s, ...patch } as Row) : s)));
  const setKind = (i: number, kind: Kind) =>
    setSteps((list) => list.map((s, j) => (j === i ? { ...blank(kind, firstServer), label: s.label, key: s.key } : s)));
  const move = (from: number, to: number) =>
    setSteps((list) => {
      if (from === to || to < 0 || to >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });
  const add = () => setSteps((list) => [...list, { ...blank("local", firstServer), key: nextKey++ }]);

  // Drag a step by its handle; it lands where the line shows.
  const startDrag = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let to = i;
    setDrag({ from: i, to });
    const moveTo = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-step]");
      if (!el) return;
      const j = Number(el.dataset.step);
      const r = el.getBoundingClientRect();
      to = ev.clientY < r.top + r.height / 2 ? j : j + 1;
      setDrag({ from: i, to });
    };
    const up = () => {
      window.removeEventListener("pointermove", moveTo);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      move(i, to > i ? to - 1 : to);
    };
    window.addEventListener("pointermove", moveTo);
    window.addEventListener("pointerup", up);
  };

  const problems: string[] = [];
  if (!name.trim()) problems.push("Give it a name.");
  if (steps.length === 0) problems.push("Add a step.");
  steps.forEach((s, i) => {
    const n = i + 1;
    if ((s.kind === "local" || s.kind === "server") && !s.run.trim()) problems.push(`Step ${n} needs a command.`);
    if ((s.kind === "server" || s.kind === "action") && !s.server) problems.push(`Step ${n} needs a server.`);
    if (s.kind === "action" && !s.action) problems.push(`Step ${n}: pick the action.`);
  });

  const save = async () => {
    if (problems.length || busy) return;
    setBusy(true);
    try {
      await workflowSave(workflow?.id ?? null, {
        id,
        name: name.trim(),
        pinServer: pinServer || null,
        pinApp: pinServer && pinApp ? pinApp : null,
        steps: steps.map(({ key: _key, ...s }) => ({ ...s, label: s.label?.trim() || null })),
      });
      useToasts.getState().push(workflow ? `Saved ${name.trim()}` : `Added ${name.trim()}`, "info");
      useWorkflows.getState().close();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!workflow || !(await askConfirm(`Delete ${workflow.name}?`, "Removes the workflow from Kemudi. Nothing on any server changes."))) return;
    try {
      await workflowDelete(workflow.id);
      useToasts.getState().push(`Deleted ${workflow.name}`, "info");
      useWorkflows.getState().close();
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  const close = async () => {
    const changed = workflow ? name !== workflow.name || JSON.stringify(steps.map(({ key: _k, ...s }) => s)) !== JSON.stringify(workflow.steps) : name || steps.length;
    if (changed && !(await askConfirm("Discard your changes?", "The workflow stays as it was.", "Discard"))) return;
    useWorkflows.getState().close();
  };

  const pinnedServer = servers.find((s) => s.id === pinServer);

  return (
    <Modal open onOpenChange={(o) => !o && void close()} title={workflow ? `Edit ${workflow.name}` : "New workflow"} width={860}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">{workflow ? `Edit ${workflow.name}` : "New workflow"}</span>
        <span className="text-[12.5px] text-muted-foreground">
          Steps run one after another in one terminal tab, so you answer prompts there. Commands run in an interactive shell (yours on this
          Mac, bash on servers), so aliases work. The first failing step stops the run.
        </span>
      </ModalHeader>
      <div className="flex max-h-[min(66vh,640px)] flex-col gap-4 overflow-y-auto px-5 pb-4">
        <div className="grid grid-cols-[1fr_1fr_1fr] gap-3">
          <Field label="Name">
            {(fid) => (
              <TextInput id={fid} autoFocus className="font-sans" value={name} placeholder="Deploy eTabika" onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field label="Pin to server" hint="Shows as a button in its Actions panel">
            {(fid) => (
              <select id={fid} value={pinServer} onChange={(e) => (setPinServer(e.target.value), setPinApp(""))} className={select}>
                <option value="">Not pinned</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="…and app">
            {(fid) => (
              <select id={fid} value={pinApp} disabled={!pinnedServer} onChange={(e) => setPinApp(e.target.value)} className={select}>
                <option value="">{pinnedServer ? "The server itself" : "—"}</option>
                {pinnedServer?.apps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          {steps.map((s, i) => (
            <div key={s.key} data-step={i} className="relative">
              {drag && drag.to === i && drag.from !== i && drag.from !== i - 1 && (
                <span className="pointer-events-none absolute -top-[5px] right-0 left-0 h-[3px] rounded bg-primary" />
              )}
              {drag && drag.to === steps.length && i === steps.length - 1 && drag.from !== i && (
                <span className="pointer-events-none absolute right-0 -bottom-[5px] left-0 h-[3px] rounded bg-primary" />
              )}
              <StepEditor
                n={i + 1}
                step={s}
                servers={servers}
                lifted={drag?.from === i}
                onHandle={(e) => startDrag(e, i)}
                onKind={(k) => setKind(i, k)}
                onChange={(p) => update(i, p)}
                onUp={i > 0 ? () => move(i, i - 1) : undefined}
                onDown={i < steps.length - 1 ? () => move(i, i + 1) : undefined}
                onRemove={() => setSteps((list) => list.filter((_, j) => j !== i))}
                title={stepTitle(config, s)}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={add}
            className="flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-control-border text-[12.5px] text-subtle-foreground hover:border-primary/50 hover:bg-hover hover:text-foreground"
          >
            <Plus className="size-4" /> Add step
          </button>
        </div>
      </div>
      <ModalFooter>
        {workflow && (
          <Btn variant="ghost" className="text-env-prod-fg" onClick={() => void remove()}>
            Delete…
          </Btn>
        )}
        <span className="flex-1 truncate text-[12px] text-subtle-foreground">{name.trim() || steps.length ? problems[0] ?? "" : ""}</span>
        <Btn variant="outline" className="pr-2.5" onClick={() => void close()}>
          Cancel <Hint>esc</Hint>
        </Btn>
        <Btn variant="primary" disabled={problems.length > 0 || busy} onClick={() => void save()}>
          {busy ? "Saving…" : workflow ? "Save" : "Add workflow"}
        </Btn>
      </ModalFooter>
    </Modal>
  );
}

function StepEditor({
  n,
  step,
  servers,
  title,
  lifted,
  onHandle,
  onKind,
  onChange,
  onUp,
  onDown,
  onRemove,
}: {
  n: number;
  step: WorkflowStep;
  servers: Server[];
  title: string;
  lifted: boolean;
  onHandle: (e: React.PointerEvent) => void;
  onKind: (k: Kind) => void;
  onChange: (p: Partial<WorkflowStep>) => void;
  onUp?: () => void;
  onDown?: () => void;
  onRemove: () => void;
}) {
  const server = step.kind === "server" || step.kind === "action" ? servers.find((s) => s.id === step.server) : undefined;
  const app = step.kind === "action" && step.app ? server?.apps.find((a) => a.id === step.app) : undefined;
  const actions = step.kind === "action" ? (app ? app.actions : (server?.actions ?? [])) : [];
  const serverSelect = (value: string) => (
    <select value={value} onChange={(e) => onChange({ server: e.target.value, ...(step.kind === "action" ? { app: null, action: "" } : {}) } as Partial<WorkflowStep>)} className={select}>
      <option value="">Pick a server…</option>
      {servers.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
          {s.env === "prod" ? " (prod)" : ""}
        </option>
      ))}
    </select>
  );
  return (
    <div className={cn("flex gap-2 rounded-xl border border-divider bg-panel p-3", lifted && "opacity-40")}>
      <div className="flex w-6 flex-none flex-col items-center gap-1 pt-1">
        <span className="font-mono text-[12px] text-subtle-foreground">{n}</span>
        <button type="button" title="Drag to reorder" onPointerDown={onHandle} className="cursor-grab text-faint-foreground hover:text-foreground">
          <GripVertical className="size-4" />
        </button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Segmented
            label="Step"
            value={step.kind}
            onChange={onKind}
            options={[
              { value: "local", label: "This Mac" },
              { value: "server", label: "Server" },
              { value: "action", label: "Action" },
              { value: "pause", label: "Pause" },
            ]}
          />
          <input
            value={step.label ?? ""}
            placeholder={title}
            onChange={(e) => onChange({ label: e.target.value })}
            className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-[12.5px] text-foreground outline-none placeholder:text-faint-foreground hover:border-control-border focus:border-primary/60"
            aria-label="Label (optional)"
            title="Label (optional)"
          />
          <button type="button" title="Move up" disabled={!onUp} onClick={onUp} className="text-subtle-foreground hover:text-foreground disabled:opacity-30">
            <ArrowUp className="size-4" />
          </button>
          <button type="button" title="Move down" disabled={!onDown} onClick={onDown} className="text-subtle-foreground hover:text-foreground disabled:opacity-30">
            <ArrowDown className="size-4" />
          </button>
          <button type="button" title="Remove step" onClick={onRemove} className="text-subtle-foreground hover:text-env-prod-fg">
            <Trash2 className="size-4" />
          </button>
        </div>
        {step.kind === "local" && (
          <div className="grid grid-cols-[1fr_2fr] gap-2">
            <TextInput value={step.dir ?? ""} placeholder="Folder, e.g. ~/workspace/laravel/app" onChange={(e) => onChange({ dir: e.target.value || null })} />
            <textarea
              rows={1}
              spellCheck={false}
              value={step.run}
              placeholder="git pull && git merge origin/main --no-edit && git push"
              onChange={(e) => onChange({ run: e.target.value })}
              className={area}
            />
          </div>
        )}
        {step.kind === "server" && (
          <>
            <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              {serverSelect(step.server)}
              <TextInput value={step.dir ?? ""} placeholder="Folder (optional), e.g. /opt/www/app" onChange={(e) => onChange({ dir: e.target.value || null })} />
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground" title="sudo, or sudo su where that's the only passwordless way">
                <input type="checkbox" checked={step.root} onChange={(e) => onChange({ root: e.target.checked })} /> as root
              </label>
            </div>
            <textarea rows={1} spellCheck={false} value={step.run} placeholder="deploy /opt/www/app" onChange={(e) => onChange({ run: e.target.value })} className={area} />
          </>
        )}
        {step.kind === "action" && (
          <div className="grid grid-cols-3 gap-2">
            {serverSelect(step.server)}
            <select value={step.app ?? ""} disabled={!server} onChange={(e) => onChange({ app: e.target.value || null, action: "" })} className={select}>
              <option value="">{server ? "Server action" : "—"}</option>
              {server?.apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <select value={step.action} disabled={!server} onChange={(e) => onChange({ action: e.target.value })} className={select}>
              <option value="">Pick the action…</option>
              {actions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.danger ? " ◆" : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        {step.kind === "pause" && (
          <TextInput className="font-sans" value={step.text} placeholder="Check the site, then continue?" onChange={(e) => onChange({ text: e.target.value })} />
        )}
      </div>
    </div>
  );
}
