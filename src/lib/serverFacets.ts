// What Home and the sidebar filter servers by besides words: environment,
// what needs attention (Home ▸ Needs attention) and what doesn't answer.
import type { Env, Server } from "@/lib/ipc";
import { useStatus } from "@/stores/status";
import { useWatch } from "@/stores/watch";

export type ServerFacets = { env: Env | null; attention: "urgent" | "any" | null; down: boolean };
export const NO_FACETS: ServerFacets = { env: null, attention: null, down: false };
export const ENV_LABEL: Record<Env, string> = { prod: "Prod", staging: "Staging", qa: "QA", dev: "Dev" };
const ENVS: Env[] = ["prod", "staging", "qa", "dev"];

/** The environments these servers are in (in order). */
export const envsOf = (servers: Server[]) => ENVS.filter((e) => servers.some((s) => s.env === e));

export const facetsOn = (f: ServerFacets) => !!f.env || !!f.attention || f.down;

/** A test of a server against facets, from the latest checks and probes. */
export function useFacetTest(): (s: Server, f: ServerFacets) => boolean {
  const items = useWatch((x) => x.snapshot?.items);
  const status = useStatus((x) => x.byServer);
  const live = (items ?? []).filter((i) => !i.snoozedUntil && i.severity !== "info");
  return (s, f) => {
    if (f.env && s.env !== f.env) return false;
    if (f.down && status[s.id]?.state !== "down") return false;
    if (f.attention && !live.some((i) => i.serverId === s.id && (f.attention === "any" || i.severity === "urgent"))) return false;
    return true;
  };
}
