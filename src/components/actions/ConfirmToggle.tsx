import { actionSetConfirm, defaultConfirm, errorMessage, type Confirm, type RenderedAction } from "@/lib/ipc";
import { refOf } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { useActionFlow } from "@/stores/actionFlow";
import { toastError } from "@/stores/toasts";

const LEVELS: { value: Confirm; label: string; hint: string }[] = [
  { value: "none", label: "Don't ask", hint: "Run on click (⌥-click still lets you edit first)" },
  { value: "warn", label: "Warn", hint: "Show the command; one click to run" },
  { value: "type", label: "Type name", hint: "Show the command; type the server name to run" },
];

export const confirmLabel = (c: Confirm) => LEVELS.find((l) => l.value === c)?.label ?? c;

/** "Ask before running" for this one action. Saves to servers.yaml and
 *  switches the open dialog to match (e.g. Warn drops the typing). */
export function ConfirmToggle({ action, command }: { action: RenderedAction; command: string }) {
  const show = useActionFlow((s) => s.show);

  const choose = async (level: Confirm | null) => {
    try {
      await actionSetConfirm(refOf(action), level);
    } catch (e) {
      toastError(errorMessage(e));
      return;
    }
    const confirm = level ?? defaultConfirm(action.env, action.danger);
    const next = { ...action, confirm, confirmExplicit: level !== null };
    // You're already confirming; "Don't ask" applies from the next click.
    const dialog = confirm === "type" ? "dangerConfirm" : action.env === "prod" ? "prodConfirm" : "preview";
    show(dialog, next, {
      command: command.trim() !== action.rendered ? command : null,
      edit: useActionFlow.getState().edit,
    });
  };

  return (
    <div className="flex items-center gap-2 px-5 pb-3 text-[11.5px] text-subtle-foreground">
      <span>Ask before running:</span>
      <div role="radiogroup" aria-label="Ask before running" className="flex rounded-md border border-control-border p-0.5">
        {LEVELS.map((l) => {
          const on = action.confirm === l.value;
          return (
            <button
              key={l.value}
              role="radio"
              aria-checked={on}
              title={l.hint}
              onClick={() => !on && void choose(l.value)}
              className={cn(
                "h-6 rounded-[4px] px-2 text-[11.5px] transition-colors",
                on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-hover-strong hover:text-foreground",
              )}
            >
              {l.label}
            </button>
          );
        })}
      </div>
      {action.confirmExplicit ? (
        <button
          title={`Back to the default for ${action.env}${action.danger ? " + danger" : ""}: ${confirmLabel(defaultConfirm(action.env, action.danger))}`}
          onClick={() => void choose(null)}
          className="text-subtle-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          reset
        </button>
      ) : (
        <span className="text-faint-foreground">default for {action.env}{action.danger ? " + danger" : ""}</span>
      )}
    </div>
  );
}
