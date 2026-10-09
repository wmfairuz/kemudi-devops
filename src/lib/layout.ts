// Pane layouts: a binary tree of splits whose leaves are pane (tab) ids.
// Pure functions, so the store and the tests share them.

export type Dir = "row" | "col"; // row: side by side (split right); col: stacked (split down)

export type Layout = { pane: string } | { id: string; dir: Dir; ratio: number; a: Layout; b: Layout };

let nextSplit = 1;

export function leaves(l: Layout): string[] {
  return "pane" in l ? [l.pane] : [...leaves(l.a), ...leaves(l.b)];
}

/** Replace leaf `target` with a split of it and `added` (added second). */
export function split(l: Layout, target: string, added: string, dir: Dir): Layout {
  if ("pane" in l) {
    return l.pane === target ? { id: `s${nextSplit++}`, dir, ratio: 0.5, a: l, b: { pane: added } } : l;
  }
  return { ...l, a: split(l.a, target, added, dir), b: split(l.b, target, added, dir) };
}

/** Remove a leaf; its sibling takes the parent split's place. Null when it
 *  was the only pane. */
export function remove(l: Layout, target: string): Layout | null {
  if ("pane" in l) return l.pane === target ? null : l;
  const a = remove(l.a, target);
  const b = remove(l.b, target);
  if (!a) return b;
  if (!b) return a;
  return a === l.a && b === l.b ? l : { ...l, a, b };
}

export function setRatio(l: Layout, splitId: string, ratio: number): Layout {
  if ("pane" in l) return l;
  if (l.id === splitId) return { ...l, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
  return { ...l, a: setRatio(l.a, splitId, ratio), b: setRatio(l.b, splitId, ratio) };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Each pane's rectangle in a unit square. */
export function rects(l: Layout, r: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if ("pane" in l) {
    out.set(l.pane, r);
    return out;
  }
  if (l.dir === "row") {
    const w = r.w * l.ratio;
    rects(l.a, { ...r, w }, out);
    rects(l.b, { ...r, x: r.x + w, w: r.w - w }, out);
  } else {
    const h = r.h * l.ratio;
    rects(l.a, { ...r, h }, out);
    rects(l.b, { ...r, y: r.y + h, h: r.h - h }, out);
  }
  return out;
}

export type Side = "left" | "right" | "up" | "down";

/** The pane next to `from` on that side (overlapping it, nearest first). */
export function neighbour(l: Layout, from: string, side: Side): string | null {
  const all = rects(l);
  const r = all.get(from);
  if (!r) return null;
  const eps = 1e-6;
  let best: { id: string; dist: number } | null = null;
  for (const [id, o] of all) {
    if (id === from) continue;
    const overlapsV = o.y < r.y + r.h - eps && o.y + o.h > r.y + eps;
    const overlapsH = o.x < r.x + r.w - eps && o.x + o.w > r.x + eps;
    const dist =
      side === "left" && overlapsV && o.x + o.w <= r.x + eps
        ? r.x - (o.x + o.w)
        : side === "right" && overlapsV && o.x >= r.x + r.w - eps
          ? o.x - (r.x + r.w)
          : side === "up" && overlapsH && o.y + o.h <= r.y + eps
            ? r.y - (o.y + o.h)
            : side === "down" && overlapsH && o.y >= r.y + r.h - eps
              ? o.y - (r.y + r.h)
              : null;
    if (dist !== null && (!best || dist < best.dist)) best = { id, dist };
  }
  return best?.id ?? null;
}

/** For saving: leaves become indexes into a pane list. */
export type SavedLayout = { pane: number } | { dir: Dir; ratio: number; a: SavedLayout; b: SavedLayout };

export function save(l: Layout, index: (id: string) => number): SavedLayout {
  return "pane" in l ? { pane: index(l.pane) } : { dir: l.dir, ratio: l.ratio, a: save(l.a, index), b: save(l.b, index) };
}

export function load(s: SavedLayout, id: (index: number) => string | undefined): Layout | null {
  if ("pane" in s) {
    const p = id(s.pane);
    return p ? { pane: p } : null;
  }
  const a = load(s.a, id);
  const b = load(s.b, id);
  if (!a) return b;
  if (!b) return a;
  return { id: `s${nextSplit++}`, dir: s.dir, ratio: s.ratio, a, b };
}
