// ⌘K search: every query token must match some field of an item; better
// matches (whole field, word prefix) rank higher; prod sorts last on ties.

export interface Searchable {
  /** Fields the query can match, most important first. */
  fields: string[];
  prod?: boolean;
}

/** Common aliases so "stg" finds staging and "prod" finds production. */
export const ENV_WORDS: Record<string, string[]> = {
  prod: ["prod", "production"],
  staging: ["stg", "staging"],
  qa: ["qa", "test"],
  dev: ["dev", "development"],
};

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function fieldScore(field: string, token: string): number {
  const f = field.toLowerCase();
  if (f === token) return 4;
  if (f.startsWith(token)) return 3;
  // Prefix of a word inside the field: "pull" in "git pull", "svr" in "stg-svr03".
  if (f.split(/[\s\-_.:/@·]+/).some((w) => w.startsWith(token))) return 2;
  return f.includes(token) ? 1 : 0;
}

/** 0 = no match; otherwise higher is better. */
export function score(item: Searchable, tokens: string[]): number {
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    for (const [i, field] of item.fields.entries()) {
      // Earlier fields weigh slightly more.
      const s = fieldScore(field, t) * (1 + 0.1 * Math.max(0, 3 - i));
      if (s > best) best = s;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/** Filter + rank, keeping config order between equal scores, prod last. */
export function rank<T extends Searchable>(items: T[], tokens: string[], limit = Infinity): T[] {
  if (tokens.length === 0) return items.slice(0, limit);
  return items
    .map((item, index) => ({ item, index, s: score(item, tokens) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || Number(!!a.item.prod) - Number(!!b.item.prod) || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.item);
}

/** Split `text` into [segment, matched] pairs for highlighting tokens. */
export function highlight(text: string, tokens: string[]): [string, boolean][] {
  if (tokens.length === 0 || !text) return [[text, false]];
  const lower = text.toLowerCase();
  const marks = new Array<boolean>(text.length).fill(false);
  for (const t of tokens) {
    let i = lower.indexOf(t);
    while (i !== -1) {
      for (let k = i; k < i + t.length; k++) marks[k] = true;
      i = lower.indexOf(t, i + t.length);
    }
  }
  const out: [string, boolean][] = [];
  for (let i = 0; i < text.length; ) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    out.push([text.slice(i, j), marks[i] ?? false]);
    i = j;
  }
  return out;
}
