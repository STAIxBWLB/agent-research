import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, gateDecide } from "../src/commands.ts";
import { runAttempt, reconcileAttempts, showAttempt, type AttemptContext, type Attempt } from "../src/exp/attempts.ts";
import { setProtocol } from "../src/exp/protocol.ts";
import { setSelection } from "../src/exp/selection.ts";
import { setExecutor, spawnRunner, type ProcessRunner, type ProcessResult } from "../src/exp/executor.ts";
import { parseMetrics } from "../src/exp/metrics.ts";
import { retainedOperation, type RetainedRef } from "../src/exp/retention.ts";
import { plain, readBytesBounded, readTextBounded, readLedger, sha256, withLock, writeAtomic } from "../src/study.ts";
import { readProvenance, compareLineage, attemptReuseView } from "../src/provenance.ts";
import { canonical, COST_FIELDS, type CostRecord } from "./execution-eval.ts";
import { numericWorkload, freshValues, prepareValue, transformValue, evaluateValue, type FreshValues, type NumericWorkload } from "./execution-workload.ts";

export interface ReuseIntegrationCheck {
  v: 1; kind: "reuse-fixture-integration-check"; authority: "functional-fixture-only";
  sourceEstablishment: "unavailable-opaque-frozen-artifact" | "no-frozen-source"; sourcePopulation: "none";
  sourceStatus: string | null; sourceIntegrity: "valid-opaque" | "corrupt" | "missing" | "pruned" | "absent" | "unsupported";
  status: "succeeded"; observed: FreshValues; reusedStages: string[]; freshStages: string[];
  producerMisses: { stage: string; reason: string }[];
  chain: { taskSha256: string; attemptId: string; attemptRecordSha256: string; artifactDigests: string[]; retainedManifestDigests: string[]; provenanceStatus: string; provenanceSha256: string; comparisonStatus: string; comparisonSha256: string; evidenceCandidate: "unreviewed-functional-fixture" };
  evaluatorFresh: true; sourceRefs: RetainedRef[]; candidateEvidenceSha256: string; costs: CostRecord; limitations: string[];
}
const actor = { kind: "person" as const }, BYTES = 16_384;
const offlineHttp = { env: {}, json: async () => fail("network access is outside the functional fixture"), text: async () => fail("network access is outside the functional fixture") };
function fail(cause: string, next = "inspect the bounded frozen input and producer adapter, restore valid bindings and rerun the functional integration checks"): never { throw new Error(`execution reuse integration: ${cause}; ${next}`); }
function sourceState(raw: unknown): Pick<ReuseIntegrationCheck, "sourceEstablishment" | "sourcePopulation" | "sourceStatus" | "sourceIntegrity"> {
  if (raw === null || raw === undefined) return { sourceEstablishment: "no-frozen-source", sourcePopulation: "none", sourceStatus: null, sourceIntegrity: "absent" };
  if (!plain(raw)) fail("source shape is invalid");
  const sourceStatus = typeof raw.status === "string" && ["succeeded", "failed", "cancelled", "unknown", "running"].includes(raw.status) ? raw.status : null;
  const artifact = plain(raw.artifact) ? raw.artifact : undefined;
  let sourceIntegrity: ReuseIntegrationCheck["sourceIntegrity"] = "unsupported";
  if (artifact?.present === false) sourceIntegrity = artifact.retention === "pruned" ? "pruned" : "missing";
  else if (artifact?.present === true && plain(artifact.payload) && typeof artifact.digest === "string" && /^[a-f0-9]{64}$/.test(artifact.digest)) sourceIntegrity = sha256(canonical(artifact.payload)) === artifact.digest ? "valid-opaque" : "corrupt";
  return { sourceEstablishment: "unavailable-opaque-frozen-artifact", sourcePopulation: "none", sourceStatus, sourceIntegrity };
}
function cleanup(root: string): void {
  function unlock(dir: string) { chmodSync(dir, 0o700); for (const name of readdirSync(dir)) { const file = join(dir, name); if (lstatSync(file).isDirectory()) unlock(file); } }
  unlock(root); rmSync(root, { recursive: true, force: true });
}
function files(root: string): { path: string; sha256: string; bytes: number }[] {
  const result: { path: string; sha256: string; bytes: number }[] = [];
  for (const name of readdirSync(root)) {
    const file = join(root, name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || result.length >= 8) fail("synthetic output shape is invalid");
    const bytes = readBytesBounded(file, BYTES); result.push({ path: file, sha256: sha256(bytes), bytes: bytes.length });
  }
  return result;
}
interface FakeContainer { id: string; args: string[]; running: boolean; exitCode: number; startedAt: string; finishedAt?: string }
function transport(env: NodeJS.ProcessEnv) {
  const containers = new Map<string, FakeContainer>(), executed: string[] = [], clock = { value: Date.parse("2030-01-01T00:00:00Z") };
  const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
  const argument = (args: string[], flag: string) => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) fail("synthetic container option missing"); return args[index + 1]!; };
  const mounts = (args: string[]) => args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]!] : []).map(text => {
    const parts = text.split(","); return { Type: "bind", Source: parts.find(value => value.startsWith("src="))!.slice(4), Destination: parts.find(value => value.startsWith("dst="))!.slice(4), RW: !parts.includes("readonly") };
  });
  const runner: ProcessRunner = async request => {
    const args = request.args;
    if (request.command === "id") return ok("1001");
    if (request.command === "sh" && args.some(value => value.includes("nohup"))) return ok();
    if (request.command !== "docker") {
      if (!["git", "tar", "python3", "sh"].includes(request.command)) fail("unexpected fixture process");
      return spawnRunner({ ...request, env });
    }
    if (args[0] === "version") return ok("29.1.3");
    if (args[0] === "image") return ok("sha256:synthetic");
    if (args[0] === "run") {
      const name = argument(args, "--name"); if (containers.has(name)) return { exitCode: 125, stdout: "", stderr: "synthetic name already exists" };
      const imageIndex = args.findIndex(value => value.includes("@sha256:")), command = args.slice(imageIndex + 1), stage = command[1]!;
      if (command[0] !== "/fixture-workload") fail("unsupported synthetic workload executable");
      const mounted = mounts(args), mount = (target: string) => { const found = mounted.find(value => value.Destination === target); if (!found) fail("synthetic mount missing"); return found.Source; };
      const seedText = args.flatMap((value, index) => value === "--env" ? [args[index + 1]!] : []).find(value => value.startsWith("ARES_SEED="));
      if (!seedText || !/^-?\d+$/.test(seedText.slice(10))) fail("synthetic seed missing"); const seed = Number(seedText.slice(10));
      const output = stage === "verify" ? mount("/result") : mount("/out"); mkdirSync(output, { recursive: true, mode: 0o700 });
      if (stage === "prepare") {
        const input: unknown = JSON.parse(readTextBounded(join(mount("/in"), "values"), BYTES));
        if (!plain(input) || !Array.isArray(input.seeds) || !input.seeds.includes(seed)) fail("frozen preparation seed missing");
        writeAtomic(join(output, "value.json"), JSON.stringify(prepareValue(input.values, seed)) + "\n", BYTES, 0o600);
      } else if (stage === "transform") {
        const prepared: unknown = JSON.parse(readTextBounded(join(mount("/in"), "prepared"), BYTES));
        if (typeof prepared !== "number") fail("preparation output is not numeric");
        writeAtomic(join(output, "value.json"), JSON.stringify(transformValue(prepared, Number(command[2]), Number(command[3]))) + "\n", BYTES, 0o600);
      } else if (stage === "evaluate") {
        const transformed: unknown = JSON.parse(readTextBounded(join(mount("/in"), "transformed"), BYTES));
        if (typeof transformed !== "number") fail("transform output is not numeric");
        writeAtomic(join(output, "value.json"), JSON.stringify(evaluateValue(transformed, seed, command[2]!)) + "\n", BYTES, 0o600);
      } else if (stage === "verify") {
        const policy: unknown = JSON.parse(readTextBounded(join(mount("/eval"), "policy.json"), BYTES)), expected = freshValues(policy, seed);
        for (const name of ["prepare", "transform", "evaluate"] as const) {
          const actual: unknown = JSON.parse(readTextBounded(join(mount("/candidate"), name, "value.json"), BYTES));
          if (actual !== expected[name]) fail("fresh evaluator rejected candidate outputs");
        }
        writeAtomic(join(output, "metrics.json"), JSON.stringify({ score: expected.evaluate }) + "\n", BYTES, 0o600);
      } else fail("unsupported synthetic stage");
      executed.push(stage); const container = { id: sha256(name), args, running: true, exitCode: 0, startedAt: new Date(clock.value).toISOString() };
      containers.set(name, container); return ok(container.id);
    }
    if (args[0] === "kill") {
      const found = [...containers.values()].find(value => value.id === args[1]); if (!found) return { exitCode: 1, stdout: "", stderr: "synthetic absence" };
      found.running = false; found.exitCode = 137; found.finishedAt = new Date(clock.value).toISOString(); return ok();
    }
    if (args[0] === "ps") return ok([...containers].filter(([name, container]) => args.some(value => value.startsWith("name=^/")) ? args.includes(`name=^/${name}$`) : container.running).map(([, value]) => value.id).join("\n"));
    if (args[0] === "inspect") {
      const found = containers.get(args.at(-1)!); if (!found) return { exitCode: 1, stdout: "", stderr: "synthetic absence" };
      const a = found.args, imageAt = a.findIndex(value => value.includes("@sha256:")), labels = Object.fromEntries(a.flatMap((value, index) => value === "--label" ? [a[index + 1]!] : []).map(value => { const i = value.indexOf("="); return [value.slice(0, i), value.slice(i + 1)]; }));
      const seed = a.flatMap((value, index) => value === "--env" ? [a[index + 1]!] : []).find(value => value.startsWith("ARES_SEED=")) ?? "";
      return ok(JSON.stringify([{ Id: found.id, State: { Running: found.running, ExitCode: found.exitCode, StartedAt: found.startedAt, ...(found.finishedAt ? { FinishedAt: found.finishedAt } : {}) },
        Config: { Seed: seed, Image: a[imageAt], User: argument(a, "--user"), Cmd: a.slice(imageAt + 1), Labels: labels }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Tmpfs: { "/tmp": "" }, Memory: Number.parseInt(argument(a, "--memory")) * 1024 * 1024, PidsLimit: Number(argument(a, "--pids-limit")), NanoCpus: Number(argument(a, "--cpus")) * 1e9, DeviceRequests: [] }, Mounts: mounts(a) }]));
    }
    fail("unexpected synthetic Docker operation");
  };
  const ctx: AttemptContext = { actor, runner, now: () => clock.value, collectStageEvidence: async (attempt, stage) => {
    const log = { path: join(attempt.executor.workdir, "fixture.log"), sha256: sha256(""), bytes: 0, truncated: false };
    return { logs: { stdout: log, stderr: log }, outputs: files(stage === "candidate" ? attempt.paths.output : attempt.paths.result) };
  }, collectEvaluation: async attempt => ({ metrics: parseMetrics(readBytesBounded(join(attempt.paths.result, "metrics.json"), BYTES), attempt.protocol), outputs: files(attempt.paths.result) }) };
  return { ctx, executed, containers, finish() { const current = [...containers.values()].filter(value => value.running); if (current.length !== 1) fail("functional integration expected one active fake container"); clock.value += 1000; current[0]!.running = false; current[0]!.finishedAt = new Date(clock.value).toISOString(); } };
}

