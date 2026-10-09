// Amber / red thresholds for server metrics, in one place (monitor tab,
// sidebar and Home badges, disk alerts).

export type Level = "ok" | "warn" | "bad";

export const THRESHOLDS = {
  /** CPU busy %. */
  cpu: { warn: 80, bad: 90 },
  /** Memory used % (total − available). */
  mem: { warn: 80, bad: 90 },
  /** Disk used %. Red also triggers a disk alert. */
  disk: { warn: 80, bad: 90 },
  /** Swap used %. */
  swap: { warn: 50, bad: 80 },
  /** 1-minute load per core. */
  load: { warn: 1, bad: 2 },
} as const;

export type Metric = keyof typeof THRESHOLDS;

export function levelOf(metric: Metric, value: number): Level {
  const t = THRESHOLDS[metric];
  return value >= t.bad ? "bad" : value >= t.warn ? "warn" : "ok";
}

export function worst(...levels: Level[]): Level {
  return levels.includes("bad") ? "bad" : levels.includes("warn") ? "warn" : "ok";
}

/** Dracula colours for the dark monitor; bars and text. */
export const LEVEL_TEXT: Record<Level, string> = { ok: "text-[#50fa7b]", warn: "text-[#ffb86c]", bad: "text-[#ff5555]" };
export const LEVEL_BAR: Record<Level, string> = { ok: "bg-[#50fa7b]", warn: "bg-[#ffb86c]", bad: "bg-[#ff5555]" };
