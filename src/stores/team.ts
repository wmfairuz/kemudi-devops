// The team in front (like DigitalOcean's team switcher): the sidebar, Home,
// ⌘K and the Snippets list show its servers / snippets. "all" shows every
// team; "none" the servers that have no team. Kept per Mac.
import { create } from "zustand";

import type { Server, Team } from "@/lib/ipc";
import { useConfig } from "@/stores/config";

const KEY = "kemudi.team";

export type TeamPick = string | "all" | "none";

function stored(): TeamPick {
  try {
    return localStorage.getItem(KEY) || "all";
  } catch {
    return "all";
  }
}

export const useTeam = create<{ current: TeamPick; set(t: TeamPick): void }>((set) => ({
  current: stored(),
  set: (current) => {
    try {
      localStorage.setItem(KEY, current);
    } catch {
      // Not kept; fine.
    }
    set({ current });
  },
}));

/** Is this server in the team in front? (A team that no longer exists shows all.) */
export function inTeam(server: Pick<Server, "team">, current: TeamPick, teams: Team[]): boolean {
  if (current === "all") return true;
  if (current === "none") return !server.team;
  if (!teams.some((t) => t.id === current)) return true;
  return server.team === current;
}

const NONE: Server[] = [];
const NO_TEAMS: Team[] = [];

/** The servers of the team in front. */
export function useTeamServers(): Server[] {
  const servers = useConfig((s) => s.snapshot?.config?.servers ?? NONE);
  const teams = useConfig((s) => s.snapshot?.config?.teams ?? NO_TEAMS);
  const current = useTeam((s) => s.current);
  return current === "all" ? servers : servers.filter((s) => inTeam(s, current, teams));
}

/** The team itself, when one is picked. */
export function useCurrentTeam(): Team | null {
  const teams = useConfig((s) => s.snapshot?.config?.teams ?? NO_TEAMS);
  const current = useTeam((s) => s.current);
  return teams.find((t) => t.id === current) ?? null;
}

/** Shown in the team in front: every-team snippets, and its own. */
export function snippetVisible(s: { team?: string | null }, current: TeamPick): boolean {
  return current === "all" || !s.team || s.team === current;
}

/** "Northwind" → "NO", "Blue Sky" → "BS". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  const s = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  return s.toUpperCase();
}

// Dev only: a hot-swapped store would be a second, empty copy; reload instead.
import.meta.hot?.accept(() => window.location.reload());
