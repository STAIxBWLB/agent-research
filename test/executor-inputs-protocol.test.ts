import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { setProtocol, validateProtocol, validateProtocolInputs, validateStoredProtocol, frozenProtocol, protocolHash, sameProtocolInputs, designBinding, readDesign, taskTreeHash, PROTOCOL_BYTES } from "../src/exp/protocol.ts";
import { readBytesBounded, readTextBounded, readLedger, sha256, writeAtomic, withLock } from "../src/study.ts";
import { canonical } from "../src/plan/state.ts";
import { selectionHash, readSelection } from "../src/exp/selection.ts";
import { finalSeedsHash } from "../src/exp/final.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const input = () => ({ path: "/synthetic/weights", sha256: "a".repeat(64), mount: { candidate: "/in/base", evaluator: "/in/base" } });
const protocol = () => ({ v: 1, method: "synthetic inputs", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluate"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 1, memoryMb: 128, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 5, maxWallHours: 1, maxGpuHours: 0 } });

test("strict executor input validation accepts stage-separated targets and preserves legacy absence", () => {
  expect(validateProtocol(protocol())).not.toHaveProperty("inputs");
  expect(validateProtocolInputs({})).toEqual({});
  expect(validateProtocol({ ...protocol(), inputs: { base: input() } }).inputs).toEqual({ base: input() });
  expect(validateProtocolInputs({ train: { ...input(), mount: { candidate: "/in/data" } }, heldout: { ...input(), mount: { evaluator: "/in/data" } } })).toHaveProperty("heldout");
});

test("malformed input descriptors refuse before changing protocol or ledger", async () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic input validation", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeAtomic(join(dir, "task", "task.md"), "synthetic", 65_536);
  writeAtomic(join(dir, "task", "evaluator", "evaluate"), "synthetic", 65_536);
  await withLock(dir, () => setProtocol(dir, protocol(), ctx.actor));
  const files = ["ledger.jsonl", "design/protocol.json"], before = files.map(file => readBytesBounded(join(dir, file), 1024 * 1024));
  const invalid = [null, [], { Bad: input() }, { ["x".repeat(33)]: input() }, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x${i}`, input()])),
    ...["relative", 5, null].map(path => ({ base: { ...input(), path } })),
    ...["A".repeat(64), "a".repeat(63), null].map(sha256 => ({ base: { ...input(), sha256 } })),
    { base: { ...input(), extra: true } }, { base: { ...input(), mount: {} } }, { base: { ...input(), mount: { other: "/in/base" } } },
    ...["/out", "/in", "/in/../private", "/in//base", "/in/base/", "/in/./base"].map(target => ({ base: { ...input(), mount: { candidate: target } } })),
    { a: input(), b: { ...input(), mount: { candidate: "/in/base/child" } } }];
  for (const inputs of invalid) {
    await expect(withLock(dir, () => setProtocol(dir, { ...protocol(), inputs }, ctx.actor))).rejects.toThrow("protocol.inputs");
    files.forEach((file, i) => expect(readBytesBounded(join(dir, file), 1024 * 1024)).toEqual(before[i]!));
  }
});

test("executor inputs verify hashes before effects and mount only the declared stage read-only", async () => {
  const { buildContainerArgs, verifyExecutorInputs } = await import("../src/exp/executor.ts");
  const { fakeRunner } = await import("./helpers.ts");
  const executor = { v: 1 as const, kind: "local" as const, workdir: "/synthetic/work" };
  const p = validateProtocol({ ...protocol(), inputs: { train: { ...input(), mount: { candidate: "/in/train" } }, heldout: { ...input(), path: "/synthetic/heldout", mount: { evaluator: "/in/heldout" } } } });
  const fake = fakeRunner(Array.from({ length: 2 }, () => ({ exitCode: 0, stdout: JSON.stringify({ sha256: input().sha256, files: 2, bytes: 10 }), stderr: "" })));
  expect(await verifyExecutorInputs(executor, p, fake.runner)).toEqual({ train: input().sha256, heldout: input().sha256 });
  expect(fake.requests.every(request => request.command === "python3")).toBe(true);
  const paths = { snapshot: "/synthetic/work/snapshot", output: "/synthetic/work/output", evaluator: "/synthetic/work/evaluator", result: "/synthetic/work/result" };
  const options = { protocol: p, studyId: "synthetic", attemptId: "a".repeat(16), user: "1000:1000", paths };
  const candidate = buildContainerArgs({ ...options, stage: "candidate" });
  const evaluator = buildContainerArgs({ ...options, stage: "evaluator" });
  expect(candidate).toContain("type=bind,src=/synthetic/weights,dst=/in/train,readonly");
  expect(candidate.join(" ")).not.toContain("/synthetic/heldout");
  expect(evaluator).toContain("type=bind,src=/synthetic/heldout,dst=/in/heldout,readonly");
  expect(evaluator.join(" ")).not.toContain("/synthetic/weights");
  expect(candidate.slice(candidate.indexOf("--network"), candidate.indexOf("--network") + 2)).toEqual(["--network", "none"]);
  const mismatch = fakeRunner([{ exitCode: 0, stdout: JSON.stringify({ sha256: "b".repeat(64), files: 2, bytes: 10 }), stderr: "private diagnostic" }]);
  await expect(verifyExecutorInputs(executor, p, mismatch.runner)).rejects.toThrow("executor input train: manifest hash mismatch");
  expect(mismatch.requests).toHaveLength(1);
  expect(mismatch.requests[0]?.command).toBe("python3");
  expect(await verifyExecutorInputs(executor, validateProtocol(protocol()), fakeRunner([]).runner)).toEqual({});
  expect(() => buildContainerArgs({ ...options, stage: "candidate", protocol: { ...p, inputs: { ...p.inputs, alias: { ...input(), path: "/synthetic/heldout", mount: { candidate: "/in/alias" } } } } })).toThrow("stage-private");
  expect(() => buildContainerArgs({ ...options, stage: "candidate", protocol: { ...p, inputs: { input: { ...input(), path: paths.output } } } })).toThrow("overlaps");
});

test("design approval becomes stale when an input hash or stage mount changes", async () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic input seal", mode: "experiment", autonomy: "gates" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeAtomic(join(dir, "task", "task.md"), "synthetic", 65_536);
  writeAtomic(join(dir, "task", "evaluator", "evaluate"), "synthetic", 65_536);
  const p = { ...protocol(), inputs: { base: input() } };
  await withLock(dir, () => setProtocol(dir, p, ctx.actor));
  await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  expect(ops.gateList(dir).find(gate => gate.gate === "design")?.state).toBe("approved");
  const sealed = designBinding(dir), initialHash = protocolHash(validateProtocol(p)), before = readTextBounded(join(dir, "design", "protocol.json"), PROTOCOL_BYTES);
  await withLock(dir, () => setProtocol(dir, { ...p, inputs: { base: { ...input(), path: "/synthetic/relocated-weights" } } }, ctx.actor));
  expect(designBinding(dir)).toBe(sealed);
  expect(protocolHash(readDesign(dir)!.protocol)).toBe(initialHash);
  expect(ops.gateList(dir).find(gate => gate.gate === "design")?.state).toBe("approved");
  const relocated = readTextBounded(join(dir, "design", "protocol.json"), PROTOCOL_BYTES);
  expect(relocated).not.toBe(before);
  const receipt = readLedger(dir).findLast(event => event.type === "protocol.set")!;
  expect(receipt.data.sha256).toBe(sha256(relocated));
  expect(receipt.data.identitySha256).toBe(sha256(canonical(frozenProtocol(readDesign(dir)!.protocol))));
  await withLock(dir, () => setProtocol(dir, { ...p, inputs: { base: { ...input(), sha256: "b".repeat(64) } } }, ctx.actor));
  expect(ops.gateList(dir).find(gate => gate.gate === "design")?.state).toBe("pending");
  await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  await withLock(dir, () => setProtocol(dir, { ...p, inputs: { base: { ...input(), sha256: "b".repeat(64), mount: { evaluator: "/in/heldout" } } } }, ctx.actor));
  expect(ops.gateList(dir).find(gate => gate.gate === "design")?.state).toBe("pending");
});

test("public locators are mandatory but frozen identities are path-free and detached", () => {
  const publicValue = validateProtocol({ ...protocol(), inputs: { base: input(), heldout: { ...input(), path: "/synthetic/private-heldout", mount: { evaluator: "/in/heldout" } } } });
  const before = JSON.stringify(publicValue), frozen = frozenProtocol(publicValue);
  expect(frozen.inputs).toEqual({ base: { sha256: input().sha256, mount: input().mount }, heldout: { sha256: input().sha256, mount: { evaluator: "/in/heldout" } } });
  expect(JSON.stringify(frozen)).not.toContain("/synthetic/");
  expect(validateStoredProtocol(frozen)).toEqual(frozen); expect(frozenProtocol(frozen)).toEqual(frozen);
  expect(protocolHash(frozen)).toBe(protocolHash(publicValue)); expect(sameProtocolInputs(publicValue, frozen)).toBe(true);
  expect(() => validateProtocol(frozen)).toThrow("invalid locator");
  expect(() => validateStoredProtocol(publicValue)).toThrow("executor locators are forbidden");
  frozen.inputs!.base!.mount.candidate = "/in/changed";
  expect(JSON.stringify(publicValue)).toBe(before); expect(sameProtocolInputs(publicValue, frozen)).toBe(false);
});

test("hash identity ignores locators and input ordering but binds names, hashes and mounts", () => {
  const publicValue = validateProtocol({ ...protocol(), inputs: { base: input(), aux: { ...input(), mount: { evaluator: "/in/aux" } } } });
  const relocated = validateProtocol({ ...protocol(), inputs: { aux: { ...input(), path: "/relocated/aux", mount: { evaluator: "/in/aux" } }, base: { ...input(), path: "/relocated/base" } } });
  expect(protocolHash(relocated)).toBe(protocolHash(publicValue)); expect(sameProtocolInputs(relocated, publicValue)).toBe(true);
  for (const changed of [
    { renamed: input(), aux: { ...input(), mount: { evaluator: "/in/aux" } } },
    { ...publicValue.inputs, base: { ...input(), sha256: "b".repeat(64) } },
    { ...publicValue.inputs, base: { ...input(), mount: { candidate: "/in/revised" } } },
  ]) {
    const value = validateProtocol({ ...protocol(), inputs: changed });
    expect(protocolHash(value)).not.toBe(protocolHash(publicValue)); expect(sameProtocolInputs(value, publicValue)).toBe(false);
  }
  expect(protocolHash({ ...publicValue, budget: { ...publicValue.budget, maxAttempts: 9 } })).toBe(protocolHash(publicValue));
});

test("stored validation strictly refuses locator fields, malformed identities and mixed frozen/public records", () => {
  const stored = frozenProtocol(validateProtocol({ ...protocol(), inputs: { base: input() } }));
  const identity = stored.inputs!.base!;
  for (const inputs of [null, [], { base: { ...identity, path: undefined } }, { base: { ...identity, path: "/private/locator" } }, { base: { ...identity, extra: true } },
    { base: { ...identity, sha256: "A".repeat(64) } }, { base: { ...identity, mount: {} } }, { base: { ...identity, mount: { evaluator: "/out" } } },
    { Bad: identity }, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x${i}`, identity]))]) expect(() => validateStoredProtocol({ ...stored, inputs })).toThrow("protocol.inputs");
  expect(() => validateStoredProtocol({ ...stored, v: 2 })).toThrow("unsupported version");
  expect(() => frozenProtocol({ ...stored, inputs: { base: identity, other: { ...input(), mount: { evaluator: "/in/other" } } } })).toThrow("invalid locator");
  expect(validateStoredProtocol({ ...protocol(), inputs: {} }).inputs).toEqual({});
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`x${i}`, { ...input(), mount: { candidate: `/in/x${i}` } }]));
  expect(Object.keys(validateProtocol({ ...protocol(), inputs: eight }).inputs!)).toHaveLength(8);
  expect(Object.keys(validateStoredProtocol(frozenProtocol(validateProtocol({ ...protocol(), inputs: eight }))).inputs!)).toHaveLength(8);
});

