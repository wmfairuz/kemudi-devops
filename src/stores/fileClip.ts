// Files ▸ Copy / Cut: what ⌘V pastes, shared by every Files tab (pasting
// works within the same server).
import { create } from "zustand";

export interface FileClip {
  serverId: string;
  path: string;
  name: string;
  dir: boolean;
  /** Cut: paste moves it. */
  cut: boolean;
}

export const useFileClip = create<{ clip: FileClip | null; set(clip: FileClip | null): void }>((set) => ({
  clip: null,
  set: (clip) => set({ clip }),
}));

// Dev only: a hot-swapped store would be a second, empty copy; reload instead.
import.meta.hot?.accept(() => window.location.reload());
