import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS } from "../src/mcp-tools.ts";
import { protocolHash, readProtocol } from "../src/exp/protocol.ts";
import { exportBundle, scanBundle } from "../src/study-export.ts";
import { appendEvent, openStudy } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), WIN = "b".repeat(40), ABL = "c".repeat(40);
const IMAGE = `fixture@sha256:${"a".repeat(64)}`;
let serial = 0;
function attempt(dir: string, runName: string, commit: string, seed: number, value: number, status = "succeeded", label = "synthetic", metric = "score") {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, folder = join(dir, "runs", runName, "attempts"); mkdirSync(folder, { recursive: true });
  const stage = { image: IMAGE, argv: ["docker", "run", "--mount", "src=/Users/someone/work,dst=/work", "--env", "ARES_SEED=1"], mounts: [{ target: "/work/candidate", readOnly: true }], network: "none", limits: protocol.limits, user: "1001", containerId: "f".repeat(64), startedAt: "2030-01-01T00:00:00Z", endedAt: "2030-01-01T00:00:05Z", exitCode: 0, evidence: { logs: { stdout: { path: "/srv/exec/logs/candidate.stdout.log", sha256: "d".repeat(64), bytes: 3, truncated: false } } } };
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({
    v: 1, id, studyId: openStudy(dir).study.id, run: runName, commit, treeId: "e".repeat(40), seed, label, protocolHash: protocolHash(protocol), sealBinding: "9".repeat(64), protocol,
    executor: { kind: "ssh", host: "gpu-box", workdir: "/srv/exec" }, paths: { snapshot: "/srv/exec/snap.tar" }, stages: { candidate: stage, evaluator: { ...stage, exitCode: 0 } }, stage: "evaluator", status,
    startedAt: "2030-01-01T00:00:00Z", endedAt: "2030-01-01T00:00:10Z", metrics: [{ name: metric, value, unit: "points", provenance: "ares-observed" }], outputs: [{ path: "/srv/exec/out.json", sha256: "c".repeat(64), bytes: 9 }],
    sealing: { separateContainers: true, evaluatorReadOnly: true, candidateHasNoEvaluator: true, verifiedBy: "ares-observed" },
  }));
  appendEvent(dir, actor, "attempt.started", { id, run: runName, commit, seed }); return id;
}
async function study() {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image: IMAGE, command: ["candidate"] }, evaluator: { image: IMAGE, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1, 2], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx); await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  attempt(dir, "investigate", BASE, 1, 10); attempt(dir, "investigate", WIN, 1, 12); attempt(dir, "investigate", ABL, 1, 3, "failed");
  await ops.investigateClose(dir, ctx); await ops.ablateAdd(dir, { id: "without", commit: ABL, removes: "confidential" }, ctx);
  attempt(dir, "ablate", WIN, 1, 12); attempt(dir, "ablate", ABL, 1, 11); await ops.ablateClose(dir, ctx);
  await ops.gateDecide(dir, "final", "approve", undefined, ctx);
  attempt(dir, "final", BASE, 2, 10); attempt(dir, "final", WIN, 2, 12); await ops.finalClose(dir, ctx);
  return dir;
}
function numericAndStatus(value: unknown, path = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(value)) value.forEach((v, i) => numericAndStatus(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) numericAndStatus(v, `${path}.${k}`, out);
  else if (typeof value === "number" || /status$/i.test(path)) out[path] = value;
  return out;
}

