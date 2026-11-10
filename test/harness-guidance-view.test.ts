import {expect, spyOn, test} from "bun:test";
import {createHash} from "node:crypto";
import * as fs from "node:fs";
import * as child from "node:child_process";
import {join} from "node:path";
import {readTextBounded} from "../src/study.ts";
import {parseHubGuidanceReadResult} from "../src/harness/hub-guidance.ts";
import {parseHarnessVariant, parseVariantFixture, HARNESS_FIXTURE_BYTES} from "../src/harness/receipts.ts";

interface NativeGoldenRecord {
  v: 1; id: string; projectKey: string; experimentId: string; taskId: number; taskCreated: number; flowRevision: number;
  baseline: {roleId: string; layer: "project" | "shipped"; sha256: string; bytes: string}; candidate: {sha256: string; bytes: string};
  author: string; rationale: {problemHypothesis: string; expectedObservableDifference: string};
  evidenceRefs: {v: 1; tool: string; projectKey: string; kind: string; id: string; revision?: string; sha256?: string}[];
}
const golden = JSON.parse(readTextBounded(join(import.meta.dir, "fixtures", "guidance-variant-v1.json"), 65_536)) as {contract: string; golden: {expectedId: string; record: NativeGoldenRecord}};
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const NAME = "Fictional Mina Example", PHONE = "000-0000-0000";
const privateRationale = {problemHypothesis: `${NAME} wrote a fictional diagnostic note.\nPhone-shaped synthetic marker ${PHONE}.`, expectedObservableDifference: `A private-looking fixture only.\n${NAME} ${PHONE}.`};
function native(index?: number): NativeGoldenRecord {
  const value = structuredClone(golden.golden.record);
  if (index !== undefined) {
    value.author = `editor-${index}`;
    const {id: _id, ...payload} = value;
    value.id = hash(JSON.stringify(["agent-hub.guidance-variant/v1", payload]));
  }
  return value;
}
/** Independently form only the public metadata. Raw role bodies and evidence addresses never enter the view. */
function publicRecord(index?: number) {
  const value = native(index);
  return {id: value.id, experimentId: value.experimentId, taskId: value.taskId, taskCreated: value.taskCreated, flowRevision: value.flowRevision,
    roleId: value.baseline.roleId, layer: value.baseline.layer, baselineSha256: hash(value.baseline.bytes), candidateSha256: hash(value.candidate.bytes),
    changedSections: ["Scope"] as ("Scope" | "Deliverables" | "Evidence")[], bytes: {baseline: Buffer.byteLength(value.baseline.bytes, "utf8"), candidate: Buffer.byteLength(value.candidate.bytes, "utf8"), record: Buffer.byteLength(JSON.stringify(value), "utf8")},
    author: value.author, status: "declared" as "declared" | "withdrawn", applicable: true, rationale: {...value.rationale},
    evidence: value.evidenceRefs.map(reference => ({key: hash(JSON.stringify(reference)), status: "declared" as "declared" | "unavailable"})),
  };
}
function publicReadResult() { return {state: "available" as const, records: [publicRecord()]}; }
function withoutRationale(value: ReturnType<typeof publicRecord>) { const {rationale: _rationale, ...metadata} = value; return metadata; }
function refusesWithoutPrivateLeak(call: () => unknown) {
  let caught: unknown;
  try {call();} catch (error) {caught = error;}
  expect(caught).toBeInstanceOf(Error);
  const message = caught instanceof Error ? caught.message : "";
  expect(message).not.toContain(NAME); expect(message).not.toContain(PHONE);
  expect(message).not.toContain(privateRationale.problemHypothesis); expect(message).not.toContain(privateRationale.expectedObservableDifference);
}

