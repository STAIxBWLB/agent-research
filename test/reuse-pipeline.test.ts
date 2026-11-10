import { executionView } from "../src/exp/pipeline.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autonomySet, gateDecide } from "../src/commands.ts";
import { CONTROL_STALE_MS, reconcileAttempts, runAttempt, showAttempt, type Attempt } from "../src/exp/attempts.ts";
import { readAttemptLogs } from "../src/exp/logs.ts";
import { retainedOperation } from "../src/exp/retention.ts";
import { canonical, designBinding, readProtocol, setProtocol } from "../src/exp/protocol.ts";
import { attemptReuseView } from "../src/provenance.ts";
import { commit, readBytesBounded, readJsonFile, readLedger, readTextBounded, sha256, withLock, writeAtomic } from "../src/study.ts";
import { fakeHttp } from "./helpers.ts";
import { actor, cleanupPipelineFixtures, setup } from "./pipeline-fixture.ts";

afterEach(cleanupPipelineFixtures);
type Fixture = Awaited<ReturnType<typeof setup>>;
const runOptions = (f: Fixture) => ({ repo: f.repo, commit: f.commit, run: "investigate", detach: true });
const operation = (request: Fixture["fake"]["requests"][number]) => request.command === "python3" && request.stdin instanceof Uint8Array ? (JSON.parse(new TextDecoder().decode(request.stdin)) as Record<string, unknown>).op : undefined;
async function finish(f: Fixture, initial: Attempt, ctx = f.fake.ctx): Promise<Attempt> {
  let attempt = initial;
  for (let step = 0; step < 32 && attempt.status === "running"; step++) {
    const running = [...f.fake.containers.values()].filter(container => container.running);
    expect(running.length).toBeLessThanOrEqual(1);
    if (running.length) f.fake.finish();
    await reconcileAttempts(f.dir, ctx); attempt = showAttempt(f.dir, attempt.id);
  }
  expect(attempt.status).not.toBe("running");
  return attempt;
}
async function source(f: Fixture): Promise<Attempt> {
  const attempt = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible" }, f.fake.ctx));
  expect(attempt.status).toBe("succeeded");
  expect(f.fake.executed).toEqual(["prepare", "train", "predict", "evaluate"]);
  return attempt;
}
async function verifiedHit(f: Fixture, first: Attempt): Promise<Attempt> {
  const before = f.fake.executed.length;
  const reused = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: first.id }, f.fake.ctx));
  expect(reused.status).toBe("succeeded");
  expect(reused.pipeline!.completed.every(completed => completed.reuse !== undefined)).toBe(true);
  expect(attemptReuseView(reused)?.reusedStages).toBe(3);
  expect(f.fake.executed.slice(before)).toEqual(["evaluate"]);
  return reused;
}
function objectPath(f: Fixture, attempt: Attempt, stage: string, suffix: string): string {
  return join(f.workdir, attempt.studyId, ".retained", "objects", attempt.id, stage, suffix);
}

// This exercises real private Git/tar/Python retention/materialization. Docker execution/observation alone is fake.
test("eligible reused pipeline is byte-exact to fresh output while executing a new evaluator only", async () => {
  const f = await setup({ reuse: true }), first = await source(f);
  const recordPath = join(f.dir, "runs", first.run, "attempts", `${first.id}.json`), originalRecord = readBytesBounded(recordPath, 1024 * 1024);
  const expectedPrediction = readTextBounded(join(first.paths.output, "predict", "predictions.txt"), 1024);
  const firstMetrics = readBytesBounded(join(first.paths.result, "metrics.json"), 65536);
  const reused = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: first.id }, f.fake.ctx));
  expect(reused.status).toBe("succeeded"); expect(reused.id).not.toBe(first.id);
  expect(f.fake.executed).toEqual(["prepare", "train", "predict", "evaluate", "evaluate"]);
  expect(readTextBounded(join(reused.paths.output, "predict", "predictions.txt"), 1024)).toBe(expectedPrediction);
  expect(readBytesBounded(join(reused.paths.result, "metrics.json"), 65536)).toEqual(firstMetrics);
  expect(reused.metrics).toEqual(first.metrics);
  expect(reused.stages.evaluator?.containerId).not.toBe(first.stages.evaluator?.containerId);
  expect(reused.pipeline?.completed).toHaveLength(3);
  for (const [index, completed] of reused.pipeline!.completed.entries()) {
    expect(completed.reuse?.source).toEqual(first.pipeline!.completed[index]!.ref);
    expect(completed.ref).toEqual(first.pipeline!.completed[index]!.ref);
    expect(completed.record.containerId).toBe(first.pipeline!.completed[index]!.record.containerId);
    expect(reused.reuse?.stages[completed.name]?.outcome).toBe("reused");
  }
  const view = attemptReuseView(reused)!;
  expect(view.reusedStages).toBe(3); expect(view.executedCandidateStages).toBe(0);
  expect(view.freshEvaluations).toBe(1); expect(view.independentSamples).toBe(0);
  expect(readBytesBounded(recordPath, 1024 * 1024)).toEqual(originalRecord);
  const executions = f.fake.executed.length, lookupCount = f.fake.requests.filter(request => operation(request) === "lookup").length;
  expect((await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: first.id }, f.fake.ctx)).id).toBe(reused.id);
  await reconcileAttempts(f.dir, f.fake.ctx);
  expect(f.fake.executed).toHaveLength(executions);
  expect(f.fake.requests.filter(request => operation(request) === "lookup")).toHaveLength(lookupCount);
}, 30_000);

