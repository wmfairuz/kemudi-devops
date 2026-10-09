import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import type { PasswordPrompt } from "@/lib/terminalSession";
import { openDetails } from "@/stores/manage";
import type { Tab } from "@/stores/tabs";
import { useUi } from "@/stores/ui";
import { fillPassword, suggested, useVault } from "@/stores/vault";

/** At a password prompt in any tab: Fill with the best-matching saved
 *  password, or pick another (⌘⇧P). Never fills on its own. */
export function PasswordChip({ tab }: { tab: Tab }) {
  const [prompt, setPrompt] = useState<PasswordPrompt>(tab.session.passwordPrompt);
  useEffect(() => tab.session.onPasswordPrompt(setPrompt), [tab.session]);
  const entries = useVault((s) => s.entries);
  const loaded = useVault((s) => s.loaded);
  useEffect(() => {
    if (prompt && !loaded) void useVault.getState().load();
  }, [prompt, loaded]);

  if (!prompt) return null;
  const best = suggested(entries, tab, prompt)[0];
  const btn = "h-6 cursor-pointer rounded-md px-2.5";
  return (
    <div className="absolute right-4 bottom-3 z-10 flex items-center gap-2 rounded-lg border border-white/15 bg-[#343746] py-1 pr-1 pl-2.5 text-[12px] text-[#f8f8f2] shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
      <KeyRound className="size-3.5 text-[#f1fa8c]" />
      {entries.length === 0 ? (
        <>
          <span className="text-[#b6b8c8]">No saved passwords</span>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => useUi.getState().setOverlay("passwords")}
            className={`${btn} border border-white/20 hover:bg-white/10`}
          >
            Add one…
          </button>
        </>
      ) : (
        <>
          {best && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void fillPassword(tab, best)}
              className={`${btn} bg-[#bd93f9] font-medium text-[#282a36] hover:bg-[#cfaefc]`}
              title={`Type “${best.name}” and press ↵`}
            >
              Fill {best.name}
            </button>
          )}
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => useVault.getState().openPicker(tab)}
            className={`${btn} ${best ? "border border-white/20 hover:bg-white/10" : "bg-[#bd93f9] font-medium text-[#282a36] hover:bg-[#cfaefc]"}`}
          >
            {best ? "Other…" : "Fill…"} <span className="opacity-60">⌘⇧P</span>
          </button>
        </>
      )}
      {prompt.kind === "login" && tab.serverId && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openDetails({ kind: "server", serverId: tab.serverId ?? null })}
          className="h-6 cursor-pointer rounded-md px-2 text-[#b6b8c8] hover:bg-white/10 hover:text-[#f8f8f2]"
          title="Install your SSH key on this server so it stops asking"
        >
          Use a key instead
        </button>
      )}
    </div>
  );
}
