import { useEffect, useRef, useState } from "react";

import { SearchIcon } from "@/components/sidebar/SidebarFrame";
import type { TerminalSession } from "@/lib/terminalSession";

const decorations = {
  // Dracula selection / orange.
  matchBackground: "#44475a",
  matchOverviewRuler: "#6272a4",
  activeMatchBackground: "#ffb86c",
  activeMatchColorOverviewRuler: "#ffb86c",
};

/** ⌘F find bar over the active terminal. Enter / ⇧Enter step, Esc closes. */
export function TerminalSearch({ session, onClose }: { session: TerminalSession; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState<{ index: number; total: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const sub = session.search.onDidChangeResults((r) =>
      setCount(r.resultCount > 0 ? { index: r.resultIndex + 1, total: r.resultCount } : null),
    );
    return () => {
      sub.dispose();
      session.search.clearDecorations();
    };
  }, [session]);

  const find = (value: string, back = false, incremental = false) => {
    if (!value) {
      session.search.clearDecorations();
      setCount(null);
      return;
    }
    const opts = { decorations, incremental };
    if (back) session.search.findPrevious(value, opts);
    else session.search.findNext(value, opts);
  };

  return (
    <div className="absolute top-2 right-3 z-20 flex h-8 w-[300px] items-center gap-2 rounded-lg border border-input bg-popover px-2 text-[12.5px] shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
      <SearchIcon className="text-subtle-foreground" />
      <input
        ref={input}
        value={query}
        spellCheck={false}
        placeholder="Find in terminal"
        onChange={(e) => {
          setQuery(e.target.value);
          find(e.target.value, false, true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") find(query, e.shiftKey);
          if (e.key === "Escape") {
            onClose();
            session.focus();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-subtle-foreground"
      />
      <span className="font-mono text-[10.5px] text-subtle-foreground">
        {query ? (count ? `${count.index}/${count.total}` : "0") : ""}
      </span>
    </div>
  );
}