test("default fresh and explicit force-fresh retry do not consume available reuse hits", async () => {
  const f = await setup({ reuse: true }), first = await source(f);
  const fresh = await finish(f, await runAttempt(f.dir, { ...runOptions(f), retry: first.id }, f.fake.ctx));
  expect(fresh.status).toBe("succeeded"); expect(fresh.v).toBe(2);
  expect(f.fake.executed).toHaveLength(8);
  const lookupCount = f.fake.requests.filter(request => operation(request) === "lookup").length;
  const forced = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", forceFresh: true, retry: fresh.id }, f.fake.ctx));
  expect(forced.status).toBe("succeeded"); expect(f.fake.executed).toHaveLength(12);
  expect(forced.pipeline!.completed.every(completed => completed.reuse === undefined)).toBe(true);
  expect(f.fake.requests.filter(request => operation(request) === "lookup")).toHaveLength(lookupCount);
  await expect(runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", forceFresh: true }, f.fake.ctx)).rejects.toThrow("retry");
}, 30_000);

test("reuse remains outside other runs and reserved phases keep ordinary authorization", async () => {
  const f = await setup({ reuse: true }), first = await source(f);
  const lookups = f.fake.requests.filter(request => operation(request) === "lookup").length;
  const other = await finish(f, await runAttempt(f.dir, { ...runOptions(f), run: "probe-other", reuse: "eligible" }, f.fake.ctx));
  expect(other.status).toBe("succeeded"); expect(other.pipeline!.completed.every(completed => completed.reuse === undefined)).toBe(true);
  expect(f.fake.requests.filter(request => operation(request) === "lookup")).toHaveLength(lookups);
  for (const run of ["final", "posthoc"]) await expect(runAttempt(f.dir, { ...runOptions(f), run, reuse: "eligible" }, f.fake.ctx)).rejects.toThrow();
  const ablate = await finish(f, await runAttempt(f.dir, { ...runOptions(f), run: "ablate", reuse: "eligible" }, f.fake.ctx));
  expect(ablate.status).toBe("succeeded"); expect(ablate.pipeline!.completed.every(completed => completed.reuse === undefined)).toBe(true);
  expect(f.fake.requests.filter(request => operation(request) === "lookup")).toHaveLength(lookups);
  expect(first.metrics).toEqual(other.metrics); expect(first.metrics).toEqual(ablate.metrics);
}, 30_000);

test("pruned and corrupt source bytes are reasoned misses followed by ordinary fresh execution", async () => {
  for (const fault of ["pruned", "corrupt"] as const) {
    const f = await setup({ reuse: true }), first = await source(f), control = await verifiedHit(f, first), ref = first.pipeline!.completed[0]!.ref;
    if (fault === "pruned") {
      const preview = await retainedOperation(first.executor, { op: "prune", studyId: first.studyId, refs: [ref] }, f.fake.ctx.runner!);
      await retainedOperation(first.executor, { op: "prune", studyId: first.studyId, refs: [ref], fingerprint: preview.fingerprint }, f.fake.ctx.runner!);
    } else {
      const path = objectPath(f, first, "prepare", "data/rows.txt"); chmodSync(path, 0o600); writeFileSync(path, "synthetic tampered bytes");
    }
    const retried = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: control.id }, f.fake.ctx));
    expect(retried.status).toBe("succeeded"); expect(retried.metrics).toEqual(first.metrics);
    expect(retried.reuse?.stages.prepare?.outcome).toBe("fresh"); expect(retried.reuse?.stages.prepare?.reason).toBe(fault);
    expect(retried.pipeline!.completed.every(completed => completed.reuse === undefined)).toBe(true);
    expect(f.fake.executed).toHaveLength(9);
    expect(readTextBounded(join(retried.paths.output, "predict", "predictions.txt"), 1024)).toBe("synthetic:rows:model:predictions");
  }
}, 40_000);

