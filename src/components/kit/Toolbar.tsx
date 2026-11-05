import { CAPSULE } from "@/components/kit/capsule";
import { cn } from "@/lib/utils";

type Size = "md" | "sm";

/** One button in a toolbar capsule: round with just an icon, or a pill
 *  with an icon and a label. `sm` fits a 44px section bar. */
export function Tool({
  title,
  onClick,
  active,
  disabled,
  label,
  size = "md",
  children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  /** Shown after the icon (the button becomes a pill). */
  label?: React.ReactNode;
  size?: Size;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label ? undefined : title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-none cursor-pointer items-center justify-center gap-1.5 rounded-full text-foreground/80 transition-colors hover:bg-hover-strong hover:text-foreground active:scale-95 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:active:scale-100",
        size === "sm" ? "h-[26px]" : "h-[30px]",
        label ? (size === "sm" ? "px-2.5 text-[12px]" : "px-3 text-[12.5px]") : size === "sm" ? "w-[26px]" : "w-[30px]",
        active && "bg-hover-strong text-foreground",
      )}
    >
      {children}
      {label && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );
}

/** Buttons that belong together, in one capsule. */
export function Group({ children, size = "md", className }: { children: React.ReactNode; size?: Size; className?: string }) {
  return <div className={cn("flex flex-none items-center gap-0.5 px-[3px]", size === "sm" ? "h-[32px]" : "h-[38px]", CAPSULE, className)}>{children}</div>;
}

/** Pick one of a few views, in a capsule like the toolbar's. */
export function ToolSwitch<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: Size;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-none items-center gap-0.5 px-[3px]", size === "sm" ? "h-[32px]" : "h-[38px]", CAPSULE)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex flex-none cursor-pointer items-center rounded-full whitespace-nowrap transition-colors active:scale-95",
              size === "sm" ? "h-[26px] px-2.5 text-[12px]" : "h-[30px] px-3 text-[12.5px]",
              on ? "bg-primary font-medium text-primary-foreground" : "text-foreground/80 hover:bg-hover-strong hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** The icon size in a toolbar. */
export const TOOL_ICON = "size-[18px]";
