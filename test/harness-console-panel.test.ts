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
const buttons = (root: Element, label: string) => descendants(root).filter(node => node.tag === "button" && node.props.label === label);
const click = (button: Element) => (button.props.onClick as () => void)();
const openRow = (row: Element) => (row.props.onOpen as () => void)();
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
const study = {id: "synthetic-study", dir: "/synthetic/registered-study", question: "Synthetic harness view", mode: "experiment"};
const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
const actor = {kind: "person", id: "synthetic-reviewer"}, at = "2030-01-01T00:00:00Z";
function round(id = "round-one") {
  const closure = {form: {id: "closure-one", outcome: "adopted-experimental", reason: "Synthetic manual disposition", adoptionSha256: c}, sha256: a, actor, at, binding: a, sourceStrength: "synthetic-fixture", matched: false, current: false};
  return {definition: {id, task: {id: "synthetic-task"}, baseline: {guidanceSha256: a}, candidates: [{id: "candidate", guidanceSha256: b}], authoring: "uncontrolled-authoring", hypothesis: {deficiency: "Synthetic omitted constraint", predictedChange: "Synthetic explicit constraint"}}, binding: a, historicalImports: 1, probes: [],
    comparisons: [{arm: "candidate", compatible: true, matched: false, sourceStrength: "synthetic-fixture", reasons: [], confounders: ["sampling-unknown"]}],
    transitions: {fingerprint: c, contrasts: [{form: {id: "contrast-one", arm: "candidate", outcome: "inconclusive", basis: "actor-claim", observations: "Synthetic observation without quality evidence", uncertainty: "No independent judge", explanations: ["Synthetic explanation"], evidence: [{probe: "synthetic-probe", projectionSha256: b, outputManifestHash: c}]}, sha256: a, actor, at}],
      composition: {form: {id: "composition-one", sections: [{section: "procedure", decision: "revise", contrasts: [{id: "contrast-one", sha256: a}], reason: "Synthetic stated change"}], successorSha256: b}, sha256: c, actor, at},
      adoption: {form: {id: "adoption-one", decision: "adopt", arm: "candidate", reason: "Synthetic adoption declaration", checks: [{probe: "synthetic-probe", projectionSha256: b}], independentCheck: {state: "unavailable", source: {kind: "unavailable", refs: []}}}, sha256: c, actor, at, binding: a, sourceStrength: "synthetic-fixture", matched: false},
      closure, closures: [closure],
      readiness: {state: "stale", experimental: true, correctness: "unavailable", transfer: "not-demonstrated"}, successor: {guidanceSha256: b, execution: "unexecuted"}}};
}
const snapshot = (views: unknown[]) => ({study, harness: {v: 1, rounds: views, truncated: false, remaining: 0, realImport: "unavailable", endToEndEvaluation: "unavailable"}});

test("Study Harness button and round selection use only producer-owned read navigation", async () => {
  const f = await mount(); f.panel.show("study", {study: study.dir}); f.emit({study}); click(buttons(f.root, "Harness")[0]!);
  expect(f.navigations.at(-1)).toEqual({tool: "ares", panel: "harness", params: {study: study.dir}});
  f.panel.show("harness", {study: study.dir}); f.emit(snapshot([round(), round("round-two")]));
  const choose = descendants(f.root).find(node => node.tag === "row" && node.props.title === "round-two")!; openRow(choose);
  expect(f.navigations.at(-1)?.params).toEqual({study: study.dir, round: "round-two"}); expect(f.actions()).toBe(0);
});