interface ProducerFixture {
  dir: string; repo: string; workdir: string; commit: string; seed: number; fake: ReturnType<typeof transport>;
}
async function withProducerFixture<T>(input: Record<string, unknown>, seed: number, maxAttempts: 1 | 2, use: (fixture: ProducerFixture) => Promise<T>): Promise<T> {
  if (!plain(input.currentContext)) fail("current context is missing");
  const workload: NumericWorkload = numericWorkload(input, seed), context = input.currentContext;
  if (typeof context.globalCodeDigest !== "string" || !/^[a-f0-9]{64}$/.test(context.globalCodeDigest) || typeof context.method !== "string" || !context.method.trim() || context.method.length > 128) fail("frozen current context is invalid");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ares-producer-fixture-")));
  const dir = join(root, "study"), repo = join(root, "repo"), workdir = join(root, "executor"), home = join(root, "home");
  try {
    for (const folder of [repo, workdir, home]) mkdirSync(folder, { mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, AGENTHUB_HOME: home, TMPDIR: home };
    const git = async (args: string[]) => { const result = await spawnRunner({ command: "git", args: ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-C", repo, ...args], env, maxOutputBytes: BYTES, timeoutMs: 5000 }); if (result.exitCode !== 0 || result.timedOut || result.truncated) fail("private synthetic Git operation failed", "check Git availability and writable private temporary storage, then rerun the functional integration checks"); return result.stdout.trim(); };
    await git(["init", "-q"]); writeAtomic(join(repo, "global-code-digest.txt"), context.globalCodeDigest + "\n", BYTES, 0o600); await git(["add", "."]); await git(["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic fixture workload identity"]); const commit = await git(["rev-parse", "HEAD"]);
    init(dir, { question: "Synthetic functional reuse integration", mode: "experiment" }, { actor });
    mkdirSync(join(dir, "task", "evaluator"), { recursive: true, mode: 0o700 });
    writeAtomic(join(dir, "task", "values.json"), JSON.stringify({ values: workload.values, seeds: workload.seeds }) + "\n", BYTES, 0o600);
    writeAtomic(join(dir, "task", "evaluator", "policy.json"), JSON.stringify({ workload: input.workload }) + "\n", BYTES, 0o600);
    const reusable = { v: 1, kind: "pure-artifact", inputs: "declared-only", externalState: "none", writableState: "fresh-output-only", modelOutputs: "forbidden", determinism: "byte-exact", toolchain: { description: "Synthetic bounded integer transform, fake container transport", documentationSha256: sha256("fixture-integer-workload-v1") } };
    const stage = { image: `synthetic@sha256:${"a".repeat(64)}`, seed: true, code: "snapshot", reuse: reusable };
    const protocol = { v: 2, method: context.method, candidate: { stages: [
      { ...stage, name: "prepare", command: ["/fixture-workload", "prepare"], needs: [], inputs: { values: { task: "values.json" } }, outputs: { value: "value.json" } },
      { ...stage, name: "transform", command: ["/fixture-workload", "transform", String(workload.multiplier), String(workload.offset)], needs: ["prepare"], inputs: { prepared: { stage: "prepare", output: "value" } }, outputs: { value: "value.json" } },
      { ...stage, name: "evaluate", command: ["/fixture-workload", "evaluate", workload.evaluateOperation], needs: ["transform"], inputs: { transformed: { stage: "transform", output: "value" } }, outputs: { value: "value.json" } },
    ] }, evaluator: { image: `synthetic@sha256:${"b".repeat(64)}`, command: ["/fixture-workload", "verify"] }, metrics: [{ name: "score", unit: "integer", direction: "max" }], seeds: workload.seeds, limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts, maxWallHours: 1, maxGpuHours: 0 } };
    await withLock(dir, () => { const normalized = setProtocol(dir, protocol, actor); setExecutor(dir, { v: 1, kind: "local", workdir }, actor); setSelection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit }, minSeeds: 1, minDelta: 0 }, normalized, actor); });
    await gateDecide(dir, "design", "approve", undefined, { actor, http: offlineHttp });
    return await use({ dir, repo, workdir, commit, seed, fake: transport(env) });
  } finally { cleanup(root); }
}
async function completeProducer(fixture: ProducerFixture, initial: Attempt, beforeStop?: (attempt: Attempt) => Promise<void>): Promise<Attempt> {
  let attempt = initial;
  for (let step = 0; step < 8 && attempt.status === "running"; step++) {
    const running = [...fixture.fake.containers.values()].filter(value => value.running);
    if (running.length > 1) fail("functional integration has multiple active fake containers");
    if (running.length === 1) { await beforeStop?.(attempt); fixture.fake.finish(); }
    await reconcileAttempts(fixture.dir, fixture.fake.ctx); attempt = showAttempt(fixture.dir, attempt.id);
  }
  if (attempt.status !== "succeeded" || !attempt.pipeline) fail("real producer adapter did not complete the functional pipeline");
  return attempt;
}
async function producerValues(fixture: ProducerFixture, attempt: Attempt): Promise<{ observed: FreshValues; payloadDigests: string[] }> {
  if (!attempt.pipeline || attempt.status !== "succeeded") fail("producer values need a completed pipeline");
  const observed: FreshValues = { seed: attempt.seed, prepare: 0, transform: 0, evaluate: 0 }, payloadDigests: string[] = [];
  for (const name of ["prepare", "transform", "evaluate"] as const) {
    const parent = attempt.pipeline.completed.find(value => value.name === name); if (!parent) fail("candidate artifact receipt missing");
    const verified = await retainedOperation(attempt.executor, { op: "verify", studyId: attempt.studyId, ref: parent.ref }, fixture.fake.ctx.runner!);
    const bytes = readBytesBounded(join(fixture.workdir, attempt.studyId, ".retained", "objects", parent.ref.attemptId, parent.ref.stage, "data", "value.json"), BYTES), value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "number" || !Number.isSafeInteger(value) || verified.sha256 !== parent.ref.sha256) fail("producer artifact is invalid");
    observed[name] = value; payloadDigests.push(sha256(bytes));
  }
  if (attempt.metrics[0]?.value !== observed.evaluate) fail("fresh evaluator receipt differs from candidate value");
  return { observed, payloadDigests };
}
function attemptBytes(fixture: ProducerFixture, attempt: Attempt): Buffer { return readBytesBounded(join(fixture.dir, "runs", "investigate", "attempts", `${attempt.id}.json`), 1024 * 1024); }
function unknownCosts(): CostRecord { return Object.fromEntries(COST_FIELDS.map(field => [field, "unknown"])) as CostRecord; }

