import { citationOccurrences } from "../lit/cite.ts";
import { isVerified, type Candidate } from "../lit/candidates.ts";
import { markdownHeadings } from "./headings.ts";
import type { PaperPlan } from "./plan.ts";

export const SCOPE_CODES = ["out-of-scope-citation", "unplanned-section", "unrouted-reference"] as const;
export type ScopeFindingCode = typeof SCOPE_CODES[number];
export interface PaperPlanHit {
  code: ScopeFindingCode;
  severity: "blocking" | "warning";
  section?: string[];
  sectionId?: string;
  start: number;
  end: number;
  message: string;
}

/** Literal routing only. citationText must preserve the original manuscript's UTF-16 offsets. */
export function paperPlanFindings(manuscript: string, headingHidden: Uint8Array, citationText: string, plan: PaperPlan, candidates: Candidate[]): PaperPlanHit[] {
  if (citationText.length !== manuscript.length) throw new Error("paper citation scopes: masked citation text changed source offsets; pass offset-preserving citationText before checking the plan");
  const headings = markdownHeadings(manuscript, headingHidden), hits: PaperPlanHit[] = [];
  const sections = new Map(plan.sections.map(section => [section.heading, {id: section.id, cites: new Set(section.cites)}]));
  const routed = new Set(plan.sections.flatMap(section => section.cites));
  for (const heading of headings) if (heading.level === 2 && !sections.has(heading.rawText)) hits.push({
    code: "unplanned-section", severity: "warning", section: heading.path, start: heading.start, end: heading.end,
    message: "level-2 heading is not declared in the paper plan; add its intended section with paper plan set or revise the manuscript heading",
  });
  let cursor = 0, scope: {id: string; cites: Set<string>} | undefined, section: string[] = [];
  for (const citation of citationOccurrences(citationText)) {
    while (cursor < headings.length && headings[cursor]!.start <= citation.start) {
      const heading = headings[cursor++]!;
      section = heading.path;
      const boundary = sections.get(heading.rawText);
      if (boundary) scope = boundary;
    }
    if (scope && !scope.cites.has(citation.key)) hits.push({
      code: "out-of-scope-citation", severity: "blocking", section, sectionId: scope.id, start: citation.start, end: citation.end,
      message: `citation @${citation.key.slice(0, 80)} is outside section ${scope.id}'s declared scope; route the verified reference explicitly with paper plan set or revise this citation`,
    });
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.status !== "included" || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const key = typeof candidate.citekey === "string" ? candidate.citekey : undefined;
    if (key && routed.has(key) && isVerified(candidate)) continue;
    hits.push({code: "unrouted-reference", severity: "warning", start: 0, end: 0,
      message: `included reference ${(key ?? candidate.id).slice(0, 80)} has no valid section routing; verify it and assign its key explicitly with paper plan set`});
  }
  return hits.sort((a, b) => a.start - b.start || a.code.localeCompare(b.code));
}
