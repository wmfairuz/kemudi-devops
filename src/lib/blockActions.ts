// Copy command / output for a block (context menu and ⇧⌘C / ⌥⇧⌘C).
import { copyText } from "@/lib/clipboard";
import type { TerminalSession } from "@/lib/terminalSession";
import { useToasts } from "@/stores/toasts";

const info = (m: string) => useToasts.getState().push(m, "info");

function lineCount(s: string) {
  return s ? s.split("\n").length : 0;
}

export async function copyCommand(session: TerminalSession, block = session.blocks.last()) {
  const cmd = block ? session.blocks.command(block) : "";
  if (!cmd) return info("No command here to copy");
  if (await copyText(cmd)) info(`Copied command: ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}`);
}

export async function copyOutput(session: TerminalSession, block = session.blocks.last()) {
  const out = block ? session.blocks.output(block) : "";
  if (!block) return info("No command output here to copy");
  if (await copyText(out)) info(out ? `Copied output · ${lineCount(out)} lines` : "Copied (the command printed nothing)");
}

export async function copyBoth(session: TerminalSession, block = session.blocks.last()) {
  if (!block) return info("No command here to copy");
  const cmd = session.blocks.command(block);
  const out = session.blocks.output(block);
  if (await copyText(`$ ${cmd}\n${out}`)) info(`Copied command and output · ${lineCount(out)} lines`);
}
