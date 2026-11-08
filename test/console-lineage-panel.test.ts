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
const study = { id: "synthetic-study", dir: "/synthetic/registered-study", question: "Synthetic question", mode: "experiment" };
const proof = { file: "ledger.jsonl", sha256: "a".repeat(64), ledgerIndex: 0, recordType: "idea.added", nativeId: "native-한" };
const reference = { v: 1, tool: "ares", projectKey: study.id, kind: "idea", id: "native/한-id", revision: "native-revision", sha256: "b".repeat(64) };
const page = (overrides = {}) => ({ v: 1, status: "ok", sourceSha256: "c".repeat(64), ledgerPosition: 42, totals: { nodes: 1, edges: 1 }, nodes: [{ ref: reference, state: "current", availability: "available", proof }], edges: [{ from: reference, to: { ...reference, kind: "attempt", id: "a".repeat(16) }, relation: "cites-attempt", proof }], issues: [], truncated: false, ...overrides });

test("study detail provides read-only lineage and comparison navigation", async () => {
  const f = await mount(); f.panel.show("study", { study: study.dir }); f.emit({ study });
  click(buttons(f.root, "Lineage")[0]!); click(buttons(f.root, "Compare")[0]!);
  expect(f.navigations).toEqual([{ tool: "ares", panel: "lineage", params: { study: study.dir } }, { tool: "ares", panel: "compare", params: { study: study.dir } }]);
  expect(f.actions()).toBe(0);
});

test("lineage keeps native root ids and proof states, with a graph cursor separate from polling", async () => {
  const f = await mount(); f.panel.show("lineage", { study: study.dir, rootKind: "idea", rootId: "previous", graphCursor: "prior" });
  f.emit({ study, lineage: page({ nextCursor: "opaque-next-graph", truncated: true, nodes: [
    { ref: reference, state: "historical", availability: "receipt-only", proof },
    { ref: { ...reference, id: "corrupt" }, state: "corrupt", availability: "available", proof },
    { ref: { ...reference, id: "missing" }, state: "unavailable", availability: "missing", proof },
    { ref: { ...reference, kind: "artifact", id: "b".repeat(64) }, state: "current", availability: "not-read", proof },
  ] }) });
  const rendered = content(f.root); for (const value of ["historical / receipt-only", "corrupt / available", "unavailable / missing", "current / not-read", "cites-attempt", "ledger index 0", proof.sha256]) expect(rendered).toContain(value);
  const row = descendants(f.root).find(node => node.tag === "row" && String(node.props.title).includes(reference.id))!;
  openRow(row); expect(f.navigations.at(-1)).toEqual({ tool: "ares", panel: "lineage", params: { study: study.dir, rootKind: reference.kind, rootId: reference.id, rootRevision: reference.revision, rootSha256: reference.sha256 } });
  click(buttons(f.root, "Next lineage page")[0]!);
  expect(f.navigations.at(-1)?.params).toEqual({ study: study.dir, rootKind: "idea", rootId: "previous", graphCursor: "opaque-next-graph" });
  expect(Object.hasOwn(f.navigations.at(-1)!.params, "cursor")).toBe(false); expect(f.actions()).toBe(0);
});

test("changed, capped and unavailable graphs retain explicit recovery notices", async () => {
  const f = await mount();
  for (const status of ["changed", "capped", "unavailable"]) {
    f.panel.show("lineage", { study: study.dir, rootKind: "idea", rootId: reference.id, graphCursor: "stale" });
    f.emit({ study, lineage: page({ status, nodes: [], edges: [], totals: null, issues: [{ code: "source-state", message: "Restore synthetic source" }] }) });
    expect(content(f.root)).toContain(status === "changed" ? "Restart from the first page" : status === "capped" ? "partial graph" : "unavailable or corrupt");
    expect(content(f.root)).toContain("Restore synthetic source");
    if (status === "changed") { click(buttons(f.root, "Restart lineage")[0]!); expect(f.navigations.at(-1)?.params).toEqual({ study: study.dir, rootKind: "idea", rootId: reference.id }); }
  }
});

test("comparison selector requires exactly one distinct bounded list before read-only navigation", async () => {
  const f = await mount(); f.panel.show("compare", { study: study.dir }); f.emit({ study, comparison: null });
  const form = descendants(f.root).find(node => node.tag === "form")!, submit = form.props.onSubmit as (values: Record<string, string>) => void;
  for (const values of [{}, { attempts: "a".repeat(16), candidates: "b".repeat(40) }, { attempts: Array(9).fill("a".repeat(16)).join(",") }, { attempts: `${"a".repeat(16)},${"a".repeat(16)}` }, { candidates: "short" }]) submit(values);
  expect(f.navigations).toEqual([]); expect(content(f.root)).toContain("one to eight distinct");
  submit({ attempts: ` ${"a".repeat(16)}, ${"b".repeat(16)} ` });
  expect(f.navigations.at(-1)?.params).toEqual({ study: study.dir, attempts: `${"a".repeat(16)},${"b".repeat(16)}` });
  submit({ candidates: "c".repeat(40) }); expect(f.navigations.at(-1)?.params).toEqual({ study: study.dir, candidates: "c".repeat(40) }); expect(f.actions()).toBe(0);
});