test("a non-succeeded source attempt misses as ineligible-source while a succeeded one still hits", async () => {
  for (const status of ["succeeded", "cancelled", "unknown"] as const) {
    const f = await setup({ reuse: true }), first = await source(f);
    if (status !== "succeeded") {
      // Only the recorded status changes: the sealed candidate stages and every other byte stay as the producer wrote them.
      const recordPath = join(f.dir, "runs", first.run, "attempts", `${first.id}.json`), record = JSON.parse(readTextBounded(recordPath, 1024 * 1024)) as Attempt;
      record.status = status;
      commit(f.dir, [[recordPath, JSON.stringify(record, null, 2) + "\n", 1024 * 1024]], [{ actor, type: status === "cancelled" ? "attempt.cancelled" : "attempt.unknown", data: { id: record.id, run: record.run, stage: record.stage, status } }]);
    }
    const before = f.fake.executed.length;
    const retried = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: first.id }, f.fake.ctx));
    expect(retried.status).toBe("succeeded");
    if (status === "succeeded") {
      expect(f.fake.executed.slice(before)).toEqual(["evaluate"]);
      for (const stage of ["prepare", "train", "predict"] as const) expect(retried.reuse?.stages[stage]?.outcome).toBe("reused");
      expect(attemptReuseView(retried)?.reusedStages).toBe(3);
    } else {
      expect(retried.pipeline!.completed.every(completed => completed.reuse === undefined)).toBe(true);
      expect(f.fake.executed.slice(before)).toEqual(["prepare", "train", "predict", "evaluate"]);
      // The first stage meets the sealed source and is refused as ineligible-source; a downstream stage's key no longer
      // matches after that fresh run, so it reports missing rather than a hit.
      const reasons = (["prepare", "train", "predict"] as const).map(stage => retried.reuse?.stages[stage]?.reason);
      expect(reasons[0]).toBe("ineligible-source"); expect(reasons.slice(1).every(reason => reason === "missing")).toBe(true);
      expect((["prepare", "train", "predict"] as const).every(stage => retried.reuse?.stages[stage]?.outcome === "fresh")).toBe(true);
      expect(attemptReuseView(retried)?.reusedStages).toBe(0);
    }
  }
}, 60_000);

test("a forged matching lookup index cannot admit a manifest with the wrong producing identity", async () => {
  const f = await setup({ reuse: true }), first = await source(f), control = await verifiedHit(f, first);
  const manifestPath = objectPath(f, first, "prepare", "manifest.json"), archivePath = join(f.workdir, first.studyId, ".retained", "archive", first.id.slice(0, 2), `${first.id}.json`);
  const manifest = readJsonFile(manifestPath, 256 * 1024) as { identity: { argvHash: string } };
  manifest.identity.argvHash = "f".repeat(64);
  const manifestText = JSON.stringify(manifest); chmodSync(manifestPath, 0o600); writeFileSync(manifestPath, manifestText);
  const archive = readJsonFile(archivePath, 64 * 1024) as { entries: Record<string, { sha256: string }> };
  archive.entries[`${first.id}/prepare`]!.sha256 = sha256(manifestText);
  chmodSync(archivePath, 0o600); writeFileSync(archivePath, JSON.stringify(archive));
  const next = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: control.id }, f.fake.ctx));
  expect(next.status).toBe("succeeded"); expect(next.metrics).toEqual(first.metrics);
  expect(next.reuse?.stages.prepare?.outcome).toBe("fresh");
  expect(next.pipeline!.completed.every(completed => completed.reuse === undefined)).toBe(true);
  expect(f.fake.executed).toHaveLength(9);
}, 30_000);

