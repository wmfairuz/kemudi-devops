import { PopupMenu } from "@/components/kit/PopupMenu";
import { triggerAction } from "@/lib/actions";
import { actionDefinition, actionRemove, actionSetConfirm, actionSetDanger, defaultConfirm, errorMessage, type Confirm, type RemoveMode } from "@/lib/ipc";
import { useConfig } from "@/stores/config";
import { askConfirm } from "@/stores/confirm";
import { toastError } from "@/stores/toasts";
import { useUi } from "@/stores/ui";

import { actionChoices } from "./AddActionDialog";
import { confirmLabel } from "./ConfirmToggle";

/** Right-click on an action button: options for that one action. */
export function ActionMenu() {
  const menu = useUi((s) => s.actionMenu);
  const setMenu = useUi((s) => s.setActionMenu);
  if (!menu) return null;
  const close = () => setMenu(null);
  const effective = menu.confirm ?? defaultConfirm(menu.env, menu.danger);
  const fallback = defaultConfirm(menu.env, menu.danger);
  const setConfirm = (level: Confirm | null) => () =>
    actionSetConfirm(menu.ref, level).catch((e) => toastError(errorMessage(e)));

  const where = menu.ref.appId ?? menu.ref.serverId;
  const remove = (mode: RemoveMode) => actionRemove(menu.ref, mode).catch((e) => toastError(errorMessage(e)));
  const confirmed = async (title: string, message: string, mode: RemoveMode) => {
    if (await askConfirm(title, message)) await remove(mode);
  };
  // A new action starting as a copy (its command as written, {{ … }} kept).
  const duplicate = async () => {
    try {
      const def = await actionDefinition(menu.ref);
      const choices = actionChoices(menu.ref.serverId, menu.ref.appId);
      // Start where the original lives: this app/server, or the shared list.
      const pick = menu.shared
        ? choices.find((c) => c.scope.kind === (menu.team ? (menu.ref.appId ? "teamApp" : "teamServer") : menu.ref.appId ? "sharedApp" : "sharedServer"))
        : choices.find((c) => c.scope.kind === (menu.ref.appId ? "app" : "server"));
      const ordered = pick ? [pick, ...choices.filter((c) => c !== pick)] : choices;
      const first = ordered[0]!;
      useUi.getState().setAddAction({
        scope: first.scope,
        title: first.title,
        env: first.env,
        choices: ordered,
        prefill: { label: `${menu.label} copy`, run: def.run, danger: menu.danger },
      });
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  const teamName = menu.team ? (useConfig.getState().snapshot?.config?.teams.find((t) => t.id === menu.team)?.name ?? menu.team) : null;
  const every = `${menu.ref.appId ? "every app" : "every server"}${teamName ? ` in ${teamName}` : ""}`;
  const removal = menu.shared
    ? [
        { label: `Hide on ${where}`, run: () => remove("hide") },
        {
          label: `Delete for ${every}…`,
          run: () =>
            confirmed(
              `Delete ${menu.label} for ${every}?`,
              teamName
                ? `Removes ${menu.label} from ${teamName}'s shared actions (a global one with the same name, if any, applies again).`
                : `Removes the shared ${menu.label} action, so no app or server has it any more.`,
              "deleteShared",
            ),
        },
      ]
    : menu.inherited
      ? [{ label: "Reset to the shared one", hint: "undo changes here", run: () => remove("reset") }]
      : [
          {
            label: "Delete…",
            run: () =>
              confirmed(`Delete ${menu.label}?`, `Removes it from ${where}.`, "delete"),
          },
        ];

  return (
    <PopupMenu
      x={menu.x}
      y={menu.y}
      title={menu.title}
      onClose={close}
      groups={[
        [
          { label: "Run", run: () => triggerAction(menu.ref) },
          { label: "Edit…", hint: "name, command", run: () => useUi.getState().setEditAction(menu) },
          { label: "Duplicate…", hint: "a copy to change", run: () => void duplicate() },
        ],
        [
          { label: "Don't ask", checked: effective === "none", run: setConfirm("none") },
          { label: "Warn first", checked: effective === "warn", run: setConfirm("warn") },
          { label: "Warn + type server name", checked: effective === "type", run: setConfirm("type") },
          {
            label: `Default (${confirmLabel(fallback).toLowerCase()})`,
            hint: menu.confirm === null ? "in use" : undefined,
            disabled: menu.confirm === null,
            run: setConfirm(null),
          },
        ],
        [
          {
            label: "Mark as danger",
            hint: "◆",
            checked: menu.danger,
            run: () => actionSetDanger(menu.ref, !menu.danger).catch((e) => toastError(errorMessage(e))),
          },
        ],
        removal,
      ]}
    />
  );
}
