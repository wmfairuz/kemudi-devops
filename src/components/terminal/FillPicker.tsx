import { Command } from "cmdk";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import { Kbd } from "@/components/kit/Kbd";
import { Modal } from "@/components/kit/Modal";
import type { VaultEntry } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { fillPassword, suggested, useVault } from "@/stores/vault";

/** ⌘⇧P / the chip's "Fill…": pick a saved password to type into the tab.
 *  Without a password prompt in sight it asks again first, since a shell
 *  would show the password on screen. */
export function FillPicker() {
  const tab = useVault((s) => s.picker);
  const entries = useVault((s) => s.entries);
  const loaded = useVault((s) => s.loaded);
  const [query, setQuery] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    setQuery("");
    setArmed(null);
  }, [tab]);
  if (!tab) return null;

  const prompt = tab.session.passwordPrompt;
  const close = () => useVault.getState().closePicker();
  const top = suggested(entries, tab, prompt);
  const q = query.trim().toLowerCase();
  const match = (e: VaultEntry) => !q || `${e.name} ${e.username} ${e.notes}`.toLowerCase().includes(q);
  const rest = entries.filter((e) => !top.includes(e));
  const pick = (e: VaultEntry) => {
    if (!prompt && armed !== e.id) return setArmed(e.id);
    close();
    void fillPassword(tab, e);
  };
  const row = (e: VaultEntry) => (
    <Command.Item
      key={e.id}
      value={e.id}
      onSelect={() => pick(e)}
      className="flex min-h-[34px] items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-[13px] text-muted-foreground data-[selected=true]:bg-selected"
    >
      <KeyRound className="size-3.5 flex-none text-subtle-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">{e.name}</span>
      {e.username && <span className="truncate font-mono text-[11px] text-subtle-foreground">{e.username}</span>}
      {armed === e.id && <span className="text-[11px] text-env-prod-fg">↵ again to type it anyway</span>}
    </Command.Item>
  );

  return (
    <Modal open onOpenChange={(o) => !o && close()} title="Fill a password" width={520} top>
      <Command loop shouldFilter={false} label="Fill a password">
        <div className="flex h-[48px] items-center gap-2.5 border-b border-border pr-3.5 pl-4">
          <KeyRound className="size-4 text-subtle-foreground" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Fill which password?"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-subtle-foreground"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className={cn("border-b border-divider px-4 py-1.5 text-[11.5px]", prompt ? "text-subtle-foreground" : "text-env-prod-fg")}>
          {prompt
            ? `Into ${tab.title}, at its ${prompt.kind === "sudo" ? "sudo" : prompt.kind === "login" ? `ssh login (${prompt.user}@${prompt.host})` : "password"} prompt.`
            : `No password prompt in ${tab.title} right now: typed into a shell, a password shows on screen and in history.`}
        </div>
        <Command.List className="max-h-[360px] overflow-y-auto p-1.5">
          {loaded && entries.length === 0 && (
            <div className="px-2.5 py-5 text-center text-[12.5px] text-subtle-foreground">
              No saved passwords yet.{" "}
              <button
                className="cursor-pointer text-primary hover:underline"
                onClick={() => {
                  close();
                  useUi.getState().setOverlay("passwords");
                }}
              >
                Add one…
              </button>
            </div>
          )}
          <Command.Empty className="px-2.5 py-5 text-center text-[12.5px] text-subtle-foreground">Nothing matches “{query}”.</Command.Empty>
          {top.filter(match).length > 0 && (
            <Command.Group heading="Suggested" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-subtle-foreground">
              {top.filter(match).map(row)}
            </Command.Group>
          )}
          {rest.filter(match).length > 0 && (
            <Command.Group heading={top.length ? "All" : undefined} className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-subtle-foreground">
              {rest.filter(match).map(row)}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </Modal>
  );
}
