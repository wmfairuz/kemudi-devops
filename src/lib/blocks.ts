// Warp-style command blocks, built from shell-integration markers:
//   OSC 133;A  prompt starts        OSC 133;B  command input starts
//   OSC 133;C  output starts        OSC 133;D;<code>  command finished
//   OSC 633;E;<cmd>  exact command line (escaped: \\ and \x3b, \x0a)
// Local zsh, remote bash and action tabs all emit these (see
// src-tauri/src/shell_integration.rs and the action intro in lib/actions.ts).
import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";

export interface Block {
  id: number;
  prompt: IMarker;
  input?: IMarker;
  inputCol?: number;
  /** Rows from the prompt marker to the input start: zle redraws a
   *  multi-line prompt with an erase, which disposes the `input` marker. */
  inputOffset?: number;
  command?: string;
  output?: IMarker;
  end?: IMarker;
  /** Output didn't end with a newline: the end row itself is output. */
  endInclusive?: boolean;
  exitCode?: number;
  decorations: IDecoration[];
}

function unescapeCommand(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})|\\\\/g, (_m, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : "\\",
  );
}

export class BlockTracker {
  private blocks: Block[] = [];
  private nextId = 1;
  private inputWaiters: (() => void)[] = [];
  private finishWaiters: ((code: number | undefined) => void)[] = [];

