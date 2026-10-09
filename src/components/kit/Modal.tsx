import { Dialog as D } from "radix-ui";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title (also shown unless the body renders its own). */
  title: string;
  width?: number;
  /** Palette-style: pinned 84px below the title bar instead of centred. */
  top?: boolean;
  children: React.ReactNode;
  className?: string;
  onOpenAutoFocus?: (e: Event) => void;
}

/** Design dialog shell: dims everything below the 38px title bar, #161618
 *  panel, 12px radius. Body/footer layout is up to the caller. */
export function Modal({ open, onOpenChange, title, width = 600, top, children, className, onOpenAutoFocus }: Props) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay
          data-modal-backdrop
          className="fixed inset-x-0 top-[38px] bottom-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          // Focus can land outside (xterm's textarea, window re-activation)
          // without the user meaning to dismiss.
          onFocusOutside={(e) => e.preventDefault()}
          // Only a click on the dimmed backdrop dismisses; a click or drag in
          // the title bar (above the backdrop) must not close a confirm.
          onPointerDownOutside={(e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (!target?.closest("[data-modal-backdrop]")) e.preventDefault();
          }}
          className={cn(
            "fixed left-1/2 z-50 -translate-x-1/2 overflow-hidden rounded-2xl border border-input bg-popover text-foreground shadow-[0_24px_80px_rgba(0,0,0,0.28)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]",
            top ? "top-[122px]" : "top-[calc(50%+19px)] -translate-y-1/2",
            className,
          )}
          style={{ width, maxWidth: "calc(100vw - 48px)" }}
        >
          <D.Title className="sr-only">{title}</D.Title>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function ModalHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-1 px-5 pt-4 pb-3", className)}>{children}</div>;
}

export function ModalFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 border-t border-border bg-dialog-footer px-5 py-3", className)}>
      {children}
    </div>
  );
}
