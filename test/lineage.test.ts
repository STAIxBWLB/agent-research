import {expect, test} from "bun:test";
import * as fs from "node:fs";
import {join} from "node:path";
import {compareLineage, readProvenance, type ExecutionReferenceV1} from "../src/provenance.ts";
import {readTextBounded, writeAtomic, sha256} from "../src/study.ts";
import {ATTEMPT_BYTES} from "../src/exp/attempts.ts";
import * as ops from "../src/commands.ts";
import {provenanceFixture} from "./provenance-fixtures.ts";

test("#105 stored revision and malformed attempt-shaped skill evidence are explicit", async () => {
  const f = await provenanceFixture(), plan = join(f.dir, "plan.json"), text = readTextBounded(plan, 65_536), raw = JSON.parse(text); delete raw.revision; writeAtomic(plan, JSON.stringify(raw), 65_536);
  let page = readProvenance(f.dir); expect(page.status).toBe("unavailable"); expect(page.issues.some(issue => issue.code === "missing-stored-plan-revision")).toBe(true);
  writeAtomic(plan, text, 65_536);
  await ops.skillPropose(f.dir, {name: "unresolved-synthetic", summary: "Synthetic", steps: ["Inspect"], evidence: [`ares:${f.studyId}/attempt:invalid-suffix`]}, f.ctx);
  page = readProvenance(f.dir); expect(page.status).toBe("ok"); expect(page.nodes.find(node => node.ref.kind === "skill-proposal" && node.ref.id === "unresolved-synthetic")?.data?.additionalEvidence).toBe("declared-unresolved");
});

test("typed roots bind deterministic cursors and cannot cross study identity", async () => {
  const f = await provenanceFixture(), root: ExecutionReferenceV1 = {v: 1, tool: "ares", projectKey: f.studyId, kind: "attempt", id: f.ids.retryAttempt};
  const options = {root, nodeLimit: 2, edgeLimit: 3}, first = readProvenance(f.dir, options);
  expect(first.status).toBe("ok"); expect(first).toEqual(readProvenance(f.dir, options)); expect(first.nextCursor).toBeDefined();
  const next = readProvenance(f.dir, {...options, cursor: first.nextCursor!}); expect(next.status).toBe("ok");
  expect(readProvenance(f.dir, {...options, root: {...root, id: f.ids.finalWinnerAttempt}, cursor: first.nextCursor!}).issues[0]?.code).toBe("changed-cursor");
  expect(readProvenance(f.dir, {root: {...root, projectKey: "foreign-study"}}).issues[0]?.code).toBe("root-unavailable");
  expect(readProvenance(f.dir, {root: {...root, id: "f".repeat(16)}}).status).toBe("unavailable");
});

test("attempt comparison preserves failed outcomes and retry family without inventing arithmetic", async () => {
  const f = await provenanceFixture(), options = {attempts: [f.ids.interruptedAttempt, f.ids.retryAttempt]}, result = compareLineage(f.dir, options);
  expect(result.status).toBe("ok"); expect(result.rows.map(row => row.attempts[0]!.status)).toEqual(["failed", "succeeded"]);
  expect(result.rows[1]!.attempts[0]!.retryAncestry).toEqual([f.ids.interruptedAttempt]);
  expect(result.rows[0]!.attempts[0]!.sampleGroup).toBe(result.rows[1]!.attempts[0]!.sampleGroup);
  expect(result.retriesAreIndependent).toBe(false); expect(result.aggregation.performed).toBe(false); expect(result.aggregation.compatible).toBe(false);
  expect(result.aggregation.reasons).toContain("retries-or-repeated-samples-not-independent");
  expect(result.rows[1]!.attempts[0]!.artifactDigests).toContain(f.outputSHA);
  expect(result.rows[1]!.attempts[0]!.costs).toMatchObject({compute: "unknown", transfer: "unknown", person: "unknown"});
  expect(result.aggregation.available).toBe(false);
  const single = compareLineage(f.dir, {attempts: [f.ids.finalWinnerAttempt]});
  expect(single.aggregation).toEqual({performed: false, available: false, compatible: true, reasons: []});
  expect(result).toEqual(compareLineage(f.dir, options)); expect(result).not.toHaveProperty("winner");
});

