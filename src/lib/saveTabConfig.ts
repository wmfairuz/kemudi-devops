// Tab ▸ Save as tab config…: the tab's panes, where each one is now, as a
// tab config (opened from + like any other).

import { useTabConfigs } from "@/components/tabconfigs/TabConfigs";
import { errorMessage, ptyCwd, tabConfigSave, tabConfigsList, type PaneDef } from "@/lib/ipc";
import { leaves, type Layout } from "@/lib/layout";
import { askText } from "@/stores/confirm";
import { isViewTab, useTabs, type Tab } from "@/stores/tabs";
import { toastError, useToasts } from "@/stores/toasts";

const quote = (s: string) => (/^[\w./~@%+=:,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

/** What a pane comes back as: a folder on this Mac, or commands typed at
 *  a local shell (ssh into the server, into the folder it was in). Null:
 *  can't be saved (a Session Manager pane, a monitor…). */
async function paneOf(t: Tab): Promise<Pick<PaneDef, "directory" | "commands"> | null> {
  if (isViewTab(t.kind) || t.instance) return null;
  const local = t.kind === "local" || t.local || !t.host;
  if (local) {
    // The shell's own folder first: OSC 7 can come from an ssh typed in it.
    const id = t.session.ptyId;
    const dir = (id !== null ? await ptyCwd(id).catch(() => null) : null) ?? t.session.cwd ?? t.cwd;
    return { directory: dir ?? undefined, commands: [] };
  }
  const dir = t.session.cwd ?? t.cwd;
  const host = quote(t.host ?? "");
  return { commands: [dir ? `ssh -t ${host} ${quote(`cd ${quote(dir)} && exec "$SHELL" -l`)}` : `ssh ${host}`] };
}

export async function saveTabAsConfig(groupId: string): Promise<void> {
  const s = useTabs.getState();
  const group = s.groups.find((g) => g.id === groupId);
  if (!group) return;
  // Named after its first pane (a server's shell, say), not a split-in shell.
  const first = s.tabs.find((t) => t.id === leaves(group.layout)[0]);
  const name = await askText(
    "Save as tab config",
    "Its panes, each in the folder it's in now (ssh panes ssh in again). Open it later from +.",
    "Save",
    first?.title ?? "",
  );
  if (!name) return;

  const panes: PaneDef[] = [];
  let skipped = 0;
  let n = 0;
  // Returns the pane id for this part of the layout, or null if nothing in
  // it can be saved. A run of same-direction splits becomes one split.
  const walk = async (l: Layout): Promise<string | null> => {
    if ("pane" in l) {
      const t = useTabs.getState().tabs.find((x) => x.id === l.pane);
      const p = t ? await paneOf(t) : null;
      if (!p) {
        skipped++;
        return null;
      }
      const id = `pane${++n}`;
      panes.push({ id, type: "terminal", ...p });
      return id;
    }
    const flat = (x: Layout): Layout[] => ("pane" in x || x.dir !== l.dir ? [x] : [...flat(x.a), ...flat(x.b)]);
    const children: string[] = [];
    for (const c of [...flat(l.a), ...flat(l.b)]) {
      const id = await walk(c);
      if (id) children.push(id);
    }
    if (children.length <= 1) return children[0] ?? null;
    const id = `split${++n}`;
    panes.push({ id, split: l.dir === "col" ? "vertical" : "horizontal", children });
    return id;
  };

  try {
    if (!(await walk(group.layout))) {
      toastError("Nothing in this tab can be saved as a tab config (Session Manager panes and monitors can't).");
      return;
    }
    const file = await tabConfigSave(null, { name, color: group.color, panes });
    const entry = (await tabConfigsList()).find((e) => e.source === "kemudi" && e.file === file);
    useToasts.getState().push(
      skipped ? `Saved “${name}” (left out ${skipped} pane${skipped > 1 ? "s" : ""}: Session Manager or monitors)` : `Saved “${name}”: open it from +`,
      "info",
      entry ? { label: "Edit…", run: () => useTabConfigs.getState().show({ edit: entry }) } : undefined,
    );
  } catch (e) {
    toastError(errorMessage(e));
  }
}
