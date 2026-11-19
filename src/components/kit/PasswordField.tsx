import { Copy, Eye, EyeOff, RefreshCw, Wand2 } from "lucide-react";
import { useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { TextInput } from "@/components/manage/fields";
import { copySecret, errorMessage } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { toastError, useToasts } from "@/stores/toasts";

// Look-alikes (I O l 0 1) left out: these get read off a screen and typed.
const SETS = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnopqrstuvwxyz",
  digits: "23456789",
  // No quotes, backslash, $ or space: safe in .env files, shells and prompts.
  symbols: "!@#%^&*-_=+.?~",
} as const;
type SetKey = keyof typeof SETS;
const SET_LABEL: Record<SetKey, string> = { upper: "Uppercase", lower: "Lowercase", digits: "Numbers", symbols: "Symbols" };
const KEYS = Object.keys(SETS) as SetKey[];

export type GenOptions = { length: number } & Record<SetKey, boolean>;
const MIN = 8;
const MAX = 64;
const DEFAULTS: GenOptions = { length: 20, upper: true, lower: true, digits: true, symbols: true };
const STORE = "kemudi.passwordGenerator";

function loadOptions(): GenOptions {
  try {
    const o = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORE) ?? "{}") as Partial<GenOptions>) };
    o.length = Math.min(MAX, Math.max(MIN, Math.round(Number(o.length)) || DEFAULTS.length));
    return KEYS.some((k) => o[k]) ? o : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function saveOptions(o: GenOptions) {
  try {
    localStorage.setItem(STORE, JSON.stringify(o));
  } catch {
    // Only a convenience: the next one starts from the defaults.
  }
}

/** An unbiased index in [0, n) from the system's crypto source. */
function pick(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0] ?? limit;
    if (v < limit) return v % n;
  }
}

/** A random password with at least one character of each chosen kind. */
export function generatePassword(o: GenOptions): string {
  const sets = KEYS.filter((k) => o[k]).map((k) => SETS[k]);
  const all = sets.join("");
  const out = sets.map((s) => s[pick(s.length)]);
  while (out.length < o.length) out.push(all[pick(all.length)]);
  // Shuffle so the guaranteed ones aren't always first (Fisher–Yates).
  for (let i = out.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

/** Bits of entropy if it were random over the kinds of characters it uses. */
function bits(pw: string): number {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 32;
  return pool ? pw.length * Math.log2(pool) : 0;
}

function strength(pw: string): { label: string; pct: number; color: string; text: string } {
  const b = bits(pw);
  const pct = Math.max(4, Math.min(100, (b / 100) * 100));
  if (b < 40) return { label: "Weak", pct, color: "bg-term-red", text: "text-term-red" };
  if (b < 60) return { label: "Fair", pct, color: "bg-term-yellow", text: "text-term-yellow" };
  if (b < 80) return { label: "Good", pct, color: "bg-term-green/70", text: "text-term-green" };
  return { label: "Strong", pct, color: "bg-term-green", text: "text-term-green" };
}

/** A password input with show/hide and a generator: Generate fills it and
 *  opens the options (length, kinds of characters, regenerate, copy) under
 *  it; every change makes a new one. The options are remembered. */
export function PasswordField({
  id,
  value,
  onChange,
  placeholder,
  autoFocus,
  inputClassName,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputClassName?: string;
}) {
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<GenOptions>(loadOptions);

  const make = (o: GenOptions) => {
    setOpts(o);
    saveOptions(o);
    onChange(generatePassword(o));
    setShow(true);
  };
  const s = strength(value);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex gap-2">
        <TextInput
          id={id}
          autoFocus={autoFocus}
          type={show ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          className={cn("font-mono", inputClassName)}
          onChange={(e) => onChange(e.target.value)}
        />
        <Btn size="sm" variant="ghost" className="h-8 flex-none" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide" : "Show"} title={show ? "Hide" : "Show"}>
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Btn>
        <Btn
          size="sm"
          variant={open ? "primary" : "outline"}
          className="h-8 flex-none"
          aria-expanded={open}
          onClick={() => {
            if (open) return setOpen(false);
            setOpen(true);
            make(opts);
          }}
          title={open ? "Close the generator" : "Make a random password"}
        >
          <Wand2 className="size-3.5" /> Generate
        </Btn>
      </div>
      {value && (
        <div className="flex items-center gap-2.5" aria-live="polite">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-hover-strong">
            <div className={cn("h-full rounded-full transition-[width]", s.color)} style={{ width: `${s.pct}%` }} />
          </div>
          <span className={cn("w-12 flex-none text-right text-[11px] font-medium", s.text)}>{s.label}</span>
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-3 rounded-lg border border-divider bg-panel px-3.5 py-3">
          <div className="flex items-center gap-3">
            <label htmlFor={`${id}-len`} className="w-[118px] flex-none text-[12px] font-medium">
              Length <span className="font-mono tabular-nums">{opts.length}</span>
            </label>
            <input
              id={`${id}-len`}
              type="range"
              min={MIN}
              max={MAX}
              value={opts.length}
              onChange={(e) => make({ ...opts, length: Number(e.target.value) })}
              className="min-w-0 flex-1 accent-primary"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="w-[118px] flex-none text-[12px] font-medium">Characters</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {KEYS.map((k) => {
                const last = opts[k] && KEYS.filter((x) => opts[x]).length === 1;
                return (
                  <label key={k} className={cn("flex items-center gap-1.5 text-[12px]", last ? "cursor-default opacity-60" : "cursor-pointer")} title={last ? "At least one kind" : SETS[k]}>
                    <input type="checkbox" className="accent-primary" checked={opts[k]} disabled={last} onChange={(e) => make({ ...opts, [k]: e.target.checked })} />
                    {SET_LABEL[k]}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] text-subtle-foreground">Look-alikes (I, O, l, 0, 1) are left out.</span>
            <Btn size="sm" variant="ghost" className="h-7" onClick={() => make(opts)} title="Another one">
              <RefreshCw className="size-3.5" /> New
            </Btn>
            <Btn
              size="sm"
              variant="outline"
              className="h-7"
              disabled={!value}
              title="The clipboard clears after 45 s"
              onClick={() =>
                void copySecret(value).then(
                  (secs) => useToasts.getState().push(`Copied the password · clears in ${secs} s`, "info"),
                  (e) => toastError(errorMessage(e)),
                )
              }
            >
              <Copy className="size-3.5" /> Copy
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
