// Where Files ▸ Download saves to: a per-Mac preference (Settings ▸ Files);
// null means ~/Downloads.
const KEY = "kemudi.downloadDir";

export function downloadDir(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function setDownloadDir(dir: string | null): void {
  try {
    if (dir) localStorage.setItem(KEY, dir);
    else localStorage.removeItem(KEY);
  } catch {
    // Not kept; downloads go to ~/Downloads.
  }
}

/** "~/Work/dumps" for display. */
export const shortPath = (p: string | null) => (p ?? "~/Downloads").replace(/^\/Users\/[^/]+/, "~");