test("candidate rows are the existing closed authority and keep every outcome", async () => {
  const f = await provenanceFixture(), file = join(f.dir, "runs/investigate/investigate.json"), closed = JSON.parse(readTextBounded(file, 1_048_576));
  const result = compareLineage(f.dir, {candidates: [f.commits.winner]});
  expect(result.status).toBe("ok"); expect(result.rows[0]!.candidate).toEqual(closed.candidates.find((row: {commit: string}) => row.commit === f.commits.winner));
  expect(result.rows[0]!.attempts.map(row => row.status).sort()).toEqual(["failed", "succeeded"]);
  const before = readTextBounded(file, 1_048_576); fs.unlinkSync(file);
  expect(compareLineage(f.dir, {candidates: [f.commits.winner]}).status).toBe("unavailable");
  expect(fs.existsSync(file)).toBe(false); writeAtomic(file, before, 1_048_576);
});

test("incompatible metric units cannot enable aggregation; no read changes authoritative files", async () => {
  const f = await provenanceFixture(), files = ["ledger.jsonl", "design/selection.json", "runs/final/final.json", "runs/investigate/investigate.json"], before = files.map(file => sha256(readTextBounded(join(f.dir, file), 64 * 1024 * 1024)));
  const file = join(f.dir, `runs/final/attempts/${f.ids.finalWinnerAttempt}.json`), record = JSON.parse(readTextBounded(file, ATTEMPT_BYTES)); record.metrics[0].unit = "different-unit"; writeAtomic(file, JSON.stringify(record), ATTEMPT_BYTES);
  const result = compareLineage(f.dir, {attempts: [f.ids.retryAttempt, f.ids.finalWinnerAttempt]});
  expect(result.rows).toHaveLength(2); expect(result.aggregation.compatible).toBe(false); expect(result.aggregation.reasons).toContain("incompatible-metrics"); expect(result.aggregation.performed).toBe(false);
  expect(files.map(file => sha256(readTextBounded(join(f.dir, file), 64 * 1024 * 1024)))).toEqual(before);
});

test("comparison selections are bounded, strict and preserve missing rows as unavailable", async () => {
  const f = await provenanceFixture();
  for (const options of [{attempts: []}, {attempts: Array(9).fill(f.ids.retryAttempt)}, {attempts: [f.ids.retryAttempt], candidates: [f.commits.winner]}, {attempts: ["bad"]}]) expect(() => compareLineage(f.dir, options)).toThrow("lineage compare");
  const missing = compareLineage(f.dir, {attempts: ["f".repeat(16)]}); expect(missing.rows[0]!.state).toBe("unavailable"); expect(missing.aggregation.compatible).toBe(false);
});

test("unknown attempts remain in comparison even when they invalidate a prior close", async () => {
  const f = await provenanceFixture(), file = join(f.dir, `runs/investigate/attempts/${f.ids.interruptedAttempt}.json`), record = JSON.parse(readTextBounded(file, ATTEMPT_BYTES));
  record.status = "unknown"; record.reason = "lost"; writeAtomic(file, JSON.stringify(record), ATTEMPT_BYTES);
  const {appendEvent} = await import("../src/study.ts"); appendEvent(f.dir, f.ctx.actor, "attempt.unknown", {id: record.id, run: record.run, status: "unknown"});
  const result = compareLineage(f.dir, {attempts: [record.id, f.ids.retryAttempt]});
  expect(result.rows).toHaveLength(2); expect(result.rows[0]!.attempts[0]!.status).toBe("unknown"); expect(result.rows[0]!.attempts[0]!.costs.storageBytes).toBe("unknown"); expect(result.aggregation.compatible).toBe(false);
});
