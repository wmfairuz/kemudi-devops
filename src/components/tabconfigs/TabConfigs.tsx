import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { ColorPicker } from "@/components/manage/ColorPicker";
import { Field, Segmented, TextInput } from "@/components/manage/fields";
import {
  errorMessage,
  tabConfigDelete,
  tabConfigSave,
  tabConfigsList,
  tabConfigsReveal,
  type ConfigLayout,
  type PaneDef,
  type TabConfig,
  type TabConfigEntry,
} from "@/lib/ipc";
import { isTabColor, TAB_COLORS, type TabColor } from "@/lib/tabColors";
import { cn } from "@/lib/utils";
import { askConfirm } from "@/stores/confirm";
import { useTabs } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";
import { create } from "zustand";

/** Which tab-config dialog is open. */
export const useTabConfigs = create<{
  view: "list" | { edit: TabConfigEntry | null } | null;
  show(v: "list" | { edit: TabConfigEntry | null } | null): void;
}>((set) => ({ view: null, show: (view) => set({ view }) }));

export function openTabConfig(e: TabConfigEntry): void {
  if (!e.layout) {
    toastError(`${e.config.name}: ${e.error ?? "can't open it"}`);
    return;
  }
  useTabs.getState().openConfig({
    title: e.config.title?.trim() || e.config.name,
    color: isTabColor(e.config.color) ? e.config.color : undefined,
    layout: e.layout,
  });
}

function paneCount(l: ConfigLayout | null): number {
  if (!l) return 0;
  return l.type === "pane" ? 1 : l.children.reduce((n, c) => n + paneCount(c), 0);
}

export function ColorDot({ color, className }: { color?: string; className?: string }) {
  return (
    <span
      className={cn("size-2.5 flex-none rounded-full", !isTabColor(color) && "border border-control-border", className)}
      style={isTabColor(color) ? { background: TAB_COLORS[color].light } : undefined}
    />
  );
}

/** Both dialogs; mount once. */
export function TabConfigDialogs() {
  const view = useTabConfigs((s) => s.view);
  if (view === "list") return <ListDialog />;
  if (view && typeof view === "object") return <EditDialog key={view.edit?.file ?? "new"} entry={view.edit} />;
  return null;
}

function ListDialog() {
  const [list, setList] = useState<TabConfigEntry[] | null>(null);
  const close = () => useTabConfigs.getState().show(null);
  const load = () => tabConfigsList().then(setList, (e) => toastError(errorMessage(e)));
  useEffect(() => void load(), []);

  return (
    <Modal open onOpenChange={(o) => !o && close()} title="Tab configs" width={600}>
      <ModalHeader>
        <span className="text-[15px] font-semibold">Tab configs</span>
        <span className="text-[12.5px] text-muted-foreground">
          A tab with panes that each start in a folder and run commands. Yours live in ~/.config/kemudi/tab_configs;
          Warp's (~/.warp/tab_configs) show up too.
        </span>
      </ModalHeader>
      <div className="mx-5 mb-4 flex max-h-[360px] flex-col overflow-y-auto rounded-xl border border-divider">
        {list === null && <div className="p-4 text-[12.5px] text-subtle-foreground">Loading…</div>}
        {list?.length === 0 && <div className="p-4 text-[12.5px] text-subtle-foreground">None yet.</div>}
        {list?.map((e) => (
          <div key={`${e.source}/${e.file}`} className="flex items-center gap-2.5 border-b border-divider px-3 py-2 last:border-b-0">
            <ColorDot color={e.config.color} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium">{e.config.name}</span>
              <span className={cn("truncate text-[11px]", e.error ? "text-env-prod-fg" : "text-subtle-foreground")}>
                {e.error ?? `${paneCount(e.layout)} pane${paneCount(e.layout) === 1 ? "" : "s"} · ${e.source === "warp" ? "from Warp" : e.file}`}
              </span>
            </span>
            <Btn size="sm" variant="outline" disabled={!e.layout} onClick={() => (openTabConfig(e), close())}>
              Open
            </Btn>
            <Btn size="sm" variant="outline" onClick={() => useTabConfigs.getState().show({ edit: e })}>
              {e.source === "warp" ? "Edit a copy" : "Edit"}
            </Btn>
            {e.source === "kemudi" && (
              <Btn
                size="sm"
                variant="ghost"
                className="text-env-prod-fg"
                onClick={async () => {
                  if (!(await askConfirm(`Delete ${e.config.name}?`, `Removes ${e.file} from ~/.config/kemudi/tab_configs.`))) return;
                  try {
                    await tabConfigDelete(e.file);
                    void load();
                  } catch (err) {
                    toastError(errorMessage(err));
                  }
                }}
              >
                Delete
              </Btn>
            )}
          </div>
        ))}
      </div>
      <ModalFooter>
        <Btn variant="ghost" className="px-2.5" onClick={() => void tabConfigsReveal().catch((e) => toastError(errorMessage(e)))}>
          Show folder
        </Btn>
        <span className="flex-1" />
        <Btn variant="outline" className="pr-2.5" onClick={close}>
          Close <Hint>esc</Hint>
        </Btn>
        <Btn variant="primary" onClick={() => useTabConfigs.getState().show({ edit: null })}>
          New tab config
        </Btn>
      </ModalFooter>
    </Modal>
  );
}

