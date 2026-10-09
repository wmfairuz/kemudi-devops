import { Command } from "cmdk";
import { useEffect, useState } from "react";

import { Kbd } from "@/components/kit/Kbd";
import { Modal } from "@/components/kit/Modal";
import { SearchIcon } from "@/components/sidebar/SidebarFrame";
import { sshHosts } from "@/lib/ipc";
import { openSsh } from "@/stores/tabs";
import { useUi } from "@/stores/ui";

const HOST_RE = /^[A-Za-z0-9._@:-]+$/;

export function isValidHost(h: string): boolean {
  return h.length > 0 && h.length <= 255 && !h.startsWith("-") && HOST_RE.test(h);
}

/** ⇧⌘T: open an ssh tab to any alias from ~/.ssh/config (or typed). */
export function SshDialog() {
  const open = useUi((s) => s.overlay === "ssh");
  const setOverlay = useUi((s) => s.setOverlay);
  const [hosts, setHosts] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    sshHosts().then(setHosts, () => setHosts([]));
  }, [open]);

  const connect = (host: string) => {
    setOverlay("none");
    openSsh(host);
  };
  const typed = query.trim();
  const showTyped = isValidHost(typed) && !hosts.includes(typed);

  return (
    <Modal open={open} onOpenChange={(o) => setOverlay(o ? "ssh" : "none")} title="SSH to host" width={640} top>
      <Command loop className="flex flex-col" label="SSH to host">
        <div className="flex h-[50px] items-center gap-2.5 border-b border-border pr-3.5 pl-4">
          <SearchIcon size={15} className="text-subtle-foreground" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="SSH to host alias…"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-subtle-foreground"
          />
          <Kbd>esc</Kbd>
        </div>
        <Command.List className="max-h-[360px] overflow-y-auto p-1.5">
          <Command.Empty className="px-2.5 py-6 text-center text-[12.5px] text-subtle-foreground">
            No matching hosts. Type a full alias or user@host.
          </Command.Empty>
          {showTyped && (
            <Command.Item value={`typed:${typed}`} onSelect={() => connect(typed)} className={itemClass}>
              <span className="flex-1 text-[13px] text-muted-foreground">
                ssh <span className="font-medium text-foreground">{typed}</span>
              </span>
            </Command.Item>
          )}
          {hosts.length > 0 && (
            <Command.Group
              heading="~/.ssh/config"
              className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle-foreground"
            >
              {hosts.map((h) => (
                <Command.Item key={h} value={h} onSelect={() => connect(h)} className={itemClass}>
                  <span className="flex-1 truncate text-[13px] font-medium text-foreground">{h}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
        <div className="flex h-9 items-center gap-4 border-t border-border bg-dialog-footer px-4 text-[11.5px] text-subtle-foreground">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">↑↓</span>Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">↵</span>Connect in new tab
          </span>
        </div>
      </Command>
    </Modal>
  );
}

const itemClass =
  "flex h-[34px] items-center gap-2.5 rounded-[7px] px-2.5 data-[selected=true]:bg-selected";