  constructor(private readonly term: Terminal) {
    term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(";");
      switch (kind) {
        case "A":
          this.startBlock();
          break;
        case "B": {
          const b = this.current();
          for (const w of this.inputWaiters.splice(0)) w();
          if (b) {
            const buf = term.buffer.active;
            b.input = this.mark();
            b.inputCol = buf.cursorX;
            if (!b.prompt.isDisposed) b.inputOffset = buf.baseY + buf.cursorY - b.prompt.line;
          }
          break;
        }
        case "C": {
          const b = this.current();
          if (b && !b.output) b.output = this.mark();
          break;
        }
        case "D":
          this.finish(arg === undefined ? undefined : Number(arg));
          break;
      }
      return true;
    });
    term.parser.registerOscHandler(633, (data) => {
      if (data.startsWith("E;")) {
        const b = this.current();
        if (b) b.command = unescapeCommand(data.slice(2));
      }
      return true;
    });
  }

  private mark(): IMarker | undefined {
    return this.term.registerMarker(0);
  }

  private current(): Block | undefined {
    const b = this.blocks[this.blocks.length - 1];
    return b && !b.end ? b : undefined;
  }

  private startBlock() {
    const prompt = this.mark();
    if (!prompt) return;
    const prev = this.blocks[this.blocks.length - 1];
    const b: Block = { id: this.nextId++, prompt, decorations: [] };
    this.blocks.push(b);
    // Divider after a block that ran a command. The shell hooks leave a blank
    // row after the output; the line goes through its middle so there's room
    // above and below (Warp-style). Without one, it sits on the prompt's top.
    if (prev && (prev.output || prev.command)) {
      const buf = this.term.buffer.active;
      const above = buf.getLine(buf.baseY + buf.cursorY - 1);
      const blankAbove = !!above && above.translateToString(true).trim() === "";
      const marker = blankAbove ? this.term.registerMarker(-1) : prompt;
      const d = marker && this.term.registerDecoration({ marker, width: this.term.cols, layer: "top" });
      d?.onRender((el) => {
        el.style.width = "100%";
        el.style.pointerEvents = "none";
        el.style.background = blankAbove
          ? "linear-gradient(transparent calc(50% - 0.5px), rgb(98 114 164 / 0.4) calc(50% - 0.5px), rgb(98 114 164 / 0.4) calc(50% + 0.5px), transparent calc(50% + 0.5px))"
          : "linear-gradient(rgb(98 114 164 / 0.4) 1px, transparent 1px)";
      });
      if (d) b.decorations.push(d);
    }
    // Keep memory bounded on very long sessions.
    if (this.blocks.length > 2000) this.blocks.splice(0, 500);
  }

  private finish(code: number | undefined) {
    const b = this.current();
    // A prompt that never ran a command (Enter on an empty line) stays open
    // and is replaced by the next prompt.
    if (!b || (!b.output && !b.input && !b.command)) return;
    if (!b.output && b.input) b.output = this.outputAfterInput(b);
    b.endInclusive = this.term.buffer.active.cursorX > 0;
    b.end = this.mark();
    b.exitCode = code;
    for (const w of this.finishWaiters.splice(0)) w(code);
    if (code !== undefined && code !== 0 && code !== 130 && b.output && b.end) {
      const height = Math.max(1, this.endLine(b) - b.output.line);
      const d = this.term.registerDecoration({ marker: b.output, height, width: 1, layer: "bottom" });
      d?.onRender((el) => {
        el.style.width = "2px";
        el.style.marginLeft = "-10px";
        el.style.background = "rgb(255 85 85 / 0.75)";
        el.style.pointerEvents = "none";
      });
      if (d) b.decorations.push(d);
    }
  }

  /** Older bash has no PS0 (no `C` marker): output starts after the input line. */
  private outputAfterInput(b: Block): IMarker | undefined {
    if (!b.input) return undefined;
    const offset = b.input.line + 1 - (this.term.buffer.active.baseY + this.term.buffer.active.cursorY);
    return this.term.registerMarker(offset);
  }

  /** First row after the block's output (the cursor row while running). */
  private endLine(b: Block): number {
    if (b.end && !b.end.isDisposed) return b.end.line + (b.endInclusive ? 1 : 0);
    const buf = this.term.buffer.active;
    return buf.baseY + buf.cursorY + (buf.cursorX > 0 ? 1 : 0);
  }

  /** Resolves when the next command finishes, with its exit code. */
  nextFinish(): Promise<number | undefined> {
    return new Promise((resolve) => this.finishWaiters.push(resolve));
  }

  /** Resolves at the next prompt that's ready for input (OSC 133;B). */
  nextInput(): Promise<void> {
    return new Promise((resolve) => this.inputWaiters.push(resolve));
  }

  /** Where the command being typed starts, while the shell is at a prompt
   *  (input marked, nothing run yet). */
  inputStart(): { row: number; col: number } | undefined {
    const b = this.current();
    if (!b || b.output || b.command !== undefined) return undefined;
    const row = this.inputLine(b);
    return row === undefined ? undefined : { row, col: b.inputCol ?? 0 };
  }

  private inputLine(b: Block): number | undefined {
    if (b.input && !b.input.isDisposed) return b.input.line;
    if (b.inputOffset !== undefined && !b.prompt.isDisposed) return b.prompt.line + b.inputOffset;
    return undefined;
  }

  /** The block containing buffer row `row`. */
  blockAt(row: number): Block | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b && !b.prompt.isDisposed && b.prompt.line <= row) return b.output || b.command ? b : undefined;
    }
    return undefined;
  }

  /** The most recent block that ran a command. */
  last(): Block | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b && (b.output || b.command) && !b.prompt.isDisposed) return b;
    }
    return undefined;
  }

  private lines(from: number, to: number): string {
    const buf = this.term.buffer.active;
    let text = "";
    for (let y = from; y < to; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const next = buf.getLine(y + 1);
      // Soft-wrapped rows join without a newline.
      text += line.translateToString(!next?.isWrapped) + (next?.isWrapped ? "" : "\n");
    }
    return text.replace(/\n+$/, "");
  }

  command(b: Block): string {
    if (b.command !== undefined) return b.command.trim();
    const input = this.inputLine(b);
    if (input === undefined) return "";
    const until = b.output && !b.output.isDisposed ? b.output.line : input + 1;
    const text = this.lines(input, until);
    return text.slice(b.inputCol ?? 0).trim();
  }

  output(b: Block): string {
    if (!b.output || b.output.isDisposed) return "";
    return this.lines(b.output.line, this.endLine(b));
  }

  /** Select the block's output in the terminal (for ⌘C or a look). */
  selectOutput(b: Block) {
    if (!b.output || b.output.isDisposed) return;
    const end = this.endLine(b) - 1;
    if (end >= b.output.line) this.term.selectLines(b.output.line, end);
  }

  scrollTo(b: Block) {
    if (!b.prompt.isDisposed) this.term.scrollToLine(b.prompt.line);
  }

  /** Temporarily tint a block (while its context menu is open). */
  highlight(b: Block): () => void {
    const d = this.term.registerDecoration({
      marker: b.prompt,
      height: Math.max(1, this.endLine(b) - b.prompt.line),
      width: this.term.cols,
      layer: "bottom",
    });
    d?.onRender((el) => {
      el.style.width = "100%";
      el.style.background = "rgb(189 147 249 / 0.10)";
      el.style.pointerEvents = "none";
    });
    return () => d?.dispose();
  }
}

/** Escape a command for OSC 633;E (same rules as the shell hooks). */
export function escapeCommand(cmd: string): string {
  return cmd
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\x3b")
    .replace(/\n/g, "\\x0a")
    .replace(/[\x07\x1b]/g, "");
}
