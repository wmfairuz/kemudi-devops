import { TAB_COLORS, type TabColor } from "@/lib/tabColors";
import { cn } from "@/lib/utils";

/** Swatches for a tab colour, plus "none". */
export function ColorPicker({ value, onChange }: { value: TabColor | null; onChange: (c: TabColor | null) => void }) {
  const swatch = "flex size-6 cursor-pointer items-center justify-center rounded-full border-2 transition-transform hover:scale-110";
  return (
    <div role="radiogroup" aria-label="Tab colour" className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        title="No colour"
        onClick={() => onChange(null)}
        className={cn(swatch, "border-control-border bg-background", value === null && "ring-2 ring-primary ring-offset-1")}
      >
        <span className="h-0.5 w-3.5 rotate-45 bg-faint-foreground" />
      </button>
      {(Object.keys(TAB_COLORS) as TabColor[]).map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          title={TAB_COLORS[c].label}
          onClick={() => onChange(c)}
          className={cn(swatch, "border-transparent", value === c && "ring-2 ring-primary ring-offset-1")}
          style={{ background: TAB_COLORS[c].light }}
        />
      ))}
    </div>
  );
}