// ------------------------------------------------------------------ editor

type Preset = "one" | "row2" | "col2" | "row3" | "grid6" | "custom";

const PRESETS: { value: Exclude<Preset, "custom">; label: string; panes: number }[] = [
  { value: "one", label: "1 pane", panes: 1 },
  { value: "row2", label: "Side by side", panes: 2 },
  { value: "col2", label: "Stacked", panes: 2 },
  { value: "row3", label: "3 columns", panes: 3 },
  { value: "grid6", label: "2 × 3 grid", panes: 6 },
];

interface PaneForm {
  id: string;
  directory: string;
  commands: string;
}

function shape(l: ConfigLayout): string {
  return l.type === "pane" ? "p" : `${l.dir}(${l.children.map(shape).join(",")})`;
}

function leavesOf(l: ConfigLayout | null): Extract<ConfigLayout, { type: "pane" }>[] {
  if (!l) return [];
  return l.type === "pane" ? [l] : l.children.flatMap(leavesOf);
}

function detect(l: ConfigLayout | null): Preset {
  if (!l) return "one";
  const s = shape(l);
  const known: Record<string, Preset> = {
    p: "one",
    "row(p,p)": "row2",
    "col(p,p)": "col2",
    "row(p,p,p)": "row3",
    "col(row(p,p,p),row(p,p,p))": "grid6",
  };
  return known[s] ?? "custom";
}

function toPanes(preset: Preset, panes: PaneForm[], original: TabConfig | null): PaneDef[] {
  const leaf = (p: PaneForm): PaneDef => ({
    id: p.id,
    type: "terminal",
    ...(p.directory.trim() ? { directory: p.directory.trim() } : {}),
    commands: p.commands.split("\n").map((c) => c.trim()).filter(Boolean),
  });
  const ids = panes.map((p) => p.id);
  switch (preset) {
    case "one":
      return [leaf(panes[0]!)];
    case "row2":
    case "row3":
      return [{ id: "root", split: "horizontal", children: ids }, ...panes.map(leaf)];
    case "col2":
      return [{ id: "root", split: "vertical", children: ids }, ...panes.map(leaf)];
    case "grid6":
      return [
        { id: "root", split: "vertical", children: ["top", "bottom"] },
        { id: "top", split: "horizontal", children: ids.slice(0, 3) },
        { id: "bottom", split: "horizontal", children: ids.slice(3, 6) },
        ...panes.map(leaf),
      ];
    case "custom": {
      // Keep the file's own layout; only the panes' folders/commands change.
      const byId = new Map(panes.map((p) => [p.id, leaf(p)]));
      return (original?.panes ?? []).map((p) => byId.get(p.id) ?? p);
    }
  }
}

