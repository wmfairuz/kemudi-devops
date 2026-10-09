import { useEffect, useState } from "react";

import { Btn } from "@/components/kit/Btn";
import { Hint } from "@/components/kit/Kbd";
import { Modal, ModalFooter, ModalHeader } from "@/components/kit/Modal";
import { Field, TextInput } from "@/components/manage/fields";
import { errorMessage, filesChooseFolder, settingsSave, type Editor } from "@/lib/ipc";
import { useConfig } from "@/stores/config";
import { downloadDir, setDownloadDir, shortPath } from "@/lib/downloads";
import { useDiskAlerts } from "@/stores/diskAlerts";
import { useSslAlerts } from "@/stores/sslAlerts";
import { toastError, useToasts } from "@/stores/toasts";
import { useUi } from "@/stores/ui";

const FONTS = ["Menlo", "SF Mono", "Monaco", "JetBrains Mono", "Fira Code", "Cascadia Code", "Source Code Pro", "Hack"];

/** Kemudi ▸ Settings… (⌘,): terminal look and behaviour, and the editor
 *  "Edit in servers.yaml" opens. Saved to servers.yaml. */
export function SettingsDialog() {
  const open = useUi((s) => s.overlay === "settings");
  if (!open) return null;
  return <SettingsForm />;
}

function SettingsForm() {
  const close = () => useUi.getState().setOverlay("none");
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
      setDownloadDir(downloads);
      useToasts.getState().push("Settings saved", "info");
      close();
    } catch (e) {
      toastError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onOpenChange={(o) => !o && close()} title="Settings" width={540}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ModalHeader>
          <span className="text-[15px] font-semibold">Settings</span>
          <span className="text-[12.5px] text-muted-foreground">
            Open tabs pick up font changes right away.
          </span>
        </ModalHeader>
        <div className="flex flex-col gap-3.5 px-5 pb-4">
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
        </div>
        <ModalFooter>
          <span className="flex-1" />
          <Btn variant="outline" className="pr-2.5" onClick={close}>
            Cancel <Hint>esc</Hint>
          </Btn>
          <Btn type="submit" variant="primary" className="pr-2.5" disabled={!canSave}>
            Save <Hint className="text-primary-foreground/60">↵</Hint>
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  );
}