test("comparison tables retain failed/unknown rows, units, digests and unknown costs without aggregation", async () => {
  const f = await mount(), attempt = { id: "a".repeat(16), code: { commit: "b".repeat(40), treeId: "c".repeat(40), snapshotSha256: "d".repeat(64) }, protocolHash: "e".repeat(64), seed: 0, status: "unknown", retryOf: "f".repeat(16), retryAncestry: ["f".repeat(16)], sampleGroup: "g".repeat(64), metrics: [{ name: "score", value: 0, unit: "points" }], artifactDigests: ["a".repeat(64)], comparabilityReasons: ["missing-declared-metrics"], costs: { wallMilliseconds: 0, storageBytes: 0, compute: "unknown" } };
  f.panel.show("compare", { study: study.dir, attempts: attempt.id });
  f.emit({ study, comparison: { status: "unavailable", rows: [{ kind: "candidate", id: "b".repeat(40), state: "available", attempts: [attempt, { ...attempt, id: "b".repeat(16), status: "failed", metrics: [], costs: {} }], reasons: ["mixed-status"] }], aggregation: { performed: false, available: false, compatible: false, reasons: ["protocol-mismatch"] }, issues: [] } });
  const table = descendants(f.root).find(node => node.tag === "table")!, values = table.props.rows as Record<string, unknown>[];
  expect(values).toHaveLength(2); expect(values[0]).toMatchObject({ seed: "0", status: "unknown", metrics: "score: 0 points", wall: 0, bytes: 0 });
  expect(values[0]!.other).toContain("compute: unknown"); expect(values[1]).toMatchObject({ status: "failed", metrics: "unknown", wall: "unknown", bytes: "unknown" });
  expect(content(f.root)).toContain("protocol-mismatch"); expect(content(f.root)).toContain("Aggregation unavailable; performed: false"); expect(content(f.root)).toContain(attempt.artifactDigests[0]!);
  const link = descendants(f.root).find(node => node.tag === "row" && node.props.title === `Trace attempt ${attempt.id}`)!; openRow(link);
  expect(f.navigations.at(-1)?.params).toEqual({ study: study.dir, rootKind: "attempt", rootId: attempt.id }); expect(f.actions()).toBe(0);
});

test("lineage rendering stays within node/edge bounds and basic registration rows remain navigable", async () => {
  const f = await mount(); f.panel.show("lineage", {}); f.emit({ study: null, studies: [{ dir: study.dir }] });
  openRow(descendants(f.root).find(node => node.tag === "row")!); expect(f.navigations.at(-1)?.params).toEqual({ study: study.dir });
  f.panel.show("lineage", { study: study.dir }); f.emit({ study, lineage: page({ nodes: Array(101).fill({ ref: reference, state: "current", availability: "available", proof }), edges: Array(201).fill({ from: reference, to: reference, relation: "parent", proof }) }) });
  expect(descendants(f.root).filter(node => node.tag === "row")).toHaveLength(100);
  expect((descendants(f.root).find(node => node.tag === "table")!.props.rows as unknown[])).toHaveLength(200);
});

test("candidate summaries preserve recorded eligibility and numbers without recomputing per-seed values", async () => {
  const f = await mount(), attempt = "a".repeat(16);
  f.panel.show("compare", { study: study.dir, candidates: "b".repeat(40) });
  f.emit({ study, comparison: { status: "ok", aggregation: { performed: false, available: false, compatible: true, reasons: [] }, issues: [], rows: [{
    kind: "candidate", id: "b".repeat(40), state: "available", attempts: [], reasons: [], candidate: {
      reason: "below-margin", eligible: false, mean: 17, baselineMean: 33, delta: -16,
      perSeed: Array.from({ length: 129 }, (_, seed) => ({ seed, attempt, value: 900 })),
    },
  }] } });
  const tables = descendants(f.root).filter(node => node.tag === "table");
  const summary = tables.find(node => node.props.caption === "Recorded closed candidate summary")!;
  expect(summary.props.rows).toEqual([{ reason: "below-margin", eligible: "false", mean: 17, baselineMean: 33, delta: -16 }]);
  const perSeed = tables.find(node => node.props.caption === "Recorded per-seed values")!.props.rows as Record<string, unknown>[];
  expect(perSeed).toHaveLength(128); expect(perSeed[0]).toEqual({ seed: 0, attempt, value: 900 });
  expect(content(f.root)).toContain("no recalculation or new eligibility judgment");
  expect(content(f.root)).toContain("Per-seed display shortened to the first 128 records");
  expect(content(f.root)).toContain("Aggregation unavailable; performed: false"); expect(f.actions()).toBe(0);
});
