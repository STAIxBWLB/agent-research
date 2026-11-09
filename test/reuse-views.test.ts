import { expect, test } from "bun:test";
import { attemptReuseView } from "../src/provenance.ts";
import { executionView } from "../src/exp/pipeline.ts";
import { validateStageProtocol } from "../src/exp/stages.ts";
import { protocolHash } from "../src/exp/protocol.ts";
import { metricAttempt } from "./metric-fixtures.ts";

function fixture() {
  const value = metricAttempt(), original = structuredClone(value.stages.candidate!), fresh = structuredClone(value.stages.candidate!);
  const definition = validateStageProtocol({ ...value.protocol, v: 2, candidate: { stages: ["prepare", "train"].map(name => ({ name, ...value.protocol.candidate, seed: true, code: "snapshot", needs: [], inputs: {}, outputs: { result: "result.txt" } })) } });
  original.startedAt = "2030-01-01T00:00:00Z"; original.endedAt = "2030-01-01T00:00:10Z";
  original.argv = ["SYNTHETIC_PRIVATE_ARG"]; original.containerId = "c".repeat(64);
  const ref = { attemptId: "a".repeat(16), stage: "prepare", sha256: "d".repeat(64) }, receipt = { v: 1 as const, key: "e".repeat(64), source: ref, original: { wallSeconds: 10, gpuHours: 0, cpuSeconds: "unknown" as const }, verificationMs: 2, materializationMs: 3 };
  value.v = 3; value.status = "succeeded"; value.stage = "evaluator"; value.protocol = executionView(definition, 1); value.protocolHash = protocolHash(definition);
  value.pipeline = { definition, index: 1, completed: [
    { name: "prepare", ref, record: original, reuse: receipt },
    { name: "train", ref: { attemptId: value.id, stage: "train", sha256: "f".repeat(64) }, record: fresh },
  ], inputHashes: {}, taskTreeHash: "9".repeat(64) };
  value.stages = { evaluator: value.stages.evaluator! };
  value.reuse = { mode: "eligible", forceFresh: false, stages: { prepare: { outcome: "reused", reason: "hit", key: receipt.key, source: ref, verificationMs: 2, materializationMs: 3 }, train: { outcome: "fresh", reason: "missing", verificationMs: 1, materializationMs: 4 } }, verificationMs: 3, materializationMs: 7 };
  return value;
}

test("reuse projection counts original source computation separately from current execution and sample authority", () => {
  const value = fixture(), view = attemptReuseView(value)!;
  expect(view).toMatchObject({ executedCandidateStages: 1, reusedCandidateStages: 1, executedStages: 2, reusedStages: 1, freshEvaluations: 1, independentSamples: 0 });
  expect(view.sources[0]!.ref).toEqual(value.pipeline!.completed[0]!.ref);
  expect(view.costs).toEqual({ originalWallSeconds: 10, originalGpuHours: 0, originalCpuSeconds: "unknown", verificationMilliseconds: 3, materializationMilliseconds: 7, observedPreflightFailureMilliseconds: "unknown", totalFailureMilliseconds: "unknown", clockRelationship: "subsets-of-attempt-wall-do-not-sum", currentCpuSeconds: "unknown", storageBytes: "unknown", transferBytes: "unknown" });
  expect(JSON.stringify(view)).not.toContain("SYNTHETIC_PRIVATE_ARG"); expect(JSON.stringify(view)).not.toContain(value.executor.workdir);
  expect(JSON.stringify(view)).not.toContain(value.pipeline!.completed[0]!.record.containerId);
  expect(JSON.stringify(value)).toContain("SYNTHETIC_PRIVATE_ARG");
});

test("fresh controlled attempts retain independent counts while unknown source telemetry never becomes zero", () => {
  const value = fixture(); delete value.pipeline!.completed[0]!.reuse;
  value.pipeline!.completed[0]!.ref.attemptId = value.id;
  value.reuse!.stages.prepare!.outcome = "fresh";
  expect(attemptReuseView(value)).toMatchObject({ executedCandidateStages: 2, reusedStages: 0, independentSamples: 1 });
  value.retryOf = "a".repeat(16); expect(attemptReuseView(value)!.independentSamples).toBe(0);
  value.status = "failed"; expect(attemptReuseView(value)!.independentSamples).toBe(0);
  const unknown = fixture(); unknown.pipeline!.completed[0]!.reuse!.original.wallSeconds = "unknown"; unknown.pipeline!.completed[0]!.reuse!.original.gpuHours = "unknown";
  expect(attemptReuseView(unknown)!.costs.originalWallSeconds).toBe("unknown"); expect(attemptReuseView(unknown)!.costs.originalGpuHours).toBe("unknown");
  expect(attemptReuseView(metricAttempt())).toBeUndefined();
});

