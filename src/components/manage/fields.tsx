import { useId } from "react";

import { cn } from "@/lib/utils";

/** Label + control + optional hint, for the server/app forms. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  children: (id: string) => React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="text-[11.5px] text-muted-foreground">
        {label}
      </label>
      {children(id)}
      {hint && <div className="text-[11px] leading-4 text-subtle-foreground">{hint}</div>}
    </div>
  );
}

export function TextInput({
  className,
  invalid,
  ...props
}: React.ComponentProps<"input"> & { invalid?: boolean }) {
  return (
    <input
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      {...props}
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border bg-background px-2.5 font-mono text-[12.5px] text-foreground outline-none placeholder:text-faint-foreground focus:border-primary/60",
        invalid ? "border-env-prod/70" : "border-control-border",
        className,
      )}
    />
  );
}

/** Pick one of a few values (env, VPN). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-fit rounded-md border border-control-border p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "h-6 rounded-[4px] px-2.5 text-[11.5px] transition-colors",
              on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-hover-strong hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
