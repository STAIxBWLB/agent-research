import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { parsePlaceholders, resolvePlaceholders, MANUSCRIPT_BYTES } from "../src/paper/placeholders.ts";
import { protocolHash, readProtocol } from "../src/exp/protocol.ts";
import { appendEvent, openStudy, sha256 } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), WIN = "b".repeat(40), ABL = "c".repeat(40);
let serial = 0;
function attempt(dir: string, run: string, commit: string, seed: number, value: number, status = "succeeded") {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
  const file = join(folder, `${id}.json`);
  writeFileSync(file, JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit, seed, protocolHash: protocolHash(protocol), protocol, executor: {}, stages: {}, stage: "evaluator", status, startedAt: "2030-01-01T00:00:00Z", metrics: [{ name: "score", value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run, commit, seed }); return { id, file };
}
async function setup(closed = true) {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  const image = `fixture@sha256:${"a".repeat(64)}`;
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image, command: ["candidate"] }, evaluator: { image, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1, 2], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx); await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  attempt(dir, "investigate", BASE, 1, 10); const measured = attempt(dir, "investigate", WIN, 1, 12);
  if (closed) {
    await ops.investigateClose(dir, ctx); await ops.ablateAdd(dir, { id: "without", commit: ABL, removes: "synthetic component" }, ctx);
    attempt(dir, "ablate", WIN, 1, 12); attempt(dir, "ablate", ABL, 1, 11); await ops.ablateClose(dir, ctx);
    await ops.gateDecide(dir, "final", "approve", undefined, ctx);
    attempt(dir, "final", BASE, 2, 10); attempt(dir, "final", WIN, 2, 12); await ops.finalClose(dir, ctx);
  }
  return { dir, measured };
}

test("grammar positions, literal escapes and decimal bounds are deterministic", () => {
  const text = "한글\nX {{n:final.delta|.2f}} {{lit:2026 cohort}}";
  const parsed = parsePlaceholders(text); expect(parsed.findings).toEqual([]);
  expect(parsed.placeholders[0]).toMatchObject({ line: 2, column: 3, kind: "number", ref: "final.delta", format: 2 });
  expect(parsed.placeholders[1]).toMatchObject({ kind: "literal", text: "2026 cohort" });
  for (let decimals = 0; decimals <= 6; decimals++) expect(parsePlaceholders(`{{n:final.mean|.${decimals}f}}`).findings).toEqual([]);
  for (const text of ["{{n:final.delta|.7f}}", "{{n:final.delta|2f}}", "{{n:}}", "{{lit:}}", "{{n:final.mean", "{{lit:bad {{n:final.mean}}}}", "{{n:final delta}}"])
    expect(parsePlaceholders(text).findings[0]?.code).toBe("bad-format");
});

test("combined n/lit bound is 5000 and manuscript reads are bounded", () => {
  expect(parsePlaceholders("{{lit:1}}".repeat(5000)).findings).toEqual([]);
  expect(parsePlaceholders("{{lit:1}}".repeat(5001)).findings[0]?.message).toContain("5000");
  expect(() => parsePlaceholders("x".repeat(MANUSCRIPT_BYTES + 1))).toThrow("2 MiB");
});

test("every closed-result family resolves exact values and bounded raw source hashes", async () => {
  const { dir, measured } = await setup(), posthoc = attempt(dir, "posthoc", WIN, 1, 14.125);
  const refs = ["final.status", "final.delta", "final.mean", "final.baselineMean", "final.attempts.succeeded", "final.attempts.failed", "investigate.winner", "investigate.winner.delta", "investigate.winner.mean", "investigate.baseline.mean", "investigate.totals.succeeded", "ablate:without.delta", "ablate:without.mean", "ablate:without.referenceMean", "ablate.totals.succeeded", `attempt:${measured.id}.score`, `posthoc:${posthoc.id}.score`];
  const ledger = readFileSync(join(dir, "ledger.jsonl")), final = readFileSync(join(dir, "runs", "final", "final.json"));
  const result = resolvePlaceholders(dir, refs.map(ref => `{{n:${ref}}}`).join(" | "));
  expect(result.findings).toEqual([]); expect(result.placeholders.map(p => p.value)).toEqual(["qualified", 2, 12, 10, 2, 0, WIN.slice(0, 12), 2, 12, 10, 2, -1, 11, 12, 2, 12, 14.125]);
  expect(result.rendered.endsWith("14.125 (exploratory)")).toBe(true);
  for (const entry of result.placeholders) expect(entry.source?.sha256).toBe(sha256(readFileSync(join(dir, entry.source!.file))));
  const formatted = resolvePlaceholders(dir, `{{n:final.delta|.0f}} {{n:final.mean|.6f}} {{n:posthoc:${posthoc.id}.score|.2f}} {{lit:2026}}`);
  expect(formatted.rendered).toBe("2 12.000000 14.13 (exploratory) 2026"); expect(formatted.literals).toHaveLength(1);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger); expect(readFileSync(join(dir, "runs", "final", "final.json"))).toEqual(final);
});

