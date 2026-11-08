import { expect, test } from "bun:test";
import { validateExecutor, validateExecutorGpu, validateGpuDevices, probeGpuAdmission, GpuAdmissionDeferred, buildContainerArgs, runOnExecutor, shellQuote, GPU_ADMISSION_SCRIPT, GPU_PROBE_TIMEOUT_MS, GPU_PROBE_OUTPUT_BYTES, GPU_INVENTORY_LIMIT, type Executor, type ProcessResult } from "../src/exp/executor.ts";
import { metricProtocol } from "./metric-fixtures.ts";
import { fakeRunner } from "./helpers.ts";

const A = "GPU-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", B = "GPU-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", C = "GPU-cccccccc-cccc-cccc-cccc-cccccccccccc";
const local: Executor = { v: 1, kind: "local", workdir: "/synthetic/work" };
const settings = () => ({ devices: [0, "1", C], minFreeMemoryMb: 1000, maxLoadRatio: 0.5 });
const configured = (): Executor => ({ ...local, gpu: settings() });
function telemetry(rows = [`0, ${A}, 2000`, `1, ${B}, 1000`, `2, ${C}, 5000`], load = "2.00 1.00 0.50 1/20 123", cpus = "4") {
  return ["ARES_GPU_INVENTORY", ...rows, "ARES_GPU_LOAD", load, "ARES_GPU_CPUS", cpus, "ARES_GPU_END", ""].join("\n");
}
const ok = (stdout = telemetry(), extra: Partial<ProcessResult> = {}): ProcessResult => ({ exitCode: 0, stdout, stderr: "", ...extra });

