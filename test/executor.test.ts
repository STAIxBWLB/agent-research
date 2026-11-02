import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { init } from "../src/commands.ts";
import { buildContainerArgs, checkExecutor, containerName, processEnvironment, readExecutor, runOnExecutor, setExecutor, shellQuote, spawnRunner, startWatchdog, validateExecutor, type ContainerOptions, type Executor, type ProcessResult } from "../src/exp/executor.ts";
import { setProtocol, type Protocol } from "../src/exp/protocol.ts";
import { readLedger, withLock } from "../src/study.ts";
import { fakeDocker, tempDir } from "./helpers.ts";
import { mkdirSync, writeFileSync } from "node:fs";

const actor = { kind: "person" as const }, local: Executor = { v: 1, kind: "local", workdir: "/executor" }, remote: Executor = { ...local, kind: "ssh", host: "fixture-host" };
const image = `fixture@sha256:${"a".repeat(64)}`;
function protocol(): Protocol {
  return { v: 1, method: "synthetic", candidate: { image, command: ["/bin/candidate", "argument with spaces"], env: { MODE: "synthetic" } }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["/bin/evaluator"] },
    metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 2, memoryMb: 128, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 3, maxWallHours: 1, maxGpuHours: 0 } };
}
function options(stage: "candidate" | "evaluator"): ContainerOptions {
  return { protocol: protocol(), stage, studyId: "synthetic-study", attemptId: "0123456789abcdef", user: "1001:1002", paths: { snapshot: "/executor/snapshot", output: "/executor/output", evaluator: "/executor/task/evaluator", result: "/executor/result" } };
}
const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
async function study(executor: Executor = local) {
  const dir = tempDir(); init(dir, { question: "Synthetic?", mode: "experiment" }, { actor });
  mkdirSync(join(dir, "task")); writeFileSync(join(dir, "task", "task.md"), "synthetic");
  await withLock(dir, () => { setProtocol(dir, protocol(), actor); setExecutor(dir, executor, actor); });
  return dir;
}

