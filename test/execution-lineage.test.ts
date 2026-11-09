import { expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as lineage from "../src/provenance.ts";
import { diagnoseTreatment, LINEAGE_TREATMENT_BYTES } from "../scripts/execution-lineage.ts";
import { resolveDiagnosticFixture, DIAGNOSTIC_BYTES } from "../scripts/execution-diagnose.ts";
import { init, protocol as setProtocol } from "../src/commands.ts";
import { designBinding, protocolHash } from "../src/exp/protocol.ts";
import { ATTEMPT_BYTES } from "../src/exp/attempts.ts";
import { metricAttempt, metricProtocol } from "./metric-fixtures.ts";
import { provenanceFixture } from "./provenance-fixtures.ts";
import { commit, plain, readJsonFile, readTextBounded, readBytesBounded, sha256, STUDY_BYTES, writeAtomic } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const LEDGER_BYTES = 64 * 1024 * 1024;
const root = resolve(import.meta.dir, ".."), actor = {kind: "person" as const, id: "synthetic-fixture-bootstrap"};
const corpus = JSON.parse(readTextBounded(join(root, "test/fixtures/execution-eval/corpus.json"), 65_536)) as {cases: {trial: string; input: string}[]};
const cases = corpus.cases.filter(row => row.trial === "diagnose");
function payload(file: string): Record<string, unknown> { const wrapper = JSON.parse(readTextBounded(join(root, file), DIAGNOSTIC_BYTES)); return wrapper.input; }
/** Unit scaffolding from visible ids/commit/status/parent facts only, never expected files or outcomes. */
async function bootstrap(value: Record<string, unknown>) {
  const dir = tempDir(), work = tempDir(), created = init(dir, {question: "Synthetic producer metadata fixture", mode: "experiment"}, {actor});
  const study = plain(value.study) ? value.study : {}, nativeStudy = {...created.study, id: study.id};
  writeAtomic(join(dir, "study.json"), JSON.stringify(nativeStudy) + "\n", STUDY_BYTES);
  mkdirSync(join(dir, "task", "evaluator"), {recursive: true}); writeAtomic(join(dir, "task", "task.md"), "synthetic task", 1024);
  const visible = Array.isArray(value.attempts) ? value.attempts.filter(plain) : [], seeds = [...new Set(visible.map(attempt => Number.isSafeInteger(attempt.seed) ? Number(attempt.seed) : 1))];
  const protocol = {...metricProtocol(), seeds}; await setProtocol(dir, protocol, {actor, http: fakeHttp([]).http});
  const artifact = plain(value.artifact) ? value.artifact : {}, events = Array.isArray(value.events) ? value.events.filter(plain) : [];
  for (const fact of visible) {
    const record = metricAttempt(), id = String(fact.id), run = typeof fact.run === "string" ? fact.run : "investigate", recordPath = join(dir, "runs", run, "attempts", `${id}.json`);
    Object.assign(record, {id, studyId: study.id, commit: fact.commit, status: fact.status, seed: Number.isSafeInteger(fact.seed) ? fact.seed : 1, run,
      protocol, protocolHash: protocolHash(protocol), sealBinding: designBinding(dir)!, metrics: [], outputs: [], label: "synthetic metadata scaffolding", executor: {v: 1, kind: "local", workdir: work},
      paths: {snapshot: join(work, String(study.id), id, "snapshot"), output: join(work, String(study.id), id, "output"), evaluator: join(work, String(study.id), id, "evaluator"), result: join(work, String(study.id), id, "result")}});
    if (fact.status === "running") delete record.endedAt; else record.endedAt = "2030-01-01T00:00:01Z";
    if (typeof fact.parentAttemptId === "string" && events.some(event => event.type === "retry.requested" && event.childAttemptId === fact.id && event.sourceAttemptId === fact.parentAttemptId)) record.retryOf = fact.parentAttemptId;
    if (artifact.producerAttemptId === fact.id && typeof artifact.digest === "string") record.outputs = [{path: join(work, String(study.id), id, "output", "artifact.json"), sha256: artifact.digest, bytes: 0}];
    commit(dir, [[recordPath, JSON.stringify(record) + "\n", 1024 * 1024]], [
      {actor, type: "attempt.started", data: {id, run, commit: fact.commit, seed: record.seed}},
      {actor, type: `attempt.${String(fact.status)}`, data: {id, run, stage: record.stage, status: fact.status}},
    ]);
  }
  return dir;
}

test("all twelve frozen Diagnose payloads use bound native metadata or explicit safe skipped uncertainty", async () => {
  expect(cases).toHaveLength(12);
  for (const row of cases) {
    const input = payload(row.input), baseline = resolveDiagnosticFixture(input);
    const dir = baseline.provenance.attemptId === null ? "/synthetic-not-opened" : await bootstrap(input);
    const result = diagnoseTreatment(dir, input);
    expect(result).toMatchObject({kind: "fixture-integration-only", authority: "harness-observed", humanTimeToFind: "unknown", costs: "unknown", resultAuthority: {selection: false, final: false, adoption: false}});
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LINEAGE_TREATMENT_BYTES);
    if (baseline.provenance.attemptId === null) { expect(result.integration.state).toBe("skipped"); expect(result.integration.evidenceSha256).toBeNull(); }
    else { expect(result.integration.state).toBe("matched"); expect(result.integration.evidenceSha256).toHaveLength(64); expect(result.integration.producerView!.comparison.rows[0]!.attempts[0]!.code.commit).toBe(baseline.provenance.head!); }
    expect(result.diagnostic).toEqual(baseline);
  }
});

