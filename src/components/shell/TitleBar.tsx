import { PanelRight } from "lucide-react";

import { LogoMark } from "@/components/kit/Logo";
import { useUi } from "@/stores/ui";

/** 38px title bar drawn under the native traffic lights (overlay style). */
export function TitleBar({ title }: { title: string }) {
  const panel = useUi((s) => s.actionsPanel);
  return (
    <div
      data-tauri-drag-region
      className="relative flex h-[38px] flex-none items-center border-b border-border bg-titlebar"
    >
      <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-2 px-24 text-[13px] font-semibold text-muted-foreground">
        <LogoMark className="h-[13px]" />
        <span className="truncate">{title}</span>
      </div>
      {!panel && (
        <button
          title="Show actions (⌘J)"
          aria-label="Show actions"
          onClick={() => useUi.getState().toggleActionsPanel()}
          className="absolute right-2 flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-subtle-foreground hover:bg-hover-strong hover:text-foreground"
        >
          <PanelRight className="size-4" strokeWidth={1.75} />
          Actions
        </button>
      )}
    </div>
  );
}
