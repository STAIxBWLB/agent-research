import { CopilotAcceptError } from "../copilot.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openStudy, readTextBounded, sha256 } from "../study.ts";
import { loadCandidates } from "../lit/candidates.ts";
import { checkCitations, citationOccurrences } from "../lit/cite.ts";
import { readCard } from "../lit/cards.ts";
import { readProtocol } from "../exp/protocol.ts";
import { readSelection } from "../exp/selection.ts";
import { investigateResultPath, readClosedInvestigation } from "../exp/investigate.ts";
import { finalResultPath } from "../exp/final.ts";
import { MANUSCRIPT_BYTES, parsePlaceholders, resolvePlaceholders } from "./placeholders.ts";
import { hygieneFindings, readPaperSettings, type HygieneCode } from "./hygiene.ts";
import { readPaperPlanCheckSnapshot } from "./plan.ts";
import { paperPointFindings, type PointFindingCode } from "./points.ts";
import { paperPlanFindings, type ScopeFindingCode } from "./scopes.ts";

export const MAX_CODE_NUMBERS = 500;
export interface PaperFinding { code: "bare-number" | "unresolved-ref" | "unaccepted-draft" | "bad-format" | "unknown-citation" | "unverified-citation" | "missing-negative-result" | HygieneCode | ScopeFindingCode | PointFindingCode; severity: "blocking" | "warning"; section?: string[]; sectionId?: string; pointId?: string; start: number; end: number; line: number; column: number; message: string }
function blank(text: string, mask: Uint8Array): string { return text.split("").map((char, index) => mask[index] && char !== "\n" && char !== "\r" ? " " : char).join(""); }
function mark(mask: Uint8Array, start: number, end: number) { mask.fill(1, start, end); }
function escaped(text: string, index: number): boolean { let slashes = 0; while (index > 0 && text[--index] === "\\") slashes++; return slashes % 2 === 1; }
/** Masks syntax-only destinations and code while retaining original offsets. Visible link labels remain prose. */
function markdownMask(text: string, knownHidden?: Uint8Array): { mask: Uint8Array; code: Uint8Array; hidden: Uint8Array; headingHidden: Uint8Array; anchorHidden: Uint8Array } {
  const mask = new Uint8Array(text.length), protectedText = new Uint8Array(text.length), tokens = parsePlaceholders(text);
  for (const token of [...tokens.placeholders, ...tokens.findings]) mark(protectedText, token.start, token.end);
  let fence: { char: string; length: number } | undefined, paragraph = false, indented = false;
  const listIndents: number[] = [];
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0], start = match.index;
    if (!line) continue;
    if (!line.trim()) { paragraph = false; continue; }
    if (!fence && knownHidden?.[start + /^[ \t]*/.exec(line)![0].length]) { paragraph = false; continue; }
    if (fence) {
      mark(mask, start, start + line.length);
      const close = /^ {0,3}(`+|~+)[ \t]*\r?\n?$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = undefined;
      paragraph = false; indented = false;
    } else if (!protectedText[start]) {
      const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
      if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) { fence = { char: open[1]![0]!, length: open[1]!.length }; mark(mask, start, start + line.length); paragraph = false; indented = false; }
      else {
        const prefix = /^[ \t]*/.exec(line)![0];
        let indent = 0; for (const char of prefix) indent += char === "\t" ? 4 - indent % 4 : 1;
        const item = /^[ \t]*(?:[-+*]|[0-9]+[.)])[ \t]+/.exec(line);
        let parent = listIndents.length; while (parent && listIndents[parent - 1]! > indent) parent--;
        if (item && indent < (listIndents[parent - 1] ?? 0) + 4) {
          listIndents.length = parent; listIndents.push(item[0].length); paragraph = true; indented = false;
        }
        else {
          if (!paragraph) listIndents.length = parent;
          if (indent >= (listIndents.at(-1) ?? 0) + 4 && (indented || !paragraph)) { mark(mask, start, start + line.length); indented = true; }
          else { indented = false; paragraph = !/^ {0,3}(?:#{1,6}[ \t]|(?:---+|\*\*\*+|___+)[ \t]*$)/.test(line.trimEnd()); }
        }
      }
    }
  }
  const blockCode = mask.slice();
  // Backtick runs must have an exactly matching closer; unmatched delimiters remain prose.
  const runs = [...text.matchAll(/`+/g)].filter(hit => !mask[hit.index] && !protectedText[hit.index] && !knownHidden?.[hit.index]);
  const regions: number[] = []; let region = 0, previous = 0;
  for (const hit of runs) {
    if (/\n[ \t]*\r?\n/.test(text.slice(previous, hit.index)) || mask.subarray(previous, hit.index).includes(1)) region++;
    regions.push(region); previous = hit.index + hit[0].length;
  }
  const next = new Map<number, number>(), closers = new Map<string, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const hit = runs[i]!, key = `${regions[i]}:${hit[0].length}`;
    if (closers.has(key)) next.set(i, closers.get(key)!); closers.set(key, i);
  }
  for (let i = 0; i < runs.length; i++) {
    if (escaped(text, runs[i]!.index)) continue;
    const close = next.get(i);
    if (close !== undefined) { mark(mask, runs[i]!.index, runs[close]!.index + runs[close]![0].length); i = close; }
  }
  const code = mask.slice(), anchorHidden = code.slice();
  const labels: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (mask[i] || protectedText[i] || knownHidden?.[i] || (text[i] !== "<" && text[i] !== "]" && text[i] !== "[") || escaped(text, i)) continue;
    if (text[i] === "[") { labels.push(i); continue; }
    if (text[i] === "<") {
      const end = text.indexOf(">", i + 1), target = text.slice(i + 1, end < 0 ? i + 1 : end);
      if (end >= 0 && /^(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(target)) { mark(mask, i, end + 1); i = end; }
    }
    if (text[i] !== "]") continue;
    const label = labels.pop();
    if (label === undefined || text[i + 1] !== "(") continue;
    let start = i + 2; while (/\s/.test(text[start] ?? "") && start < text.length) start++;
    let end = start, depth = 0;
    if (text[start] === "<") { end = text.indexOf(">", start + 1); if (end < 0) continue; end++; }
    else {
      while (end < text.length) {
        const char = text[end]!;
        if (char === "\\") { end += 2; continue; }
        if (/\s/.test(char) || (char === ")" && depth === 0)) break;
        if (char === "(") depth++;
        if (char === ")") depth--;
        end++;
      }
      if (depth) continue;
    }
    let tail = end; while (/\s/.test(text[tail] ?? "") && tail < text.length) tail++;
    if (["\"", "'"].includes(text[tail] ?? "")) {
      const quote = text[tail++]!; while (tail < text.length && (text[tail] !== quote || escaped(text, tail))) tail++;
      if (tail >= text.length) continue; tail++; while (/\s/.test(text[tail] ?? "") && tail < text.length) tail++;
    }
    if (text[tail] === ")") { mark(mask, start, end); mark(anchorHidden, i + 1, tail + 1); }
  }
  // Point anchors are comments in prose, never examples in syntax-only destinations/titles or placeholders.
  for (let i = 0; i < mask.length; i++) if (mask[i] || protectedText[i]) anchorHidden[i] = 1;
  const hidden = new Uint8Array(text.length); let hasComment = false;
  for (const comment of text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
    if (!code[comment.index] && !protectedText[comment.index]) { mark(mask, comment.index, comment.index + comment[0].length); mark(hidden, comment.index, comment.index + comment[0].length); hasComment = true; }
  }
  // Reference definitions do not count as visible negative-result prose; labels/titles still get numeric checks.
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|[^\s]+)(?:[ \t]|$)/gm)) {
    const target = match[1]!, start = match.index + match[0].lastIndexOf(target);
    if (!mask[start] && !protectedText[start]) {
      mark(mask, start, start + target.length);
      const lineEnd = text.indexOf("\n", match.index); mark(hidden, match.index, lineEnd < 0 ? text.length : lineEnd); mark(anchorHidden, match.index, lineEnd < 0 ? text.length : lineEnd);
    }
  }
  // Reclassify once with non-code comments excluded, so a fence inside a comment cannot hide later prose.
  if (!knownHidden && hasComment) return markdownMask(text, hidden);
  const headingHidden = blockCode.slice(); for (let i = 0; i < hidden.length; i++) if (hidden[i]) headingHidden[i] = 1;
  return { mask, code, hidden, headingHidden, anchorHidden };
}
export function manuscriptPath(dir: string): string { return join(dir, "paper", "manuscript.md"); }
export function checkPaper(dirArg: string) {
  const { dir, study } = openStudy(dirArg), file = manuscriptPath(dir), settings = readPaperSettings(dir);
  let manuscript: string;
  try { manuscript = readTextBounded(file, MANUSCRIPT_BYTES); }
  catch { throw new Error("paper manuscript: missing, unreadable, invalid UTF-8, non-regular or larger than 2 MiB; restore paper/manuscript.md as a bounded UTF-8 regular file before paper check"); }
  const masks = markdownMask(manuscript), prose = blank(manuscript, masks.mask), parsed = parsePlaceholders(prose), resolution = resolvePlaceholders(dir, prose);
  const lines = [0]; for (let i = 0; i < manuscript.length; i++) if (manuscript[i] === "\n") lines.push(i + 1);
  const location = (start: number) => {
    let lo = 0, hi = lines.length; while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lines[mid]! <= start) lo = mid; else hi = mid; }
    return { line: lo + 1, column: start - lines[lo]! + 1 };
  };
  const finding = (code: PaperFinding["code"], start: number, end: number, message: string): PaperFinding => ({ code, severity: "blocking", start, end, ...location(start), message });
  const findings: PaperFinding[] = resolution.findings.map(f => finding(f.code, f.start, f.end, f.message));
  const codeNumbers: { value: string; line: number; column: number }[] = [];
  let codeNumberCount = 0;
  const codeText = manuscript.split("").map((char, index) => masks.code[index] || char === "\n" || char === "\r" ? char : " ").join("");
  for (const hit of codeText.matchAll(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu)) {
    codeNumberCount++;
    if (codeNumbers.length < MAX_CODE_NUMBERS) codeNumbers.push({ value: hit[0], ...location(hit.index) });
  }
  const numberMask = masks.mask.slice(), citationMask = masks.mask.slice();
  for (const placeholder of parsed.placeholders) {
    mark(numberMask, placeholder.start, placeholder.end);
    if (placeholder.kind === "number") mark(citationMask, placeholder.start, placeholder.end);
  }
  for (const problem of parsed.findings) { mark(numberMask, problem.start, problem.end); mark(citationMask, problem.start, problem.end); }
  const citationText = blank(manuscript, citationMask), candidates = loadCandidates(dir), citations = checkCitations(citationText, candidates);
  const plan = readPaperPlanCheckSnapshot(dir, candidates);
  const groups = new Map<number, number>();
  for (const hit of citationOccurrences(citationText)) {
    mark(numberMask, hit.start, hit.end); groups.set(hit.groupStart, hit.groupEnd);
    if (citations.unknown.includes(hit.key)) findings.push(finding("unknown-citation", hit.start, hit.end, `citation ${hit.key}: unknown key; add and verify the reference, then regenerate the bibliography`));
    else if (citations.notVerified.includes(hit.key)) findings.push(finding("unverified-citation", hit.start, hit.end, `citation ${hit.key}: not included and identifier-verified; inspect ares lit list, verify the reference or exclude this citation`));
  }
  // Only locator-number syntax is exempt inside citation brackets; arbitrary prose numbers remain checked.
  const locators = /(?:^|[^\p{L}\p{N}_])(p\.|pp\.|sec\.|§|ch\.|chap\.|fig\.|tbl\.|table|eq\.|l\.|ll\.|para\.)[ \t\r\n]*(\p{Nd}+(?:[ \t]*(?:--?|–|—)[ \t]*\p{Nd}+)?(?:[ \t]*,[ \t]*\p{Nd}+(?:[ \t]*(?:--?|–|—)[ \t]*\p{Nd}+)?)*)(?=$|[\s,;:\]\)]|\.(?!\p{Nd}))/giu;
  for (const [start, end] of groups) {
    const group = citationText.slice(start, end);
    for (const hit of group.matchAll(locators)) {
      const numbers = hit[2]!, offset = start + hit.index + hit[0].length - numbers.length;
      mark(numberMask, offset, offset + numbers.length);
    }
  }
  if (study.mode === "experiment") {
    for (const match of manuscript.matchAll(/^ {0,3}[0-9]+[.)](?=[ \t])/gm)) mark(numberMask, match.index, match.index + match[0].length);
    for (const match of blank(manuscript, numberMask).matchAll(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu)) findings.push(finding("bare-number", match.index, match.index + match[0].length, "prose number has no evidence ref; use {{n:REF}} for a measured value or {{lit:TEXT}} for a reviewer-visible literal"));
    const requireRef = (ref: string) => {
      if (!parsed.placeholders.some(p => p.kind === "number" && p.ref === ref && p.format === undefined && !masks.hidden[p.start])) findings.push(finding("missing-negative-result", 0, 0, `paper omits ${ref}; include {{n:${ref}}} in prose so the result cannot be hidden`));
    };
    if (existsSync(finalResultPath(dir))) requireRef("final.status");
    try {
      const protocol = readProtocol(dir), rule = protocol ? readSelection(dir, protocol) : undefined;
      if (rule && existsSync(investigateResultPath(dir, rule.run))) {
        try { if (readClosedInvestigation(dir).result.winner === null) requireRef("investigate.reason"); }
        catch (error) { findings.push(error instanceof CopilotAcceptError ? finding("unaccepted-draft", 0, 0, error.message) : finding("unresolved-ref", 0, 0, "investigate result is not current and closed; run ares investigate close before checking the paper")); }
      }
    } catch (error) { findings.push(error instanceof CopilotAcceptError ? finding("unaccepted-draft", 0, 0, error.message) : finding("unresolved-ref", 0, 0, "experiment design or selection is invalid; restore the current validated inputs before paper check")); }
  }
  // Code and comments only: link targets stay visible so headings and bare-identifier masking use the full prose mask.
  const hiddenCode = masks.code.slice(); for (let i = 0; i < hiddenCode.length; i++) if (masks.hidden[i]) hiddenCode[i] = 1;
  for (const hit of hygieneFindings(manuscript, hiddenCode, masks.mask, citationText, settings)) {
    findings.push({ code: hit.code, severity: settings.blocking.includes(hit.code) ? "blocking" : "warning", section: hit.section, start: hit.start, end: hit.end, ...location(hit.start), message: hit.message });
  }
  if (plan) for (const hit of paperPlanFindings(manuscript, masks.headingHidden, citationText, plan.plan, candidates)) findings.push({...hit, ...location(hit.start)});
  if (plan) for (const hit of paperPointFindings(dir, manuscript, masks.anchorHidden, masks.headingHidden, citationText, plan.plan)) findings.push({...hit, ...location(hit.start)});
  let rendered = "", cursor = 0;
  for (const entry of resolution.placeholders) { rendered += manuscript.slice(cursor, entry.placeholder.start) + entry.rendered; cursor = entry.placeholder.end; }
  rendered += manuscript.slice(cursor);
  // Reused cards are planning aids: list every cited candidate whose card came from the vault, with its provenance.
  const cited = loadCandidates(dir), unreadableCards: { citekey: string; id: string; message: string }[] = [];
  const reusedCards = citations.keys.flatMap(key => {
    const candidate = cited.find(c => c.citekey === key);
    let card: ReturnType<typeof readCard>;
    // An unreadable card is reported (not hidden), but does not block the check: cards are planning aids, never evidence.
    try { card = candidate ? readCard(dir, candidate.id) : undefined; }
    catch (error) { unreadableCards.push({ citekey: key, id: candidate!.id, message: error instanceof Error ? error.message : "card unreadable; record it again with ares lit card" }); return []; }
    return card?.reused ? [{ citekey: key, id: candidate!.id, vault: card.reused.vault, note: card.reused.note, at: card.reused.at, provenance: card.reused.provenance }] : [];
  });
  return { ok: !findings.some(f => f.severity === "blocking"), settings, manuscriptSha256: sha256(manuscript), ...(plan ? {planSha256: plan.sha256} : {}), rendered, placeholders: resolution.placeholders, findings: findings.sort((a, b) => a.start - b.start || a.code.localeCompare(b.code)), literals: resolution.literals, codeNumbers, codeNumberCount, citations, ...(reusedCards.length ? { reusedCards } : {}), ...(unreadableCards.length ? { unreadableCards } : {}) };
}
