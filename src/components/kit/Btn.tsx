import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Dialog and panel buttons (design: 30px dialog, 24px compact). */
export const btn = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed",
  {
    variants: {
      variant: {
        primary: "border-0 bg-primary text-primary-foreground enabled:hover:bg-primary-hover disabled:opacity-45",
        secondary: "border border-control-border bg-secondary text-foreground enabled:hover:bg-hover-strong disabled:opacity-45",
        outline: "border border-control-border bg-transparent text-foreground enabled:hover:bg-secondary disabled:opacity-45",
        ghost:
          "border border-transparent bg-transparent font-normal text-muted-foreground enabled:hover:bg-secondary enabled:hover:text-foreground disabled:opacity-45",
        danger: "border-0 bg-env-prod text-white enabled:hover:bg-env-prod-hover disabled:bg-env-prod/22 disabled:text-white/38",
      },
      size: {
        md: "h-[30px] rounded-lg px-3 text-[12.5px]",
        sm: "h-6 rounded-md px-2 text-[11.5px]",
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
