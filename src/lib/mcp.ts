// Claude (over MCP, see mcp.rs) asks the window to run a workflow or report
// on a run. Runs start like any other: in the Workflows tab, where you can
// watch, answer and stop them; one that touches production opens the run
// dialog and waits for you (Run, or Cancel: Claude is told no).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { notify } from "@/lib/notify";
import { runWorkflow } from "@/lib/workflows";
import { useConfig } from "@/stores/config";
import { useTabs, type Tab } from "@/stores/tabs";
import { useWorkflows } from "@/stores/workflows";

const reply = (id: number, text: string, isError = false) => invoke("mcp_reply", { id, text, isError }).catch(() => {});

/** Colours, cursor moves and other escapes out of terminal text. */
const plain = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "");

const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** The last `n` non-empty lines of `s`. */
const tail = (s: string, n: number) => {
  const lines = s.split("\n").filter((l) => l.trim());
  return (lines.length > n ? [`… (${lines.length - n} lines above)`] : []).concat(lines.slice(-n)).join("\n");
};

/** A run as Claude reads it: where it is, each step, their output. */
function summary(tab: Tab): string {
  const run = tab.workflow!;
  const t = run.tracker;
  const ran = t.steps.filter((s) => s.startedAt);
  const startedAt = ran[0]?.startedAt;
  const endedAt = t.finished ? Math.max(...ran.map((s) => s.endedAt ?? 0)) : Date.now();
  const failed = t.steps.findIndex((s) => s.status === "failed") + 1;
  const status =
    tab.state === "running"
      ? `still running${t.current ? `: step ${t.current} of ${t.steps.length}` : ""}${t.waiting ? ` (waiting for an answer in Kemudi: ${plain(t.waiting.text).trim()})` : ""}`
      : failed
        ? `✗ stopped at step ${failed} (exit ${t.steps[failed - 1]?.code ?? "?"})`
        : t.finished === "ok" || tab.state === "ok"
          ? "✓ succeeded"
          : `ended (exit ${tab.exitCode ?? "?"})`;
  const out = [`${run.name}${run.from > 1 ? ` (from step ${run.from})` : ""} · run ${tab.id}: ${status}${startedAt ? ` · ${took(endedAt - startedAt)}` : ""}`, ""];
  let budget = 12_000;
  t.steps.forEach((s, i) => {
    const n = i + 1;
    const mark = { done: "✓", failed: "✗", running: "…", paused: "‖", skipped: "–", pending: "·" }[s.status] ?? "·";
    const time = s.startedAt ? ` (${took((s.endedAt ?? Date.now()) - s.startedAt)})` : "";
    out.push(`${mark} ${n}. ${run.titles[i] ?? ""}${s.status === "failed" ? ` — exit ${s.code ?? "?"}` : ""}${s.status === "skipped" ? " — skipped" : ""}${time}`);
    if (s.status === "done" || s.status === "failed" || s.status === "running") {
      const text = tail(plain(t.output(n)), s.status === "failed" ? 60 : 25);
      if (text && budget > 0) {
        const piece = text.slice(-Math.min(budget, 4000));
        budget -= piece.length;
        out.push(piece.replace(/^/gm, "    "));
      }
    }
  });
  if (tab.state === "running") out.push("", `Still running in Kemudi. Follow it with get_run (run_id: "${tab.id}").`);
  else if (failed) out.push("", `To re-run from the failed step: run_workflow with from_step: ${failed}.`);
  return out.join("\n");
}

/** Resolve when tab `id` stops running (or is closed), or after `ms`. */
function settle(id: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const check = (s = useTabs.getState()) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab || tab.state !== "running") done();
    };
    const timer = setTimeout(done, ms);
    const off = useTabs.subscribe((s) => check(s));
    check();
  });
}

async function report(id: number, tabId: string, waitMs: number) {
  await settle(tabId, waitMs);
  // The exit can arrive a moment before the terminal has read the last
  // output (the failing step's own code is in it).
  await new Promise((r) => setTimeout(r, 600));
  const tab = useTabs.getState().tabs.find((t) => t.id === tabId);
  if (!tab?.workflow) return void reply(id, `Run ${tabId}'s tab was closed in Kemudi; its record is in History (recent_runs).`, true);
  void reply(id, summary(tab), tab.state !== "running" && tab.state !== "ok");
}

async function runRequested(p: { id: number; workflowId: string; from: number; waitMs: number; prod: boolean }) {
  const wf = useConfig.getState().snapshot?.config?.workflows.find((w) => w.id === p.workflowId);
  if (!wf) return void reply(p.id, `No workflow ${p.workflowId}.`, true);
  if (!p.prod) {
    const tabId = runWorkflow(wf, p.from);
    return void report(p.id, tabId, p.waitMs);
  }
  // Production: the run dialog (type the name, Run), as when you click it.
  void notify(`Claude wants to run ${wf.name}`, "It touches production: confirm or cancel it in Kemudi.");
  useWorkflows.getState().run(wf.id, p.from, {
    by: "Claude",
    start: (tabId) => void report(p.id, tabId, p.waitMs),
    cancel: () => void reply(p.id, `The user didn't run ${wf.name} (it touches production; they cancelled it in Kemudi).`, true),
  });
}

async function getRun(p: { id: number; runId: string; waitMs: number }) {
  const tab = useTabs.getState().tabs.find((t) => t.id === p.runId && t.workflow && !t.workflow.part);
  if (!tab) return void reply(p.id, `No run ${p.runId} open in Kemudi now (closed, or from before Kemudi restarted). recent_runs lists History.`, true);
  await report(p.id, tab.id, p.waitMs);
}

let started = false;

/** Listen for Claude's requests (once, for the app's lifetime). */
export function initMcp() {
  if (started) return;
  started = true;
  void listen<{ id: number; workflowId: string; from: number; waitMs: number; prod: boolean }>("mcp://run-workflow", (e) => void runRequested(e.payload));
  void listen<{ id: number; runId: string; waitMs: number }>("mcp://get-run", (e) => void getRun(e.payload));
}