test("reuse view rejects forged source references and screens arbitrary diagnostic bodies", () => {
  const value = fixture(); value.reuse!.stages.train!.reason = "SYNTHETIC_PRIVATE_BODY https://example.test/private";
  expect(attemptReuseView(value)!.stages[1]!.reason).toBe("unknown");
  value.pipeline!.completed[0]!.reuse!.source.attemptId = value.id;
  expect(() => attemptReuseView(value)).toThrow("malformed-reuse-receipt");
});

class Element {
  hidden = false;
  constructor(readonly tag: string, readonly props: Record<string, unknown> = {}, public children: unknown[] = []) {}
  append(...children: unknown[]) { this.children.push(...children); }
  replaceChildren(...children: unknown[]) { this.children = children; }
  remove() { this.children = []; }
}
function descendants(element: Element): Element[] { return [element, ...element.children.flatMap(child => child instanceof Element ? descendants(child) : [])]; }
async function panel() {
  const module = await import(new URL("../src/ui/panel.js", import.meta.url).href), root = new Element("mount");
  let emit!: (value: Record<string, unknown>) => void, actions = 0;
  const h = (tag: string, props: Record<string, unknown> = {}, ...children: unknown[]) => new Element(tag, props, children);
  const ui = { h, button: (label: string, onClick: () => void, options = {}) => h("button", { label, onClick, ...options }), notice: (text: string, tone: string) => h("notice", { text, tone }), chip: (text: string, tone: string) => h("chip", { text, tone }), empty: (title: string, hint?: string) => h("empty", { title, hint }),
    rows: (items: unknown[], render: (item: unknown) => Element) => items.length ? h("rows", {}, ...items.map(render)) : null, row: (value: Record<string, unknown>) => h("row", value), table: (value: Record<string, unknown>) => h("table", value), form: (fields: unknown[], submit: unknown, onSubmit: unknown) => h("form", {fields, submit, onSubmit}), detail: (value: Record<string, unknown>) => h("detail", value), link: (value: unknown, label: string) => h("link", {value, label}) };
  const view = module.default({ ui, tool: "ares", mount: root, navigate: () => {}, onSnapshot: (handler: typeof emit) => { emit = handler; }, snapshot: async () => ({changed: false}), action: async () => { actions++; }, toast: () => {}, sheet: {open: () => h("sheet"), close: () => {}} });
  return { root, view, emit: (snapshot: Record<string, unknown>) => emit({changed: true, cursor: 1, ...snapshot}), actions: () => actions };
}
test("comparison console labels source compute, incremental overhead and non-independent reused samples without actions", async () => {
  const f = await panel(), value = fixture(), reuse = attemptReuseView(value), study = {id: "synthetic-study", dir: "/synthetic/registered", question: "Synthetic?", mode: "experiment"};
  f.view.show("compare", { study: study.dir });
  f.emit({ study, comparison: {v: 1, status: "ok", sourceSha256: "a".repeat(64), ledgerPosition: 1, rows: [{kind: "attempt", id: value.id, state: "available", reasons: [], attempts: [{id: value.id, code: {commit: value.commit, treeId: value.treeId}, protocolHash: value.protocolHash, seed: 1, status: "succeeded", retryOf: null, retryAncestry: [], sampleGroup: "sample", comparabilityReasons: ["reused-computation-not-independent"], metrics: value.metrics, artifactDigests: [], costs: {}, reuse}]}], issues: [], aggregation: {performed: false, available: false, compatible: false, reasons: ["reused-computation-not-independent"]}} });
  const rendered = JSON.stringify(descendants(f.root).map(node => ({tag: node.tag, ...node.props})));
  for (const text of ["reused: 1", "independent samples: 0", "original wall seconds: 10", "current verification ms: 3", "CPU/storage/transfer: unknown", "historical"]) expect(rendered).toContain(text);
  expect(rendered).toContain("a".repeat(16)); expect(rendered).not.toContain("SYNTHETIC_PRIVATE_ARG"); expect(f.actions()).toBe(0);
});
