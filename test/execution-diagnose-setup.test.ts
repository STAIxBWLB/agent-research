import {expect, spyOn, test} from "bun:test";
import {mkdirSync, readdirSync, renameSync} from "node:fs";
import {join, resolve} from "node:path";
import * as study from "../src/study.ts";
import {showAttempt} from "../src/exp/attempts.ts";
import {bootstrapVisibleDiagnosticStudy} from "../scripts/execution-diagnose-setup.ts";
import {diagnoseTreatment} from "../scripts/execution-lineage.ts";
import {resolveDiagnosticFixture} from "../scripts/execution-diagnose.ts";
import {tempDir} from "./helpers.ts";

const root = resolve(import.meta.dir, "..");
const corpus = JSON.parse(study.readTextBounded(join(root, "test/fixtures/execution-eval/corpus.json"), 65_536, {noFollow: true})) as {cases: {id: string; trial: string; input: string}[]};
const cases = corpus.cases.filter(row => row.trial === "diagnose");
function input(file: string): Record<string, unknown> {
  const wrapper = JSON.parse(study.readTextBounded(join(root, file), 16_384, {noFollow: true}));
  return wrapper.input;
}
/** Prior 047c8d6 observable contract: diagnostic equals the pure visible-fact resolver, native identity follows visible facts. */
test("all twelve cases preserve the reviewed bootstrap observable contract without any expected-label read", async () => {
  expect(cases).toHaveLength(12);
  const read = study.readTextBounded;
  const reads: string[] = [];
  const guard = spyOn(study, "readTextBounded").mockImplementation((file, bound, options) => {
    reads.push(String(file));
    if (/\.expected\.json$|evaluator-label-do-not-open/.test(String(file))) throw new Error("evaluator labels must not be opened");
    return read(file, bound, options);
  });
  try {
    for (const row of cases) {
      const value = input(row.input), baseline = resolveDiagnosticFixture(value), dir = tempDir(), work = tempDir();
      const labelHome = tempDir(), expected = join(labelHome, `${row.id}.expected.json`), renamed = join(labelHome, "evaluator-label-do-not-open.json");
      // A private poison label is renamed away; only the candidate payload goes into the helper.
      study.writeAtomic(expected, "not evaluator input", 1024, 0o600); renameSync(expected, renamed);
      Object.defineProperty(value, "expected", {get: () => {throw new Error("expected label property was accessed");}, enumerable: false});
      if (baseline.provenance.attemptId === null) {
        const result = diagnoseTreatment("/synthetic-unused-private-binding", value);
        expect(result.integration.state).toBe("skipped"); expect(result.diagnostic).toEqual(baseline);
        expect(readdirSync(dir)).toEqual([]); expect(readdirSync(work)).toEqual([]);
        continue;
      }
      await bootstrapVisibleDiagnosticStudy(value, dir, work);
      const result = diagnoseTreatment(dir, value);
      expect(result.integration.state).toBe("matched"); expect(result.diagnostic).toEqual(baseline);
      const nativeStudy = study.openStudy(dir).study, visible = value.attempts as Record<string, unknown>[];
      expect(nativeStudy.id).toBe((value.study as Record<string, unknown>).id);
      for (const fact of visible) {
        const record = showAttempt(dir, String(fact.id));
        expect({id: record.id, run: record.run, studyId: record.studyId, commit: record.commit, status: record.status, seed: record.seed}).toEqual({
          id: fact.id, run: fact.run ?? "investigate", studyId: nativeStudy.id, commit: fact.commit, status: fact.status, seed: fact.seed ?? 1,
        });
        expect(record.metrics).toEqual([]);
        expect(record.retryOf ?? null).toBe(fact.parentAttemptId ?? null);
        const artifact = value.artifact as Record<string, unknown>;
        expect(record.outputs.map(output => output.sha256)).toEqual(artifact.producerAttemptId === fact.id && typeof artifact.digest === "string" ? [artifact.digest] : []);
        expect(record.paths.output).toBe(join(work, nativeStudy.id, String(fact.id), "output"));
        expect(record.label).toBe("synthetic metadata scaffolding");
      }
      const producer = result.integration.producerView!.comparison.rows[0]!.attempts[0]!;
      expect(producer.id).toBe(baseline.provenance.attemptId); expect(producer.code.commit).toBe(baseline.provenance.head);
      expect(producer.status).toBe(baseline.provenance.status); expect(producer.retryOf).toBe(baseline.retryOf ?? null);
    }
    expect(reads.some(file => /\.expected\.json$|evaluator-label-do-not-open/.test(file))).toBe(false);
  } finally {guard.mockRestore();}
}, 20_000);

test("visible identity preflight refuses path escapes and malformed fields before any study write", async () => {
  const original = input(cases[0]!.input);
  const changes = [
    (value: Record<string, any>) => {value.study.id = "../outside";},
    (value: Record<string, any>) => {value.attempts[0].id = "../../outside";},
    (value: Record<string, any>) => {value.attempts[0].run = "../outside";},
    (value: Record<string, any>) => {value.attempts[0].commit = "/private/outside";},
    (value: Record<string, any>) => {value.attempts[0].status = "unsupported";},
    (value: Record<string, any>) => {value.attempts[0].parentAttemptId = "../parent";},
    (value: Record<string, any>) => {value.artifact.digest = "../digest";},
    (value: Record<string, any>) => {value.attempts[0].seed = 1.5;},
  ];
  for (const change of changes) {
    const value = structuredClone(original), dir = tempDir(), work = tempDir(); change(value);
    await expect(bootstrapVisibleDiagnosticStudy(value, dir, work)).rejects.toThrow("execution diagnose setup:");
    expect(readdirSync(dir)).toEqual([]); expect(readdirSync(work)).toEqual([]);
  }
});

test("caller-owned fixture directories must be distinct fresh physical directories", async () => {
  const value = input(cases[0]!.input), dir = tempDir(), work = tempDir();
  await expect(bootstrapVisibleDiagnosticStudy(value, dir, dir)).rejects.toThrow("overlap");
  mkdirSync(join(dir, "occupied"));
  await expect(bootstrapVisibleDiagnosticStudy(value, dir, work)).rejects.toThrow("not fresh");
  expect(readdirSync(work)).toEqual([]);
});