test("pinned native golden identities and raw UTF-8 hashes/counts survive as public metadata without lossy remapping", () => {
  const value = native(), {id, ...payload} = value;
  expect(golden.contract).toBe("GuidanceVariantV1"); expect(id).toBe(golden.golden.expectedId);
  expect(hash(JSON.stringify(["agent-hub.guidance-variant/v1", payload]))).toBe(golden.golden.expectedId);
  expect(hash(value.baseline.bytes)).toBe(value.baseline.sha256); expect(hash(value.candidate.bytes)).toBe(value.candidate.sha256);
  const view = publicReadResult(), mapped = parseHubGuidanceReadResult(view);
  expect(mapped).toEqual({state: "available", records: [withoutRationale(view.records[0]!)], rationaleOmitted: true});
  if (mapped.state !== "available") throw new Error("available golden view required");
  expect(mapped.records[0]).toMatchObject({id: golden.golden.expectedId, experimentId: "experiment-a", taskId: 42, taskCreated: 100, flowRevision: 3, roleId: "test-engineer", layer: "project", changedSections: ["Scope"]});
  expect(typeof mapped.records[0]!.taskId).toBe("number");
  const serialized = JSON.stringify(mapped);
  for (const withheld of ["## Scope", "Check observable behavior.", "evidenceRefs", "projectKey", value.projectKey]) expect(serialized).not.toContain(withheld);
  expect(parseHubGuidanceReadResult(JSON.stringify(view))).toEqual(mapped);
  expect(parseHarnessVariant(view)).toEqual({format: "hub-public", view: mapped});
  expect(parseHarnessVariant(JSON.stringify(view))).toEqual({format: "hub-public", view: mapped});
});

test("public lifecycle, opaque experiment identity and changed-section order remain source metadata", () => {
  const view = publicReadResult(), row = view.records[0]!;
  row.experimentId = "withheld"; row.layer = "shipped"; row.taskCreated = 0; row.flowRevision = 0;
  row.changedSections = ["Evidence", "Deliverables"]; row.status = "withdrawn"; row.applicable = false; row.evidence[0]!.status = "unavailable";
  row.rationale = {problemHypothesis: "withheld", expectedObservableDifference: "withheld"};
  expect(parseHubGuidanceReadResult(view)).toEqual({state: "available", records: [withoutRationale(row)], rationaleOmitted: true});
  row.status = "declared"; expect(parseHubGuidanceReadResult(view).state).toBe("available");
  row.status = "withdrawn"; row.applicable = true; refusesWithoutPrivateLeak(() => parseHubGuidanceReadResult(view));
  expect(parseHubGuidanceReadResult({state: "unavailable"})).toEqual({state: "unavailable"});
  expect(parseHarnessVariant({state: "unavailable"})).toEqual({format: "hub-public", view: {state: "unavailable"}});
});

test("sixteen independently addressed native variants fit while seventeen refuse without exposing records", () => {
  const records = Array.from({length: 16}, (_, index) => publicRecord(index));
  expect(new Set(records.map(record => record.id)).size).toBe(16);
  const mapped = parseHubGuidanceReadResult({state: "available", records});
  if (mapped.state !== "available") throw new Error("available bounded view required");
  expect(mapped.records).toEqual(records.map(withoutRationale));
  refusesWithoutPrivateLeak(() => parseHubGuidanceReadResult({state: "available", records: [...records, publicRecord(16)]}));
});

test("multiline synthetic PII-shaped rationale is shape-checked and omitted from every successful projection", () => {
  const view = publicReadResult(); view.records[0]!.rationale = {...privateRationale};
  const mapped = parseHubGuidanceReadResult(view);
  expect(mapped.state).toBe("available");
  expect(mapped).toEqual({state: "available", records: [withoutRationale(view.records[0]!)], rationaleOmitted: true});
  for (const result of [mapped, parseHarnessVariant(view), parseHubGuidanceReadResult(JSON.stringify(view))]) {
    const serialized = JSON.stringify(result);
    for (const hidden of [NAME, PHONE, "problemHypothesis", "expectedObservableDifference"]) expect(serialized).not.toContain(hidden);
  }
});

