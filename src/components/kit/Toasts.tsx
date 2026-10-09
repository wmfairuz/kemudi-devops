import { cn } from "@/lib/utils";
import { useToasts } from "@/stores/toasts";

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[380px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          onClick={() => dismiss(t.id)}
          className={cn(
            "selectable pointer-events-auto rounded-xl border bg-popover px-3 py-2.5 text-[12.5px] leading-[18px] shadow-[0_12px_40px_rgba(0,0,0,0.2)]",
            t.tone === "error" ? "border-env-prod-line text-env-prod-btn-fg" : "border-input text-foreground",
          )}
        >
          {t.message}
          {t.action && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
                t.action?.run();
              }}
              className="ml-2 cursor-pointer font-medium text-primary hover:underline"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
