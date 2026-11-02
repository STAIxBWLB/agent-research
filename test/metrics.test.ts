import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { collectEvaluation, collectStageEvidence, LOG_COPY_BYTES, METRICS_BYTES, MetricsError, outputBudget, parseMetrics, validateMetrics } from "../src/exp/metrics.ts";
import { ARTIFACT_BYTES } from "../src/exp/artifacts.ts";
import { sha256 } from "../src/study.ts";
import type { ProcessRequest, ProcessRunner } from "../src/exp/executor.ts";
import { logCaptureFixtureRunner, metricAttempt, metricLogTar, metricProtocol, metricTar } from "./metric-fixtures.ts";
import { tempDir } from "./helpers.ts";

function archiveRunner(archives: Buffer[]) {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = async request => {
    requests.push(request); const bytes = archives.shift(); if (!bytes || !request.stdoutSink) throw new Error("unscripted synthetic archive");
    for (let offset = 0; offset < bytes.length; offset += 73) await request.stdoutSink(bytes.subarray(offset, offset + 73));
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, requests };
}
test("AC6: only exact declared finite metrics become ares-observed numbers with protocol units", () => {
  const p = metricProtocol(); p.metrics.push({ name: "loss", unit: "ratio", direction: "min" });
  expect(validateMetrics({ loss: 0.25, score: 7 }, p)).toEqual([{ name: "score", unit: "points", value: 7, provenance: "ares-observed" }, { name: "loss", unit: "ratio", value: 0.25, provenance: "ares-observed" }]);
  for (const [raw, reason] of [[{ score: 1, extra: 99 }, "undeclared-metric"], [{}, "missing-metric"], [{ score: "7" }, "invalid-metric-value"], [{ score: NaN }, "nonfinite-metric"], [{ score: Infinity }, "nonfinite-metric"], [[], "malformed-metrics"]] as const) {
    try { validateMetrics(raw, metricProtocol()); throw new Error("unexpected success"); } catch (error) { expect((error as MetricsError).reason).toBe(reason); expect((error as Error).message).toContain("write /result/metrics.json"); }
  }
});
test("AC6: parsing rejects malformed, duplicate, non-finite, non-UTF8 and oversized metric files", () => {
  const p = metricProtocol();
  for (const [text, reason] of [["not-json synthetic-private-body", "malformed-metrics"], ['{"score":1e999}', "nonfinite-metric"], ['{"score":1,"score":2}', "duplicate-metric"], ['{"unexpected":"synthetic-private-body"}', "undeclared-metric"]] as const) {
    try { parseMetrics(Buffer.from(text), p); throw new Error("unexpected success"); } catch (error) { expect((error as MetricsError).reason).toBe(reason); expect((error as Error).message).not.toContain("synthetic-private"); }
  }
  expect(() => parseMetrics(Buffer.from([255]), p)).toThrow("valid UTF-8 JSON");
  expect(() => parseMetrics(Buffer.alloc(METRICS_BYTES + 1), p)).toThrow("exceeds 65536 bytes");
});
test("AC6: production collector reads evaluator /result only and stores hashes instead of raw bodies", async () => {
  const body = '{"score":7}', fake = archiveRunner([metricTar([{ path: "metrics.json", data: body }, { path: "report.txt", data: "synthetic evaluator report" }])]), attempt = metricAttempt();
  const result = await collectEvaluation(attempt, fake.runner);
  expect(fake.requests).toHaveLength(1); expect(fake.requests[0]?.args).toEqual(["cp", `${attempt.stages.evaluator!.containerId}:/result/.`, "-"]);
  expect(result.metrics[0]?.value).toBe(7); expect(result.outputs.find(file => file.path.endsWith("metrics.json"))).toEqual({ path: `${attempt.paths.result}/metrics.json`, sha256: sha256(body), bytes: Buffer.byteLength(body) });
  expect(JSON.stringify(result)).not.toContain(body); expect(JSON.stringify(result)).not.toContain("synthetic evaluator report");
});
test("AC6: missing, malformed and unsafe evaluator result files fail with named reasons", async () => {
  for (const [archive, reason] of [[metricTar([]), "missing-metrics"], [metricTar([{ path: "metrics.json", data: "synthetic-private-body" }]), "malformed-metrics"], [metricTar([{ path: "metrics.json", type: "2" }]), "invalid-artifact"]] as const) {
    try { await collectEvaluation(metricAttempt(), archiveRunner([archive]).runner); throw new Error("unexpected success"); }
    catch (error) { expect((error as MetricsError).reason).toBe(reason); expect((error as Error).message).not.toContain("synthetic-private-body"); }
  }
});
test("stage evidence hashes candidate output but never treats printed or candidate-file numbers as metrics", async () => {
  const logs = metricLogTar("candidate", 'candidate score=999\n{"score":999}\n', "synthetic error detail\n");
  const fake = archiveRunner([logs, metricTar([{ path: "metrics.json", data: '{"score":999}' }])]), attempt = metricAttempt();
  const stage = await collectStageEvidence(attempt, "candidate", fake.runner);
  expect(Object.keys(stage.logs.stdout).sort()).toEqual(["bytes", "path", "sha256", "truncated"]);
  expect(JSON.stringify(stage)).not.toContain("candidate score=999"); expect(JSON.stringify(stage)).not.toContain('{"score":999}');
  expect(stage.outputs.some(file => file.path === `${attempt.paths.output}/metrics.json`)).toBe(true);
  expect(attempt.metrics).toEqual([]); expect(fake.requests[1]?.args).toEqual(["cp", `${attempt.stages.candidate!.containerId}:/out/.`, "-"]);
  expect(fake.requests[0]?.args.join(" ")).toContain(`head -c ${LOG_COPY_BYTES}`);
});
test("request URLs, response bodies and keys remain exclusively in private logs, never evidence metadata", async () => {
  const body = 'GET https://api.example.test/private?query=sensitive\n{"body":"synthetic-private-body","API_KEY":"synthetic-key-value"}\n';
  const logs = metricLogTar("evaluator", body);
  const result = await collectStageEvidence(metricAttempt(), "evaluator", archiveRunner([logs]).runner);
  expect(result.logs.stdout.sha256).toBe(sha256(body)); expect(result.logs.stdout.bytes).toBe(Buffer.byteLength(body));
  expect(Object.keys(result.logs.stdout).sort()).toEqual(["bytes", "path", "sha256", "truncated"]);
  for (const text of ["https://", "synthetic-private-body", "synthetic-key-value"]) expect(JSON.stringify(result)).not.toContain(text);
});
test("logs have independent evidence and do not consume the 500-file candidate/result inventory", async () => {
  const attempt = metricAttempt(); attempt.outputs = Array.from({ length: 498 }, (_, index) => ({ path: `/private/prior-${index}`, sha256: "a".repeat(64), bytes: 1 }));
  const logs = metricLogTar("candidate", "progress\n");
  const stage = await collectStageEvidence(attempt, "candidate", archiveRunner([logs, metricTar([{ path: "one-output", data: "one" }])]).runner);
  expect(stage.outputs).toHaveLength(1); attempt.outputs.push(...stage.outputs);
  const result = await collectEvaluation(attempt, archiveRunner([metricTar([{ path: "metrics.json", data: '{"score":7}' }])]).runner);
  expect(outputBudget([...attempt.outputs, ...result.outputs])).toHaveLength(500);
});
test("truncated log copies retain their own hash and size with an explicit incomplete flag", async () => {
  const stdout = "retained stdout prefix\n", stderr = "retained stderr prefix\n";
  const logs = metricLogTar("evaluator", stdout, stderr, { stdout: true, stderr: true });
  const result = await collectStageEvidence(metricAttempt(), "evaluator", archiveRunner([logs]).runner);
  expect(result.logs.stdout).toMatchObject({ sha256: sha256(stdout), bytes: Buffer.byteLength(stdout), truncated: true });
  expect(result.logs.stderr).toMatchObject({ sha256: sha256(stderr), bytes: Buffer.byteLength(stderr), truncated: true });
});
test("host capture enforces the byte cap and records truncation without starting Docker", async () => {
  const attempt = metricAttempt(), root = tempDir();
  attempt.paths.snapshot = join(root, "snapshot"); mkdirSync(attempt.paths.snapshot);
  const result = await collectStageEvidence(attempt, "evaluator", logCaptureFixtureRunner());
  expect(result.logs.stdout.bytes).toBe(LOG_COPY_BYTES); expect(result.logs.stdout.sha256).toBe(sha256(Buffer.alloc(LOG_COPY_BYTES, "x")));
  expect(result.logs.stdout.truncated).toBe(true); expect(result.logs.stderr.truncated).toBe(true);
  expect(Object.keys(result.logs.stdout).sort()).toEqual(["bytes", "path", "sha256", "truncated"]);
}, 10_000);
test("artifact limits include prior stage outputs and reject changed receipts", async () => {
  const attempt = metricAttempt(); attempt.outputs = [{ path: "/private/existing", sha256: "a".repeat(64), bytes: ARTIFACT_BYTES }];
  await expect(collectEvaluation(attempt, archiveRunner([metricTar([{ path: "metrics.json", data: '{"score":7}' }])]).runner)).rejects.toThrow("evaluator result archive failed");
  expect(() => outputBudget([{ path: "/same", sha256: "a".repeat(64), bytes: 1 }, { path: "/same", sha256: "b".repeat(64), bytes: 1 }])).toThrow("output changed");
  expect(() => outputBudget(Array.from({ length: 500 }, (_, index) => ({ path: `/${index}/${"a".repeat(1000)}`, sha256: "a".repeat(64), bytes: 1 })))).toThrow("manifest is too large");
});