test("current gate and attempt budgets are checked before a hit can bypass admission", async () => {
  for (const guard of ["gate", "budget"] as const) {
    const f = await setup({ reuse: true }), first = await source(f), ctx = { actor, http: fakeHttp([]).http };
    const before = f.fake.requests.filter(request => operation(request) === "lookup").length;
    if (guard === "gate") await gateDecide(f.dir, "design", "reject", "Synthetic approval withdrawn", ctx);
    else {
      await withLock(f.dir, () => {
        const protocol = readProtocol(f.dir)!; protocol.budget.maxAttempts = 1; setProtocol(f.dir, protocol, actor);
      });
      await gateDecide(f.dir, "design", "approve", undefined, ctx);
    }
    await expect(runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: first.id }, f.fake.ctx)).rejects.toThrow(guard === "gate" ? "design" : "budget");
    expect(f.fake.requests.filter(request => operation(request) === "lookup")).toHaveLength(before);
    expect(f.fake.executed).toHaveLength(4);
  }
}, 30_000);

test("an uncertain owned attempt is returned idempotently without fresh execution or another lookup", async () => {
  const f = await setup({ reuse: true }), initial = await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible" }, f.fake.ctx);
  await withLock(f.dir, () => {
    const current = showAttempt(f.dir, initial.id); current.reason = "executor-start-uncertain"; delete current.launching;
    writeAtomic(join(f.dir, "runs", current.run, "attempts", `${current.id}.json`), JSON.stringify(current, null, 2) + "\n", 1024 * 1024);
  });
  const before = f.fake.requests.filter(request => operation(request) === "lookup").length;
  const same = await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible" }, f.fake.ctx);
  expect(same.id).toBe(initial.id); expect(same.status).toBe("running"); expect(same.reason).toBe("executor-start-uncertain");
  expect(f.fake.requests.filter(request => operation(request) === "lookup")).toHaveLength(before);
  expect(f.fake.executed).toEqual(["prepare"]);
});


test("current copilot acceptance is rechecked after a native hit before local reuse admission", async () => {
  const f = await setup({ reuse: true });
  // A real draft exists, but gates mode does not require separate draft acceptance yet.
  writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic hypothesis requiring explicit acceptance after policy changes");
  const first = await source(f), original = f.fake.ctx.runner!, binding = designBinding(f.dir);
  const recordPath = join(f.dir, "runs", first.run, "attempts", `${first.id}.json`), originalRecord = readBytesBounded(recordPath, 1024 * 1024);
  const sourceRef = first.pipeline!.completed[0]!.ref;
  let changedPolicyAfterHit = false, pinnedAtPolicyChange = false;
  const changed: import("../src/exp/attempts.ts").AttemptContext = { ...f.fake.ctx, runner: async request => {
    const response = await original(request);
    if (!changedPolicyAfterHit && operation(request) === "lookup" && JSON.parse(response.stdout).hit === true) {
      changedPolicyAfterHit = true;
      await autonomySet(f.dir, "copilot", "hypotheses", { actor });
      expect(designBinding(f.dir)).toBe(binding);
      const view = await retainedOperation(first.executor, { op: "inspect", studyId: first.studyId }, original);
      pinnedAtPolicyChange = view.entries?.some(entry => entry.ref.attemptId === sourceRef.attemptId && entry.ref.stage === sourceRef.stage && entry.ref.sha256 === sourceRef.sha256 && entry.active) ?? false;
      expect(view.reservedBytes).toBeGreaterThan(0);
    }
    return response;
  } };
  const blocked = await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: first.id }, changed);
  expect(changedPolicyAfterHit).toBe(true); expect(pinnedAtPolicyChange).toBe(true);
  expect(blocked.status).toBe("failed"); expect(blocked.error).toContain("acceptance");
  expect(blocked.pipeline!.completed).toEqual([]); expect(blocked.reuse?.stages.prepare?.outcome).not.toBe("reused");
  expect(blocked.metrics).toEqual([]); expect(blocked.stages.evaluator).toBeUndefined();
  expect(f.fake.executed).toEqual(["prepare", "train", "predict", "evaluate"]);
  expect(readLedger(f.dir).filter(event => event.type === "attempt.stage.reused")).toEqual([]);
  expect(readBytesBounded(recordPath, 1024 * 1024)).toEqual(originalRecord);
  const after = await retainedOperation(first.executor, { op: "inspect", studyId: first.studyId }, original);
  expect(after.reservedBytes).toBe(0);
  expect(after.entries?.find(entry => entry.ref.attemptId === sourceRef.attemptId && entry.ref.stage === sourceRef.stage)?.active).toBe(false);
}, 30_000);


