import { citationOccurrences } from "../lit/cite.ts";
import { markdownHeadings, type MarkdownHeading } from "./headings.ts";
import type { PaperPlan } from "./plan.ts";
import * as pointEvidence from "./point-evidence.ts";

export const POINT_CODES = ["missing-point", "missing-required-citation", "unresolved-point-evidence"] as const;
export type PointFindingCode = typeof POINT_CODES[number];
export interface PaperPointHit {
  code: PointFindingCode;
  severity: "blocking";
  pointId: string;
  sectionId: string;
  section?: string[];
  start: number;
  end: number;
  message: string;
}
type PlannedSection = PaperPlan["sections"][number];
interface SectionWindow { section: PlannedSection; heading: MarkdownHeading; end: number }
interface PointAnchor { id: string; start: number; end: number; window?: SectionWindow }

/** Tokenize whole comments first, so an anchor-looking substring inside a normal comment is not an anchor. */
function anchors(manuscript: string, codeMask: Uint8Array): PointAnchor[] {
  const result: PointAnchor[] = [];
  let cursor = 0;
  for (;;) {
    const start = manuscript.indexOf("<!--", cursor);
    if (start < 0) break;
    // A masked or Markdown-escaped opener cannot consume a later prose comment's closer.
    let backslashes = 0;
    for (let index = start - 1; index >= 0 && manuscript[index] === "\\"; index--) backslashes++;
    if (codeMask[start] || backslashes % 2 === 1) { cursor = start + 4; continue; }
    const close = manuscript.indexOf("-->", start + 4), end = close < 0 ? manuscript.length : close + 3;
    const match = /^<!--[\s]*point:([a-z0-9]+(?:-[a-z0-9]+)*)[\s]*-->$/.exec(manuscript.slice(start, end));
    if (match && match[1]!.length <= 64) result.push({id: match[1]!, start, end});
    cursor = end;
  }
  return result;
}

/** Literal point anchors and citation keys only; claim prose is intentionally never inspected. */
export function paperPointFindings(dir: string, manuscript: string, codeMask: Uint8Array, headingHidden: Uint8Array, citationText: string, plan: PaperPlan): PaperPointHit[] {
  if (!plan.sections.some(section => section.points?.length)) return [];
  if (citationText.length !== manuscript.length) throw new Error("paper writing points: masked citation text changed source offsets; pass offset-preserving citationText before checking points");
  const byHeading = new Map(plan.sections.map(section => [section.heading, section]));
  const boundaries = markdownHeadings(manuscript, headingHidden).filter(heading => byHeading.has(heading.rawText));
  const windows: SectionWindow[] = boundaries.map((heading, index) => ({section: byHeading.get(heading.rawText)!, heading, end: boundaries[index + 1]?.start ?? manuscript.length}));
  const tokens = anchors(manuscript, codeMask), own = new Map<string, PointAnchor[]>(), citations = citationOccurrences(citationText), hits: PaperPointHit[] = [];
  const evidenceResults = new Map<string, pointEvidence.PointEvidenceResolution>();
  let windowCursor = 0, citationCursor = 0;
  for (const [index, anchor] of tokens.entries()) {
    while (windowCursor < windows.length && windows[windowCursor]!.heading.start <= anchor.start) windowCursor++;
    const window = windowCursor ? windows[windowCursor - 1] : undefined;
    if (window && anchor.start < window.end) anchor.window = window;
    const point = anchor.window?.section.points?.find(point => point.id === anchor.id);
    if (!point) continue; // Unknown and wrong-section tokens still end the preceding window through tokens[index + 1].
    const matches = own.get(point.id) ?? []; matches.push(anchor); own.set(point.id, matches);
    const end = Math.min(tokens[index + 1]?.start ?? manuscript.length, anchor.window!.end), keys = new Set<string>();
    while (citationCursor < citations.length && citations[citationCursor]!.start < anchor.end) citationCursor++;
    while (citationCursor < citations.length && citations[citationCursor]!.start < end) keys.add(citations[citationCursor++]!.key);
    for (const key of new Set(point.requires)) if (!keys.has(key)) hits.push({
      code: "missing-required-citation", severity: "blocking", pointId: point.id, sectionId: anchor.window!.section.id, section: anchor.window!.heading.path, start: anchor.start, end: anchor.end,
      message: `point ${point.id} requires citation @${key.slice(0, 80)} in this anchor window; cite it here or revise the declared point requirements`,
    });
  }
  for (const section of plan.sections) for (const point of section.points ?? []) {
    const first = own.get(point.id)?.[0], sectionWindow = first?.window ?? windows.find(window => window.section.id === section.id);
    const start = first?.start ?? sectionWindow?.heading.start ?? 0, end = first?.end ?? sectionWindow?.heading.end ?? 0;
    const context = {pointId: point.id, sectionId: section.id, ...(sectionWindow ? {section: sectionWindow.heading.path} : {}), start, end};
    if (!first) hits.push({code: "missing-point", severity: "blocking", ...context,
      message: `point ${point.id} has no anchor in section ${section.id}; add an exact <!-- point:${point.id} --> comment in that section before its paragraph`});
    for (const ref of new Set(point.evidence ?? [])) {
      let resolution = evidenceResults.get(ref);
      if (resolution === undefined) {
        try { resolution = pointEvidence.resolvePointEvidence(dir, ref); } catch { resolution = {resolved: false}; }
        evidenceResults.set(ref, resolution);
      }
      if (!resolution.resolved) hits.push({code: "unresolved-point-evidence", severity: "blocking", ...context,
        message: `point ${point.id} evidence ${ref.slice(0, 80)} does not resolve; ${pointEvidence.pointEvidenceAdvice(resolution)}`});
    }
  }
  return hits.sort((a, b) => a.start - b.start || a.code.localeCompare(b.code));
}
