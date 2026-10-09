import { cn } from "@/lib/utils";

export function Spinner({ size = 10, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 animate-[kspin_.8s_linear_infinite] rounded-full border-[1.5px] border-current/20 border-t-foreground",
        className,
      )}
      style={{ width: size, height: size }}
      aria-label="running"
    />
  );
}

/** ✓ / ✗ / $ / ↺ glyphs used for tab and run state. */
export function Glyph({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("w-3 shrink-0 text-center text-[12px] leading-none", className)}>
      {children}
    </span>
  );
}