function EditDialog({ entry }: { entry: TabConfigEntry | null }) {
  const back = () => useTabConfigs.getState().show("list");
  const orig = entry?.config ?? null;
  const [name, setName] = useState(orig?.name ?? "");
  const [title, setTitle] = useState(orig?.title ?? "");
  const [color, setColor] = useState<TabColor | null>(isTabColor(orig?.color) ? orig.color : null);
  const [preset, setPreset] = useState<Preset>(detect(entry?.layout ?? null));
  const [panes, setPanes] = useState<PaneForm[]>(() => {
    const ls = leavesOf(entry?.layout ?? null);
    return ls.length
      ? ls.map((l) => ({ id: l.id, directory: l.directory ?? "", commands: l.commands.join("\n") }))
      : [{ id: "p1", directory: "", commands: "" }];
  });
  const [busy, setBusy] = useState(false);

  const choose = (p: Preset) => {
    setPreset(p);
    const n = PRESETS.find((x) => x.value === p)?.panes ?? panes.length;
    setPanes((cur) => {
      const next = cur.slice(0, n);
      for (let i = next.length; i < n; i++) next.push({ id: `p${i + 1}`, directory: cur[0]?.directory ?? "", commands: "" });
      // Pane ids must be unique.
      const seen = new Set<string>();
      return next.map((p, i) => {
        const id = seen.has(p.id) ? `p${i + 1}` : p.id;
        seen.add(id);
        return { ...p, id };
      });
    });
  };

  const save = async (andOpen: boolean) => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const config: TabConfig = {
      name: name.trim(),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(color ? { color } : {}),
      panes: toPanes(preset, panes, orig),
      params: orig?.params ?? {},
    };
    try {
      // Warp's own files are never written: editing one makes a Kemudi copy.
      await tabConfigSave(entry?.source === "kemudi" ? entry.file : null, config);
      useToasts.getState().push(`Saved ${config.name}`, "info");
      if (andOpen) {
        const fresh = (await tabConfigsList()).find((e) => e.source === "kemudi" && e.config.name === config.name);
        if (fresh) openTabConfig(fresh);
        useTabConfigs.getState().show(null);
      } else back();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const heading = entry ? (entry.source === "warp" ? `Copy of ${orig?.name}` : `Edit ${orig?.name}`) : "New tab config";
  const label = (i: number) =>
    preset === "row2" ? ["Left", "Right"][i] : preset === "col2" ? ["Top", "Bottom"][i] : preset === "one" ? "Pane" : `Pane ${i + 1}`;

  return (
    <Modal open onOpenChange={(o) => !o && back()} title={heading} width={640}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <ModalHeader>
          <span className="text-[15px] font-semibold">{heading}</span>
          <span className="text-[12.5px] text-muted-foreground">
            Each pane opens a shell on this Mac in its folder, then types its commands (like Warp).
            {entry?.source === "warp" && " Warp's file stays as it is; this saves a Kemudi copy."}
          </span>
        </ModalHeader>
        <div className="flex max-h-[62vh] flex-col gap-3.5 overflow-y-auto px-5 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name (in the menu)">
              {(fid) => (
                <TextInput id={fid} autoFocus className="font-sans" value={name} placeholder="PetClinic Deploy" onChange={(e) => setName(e.target.value)} />
              )}
            </Field>
            <Field label="Tab title">
              {(fid) => (
                <TextInput id={fid} className="font-sans" value={title} placeholder={name || "PetClinic"} onChange={(e) => setTitle(e.target.value)} />
              )}
            </Field>
          </div>
          <Field label="Colour">{() => <ColorPicker value={color} onChange={setColor} />}</Field>
          <Field label="Layout" hint={preset === "custom" ? "This file has its own layout; it's kept as it is." : undefined}>
            {() => (
              <Segmented
                label="Layout"
                value={preset}
                onChange={choose}
                options={[...PRESETS.map(({ value, label }) => ({ value, label })), ...(preset === "custom" ? [{ value: "custom" as Preset, label: "Custom" }] : [])]}
              />
            )}
          </Field>
          {panes.map((p, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-lg border border-divider bg-panel p-3">
              <div className="text-[11.5px] font-semibold tracking-wide text-subtle-foreground uppercase">
                {label(i)} <span className="font-normal normal-case text-faint-foreground">· {p.id}</span>
              </div>
              <TextInput
                value={p.directory}
                placeholder="Folder, e.g. ~/code/laravel/petclinic-production (empty: home)"
                onChange={(e) => setPanes((cur) => cur.map((x, j) => (j === i ? { ...x, directory: e.target.value } : x)))}
              />
              <textarea
                value={p.commands}
                spellCheck={false}
                placeholder={"Commands, one per line, e.g.\ngit pull\nssh petclinic-app -t 'sudo su'"}
                onChange={(e) => setPanes((cur) => cur.map((x, j) => (j === i ? { ...x, commands: e.target.value } : x)))}
                className="h-[72px] w-full resize-y rounded-lg border border-control-border bg-background px-2.5 py-2 font-mono text-[12.5px] leading-[19px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary/60"
              />
            </div>
          ))}
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={back}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="outline" disabled={!name.trim() || busy}>
            Save
          </Btn>
          <Btn variant="primary" disabled={!name.trim() || busy} onClick={() => void save(true)}>
            Save and open
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
