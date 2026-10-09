import { useRef } from "react";

import { Kbd } from "@/components/kit/Kbd";
import { LogoMark } from "@/components/kit/Logo";
import { useUi } from "@/stores/ui";

interface Props {
  filter: string;
  onFilter: (value: string) => void;
  filterRef?: React.Ref<HTMLInputElement>;
  footer: React.ReactNode;
  /** Under the name, above the filter (the team switcher). */
  top?: React.ReactNode;
  children: React.ReactNode;
}

/** Resizable sidebar chrome: name and filter box on top, footer at the bottom. */
export function SidebarFrame({ filter, onFilter, filterRef, footer, top, children }: Props) {
  const width = useUi((s) => s.sidebarWidth);
  const setWidth = useUi((s) => s.setSidebarWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current) setWidth(drag.current.w + e.clientX - drag.current.x);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <aside
      className="relative flex min-h-0 flex-none flex-col border-r border-sidebar-border bg-sidebar"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        className="absolute inset-y-0 -right-[3px] z-10 w-1.5 cursor-col-resize hover:bg-primary/20"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setWidth(300)}
      />
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <LogoMark className="h-[18px]" />
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-foreground">Kemudi Devops</span>
      </div>
      {top}
      <div className="px-2.5 pt-1.5 pb-1.5">
        <label className="flex h-7 items-center gap-2 rounded-lg border border-control-border bg-muted pr-1.5 pl-2 text-[12.5px] text-subtle-foreground">
          <SearchIcon />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                onFilter("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Filter servers & apps"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-subtle-foreground"
          />
          <Kbd className="border-control-border">/</Kbd>
        </label>
      </div>
      {children}
      <div className="flex flex-none flex-col gap-px border-t border-divider p-1.5">{footer}</div>
    </aside>
  );
}

export function SearchIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

export function FooterRow({
  onClick,
  children,
  mono,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={
        mono
          ? "flex h-7 items-center gap-2 rounded-md px-2 text-left font-mono text-[11px] text-subtle-foreground hover:bg-hover hover:text-muted-foreground"
          : "flex h-7 items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}
