import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { EnvTag } from "@/components/kit/EnvTag";
import { TextInput } from "@/components/manage/fields";
import { errorMessage, type WatchSettings } from "@/lib/ipc";
import { useConfig } from "@/stores/config";
import { toastError, useToasts } from "@/stores/toasts";
import { useWatch } from "@/stores/watch";

type NumKey = { [K in keyof WatchSettings]: WatchSettings[K] extends number ? K : never }[keyof WatchSettings];

const Heading = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-1 text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">{children}</div>
);

/** Settings ▸ Checks: how often each background check runs, when it warns,
 *  and which servers it leaves alone. Kept on this Mac (watch-settings.json). */
export function ChecksSettings() {
  const saved = useWatch((s) => s.settings);
  const servers = useConfig((s) => s.snapshot?.config?.servers ?? []);
  const [draft, setDraft] = useState<WatchSettings | null>(saved);
  const [text, setText] = useState<Partial<Record<NumKey, string>>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (saved && !draft) setDraft(saved);
  }, [saved, draft]);
  if (!draft) return <div className="p-6 text-[12.5px] text-subtle-foreground">Loading…</div>;

  const val = (k: NumKey) => text[k] ?? String(draft[k]);
  const num = (k: NumKey) => Number(val(k));
  const bad = (k: NumKey, min: number, max: number) => {
    const n = num(k);
    return val(k).trim() === "" || !Number.isFinite(n) || n < min || n > max;
  };
  const limits: [NumKey, number, number][] = [
    ["reachMins", 1, 1440],
    ["systemMins", 0, 10080],
    ["updatesHours", 0, 720],
    ["certsHours", 0, 720],
    ["certsSoonHours", 0, 720],
    ["setupHours", 0, 720],
    ["diskWarn", 1, 100],
    ["diskUrgent", 1, 100],
    ["inodeWarn", 1, 100],
    ["memWarn", 1, 100],
    ["swapWarn", 1, 100],
    ["loadWarn", 0.1, 100],
    ["certWarnDays", 0, 365],
    ["certUrgentDays", 0, 365],
  ];
  const invalid = limits.some(([k, a, b]) => bad(k, a, b)) || num("diskWarn") > num("diskUrgent") || num("certUrgentDays") > num("certWarnDays");

  const save = async () => {
    if (invalid) return;
    const next = { ...draft };
    for (const [k] of limits) (next[k] as number) = k === "loadWarn" ? num(k) : Math.round(num(k));
    setBusy(true);
    try {
      await useWatch.getState().saveSettings(next);
      const s = useWatch.getState().settings;
      setDraft(s);
      setText({});
      useToasts.getState().push("Checks saved", "info");
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const numField = ({ k, label, unit, min, max, step }: { k: NumKey; label: string; unit: string; min: number; max: number; step?: number }) => (
    <label key={k} className="flex items-center gap-2 text-[12px] text-muted-foreground">
      <span className="min-w-0 flex-1">{label}</span>
      <TextInput
        className="h-7 w-[76px] text-right"
        inputMode="decimal"
        step={step}
        value={val(k)}
        invalid={bad(k, min, max)}
        onChange={(e) => setText((t) => ({ ...t, [k]: e.target.value }))}
      />
      <span className="w-[64px] flex-none text-subtle-foreground">{unit}</span>
    </label>
  );
  const check = ({ k, label, hint }: { k: "enabled" | "notify" | "aws"; label: string; hint: string }) => (
    <label key={k} className="flex cursor-pointer items-start gap-2 text-[12px] text-muted-foreground">
      <input type="checkbox" className="mt-0.5" checked={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
      <span>
        {label}
        <span className="block text-[11px] text-subtle-foreground">{hint}</span>
      </span>
    </label>
  );

  return (
    <form
      className="absolute inset-0 flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex h-12 flex-none items-center gap-2 border-b border-divider px-4">
        <span className="text-[14px] font-semibold">Checks</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-subtle-foreground">
          Read-only, over the ssh connection Kemudi already uses. Results are kept, so a restart doesn't check again.
        </span>
        <Btn type="submit" size="sm" variant="primary" disabled={invalid || busy}>
          {busy ? "Saving…" : "Save"}
        </Btn>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-3 px-6 py-5">
          {check({ k: "enabled", label: "Check servers in the background", hint: "Off: only Home's Check all and a server's Check now read anything." })}
          {check({ k: "notify", label: "Notify when something becomes urgent", hint: "One macOS notification per problem; again only if it comes back after being fixed." })}
          {check({ k: "aws", label: "Check AWS Auto Scaling groups too", hint: "Each check finds an instance through AWS (Session Manager), so it also calls AWS." })}

          <Heading>How often</Heading>
          <span className="-mt-1 text-[11px] text-subtle-foreground">0 turns a check off in the background (Check now still runs it). Only servers that answer the reachability probe are checked.</span>
          {numField({ k: "reachMins", label: "Reachability (a TCP connect, no ssh): the dots and the VPN gate", unit: "minutes", min: 1, max: 1440 })}
          {numField({ k: "systemMins", label: "Disks, inodes, load, memory, swap, failed services", unit: "minutes", min: 0, max: 10080 })}
          {numField({ k: "updatesHours", label: "Updates, restart needed, each app's APP_DEBUG and maintenance mode", unit: "hours", min: 0, max: 720 })}
          {numField({ k: "certsHours", label: "Certificates", unit: "hours", min: 0, max: 720 })}
          {numField({ k: "certsSoonHours", label: "Certificates, once one is within the warning below", unit: "hours", min: 0, max: 720 })}
          {numField({ k: "setupHours", label: "Setup (against the server's profile)", unit: "hours", min: 0, max: 720 })}

          <Heading>Warn when</Heading>
          {numField({ k: "diskWarn", label: "A disk is this full (a warning)", unit: "%", min: 1, max: 100 })}
          {numField({ k: "diskUrgent", label: "A disk is this full (urgent)", unit: "%", min: 1, max: 100 })}
          {numField({ k: "inodeWarn", label: "Inodes used", unit: "%", min: 1, max: 100 })}
          {numField({ k: "memWarn", label: "Memory in use", unit: "%", min: 1, max: 100 })}
          {numField({ k: "swapWarn", label: "Swap in use", unit: "%", min: 1, max: 100 })}
          {numField({ k: "loadWarn", label: "5-minute load, per CPU", unit: "× CPUs", min: 0.1, max: 100, step: 0.1 })}
          {numField({ k: "certWarnDays", label: "A certificate runs out within (a warning)", unit: "days", min: 0, max: 365 })}
          {numField({ k: "certUrgentDays", label: "A certificate runs out within (urgent)", unit: "days", min: 0, max: 365 })}
          {num("diskWarn") > num("diskUrgent") && <span className="text-[12px] text-env-prod-fg">The disk warning should be at or under the urgent level.</span>}
          {num("certUrgentDays") > num("certWarnDays") && <span className="text-[12px] text-env-prod-fg">Urgent days should be at or under the warning.</span>}

          <Heading>Servers</Heading>
          <span className="-mt-1 text-[11px] text-subtle-foreground">Unticked ones are never checked in the background (Check now still works).</span>
          <div className="flex flex-col divide-y divide-divider rounded-lg border border-divider">
            {servers.map((s) => (
              <label key={s.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={!draft.skip.includes(s.id)}
                  onChange={(e) => setDraft({ ...draft, skip: e.target.checked ? draft.skip.filter((x) => x !== s.id) : [...draft.skip, s.id] })}
                />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <EnvTag env={s.env} />
              </label>
            ))}
          </div>
        </div>
      </div>
    </form>
  );
}
