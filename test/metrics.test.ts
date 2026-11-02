import { expect, test } from "bun:test";
import { collectEvaluation, collectStageEvidence, LOG_COPY_BYTES, LOG_TAIL_BYTES, METRICS_BYTES, MetricsError, outputBudget, parseMetrics, sanitizeLogTail, validateMetrics } from "../src/exp/metrics.ts";
import { ARTIFACT_BYTES } from "../src/exp/artifacts.ts";
import { sha256 } from "../src/study.ts";
import type { ProcessRequest, ProcessRunner } from "../src/exp/executor.ts";
import { metricAttempt, metricProtocol, metricTar } from "./metric-fixtures.ts";

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
  const logs = metricTar([{ path: "logs/candidate.stdout.log", data: 'candidate score=999\n{"score":999}\n' }, { path: "logs/candidate.stderr.log", data: "synthetic error detail\n" }]);
  const fake = archiveRunner([logs, metricTar([{ path: "metrics.json", data: '{"score":999}' }])]), attempt = metricAttempt();
  const stage = await collectStageEvidence(attempt, "candidate", fake.runner);
  expect(stage.logs.stdout.tail).toContain("candidate score=999"); expect(stage.logs.stdout.tail).toContain('{"score":999}');
  expect(stage.outputs.some(file => file.path === `${attempt.paths.output}/metrics.json`)).toBe(true);
  expect(attempt.metrics).toEqual([]); expect(fake.requests[1]?.args).toEqual(["cp", `${attempt.stages.candidate!.containerId}:/out/.`, "-"]);
  expect(fake.requests[0]?.args.join(" ")).toContain("ulimit -f 16384");
});
test("log tails apply the declared credential masks and preserve ordinary context and JSON", () => {
  const key = "synthetic-parent-value", text = `ordinary stage progress\n${key}\nGET https://user:pass@example.test/private?API_TOKEN=query-value&step=1\nAPI_KEY=assignment-value next\nTOKEN="quoted value" next\n{\n  "body": "synthetic-response-body", "PASSWORD":"json-value"\n}\n`;
  const sanitized = sanitizeLogTail(Buffer.from(text), { API_TOKEN: key });
  expect(sanitized.redacted).toBe(true); expect(sanitized.tail).toContain("ordinary stage progress");
  expect(sanitized.tail).toContain("https://***@example.test/private?API_TOKEN=***&step=1");
  expect(sanitized.tail).toContain('TOKEN="***" next'); expect(sanitized.tail).toContain('"PASSWORD":"***"');
  expect(sanitized.tail).toContain("synthetic-response-body");
  expect(sanitizeLogTail(Buffer.from("ordinary stage progress"), {}).tail).toBe("ordinary stage progress");
  for (const value of [key, "user:pass", "query-value", "assignment-value", "quoted value", "json-value"]) expect(sanitized.tail).not.toContain(value);
  expect(Buffer.byteLength(sanitizeLogTail(Buffer.from("x".repeat(LOG_TAIL_BYTES * 2))).tail)).toBeLessThanOrEqual(LOG_TAIL_BYTES);
  expect(Buffer.byteLength(sanitizeLogTail(Buffer.from("x".repeat(1024 * 1024)), {}).tail)).toBeLessThanOrEqual(LOG_TAIL_BYTES);
  expect(Buffer.byteLength(sanitizeLogTail(Buffer.from("x-".repeat(512 * 1024)), {}).tail)).toBeLessThanOrEqual(LOG_TAIL_BYTES);
  expect(() => sanitizeLogTail(Buffer.alloc(LOG_COPY_BYTES + 1))).toThrow("log exceeds 16 MiB");
});
test("controls normalize before masking, tabs/newlines remain and body markers never erase evidence", () => {
  expect(sanitizeLogTail(Buffer.from("abc\0def"), { API_KEY: "abcdef" })).toEqual({ tail: "***", redacted: true });
  expect(sanitizeLogTail(Buffer.from("https:\0//user:pass@example.test/private"), {}).tail).toBe("https://***@example.test/private");
  expect(sanitizeLogTail(Buffer.from("x"), { API_KEY: "x" }).tail).toBe("***");
  expect(sanitizeLogTail(Buffer.from("first\nsecond"), { API_KEY: "first\nsecond" }).tail).toBe("***");
  expect(sanitizeLogTail(Buffer.from("step\t1\nnext"), {}).tail).toBe("step\t1\nnext");
  for (const body of ['[\n  "synthetic-private-body"\n]', '<body>\nsynthetic-private-body\n</body>', '{\n  "value":\n  "synthetic-private-body"\n}']) expect(sanitizeLogTail(Buffer.from(body), {}).tail).toBe(body);
  expect(sanitizeLogTail(Buffer.from('CREDENTIAL={"id":"nested-value","items":[1,2]} next'), {}).tail).toBe("CREDENTIAL=*** next");
});
test("credential assignment prefixes outside the retained tail still mask the whole value", async () => {
  const body = `API_KEY=${"z".repeat(LOG_TAIL_BYTES + 1000)}\nnormal final context\n`;
  const logs = metricTar([{ path: "logs/evaluator.stdout.log", data: body }, { path: "logs/evaluator.stderr.log", data: "" }]);
  const result = await collectStageEvidence(metricAttempt(), "evaluator", archiveRunner([logs]).runner);
  expect(result.logs.stdout.bytes).toBeGreaterThan(LOG_TAIL_BYTES); expect(result.logs.stdout.tail).toBe("API_KEY=***\nnormal final context\n"); expect(result.logs.stdout.redacted).toBe(true);
});
test("logs have independent evidence and do not consume the 500-file candidate/result inventory", async () => {
  const attempt = metricAttempt(); attempt.outputs = Array.from({ length: 498 }, (_, index) => ({ path: `/private/prior-${index}`, sha256: "a".repeat(64), bytes: 1 }));
  const logs = metricTar([{ path: "logs/candidate.stdout.log", data: "progress\n" }, { path: "logs/candidate.stderr.log", data: "" }]);
  const stage = await collectStageEvidence(attempt, "candidate", archiveRunner([logs, metricTar([{ path: "one-output", data: "one" }])]).runner);
  expect(stage.outputs).toHaveLength(1); attempt.outputs.push(...stage.outputs);
  const result = await collectEvaluation(attempt, archiveRunner([metricTar([{ path: "metrics.json", data: '{"score":7}' }])]).runner);
  expect(outputBudget([...attempt.outputs, ...result.outputs])).toHaveLength(500);
});
test("artifact limits include prior stage outputs and reject changed receipts", async () => {
  const attempt = metricAttempt(); attempt.outputs = [{ path: "/private/existing", sha256: "a".repeat(64), bytes: ARTIFACT_BYTES }];
  await expect(collectEvaluation(attempt, archiveRunner([metricTar([{ path: "metrics.json", data: '{"score":7}' }])]).runner)).rejects.toThrow("evaluator result archive failed");
  expect(() => outputBudget([{ path: "/same", sha256: "a".repeat(64), bytes: 1 }, { path: "/same", sha256: "b".repeat(64), bytes: 1 }])).toThrow("output changed");
  expect(() => outputBudget(Array.from({ length: 500 }, (_, index) => ({ path: `/${index}/${"a".repeat(1000)}`, sha256: "a".repeat(64), bytes: 1 })))).toThrow("manifest is too large");
});
