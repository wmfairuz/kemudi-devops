// One xterm.js terminal bound to one PTY. Lives outside React so a terminal
// survives re-renders, StrictMode double-mounts and being hidden: components
// only attach/detach its host element. Call dispose() to close it for real.
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";

import { BlockTracker } from "@/lib/blocks";
import {
  errorMessage,
  killPty,
  openUrl,
  resizePty,
  spawnPty,
  writePty,
  type PtyEvent,
  type SpawnSpec,
  type TerminalSettings,
} from "@/lib/ipc";

/** Starts the PTY behind a session and resolves to its id. */
export type Spawner = (
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onEvent: (event: PtyEvent) => void,
) => Promise<number>;

export function ptySpawner(spec: SpawnSpec): Spawner {
  return (cols, rows, onData, onEvent) => spawnPty(spec, cols, rows, onData, onEvent);
}

/** A password prompt at the cursor: sudo's, ssh's ("user@host's
 *  password:", with who), or any other "…password:" / "…passphrase:". */
export type PasswordPrompt = { kind: "sudo" } | { kind: "login"; user: string; host: string } | { kind: "other" } | null;

export function passwordPromptIn(line: string): PasswordPrompt {
  if (/\[sudo\] password for [^:]+:\s*$/.test(line)) return { kind: "sudo" };
  const ssh = /(\S+)@(\S+)'s password:\s*$/.exec(line);
  if (ssh) return { kind: "login", user: ssh[1]!, host: ssh[2]! };
  if (/(password|passphrase|passcode)[^:\n]{0,60}:\s*$/i.test(line)) return { kind: "other" };
  return null;
}

export interface SessionOptions {
  /** Written to the terminal before the PTY starts (action headers). */
  intro?: string;
  settings?: TerminalSettings | null;
  /** After the process ends, ↵ starts it again (plain shells, not actions). */
  restartable?: boolean;
}

// Dracula (draculatheme.com), the palette the user runs in Warp.
export const terminalTheme: ITheme = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f2",
  cursorAccent: "#282a36",
  selectionBackground: "#44475a",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

// Warp's defaults on this Mac: Menlo 14px, line height 1.5× the font size.
// xterm's lineHeight multiplies Menlo's natural cell (~1.2× font size), so
// 1.25 lands on Warp's spacing. All three are overridable under `terminal:`.
const FONT_FAMILY = 'Menlo, "SF Mono", monospace';
const FONT_SIZE = 14;
const LINE_HEIGHT = 1.25;

// xterm measures the cell size when it opens; make sure the font is loaded
// first. Never blocks for long: resolves on failure.
function fontReady(family: string, size: number): Promise<unknown> {
  return document.fonts.load(`${size}px ${family}`).catch(() => undefined);
}

export type SessionStatus = "starting" | "running" | "exited" | "failed";

export class TerminalSession {
  readonly term: Terminal;
  readonly search = new SearchAddon();
  /** Command blocks from shell-integration markers. */
  readonly blocks: BlockTracker;
  private readonly host: HTMLDivElement;
  private readonly fit = new FitAddon();
  private readonly resizeObserver: ResizeObserver;
  private ptyIdValue: number | null = null;
  private opened = false;
  private started = false;
  private disposed = false;
  private listeners = new Set<(event: PtyEvent) => void>();
  private promptValue: PasswordPrompt = null;
  private promptListeners = new Set<(p: PasswordPrompt) => void>();
  status: SessionStatus = "starting";
  private readonly fontReady: Promise<unknown>;