test("malformed, over-bound, raw snapshot and unknown field errors never echo planted rationale or field names", () => {
  const view = publicReadResult(); view.records[0]!.rationale = {...privateRationale};
  const row = view.records[0]!;
  const invalid: unknown[] = [
    {...view, [NAME]: PHONE}, {state: "unavailable", [NAME]: PHONE}, {...view, records: [row, {...row}]},
    {...view, records: [{...row, [NAME]: PHONE}]}, {...view, records: [{...row, rationale: {...row.rationale, [NAME]: PHONE}}]},
    {...view, records: [{...row, baseline: {bytes: golden.golden.record.baseline.bytes}}]},
    {...view, records: [{...row, evidenceRefs: golden.golden.record.evidenceRefs}]},
    {...view, records: [{...row, taskId: "42"}]}, {...view, records: [{...row, taskCreated: -1}]}, {...view, records: [{...row, flowRevision: 0.5}]},
    {...view, records: [{...row, bytes: {...row.bytes, record: 32769}}]}, {...view, records: [{...row, bytes: {...row.bytes, baseline: 8193}}]},
    {...view, records: [{...row, rationale: {...row.rationale, problemHypothesis: `${NAME} ${PHONE} ${"x".repeat(2001)}`}}]},
    {state: "available", records: [golden.golden.record]},
  ];
  for (const raw of invalid) {
    refusesWithoutPrivateLeak(() => parseHubGuidanceReadResult(raw));
    refusesWithoutPrivateLeak(() => parseHarnessVariant(raw));
  }
});

test("accessors, proxies and toJSON are rejected without execution, including on omitted rationale", () => {
  let invoked = 0;
  const forbidden = (): never => {invoked++; throw new Error(`${NAME} ${PHONE}`);};
  const getter = publicReadResult(); Object.defineProperty(getter, "state", {enumerable: true, get: forbidden});
  const nestedGetter = publicReadResult(); Object.defineProperty(nestedGetter.records[0]!.rationale, "problemHypothesis", {enumerable: true, get: forbidden});
  const arrayGetter = publicReadResult(); Object.defineProperty(arrayGetter.records, "0", {enumerable: true, get: forbidden});
  const toJSON = publicReadResult(); Object.defineProperty(toJSON.records[0]!.rationale, "toJSON", {enumerable: false, value: forbidden});
  const rootJSON = publicReadResult(); Object.defineProperty(rootJSON, "toJSON", {enumerable: false, value: forbidden});
  const proxy = new Proxy(publicReadResult(), {get: forbidden, ownKeys: forbidden, getPrototypeOf: forbidden});
  const nestedProxy = publicReadResult(); nestedProxy.records[0]!.rationale = new Proxy({...privateRationale}, {get: forbidden, ownKeys: forbidden, getPrototypeOf: forbidden});
  for (const raw of [getter, nestedGetter, arrayGetter, toJSON, rootJSON, proxy, nestedProxy]) {
    refusesWithoutPrivateLeak(() => parseHubGuidanceReadResult(raw)); refusesWithoutPrivateLeak(() => parseHarnessVariant(raw));
  }
  expect(invoked).toBe(0);
});

test("format dispatch retains the legacy ares fixture and performs no implicit model/process/source IO", () => {
  const legacy = readTextBounded(join(import.meta.dir, "fixtures", "harness-rounds", "variant.json"), HARNESS_FIXTURE_BYTES), parsed = parseVariantFixture(legacy), view = publicReadResult();
  const forbidden = (): never => {throw new Error("implicit mapper IO forbidden");};
  const open = spyOn(fs, "openSync").mockImplementation(forbidden), spawn = spyOn(child, "spawn").mockImplementation(forbidden), sync = spyOn(child, "spawnSync").mockImplementation(forbidden);
  const bun = spyOn(Bun, "spawn").mockImplementation(forbidden), bunSync = spyOn(Bun, "spawnSync").mockImplementation(forbidden);
  const preconnect = spyOn(globalThis.fetch, "preconnect").mockImplementation(forbidden), fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(forbidden, {preconnect}));
  try {
    expect(parseHarnessVariant(legacy)).toEqual({format: "ares-fixture", variant: parsed});
    expect(parseVariantFixture(legacy)).toEqual(parsed);
    expect(parseHarnessVariant(view).format).toBe("hub-public");
    for (const spy of [open, spawn, sync, bun, bunSync, fetch, preconnect]) expect(spy).not.toHaveBeenCalled();
  } finally {open.mockRestore(); spawn.mockRestore(); sync.mockRestore(); bun.mockRestore(); bunSync.mockRestore(); fetch.mockRestore(); preconnect.mockRestore();}
});