test("unknown, null, wrong-kind and text-format refs produce named findings without substitution", async () => {
  const { dir, measured } = await setup(), posthoc = attempt(dir, "posthoc", WIN, 1, 14);
  const refs = ["missing.delta", "final.reason", "investigate.reason", "ablate:missing.mean", "final.attempts.other", `attempt:${posthoc.id}.score`, `posthoc:${measured.id}.score`, `attempt:${measured.id}.missing`];
  const input = refs.map(ref => `{{n:${ref}}}`).join("\n"), result = resolvePlaceholders(dir, input);
  expect(result.findings).toHaveLength(refs.length); expect(result.findings.every(f => f.code === "unresolved-ref" && f.message.includes("before retrying"))).toBe(true); expect(result.rendered).toBe(input);
  for (const ref of ["final.status", "investigate.winner"]) expect(resolvePlaceholders(dir, `{{n:${ref}|.2f}}`).findings[0]?.code).toBe("bad-format");
});

test("absent and unclosed results are unresolved; survey literals work but experiment refs refuse", async () => {
  const { dir } = await setup(false);
  for (const ref of ["investigate.winner", "ablate:without.mean", "final.status"]) expect(resolvePlaceholders(dir, `{{n:${ref}}}`).findings[0]?.code).toBe("unresolved-ref");
  const survey = tempDir(); ops.init(survey, { question: "synthetic" }, ctx);
  expect(resolvePlaceholders(survey, "{{lit:2026}} {{n:final.status}}").findings[0]?.code).toBe("unresolved-ref");
  expect(resolvePlaceholders(survey, "{{lit:2026}}").rendered).toBe("2026");
});

test("changed attempt inputs invalidate closed investigate, ablate and final until reclosed", async () => {
  const { dir } = await setup(); attempt(dir, "investigate", WIN, 1, 99);
  const text = "{{n:investigate.winner}} {{n:ablate:without.mean}} {{n:final.status}}";
  expect(resolvePlaceholders(dir, text).findings).toHaveLength(3);
  await ops.investigateClose(dir, ctx); await ops.ablateClose(dir, ctx); await ops.gateDecide(dir, "final", "approve", undefined, ctx); await ops.finalClose(dir, ctx);
  expect(resolvePlaceholders(dir, text).findings).toEqual([]);
  attempt(dir, "final", WIN, 2, 100);
  expect(resolvePlaceholders(dir, "{{n:final.delta}}").findings[0]?.code).toBe("unresolved-ref");
  await ops.finalClose(dir, ctx); expect(resolvePlaceholders(dir, "{{n:final.delta}}").rendered).toBe("2");
});

test("hand-edited and unknown-version results stay unchanged and unresolved", async () => {
  const { dir } = await setup(), file = join(dir, "runs", "final", "final.json"), original = readFileSync(file, "utf8");
  for (const text of [original + " ", '{"v":99}', "x".repeat(1_048_577), "not JSON"]) {
    writeFileSync(file, text); const ledger = readFileSync(join(dir, "ledger.jsonl"));
    expect(resolvePlaceholders(dir, "{{n:final.status}}").findings[0]?.code).toBe("unresolved-ref");
    expect(readFileSync(file, "utf8")).toBe(text); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  }
});

test("negative reasons and attempt metric provenance remain explicit", async () => {
  const { dir, measured } = await setup(false); // Make no winner by lowering the candidate value.
  const data = JSON.parse(readFileSync(measured.file, "utf8")); data.metrics[0].value = 9; writeFileSync(measured.file, JSON.stringify(data)); await ops.investigateClose(dir, ctx);
  expect(resolvePlaceholders(dir, "{{n:investigate.reason}}").rendered).toBe("below-margin");
  expect(resolvePlaceholders(dir, "{{n:investigate.winner}}").findings[0]?.code).toBe("unresolved-ref");
  for (const status of ["running", "failed", "cancelled", "unknown"]) {
    data.status = status; writeFileSync(measured.file, JSON.stringify(data)); expect(resolvePlaceholders(dir, `{{n:attempt:${measured.id}.score}}`).findings[0]?.code).toBe("unresolved-ref");
  }
  data.status = "succeeded"; data.metrics[0].provenance = "candidate"; writeFileSync(measured.file, JSON.stringify(data));
  expect(resolvePlaceholders(dir, `{{n:attempt:${measured.id}.score}}`).findings[0]?.code).toBe("unresolved-ref");
});


test("negative final status/reason, final attempt edits and stale protocol metrics fail closed", async () => {
  const { dir, measured } = await setup();
  const failed = attempt(dir, "final", WIN, 2, 0, "failed"); // Later failure is listed, not decisive.
  await ops.finalClose(dir, ctx);
  const final = JSON.parse(readFileSync(join(dir, "runs", "final", "final.json"), "utf8"));
  const first = final.decisive.find((a: {commit:string}) => a.commit === WIN), file = join(dir, "runs", "final", "attempts", `${first.id}.json`);
  const data = JSON.parse(readFileSync(file, "utf8")); data.status = "failed"; writeFileSync(file, JSON.stringify(data));
  expect(resolvePlaceholders(dir, "{{n:final.status}}").findings[0]?.code).toBe("unresolved-ref");
  await ops.finalClose(dir, ctx);
  expect(resolvePlaceholders(dir, "{{n:final.status}} {{n:final.reason}} {{n:final.attempts.failed}}").rendered).toBe("not_qualified failed 2");
  expect(resolvePlaceholders(dir, "{{n:final.reason|.2f}}").findings[0]?.code).toBe("bad-format");
  const protocol = readProtocol(dir)!; await ops.protocol(dir, { ...protocol, method: "changed" }, ctx);
  expect(resolvePlaceholders(dir, `{{n:attempt:${measured.id}.score}}`).findings[0]?.code).toBe("unresolved-ref");
  expect(resolvePlaceholders(dir, `{{n:attempt:${failed.id}.score}}`).findings[0]?.code).toBe("unresolved-ref");
});
