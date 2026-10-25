import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import type { PasswordPrompt } from "@/lib/terminalSession";
import { openDetails } from "@/stores/manage";
import type { Tab } from "@/stores/tabs";
import { useUi } from "@/stores/ui";
import { fillPassword, suggested, useVault } from "@/stores/vault";

/** At a password prompt in any tab: Fill with the best-matching saved
 *  password, or pick another (⌘⇧P). Never fills on its own. */
export function PasswordChip({ tab, below = false }: { tab: Tab; below?: boolean }) {
  const [prompt, setPrompt] = useState<PasswordPrompt>(tab.session.passwordPrompt);
  useEffect(() => tab.session.onPasswordPrompt(setPrompt), [tab.session]);
  const entries = useVault((s) => s.entries);
  const loaded = useVault((s) => s.loaded);
  useEffect(() => {
    if (prompt && !loaded) void useVault.getState().load();
  }, [prompt, loaded]);

  if (!prompt) return null;
  const best = suggested(entries, tab, prompt)[0];
  const btn = "h-8 cursor-pointer rounded-md px-3";
  const asking = prompt.kind === "sudo" ? "sudo wants your password" : prompt.kind === "login" ? `${prompt.user}@${prompt.host} wants a password` : "Password asked";
  // Top right (under the "◂ Workflows" button when there is one), with a
  // short glow when it appears: easy to miss down in the corner.
  return (
    <div
      className={`${below ? "top-12" : "top-3"} pw-chip absolute right-4 z-10 flex items-center gap-2.5 rounded-lg border border-[#f1fa8c]/60 bg-[#343746] py-1.5 pr-1.5 pl-3 text-[13px] text-[#f8f8f2] shadow-[0_8px_24px_rgba(0,0,0,0.45)]`}
    >
      <KeyRound className="size-4 shrink-0 text-[#f1fa8c]" />
      <span className="max-w-[260px] truncate font-medium text-[#f1fa8c]" title={asking}>
        {asking}
      </span>
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
          className="h-8 cursor-pointer rounded-md px-2.5 text-[#b6b8c8] hover:bg-white/10 hover:text-[#f8f8f2]"
          title="Install your SSH key on this server so it stops asking"
        >
          Use a key instead
        </button>
      )}
    </div>
  );
}