test("v3 readers refuse corrupt known reuse receipt fields without rewriting records or reaching an executor", async () => {
  const f = await setup({ reuse: true }), first = await source(f), reused = await verifiedHit(f, first);
  const path = join(f.dir, "runs", reused.run, "attempts", `${reused.id}.json`), saved = readBytesBounded(path, 1024 * 1024);
  expect(reused.v).toBe(3); expect(reused.pipeline!.completed[0]!.reuse!.context).toBeDefined();
  const originalCalls = f.fake.requests.length;
  const changes: ((value: Attempt) => void)[] = [
    value => { value.pipeline!.completed[0]!.reuse!.original.wallSeconds = -1; },
    value => { value.pipeline!.completed[0]!.reuse!.original.gpuHours = -1; },
    // Deliberately corrupt the literal-only CPU field at the serialized-record boundary.
    value => { value.pipeline!.completed[0]!.reuse!.original.cpuSeconds = 0 as unknown as "unknown"; },
    value => { value.pipeline!.completed[0]!.reuse!.verificationMs = -1; },
    value => { value.pipeline!.completed[0]!.reuse!.materializationMs = -1; },
    value => { value.reuse!.stages.prepare!.outcome = "opaque" as "fresh"; },
    value => { value.reuse!.stages.prepare!.key = "invalid-key"; },
    value => { value.reuse!.stages.prepare!.key = "0".repeat(64); },
    value => { value.reuse!.stages.prepare!.context = undefined; },
    value => { value.reuse!.stages.prepare!.context!.runtime.semantics = ""; },
    value => { value.reuse!.stages.prepare!.context!.populationSha256 = "0".repeat(64); },
    value => { value.reuse!.stages.prepare!.verificationMs = -1; },
    value => { value.reuse!.failureMs = -1; },
  ];
  for (const change of changes) {
    const corrupt = structuredClone(reused); change(corrupt);
    const text = JSON.stringify(corrupt, null, 2) + "\n";
    writeAtomic(path, text, 1024 * 1024);
    try {
      expect(() => showAttempt(f.dir, reused.id)).toThrow("reuse:");
      expect(readBytesBounded(path, 1024 * 1024)).toEqual(Buffer.from(text));
      expect(f.fake.requests).toHaveLength(originalCalls);
    } finally { writeAtomic(path, saved.toString("utf8"), 1024 * 1024); }
  }
  expect(showAttempt(f.dir, reused.id)).toEqual(reused);
}, 30_000);

test("logs for reused candidates point to the original attempt without relabeling or transport", async () => {
  const f = await setup({ reuse: true }), first = await source(f), reused = await verifiedHit(f, first);
  const path = join(f.dir, "runs", reused.run, "attempts", `${reused.id}.json`), saved = readBytesBounded(path, 1024 * 1024);
  let calls = 0;
  await expect(readAttemptLogs(f.dir, reused.id, { candidateStage: "prepare", stream: "stdout" }, async () => {
    calls++; throw new Error("synthetic unexpected log transport");
  })).rejects.toThrow(`source attempt ${first.id}`);
  expect(calls).toBe(0); expect(readBytesBounded(path, 1024 * 1024)).toEqual(saved);
}, 30_000);


test("a valid native hit cannot underreport retained metadata to bypass the shared budget", async () => {
  const f = await setup({ reuse: true }), first = await source(f), control = await verifiedHit(f, first), original = f.fake.ctx.runner!;
  let injected = false;
  const underreported: import("../src/exp/attempts.ts").AttemptContext = { ...f.fake.ctx, runner: async request => {
    const response = await original(request);
    if (!injected && operation(request) === "lookup") {
      const value = JSON.parse(response.stdout) as { hit?: boolean; ref?: unknown; manifest?: { identity: unknown; reuseKey?: string }; manifestBytes?: number };
      if (value.hit === true) {
        const expected = JSON.parse(new TextDecoder().decode(request.stdin as Uint8Array)) as { key: string; expected: unknown };
        expect(value.ref).toEqual(first.pipeline!.completed[0]!.ref);
        expect(value.manifest!.reuseKey).toBe(expected.key);
        expect(canonical(value.manifest!.identity)).toBe(canonical(expected.expected));
        expect(value.manifestBytes).toBeGreaterThan(0);
        injected = true;
        return { ...response, stdout: JSON.stringify({ ...value, manifestBytes: 0 }) };
      }
    }
    return response;
  } };
  const initial = await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: control.id }, underreported);
  const result = await finish(f, initial);
  expect(injected).toBe(true); expect(result.status).toBe("succeeded");
  expect(result.reuse?.stages.prepare?.outcome).toBe("fresh"); expect(result.reuse?.stages.prepare?.reason).toBe("invalid-hit");
  expect(result.pipeline!.completed.every(completed => completed.reuse === undefined)).toBe(true);
  expect(f.fake.executed).toHaveLength(9); expect(result.metrics).toEqual(first.metrics);
}, 30_000);

