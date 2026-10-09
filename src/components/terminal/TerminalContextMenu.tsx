import { PopupMenu, type MenuItem } from "@/components/kit/PopupMenu";
import { copyBoth, copyCommand, copyOutput } from "@/lib/blockActions";
import type { Block } from "@/lib/blocks";
import { copyText, readText } from "@/lib/clipboard";
import type { TerminalSession } from "@/lib/terminalSession";
import { useSnippets } from "@/stores/snippets";
import { useToasts } from "@/stores/toasts";
import { useUi } from "@/stores/ui";

export interface MenuState {
  x: number;
  y: number;
  session: TerminalSession;
  block: Block | undefined;
}

/** Warp-style right-click menu for a terminal block. */
export function TerminalContextMenu({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const { session, block } = state;
  const groups: MenuItem[][] = [
    [
      {
        label: "Copy",
        hint: "⌘C",
        disabled: !session.term.hasSelection(),
        run: () => copyText(session.term.getSelection()),
      },
      { label: "Copy command", hint: "⇧⌘C", disabled: !block, run: () => copyCommand(session, block) },
      { label: "Copy output", hint: "⌥⇧⌘C", disabled: !block, run: () => copyOutput(session, block) },
      { label: "Copy command and output", disabled: !block, run: () => copyBoth(session, block) },
      {
        label: "Save command as snippet…",
        disabled: !block || !session.blocks.command(block),
        run: () => {
          const command = block ? session.blocks.command(block) : "";
          if (command) useSnippets.getState().setEditing({ id: null, command });
        },
      },
      {
        label: "Paste",
        hint: "⌘V",
        run: async () => {
          const text = await readText();
          if (text === null) useToasts.getState().push("Use ⌘V to paste", "info");
          else session.term.paste(text);
        },
      },
    ],
    [
      { label: "Select output", disabled: !block, run: () => block && session.blocks.selectOutput(block) },
      { label: "Scroll to top of block", disabled: !block, run: () => block && session.blocks.scrollTo(block) },
    ],
    [
      { label: "Find…", hint: "⌘F", run: () => useUi.getState().setSearchOpen(true) },
      { label: "Clear scrollback", run: () => session.term.clear() },
    ],
  ];
  return <PopupMenu x={state.x} y={state.y} groups={groups} onClose={onClose} afterRun={() => session.focus()} />;
}
