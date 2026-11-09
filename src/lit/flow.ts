import { existsSync } from "node:fs";
import { candidatesPath, includedHash, isVerified, loadCandidates, type Candidate } from "./candidates.ts";
import { cardPath } from "./cards.ts";
import { readScope } from "../scope.ts";
import { gateState, openStudy, readLedger, type LedgerEvent } from "../study.ts";

/** Fields available as {{n:lit.flow.<field>}}; excluded.<code> is added per declared code plus "uncoded". */
export const FLOW_FIELDS = ["records", "duplicates", "unique", "screened", "excluded", "unscreened", "included", "verified", "cards"] as const;
export type FlowField = typeof FLOW_FIELDS[number];
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Derived only from the ledger, the candidate file, scope.json and card existence; no new state. */
export function flowFrom(dir: string, events: LedgerEvent[], candidates: Candidate[]) {
  const searches = events.filter(e => e.type === "lit.search"), scope = readScope(dir);
  const bySource: Record<string, { searches: number; ok: number; records: number }> = {};
  let records = 0, duplicates = 0, dropped = 0;
  const yearFrom = new Set<number>();
  for (const e of searches) {
    for (const s of Array.isArray(e.data.sources) ? e.data.sources as { source?: unknown; ok?: unknown; returned?: unknown }[] : []) {
      const name = typeof s.source === "string" ? s.source : "unknown", row = bySource[name] ??= { searches: 0, ok: 0, records: 0 };
      row.searches++; if (s.ok === true) row.ok++; row.records += count(s.returned); records += count(s.returned);
    }
    // A bridging record that folds an earlier candidate away removes one more duplicate than its single merge.
    duplicates += count(e.data.merged) + count(e.data.absorbed); dropped += count(e.data.dropped);
    if (typeof e.data.yearFrom === "number") yearFrom.add(e.data.yearFrom);
  }
  const included = candidates.filter(c => c.status === "included"), excluded = candidates.filter(c => c.status === "excluded");
  const codes = scope?.exclusionCodes ?? [];
  // Without declared codes every exclusion is one "uncoded" group; a code no longer declared still counts under its name.
  const excludedByCode: Record<string, number> = Object.fromEntries([...codes.map(c => [c.code, 0] as [string, number]), ["uncoded", 0]]);
  for (const c of excluded) { const key = c.exclusionCode ?? "uncoded"; excludedByCode[key] = (excludedByCode[key] ?? 0) + 1; }
  return {
    window: { firstSearch: searches[0]?.at ?? null, lastSearch: searches.at(-1)?.at ?? null, searches: searches.length, yearFrom: [...yearFrom].sort((a, b) => a - b), scopeYearFrom: scope?.yearFrom ?? null, scopeYearTo: scope?.yearTo ?? null },
    sources: bySource,
    records, duplicates, dropped, unique: candidates.length,
    screened: included.length + excluded.length, excluded: excluded.length, excludedByCode,
    exclusionCodes: codes, unscreened: candidates.length - included.length - excluded.length,
    included: included.length, verified: included.filter(isVerified).length,
    cards: included.filter(c => existsSync(cardPath(dir, c.id))).length,
  };
}
export type Flow = ReturnType<typeof flowFrom>;

/** The screen gate binds the included set; flow numbers are citable only while it is approved for the current set. */
export function screenApproved(events: LedgerEvent[], candidates: Candidate[]): boolean {
  return gateState("screen", events, gate => gate === "screen" ? includedHash(candidates) : undefined).state === "approved";
}

export function litFlow(dirArg: string) {
  const { dir } = openStudy(dirArg), events = readLedger(dir), candidates = loadCandidates(dir);
  return { ...flowFrom(dir, events, candidates), screenApproved: screenApproved(events, candidates) };
}

/** Value for a lit.flow.* ref, or undefined for an unknown field. */
export function flowValue(flow: Flow, field: string): number | undefined {
  if ((FLOW_FIELDS as readonly string[]).includes(field)) return flow[field as FlowField];
  const match = /^excluded\.([a-z][a-z0-9-]{0,31})$/.exec(field);
  return match && Object.hasOwn(flow.excludedByCode, match[1]!) ? flow.excludedByCode[match[1]!] : undefined;
}

/** A pasteable Markdown table whose every number is a {{n:lit.flow.*}} placeholder; labels hold no digits. */
export function flowMarkdown(dirArg: string): string {
  const { dir } = openStudy(dirArg), flow = flowFrom(dir, readLedger(dir), loadCandidates(dir));
  const n = (field: string) => `{{n:lit.flow.${field}}}`;
  const label = (text: string) => /\p{Nd}/u.test(text) ? `{{lit:${text}}}` : text;
  const rows: [string, string][] = [
    ["Records retrieved from all sources", n("records")],
    ["Duplicates merged", n("duplicates")],
    ["Unique records", n("unique")],
    ["Records screened", n("screened")],
    ["Records excluded", n("excluded")],
    ...flow.exclusionCodes.map(c => [`Excluded: ${label(c.label)}`, n(`excluded.${c.code}`)] as [string, string]),
    ...(flow.exclusionCodes.length && flow.excludedByCode.uncoded ? [["Excluded without a code", n("excluded.uncoded")] as [string, string]] : []),
    ["Records not yet screened", n("unscreened")],
    ["Studies included", n("included")],
    ["Included with verified identifiers", n("verified")],
    ["Included with extraction cards", n("cards")],
  ];
  return ["| Stage | Count |", "| --- | --- |", ...rows.map(([stage, value]) => `| ${stage} | ${value} |`)].join("\n") + "\n";
}

export function flowSourceFile(dir: string): string { return candidatesPath(dir); }