test("GPU settings require every threshold explicitly and preserve legacy absence", () => {
  expect(validateExecutor(local)).toEqual(local); expect(validateExecutor(local)).not.toHaveProperty("gpu");
  expect(validateExecutor({ ...local, gpu: { devices: [0, "1", A.toUpperCase()], minFreeMemoryMb: 0, maxLoadRatio: 1_000_000 } }).gpu).toEqual({ devices: ["0", "1", A], minFreeMemoryMb: 0, maxLoadRatio: 1_000_000 });
  expect(validateExecutorGpu({ ...settings(), minFreeMemoryMb: 2_147_483_647 })).toHaveProperty("minFreeMemoryMb", 2_147_483_647);
  const invalid: unknown[] = [null, [], {}, { devices: [0] }, { devices: [0], minFreeMemoryMb: 0 }, { devices: [0], maxLoadRatio: 1 }, { ...settings(), extra: true }, JSON.parse('{"devices":[0],"minFreeMemoryMb":0,"maxLoadRatio":1,"__proto__":{}}'),
    ...[[], Array(65).fill(0), [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], ["01"], ["-1"], [" 1"], ["gpu-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], ["GPU-invalid"], [0, "0"], [A, A.toUpperCase()], [null]].map(devices => ({ ...settings(), devices })),
    ...[-1, 1.5, 2_147_483_648, "1", null].map(minFreeMemoryMb => ({ ...settings(), minFreeMemoryMb })),
    ...[0, -1, Infinity, NaN, 1_000_001, "1", null].map(maxLoadRatio => ({ ...settings(), maxLoadRatio }))];
  for (const gpu of invalid) expect(() => validateExecutor({ ...local, gpu })).toThrow("executor.gpu.");
});

test("legacy and zero-GPU admission never probe and invalid requested counts refuse", async () => {
  const fake = fakeRunner([]);
  expect(await probeGpuAdmission(local, 3, fake.runner)).toEqual({ status: "admitted", devices: [] });
  expect(await probeGpuAdmission(configured(), 0, fake.runner)).toEqual({ status: "admitted", devices: [] });
  for (const count of [-1, 1.5, 65, NaN]) await expect(probeGpuAdmission(configured(), count, fake.runner)).rejects.toThrow("GPU admission count");
  expect(fake.requests).toHaveLength(0);
});

for (const kind of ["local", "ssh"] as const) test(`${kind} one-shot probe selects allowed UUIDs at memory/load boundary with bounded transport`, async () => {
  const executor: Executor = { ...configured(), kind, ...(kind === "ssh" ? { host: "synthetic-host" } : {}) }, fake = fakeRunner([ok()]);
  expect(await probeGpuAdmission(executor, 2, fake.runner)).toEqual({ status: "admitted", devices: [A, B] });
  expect(fake.requests).toHaveLength(1); const request = fake.requests[0]!;
  expect(request.timeoutMs).toBe(GPU_PROBE_TIMEOUT_MS); expect(request.maxOutputBytes).toBe(GPU_PROBE_OUTPUT_BYTES);
  if (kind === "local") expect(request).toMatchObject({ command: "sh", args: ["-c", GPU_ADMISSION_SCRIPT] });
  else expect(request).toMatchObject({ command: "ssh", args: ["-o", "BatchMode=yes", "synthetic-host", "sh", "-c", shellQuote(GPU_ADMISSION_SCRIPT)] });
  expect(GPU_ADMISSION_SCRIPT).toContain("nvidia-smi --query-gpu=index,uuid,memory.free --format=csv,noheader,nounits");
  expect(GPU_ADMISSION_SCRIPT).toContain("/proc/loadavg"); expect(GPU_ADMISSION_SCRIPT).toContain("getconf _NPROCESSORS_ONLN"); expect(GPU_ADMISSION_SCRIPT).not.toContain("python");
});

test("selection honors configured order, memory filtering and physical UUID alias deduplication", async () => {
  const executor: Executor = { ...configured(), gpu: { ...settings(), devices: ["2", "0", A, "1"] } };
  const ordered = fakeRunner([ok()]); expect(await probeGpuAdmission(executor, 3, ordered.runner)).toEqual({ status: "admitted", devices: [C, A, B] });
  const filtered = fakeRunner([ok(telemetry([`0, ${A}, 999`, `1, ${B}, 1000`, `2, ${C}, 5000`]))]);
  expect(await probeGpuAdmission(executor, 2, filtered.runner)).toEqual({ status: "admitted", devices: [C, B] });
  const alias = fakeRunner([ok()]); const result = await probeGpuAdmission({ ...executor, gpu: { ...settings(), devices: [0, A] } }, 2, alias.runner);
  expect(result).toMatchObject({ status: "deferred", reason: "devices", exitCode: 75 });
  const none = fakeRunner([ok(telemetry([]))]); expect(await probeGpuAdmission(executor, 1, none.runner)).toMatchObject({ status: "deferred", reason: "devices", exitCode: 75 });
  const absent = fakeRunner([ok()]); expect(await probeGpuAdmission({ ...executor, gpu: { ...settings(), devices: [9] } }, 1, absent.runner)).toMatchObject({ status: "deferred", reason: "devices" });
});

test("load pressure defers once without retrying and typed deferral retains its public result", async () => {
  const fake = fakeRunner([ok(telemetry(undefined, "2.01 1.0 0.5 1/20 123"))]);
  const result = await probeGpuAdmission(configured(), 1, fake.runner); expect(result).toMatchObject({ status: "deferred", reason: "load", exitCode: 75 });
  if (result.status !== "deferred") throw new Error("expected typed deferral");
  const error = new GpuAdmissionDeferred(result); expect(error.result).toBe(result); expect(error.message).toBe(result.message); expect(fake.requests).toHaveLength(1);
});

test("malformed inventory/load/CPU and failed probes defer closed without private output", async () => {
  const secret = "/synthetic/private-path synthetic-host confidential diagnostic";
  const uuid = (i: number) => `GPU-${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const malformed = ["", secret, telemetry(["not CSV"]), telemetry([`0, ${A}, N/A`]), telemetry([`0, ${A}, Infinity`]), telemetry([`0, ${A}, -1`]), telemetry([`0, ${A}, 1000, extra`]), telemetry([`00, ${A}, 1000`]), telemetry([`0, invalid, 1000`]), telemetry([`0, ${A}, 1000`, `0, ${B}, 1000`]), telemetry([`0, ${A}, 1000`, `1, ${A.toUpperCase()}, 1000`]), telemetry(Array.from({ length: GPU_INVENTORY_LIMIT + 1 }, (_, i) => `${i}, ${uuid(i)}, 1000`)),
    ...["NaN 0 0 1/10 1", "Infinity 0 0 1/10 1", "0 -1 0 1/10 1", "0 0 0", "0 0 0 11/10 1", "0 0 0 1/0 1"].map(load => telemetry(undefined, load)),
    ...["", "0", "N/A", "1.5", "Infinity"].map(cpus => telemetry(undefined, undefined, cpus))];
  const results: (ProcessResult | Error)[] = [new Error(secret), ok(undefined, { exitCode: 1, stderr: secret }), ok(undefined, { timedOut: true, stderr: secret }), ok(undefined, { truncated: true }), ok("x".repeat(GPU_PROBE_OUTPUT_BYTES + 1)), ...malformed.map(stdout => ok(stdout, { stderr: secret }))];
  for (const outcome of results) {
    const fake = fakeRunner([outcome]), result = await probeGpuAdmission(configured(), 1, fake.runner);
    expect(result).toMatchObject({ status: "deferred", reason: "probe", exitCode: 75 });
    if (result.status !== "deferred") throw new Error("expected probe deferral");
    expect(result.message).not.toContain("synthetic-host"); expect(result.message).not.toContain("/synthetic/private-path"); expect(result.message).not.toContain("confidential"); expect(fake.requests).toHaveLength(1);
  }
});

test("explicit UUID Docker CSV arguments preserve literal multi-device quotes locally and over SSH", async () => {
  const protocol = metricProtocol(); protocol.limits.gpus = 2;
  const options = { protocol, studyId: "synthetic", attemptId: "a".repeat(16), user: "1000:1000", paths: { snapshot: "/synthetic/snapshot", output: "/synthetic/output", evaluator: "/synthetic/evaluator", result: "/synthetic/result" } };
  const legacy = buildContainerArgs({ ...options, stage: "candidate" }); expect(legacy[legacy.indexOf("--gpus") + 1]).toBe("2");
  for (const stage of ["candidate", "evaluator"] as const) {
    const args = buildContainerArgs({ ...options, stage, gpuDevices: [A.toUpperCase(), B] });
    expect(args[args.indexOf("--gpus") + 1]).toBe(`"device=${A},${B}"`);
    const fake = fakeRunner([ok("")]); await runOnExecutor({ ...local, kind: "ssh", host: "synthetic-host" }, "docker", args, fake.runner);
    expect(fake.requests[0]!.args).toContain(shellQuote(`"device=${A},${B}"`));
  }
  for (const devices of [[], [A], [A, A.toUpperCase()], ["0", "1"], [A, "bad"]]) expect(() => buildContainerArgs({ ...options, stage: "candidate", gpuDevices: devices })).toThrow("GPU devices:");
  expect(validateGpuDevices([A.toUpperCase(), B], 2)).toEqual([A, B]);
  protocol.limits.gpus = 0;
  expect(buildContainerArgs({ ...options, stage: "candidate", gpuDevices: [] })).not.toContain("--gpus");
  expect(buildContainerArgs({ ...options, stage: "candidate" })).not.toContain("--gpus");
});
