import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Field, TextInput } from "@/components/manage/fields";
import { errorMessage, filesChooseFolder, settingsSave, type Editor } from "@/lib/ipc";
import { useConfig } from "@/stores/config";
import { downloadDir, setDownloadDir, shortPath } from "@/lib/downloads";
import { useDiskAlerts } from "@/stores/diskAlerts";
import { useSslAlerts } from "@/stores/sslAlerts";
import { toastError, useToasts } from "@/stores/toasts";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdates } from "@/stores/updates";
import { useConfirmClose } from "@/stores/confirmClose";
import { useMcpPrefs } from "@/stores/mcpPrefs";
import { useTabs } from "@/stores/tabs";

const FONTS = ["Menlo", "SF Mono", "Monaco", "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", "Hack"];

/** Kemudi ▸ Settings… (⌘,): a pinned Settings tab: terminal look and
 *  behaviour, tabs, Claude, monitoring, files. Terminal settings are saved
 *  to servers.yaml, the rest on this Mac. */
export function SettingsView() {
  const config = useConfig.getState().snapshot?.config;
  const t = config?.terminal ?? {};
  const [font, setFont] = useState(t.fontFamily ?? "Menlo");
  const [size, setSize] = useState(String(t.fontSize ?? 14));
  const [lineHeight, setLineHeight] = useState(String(t.lineHeight ?? 1.25));
  const [optionAsMeta, setOptionAsMeta] = useState(t.optionAsMeta ?? false);
  const [scrollback, setScrollback] = useState(String(t.scrollback ?? 10000));
  const [integration, setIntegration] = useState(t.shellIntegration ?? true);
  // Kept as is (no longer shown).
  const [editor] = useState<Editor | "auto">(config?.editor ?? "auto");
  const [busy, setBusy] = useState(false);
  const [diskAlerts, setDiskAlerts] = useState(useDiskAlerts.getState().enabled);
  const [sslAlerts, setSslAlerts] = useState(useSslAlerts.getState().enabled);
  const [updatesAtLaunch, setUpdatesAtLaunch] = useState(useUpdates.getState().atLaunch);
  const [confirmClose, setConfirmClose] = useState(useConfirmClose.getState().enabled);
  const [prodConfirm, setProdConfirm] = useState(useMcpPrefs.getState().prodConfirm);
  const [version, setVersion] = useState("");
  useEffect(() => void getVersion().then(setVersion, () => {}), []);
  const [downloads, setDownloads] = useState<string | null>(downloadDir());
  const [fonts, setFonts] = useState<string[]>(FONTS);

  // Only offer fonts this Mac has.
  useEffect(() => {
    setFonts(FONTS.filter((f) => f === "Menlo" || document.fonts.check(`12px "${f}"`)));
  }, []);

  const sizeN = Number(size);
  const lhN = Number(lineHeight);
  const sbN = Number(scrollback);
  const sizeOk = sizeN >= 8 && sizeN <= 40;
  const lhOk = lhN >= 1 && lhN <= 2;
  const sbOk = Number.isInteger(sbN) && sbN >= 0 && sbN <= 1_000_000;
  const canSave = font.trim() !== "" && sizeOk && lhOk && sbOk && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    try {
      await settingsSave({
        fontFamily: font.trim(),
        fontSize: sizeN,
        lineHeight: lhN,
        optionAsMeta,
        scrollback: sbN,
        shellIntegration: integration,
        editor: editor === "auto" ? null : editor,
      });
      useDiskAlerts.getState().setEnabled(diskAlerts);
      useSslAlerts.getState().setEnabled(sslAlerts);
      useUpdates.getState().setAtLaunch(updatesAtLaunch);
      useConfirmClose.getState().setEnabled(confirmClose);
      useMcpPrefs.getState().setProdConfirm(prodConfirm);
      setDownloadDir(downloads);
      useToasts.getState().push("Settings saved", "info");
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="light-ui absolute inset-0 flex flex-col bg-background text-foreground">
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex h-12 flex-none items-center gap-2 border-b border-divider px-4">
          <span className="text-[14px] font-semibold">Settings</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-subtle-foreground">Open tabs pick up font changes right away.</span>
          <Btn type="submit" size="sm" variant="primary" disabled={!canSave}>
            {busy ? "Saving…" : "Save"}
          </Btn>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-3.5 px-6 py-5">
          <div className="text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">Terminal</div>
          <div className="grid grid-cols-[1fr_88px_88px] gap-3">
            <Field label="Font">
              {(fid) => (
                <>
                  <TextInput id={fid} list="kemudi-fonts" value={font} onChange={(e) => setFont(e.target.value)} />
                  <datalist id="kemudi-fonts">
                    {fonts.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field label="Size">
              {(fid) => (
                <TextInput
                  id={fid}
                  type="number"
                  step={0.5}
                  min={8}
                  max={40}
                  value={size}
                  invalid={!sizeOk}
                  onChange={(e) => setSize(e.target.value)}
                />
              )}
            </Field>
            <Field label="Line height">
              {(fid) => (
                <TextInput
                  id={fid}
                  type="number"
                  step={0.05}
                  min={1}
                  max={2}
                  value={lineHeight}
                  invalid={!lhOk}
                  onChange={(e) => setLineHeight(e.target.value)}
                />
              )}
            </Field>
          </div>
          <div
            className="rounded-lg border border-divider bg-terminal px-3 py-2 text-foreground"
            style={{ fontFamily: `"${font}", Menlo, monospace`, fontSize: sizeOk ? sizeN : 14, lineHeight: lhOk ? lhN * 1.2 : 1.5 }}
          >
            <span className="text-term-green">~/code</span> <span className="text-primary">main</span> ❯ php artisan migrate
          </div>
          <Field label="Scrollback (lines)" className="w-[160px]">
            {(fid) => (
              <TextInput id={fid} type="number" min={0} value={scrollback} invalid={!sbOk} onChange={(e) => setScrollback(e.target.value)} />
            )}
          </Field>
          <label className="flex cursor-pointer items-start gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" className="mt-0.5" checked={optionAsMeta} onChange={(e) => setOptionAsMeta(e.target.checked)} />
            <span>
              Use Option as Meta
              <span className="block text-[11px] text-subtle-foreground">
                For ⌥B / ⌥F word jumps in the shell; off lets ⌥ type special characters.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" className="mt-0.5" checked={integration} onChange={(e) => setIntegration(e.target.checked)} />
            <span>
              Shell integration
              <span className="block text-[11px] text-subtle-foreground">
                Command blocks (copy command / output), click to move the cursor, ⌘A. New tabs only.
              </span>
            </span>
          </label>
          <div className="mt-1 text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">Servers</div>
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="min-w-0 flex-1">
              Server baseline
              <span className="block text-[11px] text-subtle-foreground">
                Repos and ~/.bashrc lines every server should have; check them all, install what's missing.
              </span>
            </span>
            <Btn size="sm" variant="outline" onClick={() => useTabs.getState().openBaseline()}>
              Server baseline…
            </Btn>
          </div>
          <div className="mt-1 text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">Tabs</div>
          <label className="flex cursor-pointer items-start gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" className="mt-0.5" checked={confirmClose} onChange={(e) => setConfirmClose(e.target.checked)} />
            <span>
              Ask before ⌘W closes a tab
              <span className="block text-[11px] text-subtle-foreground">
                ↵ closes it, esc keeps it. The × on a tab closes without asking. Either way ⇧⌘T reopens what you closed last
                (a fresh shell where it was).
              </span>
            </span>
          </label>
          <div className="mt-1 text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">Claude (MCP)</div>
          <div className="flex flex-col gap-1.5 text-[12px] text-muted-foreground">
            <span>A production workflow Claude asks to run is confirmed:</span>
            {(
              [
                ["kemudi", "In Kemudi", "Kemudi comes to the front with its run dialog: type the name, Run (or Cancel)."],
                ["claude", "In Claude", "Claude asks you in the chat to type the name (the one Kemudi's dialog asks for) and passes it; Kemudi runs it if it matches."],
              ] as const
            ).map(([value, label, hint]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2">
                <input type="radio" name="prod-confirm" className="mt-0.5" checked={prodConfirm === value} onChange={() => setProdConfirm(value)} />
                <span>
                  {label}
                  <span className="block text-[11px] text-subtle-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-1 text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">Monitoring</div>
          <label className="flex cursor-pointer items-start gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" className="mt-0.5" checked={diskAlerts} onChange={(e) => setDiskAlerts(e.target.checked)} />
            <span>
              Disk alerts
              <span className="block text-[11px] text-subtle-foreground">
                Every 15 minutes, check reachable servers' disks over ssh (read-only `df`) and notify once when one reaches
                90% (amber from 80%). Servers with a full disk get a red ⚠ badge.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" className="mt-0.5" checked={sslAlerts} onChange={(e) => setSslAlerts(e.target.checked)} />
            <span>
              SSL expiry alerts
              <span className="block text-[11px] text-subtle-foreground">
                Every 6 hours, check the certificates reachable servers serve (over ssh, read-only) and notify once when one
                expires within 14 days. Those servers get a 🔒 badge.
              </span>
            </span>
          </label>
          <div className="mt-1 text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">Files</div>
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="w-[110px] flex-none">Download folder</span>
            <span className="selectable min-w-0 flex-1 truncate font-mono text-foreground" title={downloads ?? "~/Downloads"}>
              {shortPath(downloads)}
            </span>
            <Btn
              size="sm"
              variant="outline"
              onClick={() => void filesChooseFolder(downloads).then((p) => p && setDownloads(p), () => {})}
            >
              Change…
            </Btn>
            {downloads && (
              <Btn size="sm" variant="ghost" onClick={() => setDownloads(null)} title="Back to ~/Downloads">
                Reset
              </Btn>
            )}
          </div>
          <div className="-mt-1 pl-[118px] text-[11px] text-subtle-foreground">Where Files ▸ Download saves; right-click ▸ Download to… asks each time.</div>
          <div className="mt-1 text-[10.5px] font-medium tracking-wide text-faint-foreground uppercase">About</div>
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="flex-1">
              Kemudi Devops <span className="font-mono text-foreground">{version || "…"}</span>
            </span>
            <Btn size="sm" variant="outline" onClick={() => useUpdates.getState().show()}>
              Check for updates…
            </Btn>
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" className="mt-0.5" checked={updatesAtLaunch} onChange={(e) => setUpdatesAtLaunch(e.target.checked)} />
            <span>
              Check for updates at launch
              <span className="block text-[11px] text-subtle-foreground">
                At most once a day, ask GitHub whether there's a newer release (nothing about you or your servers is sent). Off: Kemudi
                only checks when you ask.
              </span>
            </span>
          </label>
        </div>
        </div>
      </form>
    </div>
  );
}
