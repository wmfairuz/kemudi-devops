// Follows a workflow run in its terminal: the script's `\e]6973;…\a`
// markers say when each step starts, ends, fails or pauses; a step whose
// output stops on an unfinished line that looks like a question is
// "waiting" (the Steps view shows an answer box). Each step's output is kept
// between two buffer markers, so it can be shown on its own.
import type { IMarker, Terminal } from "@xterm/xterm";

import { passwordPromptIn } from "@/lib/terminalSession";

export type StepStatus = "pending" | "skipped" | "running" | "paused" | "done" | "failed";

export interface StepState {
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  /** Exit code when it failed. */
  code?: number;
  start?: IMarker;
  end?: IMarker;
}

/** A question the running step is waiting on. */
export interface Waiting {
  step: number;
  /** The prompt line as shown. */
  text: string;
  secret: boolean;
  /** A yes/no question (buttons for both). */
  yesNo: boolean;
  /** Laravel Prompts' boxed prompts: `confirm` (Yes / No: answered with y /
   *  n and ↵), `choice` (a list: arrow keys and ↵), `text` (typed). */
  box?: "confirm" | "choice" | "text";
}

/** Laravel Prompts draws `┌ question ─┐ / │ … │ / └──┘` and waits on the
 *  bottom border: the question and what's inside, from the lines above. */
function promptsBox(lines: string[]): { text: string; box: "confirm" | "choice" | "text" } | null {
  const top = lines.findIndex((l) => /^[┌╭]/.test(l));
  if (top < 0) return null;
  const question = lines[top]!.replace(/^[┌╭]\s*/, "").replace(/[─━]+\s*[┐╮]?\s*$/, "").trim();
  const body = lines
    .slice(top + 1)
    .map((l) => l.replace(/^[│┃]\s?/, "").replace(/\s*[│┃]\s*$/, "").trim())
    .filter(Boolean);
  const inside = body.join("\n");
  const box = /\bYes\b.*\/.*\bNo\b/.test(inside) ? "confirm" : body.length > 1 || /[○●◯◉›❯]/.test(inside) ? "choice" : "text";
  return { text: [question, box === "text" ? "" : inside].filter(Boolean).join("\n"), box };
}

const YES_NO = /\(yes\/no\)|\[y\/n\]|\(y\/n\)|\[yes\/no\]/i;
/** An unfinished last line that reads like a prompt. */
const PROMPTISH = /([?:>\]]|\(yes\/no\)|\[[^\]]{0,12}\])\s*$/;