test("supplied transitions show comparison, contrast citations, section edits and stale closure without promotion", async () => {
  const f = await mount(); f.panel.show("harness", {study: study.dir, round: "round-one"}); f.emit(snapshot([round()]));
  const rendered = content(f.root);
  for (const value of ["Experimental records only", "Correctness is unavailable", "transfer is not demonstrated", "Recorded contrast contrast-one", "Synthetic observation", "No independent judge", "Synthetic explanation", "synthetic-probe", "Recorded per-section edit-to-evidence composition-one", "revise", "contrast-one @", "Recorded closure closure-one", "stale closure", "Synthetic manual disposition", "does not activate guidance", "actor-claim", "Actor claim (not observed evidence)", "Recorded adoption adoption-one", "Independent check state: unavailable", "Independent check source kind: unavailable", "Recorded closure history", "adopted-experimental", "unexecuted and untested"]) expect(rendered).toContain(value);
  const table = descendants(f.root).find(node => node.tag === "table" && node.props.caption === "Fixture comparison identities")!;
  expect((table.props.rows as Record<string, unknown>[])[0]).toMatchObject({compatible: "true", matched: "false", source: "synthetic-fixture"});
  const evidence = descendants(f.root).find(node => node.tag === "table" && node.props.caption === "Recorded contrast evidence references")!;
  expect(evidence.props.rows).toEqual([{probe: "synthetic-probe", projection: b, output: c}]);
  const adoption = descendants(f.root).find(node => node.tag === "table" && node.props.caption === "Recorded adoption probe references")!;
  expect(adoption.props.rows).toEqual([{probe: "synthetic-probe", projection: b, output: "not recorded"}]);
  expect(f.actions()).toBe(0); expect(f.navigations).toEqual([]);
});

test("open rounds and fixture-only successors remain explicitly untested", async () => {
  const f = await mount(), value = round();
  const open = {...value, transitions: {...value.transitions, contrasts: [], composition: null, adoption: null, closure: null, closures: [], readiness: {...value.transitions.readiness, state: "open"}, successor: {...value.transitions.successor, execution: "fixture-declared", probeId: "synthetic-successor-probe"}}};
  f.panel.show("harness", {study: study.dir}); f.emit(snapshot([open]));
  for (const value of ["No recorded contrasts", "No recorded composition", "Round remains open", "fixture declaration is not live execution", "remains untested"]) expect(content(f.root)).toContain(value);
  expect(f.actions()).toBe(0);
});

test("fresh and unavailable views offer no action or arbitrary external reference resolution", async () => {
  const f = await mount(); f.panel.show("harness", {study: study.dir}); f.emit(snapshot([])); expect(content(f.root)).toContain("No harness rounds");
  f.emit({study, harness: null, error: "Synthetic source unavailable"}); expect(content(f.root)).toContain("Synthetic source unavailable"); expect(content(f.root)).toContain("Harness records unavailable");
  f.panel.show("harness", {}); f.emit({study: null, studies: [{dir: study.dir}], harness: null}); openRow(descendants(f.root).find(node => node.tag === "row")!);
  expect(f.navigations.at(-1)).toEqual({tool: "ares", panel: "harness", params: {study: study.dir}}); expect(f.actions()).toBe(0);
});


test("non-adoption closure outcomes render independently and preserve stale immutable history", async () => {
  const f = await mount();
  for (const outcome of ["baseline-kept", "inconclusive", "withdrawn"]) {
    const value = round(), closure = {...value.transitions.closure, form: {id: "standalone-closure", outcome, reason: "Synthetic closure without adoption"}, current: true};
    const history = Array.from({length: 17}, (_, i) => ({...closure, form: {...closure.form, id: `history-${i}`}, current: false}));
    f.panel.show("harness", {study: study.dir, round: value.definition.id});
    f.emit(snapshot([{...value, transitions: {...value.transitions, adoption: null, closure, closures: history}}]));
    const rendered = content(f.root); expect(rendered).toContain(`Recorded outcome: ${outcome}`); expect(rendered).toContain("current closure"); expect(rendered).not.toContain("Recorded adoption");
    const table = descendants(f.root).find(node => node.tag === "table" && node.props.caption === "Immutable closure records")!;
    expect((table.props.rows as unknown[])).toHaveLength(16); expect((table.props.rows as Record<string, unknown>[])[0]!.currency).toBe("stale"); expect(rendered).toContain("1 more closure records");
    expect(f.actions()).toBe(0);
  }
});

test("blinded judgment provenance stays distinct from unavailable independent checking", async () => {
  const f = await mount(), value = round(), contrast = value.transitions.contrasts[0]!;
  f.panel.show("harness", {study: study.dir});
  f.emit(snapshot([{...value, transitions: {...value.transitions, contrasts: [{...contrast, form: {...contrast.form, basis: "blinded-judgment", judge: "model", model: "synthetic-judge"}}]}}]));
  const rendered = content(f.root); expect(rendered).toContain("provenance basis blinded-judgment | judge model | model synthetic-judge");
  expect(rendered).toContain("Recorded blinded judgment"); expect(rendered).toContain("Independent check state: unavailable"); expect(rendered).toContain("Independent check source kind: unavailable"); expect(f.actions()).toBe(0);
});
