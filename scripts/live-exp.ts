import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as ops from "../src/commands.ts";
import { ATTEMPT_BYTES, type Attempt } from "../src/exp/attempts.ts";
import { readArtifactArchive } from "../src/exp/artifacts.ts";
import { runOnExecutor, spawnRunner, validateExecutor, type Executor, type ProcessRunner } from "../src/exp/executor.ts";
import { LOG_COPY_BYTES, METRICS_BYTES, parseMetrics } from "../src/exp/metrics.ts";
import { validateProtocol } from "../src/exp/protocol.ts";
import { createHttp } from "../src/http.ts";
import { readBytesBounded, readLedger, readTextBounded, sha256, writeAtomic } from "../src/study.ts";
import { probeSnapshotExtraction } from "./live-exp-probe.ts";

export const DEFAULT_LIVE_IMAGE = "busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";
const FILE_BYTES = 65_536, SUMMARY_BYTES = 16_384;
const sourceRoot = fileURLToPath(new URL("../", import.meta.url)), fixtures = join(sourceRoot, "test", "fixtures", "exp");
export interface LiveOptions { host: string; image: string }
export interface LiveRuntime { runner?: ProcessRunner }
export interface LiveSummary {
  v: 1; host: string; image: string; harnessCommit: string; controllerBun: string | null; dockerVersion: string; user: string;
  study: string; privateExecutorWorkdir: string; parentSecretAbsent: boolean;
  attempts: { label: string; id: string; commit: string; status: string; score: number; candidateContainer: string; evaluatorContainer: string; separateContainers: boolean; evaluatorReadOnly: boolean; candidateHasNoEvaluator: boolean }[];
  isolation: { evaluatorReadExit: number; resultWriteExit: number; stderr: string; printedScoreIgnored: boolean };
  stoppedEvaluatorResult: { containerStopped: boolean; metricsSha256: string };
  oversizedLog: { attempt: string; status: string; observedStdoutAtLeastBytes: number; retainedBytes: number; sha256: string; truncated: boolean };
  logRead: { command: string; attempt: string; tailBytes: number; returnedStreams: number; returnedCandidateStderrBytes: number; studyBytesUnchanged: boolean; files: number; bytes: number; beforeSha256: string; afterSha256: string };
  snapshotProbe: Awaited<ReturnType<typeof probeSnapshotExtraction>>;
  removedContainers: number;
}
export function parseLiveOptions(args: string[]): LiveOptions {
  let host: string | undefined, image = DEFAULT_LIVE_IMAGE;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    if (!["--host", "--image"].includes(option) || seen.has(option)) throw new Error("live-exp: unknown or repeated option; use --host ALIAS [--image NAME@sha256:DIGEST]");
    seen.add(option); const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("live-exp: option value missing; use --host ALIAS [--image NAME@sha256:DIGEST]");
    if (option === "--host") host = value; else image = value;
  }
  if (!host) throw new Error("live-exp: host missing; run bun scripts/live-exp.ts --host dgx-h100-2");
  validateExecutor({ v: 1, kind: "ssh", host, workdir: "/tmp" });
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("live-exp: digest-pinned image required; pass --image NAME@sha256:<64 lowercase hex digits>");
  return { host, image };
}
async function checked(command: string, args: string[], runner: ProcessRunner): Promise<string> {
  let response;
  try { response = await runner({ command, args, timeoutMs: 300_000 }); }
  catch { throw new Error("live-exp: local fixture command failed; check Git/Bun and rerun the live fixture"); }
  if (response.exitCode !== 0 || response.timedOut || response.truncated) throw new Error("live-exp: local fixture command failed; check Git/Bun and rerun the live fixture");
  return response.stdout.trim();
}
/** Build all commits before execution, proving the selected archive ignores the current worktree. */
export async function prepareSyntheticRepository(root: string, runner: ProcessRunner = spawnRunner) {
  const repo = join(root, "candidate"), emptyTemplate = join(root, "empty-git-template");
  mkdirSync(repo, { recursive: true }); mkdirSync(emptyTemplate, { recursive: true });
  const git = (args: string[]) => checked("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "core.attributesFile=/dev/null", "-c", `init.templateDir=${emptyTemplate}`, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", ...args], runner);
  await git(["init", "-q"]);
  writeAtomic(join(repo, "candidate.sh"), readTextBounded(join(fixtures, "candidate.sh"), FILE_BYTES), FILE_BYTES);
  await git(["add", "candidate.sh"]); await git(["commit", "-qm", "Synthetic baseline"]); const baseline = await git(["rev-parse", "HEAD"]);
  writeAtomic(join(repo, "candidate.sh"), readTextBounded(join(fixtures, "adversarial.sh"), FILE_BYTES), FILE_BYTES);
  await git(["add", "candidate.sh"]); await git(["commit", "-qm", "Synthetic isolation adversary"]); const adversarial = await git(["rev-parse", "HEAD"]);
  writeAtomic(join(repo, "candidate.sh"), readTextBounded(join(fixtures, "noisy.sh"), FILE_BYTES), FILE_BYTES);
  await git(["add", "candidate.sh"]); await git(["commit", "-qm", "Synthetic oversized stdout"]); const noisy = await git(["rev-parse", "HEAD"]);
  if (![baseline, adversarial, noisy].every(commit => /^[a-f0-9]{40}$/.test(commit)) || new Set([baseline, adversarial, noisy]).size !== 3) throw new Error("live-exp: fixture commits invalid; restore the synthetic candidate fixtures and retry");
  return { repo, baseline, adversarial, noisy };
}
/** Compare raw ledger/record bytes, not parsed JSON, around explicit read-only CLI access. */
export function studyByteSnapshot(study: string, attempts: Pick<Attempt, "id" | "run">[]) {
  const files: [string, number][] = [["ledger.jsonl", 64 * 1024 * 1024]];
  for (const attempt of attempts) {
    if (!/^[a-f0-9]{16}$/.test(attempt.id) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(attempt.run)) throw new Error("live log audit: invalid attempt identity; use records returned by attempt run");
    files.push([`runs/${attempt.run}/attempts/${attempt.id}.json`, ATTEMPT_BYTES]);
  }
  let bytes = 0;
  const manifest = files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bound]) => { const content = readBytesBounded(join(study, path), bound); bytes += content.length; return [path, content.length, sha256(content)]; });
  return { files: files.length, bytes, sha256: sha256(JSON.stringify(manifest)) };
}
async function remote(executor: Executor, command: string, args: string[], runner: ProcessRunner, trim = true): Promise<string> {
  let response;
  try { response = await runOnExecutor(executor, command, args, runner, { timeoutMs: 300_000, maxOutputBytes: 8192 }); }
  catch { throw new Error(`executor ${executor.host}: live setup/readback failed; check the executor host and rerun the fixture`); }
  if (response.exitCode !== 0 || response.timedOut || response.truncated) throw new Error(`executor ${executor.host}: live setup/readback failed; check the executor host and rerun the fixture`);
  return trim ? response.stdout.trim() : response.stdout;
}
function successful(attempt: Attempt) {
  const score = attempt.metrics.find(metric => metric.name === "score");
  if (attempt.status !== "succeeded" || score?.value !== 1 || score.provenance !== "ares-observed" || !attempt.stages.candidate?.containerId || !attempt.stages.evaluator?.containerId || !attempt.sealing.separateContainers || !attempt.sealing.evaluatorReadOnly || !attempt.sealing.candidateHasNoEvaluator) throw new Error(`live-exp: ${attempt.label} did not satisfy the fixture; inspect its attempt record and executor logs before retrying`);
  return { label: attempt.label, id: attempt.id, commit: attempt.commit, status: attempt.status, score: score.value, candidateContainer: attempt.stages.candidate.containerId, evaluatorContainer: attempt.stages.evaluator.containerId, separateContainers: attempt.sealing.separateContainers, evaluatorReadOnly: attempt.sealing.evaluatorReadOnly, candidateHasNoEvaluator: attempt.sealing.candidateHasNoEvaluator };
}
/** Real Docker/SSH execution is opt-in through this script, never through bun run check. */
export async function runLiveExperiment(options: LiveOptions, runtime: LiveRuntime = {}): Promise<LiveSummary> {
  parseLiveOptions(["--host", options.host, "--image", options.image]);
  const runner = runtime.runner ?? spawnRunner, localRoot = mkdtempSync(join(tmpdir(), "ares-live-")), study = join(localRoot, "study"), provisional: Executor = { v: 1, kind: "ssh", host: options.host, workdir: "/tmp" };
  const harnessCommit = await checked("git", ["-C", sourceRoot, "rev-parse", "HEAD"], runner);
  const root = await remote(provisional, "mktemp", ["-d", "/tmp/ares-live.XXXXXXXX"], runner), executor = validateExecutor({ ...provisional, workdir: root });
  const ctx: ops.Ctx = { actor: { kind: "agent", id: "live-exp" }, http: createHttp({}, async () => { throw new Error("live fixture forbids HTTP clients"); }), runner };
  const sentinelName = "ARES_LIVE_SECRET_TOKEN", previous = process.env[sentinelName], sentinel = `synthetic-live-only-${randomUUID()}`;
  process.env[sentinelName] = sentinel;
  let studyId: string | undefined, removedContainers = 0, summary: LiveSummary | undefined;
  try {
    const created = ops.init(study, { question: "Synthetic CPU executor isolation?", mode: "experiment", autonomy: "gates" }, ctx); studyId = created.study.id;
    mkdirSync(join(study, "task", "evaluator"), { recursive: true });
    for (const relative of ["task.md", "evaluator/evaluate.sh", "evaluator/private.txt"]) writeAtomic(join(study, "task", relative), readTextBounded(join(fixtures, relative), FILE_BYTES), FILE_BYTES);
    const repository = await prepareSyntheticRepository(localRoot, runner);
    const protocol = validateProtocol({ v: 1, method: "Synthetic integer comparison with evaluator-only metrics", candidate: { image: options.image, command: ["sh", "/workspace/candidate.sh"] }, evaluator: { image: options.image, command: ["sh", "/eval/evaluate.sh"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 64, wallSeconds: 30, gpus: 0 }, network: "none", budget: { maxAttempts: 4, maxWallHours: 1, maxGpuHours: 0 } });
    await ops.protocol(study, protocol, ctx); await ops.executorSet(study, executor, ctx); const checkedExecutor = await ops.executorCheck(study, ctx); await ops.gateDecide(study, "design", "approve", undefined, ctx);
    const run = `live-${randomUUID().slice(0, 8)}`;
    const baseline = await ops.attemptRun(study, { repo: repository.repo, commit: repository.baseline, run, label: "baseline" }, ctx); successful(baseline);
    const adversarial = await ops.attemptRun(study, { repo: repository.repo, commit: repository.adversarial, run, label: "adversarial" }, ctx); successful(adversarial);
    const noisy = await ops.attemptRun(study, { repo: repository.repo, commit: repository.noisy, run, label: "oversized-stdout" }, ctx); successful(noisy);
    const noisyLog = noisy.stages.candidate!.evidence?.logs.stdout;
    const volume = Number(await remote(executor, "sh", ["-c", `docker logs ${noisy.stages.candidate!.containerId!} 2>/dev/null | head -c ${LOG_COPY_BYTES + 1} | wc -c`], runner));
    if (!noisyLog || noisyLog.bytes !== LOG_COPY_BYTES || !noisyLog.truncated || !Number.isSafeInteger(volume) || volume <= LOG_COPY_BYTES) throw new Error("live-exp: oversized stdout did not succeed with capped/truncated evidence; inspect host log capture before acceptance");
    const records = [baseline, adversarial, noisy], beforeLogs = studyByteSnapshot(study, records);
    const cliLogs = JSON.parse(await checked(process.execPath, [join(sourceRoot, "bin", "ares.js"), "attempt", "logs", study, adversarial.id, "--tail", "2048", "--json"], runner)) as { id: string; logs: { stage: string; stream: string; text: string; tailBytes: number }[] };
    const afterLogs = studyByteSnapshot(study, records);
    const stderrEntry = cliLogs.logs.find(log => log.stage === "candidate" && log.stream === "stderr"), stdoutEntry = cliLogs.logs.find(log => log.stage === "candidate" && log.stream === "stdout");
    if (cliLogs.id !== adversarial.id || !stderrEntry || !stdoutEntry || beforeLogs.sha256 !== afterLogs.sha256 || beforeLogs.bytes !== afterLogs.bytes) throw new Error("live-exp: CLI log read changed study bytes or omitted the requested tail; inspect read-only log access before acceptance");
    const stderr = stderrEntry.text, stdout = stdoutEntry.text;
    const markerFile = posix.join(adversarial.paths.output, "isolation.txt"), marker = await remote(executor, "head", ["-c", "4097", markerFile], runner, false);
    const expected = adversarial.outputs.find(output => output.path === markerFile);
    if (!expected || Buffer.byteLength(marker) > 4096 || sha256(marker) !== expected.sha256) throw new Error("live-exp: isolation marker differs from its artifact receipt; inspect the private executor output before retrying");
    const readExit = Number(/^eval_read_exit=(\d+)$/m.exec(marker)?.[1]), writeExit = Number(/^result_write_exit=(\d+)$/m.exec(marker)?.[1]);
    if (!Number.isSafeInteger(readExit) || readExit <= 0 || !Number.isSafeInteger(writeExit) || writeExit <= 0 || !stderr.includes("eval_read_error:") || !stderr.includes("result_write_error:") || !stdout.includes('{"score":999}')) throw new Error("live-exp: adversarial isolation evidence is incomplete; inspect candidate logs and isolation.txt before retrying");
    const evaluator = baseline.stages.evaluator!.containerId!, stopped = await remote(executor, "docker", ["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", evaluator], runner);
    const copied = await readArtifactArchive(executor, "docker", ["cp", `${evaluator}:/result/.`, "-"], runner, { capture: "metrics.json", captureBytes: METRICS_BYTES });
    if (stopped !== "false 0" || !copied.captured || parseMetrics(copied.captured, protocol)[0]?.value !== 1) throw new Error("live-exp: stopped evaluator bind-mount readback failed; inspect Docker cp behavior before accepting the fixture");
    const snapshotProbe = await probeSnapshotExtraction(executor, root, runner);
    if (!snapshotProbe.outsideUnchanged) throw new Error("live-exp: adversarial archive escaped its snapshot; stop acceptance and fix executor extraction");
    const audit = [readTextBounded(join(study, "study.json"), FILE_BYTES), readTextBounded(join(study, "design", "protocol.json"), FILE_BYTES), readTextBounded(join(study, "executor.json"), 8192), JSON.stringify(readLedger(study)), ...records.map(attempt => readTextBounded(join(study, "runs", attempt.run, "attempts", `${attempt.id}.json`), ATTEMPT_BYTES))];
    if (audit.some(text => text.includes(sentinel) || text.includes('{"score":999}'))) throw new Error("live-exp: private process/log content entered the study; stop acceptance and inspect record persistence");
    summary = { v: 1, host: options.host, image: options.image, harnessCommit, controllerBun: process.versions.bun ?? null, dockerVersion: checkedExecutor.serverVersion, user: checkedExecutor.user, study, privateExecutorWorkdir: root, parentSecretAbsent: true, attempts: records.map(successful), isolation: { evaluatorReadExit: readExit, resultWriteExit: writeExit, stderr, printedScoreIgnored: adversarial.metrics[0]!.value === 1 }, stoppedEvaluatorResult: { containerStopped: true, metricsSha256: sha256(copied.captured) }, oversizedLog: { attempt: noisy.id, status: noisy.status, observedStdoutAtLeastBytes: volume, retainedBytes: noisyLog.bytes, sha256: noisyLog.sha256, truncated: noisyLog.truncated }, logRead: { command: "ares attempt logs", attempt: adversarial.id, tailBytes: 2048, returnedStreams: cliLogs.logs.length, returnedCandidateStderrBytes: stderrEntry.tailBytes, studyBytesUnchanged: true, files: beforeLogs.files, bytes: beforeLogs.bytes, beforeSha256: beforeLogs.sha256, afterSha256: afterLogs.sha256 }, snapshotProbe, removedContainers: 0 };
    return summary;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "live-exp failed"}; fixture study=${study}; private executor workdir=${root}`);
  } finally {
    if (previous === undefined) delete process.env[sentinelName]; else process.env[sentinelName] = previous;
    // Cleanup is scoped to our fresh study label, never a daemon-wide prune or another study's container name.
    if (studyId) {
      const ids = await remote(executor, "docker", ["ps", "--all", "--no-trunc", "--filter", `label=ares.study=${studyId}`, "--format", "{{.ID}}"], runner);
      for (const cid of ids.split(/\s+/).filter(Boolean)) { if (!/^[a-f0-9]{64}$/.test(cid)) throw new Error("live-exp: invalid cleanup identity; inspect the labeled fixture containers manually"); await remote(executor, "docker", ["rm", "-f", cid], runner); removedContainers++; }
    }
    if (summary) { summary.removedContainers = removedContainers; if (Buffer.byteLength(JSON.stringify(summary, null, 2)) > SUMMARY_BYTES) throw new Error("live-exp: summary exceeds its bound; narrow the fixture diagnostics before reporting"); }
  }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await runLiveExperiment(parseLiveOptions(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "live-exp: failed; inspect the private fixture records"); process.exitCode = 1; }
}
