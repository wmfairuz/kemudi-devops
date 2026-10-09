import { cn } from "@/lib/utils";

/** "NovaOS" → "NO", "stg-web3" → "SW", "ETP DB Prod" → "EDP", "crm" → "CR". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s\-_./]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 3).map((w) => w[0]!.toUpperCase()).join("");
  const w = words[0] ?? "?";
  const caps = w.slice(1).match(/[A-Z]/);
  return (w[0]! + (caps ? caps[0] : (w[1] ?? ""))).toUpperCase();
}

/** A stable hue per id, so each server/app keeps its colour. */
function hue(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** Querious-style rounded square with initials. */
export function Badge({ id, name, size = 28, className }: { id: string; name: string; size?: number; className?: string }) {
  const text = initials(name);
  return (
    <span
      aria-hidden
      className={cn("flex flex-none items-center justify-center rounded-[7px] font-semibold text-white select-none", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * (text.length > 2 ? 0.32 : 0.38)),
        background: `hsl(${hue(id)} 42% 46%)`,
        boxShadow: "inset 0 1px 0 rgb(255 255 255 / 0.18), 0 1px 1px rgb(0 0 0 / 0.3)",
        letterSpacing: "-0.02em",
      }}
    >
      {text}
    </span>
  );
}
