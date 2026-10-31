import { isVerified, type Candidate } from "./candidates.ts";

/** Keys cited as `[@key]` or `[see @a, p. 3; @b]` (Pandoc style). */
export function citedKeys(text: string): { count: number; keys: string[] } {
  const keys: string[] = [];
  let count = 0;
  for (const group of text.matchAll(/\[([^\[\]]*?@[^\[\]]*?)\]/g)) {
    for (const m of group[1]!.matchAll(/(?:^|[\s;,(-])@([A-Za-z0-9_](?:[A-Za-z0-9_:.#$%&+?<>~/-]*[A-Za-z0-9_])?)/g)) { count++; keys.push(m[1]!); }
  }
  return { count, keys: [...new Set(keys)] };
}

export interface CiteReport { ok: boolean; citations: number; keys: string[]; unknown: string[]; notVerified: string[] }
export function checkCitations(text: string, list: Candidate[]): CiteReport {
  const { count, keys } = citedKeys(text);
  const byKey = new Map(list.filter(c => c.citekey).map(c => [c.citekey!, c]));
  const unknown = keys.filter(k => !byKey.has(k));
  const notVerified = keys.filter(k => { const c = byKey.get(k); return !!c && !(c.status === "included" && isVerified(c)); });
  return { ok: !unknown.length && !notVerified.length, citations: count, keys, unknown, notVerified };
}