test("AC1/AC3: bundle counts equal attempt list, rows carry identity, results match closed files", async () => {
  const dir = await study(), out = join(tempDir(), "bundle");
  const manifest = ops.studyExport(dir, { bundle: out }) as Exclude<ReturnType<typeof ops.studyExport>, { wouldWrite: true }>;
  expect(readdirSync(out).sort()).toEqual(["attempts.jsonl", "evidence.json", "ledger.jsonl", "manifest.json", "results.json", "reviews.jsonl"]);
  const listed = ops.attemptList(dir, { limit: 200 });
  expect(manifest.counts.byStatus).toEqual(listed.totals); expect(manifest.counts.attempts).toBe(listed.total);
  expect(manifest.bundle).toBe(1); expect(manifest.protocolHash).toBe(protocolHash(readProtocol(dir)!));
  const rows = readFileSync(join(out, "attempts.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  expect(rows).toHaveLength(listed.total);
  for (const row of rows) {
    expect(row).toMatchObject({ commit: expect.stringMatching(/^[a-f0-9]{40}$/), treeId: "e".repeat(40), protocolHash: manifest.protocolHash, sealBinding: "9".repeat(64), seed: expect.any(Number), status: expect.any(String) });
    expect(row.metrics[0]).toMatchObject({ name: "score", provenance: "ares-observed" });
    expect(row.stages.candidate).toMatchObject({ exitCode: 0, durationMs: 5000, network: "none", imageDigest: `sha256:${"a".repeat(64)}` });
  }
  const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
  const read = (...p: string[]) => JSON.parse(readFileSync(join(dir, ...p), "utf8"));
  expect(numericAndStatus(results.investigate.investigate)).toEqual(numericAndStatus(read("runs", "investigate", "investigate.json")));
  expect(numericAndStatus(results.ablate)).toEqual(numericAndStatus(read("runs", "ablate", "ablate.json")));
  expect(numericAndStatus(results.final)).toEqual(numericAndStatus(read("runs", "final", "final.json")));
  expect(results.final.status).toBe("qualified");
});

test("AC2: no bundle file carries paths, mounts, container ids, argv, env, URLs or keys", async () => {
  const dir = await study(), out = join(tempDir(), "bundle"); ops.studyExport(dir, { bundle: out });
  const all = readdirSync(out).map(f => readFileSync(join(out, f), "utf8")).join("\n");
  for (const needle of ["/Users/", "/srv/", "/work", "gpu-box", "f".repeat(64), "ARES_SEED", "docker", "argv", "mounts", "containerId", "workdir", "http", openStudy(dir).study.id])
    expect(all).not.toContain(needle);
});

test("AC2: a planted path or key-like token refuses the whole export and writes nothing", async () => {
  for (const metric of ["/Users/someone/secret/data", "/work", "sk-AbCdEf0123456789xyzQ", "see https://example.test/x", "mailto:a", "urn:x:y", "A=secret"]) {
    const dir = await study(); attempt(dir, "posthoc", WIN, 1, 1, "succeeded", "synthetic", metric);
    const out = join(tempDir(), "bundle");
    expect(() => ops.studyExport(dir, { bundle: out })).toThrow("study export: refused");
    expect(existsSync(out)).toBe(false);
  }
  expect(() => scanBundle({ "x": "AWS AKIAABCDEFGHIJKLMNOP" })).toThrow("key-like");
  expect(() => scanBundle({ "x": "TOKEN=abc" })).toThrow("env value");
  for (const planted of ["/secret", "file:x", "data:x"]) expect(() => scanBundle({ x: JSON.stringify({ v: planted }) })).toThrow("refused");
  expect(() => scanBundle({ "x": JSON.stringify({ at: "2030-01-01T00:00:00Z", sha: "a".repeat(64), unit: "points/s", ref: `attempt:${"a".repeat(16)}.score` }) })).not.toThrow();
});

test("AC4: CLI and MCP both expose the command; --list writes nothing; non-empty target refuses", async () => {
  const dir = await study(), out = join(tempDir(), "bundle");
  const listed = await run(["study", "export", dir, "--bundle", out, "--list", "--json"], {});
  expect(listed.code).toBe(0); expect(JSON.parse(listed.text).files).toContain("attempts.jsonl"); expect(existsSync(out)).toBe(false);
  const written = await run(["study", "export", dir, "--bundle", out, "--json"], {});
  expect(written.code).toBe(0); expect(JSON.parse(written.text).bundle).toBe(1);
  await expect(run(["study", "export", dir, "--bundle", out], {})).rejects.toThrow("not empty");
  expect(ARES_TOOLS.some(t => t.name === "ares_study_export")).toBe(true);
});

test("review regressions: ledger allowlist, label and prose, closed results, run names, bounds, target", async () => {
  const dir = await study();
  await ops.executorSet(dir, { v: 1, kind: "ssh", host: "dgx02", workdir: "/srv/exec" }, ctx);
  attempt(dir, "constructor", WIN, 1, 1, "succeeded", "/work");
  const out = join(tempDir(), "bundle"), manifest = ops.studyExport(dir, { bundle: out }) as { counts: { byRun: Record<string, Record<string, number>> } };
  const all = readdirSync(out).map(f => readFileSync(join(out, f), "utf8")).join("\n");
  for (const needle of ["dgx02", "/work", "confidential", "\"label\""]) expect(all).not.toContain(needle);
  const ledger = readFileSync(join(out, "ledger.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  expect(ledger.find(e => e.type === "executor.set").data).toEqual({ kind: "ssh" });
  expect((manifest.counts.byRun["constructor"] as unknown)).toEqual({ running: 0, succeeded: 1, failed: 0, cancelled: 0, unknown: 0 });
  const rows = readFileSync(join(out, "attempts.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  expect(rows.every(r => typeof r.labelSha256 === "string" && !("label" in r))).toBe(true);

  const tampered = await study(), file = join(tampered, "runs", "ablate", "ablate.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), v: 99 }, null, 2) + "\n");
  const out2 = join(tempDir(), "bundle");
  expect(() => ops.studyExport(tampered, { bundle: out2 })).toThrow("ablate result is not a verified closed result");
  expect(existsSync(out2)).toBe(false);

  const out3 = join(tempDir(), "bundle");
  expect(() => exportBundle(dir, { bundle: out3 }, 1024)).toThrow("nothing was written");
  expect(existsSync(out3)).toBe(false);
  expect(() => ops.studyExport(dir, { bundle: join(dir, "export") })).toThrow("inside the study directory");
  expect(() => ops.studyExport(dir, { bundle: dir })).toThrow("inside the study directory");
  expect(existsSync(join(dir, "export"))).toBe(false);
});

test("round 2: one-token free text, broader path scan, symlinked target, early attempt bound", async () => {
  const { symlinkSync } = await import("node:fs");
  const base = await study();
  const out = join(tempDir(), "bundle"); ops.studyExport(base, { bundle: out });
  expect(readFileSync(join(out, "results.json"), "utf8")).not.toContain("removes");
  for (const metric of ["//server/share", "/비밀"]) {
    const d = await study(); attempt(d, "posthoc", WIN, 1, 1, "succeeded", "synthetic", metric);
    const o = join(tempDir(), "bundle"); expect(() => ops.studyExport(d, { bundle: o })).toThrow("absolute path"); expect(existsSync(o)).toBe(false);
  }
  const link = join(tempDir(), "link"); symlinkSync(base, link);
  expect(() => ops.studyExport(base, { bundle: join(link, "nested", "bundle") })).toThrow("inside the study directory");
  expect(existsSync(join(base, "nested"))).toBe(false);
  const o2 = join(tempDir(), "bundle");
  expect(() => exportBundle(base, { bundle: o2 }, 600)).toThrow("attempts.jsonl would exceed 600 bytes");
  expect(existsSync(o2)).toBe(false);
});