  constructor(
    private readonly spawner: Spawner,
    private readonly options: SessionOptions = {},
  ) {
    const settings = options.settings ?? {};
    this.host = document.createElement("div");
    this.host.className = "h-full w-full";
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: settings.fontFamily ? `"${settings.fontFamily}", ${FONT_FAMILY}` : FONT_FAMILY,
      fontSize: settings.fontSize ?? FONT_SIZE,
      lineHeight: settings.lineHeight ?? LINE_HEIGHT,
      macOptionClickForcesSelection: true,
      macOptionIsMeta: settings.optionAsMeta ?? false,
      scrollback: settings.scrollback ?? 10_000,
      theme: terminalTheme,
    });
    this.blocks = new BlockTracker(this.term);
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Plain click selects text like any terminal; ⌘-click opens.
        if (event.metaKey) void openUrl(uri);
      }),
    );
    // Let ⌘ chords bubble to the app's shortcut router; everything else
    // (Ctrl+C/R/D, Esc, arrows, Option combos) belongs to the PTY.
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.metaKey) return false;
      // Typing or Backspace over a selected part of the command replaces it.
      if (ev.type === "keydown" && this.replaceSelection(ev)) {
        ev.preventDefault();
        return false;
      }
      return true;
    });
    // A sudo / ssh password prompt at the cursor offers Fill (see vault).
    this.term.onWriteParsed(() => this.checkPasswordPrompt());
    this.term.onData((data) => {
      if (data.includes("\r")) this.clearPasswordPrompt();
      // An ended shell: ↵ starts it again (reconnects an ssh tab).
      if (this.status === "exited" || this.status === "failed") {
        if (this.options.restartable && data === "\r") void this.restart();
        return;
      }
      this.send(data);
    });
    this.term.onBinary((data) => this.send(Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyIdValue !== null) void resizePty(this.ptyIdValue, cols, rows).catch(() => {});
    });
    this.clickToMoveCursor();
    this.editSelectionOnPasteAndCut();
    this.resizeObserver = new ResizeObserver(() => this.fitToContainer());
    this.fontReady = fontReady(this.term.options.fontFamily ?? FONT_FAMILY, this.term.options.fontSize ?? FONT_SIZE);
  }

  /** Settings ▸ Terminal changed: restyle this tab in place. */
  applySettings(settings: TerminalSettings | null | undefined): void {
    const s = settings ?? {};
    const o = this.term.options;
    const fontFamily = s.fontFamily ? `"${s.fontFamily}", ${FONT_FAMILY}` : FONT_FAMILY;
    const fontSize = s.fontSize ?? FONT_SIZE;
    const lineHeight = s.lineHeight ?? LINE_HEIGHT;
    if (o.fontFamily !== fontFamily) o.fontFamily = fontFamily;
    if (o.fontSize !== fontSize) o.fontSize = fontSize;
    if (o.lineHeight !== lineHeight) o.lineHeight = lineHeight;
    o.macOptionIsMeta = s.optionAsMeta ?? false;
    o.scrollback = s.scrollback ?? 10_000;
    // A newly picked font may still be loading; refit once it's there.
    void fontReady(fontFamily, fontSize).then(() => this.fitToContainer());
  }

  /** Mount into `container` (first call opens xterm and spawns the PTY). */
  attach(container: HTMLElement): void {
    if (this.disposed) return;
    container.appendChild(this.host);
    this.resizeObserver.observe(container);
    void this.fontReady.then(() => {
      if (this.disposed) return;
      if (!this.opened) {
        this.term.open(this.host);
        this.loadWebgl();
        this.opened = true;
      }
      this.fitToContainer();
      if (!this.started) {
        this.started = true;
        void this.start();
      }
    });
  }

  detach(): void {
    this.resizeObserver.disconnect();
    this.host.remove();
  }

  /** Buffer row under a viewport point, or null outside the text area. */
  rowAt(clientY: number): number | null {
    const screen = this.host.querySelector(".xterm-screen");
    if (!screen || !this.opened) return null;
    const rect = screen.getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) return null;
    const row = Math.floor(((clientY - rect.top) / rect.height) * this.term.rows);
    return this.term.buffer.active.viewportY + row;
  }

  /** Viewport point → buffer cell (column rounded to the nearest gap
   *  between cells, like a caret in a text field). */
  private cellAt(clientX: number, clientY: number): { row: number; col: number } | null {
    const row = this.rowAt(clientY);
    const screen = this.host.querySelector(".xterm-screen");
    if (row === null || !screen) return null;
    const rect = screen.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right) return null;
    const col = Math.round(((clientX - rect.left) / rect.width) * this.term.cols);
    return { row, col: Math.min(Math.max(col, 0), this.term.cols) };
  }

  /** ⌘A: the command being typed when at a prompt, else everything. */
  selectAll(): void {
    const input = this.input();
    if (input && input.model.index(input.model.end) > 0) {
      const { start, model } = input;
      const cells = (model.end.row - start.row) * this.term.cols + model.end.col - start.col;
      this.term.select(start.col, start.row, cells);
    } else {
      this.term.selectAll();
    }
  }

  /** The command line being typed, while at a prompt in the normal buffer. */
  private input(): { start: Cell; cursor: Cell; model: InputModel } | null {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return null;
    const start = this.blocks.inputStart();
    if (!start) return null;
    const cursor = { row: buf.baseY + buf.cursorY, col: buf.cursorX };
    if (cursor.row < start.row) return null;
    return { start, cursor, model: inputModel(this.term, start, cursor) };
  }

  /** Keys that delete the selected part of the command (and type over it):
   *  move the cursor to its end, then that many backspaces. */
  private selectionEdit(): string | null {
    const range = this.term.getSelectionPosition();
    const input = range && this.input();
    if (!range || !input) return null;
    const { start, cursor, model } = input;
    // x is 0-based here (despite the typings), end exclusive.
    const from = { row: range.start.y, col: range.start.x };
    const to = model.clamp({ row: range.end.y, col: range.end.x });
    if (from.row < start.row || (from.row === start.row && from.col < start.col)) return null;
    const count = model.index(to) - model.index(from);
    if (count <= 0) return null;
    const delta = model.index(to) - model.index(cursor);
    return this.arrows(delta) + "\x7f".repeat(count);
  }

  private replaceSelection(ev: KeyboardEvent): boolean {
    if (!this.term.hasSelection() || ev.ctrlKey || ev.isComposing) return false;
    const typed = ev.key.length === 1 ? ev.key : ev.key === "Backspace" || ev.key === "Delete" ? "" : null;
    if (typed === null) return false;
    const edit = this.selectionEdit();
    if (edit === null) return false;
    this.term.clearSelection();
    this.send(edit + typed);
    return true;
  }

  /** ⌘V over a selected part of the command replaces it; ⌘X cuts it. One
   *  write each, so the delete and the paste can't arrive out of order. */
  private editSelectionOnPasteAndCut(): void {
    this.host.addEventListener(
      "paste",
      (e) => {
        if (!this.term.hasSelection()) return;
        const edit = this.selectionEdit();
        const text = e.clipboardData?.getData("text/plain");
        if (edit === null || !text) return;
        e.preventDefault();
        e.stopPropagation();
        const body = text.replace(/\r?\n/g, "\r");
        const paste = this.term.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body;
        this.term.clearSelection();
        this.send(edit + paste);
      },
      { capture: true },
    );
    this.host.addEventListener(
      "cut",
      (e) => {
        if (!this.term.hasSelection()) return;
        const edit = this.selectionEdit();
        if (edit === null || !e.clipboardData) return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", this.term.getSelection());
        this.term.clearSelection();
        this.send(edit);
      },
      { capture: true },
    );
  }

  private arrows(delta: number): string {
    const app = this.term.modes.applicationCursorKeysMode;
    const key = delta < 0 ? (app ? "\x1bOD" : "\x1b[D") : app ? "\x1bOC" : "\x1b[C";
    return key.repeat(Math.abs(delta));
  }

  /** Warp-style: a plain click inside the command you're typing moves the
   *  cursor there, by sending the shell ← / → presses. Only at a prompt
   *  (shell-integration markers), never in full-screen or mouse-mode apps,
   *  and not when the click was a drag, double-click or modified. */
  private clickToMoveCursor(): void {
    let down: { row: number; col: number } | null = null;
    this.host.addEventListener("mousedown", (e) => {
      down = e.button === 0 && e.detail === 1 ? this.cellAt(e.clientX, e.clientY) : null;
    });
    this.host.addEventListener("mouseup", (e) => {
      const from = down;
      down = null;
      if (!from || e.button !== 0 || e.detail !== 1 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const at = this.cellAt(e.clientX, e.clientY);
      if (!at || at.row !== from.row || at.col !== from.col || this.term.hasSelection()) return;
      if (this.term.modes.mouseTrackingMode !== "none") return;
      const input = this.input();
      if (!input || at.row < input.start.row) return;
      const { model, cursor } = input;
      const delta = model.index(model.clamp(at)) - model.index(cursor);
      if (delta !== 0) this.send(this.arrows(delta));
    });
  }

  focus(): void {
    if (this.opened) this.term.focus();
    else void this.fontReady.then(() => this.term.focus());
  }

  onEvent(listener: (event: PtyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Type commands at the first prompt, as if the user had (tab configs).
   *  Waits for shell integration's ready-for-input mark, or a few seconds
   *  when it's off. */
  typeAtPrompt(commands: string[], { submit = true }: { submit?: boolean } = {}): void {
    if (commands.length === 0) return;
    let sent = false;
    const send = () => {
      if (sent || this.disposed) return;
      sent = true;
      // Without submit the last command waits on the line for ↵.
      this.send(commands.map((c, i) => (submit || i < commands.length - 1 ? `${c}\r` : c)).join(""));
    };
    void this.blocks.nextInput().then(send);
    setTimeout(send, 4000);
  }

  /** Put text on the command line as a paste (bracketed when the shell
   *  wants it, so a multi-line snippet doesn't run line by line); `submit`
   *  presses ↵ after it. */
  paste(text: string, { submit = false }: { submit?: boolean } = {}): void {
    const body = text.replace(/\r?\n/g, "\r");
    const pasted = this.term.modes.bracketedPasteMode ? `\x1b[200~${body}\x1b[201~` : body;
    this.send(submit ? `${pasted}\r` : pasted);
  }

  /** The password prompt the cursor sits at, if any. */
  get passwordPrompt(): PasswordPrompt {
    return this.promptValue;
  }

  onPasswordPrompt(listener: (p: PasswordPrompt) => void): () => void {
    this.promptListeners.add(listener);
    return () => this.promptListeners.delete(listener);
  }

  clearPasswordPrompt(): void {
    this.setPrompt(null);
  }

  private setPrompt(p: PasswordPrompt): void {
    if (JSON.stringify(p) === JSON.stringify(this.promptValue)) return;
    this.promptValue = p;
    for (const l of this.promptListeners) l(p);
  }

  private checkPasswordPrompt(): void {
    const b = this.term.buffer.active;
    const line = b.getLine(b.baseY + b.cursorY)?.translateToString(true).slice(0, b.cursorX) ?? "";
    this.setPrompt(passwordPromptIn(line));
  }

  /** Type text into the PTY as if the user had. */
  send(data: string | number[]): void {
    if (this.ptyIdValue !== null && this.status === "running") {
      void writePty(this.ptyIdValue, data).catch(() => {});
    }
  }

  fitToContainer(): void {
    // Hidden (display:none / detached) containers measure as 0×0.
    if (!this.opened || this.host.clientWidth === 0 || this.host.clientHeight === 0) return;
    try {
      this.fit.fit();
    } catch {
      // fit() can throw while the renderer is mid-teardown; harmless.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    if (this.ptyIdValue !== null) void killPty(this.ptyIdValue).catch(() => {});
    this.listeners.clear();
    this.promptListeners.clear();
    this.term.dispose();
  }

  /** The PTY id once started (for "send to current tab"). */
  get ptyId(): number | null {
    return this.ptyIdValue;
  }

  private async start(): Promise<void> {
    if (this.options.intro) this.term.write(this.options.intro);
    try {
      const id = await this.spawner(
        Math.max(this.term.cols, 2),
        Math.max(this.term.rows, 1),
        (bytes) => this.term.write(bytes),
        (event) => this.handleEvent(event),
      );
      if (this.disposed) {
        void killPty(id).catch(() => {});
        return;
      }
      this.ptyIdValue = id;
      this.status = "running";
      // The size may have changed while the spawn was in flight.
      void resizePty(id, this.term.cols, this.term.rows).catch(() => {});
    } catch (e) {
      this.status = "failed";
      this.term.write(`\x1b[1;31mCould not start: ${errorMessage(e)}\x1b[0m\r\n`);
      if (this.options.restartable) this.term.write("\x1b[2mpress \x1b[1m↵\x1b[22m\x1b[2m to try again\x1b[0m\r\n");
      for (const listener of this.listeners) listener({ type: "exit", code: null });
    }
  }

  /** Start an ended shell again in the same tab (↵ after it exits). */
  private async restart(): Promise<void> {
    if (this.disposed || (this.status !== "exited" && this.status !== "failed")) return;
    this.status = "starting";
    this.term.write("\r\n");
    for (const listener of this.listeners) listener({ type: "restart" });
    await this.start();
  }

  private handleEvent(event: PtyEvent): void {
    if (event.type === "exit") {
      this.status = "exited";
      const code = event.code === null ? "" : ` (${event.code})`;
      const again = this.options.restartable ? " · press \x1b[1m↵\x1b[22m\x1b[2m to start it again" : "";
      this.term.write(`\r\n\x1b[2m[process exited${code}]${again}\x1b[0m\r\n`);
    }
    for (const listener of this.listeners) listener(event);
  }

  private loadWebgl(): void {
    try {
      const webgl = new WebglAddon();
      // On GPU context loss fall back to xterm's DOM renderer.
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      // WebGL2 unavailable: the DOM renderer is already active.
    }
  }
}

interface Cell {
  row: number;
  col: number;
}

interface InputModel {
  /** Just after the last character typed (a grey autosuggestion isn't text). */
  end: Cell;
  /** Clicks on the prompt go to the start, past the end to the end. */
  clamp(p: Cell): Cell;
  /** Characters from the input start to a cell (wide characters count once). */
  index(p: Cell): number;
}

/** The command line that starts at `start` and runs over soft-wrapped rows,
 *  at least to the cursor's row. */
export function inputModel(term: Terminal, start: Cell, cursor: Cell): InputModel {
  const buf = term.buffer.active;
  let last = Math.max(start.row, cursor.row);
  while (buf.getLine(last + 1)?.isWrapped) last++;
  const lastLine = buf.getLine(last);
  const from = last === start.row ? start.col : 0;
  let endCol = from;
  if (lastLine) {
    for (let x = lastLine.length - 1; x >= from; x--) {
      const cell = lastLine.getCell(x);
      if (!cell || cell.getChars() === "" || cell.getChars() === " ") continue;
      if (cell.isFgPalette() && cell.getFgColor() === 8) continue; // zsh-autosuggestion
      endCol = x + cell.getWidth();
      break;
    }
  }
  const end = { row: last, col: endCol };
  return {
    end,
    clamp(p) {
      if (p.row < start.row || (p.row === start.row && p.col < start.col)) return start;
      if (p.row > end.row || (p.row === end.row && p.col > end.col)) return end;
      return p;
    },
    index(p) {
      let n = 0;
      for (let y = start.row; y <= p.row; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        const to = y === p.row ? p.col : term.cols;
        for (let x = y === start.row ? start.col : 0; x < to; x++) {
          if (line.getCell(x)?.getWidth() !== 0) n++;
        }
      }
      return n;
    },
  };
}
