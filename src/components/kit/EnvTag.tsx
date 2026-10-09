import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

import { envLabel, type Env } from "./env";

const tag =
  // Flex-centred so the label sits mid-tag whatever the font's metrics.
  "inline-flex h-4 shrink-0 items-center justify-center rounded-sm border font-mono text-[9.5px] leading-none tracking-[0.04em]";

export const envTag = cva(cn(tag, "w-[34px]"), {
  variants: {
    env: {
      prod: "text-env-prod-fg bg-env-prod/12 border-env-prod/32",
      staging: "text-env-staging-fg bg-env-staging/12 border-env-staging/30",
      qa: "text-env-qa-fg bg-env-qa/12 border-env-qa/30",
      dev: "text-env-dev-fg bg-foreground/4 border-foreground/15",
    },
  },
  defaultVariants: { env: "dev" },
});

export function EnvTag({ env, className }: { env: Env; className?: string }) {
  return <span className={cn(envTag({ env }), className)}>{envLabel[env]}</span>;
}

export function VpnBadge() {
  return <span className={cn(tag, "border-vpn/28 bg-vpn/10 px-1 text-vpn-fg")}>VPN</span>;
}

export function StaleBadge() {
  return (
    <span className="inline-flex h-4 items-center rounded-sm border border-dashed border-env-staging/45 px-[5px] font-mono text-[9.5px] leading-none tracking-[0.04em] text-env-staging-fg">
      STALE
    </span>
  );
}

export function DangerBadge() {
  return (
    <span className="inline-flex h-4 items-center gap-[5px] rounded-sm bg-env-prod px-[5px] font-mono text-[9.5px] tracking-[0.04em] text-white">
      <span className="size-[5px] rotate-45 bg-white" />
      DANGER
    </span>
  );
}