/** One functional first-seed check. No source warmup, treatment trial, measured cost or adoption authority. */
export async function checkReuseTreatmentFixture(input: unknown, seed: number): Promise<ReuseIntegrationCheck> {
  if (!plain(input) || Buffer.byteLength(JSON.stringify(input)) > BYTES || !plain(input.currentContext)) fail("input is malformed or exceeds bound", "supply only a bounded frozen input payload");
  const source = sourceState(input.source);
  return withProducerFixture<ReuseIntegrationCheck>(input, seed, 1, async fixture => {
    const { dir, repo, commit, fake } = fixture;
    const attempt = await completeProducer(fixture, await runAttempt(dir, { repo, commit, seed, run: "investigate", reuse: "eligible", detach: true }, fake.ctx));
    if (fake.executed.join(",") !== "prepare,transform,evaluate,verify" || attempt.pipeline!.completed.some(parent => parent.reuse)) fail("opaque source unexpectedly produced a reuse hit");
    const { observed } = await producerValues(fixture, attempt);
    if ([...fake.containers.values()].filter(value => value.args.includes("verify")).length !== 1) fail("fresh evaluator receipt missing");
    const page = readProvenance(dir), comparison = compareLineage(dir, { attempts: [attempt.id] }), reuse = attemptReuseView(attempt, readLedger(dir));
    if (!reuse || reuse.stages.some(value => value.outcome === "reused")) fail("opaque frozen source was incorrectly counted as reused");
    const chain = { taskSha256: sha256(canonical({ workload: input.workload, currentContext: input.currentContext })), attemptId: attempt.id,
      attemptRecordSha256: sha256(attemptBytes(fixture, attempt)), artifactDigests: attempt.outputs.map(value => value.sha256), retainedManifestDigests: attempt.pipeline!.completed.map(value => value.ref.sha256),
      provenanceStatus: page.status, provenanceSha256: sha256(canonical(page)), comparisonStatus: comparison.status, comparisonSha256: sha256(canonical(comparison)), evidenceCandidate: "unreviewed-functional-fixture" as const };
    return { v: 1, kind: "reuse-fixture-integration-check", authority: "functional-fixture-only", ...source, status: "succeeded", observed, reusedStages: [], freshStages: ["prepare", "transform", "evaluate"], evaluatorFresh: true, sourceRefs: [], producerMisses: Object.entries(attempt.reuse?.stages ?? {}).map(([stage, value]) => ({ stage, reason: value.reason })), chain, candidateEvidenceSha256: sha256(canonical({ observed, chain, receipts: attempt.pipeline!.completed.map(value => ({ stage: value.name, sha256: value.ref.sha256 })), evaluator: attempt.metrics })), costs: unknownCosts(),
      limitations: ["frozen artifacts are opaque strings, not numeric producer checkpoints; no source was generated or populated", "one current first-seed functional integration only; no treatment trial, comparison estimate, adoption or measured costs", "Docker/container execution is fake; real private Git/tar/Python and ares APIs do not prove native container isolation", "current fresh outputs are verified; positive preregistered reuse eligibility is not established from opaque source bytes"] };
  });
}

