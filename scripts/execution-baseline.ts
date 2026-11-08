import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { arch, cpus, hostname, platform, release, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bindRunCode, RUN_CODE_FILE_BYTES } from "./execution-code-binding.ts";
import { COST_FIELDS, FROZEN_RECEIPT, PREREGISTRATION, verifyPreregistration, validateCostRecord, type CostRecord } from "./execution-eval.ts";
import { plain, readBytesBounded, readTextBounded, sha256, writeAtomic } from "../src/study.ts";

const BYTES = 65_536, INPUT_BYTES = 16_384, LOG_BYTES = 65_536, BUNDLE_BYTES = 2 * 1024 * 1024;
type Status = "succeeded" | "failed" | "cancelled" | "unknown" | "excluded";
type Trial = "diagnose" | "reuse";
interface Case { id: string; trial: Trial; input: string; expected: string; index: number; payload: Record<string, unknown>; truth: Record<string, unknown>; inputSha256: string; expectedSha256: string }
interface Observation {
  authority: "harness-observed"; caseId: string; trial: Trial; arm: "current-workflow" | "fresh"; repetition: number; seed: number; condition: "cold" | "warm";
  slotOrder: ("baseline" | null)[]; executedSlot: number; status: Status; cause?: string; matched: boolean | "unknown";
  observed: unknown; processWallMs: number | "unknown"; humanTimeToFind: "unknown"; costs: CostRecord;
  artifacts: { sha256: string; bytes: number }[]; logs: { stdout: { sha256: string; bytes: number }; stderr: { sha256: string; bytes: number } } | null;
}
export interface BaselineReceipt {
  v: 1; authority: "harness-observed"; kind: "synthetic-baseline-observations"; startedAt: string; endedAt: string;
  registrationReceiptSha256: string; methodSha256: string; inputSha256: string; expectedSha256: string;
  code: ReturnType<typeof bindRunCode>; environment: ReturnType<typeof environment>;
  schedule: { trials: ["diagnose", "reuse"]; repetitions: 3; conditions: ["cold", "warm"]; executedArms: ["baseline"]; supervision: "preregistered-only"; treatmentObservations: 0 };
  denominators: Record<Trial, ReturnType<typeof denominator>>; costs: Record<Trial, CostRecord>;
  automatedSourceResolution: { correct: number; full: number; accuracy: number | "unknown"; humanTimeToFind: "unknown" };
  admission: { parentCpuSeconds: number; wallMs: number; codeMaterializationBytes: number };
  files: { path: string; sha256: string; bytes: number }[]; limitations: string[];
}
function fail(cause: string): never { throw new Error(`execution baseline: ${cause}; restore the frozen registration and clean code, use a fresh output directory in an admitted container, then retry`); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function environment(imageDigest: string) {
  if (platform() !== "linux" || !existsSync("/.dockerenv")) fail("real baseline requires one admitted Linux container");
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) fail("admission controller must supply the actual immutable container image digest");
  let cpuLimit: number, memoryLimitBytes: number, pidsLimit: number;
  try {
    const [quota, period] = readTextBounded("/sys/fs/cgroup/cpu.max", 4096).trim().split(/\s+/);
    cpuLimit = Number(quota) / Number(period);
    memoryLimitBytes = Number(readTextBounded("/sys/fs/cgroup/memory.max", 4096).trim());
    pidsLimit = Number(readTextBounded("/sys/fs/cgroup/pids.max", 4096).trim());
  } catch { fail("admitted cgroup v2 CPU/memory/PID limits are unavailable"); }
  if (![cpuLimit, memoryLimitBytes, pidsLimit].every(value => Number.isFinite(value) && value > 0) || cpuLimit > 2 || memoryLimitBytes > 256 * 1024 * 1024 || pidsLimit > 32) fail("admitted limits exceed the preregistered 2 CPU/256 MiB/32 PID budget");
  return { os: platform(), osRelease: release(), arch: arch(), bun: Bun.version, cpuModelsSha256: sha256(canonical(cpus().map(cpu => cpu.model))), logicalCpus: cpus().length, cpuLimit, memoryLimitBytes, pidsLimit, containerIdentitySha256: sha256(hostname()), imageDigest, imageDigestSource: "admission-controller-pinned-image-id" as const, sequentialChildren: 1 as const };
}
function unknownCosts(): CostRecord { return Object.fromEntries(COST_FIELDS.map(key => [key, "unknown"])) as CostRecord; }
function denominator() { return { full: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0, excluded: 0 }; }
export function baselineSlots(index: number, seeds: readonly number[]) {
  if (!Number.isInteger(index) || index < 0 || seeds.length !== 3 || !seeds.every(Number.isSafeInteger)) fail("three declared seeds and a corpus index are required");
  return seeds.flatMap((seed, repetition) => (["cold", "warm"] as const).map(condition => {
    const first = (index + repetition) % 2 === 0;
    return { seed, repetition, condition, slotOrder: first ? ["baseline", null] as ("baseline" | null)[] : [null, "baseline"] as ("baseline" | null)[], executedSlot: first ? 0 : 1 };
  }));
}
export function baselineDenominators(rows: { trial: Trial; status: Status }[]) {
  const result = { diagnose: denominator(), reuse: denominator() };
  for (const row of rows) { if (!result[row.trial] || !["succeeded", "failed", "cancelled", "unknown", "excluded"].includes(row.status)) fail("observation denominator status is invalid"); result[row.trial].full++; result[row.trial][row.status]++; }
  return result;
}
function cpuSeconds(start: NodeJS.CpuUsage): number { const cpu = process.cpuUsage(start); return (cpu.user + cpu.system) / 1_000_000; }
function records(root: string, registration: ReturnType<typeof verifyPreregistration>): Case[] {
  const hashes = new Map([...registration.inputFiles, ...registration.expectedFiles].map(file => [file.path, file.sha256]));
  const read = (name: string, bound: number): Record<string, unknown> => {
    if (!hashes.has(name)) fail("fixture is absent from the frozen file set");
    const text = readTextBounded(join(root, name), bound, { noFollow: true });
    if (sha256(text) !== hashes.get(name)) fail("fixture changed after preregistration verification");
    const value: unknown = JSON.parse(text); if (!plain(value)) fail("fixture object is malformed"); return value;
  };
  const index = read("test/fixtures/execution-eval/corpus.json", BYTES);
  if (!Array.isArray(index.cases)) fail("corpus index is invalid");
  return index.cases.flatMap((row: unknown, index: number) => {
    if (!plain(row) || row.trial === "supervision") return [];
    if (!["diagnose", "reuse"].includes(String(row.trial)) || typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(row.id) || typeof row.input !== "string" || typeof row.expected !== "string") fail("baseline case identity is invalid");
    const input = read(row.input, INPUT_BYTES), truth = read(row.expected, INPUT_BYTES);
    if (!plain(input.input)) fail("candidate payload is missing");
    return [{ id: row.id, trial: row.trial as Trial, index, input: row.input, expected: row.expected, payload: input.input, truth, inputSha256: hashes.get(row.input)!, expectedSha256: hashes.get(row.expected)! }];
  });
}
function projectedDiagnostic(raw: unknown): unknown {
  if (!plain(raw)) return null;
  return { provenance: raw.provenance, nextAction: raw.nextAction, ...(raw.retryOf !== undefined ? { retryOf: raw.retryOf } : {}), ...(raw.independentSamples !== undefined ? { independentSamples: raw.independentSamples } : {}) };
}
function matches(row: Case, seed: number, observed: unknown): boolean {
  if (row.trial === "diagnose") return canonical(projectedDiagnostic(observed)) === canonical(projectedDiagnostic(row.truth));
  const execution = row.truth.freshExecution;
  if (!plain(execution) || !Array.isArray(execution.outputs)) fail("sealed fresh-output truth is missing");
  return canonical(observed) === canonical(execution.outputs.find(value => plain(value) && value.seed === seed));
}
function totals(rows: Observation[]): CostRecord {
  const result = unknownCosts();
  if (!rows.length) return result;
  // Only comparable units are added, with unknown propagation; component subsets never join their parent total.
  for (const key of COST_FIELDS) {
    const values = rows.map(row => row.costs[key]);
    if (values.every((value): value is number => typeof value === "number")) result[key] = key === "storagePeakBytes" ? Math.max(...values) : values.reduce((sum, value) => sum + value, 0);
  }
  return validateCostRecord(result);
}
/** Observation-only T2a adapter. Never writes an ares study, attempt, result, gate or adoption decision. */
export function runBaseline(rootArg: string, outputArg: string, imageDigest: string): BaselineReceipt {
  const admissionStart = performance.now(), admissionCpu = process.cpuUsage();
  const root = realpathSync(rootArg), registration = verifyPreregistration(root, join(root, FROZEN_RECEIPT));
  const code = bindRunCode(root), envIdentity = environment(imageDigest);
  const protocol = JSON.parse(readTextBounded(join(root, PREREGISTRATION), BYTES));
  if (envIdentity.bun !== protocol.design.versions.bun) fail("Bun version differs from the preregistered runtime");
  const cases = records(root, registration), startedAt = new Date().toISOString(), output = resolve(outputArg), rel = relative(root, output);
  if (!isAbsolute(outputArg) || rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) || existsSync(output)) fail("output must be a fresh absolute directory outside the checkout");
  if (lstatSync(dirname(output)).isSymbolicLink() || realpathSync(dirname(output)) !== dirname(output)) fail("output parent must be an owned physical directory without links");
  const work = mkdtempSync(join(tmpdir(), "ares-baseline-"));
  const rows: Observation[] = [], files: BaselineReceipt["files"] = [];
  let materialized = 0, createdOutput = false;
  try {
    const privateCode = join(work, "code"), home = join(work, "home"); mkdirSync(home, { mode: 0o700 });
    for (const file of code.files) {
      const bytes = readBytesBounded(join(root, file.path), RUN_CODE_FILE_BYTES, { noFollow: true });
      if (sha256(bytes) !== file.sha256) fail("code changed while materializing its private snapshot");
      const target = join(privateCode, file.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeAtomic(target, bytes.toString("utf8"), RUN_CODE_FILE_BYTES, 0o600); materialized += bytes.length;
      if (materialized > protocol.budgets.trialRetainedBytes / 2) fail("private code snapshot would exceed its share of the retention budget");
    }
    const admission = { parentCpuSeconds: cpuSeconds(admissionCpu), wallMs: performance.now() - admissionStart, codeMaterializationBytes: materialized };
    mkdirSync(output, { mode: 0o700 }); createdOutput = true;
    const childEnv = { PATH: dirname(process.execPath), HOME: home, AGENTHUB_HOME: join(home, "family"), XDG_CONFIG_HOME: join(home, "config"), TMPDIR: home, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1" };
    const stopped = { diagnose: false, reuse: false };
    const trialStarts = { diagnose: performance.now(), reuse: 0 }, trialCpu = { diagnose: 0, reuse: 0 };
    for (const row of cases) {
      if (row.trial === "reuse" && trialStarts.reuse === 0) trialStarts.reuse = performance.now();
      const workspace = join(work, row.id), candidate = join(workspace, "candidate.json"), artifact = join(workspace, "observed.json"); mkdirSync(workspace, { mode: 0o700 });
      const seedSet = row.trial === "reuse" && plain(row.payload.workload) && Array.isArray(row.payload.workload.seeds) ? row.payload.workload.seeds as number[] : protocol.design.seedSets.firstVariant as number[];
      const caseRows: Observation[] = [];
      for (const slot of baselineSlots(row.index, seedSet)) {
        const { seed, repetition, condition } = slot;
        const observation: Observation = { authority: "harness-observed", caseId: row.id, trial: row.trial, arm: row.trial === "reuse" ? "fresh" : "current-workflow", repetition, seed, condition, slotOrder: slot.slotOrder, executedSlot: slot.executedSlot, status: "unknown", cause: "not-started", matched: "unknown", observed: null, processWallMs: "unknown", humanTimeToFind: "unknown", costs: unknownCosts(), artifacts: [], logs: null };
        if (!stopped[row.trial] && performance.now() - trialStarts[row.trial] < protocol.budgets.trialWallMs && trialCpu[row.trial] < protocol.budgets.trialCpuSeconds) {
          const start = performance.now(), parentCpu = process.cpuUsage();
          const matStart = performance.now(), matCpu = process.cpuUsage();
          const text = JSON.stringify(row.payload) + "\n";
          if (condition === "cold") writeAtomic(candidate, text, INPUT_BYTES, 0o600);
          if (existsSync(artifact)) unlinkSync(artifact);
          observation.costs.materializationCpuSeconds = cpuSeconds(matCpu); observation.costs.materializationWallMs = performance.now() - matStart;
          observation.costs.materializationTransferBytes = condition === "cold" ? Buffer.byteLength(text) : 0;
          const childStart = performance.now(); let childCpu: number | "unknown" = "unknown";
          try {
            const script = row.trial === "reuse" ? "execution-workload.ts" : "execution-diagnose.ts";
            const child = Bun.spawnSync([process.execPath, "--smol", join(privateCode, "scripts", script), candidate, artifact, ...(row.trial === "reuse" ? [String(seed)] : [])], { cwd: workspace, env: childEnv, stdout: "pipe", stderr: "pipe", timeout: Math.max(1, Math.min(protocol.budgets.caseWallMs, protocol.budgets.trialWallMs - (performance.now() - trialStarts[row.trial]))), maxBuffer: LOG_BYTES });
            observation.processWallMs = performance.now() - childStart;
            observation.logs = { stdout: { sha256: sha256(child.stdout), bytes: child.stdout.length }, stderr: { sha256: sha256(child.stderr), bytes: child.stderr.length } };
            const usage = child.resourceUsage;
            if (usage && usage.cpuTime.total >= 0) childCpu = Number(usage.cpuTime.total) / 1_000_000;
            if (child.exitedDueToTimeout || child.exitedDueToMaxBuffer || child.exitCode !== 0) { observation.status = child.signalCode && !child.exitedDueToTimeout ? "cancelled" : "failed"; observation.cause = child.exitedDueToTimeout ? "wall-budget" : child.exitedDueToMaxBuffer ? "output-bound" : "child-nonzero"; }
            else if (usage.maxRSS > protocol.budgets.caseMemoryMiB * 1024 * 1024) { observation.status = "failed"; observation.cause = "memory-budget"; stopped[row.trial] = true; }
            else {
              const verifyStart = performance.now(), verifyCpu = process.cpuUsage(), result = readTextBounded(artifact, INPUT_BYTES, { noFollow: true });
              observation.observed = JSON.parse(result); observation.artifacts.push({ sha256: sha256(result), bytes: Buffer.byteLength(result) });
              observation.matched = matches(row, seed, observation.observed); observation.status = observation.matched ? "succeeded" : "failed";
              observation.cause = observation.matched ? undefined : "expected-mismatch";
              observation.costs.verificationCpuSeconds = cpuSeconds(verifyCpu); observation.costs.verificationWallMs = performance.now() - verifyStart;
            }
          } catch { observation.status = "failed"; observation.cause = "spawn-or-observation-unavailable"; }
          observation.costs.wallElapsedMs = performance.now() - start;
          observation.costs.cpuSeconds = childCpu === "unknown" ? "unknown" : childCpu + cpuSeconds(parentCpu);
          if (typeof observation.costs.cpuSeconds === "number") trialCpu[row.trial] += observation.costs.cpuSeconds;
          else stopped[row.trial] = true;
          if (typeof observation.costs.cpuSeconds === "number" && observation.costs.cpuSeconds > protocol.budgets.caseCpuSeconds) { observation.status = "failed"; observation.cause = "cpu-budget"; stopped[row.trial] = true; }
          if (observation.costs.wallElapsedMs > protocol.budgets.caseWallMs) { observation.status = "failed"; observation.cause = "wall-budget"; stopped[row.trial] = true; }
          observation.costs.failureCpuSeconds = observation.status === "succeeded" ? 0 : observation.costs.cpuSeconds;
          observation.costs.failureWallMs = observation.status === "succeeded" ? 0 : observation.costs.wallElapsedMs;
          validateCostRecord(observation.costs);
        } else observation.cause = "budget-stopped-not-started";
        rows.push(observation); caseRows.push(observation);
      }
      const body = { v: 1, authority: "harness-observed", registrationReceiptSha256: registration.receiptSha256, codeSha256: code.codeSha256, methodSha256: registration.bindings.methodSha256, inputFileSha256: row.inputSha256, expectedFileSha256: row.expectedSha256, observations: caseRows };
      const name = `${row.id}.json`, text = JSON.stringify(body, null, 2) + "\n"; writeAtomic(join(output, name), text, BYTES, 0o600); files.push({ path: name, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    }
    const diagnostic = rows.filter(row => row.trial === "diagnose"), correct = diagnostic.filter(row => row.matched === true).length;
    const receipt: BaselineReceipt = {
      v: 1, authority: "harness-observed", kind: "synthetic-baseline-observations", startedAt, endedAt: new Date().toISOString(), registrationReceiptSha256: registration.receiptSha256, methodSha256: registration.bindings.methodSha256, inputSha256: registration.bindings.inputSha256, expectedSha256: registration.bindings.expectedSha256, code, environment: envIdentity,
      schedule: { trials: ["diagnose", "reuse"], repetitions: 3, conditions: ["cold", "warm"], executedArms: ["baseline"], supervision: "preregistered-only", treatmentObservations: 0 }, denominators: baselineDenominators(rows),
      costs: { diagnose: totals(diagnostic), reuse: totals(rows.filter(row => row.trial === "reuse")) }, automatedSourceResolution: { correct, full: diagnostic.length, accuracy: diagnostic.length ? correct / diagnostic.length : "unknown", humanTimeToFind: "unknown" }, admission, files,
      limitations: ["harness-observed synthetic baseline only; no study/attempt, ares-observed/sealed evidence, winner or adoption authority", "rule engine scored against its development fixtures; automated source-resolution accuracy is not workflow usability", "human time-to-find, idle/person time and uninstrumented cost dimensions are unknown", "cold resets private fixture input/output state; warm retains input bytes, but every computation is fresh; no host-cache or JIT coldness claim", "T2a is not T3 control: rerun fresh alongside each authorized treatment in paired AB/BA order", "CPU sums only same-unit parent/self and child process counters; verification/materialization/failure are subsets, never added again", "newly created local receipts are 0600; checked-in synthetic hash/observation copies are ordinary 0644 Git files"] };
    writeAtomic(join(output, "manifest.json"), JSON.stringify(receipt, null, 2) + "\n", BYTES, 0o600);
    return receipt;
  } catch (error) { if (createdOutput) rmSync(output, { recursive: true, force: true }); if (error instanceof Error && error.message.startsWith("execution baseline:")) throw error; fail("baseline collection failed before a complete receipt"); }
  finally { rmSync(work, { recursive: true, force: true }); }
}
export function emitBaseline(output: string): string {
  const manifest = readTextBounded(join(output, "manifest.json"), BYTES, { noFollow: true }), raw: unknown = JSON.parse(manifest);
  if (!plain(raw) || !Array.isArray(raw.files)) fail("baseline manifest is invalid");
  const files: Record<string, string> = { "manifest.json": manifest };
  let size = Buffer.byteLength(manifest);
  for (const entry of raw.files) {
    if (!plain(entry) || typeof entry.path !== "string" || !/^[a-z][a-z0-9-]{0,63}\.json$/.test(entry.path)) fail("baseline receipt filename is invalid");
    const text = readTextBounded(join(output, entry.path), BYTES, { noFollow: true }); if (sha256(text) !== entry.sha256) fail("baseline receipt hash changed");
    size += Buffer.byteLength(text); if (size > BUNDLE_BYTES) fail("baseline bundle exceeds2MiB"); files[entry.path] = text;
  }
  return JSON.stringify({ v: 1, files });
}