test("lost lookup acknowledgement recovers the pre-RPC marker and the same pinned source without rerunning candidates", async () => {
  const f = await setup({ reuse: true }), first = await source(f), original = f.fake.ctx.runner!, sourceRef = first.pipeline!.completed[0]!.ref;
  let captured: Attempt | undefined, lostOnce = false, pinHeldBeforeAcknowledgement = false;
  const lost: import("../src/exp/attempts.ts").AttemptContext = { ...f.fake.ctx, runner: async request => {
    const response = await original(request);
    if (!lostOnce && operation(request) === "lookup" && JSON.parse(response.stdout).hit === true) {
      const lookup = JSON.parse(new TextDecoder().decode(request.stdin as Uint8Array)) as { attemptId: string };
      captured = structuredClone(showAttempt(f.dir, lookup.attemptId));
      expect(captured.stages.candidate?.launchPending).toBe(true);
      expect(captured.pipeline?.completed).toEqual([]);
      expect(captured.reuse?.stages.prepare?.outcome).not.toBe("reused");
      const view = await retainedOperation(first.executor, { op: "inspect", studyId: first.studyId }, original);
      pinHeldBeforeAcknowledgement = view.entries?.some(entry => canonical(entry.ref) === canonical(sourceRef) && entry.active) ?? false;
      expect(pinHeldBeforeAcknowledgement).toBe(true); expect(view.reservedBytes).toBeGreaterThan(0);
      lostOnce = true;
      return { exitCode: 255, stdout: "", stderr: "synthetic lookup acknowledgement lost" };
    }
    return response;
  } };
  const pending = await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: first.id }, lost);
  expect(lostOnce).toBe(true); expect(captured).toBeDefined();
  expect(pending.status).toBe("running"); expect(pending.reason).toBe("executor-preflight");
  expect(pending.stages.candidate?.launchPending).toBe(true);
  expect(f.fake.executed).toEqual(["prepare", "train", "predict", "evaluate"]);
  // Restore the exact durable pre-ack state with an expired/dead owner, simulating process death before response handling.
  const beforeAck = captured!; expect(beforeAck.launching).toBeDefined();
  beforeAck.launching!.pid = 2147483647;
  beforeAck.launching!.claimedAt = new Date(f.fake.clock.value - CONTROL_STALE_MS - 1000).toISOString();
  beforeAck.launching!.expiresAt = new Date(f.fake.clock.value - 1).toISOString();
  await withLock(f.dir, () => writeAtomic(join(f.dir, "runs", beforeAck.run, "attempts", `${beforeAck.id}.json`), JSON.stringify(beforeAck, null, 2) + "\n", 1024 * 1024));
  const recovered = await finish(f, showAttempt(f.dir, pending.id));
  expect(recovered.status).toBe("succeeded"); expect(pinHeldBeforeAcknowledgement).toBe(true);
  expect(recovered.pipeline!.completed.map(completed => completed.ref)).toEqual(first.pipeline!.completed.map(completed => completed.ref));
  expect(recovered.pipeline!.completed.every(completed => completed.reuse !== undefined)).toBe(true);
  expect(f.fake.executed).toEqual(["prepare", "train", "predict", "evaluate", "evaluate"]);
  expect(recovered.stages.evaluator?.containerId).not.toBe(first.stages.evaluator?.containerId);
  expect(readLedger(f.dir).filter(event => event.type === "attempt.unknown")).toEqual([]);
  expect((await retainedOperation(first.executor, { op: "inspect", studyId: first.studyId }, original)).reservedBytes).toBe(0);
}, 30_000);

