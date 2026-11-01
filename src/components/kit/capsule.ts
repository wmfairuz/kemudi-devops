// The capsule look (macOS 26 style) shared by the toolbar and the tab strip:
// white, round, a hairline and a soft shadow.
export const CAPSULE =
  "rounded-full border border-black/[0.06] bg-background shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.05)]";

/** A tab in the strip: a pill, raised (a capsule) when it's the one in front. */
export const PILL = "flex h-[32px] items-center gap-2 rounded-full border text-[13px] transition-colors";
export const PILL_OFF = "border-transparent text-dim-foreground hover:bg-hover hover:text-foreground";
export const PILL_ON = "border-black/[0.06] bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.05)]";
/** The front tab of a terminal: dark like the terminal under it. */
export const PILL_ON_DARK = "dracula border-white/10 bg-terminal text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.15),0_2px_8px_rgba(0,0,0,0.12)]";
