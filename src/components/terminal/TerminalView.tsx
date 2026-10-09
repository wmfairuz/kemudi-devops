import { useEffect, useRef } from "react";

import type { TerminalSession } from "@/lib/terminalSession";

interface Props {
  session: TerminalSession;
  active: boolean;
}

/** Hosts a TerminalSession's DOM. Hidden tabs stay mounted so scrollback and
 *  the running process are untouched; moving into a split re-attaches it. */
export function TerminalView({ session, active }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    session.attach(el);
    return () => session.detach();
  }, [session]);

  useEffect(() => {
    if (!active) return;
    // Wait a frame so the container is visible before measuring.
    const raf = requestAnimationFrame(() => {
      session.fitToContainer();
      session.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, session]);

  // Visibility is the tab's (TerminalPane); `active` means focused.
  return <div className="absolute inset-0 px-4 py-3" ref={ref} />;
}
