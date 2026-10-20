// Settings ▸ Ask before ⌘W closes a tab (off by default). Kept on this Mac.
import { create } from "zustand";

const KEY = "kemudi.confirmClose";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export const useConfirmClose = create<{ enabled: boolean; setEnabled(on: boolean): void }>((set) => ({
  enabled: read(),
  setEnabled: (on) => {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      // Not kept; fine.
    }
    set({ enabled: on });
  },
}));
