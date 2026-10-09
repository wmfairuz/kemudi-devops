import { cn } from "@/lib/utils";

/** Keyboard hint chip (⌘K, esc, /). */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-sm border border-control-border bg-muted px-[5px] font-mono text-[10.5px] leading-none text-dim-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Inline shortcut text inside a button. */
export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[10.5px] text-dim-foreground", className)}>{children}</span>;
}
