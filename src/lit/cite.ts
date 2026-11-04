import { isVerified, type Candidate } from "./candidates.ts";

/** Keys cited as `[@key]` or `[see @a, p. 3; @b]` (Pandoc style). */
export function citationOccurrences(text: string): { key: string; start: number; end: number; groupStart: number; groupEnd: number }[] {
  const result: { key: string; start: number; end: number; groupStart: number; groupEnd: number }[] = [];
  for (const group of text.matchAll(/\[([^\[\]]*?@[^\[\]]*?)\]/g)) {
    for (const match of group[1]!.matchAll(/(?:^|[\s;,(-])@([A-Za-z0-9_](?:[A-Za-z0-9_:.#$%&+?<>~/-]*[A-Za-z0-9_])?)/g)) {
      const start = group.index + 1 + match.index + match[0].indexOf("@");
      result.push({ key: match[1]!, start, end: start + match[1]!.length + 1, groupStart: group.index, groupEnd: group.index + group[0].length });
    }
  }
  return result;
}
export function citedKeys(text: string): { count: number; keys: string[] } {
  const occurrences = citationOccurrences(text);
  return { count: occurrences.length, keys: [...new Set(occurrences.map(hit => hit.key))] };
}

export interface CiteReport { ok: boolean; citations: number; keys: string[]; unknown: string[]; notVerified: string[] }
export function checkCitations(text: string, list: Candidate[]): CiteReport {
  const { count, keys } = citedKeys(text);
  const byKey = new Map(list.filter(c => c.citekey).map(c => [c.citekey!, c]));
  const unknown = keys.filter(k => !byKey.has(k));
  const notVerified = keys.filter(k => { const c = byKey.get(k); return !!c && !(c.status === "included" && isVerified(c)); });
  return { ok: !unknown.length && !notVerified.length, citations: count, keys, unknown, notVerified };
}
