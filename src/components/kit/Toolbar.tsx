import { CAPSULE } from "@/components/kit/capsule";
import { cn } from "@/lib/utils";

/** One button in a toolbar capsule: round with just an icon, or a pill
 *  with an icon and a label. */
export function Tool({
  title,
  onClick,
  active,
  label,
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  /** Shown after the icon (the button becomes a pill). */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={label ? undefined : title}
      onClick={onClick}
      className={cn(
        "flex h-[30px] flex-none cursor-pointer items-center justify-center gap-1.5 rounded-full text-foreground/80 transition-colors hover:bg-hover-strong hover:text-foreground active:scale-95",
        label ? "px-3 text-[12.5px]" : "w-[30px]",
        active && "bg-hover-strong text-foreground",
      )}
    >
      {children}
      {label && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );
}

/** Buttons that belong together, in one capsule. */
export function Group({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex h-[38px] flex-none items-center gap-0.5 px-[3px]", CAPSULE, className)}>{children}</div>;
}

/** The icon size in a toolbar. */
export const TOOL_ICON = "size-[18px]";
