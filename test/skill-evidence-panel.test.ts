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
const study = {id: "synthetic-study", dir: "/synthetic/registered-study", question: "Synthetic skills", mode: "experiment"};
const digest = "a".repeat(64), time = "2030-01-01T00:00:00Z";
const local = {v: 1, tool: "ares", projectKey: study.id, kind: "investigation", id: "no-winner"};
const amem = {v: 1, tool: "amem", id: "b".repeat(32)};
const inspection = (ref: unknown, state = "available", integrity = "record", status = "no-winner") => ({ref, state, digest, integrity, outcome: {status, success: false}, support: "reviewer-judgment", sourceVersion: {reference: 1, native: 1, ledger: 1}, observedAt: time});
const proposal = () => ({skillProposal: 2, evidenceStatus: "inspection-required", name: "synthetic-skill", summary: "Synthetic bounded process", steps: ["Review the record"], state: "proposed", sha256: digest,
  applicability: "Only synthetic records", limitations: ["No scientific support established"], evidence: [local, amem], counterevidence: [local],
  inspections: [inspection(local), {...inspection(amem, "available", "screened", "not-applicable"), sourceVersion: {reference: 1, amem: "0.22.1"}}]});
async function render(skills: unknown[]) {const f = await mount(); f.panel.show("study", {study: study.dir}); f.emit({study: {...study, skills}}); return f;}

test("v2 skill cards passively separate typed refs, counterevidence, outcomes and screening receipts", async () => {
  const value = proposal();
  const f = await render([{...value, decision: {action: "accept", reason: "Synthetic review", actor: {kind: "person", id: "reviewer"}, at: time, pr: "https://example.invalid/pull/1", evidenceFingerprint: digest, inspections: value.inspections}}]);
  const shown = content(f.root);
  for (const label of ["Applicability", "Only synthetic records", "Limitations", "No scientific support established", "Counterevidence", "Stored proposal inspections", "Stored decision inspections", "Recorded availability", "Integrity", "Recorded outcome", "Recorded success", "Support", "Source versions", "Observed time", "no-winner", "false", "screened", "not-applicable", "reviewer-judgment", "0.22.1", "2030-01-01", "inspection-required", "Stored receipts are not a current privacy check", "ares skill check /synthetic/registered-study synthetic-skill", "Acceptance reruns evidence and counterevidence under the study lock", "Negative/no-winner outcomes are not success", "not verified as merged"]) expect(shown).toContain(label);
  expect(shown).toContain('\\"tool\\":\\"ares\\"'); expect(shown).toContain('\\"tool\\":\\"amem\\"');
  expect(shown).not.toContain("[object Object]"); expect(f.actions()).toBe(0); expect(f.navigations).toEqual([]);
});

test("stored inspection classes remain distinct and no body or private metadata is rendered", async () => {
  const value = proposal(), states = ["available", "missing", "changed", "unavailable", "unsupported"];
  const f = await render([{...value, inspections: states.map((state, index) => ({...inspection(local, state, ["record", "receipt-only", "unverified", "screened", "unverified"][index], "failed"), body: "PRIVATE_BODY_SENTINEL", metadata: {path: "PRIVATE_PATH_SENTINEL", text: "PRIVATE_TEXT_SENTINEL"}}))}]);
  const shown = content(f.root);
  for (const label of [...states, "record", "receipt-only", "unverified", "screened", "failed"]) expect(shown).toContain(label);
  for (const secret of ["PRIVATE_BODY_SENTINEL", "PRIVATE_PATH_SENTINEL", "PRIVATE_TEXT_SENTINEL"]) expect(shown).not.toContain(secret);
  expect(f.actions()).toBe(0);
});

test("v1 legacy cards preserve string references without implying current inspection or success", async () => {
  const f = await render([{skillProposal: 1, evidenceStatus: "legacy-unresolved", name: "legacy-skill", summary: "Synthetic legacy", steps: ["Review"], evidence: ["c".repeat(32), "ares:synthetic-study/attempt:old"], state: "accepted", sha256: digest}]);
  const shown = content(f.root);
  for (const label of ["Legacy v1 evidence: legacy-unresolved", "Create a new v2 proposal", "No stored inspection receipts", "ares:synthetic-study/attempt:old", "c".repeat(32)]) expect(shown).toContain(label);
  expect(shown).not.toContain("Stored proposal inspections"); expect(shown).not.toContain('"success":"true"'); expect(f.actions()).toBe(0);
});
