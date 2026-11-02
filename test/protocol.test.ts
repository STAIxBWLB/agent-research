import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binder, gateDecide, gateList, init } from "../src/commands.ts";
import { designBinding, LIMIT_BOUNDS, protocolHash, readProtocol, setProtocol, TASK_BYTES, taskTreeHash, validateProtocol } from "../src/exp/protocol.ts";
import { commit, openStudy, readLedger, requireExperiment, requireGate, withLock } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
function fixture() {
  return { v: 1, method: "synthetic scoring", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["/bin/candidate", " spaced argument "] },
    evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["/bin/evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }],
    seeds: [0, 1], limits: { cpus: 1, memoryMb: 128, pidsLimit: 64, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 5, maxWallHours: 1, maxGpuHours: 0 } };
}
function study(mode = "experiment", autonomy = "gates") {
  const dir = tempDir(); init(dir, { question: "Synthetic?", mode, autonomy }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeFileSync(join(dir, "task", "task.md"), "synthetic task");
  writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic evaluator");
  return dir;
}
async function set(dir: string, raw: unknown) { return withLock(dir, () => setProtocol(dir, raw, actor)); }

test("AC2: design requires approval and reopens for protocol, budget and nested task edits", async () => {
  const dir = study();
  expect(() => requireGate(dir, openStudy(dir).study, "design", binder(dir))).toThrow("no protocol");
  const protocol = await set(dir, fixture()), hash = protocolHash(protocol);
  expect(() => requireGate(dir, openStudy(dir).study, "design", binder(dir))).toThrow("pending");
  await gateDecide(dir, "design", "approve", undefined, ctx);
  expect(requireGate(dir, openStudy(dir).study, "design", binder(dir))).toEqual([]);
  const oldBinding = designBinding(dir);
  await set(dir, { ...protocol, budget: { ...protocol.budget, maxAttempts: 6 } });
  expect(protocolHash(readProtocol(dir)!)).toBe(hash);
  expect(designBinding(dir)).not.toBe(oldBinding);
  expect(gateList(dir).find(g => g.gate === "design")?.state).toBe("pending");
  await gateDecide(dir, "design", "approve", undefined, ctx);
  writeFileSync(join(dir, "task", "evaluator", "run"), "changed evaluator");
  expect(gateList(dir).find(g => g.gate === "design")?.state).toBe("pending");
  await gateDecide(dir, "design", "approve", undefined, ctx);
  writeFileSync(join(dir, "design", "protocol.json"), JSON.stringify({ ...protocol, method: "changed method" }));
  expect(gateList(dir).find(g => g.gate === "design")?.state).toBe("pending");
  expect(protocolHash(readProtocol(dir)!)).not.toBe(hash);
});

test("AC2: survey refuses experiment operations and design decisions", async () => {
  const dir = study("survey"), before = readLedger(dir);
  await expect(set(dir, fixture())).rejects.toThrow("mode must be experiment");
  await expect(gateDecide(dir, "design", "approve", undefined, ctx)).rejects.toThrow("mode must be experiment");
  expect(() => requireExperiment(openStudy(dir).study)).toThrow("mode must be experiment");
  expect(() => requireGate(dir, openStudy(dir).study, "design", binder(dir))).toThrow("mode must be experiment");
  expect(readLedger(dir)).toEqual(before);
  expect(existsSync(join(dir, "design"))).toBe(false);
});

test("auto design approval belongs to successful command commit only", async () => {
  const dir = study("experiment", "auto"); await set(dir, fixture());
  const pending = requireGate(dir, openStudy(dir).study, "design", binder(dir));
  expect(pending[0]?.actor.kind).toBe("auto");
  expect(() => commit(dir, [[join(dir, "bad"), "too large", 0]], pending)).toThrow("exceed");
  expect(readLedger(dir).some(e => e.type === "gate.approve")).toBe(false);
});

test("AC3: malformed protocols preserve existing file and ledger", async () => {
  const dir = study(); await set(dir, fixture());
  const bytes = readFileSync(join(dir, "design", "protocol.json")), events = readLedger(dir);
  const p = fixture();
  const invalid: unknown[] = [
    { ...p, candidate: { ...p.candidate, image: "fixture:latest" } },
    ...["API_KEY", "token", "MY_SECRET", "PASSWORD", "CREDENTIAL"].map(key => ({ ...p, candidate: { ...p.candidate, env: { [key]: "synthetic-value" } } })),
    { ...p, network: "host" }, { ...p, metrics: [{ name: "score", unit: "points", direction: "sideways" }] },
    { ...p, candidate: { ...p.candidate, command: "sh -c candidate" } },
    { ...p, evaluator: { ...p.evaluator, command: [] } },
    { ...p, candidate: { ...p.candidate, env: { SAFE: "x".repeat(4097) } } },
    { ...p, budget: { ...p.budget, maxAttempts: 0 } }, { ...p, seeds: [0, 0] }, { ...p, unexpected: true },
  ];
  for (const [key, [min, max]] of Object.entries(LIMIT_BOUNDS)) {
    invalid.push({ ...p, limits: { ...p.limits, [key]: min - 1 } }, { ...p, limits: { ...p.limits, [key]: max + 1 } }, { ...p, limits: { ...p.limits, [key]: NaN } });
  }
  for (const raw of invalid) {
    await expect(set(dir, raw)).rejects.toThrow();
    expect(readFileSync(join(dir, "design", "protocol.json"))).toEqual(bytes);
    expect(readLedger(dir)).toEqual(events);
  }
});

test("protocol hash ignores JSON key order and keeps argv bytes", () => {
  const p = validateProtocol({ ...fixture(), candidate: { ...fixture().candidate, env: { B: "b", A: "a" } } });
  expect(p.candidate.command[1]).toBe(" spaced argument ");
  expect(protocolHash(p)).toBe(protocolHash({ ...p, candidate: { ...p.candidate, env: { A: "a", B: "b" } } }));
});

test("task hash binds sorted relative paths and binary contents", () => {
  const dir = study(), first = taskTreeHash(dir);
  renameSync(join(dir, "task", "task.md"), join(dir, "task", "renamed.md"));
  expect(taskTreeHash(dir)).not.toBe(first);
  renameSync(join(dir, "task", "renamed.md"), join(dir, "task", "task.md"));
  expect(taskTreeHash(dir)).toBe(first);
  writeFileSync(join(dir, "task", "binary"), Buffer.from([0, 255, 1]));
  expect(taskTreeHash(dir)).not.toBe(first);
  unlinkSync(join(dir, "task", "binary"));
  expect(taskTreeHash(dir)).toBe(first);
});

test("AC3: symlink files, directories and task root refuse without writing", async () => {
  const dir = study(), outside = tempDir(), events = readLedger(dir);
  for (const target of [join(dir, "task", "task.md"), outside]) {
    symlinkSync(target, join(dir, "task", "link"));
    await expect(set(dir, fixture())).rejects.toThrow("symlink");
    unlinkSync(join(dir, "task", "link"));
  }
  renameSync(join(dir, "task"), join(dir, "original")); symlinkSync(join(dir, "original"), join(dir, "task"));
  await expect(set(dir, fixture())).rejects.toThrow("symlink");
  expect(readLedger(dir)).toEqual(events);
  expect(existsSync(join(dir, "design"))).toBe(false);
});

test("AC3: more than 500 files or 64 MiB refuses before protocol or ledger writes", async () => {
  const dir = study(), events = readLedger(dir);
  for (let i = 0; i < 499; i++) writeFileSync(join(dir, "task", `file-${i}`), "");
  await expect(set(dir, fixture())).rejects.toThrow("500 files");
  for (let i = 0; i < 499; i++) unlinkSync(join(dir, "task", `file-${i}`));
  const huge = join(dir, "task", "huge"); writeFileSync(huge, ""); truncateSync(huge, TASK_BYTES + 1);
  await expect(set(dir, fixture())).rejects.toThrow("larger than");
  expect(readLedger(dir)).toEqual(events);
  expect(existsSync(join(dir, "design"))).toBe(false);
});

test("task tree bounds are inclusive and bytes are summed across files", async () => {
  const dir = study();
  for (let i = 0; i < 498; i++) writeFileSync(join(dir, "task", `file-${i}`), "");
  expect(taskTreeHash(dir)).toHaveLength(64);
  for (let i = 0; i < 498; i++) unlinkSync(join(dir, "task", `file-${i}`));
  writeFileSync(join(dir, "task", "task.md"), "");
  writeFileSync(join(dir, "task", "evaluator", "run"), "");
  truncateSync(join(dir, "task", "task.md"), TASK_BYTES / 2);
  truncateSync(join(dir, "task", "evaluator", "run"), TASK_BYTES / 2);
  expect(taskTreeHash(dir)).toHaveLength(64);
  writeFileSync(join(dir, "task", "one-more-byte"), "x");
  await expect(set(dir, fixture())).rejects.toThrow("larger than");
  expect(readLedger(dir).map(e => e.type)).toEqual(["study.init"]);
});
