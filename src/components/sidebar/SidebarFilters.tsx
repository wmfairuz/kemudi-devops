import { ChipGroup, FilterChip } from "@/components/kit/Filters";
import type { Server } from "@/lib/ipc";
import { ENV_LABEL, envsOf, NO_FACETS, useFacetTest, type ServerFacets } from "@/lib/serverFacets";
import { useSidebar } from "@/stores/sidebar";

/** Chips under the filter box: environment, Urgent / Attention (as in Home ▸
 *  Needs attention) and Unreachable, each with how many servers it'd show.
 *  Clear is in the Servers heading under them. */
export function SidebarFilters({ servers }: { servers: Server[] }) {
  const f = useSidebar((s) => s.facets);
  const set = useSidebar((s) => s.setFacets);
  const test = useFacetTest();
  if (servers.length < 2) return null;
  const count = (g: Partial<ServerFacets>) => servers.filter((s) => test(s, { ...NO_FACETS, ...g })).length;
  const envs = envsOf(servers);
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-1.5">
      {envs.length > 1 && (
        <ChipGroup sm>
          {envs.map((e) => (
            <FilterChip sm key={e} label={ENV_LABEL[e]} on={f.env === e} n={count({ env: e })} onClick={() => set({ env: f.env === e ? null : e })} />
          ))}
        </ChipGroup>
      )}
      <ChipGroup sm>
        <FilterChip sm label="Urgent" on={f.attention === "urgent"} n={count({ attention: "urgent" })} onClick={() => set({ attention: f.attention === "urgent" ? null : "urgent" })} title="Servers with something urgent in Home ▸ Needs attention" />
        <FilterChip sm label="Attention" on={f.attention === "any"} n={count({ attention: "any" })} onClick={() => set({ attention: f.attention === "any" ? null : "any" })} title="Servers with anything urgent or soon in Home ▸ Needs attention (not snoozed)" />
        <FilterChip sm label="Unreachable" on={f.down} n={count({ down: true })} onClick={() => set({ down: !f.down })} title="Servers that don't answer the reachability probe (VPN off?)" />
      </ChipGroup>
    </div>
  );
}
