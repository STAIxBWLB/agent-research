import { loadCandidates } from "./candidates.ts";
import { openStudy, readLedger, type LedgerEvent } from "../study.ts";

/** Query intents (#103). ares records them; it never generates or ranks queries. */
export const QUERY_INTENTS = ["lexical", "semantic", "background"] as const;
export type QueryIntent = typeof QUERY_INTENTS[number];
export type IntentLabel = QueryIntent | "unspecified";

export function validateIntent(raw: unknown, field = "--intent"): QueryIntent {
  if (typeof raw !== "string" || !(QUERY_INTENTS as readonly string[]).includes(raw)) throw new Error(`${field}: unknown query intent; use ${QUERY_INTENTS.join(", ")} or omit it`);
  return raw as QueryIntent;
}
/** Ledger events carry no id; a search is named by its 1-based ordinal among lit.search events in the append-only ledger. */
export function searchId(ordinal: number): string { return `search-${ordinal}`; }
export function nextSearchId(events: LedgerEvent[]): string { return searchId(events.filter(e => e.type === "lit.search").length + 1); }
/** Old or hand-edited events read as unspecified rather than failing the report. */
export function intentOf(event: LedgerEvent): IntentLabel {
  const value = event.data.intent;
  return typeof value === "string" && (QUERY_INTENTS as readonly string[]).includes(value) ? value as QueryIntent : "unspecified";
}

interface Yield { included: number; excluded: number; new: number }
const LABELS: IntentLabel[] = [...QUERY_INTENTS, "unspecified"];
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Per-intent counts only, for the content-free export bundle. */
export function intentSummary(events: LedgerEvent[], candidates: { firstQuery?: string; status: string }[]) {
  return queryReport(events, candidates).byIntent;
}

function queryReport(events: LedgerEvent[], candidates: { firstQuery?: string; status: string }[]) {
  const yields = new Map<string, Yield>();
  let unattributed = 0;
  for (const c of candidates) {
    if (!c.firstQuery) { unattributed++; continue; }
    const row = yields.get(c.firstQuery) ?? { included: 0, excluded: 0, new: 0 };
    if (c.status === "included") row.included++; else if (c.status === "excluded") row.excluded++; else row.new++;
    yields.set(c.firstQuery, row);
  }
  const rows = events.filter(e => e.type === "lit.search").map((e, index) => {
    const id = searchId(index + 1), y = yields.get(id) ?? { included: 0, excluded: 0, new: 0 };
    const sources = Array.isArray(e.data.sources) ? (e.data.sources as { source?: unknown; ok?: unknown }[]).map(s => ({ source: typeof s.source === "string" ? s.source : "unknown", ok: s.ok === true })) : [];
    return { id, at: e.at, query: typeof e.data.query === "string" ? e.data.query : "", intent: intentOf(e), sources, added: count(e.data.added), merged: count(e.data.merged), ...y };
  });
  const byIntent = Object.fromEntries(LABELS.map(label => [label, { queries: 0, added: 0, merged: 0, included: 0, excluded: 0, new: 0 }])) as Record<IntentLabel, { queries: number; added: number; merged: number } & Yield>;
  for (const row of rows) {
    const s = byIntent[row.intent];
    s.queries++; s.added += row.added; s.merged += row.merged; s.included += row.included; s.excluded += row.excluded; s.new += row.new;
  }
  return { rows, byIntent, unattributed };
}

/** Read-only per-query yield: what each search first added and how that screened out. */
export function litQueries(dirArg: string) {
  const { dir } = openStudy(dirArg), report = queryReport(readLedger(dir), loadCandidates(dir));
  return {
    queries: report.rows, byIntent: report.byIntent,
    zeroIncluded: report.rows.filter(row => row.included === 0).map(row => ({ id: row.id, intent: row.intent, added: row.added })),
    // Candidates created before #103 (or by older ares) have no firstQuery and cannot be attributed to one search.
    unattributed: report.unattributed,
  };
}
