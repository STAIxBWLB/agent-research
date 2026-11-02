import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIVE_IMAGE, parseLiveOptions, prepareSyntheticRepository, studyByteSnapshot, verifyFixtureAttempt } from "../scripts/live-exp.ts";
import { spawnRunner } from "../src/exp/executor.ts";
import { readTextBounded, writeAtomic } from "../src/study.ts";
import { tempDir } from "./helpers.ts";
import { init } from "../src/commands.ts";
import { metricAttempt } from "./metric-fixtures.ts";
import { mkdirSync } from "node:fs";
import { ATTEMPT_BYTES } from "../src/exp/attempts.ts";

test("live executor selection requires an SSH alias and pinned image before any execution", () => {
  expect(parseLiveOptions(["--host", "dgx-h100-2"])).toEqual({ host: "dgx-h100-2", image: DEFAULT_LIVE_IMAGE });
  for (const args of [[], ["--host"], ["--host", "-oProxyCommand=bad"], ["--host", "user@host"], ["--host", "synthetic", "--image", "busybox:latest"], ["--host", "synthetic", "--host", "other"], ["--host", "synthetic", "--unexpected"]]) expect(() => parseLiveOptions(args)).toThrow();
});
test("live fixture repository records distinct full commits independent of the later worktree", async () => {
  const prepared = await prepareSyntheticRepository(tempDir());
  expect(prepared.baseline).toMatch(/^[a-f0-9]{40}$/); expect(prepared.adversarial).toMatch(/^[a-f0-9]{40}$/); expect(prepared.baseline).not.toBe(prepared.adversarial);
  expect(prepared.noisy).toMatch(/^[a-f0-9]{40}$/); expect(new Set([prepared.baseline, prepared.adversarial, prepared.noisy]).size).toBe(3);
  writeAtomic(join(prepared.repo, "candidate.sh"), "dirty synthetic worktree\n", 65_536);
  const show = async (commit: string) => { const result = await spawnRunner({ command: "git", args: ["-C", prepared.repo, "show", `${commit}:candidate.sh`] }); expect(result.exitCode).toBe(0); return result.stdout; };
  expect(await show(prepared.baseline)).not.toContain("eval_read_exit"); expect(await show(prepared.adversarial)).toContain("eval_read_exit");
  expect(await show(prepared.noisy)).toContain("1025");
});
test("CPU fixtures are bounded synthetic POSIX shell and the evaluator is the metrics writer", async () => {
  const root = fileURLToPath(new URL("./fixtures/exp/", import.meta.url));
  for (const file of ["candidate.sh", "adversarial.sh", "noisy.sh", "evaluator/evaluate.sh"]) {
    const path = join(root, file), text = readTextBounded(path, 65_536); expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    const checked = await spawnRunner({ command: "sh", args: ["-n", path] }); expect(checked.exitCode).toBe(0);
  }
  expect(readTextBounded(join(root, "evaluator/evaluate.sh"), 65_536)).toContain("/result/metrics.json");
});
test("live log audit fingerprints raw ledger and record bytes, including whitespace changes", () => {
  const study = tempDir(); init(study, { question: "Synthetic?", mode: "experiment" }, { actor: { kind: "person" } });
  const record = metricAttempt(), path = join(study, "runs", record.run, "attempts", `${record.id}.json`);
  mkdirSync(join(study, "runs", record.run, "attempts"), { recursive: true }); writeAtomic(path, JSON.stringify(record), ATTEMPT_BYTES);
  const before = studyByteSnapshot(study, [record]); expect(studyByteSnapshot(study, [record])).toEqual(before); expect(before.files).toBe(2);
  writeAtomic(path, JSON.stringify(record) + "\n", ATTEMPT_BYTES);
  expect(studyByteSnapshot(study, [record]).sha256).not.toBe(before.sha256);
});
test("live acceptance rejects a successful HEAD result when a different commit-specific score was requested", () => {
  const attempt = metricAttempt(); attempt.status = "succeeded"; attempt.label = "baseline";
  attempt.metrics = [{ name: "score", unit: "points", value: 9, provenance: "ares-observed" }];
  expect(() => verifyFixtureAttempt(attempt, 7)).toThrow("commit-specific fixture score");
  attempt.metrics[0]!.value = 7; expect(verifyFixtureAttempt(attempt, 7).score).toBe(7);
});
