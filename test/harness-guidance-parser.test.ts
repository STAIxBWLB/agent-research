import {describe, expect, test} from "bun:test";
import {HUB_GUIDANCE_READ_BYTES, parseHubGuidanceReadResult} from "../src/harness/hub-guidance.ts";

function fixture() {
  return {state: "available", records: [{
    id: "a".repeat(64), experimentId: "[withheld]", taskId: 1, taskCreated: 0, flowRevision: 0, roleId: "implementer", layer: "project",
    baselineSha256: "b".repeat(64), candidateSha256: "c".repeat(64), changedSections: ["Evidence", "Scope"],
    bytes: {baseline: 1, candidate: 8192, record: 32768}, author: "codex", status: "declared", applicable: true,
    rationale: {problemHypothesis: "[withheld]", expectedObservableDifference: "첫 줄\nsecond line"},
    evidence: [{key: "d".repeat(64), status: "unavailable"}],
  }]};
}

describe("inert public hub guidance projection", () => {
  test("preserves screened metadata and omits rationale entirely", () => {
    const input = fixture();
    const result = parseHubGuidanceReadResult(input);
    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("available fixture required");
    const {rationale: _rationale, ...metadata} = input.records[0]!;
    expect(result.records).toEqual([metadata]);
    expect(result.rationaleOmitted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("problemHypothesis");
    expect(JSON.stringify(result)).not.toContain("첫 줄");
    expect(parseHubGuidanceReadResult(JSON.stringify(input))).toEqual(result);
    expect(parseHubGuidanceReadResult({state: "unavailable"})).toEqual({state: "unavailable"});
  });

  test("opaque whitespace identities and withheld rationale are preserved as valid inputs", () => {
    const input = fixture(); input.records[0]!.experimentId = "   ";
    expect(parseHubGuidanceReadResult(input).state).toBe("available");
    input.records[0]!.status = "withdrawn"; input.records[0]!.applicable = false;
    expect(parseHubGuidanceReadResult(input).state).toBe("available");
    input.records[0]!.applicable = true;
    expect(() => parseHubGuidanceReadResult(input)).toThrow("reload");
  });

  test("refuses extra fields, duplicate section/evidence keys and unsupported tokens", () => {
    expect(() => parseHubGuidanceReadResult({state: "unavailable", records: []})).toThrow("reload");
    for (const mutate of [
      (row: ReturnType<typeof fixture>["records"][number]) => {row.changedSections = ["Scope", "Scope"];},
      (row: ReturnType<typeof fixture>["records"][number]) => {row.evidence.push({...row.evidence[0]!});},
      (row: ReturnType<typeof fixture>["records"][number]) => {row.roleId = "Role";},
      (row: ReturnType<typeof fixture>["records"][number]) => {row.experimentId = "bad\nidentity";},
      (row: ReturnType<typeof fixture>["records"][number]) => {row.taskId = 0;},
      (row: ReturnType<typeof fixture>["records"][number]) => {row.bytes.candidate = 8193;},
    ]) {
      const input = fixture(); mutate(input.records[0]!);
      expect(() => parseHubGuidanceReadResult(input)).toThrow("reload");
    }
  });

  test("bounds rationale canonical JSON including escaping and the transport body", () => {
    const input = fixture();
    input.records[0]!.rationale.problemHypothesis = '"'.repeat(1000);
    expect(() => parseHubGuidanceReadResult(input)).toThrow("reload");
    expect(() => parseHubGuidanceReadResult(" ".repeat(HUB_GUIDANCE_READ_BYTES + 1))).toThrow("reload");
    const many = fixture(); many.records = Array.from({length: 17}, () => fixture().records[0]!);
    expect(() => parseHubGuidanceReadResult(many)).toThrow("reload");
  });

  test("does not invoke accessors, proxies, toJSON or sparse/augmented array hooks", () => {
    let calls = 0;
    const accessor = fixture();
    Object.defineProperty(accessor.records[0]!, "rationale", {enumerable: true, get() {calls++; return {};}});
    const proxy = new Proxy(fixture(), {ownKeys() {calls++; return [];}, get() {calls++; return undefined;}});
    const serializer = {...fixture(), toJSON() {calls++; return {};}};
    const indexed = fixture();
    Object.defineProperty(indexed.records, "0", {enumerable: true, get() {calls++; return {};}});
    const sparse = fixture(); delete sparse.records[0];
    const hidden = fixture(); Object.defineProperty(hidden, "secret", {value: "private", enumerable: false});
    const symbol = fixture(); Object.defineProperty(symbol.records, Symbol.iterator, {value() {calls++;}});
    for (const input of [accessor, proxy, serializer, indexed, sparse, hidden, symbol]) {
      expect(() => parseHubGuidanceReadResult(input)).toThrow("reload");
    }
    expect(calls).toBe(0);
  });

  test("errors never echo unknown fields or rationale", () => {
    const input = {...fixture(), "private-sensitive-field": "private-sensitive-text"};
    try {parseHubGuidanceReadResult(input); throw new Error("must refuse");}
    catch (error) {
      expect(String(error)).toContain("reload");
      expect(String(error)).not.toContain("private-sensitive");
    }
  });
});
