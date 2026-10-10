import { Check, ChevronDown, ChevronRight, Circle, KeyRound, Pause, Square, TerminalSquare, X } from "lucide-react";
import { useEffect, useReducer, useState } from "react";

import { Spinner } from "@/components/kit/Spinner";
import { cn } from "@/lib/utils";
import type { StepState } from "@/lib/stepTracker";
import { passwordPromptIn } from "@/lib/terminalSession";
import { useTabs, type Tab } from "@/stores/tabs";
import { killPty } from "@/lib/ipc";
import { fillPassword, suggested, useVault } from "@/stores/vault";
import { useWorkflows } from "@/stores/workflows";

const KIND: Record<string, string> = { local: "this Mac", server: "server", action: "action", pause: "pause", parallel: "at once", watch: "watch" };

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Switch a workflow tab between its steps and the terminal. */
export function setWorkflowView(tab: Tab, view: "steps" | "output") {
  if (tab.workflow) useTabs.getState().update(tab.id, { workflow: { ...tab.workflow, view } });
}

/** The Steps view of a workflow run: each step's progress, its output on
 *  demand, an answer box when it waits for input. The terminal keeps
 *  running underneath (Output ▸ shows it). */
export function WorkflowStepsView({ tab }: { tab: Tab }) {
  const run = tab.workflow!;
  const t = run.tracker;
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => t.subscribe(rerender), [t]);
  useEffect(() => {
    if (t.finished) return;
    const timer = setInterval(rerender, 1000);
    return () => clearInterval(timer);
  }, [t, t.finished]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (n: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const cur = t.current;
  const failed = t.steps.findIndex((s) => s.status === "failed") + 1;
  const ran = t.steps.filter((s) => s.startedAt);
  const startedAt = ran[0]?.startedAt;
  const endedAt = t.finished ? Math.max(...ran.map((s) => s.endedAt ?? 0)) : Date.now();
  const status = failed
    ? `Stopped at step ${failed}`
    : t.finished === "ok"
      ? "Done"
      : cur
        ? `Step ${cur} of ${t.steps.length}`
        : t.finished
          ? "Stopped"
          : "Starting…";

  return (
    <div className="absolute inset-0 z-10 flex flex-col overflow-y-auto bg-[#282a36] font-mono text-[13px] text-[#f8f8f2]">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/10 bg-[#282a36] px-5 py-3">
        <span className="text-[14px] font-semibold">{run.name}</span>
        <span className={cn("text-[12px]", failed ? "text-[#ff5555]" : t.finished === "ok" ? "text-[#50fa7b]" : "text-[#bd93f9]")}>
          {status}
          {startedAt ? ` · ${clock(endedAt - startedAt)}` : ""}
        </span>
        <span className="flex-1" />
        {!t.finished && (
          <button
            onClick={() => tab.session.send("\x03")}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-white/15 px-2.5 text-[12px] text-[#b6b8c8] hover:bg-white/10 hover:text-[#f8f8f2]"
            title="Ctrl+C: stop the running step (later steps don't run)"
          >
            <Square className="size-3" /> Stop
          </button>
        )}
        <button
          onClick={() => setWorkflowView(tab, "output")}
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-white/15 px-2.5 text-[12px] text-[#b6b8c8] hover:bg-white/10 hover:text-[#f8f8f2]"
          title="The whole terminal output"
        >
          <TerminalSquare className="size-3.5" /> Output
        </button>
      </div>
      <ol className="flex flex-col gap-1 px-4 py-3">
        {t.steps.map((s, i) => {
          const n = i + 1;
          const showOut = open.has(n) || (s.status === "failed" && !open.has(-n));
          const waiting = t.waiting?.step === n ? t.waiting : null;
          const out = showOut || s.status === "running" ? t.output(n) : "";
          const tail = s.status === "running" && !showOut ? out.split("\n").filter(Boolean).pop() : undefined;
          return (
            <li key={n} className={cn("rounded-lg px-3 py-2", (s.status === "running" || s.status === "paused") && "bg-white/[0.04]", s.status === "failed" && "bg-[#ff5555]/[0.07]")}>
              <div className="flex items-center gap-3">
                <StepIcon state={s} />
                <span className="w-5 text-right text-[12px] text-[#6272a4]">{n}</span>
                <span className={cn("min-w-0 flex-1 truncate", s.status === "pending" || s.status === "skipped" ? "text-[#8a8ea8]" : "")}>
                  {run.titles[i]}
                </span>
                <span className="text-[11px] text-[#6272a4] uppercase">{s.status === "skipped" ? "skipped" : KIND[run.kinds[i] ?? ""]}</span>
                <span className="w-14 text-right text-[12px] text-[#b6b8c8]">
                  {s.startedAt ? clock((s.endedAt ?? Date.now()) - s.startedAt) : ""}
                </span>
                {(s.status === "done" || s.status === "failed") && (
                  <button
                    onClick={() => (s.status === "failed" ? toggle(showOut ? -n : n) : toggle(n))}
                    className="cursor-pointer text-[#6272a4] hover:text-[#f8f8f2]"
                    title={showOut ? "Hide output" : "Show output"}
                  >
                    {showOut ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </button>
                )}
              </div>
              {tail && !waiting && run.kinds[i] !== "parallel" && run.kinds[i] !== "watch" && (
                <div className="mt-1 ml-[52px] truncate text-[12px] text-[#8a8ea8]">{tail}</div>
              )}
              {run.kinds[i] === "parallel" && run.branches?.[n] && <Branches ids={run.branches[n]!} />}
              {run.kinds[i] === "watch" && run.watches?.[n] && <WatchRow id={run.watches[n]!.tab} keep={run.watches[n]!.keep} />}
              {s.status === "failed" && (
                <div className="mt-1.5 ml-[52px] flex items-center gap-2 text-[12px]">
                  <span className="text-[#ff5555]">exit {s.code ?? "?"}</span>
                  <button
                    onClick={() => useWorkflows.getState().run(run.id, n)}
                    className="h-6 cursor-pointer rounded-md bg-[#bd93f9] px-2.5 font-medium text-[#282a36] hover:bg-[#cfaefc]"
                  >
                    Run from here
                  </button>
                </div>
              )}
              {s.status === "paused" && (
                <div className="mt-2 ml-[52px] flex items-center gap-2">
                  <button
                    onClick={() => tab.session.send("\r")}
                    className="h-7 cursor-pointer rounded-md bg-[#50fa7b] px-3 text-[12px] font-medium text-[#282a36] hover:brightness-110"
                  >
                    Continue
                  </button>
                  <button
                    onClick={() => tab.session.send("\x03")}
                    className="h-7 cursor-pointer rounded-md border border-white/15 px-3 text-[12px] text-[#b6b8c8] hover:bg-white/10"
                  >
                    Stop here
                  </button>
                </div>
              )}
              {waiting && s.status === "running" && <Answer tab={tab} text={waiting.text} secret={waiting.secret} yesNo={waiting.yesNo} />}
              {showOut && out && (
                <pre className="selectable mt-2 ml-[52px] max-h-[320px] overflow-auto rounded-md bg-black/25 px-3 py-2 text-[12px] leading-[17px] whitespace-pre-wrap text-[#e2e2dc]">
                  {out}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function StepIcon({ state }: { state: StepState }) {
  switch (state.status) {
    case "running":
      return <Spinner size={11} />;
    case "paused":
      return <Pause className="size-4 text-[#f1fa8c]" />;
    case "done":
      return <Check className="size-4 text-[#50fa7b]" strokeWidth={2.5} />;
    case "failed":
      return <X className="size-4 text-[#ff5555]" strokeWidth={2.5} />;
    case "skipped":
      return <span className="w-4 text-center text-[#6272a4]">–</span>;
    default:
      return <Circle className="size-3.5 text-[#6272a4]" />;
  }
}

/** The step's question, with a box to answer it (typed into the terminal
 *  with ↵). Passwords: hidden, or Fill from the vault. Yes/no: buttons. */
function Answer({ tab, text, secret, yesNo }: { tab: Tab; text: string; secret: boolean; yesNo: boolean }) {
  const [value, setValue] = useState("");
  const entries = useVault((s) => s.entries);
  const loaded = useVault((s) => s.loaded);
  useEffect(() => {
    if (secret && !loaded) void useVault.getState().load();
  }, [secret, loaded]);
  const prompt = secret ? passwordPromptIn(text) : null;
  const best = prompt ? suggested(entries, tab, prompt)[0] : undefined;
  const send = (v: string) => {
    tab.session.send(`${v}\r`);
    setValue("");
  };
  const btn = "h-7 cursor-pointer rounded-md px-3 text-[12px]";
  return (
    <div className="mt-2 ml-[52px] flex flex-col gap-2 rounded-md border border-[#f1fa8c]/30 bg-[#f1fa8c]/[0.06] px-3 py-2">
      <div className="text-[12px] text-[#f1fa8c]">{text}</div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(value);
        }}
      >
        {yesNo && (
          <>
            <button type="button" onClick={() => send("yes")} className={`${btn} bg-[#50fa7b] font-medium text-[#282a36]`}>
              yes
            </button>
            <button type="button" onClick={() => send("no")} className={`${btn} border border-white/20 text-[#f8f8f2] hover:bg-white/10`}>
              no
            </button>
          </>
        )}
        <input
          autoFocus
          type={secret ? "password" : "text"}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          placeholder={secret ? "password" : yesNo ? "or type an answer" : "answer"}
          className="h-7 min-w-0 flex-1 rounded-md border border-white/15 bg-black/30 px-2 text-[12.5px] text-[#f8f8f2] outline-none placeholder:text-[#6272a4] focus:border-[#bd93f9]"
        />
        <button type="submit" className={`${btn} border border-white/20 text-[#f8f8f2] hover:bg-white/10`}>
          Send ↵
        </button>
        {secret && best && (
          <button
            type="button"
            onClick={() => void fillPassword(tab, best)}
            className={`${btn} flex items-center gap-1.5 bg-[#bd93f9] font-medium text-[#282a36] hover:bg-[#cfaefc]`}
            title={`Type “${best.name}” and press ↵`}
          >
            <KeyRound className="size-3.5" /> Fill {best.name}
          </button>
        )}
      </form>
    </div>
  );
}

/** A parallel step's panes: each branch's state; click to go to it. */
function Branches({ ids }: { ids: string[] }) {
  const tabs = useTabs((s) => s.tabs);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  // Their trackers (waiting for an answer) live outside the store.
  useEffect(() => {
    const offs = ids.map((id) => tabs.find((t) => t.id === id)?.workflow?.tracker.subscribe(rerender));
    return () => offs.forEach((off) => off?.());
  }, [ids, tabs]);
  return (
    <ol className="mt-1.5 ml-[52px] flex flex-col gap-0.5">
      {ids.map((id) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) return null;
        const waiting = t.workflow?.tracker.waiting;
        return (
          <li key={id}>
            <button
              onClick={() => useTabs.getState().activate(id)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 text-left text-[12.5px] hover:bg-white/[0.05]"
              title="Go to its pane"
            >
              {t.state === "running" ? (
                <Spinner size={9} />
              ) : t.state === "failed" ? (
                <X className="size-3.5 text-[#ff5555]" strokeWidth={2.5} />
              ) : (
                <Check className="size-3.5 text-[#50fa7b]" strokeWidth={2.5} />
              )}
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {waiting && <span className="text-[11.5px] text-[#f1fa8c]">needs an answer ›</span>}
              {t.state === "failed" && <span className="text-[11.5px] text-[#ff5555]">exit {t.exitCode ?? "?"}</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A watch step's pane: show it, or stop it. */
function WatchRow({ id, keep }: { id: string; keep: boolean }) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === id));
  if (!tab) return <div className="mt-1 ml-[52px] text-[12px] text-[#8a8ea8]">its pane was closed</div>;
  const running = tab.state === "running";
  const btn = "h-6 cursor-pointer rounded-md border border-white/15 px-2.5 text-[12px] text-[#b6b8c8] hover:bg-white/10 hover:text-[#f8f8f2]";
  return (
    <div className="mt-1.5 ml-[52px] flex items-center gap-2 text-[12px] text-[#8a8ea8]">
      <span className="flex-1">
        {running ? `watching in a pane below${keep ? " (stays after the run)" : " until the run ends"}` : "stopped"}
      </span>
      <button className={btn} onClick={() => useTabs.getState().activate(id)}>
        Show
      </button>
      {running && tab.session.ptyId !== null && (
        <button className={btn} onClick={() => void killPty(tab.session.ptyId!).catch(() => {})}>
          Stop
        </button>
      )}
    </div>
  );
}