test("private and corrupt null-producer payloads never query native APIs or resolve candidate locators", () => {
  const read = spyOn(lineage, "readProvenance").mockImplementation(() => { throw new Error("private query forbidden"); });
  const compare = spyOn(lineage, "compareLineage").mockImplementation(() => { throw new Error("private query forbidden"); });
  try {
    for (const row of cases.filter(row => /privacy-gap|corrupt-source/.test(row.input))) {
      const input = payload(row.input); input.source = {...(plain(input.source) ? input.source : {}), reference: "/private/candidate-reference-must-not-open"};
      expect(diagnoseTreatment("/private/explicit-binding-unused", input).integration.state).toBe("skipped");
    }
    expect(read).not.toHaveBeenCalled(); expect(compare).not.toHaveBeenCalled();
  } finally { read.mockRestore(); compare.mockRestore(); }
});

async function rich() {
  const f = await provenanceFixture();
  const input = {study: {id: f.studyId, selectedHead: f.commits.winner}, attempts: [
    {id: f.ids.interruptedAttempt, commit: f.commits.winner, status: "failed", seed: 1},
    {id: f.ids.retryAttempt, commit: f.commits.winner, status: "succeeded", seed: 1, parentAttemptId: f.ids.interruptedAttempt},
  ], artifact: {producerAttemptId: f.ids.retryAttempt, commit: f.commits.winner, present: true, digest: f.outputSHA}, events: [{type: "retry.requested", sourceAttemptId: f.ids.interruptedAttempt, childAttemptId: f.ids.retryAttempt}]};
  return {f, input};
}
test("real product lineage and comparison cross-check producer and retry identities read-only", async () => {
  const {f, input} = await rich(), file = join(f.dir, "runs", "investigate", "attempts", `${f.ids.retryAttempt}.json`), before = readBytesBounded(file, ATTEMPT_BYTES), ledger = readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES);
  const result = diagnoseTreatment(f.dir, input);
  expect(result.integration.state).toBe("matched"); expect(result.diagnostic.retryOf).toBe(f.ids.interruptedAttempt);
  expect(result.integration.producerView!.lineage.edges.some(edge => edge.relation === "retryOf" && edge.from.id === f.ids.retryAttempt && edge.to.id === f.ids.interruptedAttempt)).toBe(true);
  expect(result.integration.producerView!.comparison.retriesAreIndependent).toBe(false);
  const conflict = structuredClone(input); conflict.attempts[0]!.commit = f.commits.baseline; conflict.attempts[1]!.commit = f.commits.baseline; conflict.artifact.commit = f.commits.baseline;
  expect(diagnoseTreatment(f.dir, conflict)).toMatchObject({integration: {state: "conflicting", reason: "producer-conflict"}, diagnostic: {provenance: {attemptId: null, status: "unknown", completeness: "lineage-conflicting"}}});
  const noParent = {...input, attempts: [{id: f.ids.retryAttempt, commit: f.commits.winner, status: "succeeded", seed: 1}]};
  expect(diagnoseTreatment(f.dir, noParent).integration.reason).toBe("retry-conflict");
  expect(readBytesBounded(file, ATTEMPT_BYTES)).toEqual(before); expect(readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES)).toEqual(ledger);
}, 20_000);

test("missing corrupt and capped product sources never retain a favorable pure diagnostic", async () => {
  const {f, input} = await rich(), file = join(f.dir, "runs", "investigate", "attempts", `${f.ids.retryAttempt}.json`), raw = readTextBounded(file, 1024 * 1024);
  writeAtomic(file, "{", 1024 * 1024);
  const corrupt = diagnoseTreatment(f.dir, input); expect(corrupt.integration.state).toBe("unavailable"); expect(corrupt.diagnostic.provenance.status).toBe("unknown"); expect(readTextBounded(file, 1024)).toBe("{");
  writeAtomic(file, raw, 1024 * 1024);
  const attempt = readJsonFile(file, 1024 * 1024) as Record<string, unknown>;
  attempt.outputs = Array.from({length: 150}, (_, i) => ({path: join(tempDir(), `synthetic-output-${i}`), sha256: sha256(`synthetic-output-${i}`), bytes: 0}));
  writeAtomic(file, JSON.stringify(attempt) + "\n", 1024 * 1024);
  const capped = diagnoseTreatment(f.dir, input); expect(capped.integration.state).toBe("unavailable"); expect(capped.integration.reason).toBe("lineage-capped"); expect(capped.diagnostic.provenance.status).toBe("unknown");
  expect(diagnoseTreatment(tempDir(), input).integration.state).toBe("unavailable");
}, 20_000);