test("legacy no-input protocol hash and raw-byte design seals remain identical", async () => {
  const legacy = validateProtocol(protocol()), { budget: _budget, ...oldComparable } = legacy;
  expect(frozenProtocol(legacy)).toEqual(legacy); expect(validateStoredProtocol(legacy)).toEqual(legacy);
  expect(protocolHash(legacy)).toBe(sha256(canonical(oldComparable)));
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic legacy seal", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeAtomic(join(dir, "task", "task.md"), "synthetic task", 65_536); writeAtomic(join(dir, "task", "evaluator", "evaluate"), "synthetic evaluator", 65_536);
  await withLock(dir, () => setProtocol(dir, legacy, ctx.actor));
  const file = join(dir, "design", "protocol.json"), original = readTextBounded(file, PROTOCOL_BYTES), tree = taskTreeHash(dir);
  expect(designBinding(dir)).toBe(sha256(JSON.stringify([sha256(original), tree])));
  expect(readLedger(dir).findLast(event => event.type === "protocol.set")!.data).not.toHaveProperty("identitySha256");
  writeAtomic(file, original + "\n", PROTOCOL_BYTES);
  expect(designBinding(dir)).toBe(sha256(JSON.stringify([sha256(original + "\n"), tree])));
  expect(protocolHash(readDesign(dir)!.protocol)).toBe(protocolHash(legacy));
  // Existing optional selection/final-seed seal pieces retain their original order and bytes too.
  await withLock(dir, () => setProtocol(dir, { ...legacy, seeds: [1, 2] }, ctx.actor));
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: "a".repeat(40) }, minSeeds: 1, minDelta: 1 }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx);
  const design = readDesign(dir)!, currentText = readTextBounded(file, PROTOCOL_BYTES);
  expect(readSelection(dir, design.protocol)?.run).toBe("investigate");
  expect(design.binding).toBe(sha256(JSON.stringify([sha256(currentText), tree, selectionHash(dir, design.protocol), finalSeedsHash(dir, design.protocol)])));
});
