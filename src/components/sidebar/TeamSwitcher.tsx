import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { PopupMenu, type MenuItem } from "@/components/kit/PopupMenu";
import { ColorPicker } from "@/components/manage/ColorPicker";
import { Field, TextInput, VALID_ID } from "@/components/manage/fields";
import { errorMessage, teamDelete, teamSave, type Team } from "@/lib/ipc";
import { TAB_COLORS, type TabColor } from "@/lib/tabColors";
import { cn } from "@/lib/utils";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { slug } from "@/stores/manage";
import { initials, useTeam } from "@/stores/team";
import { toastError, useToasts } from "@/stores/toasts";

const NO_TEAMS: Team[] = [];

/** A team's badge: its initials on its colour. */
export function TeamBadge({ team, size = 20 }: { team: Pick<Team, "name" | "color"> | null; size?: number }) {
  const bg = team?.color ? TAB_COLORS[team.color].light : "var(--muted-foreground)";
  return (
    <span
      className="flex flex-none items-center justify-center rounded-[6px] font-semibold text-white"
      style={{ width: size, height: size, background: team ? bg : "transparent", fontSize: size * 0.45, border: team ? undefined : "1px dashed var(--control-border)" }}
    >
      {team ? initials(team.name) : ""}
    </span>
  );
}

/** The team switcher at the top of the sidebar (DigitalOcean-style). */
export function TeamSwitcher() {
  const teams = useConfig((s) => s.snapshot?.config?.teams ?? NO_TEAMS);
  const unassigned = useConfig((s) => s.snapshot?.config?.servers.some((x) => !x.team) ?? false);
  const current = useTeam((s) => s.current);
  const [menu, setMenu] = useState<{ x: number; y: number; w: number } | null>(null);
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  const team = teams.find((t) => t.id === current) ?? null;
  const label = team ? team.name : current === "none" && teams.length ? "No team" : teams.length ? "All teams" : "All servers";

  const remove = async (t: Team) => {
    if (!(await askConfirm(`Delete team ${t.name}?`, "Its servers stay, with no team. Its shared actions are deleted.", "Delete"))) return;
    try {
      await teamDelete(t.id);
      useTeam.getState().set("all");
      useToasts.getState().push(`Deleted team ${t.name}`, "info");
    } catch (e) {
      toastError(errorMessage(e));
    }
  };

  const groups: MenuItem[][] = [
    teams.map((t) => ({ label: t.name, checked: t.id === current, icon: <TeamBadge team={t} size={24} />, run: () => useTeam.getState().set(t.id) })),
    [
      ...(teams.length && unassigned ? [{ label: "No team", checked: current === "none", run: () => useTeam.getState().set("none") }] : []),
      { label: teams.length ? "All teams" : "All servers", checked: current === "all" || (!team && current !== "none"), run: () => useTeam.getState().set("all") },
    ],
    [
      { label: "New team…", run: () => setEditing("new") },
      ...(team
        ? [
            { label: `Edit ${team.name}…`, run: () => setEditing(team) },
            { label: `Delete ${team.name}…`, run: () => void remove(team) },
          ]
        : []),
    ],
  ].filter((g) => g.length > 0);

  return (
    <>
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4, w: r.width });
        }}
        className="mx-2.5 mt-1.5 flex h-11 cursor-pointer items-center gap-2.5 rounded-xl border border-sidebar-border bg-background/60 px-2.5 text-left hover:bg-hover"
        title="Switch team"
      >
        <TeamBadge team={team} size={28} />
        <span className={cn("min-w-0 flex-1 truncate text-[15px]", team ? "font-semibold text-foreground" : "text-muted-foreground")}>{label}</span>
        <ChevronsUpDown className="size-4 flex-none text-subtle-foreground" />
      </button>
      {menu && <PopupMenu x={menu.x} y={menu.y} title="Teams" groups={groups} onClose={() => setMenu(null)} large minWidth={Math.max(260, menu.w)} />}
      {editing && <TeamDialog team={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** New / edit a team: name, id, colour. */
function TeamDialog({ team, onClose }: { team: Team | null; onClose: () => void }) {
  const [name, setName] = useState(team?.name ?? "");
  const [id, setId] = useState(team?.id ?? "");
  const [idTouched, setIdTouched] = useState(!!team);
  const [color, setColor] = useState<TabColor | null>(team?.color ?? null);
  const [busy, setBusy] = useState(false);
  const idOk = VALID_ID.test(id);
  const ok = idOk && name.trim() !== "" && !busy;
  const save = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await teamSave(team?.id ?? null, { id: id.trim(), name: name.trim(), color });
      useToasts.getState().push(team ? `Saved ${name.trim()}` : `Added team ${name.trim()}`, "info");
      if (!team) useTeam.getState().set(id.trim());
      else if (useTeam.getState().current === team.id) useTeam.getState().set(id.trim());
      onClose();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={team ? "Edit team" : "New team"} width={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ModalHeader>
          <div className="flex items-center gap-2">
            <TeamBadge team={{ name: name || "?", color }} size={22} />
            <span className="text-[15px] font-semibold">{team ? `Edit ${team.name}` : "New team"}</span>
          </div>
          <span className="text-[12.5px] text-muted-foreground">Servers belong to a team (pick it on a server's page). A team can have its own shared actions and snippets.</span>
        </ModalHeader>
        <div className="flex flex-col gap-3.5 px-5 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              {(fid) => (
                <TextInput
                  id={fid}
                  autoFocus
                  value={name}
                  placeholder="Northwind"
                  className="font-sans"
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!idTouched) setId(slug(e.target.value));
                  }}
                />
              )}
            </Field>
            <Field label="ID" hint={id && !idOk ? "Letters, digits, . _ -" : undefined}>
              {(fid) => (
                <TextInput
                  id={fid}
                  value={id}
                  invalid={!!id && !idOk}
                  onChange={(e) => {
                    setId(e.target.value);
                    setIdTouched(true);
                  }}
                />
              )}
            </Field>
          </div>
          <Field label="Colour">{() => <ColorPicker value={color} onChange={setColor} />}</Field>
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={onClose}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="primary" disabled={!ok}>
            {busy ? "Saving…" : team ? "Save" : "Add team"}
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
