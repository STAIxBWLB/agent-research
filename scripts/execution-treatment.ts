import { realpathSync } from "node:fs";
import { join } from "node:path";
import {loadSupervisionAmendmentCases} from "./execution-supervision-amendment.ts";
import { bindRunCode } from "./execution-code-binding.ts";
import { FROZEN_RECEIPT, filePath, verifyPreregistration } from "./execution-eval.ts";
import { plain, readTextBounded, sha256 } from "../src/study.ts";

export interface TreatmentCase {
  id: string; trial: "diagnose" | "reuse" | "supervision"; scenario: string;
  inputSha256: string; expectedSha256: string; payload: Record<string, unknown>;
}
function fail(cause: string): never {
  throw new Error(`execution treatment integration: ${cause}; restore the frozen corpus and clean source checkout before integration-check; treatment trials require separate authorization`);
}
/** Candidate adapters receive input bytes only, never evaluator truth. No producer is executed here. */
export function treatmentCases(rootArg: string): { registration: ReturnType<typeof verifyPreregistration>; cases: TreatmentCase[]; supervisionCases: number } {
  const root = realpathSync(rootArg), registration = verifyPreregistration(root, join(root, FROZEN_RECEIPT));
  const inputs = new Map(registration.inputFiles.map(file => [file.path, file.sha256]));
  const expected = new Map(registration.expectedFiles.map(file => [file.path, file.sha256]));
  const read = (name: string, bound: number) => {
    const text = readTextBounded(filePath(root, name), bound, { noFollow: true });
    if (sha256(text) !== inputs.get(name)) fail("input changed after frozen verification");
    const value: unknown = JSON.parse(text); if (!plain(value)) fail("input object required"); return value;
  };
  const corpus = read("test/fixtures/execution-eval/corpus.json", 65_536);
  if (!Array.isArray(corpus.cases) || corpus.cases.length > 48) fail("bounded corpus index required");
  const cases: TreatmentCase[] = []; let supervisionCases = 0;
  for (const row of corpus.cases) {
    if (!plain(row)) fail("case object required");
    if ((row.trial !== "diagnose" && row.trial !== "reuse" && row.trial !== "supervision") || typeof row.id !== "string" || typeof row.scenario !== "string" || typeof row.input !== "string" || typeof row.expected !== "string") fail("invalid case identity");
    const input = read(row.input, 16_384), truthHash = expected.get(row.expected);
    if (input.id !== row.id || input.trial !== row.trial || !plain(input.input) || !truthHash) fail("case is not bound to its frozen input/truth pair");
    if (row.trial === "supervision") supervisionCases++;
    cases.push({ id: row.id, trial: row.trial, scenario: row.scenario, inputSha256: inputs.get(row.input)!, expectedSha256: truthHash, payload: input.input });
  }
  return { registration, cases, supervisionCases };
}
/** Check-only admission plan. It does not run arms, schedule repetitions, write receipts or decide adoption. */
export async function validateTreatmentIntegration(rootArg: string) {
  const { registration, cases, supervisionCases } = treatmentCases(rootArg), code = bindRunCode(rootArg);
  const lineage = await import("./execution-lineage.ts"), reuse = await import("./execution-reuse.ts"), supervision = await import("./execution-supervision.ts"), records = await import("./execution-supervision-records.ts");
  if (typeof lineage.diagnoseTreatment !== "function" || typeof reuse.checkReuseTreatmentFixture !== "function" || typeof supervision.classifySupervisionFixture !== "function" || typeof supervision.scoreSupervisionRecords !== "function" || typeof records.readShadowSnapshot !== "function") fail("producer adapter unavailable");
  const supervisionCoverage = cases.filter(row => row.trial === "supervision").map(row => ({
    id: row.id, inputSha256: row.inputSha256, expectedSha256: row.expectedSha256, ...supervision.classifySupervisionFixture(row.payload),
  }));
  const unsupported = supervisionCoverage.filter(row => row.state === "unsupported").length;
  const amended = loadSupervisionAmendmentCases(rootArg);
  const amendmentCoverage = amended.cases.map(row => ({id: row.id, inputSha256: row.inputSha256, expectedSha256: row.expectedSha256,
    ...supervision.classifySupervisionV2Fixture(row.payload)}));
  return {
    v: 1 as const, kind: "synthetic-treatment-integration-check" as const, status: "integrated-not-measured" as const,
    authority: "harness-observed" as const, registrationReceiptSha256: registration.receiptSha256, bindings: registration.bindings, code,
    arms: {
      diagnose: { status: "integrated-read-only", adapter: "diagnoseTreatment", producer: "ares-lineage", cases: cases.filter(row => row.trial === "diagnose").length },
      reuse: { status: "integrated-fresh-fallback", adapter: "checkReuseTreatmentFixture", producer: "ares-retained-stage-reuse", cases: cases.filter(row => row.trial === "reuse").length, sourceEstablishment: "opaque-frozen-sources-not-numeric-manifests" },
      supervision: { status: "integrated-record-reader", cases: supervisionCases, dependency: "agent-hub#1221", producerCommit: supervision.SUPERVISION_PRODUCER_COMMIT,
        reader: "readShadowSnapshot", scorer: "scoreSupervisionRecords", classifier: "classifySupervisionFixture", fakeShadow: false,
        coverage: { covered: supervisionCoverage.length - unsupported, unsupported, rows: supervisionCoverage }, helpful: null, false: null, missed: null, personDecisions: 0 as const,
        amendment: {corpusVersion: 2, status: amended.receipt.status, receiptSha256: amended.receipt.receiptSha256, amends: amended.receipt.amends,
          bindings: amended.receipt.bindings, cases: amendmentCoverage.length,
          coverage: {kind: "format-only", covered: amendmentCoverage.length, unsupported: 0, rows: amendmentCoverage},
          helpful: null, false: null, falseCases: null, falseProposals: null, wrongAction: null, missed: null, correctNonTriggers: null, personDecisions: 0 as const, trialExecutions: 0, treatmentObservations: 0} },
    },
    trialExecutions: 0, treatmentObservations: 0, adoptionDecision: null,
    limitations: ["integration checks only; T3 paired trials require separate launch authorization", "native container, model/account, human timing and measured cost benefit are unverified", "opaque frozen cached strings cannot establish numeric producer manifests; no hidden warmup or fabricated hits", "v2 format coverage is not producer evaluation coverage; no evaluator or trial was run", "frozen supervision task-state payloads are unsupported T1 rule facts; no translation, missed-trigger score or correct-non-trigger claim; corpus re-expression needs an owner decision before T3"],
  };
}
