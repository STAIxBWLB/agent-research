import { expect, test } from "bun:test";

class Element {
  hidden = false;
  constructor(readonly tag: string, readonly props: Record<string, unknown> = {}, public children: unknown[] = []) {}
  append(...children: unknown[]) { this.children.push(...children); }
  replaceChildren(...children: unknown[]) { this.children = children; }
  remove() { this.children = []; }
}
function descendants(element: Element): Element[] {
  return [element, ...element.children.flatMap(child => child instanceof Element ? descendants(child) : [])];
}
const content = (root: Element) => JSON.stringify(descendants(root).map(node => ({ tag: node.tag, ...node.props })));
async function mount() {
  const module = await import(new URL("../src/ui/panel.js", import.meta.url).href);
  const root = new Element("mount"), navigations: { tool: string; panel: string; params: Record<string, string> }[] = [];
  let emit!: (snapshot: Record<string, unknown>) => void, actions = 0;
  const h = (tag: string, props: Record<string, unknown> = {}, ...children: unknown[]) => new Element(tag, props, children);
  const ui = {
    h, button: (label: string, onClick: () => void, options = {}) => h("button", { label, onClick, ...options }),
    notice: (text: string, tone: string) => h("notice", { text, tone }), chip: (text: string, tone: string) => h("chip", { text, tone }),
    empty: (title: string, hint?: string) => h("empty", { title, hint }),
    rows: (items: unknown[], render: (item: unknown) => Element) => items.length ? h("rows", {}, ...items.map(render)) : null,
    row: (value: Record<string, unknown>) => h("row", value, ...(Array.isArray(value.verbs) ? value.verbs : [])),
    table: (value: Record<string, unknown>) => h("table", value),
    form: (fields: unknown[], submit: unknown, onSubmit: (values: Record<string, string>) => void) => h("form", { fields, submit, onSubmit }),
    detail: (value: Record<string, unknown>) => h("detail", value), link: (value: unknown, label: string) => h("link", { value, label }),
  };
  const panel = module.default({ ui, tool: "ares", mount: root, navigate: (tool: string, panel: string, params: Record<string, string>) => navigations.push({ tool, panel, params }),
    onSnapshot: (handler: typeof emit) => { emit = handler; }, snapshot: async () => ({ changed: false }), action: async () => { actions++; throw new Error("read panel must not request an action"); }, toast: () => {}, sheet: { open: () => h("sheet"), close: () => {} } });
  return { root, panel, navigations, emit: (snapshot: Record<string, unknown>) => emit({ changed: true, cursor: 987, ...snapshot }), actions: () => actions };
}
const hash = "a".repeat(64), other = "b".repeat(64), actor = {kind: "person", id: "synthetic-owner"}, at = "2030-01-01T00:00:00Z";
const study = {id: "synthetic-study", dir: "/synthetic/study", question: "Synthetic lessons", mode: "experiment"};
function lesson(kind = "observation", round = "round-one") {
  return {proposal: {name: "synthetic-lesson", round, kind, summary: "Synthetic bounded observation", procedure: ["Inspect declared result", "Keep explicit limits"], applicability: "Synthetic task only", limitations: ["No live evidence"], whenNotToUse: ["Unrelated tasks"], failure: "Synthetic omitted check", retryWhen: "New independent evidence", change: [{kind: "contrast", id: "contrast-one", sha256: hash}], behavior: [{probe: "probe-one", projectionSha256: hash, outputManifestHash: other}], sourceStrength: "synthetic-fixture", transfer: "not-demonstrated", evidenceLabel: "single-task-observation", closureSha256: other, roundBinding: hash, sourceFingerprint: other,
    inspections: [{ref: {v: 1, tool: "ares", projectKey: study.id, kind: "harness-closure", id: round, sha256: other}, state: "available", digest: other, integrity: "record", outcome: {status: "closed", success: false}, support: "reviewer-judgment", sourceVersion: {reference: 1, native: 1}, observedAt: at, body: "PRIVATE_BODY_SENTINEL"}]},
    sha256: hash, actor, at, state: "accepted", current: true, exportable: true, needsSourceRecheck: true, evidenceFingerprint: other,
    disposition: {decision: "accept", reason: "Synthetic bounded review", acknowledgeStrength: "synthetic-fixture; not evidence of real agent behavior", actor, at, evidenceFingerprint: other, sha256: hash}};
}
async function render(candidates: unknown[], panel = "harness") {
  const f = await mount(); f.panel.show(panel, {study: study.dir, round: "round-one"});
  f.emit({study, lessonCandidates: candidates, harness: {v: 1, rounds: [{definition: {id: "round-one", task: {id: "task-one"}, baseline: {}}, binding: hash, comparisons: [], probes: [], transitions: {fingerprint: hash, readiness: {state: "closed"}, contrasts: [], closures: []}}]}}); return f;
}
test("selected harness round shows stored lesson links and explicit experimental eligibility without actions or bodies", async () => {
  const f = await render([lesson(), {...lesson("observation", "other-round"), proposal: {...lesson().proposal, round: "other-round", name: "HIDDEN_OTHER_ROUND"}}]), shown = content(f.root);
  for (const label of ["Linked lesson candidates", "Lesson synthetic-lesson", "Stored disposition: accepted", "current proposal", "synthetic-fixture; not evidence of real agent behavior", "single-task-observation", "transfer: not-demonstrated", "No success or scientific support", "stored exportable flag: true", "not fresh proof", "Owner source recheck", "Needs source recheck: true", "Synthetic task only", "No live evidence", "Unrelated tasks", "Synthetic omitted check", "New independent evidence", "Proposal SHA-256", "source closure", "round binding", "source fingerprint", "evidence fingerprint", "Lesson change references", "contrast-one", "Lesson behavior references", "probe-one", "Stored lesson inspections", "reviewer-judgment", "Synthetic bounded review"]) expect(shown).toContain(label);
  expect(shown).not.toContain("PRIVATE_BODY_SENTINEL"); expect(shown).not.toContain("HIDDEN_OTHER_ROUND"); expect(f.actions()).toBe(0); expect(f.navigations).toEqual([]);
});
test("stale no-lesson remains visible and never acquires export or activation actions", async () => {
  const f = await render([{...lesson("no-lesson"), current: false, exportable: false, state: "withdrawn"}]), shown = content(f.root);
  for (const label of ["stale proposal", "Stored disposition: withdrawn", "No-lesson candidates never export", "stored exportable flag: false", "no source checks or activation"]) expect(shown).toContain(label);
  expect(f.actions()).toBe(0); expect(descendants(f.root).filter(node => node.tag === "button").some(node => /accept|export|activate|check/i.test(String(node.props.label)))).toBe(false);
});
test("lesson text, reference arrays and card count announce every display cut", async () => {
  const first = lesson(); first.proposal.procedure = Array.from({length: 17}, (_, index) => `procedure-${index}`); first.proposal.summary = "x".repeat(4001); first.proposal.change = Array(17).fill(first.proposal.change[0]);
  const f = await render([first, ...Array(32).fill(lesson())]), shown = content(f.root);
  for (const label of ["1 more entries; display incomplete", "text display incomplete", "Lesson reference display incomplete", "1 more lesson candidates; display incomplete"]) expect(shown).toContain(label);
  expect(shown).not.toContain("procedure-16"); expect(f.actions()).toBe(0);
});
test("lesson candidates are not rendered on the Study panel", async () => {
  const f = await render([lesson()], "study"); expect(content(f.root)).not.toContain("synthetic-lesson"); expect(f.actions()).toBe(0);
});