test("a local stage edit reuses only unaffected upstream work and matches a full fresh revised pipeline", async () => {
  const f = await setup({ reuse: true }), original = await source(f);
  const revised = readProtocol(f.dir)!;
  if (revised.v !== 2) throw new Error("synthetic v2 fixture required");
  revised.candidate.stages[1]!.command = ["/synthetic", "--revised-tool-option", "train"];
  await withLock(f.dir, () => setProtocol(f.dir, revised, actor));
  await gateDecide(f.dir, "design", "approve", undefined, { actor, http: fakeHttp([]).http });
  const fresh = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "off", retry: original.id }, f.fake.ctx));
  expect(fresh.status).toBe("succeeded");
  expect(readBytesBounded(join(fresh.paths.output, "predict", "predictions.txt"), 1024)).not.toEqual(readBytesBounded(join(original.paths.output, "predict", "predictions.txt"), 1024));
  const partial = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: fresh.id }, f.fake.ctx));
  expect(partial.status).toBe("succeeded");
  expect(partial.reuse?.stages.prepare?.outcome).toBe("reused");
  expect(partial.pipeline!.completed[0]!.ref).toEqual(original.pipeline!.completed[0]!.ref);
  expect(partial.reuse?.stages.train?.outcome).toBe("fresh"); expect(partial.reuse?.stages.predict?.outcome).toBe("fresh");
  expect(f.fake.executed).toEqual(["prepare", "train", "predict", "evaluate", "prepare", "train", "predict", "evaluate", "train", "predict", "evaluate"]);
  expect(readBytesBounded(join(partial.paths.output, "predict", "predictions.txt"), 1024)).toEqual(readBytesBounded(join(fresh.paths.output, "predict", "predictions.txt"), 1024));
  expect(readBytesBounded(join(partial.paths.result, "metrics.json"), 65536)).toEqual(readBytesBounded(join(fresh.paths.result, "metrics.json"), 65536));
  expect(attemptReuseView(partial)).toMatchObject({ reusedStages: 1, executedCandidateStages: 2, freshEvaluations: 1, independentSamples: 0 });
}, 30_000);


test("force-fresh MCP redelivery preserves running and terminal attempts while changed controls require explicit retry", async () => {
  const f = await setup({ reuse: true }), { actor: _actor, ...runtime } = f.fake.ctx;
  const server = createAresMcp({}, fakeHttp([]).http, runtime);
  const request = { study: f.dir, repo: f.repo, commit: f.commit, run: "investigate", reuse: "eligible", forceFresh: true };
  const first = await server.handlers.ares_attempt_run!(request) as Attempt;
  const path = join(f.dir, "runs", first.run, "attempts", `${first.id}.json`);
  const runningBytes = readBytesBounded(path, 1024 * 1024), runningLedger = readLedger(f.dir);
  expect((await server.handlers.ares_attempt_run!(request) as Attempt).id).toBe(first.id);
  expect(readBytesBounded(path, 1024 * 1024)).toEqual(runningBytes); expect(readLedger(f.dir)).toEqual(runningLedger);
  expect(f.fake.executed).toEqual(["prepare"]);
  const done = await finish(f, first), before = readBytesBounded(path, 1024 * 1024), ledger = readLedger(f.dir), count = f.fake.executed.length;
  expect((await server.handlers.ares_attempt_run!(request) as Attempt).id).toBe(done.id);
  expect(readBytesBounded(path, 1024 * 1024)).toEqual(before); expect(readLedger(f.dir)).toEqual(ledger); expect(f.fake.executed).toHaveLength(count);
  await expect(server.handlers.ares_attempt_run!({ ...request, reuse: "off" })).rejects.toThrow("recorded reuse=eligible, forceFresh=true");
  await expect(server.handlers.ares_attempt_run!({ ...request, forceFresh: false })).rejects.toThrow(`--retry ${done.id}`);
  const retried = await server.handlers.ares_attempt_run!({ ...request, reuse: "off", retry: done.id }) as Attempt;
  expect(retried.id).not.toBe(done.id); expect(retried.retryOf).toBe(done.id);
}, 30_000);

