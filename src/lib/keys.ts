// App commands, reachable two ways:
//  * the native menu (src-tauri/src/menu.rs): each item's id arrives as a
//    `menu` event — the reliable path for ⌘ keys on macOS;
//  * a keydown router, for when the webview does see the ⌘ chord first.
// xterm passes every ⌘ chord through (see TerminalSession's key handler);
// everything else stays in the PTY.
import { copyCommand, copyOutput } from "@/lib/blockActions";
import { DETAILS_ID, HISTORY_ID, isViewTab, openLocalShell, useTabs } from "@/stores/tabs";
import { useVault } from "@/stores/vault";
import { useUi } from "@/stores/ui";

function activeSession() {
  const { tabs, activeId } = useTabs.getState();
  return tabs.find((t) => t.id === activeId)?.session;
}

const COMMANDS: Record<string, () => void> = {
  "tab.new": () => void openLocalShell(),
  "tab.ssh": () => useUi.getState().setOverlay("ssh"),
  "tab.close": () => {
    const tabs = useTabs.getState();
    // With no tabs, ⌘W does nothing rather than closing the window.
    if (tabs.activeId === HISTORY_ID) tabs.closeHistory();
    else if (tabs.activeId === DETAILS_ID) tabs.closeDetails();
    else if (tabs.activeId) tabs.close(tabs.activeId);
  },
  "tab.prev": () => useTabs.getState().activateRelative(-1),
  "tab.next": () => useTabs.getState().activateRelative(1),
  history: () => {
    const tabs = useTabs.getState();
    if (tabs.activeId === HISTORY_ID) tabs.closeHistory();
    else tabs.openHistory();
  },
  palette: () => {
    const ui = useUi.getState();
    ui.setOverlay(ui.overlay === "palette" ? "none" : "palette");
  },
  find: () => {
    const { activeId } = useTabs.getState();
    const tab = useTabs.getState().tabs.find((t) => t.id === activeId);
    if (tab && !isViewTab(tab.kind)) useUi.getState().setSearchOpen(true);
    else if (tab?.kind === "logs") window.dispatchEvent(new CustomEvent("kemudi:logs-find", { detail: tab.id }));
    else if (tab?.kind === "files") window.dispatchEvent(new CustomEvent("kemudi:files-find", { detail: tab.id }));
  },
  "block.copyCommand": () => {
    const s = activeSession();
    if (s) void copyCommand(s);
  },
  "block.copyOutput": () => {
    const s = activeSession();
    if (s) void copyOutput(s);
  },
  "edit.selectAll": () => {
    const el = document.activeElement;
    const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    if (field && !el.classList.contains("xterm-helper-textarea")) return el.select();
    const s = el?.closest(".xterm") ? activeSession() : undefined;
    if (s) s.selectAll();
    else document.execCommand("selectAll");
  },
  settings: () => useUi.getState().setOverlay("settings"),
  passwords: () => useUi.getState().setOverlay("passwords"),
  environment: () => useUi.getState().setOverlay("environment"),
  "panel.actions": () => useUi.getState().toggleActionsPanel(),
  "vault.fill": () => {
    const { tabs, activeId } = useTabs.getState();
    const tab = tabs.find((t) => t.id === activeId);
    if (tab && !isViewTab(tab.kind)) useVault.getState().openPicker(tab);
  },
  "pane.splitRight": () => useTabs.getState().splitActive("row"),
  "pane.splitDown": () => useTabs.getState().splitActive("col"),
  "pane.left": () => useTabs.getState().focusSide("left"),
  "pane.right": () => useTabs.getState().focusSide("right"),
  "pane.up": () => useTabs.getState().focusSide("up"),
  "pane.down": () => useTabs.getState().focusSide("down"),
};
// ⌘1–8 jump to that tab, ⌘9 to the last one (browser/Warp convention).
for (let n = 1; n <= 9; n++) {
  COMMANDS[`tab.${n}`] = () => useTabs.getState().activateIndex(n === 9 ? -1 : n - 1);
}

let last = { id: "", at: 0 };

/** Run a command by id. The same command twice within 150ms runs once, in
 *  case a ⌘ key reaches both the page and the menu. */
export function runCommand(id: string): boolean {
  const run = COMMANDS[id];
  if (!run) return false;
  const now = performance.now();
  if (last.id === id && now - last.at < 150) return true;
  last = { id, at: now };
  run();
  return true;
}

/** ⌘ chord → command id. Uses the physical key where Option/Shift change e.key. */
function commandFor(e: KeyboardEvent): string | null {
  if (e.code === "KeyC" && e.shiftKey) return e.altKey ? "block.copyOutput" : "block.copyCommand";
  if (e.altKey && !e.shiftKey) {
    const side = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[e.code];
    return side ? `pane.${side}` : null;
  }
  if (e.altKey) return null;
  if (e.code === "KeyD") return e.shiftKey ? "pane.splitDown" : "pane.splitRight";
  if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) return `tab.${e.code.slice(5)}`;
  if (e.shiftKey && e.code === "BracketLeft") return "tab.prev";
  if (e.shiftKey && e.code === "BracketRight") return "tab.next";
  if (e.shiftKey && e.code === "KeyT") return "tab.ssh";
  if (e.shiftKey && e.code === "KeyP") return "vault.fill";
  if (e.shiftKey && e.code === "KeyK") return "passwords";
  if (e.shiftKey) return null;
  const byCode: Record<string, string> = {
    KeyA: "edit.selectAll",
    KeyJ: "panel.actions",
    KeyT: "tab.new",
    KeyW: "tab.close",
    KeyY: "history",
    KeyK: "palette",
    KeyF: "find",
    Comma: "settings",
  };
  return byCode[e.code] ?? null;
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!e.metaKey || e.ctrlKey) return;
    const id = commandFor(e);
    if (id && runCommand(id)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener("keydown", onKey, { capture: true });
  return () => window.removeEventListener("keydown", onKey, { capture: true });
}