export interface ProducerReuseUnitCheck {
  v: 1; kind: "producer-reuse-unit-check"; authority: "functional-fixture-only"; sourcePopulation: "separate-unit-fixture"; frozenCorpus: false;
  status: "succeeded"; sourceAttemptId: string; currentAttemptId: string; sourceRefs: RetainedRef[]; reusedRefs: RetainedRef[];
  sourceObserved: FreshValues; currentObserved: FreshValues; sourcePayloadDigests: string[]; currentPayloadDigests: string[];
  sourceRecordSha256: string; sourceRecordUnchanged: true; sourceMetricsSha256: string; currentMetricsSha256: string;
  sourceEvaluatorId: string; currentEvaluatorId: string; evaluatorFresh: true; pinsHeldBeforeEvaluation: true; pinsReleased: true;
  executed: string[]; counts: { sourceExecutedStages: number; currentExecutedStages: number; reusedStages: number; currentIndependentSamples: 0 };
  candidateEvidenceSha256: string; costs: CostRecord; limitations: string[];
}
/** Separate hardcoded producer conformance only. It neither accepts nor reads a frozen corpus source. */
export async function checkProducerReuseUnitFixture(): Promise<ProducerReuseUnitCheck> {
  const seed = 5, input = { workload: { values: [1, 2, 3], seeds: [seed], stages: [
    { id: "prepare", operation: "sum-input-plus-seed" }, { id: "transform", operation: "multiply-plus-offset", multiplier: 4, offset: 7 }, { id: "evaluate", operation: "square-plus-two-seeds" },
  ] }, currentContext: { method: "separate-producer-reuse-unit-v1", globalCodeDigest: sha256("non-frozen-producer-unit-code-v1") } };
  return withProducerFixture<ProducerReuseUnitCheck>(input, seed, 2, async fixture => {
    const { dir, repo, commit, fake } = fixture;
    const source = await completeProducer(fixture, await runAttempt(dir, { repo, commit, seed, run: "investigate", reuse: "eligible", detach: true }, fake.ctx));
    if (!source.pipeline || source.pipeline.completed.some(parent => parent.reuse) || fake.executed.join(",") !== "prepare,transform,evaluate,verify") fail("separate unit source was not produced fresh");
    const sourceBytes = attemptBytes(fixture, source), sourceMetrics = canonical(source.metrics), sourceValues = await producerValues(fixture, source), sourceRefs = source.pipeline.completed.map(parent => ({ ...parent.ref }));
    let pinsHeldBeforeEvaluation = false;
    const current = await completeProducer(fixture, await runAttempt(dir, { repo, commit, seed, run: "investigate", reuse: "eligible", retry: source.id, detach: true }, fake.ctx), async attempt => {
      if (attempt.stage !== "evaluator") return;
      const inventory = await retainedOperation(attempt.executor, { op: "inspect", studyId: attempt.studyId }, fake.ctx.runner!);
      pinsHeldBeforeEvaluation = sourceRefs.every(ref => inventory.entries?.some(entry => canonical(entry.ref) === canonical(ref) && entry.active)) && inventory.reservations?.some(entry => entry.attemptId === attempt.id && entry.active) === true;
      if (!pinsHeldBeforeEvaluation) fail("separate unit source was not pinned until fresh evaluation");
    });
    if (!current.pipeline || fake.executed.join(",") !== "prepare,transform,evaluate,verify,verify") fail("separate unit reran a candidate instead of reusing its sealed output");
    const currentValues = await producerValues(fixture, current), expected = freshValues(input, seed);
    if (canonical(sourceValues.observed) !== canonical(expected) || canonical(currentValues.observed) !== canonical(expected) || canonical(sourceValues.payloadDigests) !== canonical(currentValues.payloadDigests)) fail("separate unit output equivalence failed");
    for (const [index, parent] of current.pipeline.completed.entries()) {
      const original = source.pipeline.completed[index]!;
      if (!parent.reuse || canonical(parent.ref) !== canonical(original.ref) || canonical(parent.reuse.source) !== canonical(original.ref) || canonical(parent.record) !== canonical(original.record)) fail("separate unit lost original source provenance");
      const copied = readBytesBounded(join(current.paths.output, parent.name, "value.json"), BYTES);
      if (sha256(copied) !== sourceValues.payloadDigests[index]) fail("fresh evaluator materialization differs from sealed source bytes");
    }
    const after = showAttempt(dir, source.id), view = attemptReuseView(current, readLedger(dir)), sourceView = attemptReuseView(source, readLedger(dir));
    if (!sourceBytes.equals(attemptBytes(fixture, after)) || canonical(after.metrics) !== sourceMetrics) fail("reuse overwrote original source record or evaluator metrics");
    if (!view || !sourceView || view.reusedCandidateStages !== 3 || view.executedStages !== 1 || view.independentSamples !== 0 || sourceView.executedStages !== 4) fail("separate unit counts misrepresent prior computation as new work");
    const sourceEvaluatorId = source.stages.evaluator?.containerId, currentEvaluatorId = current.stages.evaluator?.containerId;
    if (!sourceEvaluatorId || !currentEvaluatorId || sourceEvaluatorId === currentEvaluatorId || canonical(source.metrics) !== canonical(current.metrics)) fail("current evaluator is not independently fresh");
    const inventory = await retainedOperation(current.executor, { op: "inspect", studyId: current.studyId }, fake.ctx.runner!);
    const pinsReleased = sourceRefs.every(ref => inventory.entries?.some(entry => canonical(entry.ref) === canonical(ref) && !entry.active)) && inventory.reservedBytes === 0;
    if (!pinsReleased || !pinsHeldBeforeEvaluation) fail("separate unit source pin lifecycle is incomplete");
    const evidence = { sourceAttemptId: source.id, currentAttemptId: current.id, sourceRefs, sourcePayloadDigests: sourceValues.payloadDigests, currentPayloadDigests: currentValues.payloadDigests, sourceEvaluatorId, currentEvaluatorId, counts: { sourceExecutedStages: sourceView.executedStages, currentExecutedStages: view.executedStages, reusedStages: view.reusedCandidateStages, currentIndependentSamples: 0 as const } };
    return { v: 1, kind: "producer-reuse-unit-check", authority: "functional-fixture-only", sourcePopulation: "separate-unit-fixture", frozenCorpus: false, status: "succeeded", ...evidence,
      reusedRefs: current.pipeline.completed.map(parent => ({ ...parent.ref })), sourceObserved: sourceValues.observed, currentObserved: currentValues.observed,
      sourceRecordSha256: sha256(sourceBytes), sourceRecordUnchanged: true, sourceMetricsSha256: sha256(sourceMetrics), currentMetricsSha256: sha256(canonical(current.metrics)),
      evaluatorFresh: true, pinsHeldBeforeEvaluation: true, pinsReleased: true, executed: [...fake.executed], candidateEvidenceSha256: sha256(canonical(evidence)), costs: unknownCosts(),
      limitations: ["separate hardcoded unit fixture, outside the frozen corpus; no opaque frozen source is rematerialized", "fake container transport validates producer control/dataflow only; no kernel isolation or native container proof", "no treatment trial, benchmark estimate, measured cost or adoption disposition is produced"] };
  });
}
