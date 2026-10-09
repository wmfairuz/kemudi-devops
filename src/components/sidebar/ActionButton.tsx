import { cva } from "class-variance-authority";
import {
  Database,
  GitPullRequestArrow,
  ListRestart,
  Package,
  Play,
  Rocket,
  ScrollText,
  Server,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import type { Env } from "@/components/kit/env";
import { cn } from "@/lib/utils";

/** Real buttons: filled, bordered, with hover, pressed and focus states.
 *  Colour follows the server's env (design 1j: ActionButton · env × danger). */
export const actionButton = cva(
  [
    "inline-flex min-w-0 cursor-pointer items-center whitespace-nowrap border font-medium select-none",
    "shadow-[0_1px_1px_rgb(0_0_0/0.08),inset_0_1px_0_rgb(255_255_255/0.5)]",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-100",
    "active:translate-y-px active:shadow-none",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
  ],
  {
    variants: {
      env: {
        prod: "border-env-prod/40 bg-env-prod/8 text-env-prod-btn-fg hover:border-env-prod/70 hover:bg-env-prod/16 active:bg-env-prod/24",
        staging:
          "border-env-staging/40 bg-env-staging/8 text-env-staging-btn-fg hover:border-env-staging/70 hover:bg-env-staging/16 active:bg-env-staging/24",
        qa: "border-env-qa/40 bg-env-qa/8 text-env-qa-fg hover:border-env-qa/70 hover:bg-env-qa/16 active:bg-env-qa/24",
        dev: "border-control-border bg-secondary text-soft-foreground hover:border-dim-foreground/60 hover:bg-hover-strong hover:text-foreground active:bg-selected",
      },
      size: {
        app: "h-8 gap-2 rounded-lg px-3 text-[12.5px]",
        server: "h-6 gap-1.5 rounded-md px-2 text-[11px]",
      },
    },
    defaultVariants: { env: "dev", size: "app" },
  },
);

/** A recognisable icon per common action id; anything else gets ▶. */
const ICONS: Record<string, LucideIcon> = {
  pull: GitPullRequestArrow,
  composer: Package,
  migrate: Database,
  optimize: Sparkles,
  log: ScrollText,
  deploy: Rocket,
  nginx: Server,
  queues: ListRestart,
};

export function DangerMark() {
  return <span title="Marked as danger" className="size-[7px] flex-none rotate-45 bg-env-prod" />;
}

interface Props {
  env: Env;
  id: string;
  label: string;
  danger: boolean;
  size?: "app" | "server";
  title?: string;
  onRun: (alt: boolean) => void;
  /** Right-click: menu for this action (Run, Preview, Edit in servers.yaml). */
  onMenu?: (x: number, y: number) => void;
}

export function ActionButton({ env, id, label, danger, size = "app", title, onRun, onMenu }: Props) {
  const Icon = ICONS[id] ?? Play;
  return (
    <button
      title={title}
      className={cn(actionButton({ env, size }))}
      onClick={(e) => onRun(e.altKey)}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <Icon className="size-4 flex-none opacity-80" strokeWidth={1.75} aria-hidden />
      <span className="truncate">{label}</span>
      {danger && <DangerMark />}
    </button>
  );
}
