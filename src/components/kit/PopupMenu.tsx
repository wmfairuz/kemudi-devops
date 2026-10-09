import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  hint?: string;
  /** Shows a ✓ (for choice items). */
  checked?: boolean;
  /** Drawn before the label (e.g. a colour swatch). */
  icon?: React.ReactNode;
  disabled?: boolean;
  run: () => void | Promise<unknown>;
}

interface Props {
  x: number;
  y: number;
  /** Small dim heading naming what the menu is about. */
  title?: string;
  groups: MenuItem[][];
  onClose: () => void;
  /** Called after an item runs (e.g. to return focus to a terminal). */
  afterRun?: () => void;
  /** Taller rows and bigger text (the team switcher). */
  large?: boolean;
  /** At least this wide (px). */
  minWidth?: number;
}

/** Context menu: one highlighted row that follows the mouse or ↑↓; ↵ runs
 *  it, Esc / click outside / scroll closes. Kept on screen. */
export function PopupMenu({ x, y, title, groups, onClose, afterRun, large, minWidth }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [active, setActive] = useState<number | null>(null);
  const flat = groups.flat();

  const run = (item: MenuItem) => {
    onClose();
    void item.run();
    afterRun?.();
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close, true);
    };
  }, [onClose]);

  const step = (dir: 1 | -1) => {
    const enabled = flat.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const at = active === null ? -1 : enabled.indexOf(active);
    const next = at === -1 ? (dir === 1 ? 0 : enabled.length - 1) : (at + dir + enabled.length) % enabled.length;
    setActive(enabled[next] ?? null);
  };

  let index = 0;
  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation();
        const item = active === null ? undefined : flat[active];
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowDown") step(1);
        else if (e.key === "ArrowUp") step(-1);
        else if (e.key === "Enter" && item && !item.disabled) run(item);
        else return;
        e.preventDefault();
      }}
      onMouseLeave={() => setActive(null)}
      className="fixed z-[70] min-w-[240px] rounded-xl border border-input bg-popover p-1 shadow-[0_16px_48px_rgba(0,0,0,0.22)] outline-none"
      style={{ ...pos, minWidth }}
    >
      {title && <div className={cn("truncate px-2.5 pt-1 pb-1.5 text-subtle-foreground", large ? "text-[12px]" : "text-[11px]")}>{title}</div>}
      {groups.map((items, gi) => (
        <div key={gi} className={cn(gi > 0 && "mt-1 border-t border-divider pt-1")}>
          {items.map((item) => {
            const i = index++;
            const on = active === i && !item.disabled;
            return (
              <div
                key={item.label}
                role="menuitem"
                aria-disabled={item.disabled}
                onMouseEnter={() => setActive(item.disabled ? null : i)}
                onClick={() => !item.disabled && run(item)}
                className={cn(
                  "flex items-center gap-6 rounded-md px-2.5",
                  large ? "h-9 text-[14px]" : "h-7 text-[12.5px]",
                  item.disabled ? "text-faint-foreground" : "text-foreground",
                  on && "bg-primary text-primary-foreground",
                )}
              >
                {groups.some((g) => g.some((it) => it.checked !== undefined)) && (
                  <span className="-mr-3 w-3 text-center">{item.checked ? "✓" : ""}</span>
                )}
                <span className={cn("flex flex-1 items-center whitespace-nowrap", large ? "gap-2.5" : "gap-2")}>
                  {item.icon}
                  {item.label}
                </span>
                {item.hint && <span className="font-mono text-[11px] whitespace-nowrap opacity-70">{item.hint}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
