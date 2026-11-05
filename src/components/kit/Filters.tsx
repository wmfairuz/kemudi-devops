import { Search, X } from "lucide-react";

import { CAPSULE } from "@/components/kit/capsule";
import { cn } from "@/lib/utils";

/** A filter chip with its count: on (filled) or off; none to show, it's dimmed. */
export function FilterChip({ label, on, n, onClick, title, sm }: { label: string; on: boolean; n: number; onClick: () => void; title?: string; sm?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={!on && n === 0}
      className={cn(
        "flex flex-none cursor-pointer items-center rounded-full whitespace-nowrap transition-colors active:scale-[0.97] disabled:cursor-default disabled:opacity-40",
        sm ? "h-[22px] gap-1 px-2 text-[11.5px]" : "h-[26px] gap-1.5 px-2.5 text-[12px]",
        on ? "bg-primary font-medium text-primary-foreground" : "text-foreground/80 enabled:hover:bg-hover-strong enabled:hover:text-foreground",
      )}
    >
      {label}
      <span className={cn("font-mono", sm ? "text-[10px]" : "text-[10.5px]", on ? "text-primary-foreground/80" : "text-faint-foreground")}>{n}</span>
    </button>
  );
}

/** Chips that belong together, in one capsule. */
export function ChipGroup({ children, sm }: { children: React.ReactNode; sm?: boolean }) {
  return <div className={cn("flex flex-none items-center gap-0.5 px-[3px]", sm ? "h-[28px]" : "h-[32px]", CAPSULE)}>{children}</div>;
}

/** A filter set from somewhere else (e.g. a number tile): a chip that only takes it away. */
export function PickedChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="flex h-[26px] flex-none items-center gap-1 rounded-full bg-primary pr-1 pl-2.5 text-[12px] font-medium text-primary-foreground">
      {label}
      <button className="cursor-pointer rounded-full p-0.5 hover:bg-white/20" aria-label={`Stop showing only: ${label}`} onClick={onClear}>
        <X className="size-3" />
      </button>
    </span>
  );
}

/** The search box of a filter bar (Esc clears it). */
export function FilterSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className={cn("flex h-[32px] w-[260px] min-w-[180px] items-center gap-2 px-3", CAPSULE)}>
      <Search className="size-[15px] flex-none text-subtle-foreground" strokeWidth={1.6} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder={placeholder}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint-foreground"
      />
      {value && (
        <button className="cursor-pointer text-subtle-foreground hover:text-foreground" onClick={() => onChange("")} aria-label="Clear the search">
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );
}

/** Every word of `q` is somewhere in `hay` (case aside). */
export const wordsMatch = (q: string, hay: string) =>
  q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.toLowerCase().includes(w));

/** Clear, when anything is filtered. */
export function ClearFilters({ onClick }: { onClick: () => void }) {
  return (
    <button className="cursor-pointer rounded-full px-2 py-1 text-[12px] text-primary hover:bg-primary/10" onClick={onClick}>
      Clear
    </button>
  );
}
