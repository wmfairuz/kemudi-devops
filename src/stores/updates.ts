// Check for updates: the dialog, and the opt-in check at launch (off by
// default: Kemudi otherwise never calls out except over ssh).
import { create } from "zustand";

import { updateCheck } from "@/lib/ipc";
import { useToasts } from "@/stores/toasts";

const KEY = "kemudi.updates.atLaunch";
const LAST = "kemudi.updates.lastCheck";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not kept; fine.
  }
}

interface UpdatesState {
  open: boolean;
  atLaunch: boolean;
  show(): void;
  close(): void;
  setAtLaunch(on: boolean): void;
}

export const useUpdates = create<UpdatesState>((set) => ({
  open: false,
  atLaunch: read(KEY) === "on",
  show: () => set({ open: true }),
  close: () => set({ open: false }),
  setAtLaunch: (on) => {
    write(KEY, on ? "on" : "off");
    set({ atLaunch: on });
  },
}));

/** At launch, when switched on: at most once a day, quietly; a toast when
 *  there's a newer version. */
export async function checkAtLaunch(): Promise<void> {
  if (!useUpdates.getState().atLaunch) return;
  const last = Number(read(LAST) ?? 0);
  if (Date.now() - last < 20 * 3600 * 1000) return;
  write(LAST, String(Date.now()));
  try {
    const info = await updateCheck();
    if (info.version) {
      useToasts.getState().push(`Kemudi ${info.version} is available (you have ${info.current})`, "info", {
        label: "Update…",
        run: () => useUpdates.getState().show(),
      });
    }
  } catch {
    // Offline or GitHub unreachable: say nothing; the menu item still works.
  }
}

import.meta.hot?.accept(() => window.location.reload());
