import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** CAPSULE (kit/capsule) without its rounding (the button has its own). */
const CAPSULE_LOOK =
  "border border-black/[0.08] bg-background shadow-[0_1px_2px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.05)] in-[.dracula]:border-white/10 dark:border-white/10";

/** Dialog and panel buttons (design: 30px dialog, 24px compact): capsules,
 *  like the title bar's toolbar (macOS 26). */
export const btn = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full whitespace-nowrap font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 enabled:active:scale-[0.97] disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary:
          "border-0 bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08),0_2px_8px_rgba(0,0,0,0.06)] enabled:hover:bg-primary-hover disabled:opacity-45 disabled:shadow-none",
        // The title bar's capsule: white, a hairline and a soft shadow.
        secondary: `${CAPSULE_LOOK} text-foreground enabled:hover:bg-hover-strong disabled:opacity-45`,
        outline: `${CAPSULE_LOOK} text-foreground enabled:hover:bg-hover-strong disabled:opacity-45`,
        ghost:
          "border border-transparent bg-transparent font-normal text-muted-foreground enabled:hover:bg-secondary enabled:hover:text-foreground disabled:opacity-45",
        danger: "border-0 bg-env-prod text-white enabled:hover:bg-env-prod-hover disabled:bg-env-prod/22 disabled:text-white/38",
      },
      size: {
        md: "h-[30px] px-3.5 text-[12.5px]",
        sm: "h-6 px-2.5 text-[11.5px]",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Btn({
  className,
  variant,
  size,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof btn>) {
  return <button type={type} className={cn(btn({ variant, size }), className)} {...props} />;
}