test("AC4: candidate and evaluator get separate named containers and fixed isolated mounts", () => {
  const candidate = buildContainerArgs(options("candidate")), evaluator = buildContainerArgs(options("evaluator"));
  for (const args of [candidate, evaluator]) {
    for (const [flag, value] of [["--network", "none"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"], ["--user", "1001:1002"], ["--cpus", "2"], ["--memory", "128m"], ["--pids-limit", "32"], ["--tmpfs", "/tmp"], ["--pull", "missing"]]) expect(args[args.indexOf(flag!) + 1]).toBe(value);
    expect(args).toContain("--read-only"); expect(args).toContain("--detach");
  }
  const mounts = (args: string[]) => args.flatMap((value, i) => value === "--mount" ? [args[i + 1]] : []);
  expect(mounts(candidate)).toEqual(["type=bind,src=/executor/snapshot,dst=/workspace,readonly", "type=bind,src=/executor/output,dst=/out"]);
  expect(candidate.join(" ")).not.toContain("/task/"); expect(candidate.join(" ")).not.toContain("/eval"); expect(candidate.join(" ")).not.toContain("/result");
  expect(mounts(evaluator)).toEqual(["type=bind,src=/executor/task/evaluator,dst=/eval,readonly", "type=bind,src=/executor/output,dst=/candidate,readonly", "type=bind,src=/executor/result,dst=/result"]);
  expect(candidate[candidate.indexOf("--name") + 1]).not.toBe(evaluator[evaluator.indexOf("--name") + 1]);
  expect(candidate.slice(-3)).toEqual([image, "/bin/candidate", "argument with spaces"]);
  expect(candidate).toContain("MODE=synthetic"); expect(evaluator).not.toContain("MODE=synthetic");
  expect(candidate).not.toContain("--gpus");
  const gpu = options("candidate"); gpu.protocol.limits.gpus = 2;
  const args = buildContainerArgs(gpu); expect(args[args.indexOf("--gpus") + 1]).toBe("2");
});

test("AC4: builders reject root users, overlapping or injected mounts and invalid identities", () => {
  for (const user of ["0:0", "0:1000", "1000:0", "root", "1000"]) expect(() => buildContainerArgs({ ...options("candidate"), user })).toThrow("non-root");
  for (const snapshot of ["/executor", "/", "/executor/task/evaluator", "/executor/output/child", "/tmp/a,dst=/eval", '/tmp/a"b', "relative"]) expect(() => buildContainerArgs({ ...options("candidate"), paths: { ...options("candidate").paths, snapshot } })).toThrow();
  expect(() => containerName("--bad", "candidate")).toThrow("invalid attempt");
  expect(() => buildContainerArgs({ ...options("candidate"), studyId: "bad\nlabel" })).toThrow("invalid label");
});

test("selected declared seed reaches both containers once and defaults to the first protocol seed", () => {
  const p = { ...protocol(), seeds: [11, 29] };
  for (const stage of ["candidate", "evaluator"] as const) {
    for (const seed of p.seeds) {
      const args = buildContainerArgs({ ...options(stage), protocol: p, seed });
      const env = args.flatMap((value, i) => value === "--env" ? [args[i + 1]!] : []);
      expect(env.filter(value => value.startsWith("ARES_SEED="))).toEqual([`ARES_SEED=${seed}`]);
      expect(args.indexOf(`ARES_SEED=${seed}`)).toBeLessThan(args.indexOf(p[stage].image));
    }
    expect(buildContainerArgs({ ...options(stage), protocol: p })).toContain("ARES_SEED=11");
    for (const seed of [0, 12.5, NaN, Infinity]) expect(() => buildContainerArgs({ ...options(stage), protocol: p, seed })).toThrow("container seed: undeclared or non-integer; choose a seed from protocol.seeds");
  }
});

test("AC8: local and SSH transport preserve argv and stdin without connection overrides", async () => {
  const fake = fakeDocker([ok(), ok()]), stdin = new Uint8Array([1, 2, 3]);
  const args = ["run", "argument with spaces", "quote'and;$(false)", ""];
  await runOnExecutor(local, "docker", args, fake.runner, { stdin });
  await runOnExecutor(remote, "docker", args, fake.runner, { stdin });
  expect(fake.requests[0]).toEqual({ command: "docker", args, stdin });
  expect(fake.requests[1]).toEqual({ command: "ssh", args: ["-o", "BatchMode=yes", "fixture-host", "docker", "run", "'argument with spaces'", "'quote'\\''and;$(false)'", "''"], stdin });
  expect(shellQuote("safe@sha256:abc")).toBe("safe@sha256:abc");
  for (const host of ["-oProxyCommand=bad", "user@host", "host;bad", "host\nextra", "/config", ""]) expect(() => validateExecutor({ ...remote, host })).toThrow("SSH alias");
});

test("executor config validates before persistence and refuses survey studies", async () => {
  const dir = await study(), before = readFileSync(join(dir, "executor.json")), events = readLedger(dir);
  for (const raw of [{ ...local, host: "host" }, { ...local, workdir: "relative" }, { ...remote, host: "--bad" }, { ...local, privateKey: "synthetic" }]) {
    await expect(withLock(dir, () => setExecutor(dir, raw, actor))).rejects.toThrow();
    expect(readFileSync(join(dir, "executor.json"))).toEqual(before); expect(readLedger(dir)).toEqual(events);
  }
  expect(readExecutor(dir)).toEqual(local);
  for (const raw of [{ v: 1, kind: "local" }, { v: 1, kind: "ssh", host: "fixture-host" }, { ...local, workdir: null }]) {
    expect(() => validateExecutor(raw)).toThrow("executor.workdir: required with no default; run ares executor set");
    await expect(withLock(dir, () => setExecutor(dir, raw, actor))).rejects.toThrow("--workdir PATH using a private directory");
    expect(readFileSync(join(dir, "executor.json"))).toEqual(before); expect(readLedger(dir)).toEqual(events);
  }
  for (const workdir of ['/private/a"b', '/private/a",dst=/eval']) {
    await expect(withLock(dir, () => setExecutor(dir, { ...local, workdir }, actor))).rejects.toThrow("double quotes");
    expect(readFileSync(join(dir, "executor.json"))).toEqual(before); expect(readLedger(dir)).toEqual(events);
  }
  const survey = tempDir(); init(survey, { question: "Survey?" }, { actor });
  await expect(withLock(survey, () => setExecutor(survey, local, actor))).rejects.toThrow("--mode experiment");
  await expect(checkExecutor(survey, fakeDocker([]).runner)).rejects.toThrow("--mode experiment");
});

test("executor check reports server and non-root user, pulling missing images only", async () => {
  const dir = await study(remote), before = readFileSync(join(dir, "ledger.jsonl"));
  const fake = fakeDocker([ok("29.1.3\n"), ok("1001\n"), ok("1002\n"), ok("{}"), { exitCode: 1, stdout: "", stderr: "missing" }, ok()]);
  const checked = await checkExecutor(dir, fake.runner);
  expect(checked).toEqual({ executor: remote, serverVersion: "29.1.3", user: "1001:1002", images: [{ image, available: true }, { image: protocol().evaluator.image, available: true }], pull: "missing" });
  expect(fake.requests.every(r => r.command === "ssh" && r.args.slice(0, 3).join(" ") === "-o BatchMode=yes fixture-host")).toBe(true);
  expect(fake.requests.filter(r => r.args.includes("pull"))).toHaveLength(1);
  const inspections = fake.requests.filter(r => r.args.includes("inspect"));
  expect(inspections.map(r => r.args.slice(3))).toEqual([
    ["docker", "image", "inspect", "--format", "'{{.Id}}'", image],
    ["docker", "image", "inspect", "--format", "'{{.Id}}'", protocol().evaluator.image],
  ]);
  expect(fake.remaining()).toBe(0); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});

test("AC8: executor failures expose host and step, never remote diagnostics or secret values", async () => {
  const dir = await study(remote), secret = "synthetic-private-value";
  const cases = [
    [new Error(`spawn ${secret}`)],
    [{ exitCode: 1, stdout: `https://private/${secret}`, stderr: secret }],
    [ok("29.1.3"), ok("0"), ok("1002")],
    [ok("29.1.3"), ok("1001"), ok("1002"), { exitCode: 1, stdout: "", stderr: secret }, { exitCode: 1, stdout: "", stderr: secret }],
    [{ ...ok("29.1.3"), timedOut: true }], [{ ...ok("29.1.3"), truncated: true }],
  ];
  for (const script of cases) {
    try { await checkExecutor(dir, fakeDocker(script).runner); throw new Error("unexpected success"); }
    catch (error) { const message = (error as Error).message; expect(message).toContain("executor fixture-host:"); expect(message).toContain("failed; check that step"); expect(message).not.toContain(secret); expect(message).not.toContain("https://"); }
  }
});

test("watchdog starts detached on the executor host with validated name and wall limit", async () => {
  const fake = fakeDocker([ok(), new Error("synthetic-sensitive-output")]);
  await startWatchdog(remote, "0123456789abcdef", "candidate", 60, fake.runner);
  const request = fake.requests[0]!;
  expect(request.command).toBe("ssh"); expect(request.args.slice(0, 4)).toEqual(["-o", "BatchMode=yes", "fixture-host", "sh"]);
  expect(request.args.join(" ")).toContain("sleep 60; docker kill ares-0123456789abcdef-candidate");
  expect(request.args.join(" ")).toContain("nohup"); expect(request.args.join(" ")).toContain("/dev/null");
  await expect(startWatchdog(local, "0123456789abcdef", "evaluator", 60, fake.runner)).rejects.toThrow("executor local: watchdog start failed");
  await expect(startWatchdog(local, "0123456789abcdef", "candidate", 0, fake.runner)).rejects.toThrow("validated protocol limit");
});

test("process environment uses an allowlist and spawn runner bounds output and deadlines", async () => {
  expect(processEnvironment({ PATH: "/bin", HOME: "/synthetic", SSH_AUTH_SOCK: "/agent", OPENAI_API_KEY: "synthetic-secret", PRIVATE_TOKEN: "synthetic-secret" })).toEqual({ PATH: "/bin", HOME: "/synthetic", SSH_AUTH_SOCK: "/agent" });
  const key = "ARES_TEST_SECRET_TOKEN", old = process.env[key]; process.env[key] = "synthetic-secret";
  try {
    const output = await spawnRunner({ command: process.execPath, args: ["-e", `process.stdout.write(String(process.env.${key})); process.stderr.write('x'.repeat(1000))`], maxOutputBytes: 32 });
    expect(output.exitCode).toBe(0); expect(output.stdout).toBe("undefined"); expect(output.stderr).toBe("x".repeat(32)); expect(output.truncated).toBe(true);
  } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
  const timeout = await spawnRunner({ command: process.execPath, args: ["-e", "setTimeout(()=>{}, 10000)"], timeoutMs: 50 });
  expect(timeout.timedOut).toBe(true); expect(timeout.exitCode).not.toBe(0);
});

test("AC8: parent secret-looking variables and raw executor output never reach study files", async () => {
  const key = "ARES_TEST_PRIVATE_TOKEN", old = process.env[key], secret = "synthetic-inherited-secret"; process.env[key] = secret;
  try {
    const dir = await study(), fake = fakeDocker([ok("29.1.3"), ok("1001"), ok("1002"), ok(secret), ok(secret)]);
    await checkExecutor(dir, fake.runner);
    function inspect(root: string): void { for (const name of readdirSync(root)) { const file = join(root, name); if (statSync(file).isDirectory()) inspect(file); else expect(readFileSync(file, "utf8")).not.toContain(secret); } }
    inspect(dir);
  } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
});
