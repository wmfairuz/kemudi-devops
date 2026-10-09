import { cn } from "@/lib/utils";

import type { Status } from "./env";

const ring: Record<Status, string> = {
  up: "bg-status-up shadow-[0_0_0_2px_rgb(80_250_123/0.18)]",
  down: "bg-status-down shadow-[0_0_0_2px_rgb(255_85_85/0.22)]",
  checking: "bg-status-checking animate-[status-pulse_1.2s_ease-in-out_infinite]",
  unknown: "bg-status-unknown",
};

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      className={cn("inline-block size-[7px] shrink-0 rounded-full", ring[status], className)}
      aria-label={status}
    />
  );
}
