import { expect, test } from "bun:test";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { ATTEMPT_BYTES } from "../src/exp/attempts.ts";
import { cardPath } from "../src/lit/cards.ts";
import { resolvePointEvidence } from "../src/paper/point-evidence.ts";
import { writeAtomic } from "../src/study.ts";
import { metricAttempt } from "./metric-fixtures.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const ctx = {actor: {kind: "person" as const}, http: fakeHttp([]).http};
test("point evidence resolves existing failed and unknown attempts without inferring success", () => {
  const dir = tempDir(), {study} = ops.init(dir, {question: "Synthetic local record existence", mode: "experiment"}, ctx);
  const record = metricAttempt(), directory = join(dir, "runs", record.run, "attempts");
  mkdirSync(directory, {recursive: true}); record.studyId = study.id;
  const file = join(directory, `${record.id}.json`);
  for (const status of ["failed", "unknown"] as const) {
    record.status = status; writeAtomic(file, JSON.stringify(record), ATTEMPT_BYTES);
    expect(resolvePointEvidence(dir, `attempt:${record.id}`)).toEqual({resolved: true});
  }
  record.studyId = "synthetic-other-study"; writeAtomic(file, JSON.stringify(record), ATTEMPT_BYTES);
  expect(resolvePointEvidence(dir, `attempt:${record.id}`).resolved).toBe(false);
  writeAtomic(file, "{}", ATTEMPT_BYTES);
  expect(resolvePointEvidence(dir, `attempt:${record.id}`).resolved).toBe(false);
  unlinkSync(file); expect(resolvePointEvidence(dir, `attempt:${record.id}`).resolved).toBe(false);
});

test("card existence is validated locally and missing, malformed or unsupported addresses never resolve", () => {
  const dir = tempDir(); ops.init(dir, {question: "Synthetic card existence", mode: "survey"}, ctx);
  const id = "doi:10.0000/synthetic-card", file = cardPath(dir, id);
  mkdirSync(join(dir, "literature", "cards"), {recursive: true});
  writeAtomic(file, JSON.stringify({id, summary: "Synthetic extraction; no support judgment", claims: []}), 65_536);
  expect(resolvePointEvidence(dir, `card:${id}`)).toEqual({resolved: true});
  writeAtomic(file, JSON.stringify({id: "other", summary: "Synthetic", claims: []}), 65_536);
  expect(resolvePointEvidence(dir, `card:${id}`).resolved).toBe(false);
  writeAtomic(file, "x".repeat(65_537), 65_537);
  expect(resolvePointEvidence(dir, `card:${id}`).resolved).toBe(false);
  unlinkSync(file);
  for (const reference of [`card:${id}`, "card:", "attempt:invalid", "remote:source", "card:bad\0id", `card:${"x".repeat(4096)}`]) {
    const result = resolvePointEvidence(dir, reference);
    expect(result.resolved).toBe(false); expect(result.reason).toContain(";");
  }
});
