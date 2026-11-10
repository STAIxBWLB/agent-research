import { existsSync, linkSync, lstatSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plain, readBytesBounded, readTextBounded, sha256, writeAtomic } from "../src/study.ts";

export const PREREGISTRATION = "docs/verification/execution-eval-preregistration.json";
export const PROTOCOL_DOC = "docs/verification/execution-eval-protocol.md";
export const FROZEN_RECEIPT = "docs/verification/execution-eval-frozen.json";
export const DENOMINATORS = ["full", "succeeded", "failed", "cancelled", "unknown", "excluded"] as const;
export const COST_FIELDS = ["cpuSeconds", "gpuDeviceSeconds", "providerTokens", "providerRequests", "wallElapsedMs", "storagePeakBytes", "storageByteSeconds", "transferBytes", "verificationCpuSeconds", "verificationWallMs", "retentionBytes", "retentionByteSeconds", "materializationCpuSeconds", "materializationWallMs", "materializationTransferBytes", "failureCpuSeconds", "failureGpuDeviceSeconds", "failureWallMs", "failureTransferBytes", "idleWallMs", "personMinutes", "monetaryEstimateUsd"] as const;
export type CostRecord = Record<typeof COST_FIELDS[number], number | "unknown">;
const DOCUMENT_BYTES = 65_536, FIXTURE_BYTES = 16_384, TOTAL_BYTES = 3 * 1024 * 1024, MAX_CASES = 48;
const TRIALS = ["diagnose", "reuse", "supervision"] as const;
const SCENARIOS = {
  diagnose: ["stale-head", "missing-artifact", "retry", "uncertain-delivery", "privacy-gap", "corrupt-source"],
  reuse: ["local-stage-edit", "global-code-change", "no-hit", "corrupt-artifact", "pruned-artifact", "interrupted-source"],
  supervision: ["ordinary-progress", "true-trigger", "misleading-symptom"],
} as const;
interface FileHash { path: string; sha256: string; bytes: number }
interface Bindings { protocolSha256: string; methodSha256: string; thresholdsSha256: string; denominatorsSha256: string; inputSha256: string; expectedSha256: string }
export interface FrozenPreregistration {
  v: 1; status: "preregistered-not-measured"; bindings: Bindings;
  methodFiles: FileHash[]; inputFiles: FileHash[]; expectedFiles: FileHash[]; receiptSha256: string;
}
function fail(cause: string, next = "restore the preregistered files or register a separately reviewed protocol and new receipt before any run"): never {
  throw new Error(`execution eval: ${cause}; ${next}`);
}
function object(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plain(raw) || Object.keys(raw).some(key => !keys.includes(key))) fail(`${label} has an invalid shape or unknown field`);
  return raw;
}
export function canonical(raw: unknown, depth = 0): string {
  if (depth > 24) fail("method nesting exceeds 24 levels");
  if (Array.isArray(raw)) return `[${raw.map(value => canonical(value, depth + 1)).join(",")}]`;
  if (plain(raw)) return `{${Object.keys(raw).sort().map(key => `${JSON.stringify(key)}:${canonical(raw[key], depth + 1)}`).join(",")}}`;
  return JSON.stringify(raw) ?? "null";
}
export function filePath(root: string, name: string): string {
  if (!/^[A-Za-z0-9_.\/-]{1,240}$/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..")) fail("source path is not a bounded repository-relative file");
  const parts = name.split("/"); let file = root;
  try {
    for (const [index, part] of parts.entries()) {
      file = join(file, part); const stat = lstatSync(file);
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail("source links or non-regular files are refused");
    }
  } catch (error) { if (error instanceof Error && error.message.startsWith("execution eval:")) throw error; fail("required preregistration source is missing or unreadable"); }
  return file;
}
function json(text: string, label: string): unknown { try { return JSON.parse(text); } catch { fail(`${label} is not valid JSON`); } }
/** Unknown is a literal measurement state, never zero. No totals combine CPU, device, wall, idle or person clocks. */
export function validateCostRecord(raw: unknown): CostRecord {
  if (!plain(raw) || Object.keys(raw).some(key => !(COST_FIELDS as readonly string[]).includes(key))) fail("cost record has an invalid shape or unknown field", "supply exactly the preregistered cost fields before validating the record");
  const value = raw;
  for (const key of COST_FIELDS) if (value[key] !== "unknown" && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0)) fail(`cost ${key} must be nonnegative measured units or unknown`, "correct the measurement or record unknown, then validate the cost record again");
  return { ...value } as CostRecord;
}
function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("preregistration JSON is not valid UTF-8"); }
}
function snapshot(root: string): FrozenPreregistration {
  let total = 0;
  const read = (name: string, bound: number) => {
    let bytes: Buffer;
    try { bytes = readBytesBounded(filePath(root, name), bound, { noFollow: true }); }
    catch (error) { if (error instanceof Error && error.message.startsWith("execution eval:")) throw error; fail("source read failed or exceeded its file bound"); }
    total += bytes.length; if (total > TOTAL_BYTES) fail("sources exceed the aggregate 3 MiB bound");
    return { bytes, hash: { path: name, sha256: sha256(bytes), bytes: bytes.length } };
  };
  const source = read(PREREGISTRATION, DOCUMENT_BYTES), protocol = object(json(utf8(source.bytes), "protocol"), ["v", "id", "status", "scope", "authority", "corpus", "trials", "design", "budgets", "metrics", "denominators", "thresholds", "costs", "reporting"], "protocol");
  if (protocol.v !== 1 || protocol.status !== "proposed-not-measured" || typeof protocol.id !== "string") fail("protocol version/status is unsupported");
  for (const key of ["scope", "authority", "design", "budgets", "metrics", "thresholds", "costs", "reporting"]) if (!plain(protocol[key])) fail(`protocol ${key} is missing`);
  if (canonical(protocol.denominators) !== canonical(DENOMINATORS)) fail("denominators changed or missing (full/succeeded/failed/cancelled/unknown/excluded required)");
  if (typeof protocol.corpus !== "string" || !protocol.corpus.startsWith("test/fixtures/execution-eval/")) fail("corpus must be an explicit synthetic fixture index");
  if (!Array.isArray(protocol.trials) || protocol.trials.length !== 3) fail("three preregistered trials are required");
  for (const trial of TRIALS) {
    const entry = protocol.trials.find(value => plain(value) && value.id === trial);
    if (!plain(entry) || !Number.isInteger(entry.repetitions) || (entry.repetitions as number) < 3 || (entry.repetitions as number) > 6 || !Array.isArray(entry.arms) || !entry.arms.length) fail(`trial ${trial} needs its arms and 3..6 repetitions`);
  }
  const costFields = (protocol.costs as Record<string, unknown>).fields;
  if (!plain(costFields) || canonical(Object.keys(costFields).sort()) !== canonical([...COST_FIELDS].sort())) fail("cost schema is missing required independent dimensions");
  const index = read(protocol.corpus, DOCUMENT_BYTES), corpus = object(json(utf8(index.bytes), "corpus"), ["v", "cases"], "corpus");
  if (corpus.v !== 1 || !Array.isArray(corpus.cases) || corpus.cases.length > MAX_CASES) fail("corpus version or 48-case bound is invalid");
  const ids = new Set<string>(), paths = new Set<string>(), inputs = [index.hash], expected: FileHash[] = [], counts = new Map<string, number>();
  const coverage = new Set<string>();
  for (const raw of corpus.cases) {
    const row = object(raw, ["id", "trial", "scenario", "input", "expected"], "corpus case");
    if (typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(row.id) || ids.has(row.id)) fail("corpus case id is invalid or duplicated");
    ids.add(row.id);
    if (!TRIALS.includes(row.trial as typeof TRIALS[number])) fail("corpus case trial is unknown");
    const trial = row.trial as typeof TRIALS[number];
    if (typeof row.scenario !== "string" || !(SCENARIOS[trial] as readonly string[]).includes(row.scenario)) fail("corpus case scenario is unknown");
    counts.set(trial, (counts.get(trial) ?? 0) + 1); coverage.add(`${trial}:${row.scenario}`);
    for (const visibility of ["input", "expected"] as const) {
      const name = row[visibility];
      if (typeof name !== "string" || !name.startsWith("test/fixtures/execution-eval/") || paths.has(name)) fail("corpus input/expected paths must be distinct synthetic files");
      paths.add(name); const fixture = read(name, FIXTURE_BYTES), data = json(utf8(fixture.bytes), "fixture");
      if (!plain(data) || data.v !== 1 || data.id !== row.id || data.trial !== trial || data.scenario !== row.scenario) fail("fixture identity does not match the corpus index");
      if (visibility === "input" && !plain(data.input)) fail("candidate input payload is missing; keep case labels outside candidate visibility");
      if (visibility === "expected" && trial === "supervision" && typeof data.trigger !== "boolean") fail("supervision truth label is missing");
      (visibility === "input" ? inputs : expected).push(fixture.hash);
    }
  }
  const plannedCases = (protocol.design as Record<string, unknown>).plannedCases;
  if (!plain(plannedCases)) fail("planned corpus denominator is missing");
  for (const trial of TRIALS) {
    if (counts.get(trial) !== plannedCases[trial]) fail(`corpus ${trial} count differs from its planned denominator`);
    if ((counts.get(trial) ?? 0) < (trial === "reuse" ? 10 : 12)) fail(`corpus ${trial} has fewer than its preregistered minimum cases`);
    for (const scenario of SCENARIOS[trial]) if (!coverage.has(`${trial}:${scenario}`)) fail(`corpus ${trial} lacks a required scenario`);
  }
  const methodDoc = read(PROTOCOL_DOC, DOCUMENT_BYTES);
  const bindings: Bindings = {
    protocolSha256: source.hash.sha256, methodSha256: sha256(canonical({ protocol, docSha256: methodDoc.hash.sha256 })), thresholdsSha256: sha256(canonical(protocol.thresholds)), denominatorsSha256: sha256(canonical(protocol.denominators)),
    inputSha256: sha256(canonical(inputs)), expectedSha256: sha256(canonical(expected)),
  };
  const body = { v: 1 as const, status: "preregistered-not-measured" as const, bindings, methodFiles: [source.hash, methodDoc.hash], inputFiles: inputs, expectedFiles: expected };
  return { ...body, receiptSha256: sha256(canonical(body)) };
}
export function verifyPreregistration(rootArg: string, receiptFile: string): FrozenPreregistration {
  const current = snapshot(resolve(rootArg));
  let raw: unknown;
  try { raw = json(readTextBounded(receiptFile, DOCUMENT_BYTES, { noFollow: true }), "frozen receipt"); }
  catch (error) { if (error instanceof Error && error.message.startsWith("execution eval:")) throw error; fail("frozen receipt is missing, unreadable or over-bound"); }
  const receipt = object(raw, ["v", "status", "bindings", "methodFiles", "inputFiles", "expectedFiles", "receiptSha256"], "frozen receipt");
  if (!plain(receipt.bindings)) fail("frozen receipt bindings are missing");
  for (const key of ["thresholdsSha256", "denominatorsSha256", "protocolSha256", "methodSha256", "inputSha256", "expectedSha256"] as const) if (receipt.bindings[key] !== current.bindings[key]) fail(`${key} changed since freeze`);
  if (canonical(receipt) !== canonical(current)) fail("frozen receipt content or seal changed");
  return current;
}
/** First freeze creates a private receipt exclusively. Subsequent freeze calls only verify; they never overwrite it. */
export function freezePreregistration(rootArg: string, receiptFile: string): FrozenPreregistration {
  if (existsSync(receiptFile)) return verifyPreregistration(rootArg, receiptFile);
  return publishEvaluationReceipt(receiptFile, snapshot(resolve(rootArg)), DOCUMENT_BYTES, () => verifyPreregistration(rootArg, receiptFile));
}
/** Shared exclusive publication: existing receipts are verified, never overwritten. */
export function publishEvaluationReceipt<T>(receiptFile: string, receipt: T, maxBytes: number, onExisting: () => T): T {
  const temporary = join(dirname(receiptFile), `.execution-eval-${randomUUID()}.tmp`);
  try {
    try { writeAtomic(temporary, JSON.stringify(receipt, null, 2) + "\n", maxBytes, 0o600); }
    catch { fail("receipt staging failed; choose an owned writable receipt directory"); }
    try { linkSync(temporary, receiptFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return onExisting(); fail("receipt publication failed (choose an owned directory with hard-link support)"); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return receipt;
}
if (import.meta.main) {
  void (async () => {
  const [command, output, ...extra] = process.argv.slice(2), root = fileURLToPath(new URL("..", import.meta.url));
  try {
    if (command === "integration-check") {
      if (output !== undefined || extra.length) fail("integration-check accepts no operands", "use bun scripts/execution-eval.ts integration-check; it never launches treatment trials");
      const { validateTreatmentIntegration } = await import("./execution-treatment.ts");
      console.log(JSON.stringify(await validateTreatmentIntegration(root)));
    } else if (command === "freeze-supervision-v2" || command === "verify-supervision-v2") {
      if (extra.length || output?.startsWith("-")) fail("Supervision amendment accepts at most one receipt path and no flags", "use bun scripts/execution-eval.ts freeze-supervision-v2|verify-supervision-v2 [receipt.json]; no evaluator or trial is run");
      const amendment = await import("./execution-supervision-amendment.ts");
      const file = resolve(output ?? join(root, amendment.AMENDMENT_RECEIPT));
      const receipt = command === "freeze-supervision-v2" ? amendment.freezeSupervisionAmendment(root, file) : amendment.verifySupervisionAmendment(root, file);
      console.log(JSON.stringify({command, status: receipt.status, receiptSha256: receipt.receiptSha256, amends: receipt.amends}));
    } else if (command === "freeze-reuse-rematerialization" || command === "verify-reuse-rematerialization") {
      if (extra.length || output?.startsWith("-")) fail("Reuse rematerialization accepts at most one receipt path and no flags", "use bun scripts/execution-eval.ts freeze-reuse-rematerialization|verify-reuse-rematerialization [receipt.json]; no evaluator or trial is run");
      const amendment = await import("./execution-reuse-rematerialize.ts");
      const file = resolve(output ?? join(root, amendment.REMATERIALIZATION_RECEIPT));
      const sealed = command === "freeze-reuse-rematerialization" ? amendment.sealReuseRematerialization(root, file) : amendment.verifyReuseRematerializationSeal(root, file);
      if (sealed.state !== "verified") fail(`reuse rematerialization receipt is ${sealed.state}`, "restore the committed receipt bytes or freeze a reviewed setup again");
      console.log(JSON.stringify({command, state: sealed.state, status: sealed.receipt.identity.status, setupSha256: sealed.receipt.setupSha256, amends: sealed.receipt.identity.amends}));
    } else if (command === "baseline") {
      if (!output || output.startsWith("-") || !isAbsolute(output) || extra.some(value => value !== "--emit") || extra.length > 1) fail("baseline arguments require an absolute output operand followed only by optional --emit", "use bun scripts/execution-eval.ts baseline /absolute/fresh-directory [--emit]; no other flags are supported");
      const { runBaseline, emitBaseline, BASELINE_BUNDLE_PREFIX } = await import("./execution-baseline.ts");
      const receipt = runBaseline(root, output, process.env.EXECUTION_EVAL_IMAGE_DIGEST ?? "");
      if (extra.includes("--emit")) console.log(BASELINE_BUNDLE_PREFIX + emitBaseline(output));
      else console.log(JSON.stringify({ authority: receipt.authority, codeSha256: receipt.code.codeSha256, registrationReceiptSha256: receipt.registrationReceiptSha256, denominators: receipt.denominators }));
    } else {
      if (extra.length || !["freeze", "verify"].includes(command ?? "")) fail("usage is bun scripts/execution-eval.ts freeze|verify [receipt.json], baseline OUTSIDE_DIR [--emit], integration-check, freeze-supervision-v2|verify-supervision-v2 [receipt.json], or freeze-reuse-rematerialization|verify-reuse-rematerialization [receipt.json]; no treatment-run or supervision command");
      const file = resolve(output ?? join(root, FROZEN_RECEIPT));
      const receipt = command === "freeze" ? freezePreregistration(root, file) : verifyPreregistration(root, file);
      console.log(JSON.stringify({ command, status: receipt.status, receiptSha256: receipt.receiptSha256 }));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : "execution eval: verification failed; restore the frozen protocol before any run"); process.exitCode = 1; }
  })();
}