test("wall exhaustion or stale design during a verified lookup cannot admit a hit and releases its pin", async () => {
  for (const fault of ["wall", "design"] as const) {
    const f = await setup({ reuse: true }), first = await source(f), original = f.fake.ctx.runner!;
    const sourcePath = join(f.dir, "runs", first.run, "attempts", `${first.id}.json`), sourceBytes = readBytesBounded(sourcePath, 1024 * 1024);
    let hit = false;
    const interrupted = { ...f.fake.ctx, runner: async (request: Parameters<typeof original>[0]) => {
      const result = await original(request);
      if (!hit && operation(request) === "lookup") {
        const response = JSON.parse(result.stdout); expect(response.hit).toBe(true); hit = true;
        const view = await retainedOperation(first.executor, { op: "inspect", studyId: first.studyId }, original);
        expect(view.entries!.find(entry => entry.ref.attemptId === first.id && entry.ref.stage === "prepare")?.active).toBe(true);
        if (fault === "wall") f.fake.clock.value += 121_000;
        else {
          const changed = readProtocol(f.dir)!; changed.budget.maxAttempts++;
          await withLock(f.dir, () => setProtocol(f.dir, changed, actor));
        }
      }
      return result;
    } };
    const failed = await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: first.id }, interrupted);
    expect(hit).toBe(true); expect(failed.status).toBe("failed");
    expect(failed.reason).toBe(fault === "wall" ? "wall-clock" : "evidence-read");
    expect(failed.pipeline!.completed).toEqual([]); expect(failed.metrics).toEqual([]);
    expect(readLedger(f.dir).some(event => event.type === "attempt.stage.reused" && event.data.id === failed.id)).toBe(false);
    expect(f.fake.executed).toEqual(["prepare", "train", "predict", "evaluate"]);
    expect((await retainedOperation(first.executor, { op: "inspect", studyId: first.studyId }, original)).reservedBytes).toBe(0);
    expect(readBytesBounded(sourcePath, 1024 * 1024)).toEqual(sourceBytes);
    expect(failed.error).toMatch(fault === "wall" ? /budget exhausted/ : /gate list.*retry/);
  }
}, 30_000);

test("executor manifest disagreement with local producing evidence is a reasoned fresh miss", async () => {
  const f = await setup({ reuse: true }), first = await source(f), original = f.fake.ctx.runner!;
  const sourcePath = join(f.dir, "runs", first.run, "attempts", `${first.id}.json`);
  let hit = false;
  const tampered = { ...f.fake.ctx, runner: async (request: Parameters<typeof original>[0]) => {
    const result = await original(request);
    if (!hit && operation(request) === "lookup") {
      const response = JSON.parse(result.stdout); expect(response.hit).toBe(true); hit = true;
      const changed = showAttempt(f.dir, first.id);
      changed.pipeline!.completed[0]!.record.evidence!.outputs[0]!.sha256 = "e".repeat(64);
      writeAtomic(sourcePath, JSON.stringify(changed, null, 2) + "\n", 1024 * 1024);
    }
    return result;
  } };
  const current = await finish(f, await runAttempt(f.dir, { ...runOptions(f), reuse: "eligible", retry: first.id }, tampered), tampered);
  expect(hit).toBe(true); expect(current.status).toBe("succeeded");
  expect(current.reuse!.stages.prepare).toMatchObject({ outcome: "fresh", reason: "invalid-hit" });
  expect(current.pipeline!.completed.every(parent => !parent.reuse)).toBe(true);
  expect(f.fake.executed).toEqual(["prepare", "train", "predict", "evaluate", "prepare", "train", "predict", "evaluate"]);
}, 30_000);


test("legacy fresh requests also preserve new control intent for identical redelivery", async () => {
  const f = await setup({ reuse: true }), current = readProtocol(f.dir)!;
  const legacy = executionView(current); legacy.candidate.command = ["/synthetic", "unsupported-synthetic-stage"];
  await withLock(f.dir, () => setProtocol(f.dir, legacy, actor));
  await gateDecide(f.dir, "design", "approve", undefined, { actor, http: fakeHttp([]).http });
  const request = { ...runOptions(f), reuse: "eligible" as const, forceFresh: true };
  const first = await runAttempt(f.dir, request, f.fake.ctx);
  expect(first.v).toBe(1); expect(first.freshRequest).toEqual({ reuse: "eligible", forceFresh: true });
  const before = readLedger(f.dir), executions = f.fake.executed.length;
  expect((await runAttempt(f.dir, request, f.fake.ctx)).id).toBe(first.id);
  expect(readLedger(f.dir)).toEqual(before); expect(f.fake.executed).toHaveLength(executions);
  await expect(runAttempt(f.dir, { ...request, reuse: "off" }, f.fake.ctx)).rejects.toThrow("recorded reuse=eligible");
});