export class StepTracker {
  readonly steps: StepState[];
  waiting: Waiting | null = null;
  finished: "ok" | "failed" | null = null;
  private listeners = new Set<() => void>();
  private quiet: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly term: Terminal,
    count: number,
    from: number,
    /** A parallel group / a watch reached: open their panes. */
    private readonly hooks: { group?: (step: number, branches: number) => void; watch?: (step: number) => void } = {},
  ) {
    this.steps = Array.from({ length: count }, (_, i) => ({ status: i + 1 < from ? "skipped" : "pending" }));
    term.parser.registerOscHandler(6973, (data) => {
      this.marker(data);
      return true;
    });
    // Output arriving means nobody's waiting; when it goes quiet on an
    // unfinished prompt-like line, someone is.
    term.onWriteParsed(() => {
      if (this.waiting) this.setWaiting(null);
      clearTimeout(this.quiet);
      this.quiet = setTimeout(() => this.checkWaiting(), 700);
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** The step running or paused now (1-based), if any. */
  get current(): number | null {
    const i = this.steps.findIndex((s) => s.status === "running" || s.status === "paused");
    return i < 0 ? null : i + 1;
  }

  /** The process ended (exit code from the tab). */
  exited(code: number | undefined) {
    const cur = this.current;
    if (cur !== null && code !== 0) {
      const s = this.steps[cur - 1]!;
      s.status = "failed";
      s.endedAt ??= Date.now();
      s.code ??= code;
      s.end ??= this.term.registerMarker(0);
    }
    this.finished = code === 0 ? "ok" : "failed";
    this.setWaiting(null);
    this.emit();
  }

  /** The text a step printed (between its markers). */
  output(n: number): string {
    const s = this.steps[n - 1];
    if (!s?.start || s.start.isDisposed) return "";
    const b = this.term.buffer.active;
    const from = s.start.line;
    const to = s.end && !s.end.isDisposed ? s.end.line : b.baseY + b.cursorY;
    const lines: string[] = [];
    for (let i = from; i <= to; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    // Drop the step's own header and ✓/✗ lines; keep what it printed.
    return lines
      .filter((l) => !/^━━ \d+\/\d+ · /.test(l) && !/^✓ step \d+$/.test(l.trim()))
      .join("\n")
      .trim();
  }

  private marker(data: string) {
    const [kind, a, b] = data.split(";");
    const n = Number(a);
    const s = Number.isFinite(n) ? this.steps[n - 1] : undefined;
    const now = Date.now();
    if (kind === "start" && s) {
      s.status = "running";
      s.startedAt = now;
      s.start = this.term.registerMarker(0);
    } else if (kind === "pause" && s) {
      s.status = "paused";
    } else if (kind === "done" && s) {
      s.status = "done";
      s.endedAt = now;
      s.end = this.term.registerMarker(0);
    } else if (kind === "fail" && s) {
      s.status = "failed";
      s.endedAt = now;
      s.code = Number(b);
      s.end = this.term.registerMarker(0);
    } else if (kind === "end") {
      this.finished = "ok";
    } else if (kind === "group" && s) {
      // Opened after the terminal finishes this write.
      setTimeout(() => this.hooks.group?.(n, Number(b)), 0);
      return;
    } else if (kind === "watch" && s) {
      setTimeout(() => this.hooks.watch?.(n), 0);
      return;
    } else {
      return;
    }
    this.setWaiting(null);
    this.emit();
  }

  private checkWaiting() {
    const cur = this.current;
    if (cur === null || this.steps[cur - 1]!.status !== "running") return;
    const b = this.term.buffer.active;
    if (b.cursorX === 0) return;
    const at = b.baseY + b.cursorY;
    const line = b.getLine(at)?.translateToString(true).slice(0, b.cursorX).trimStart() ?? "";
    if (!line) return;
    let text = line.trim();
    // Laravel Prompts: the cursor sits on the box's bottom border.
    if (/^[└╰][─━]*[┘╯]?$/.test(text)) {
      const first = this.steps[cur - 1]!.start?.line ?? 0;
      const above: string[] = [];
      for (let y = at - 1; y >= first && y >= at - 14; y--) {
        const t = b.getLine(y)?.translateToString(true).trim() ?? "";
        above.unshift(t);
        if (/^[┌╭]/.test(t)) break;
      }
      const p = promptsBox(above);
      if (p) {
        this.setWaiting({ step: cur, text: p.text, secret: false, yesNo: p.box === "confirm", box: p.box });
        return;
      }
    }
    // A bare prompt mark (Laravel's " > ") asks the question on the line(s)
    // above: show those (within this step's output).
    if (text.length <= 2) {
      const first = this.steps[cur - 1]!.start?.line ?? 0;
      const above: string[] = [];
      for (let y = at - 1; y >= first && y >= at - 8 && above.length < 3; y--) {
        const t = b.getLine(y)?.translateToString(true).trim() ?? "";
        if (!t) {
          if (above.length) break;
          continue;
        }
        above.unshift(t);
      }
      if (above.length) text = above.join("\n");
    }
    const secret = passwordPromptIn(line) !== null;
    const yesNo = YES_NO.test(text);
    if (secret || yesNo || PROMPTISH.test(line) || PROMPTISH.test(text)) this.setWaiting({ step: cur, text, secret, yesNo });
  }

  private setWaiting(w: Waiting | null) {
    if (JSON.stringify(w) === JSON.stringify(this.waiting)) return;
    this.waiting = w;
    this.emit();
  }
}
