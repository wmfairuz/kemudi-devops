// macOS notifications when a long action finishes while you're elsewhere.
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

const LONG_MS = 10_000;
let granted: Promise<boolean> | null = null;

function permission(): Promise<boolean> {
  granted ??= isPermissionGranted()
    .then(async (ok) => ok || (await requestPermission()) === "granted")
    .catch(() => false);
  return granted;
}

function human(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

/** A plain notification (disk alerts). */
export async function notify(title: string, body: string) {
  if (!(await permission())) return;
  sendNotification({ title, body });
}

/** Notify if the action ran long and its tab isn't what you're looking at. */
export async function maybeNotifyFinished(title: string, code: number, elapsedMs: number, tabVisible: boolean) {
  if (elapsedMs < LONG_MS || (tabVisible && document.hasFocus())) return;
  if (!(await permission())) return;
  const ok = code === 0;
  sendNotification({
    title: `${ok ? "✓" : "✗"} ${title}`,
    body: ok ? `Finished in ${human(elapsedMs)}` : `Exit ${code} after ${human(elapsedMs)}`,
  });
}
