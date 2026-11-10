import {expect, test} from "bun:test";
import {mkdirSync, symlinkSync, unlinkSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {canonical, filePath, FROZEN_RECEIPT, verifyPreregistration} from "../scripts/execution-eval.ts";
import {REMATERIALIZATION_PROTOCOL, REMATERIALIZATION_RECEIPT, SETUP_CODE_FILES} from "../scripts/execution-reuse-rematerialize.ts";
import {AMENDMENT_RECEIPT} from "../scripts/execution-supervision-amendment.ts";
import {REUSE_R2_BYTES, REUSE_R2_PRIOR_SETUP_SHA256, REUSE_R2_PROTOCOL, REUSE_R2_RECEIPT, REUSE_R2_SEALER, readReuseRematerializationR2, sealReuseRematerializationR2, verifyReuseRematerializationR2} from "../scripts/execution-reuse-rematerialize-r2.ts";
import {readBytesBounded, readTextBounded, sha256, writeAtomic} from "../src/study.ts";
import {tempDir} from "./helpers.ts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
function fixture() {
  const root = tempDir(), parent = verifyPreregistration(sourceRoot, join(sourceRoot, FROZEN_RECEIPT));
  const names = [...new Set([FROZEN_RECEIPT, AMENDMENT_RECEIPT, REMATERIALIZATION_RECEIPT, REMATERIALIZATION_PROTOCOL,
    REUSE_R2_PROTOCOL, REUSE_R2_SEALER, ...SETUP_CODE_FILES, ...parent.methodFiles.map(row => row.path),
    ...parent.inputFiles.map(row => row.path), ...parent.expectedFiles.map(row => row.path)])];
  let total = 0;
  for (const name of names) {
    const bytes = readBytesBounded(filePath(sourceRoot, name), REUSE_R2_BYTES, {noFollow: true});
    total += bytes.length;
    if (total > 3 * 1024 * 1024) throw new Error("synthetic r2 fixture exceeds its aggregate copy bound");
    const target = join(root, name); mkdirSync(dirname(target), {recursive: true});
    writeAtomic(target, new TextDecoder("utf-8", {fatal: true}).decode(bytes), REUSE_R2_BYTES);
  }
  const raw = (name: string) => readBytesBounded(filePath(root, name), REUSE_R2_BYTES, {noFollow: true});
  const immutable = [FROZEN_RECEIPT, AMENDMENT_RECEIPT, REMATERIALIZATION_RECEIPT, ...parent.inputFiles.map(row => row.path), ...parent.expectedFiles.map(row => row.path)];
  const before = immutable.map(name => [name, sha256(raw(name))] as const);
  return {root, raw, before, receipt: join(root, REUSE_R2_RECEIPT)};
}
function edit(file: string, change: (raw: any) => void): void {
  const raw = JSON.parse(readTextBounded(file, REUSE_R2_BYTES, {noFollow: true})); change(raw);
  writeAtomic(file, JSON.stringify(raw, null, 2) + "\n", REUSE_R2_BYTES);
}

test("r2 supersedes only code visibility and preserves every original case, stage, fault and inherited binding", () => {
  const f = fixture(), old = JSON.parse(readTextBounded(join(f.root, REMATERIALIZATION_RECEIPT), REUSE_R2_BYTES));
  expect(verifyReuseRematerializationR2(f.root)).toEqual({state: "missing", receipt: null});
  const result = sealReuseRematerializationR2(f.root);
  expect(result.state).toBe("verified");
  if (result.state !== "verified") throw new Error("synthetic r2 fixture must seal");
  const receipt = result.receipt;
  expect(receipt.supersedes).toEqual({path: REMATERIALIZATION_RECEIPT, sha256: sha256(f.raw(REMATERIALIZATION_RECEIPT)), setupSha256: REUSE_R2_PRIOR_SETUP_SHA256, reason: "export-only-before-first-t3-use"});
  expect(sha256(canonical(old.identity))).toBe(REUSE_R2_PRIOR_SETUP_SHA256);
  expect(receipt.setup.identity.cases).toEqual(old.identity.cases);
  for (const [index, row] of receipt.setup.identity.cases.entries()) {
    expect(canonical(row.stages)).toBe(canonical(old.identity.cases[index].stages));
    expect(row.fault).toBe(old.identity.cases[index].fault);
  }
  const {codeSha256: oldCode, ...oldBindings} = old.identity.bindings;
  const {codeSha256: currentCode, ...currentBindings} = receipt.setup.identity.bindings;
  expect(currentBindings).toEqual(oldBindings); expect(currentCode).not.toBe(oldCode);
  expect(receipt.bindings.protocolSha256).toBe(sha256(f.raw(REUSE_R2_PROTOCOL)));
  expect(receipt.bindings.sealerSha256).toBe(sha256(f.raw(REUSE_R2_SEALER)));
  expect(readReuseRematerializationR2(f.root)).toEqual(receipt);
  const sealed = f.raw(REUSE_R2_RECEIPT);
  expect(sealReuseRematerializationR2(f.root)).toEqual(result);
  expect(f.raw(REUSE_R2_RECEIPT)).toEqual(sealed);
  for (const [name, before] of f.before) expect(sha256(f.raw(name))).toBe(before);
});

test("r2 refuses source changes outside the exact seven export prefixes", () => {
  for (const name of ["scripts/execution-reuse.ts", "scripts/execution-workload.ts", REMATERIALIZATION_PROTOCOL]) {
    const f = fixture(), file = join(f.root, name), before = readTextBounded(file, REUSE_R2_BYTES);
    writeAtomic(file, before + "\n// synthetic non-export mutation\n", REUSE_R2_BYTES);
    expect(() => sealReuseRematerializationR2(f.root)).toThrow("execution reuse rematerialization r2:");
    for (const [immutable, hash] of f.before) expect(sha256(f.raw(immutable))).toBe(hash);
  }
});

test("recorded setup costs retain their values and canonical seal across JSON property ordering", () => {
  const f = fixture(), first = sealReuseRematerializationR2(f.root);
  if (first.state !== "verified") throw new Error("synthetic r2 fixture must seal");
  edit(f.receipt, raw => {raw.setup.setupCosts = Object.fromEntries(Object.entries(raw.setup.setupCosts).reverse());});
  const reread = readReuseRematerializationR2(f.root);
  expect(reread.setup.setupCosts).toEqual(first.receipt.setup.setupCosts);
  expect(reread.receiptSha256).toBe(first.receipt.receiptSha256);
  const {receiptSha256, ...body} = reread;
  expect(sha256(canonical(body))).toBe(receiptSha256);
  expect(verifyReuseRematerializationR2(f.root)).toEqual({state: "verified", receipt: reread});
});

test("original receipt raw and canonical pins cannot be replaced by a recomputed tampered setup", () => {
  const f = fixture(), prior = join(f.root, REMATERIALIZATION_RECEIPT);
  edit(prior, raw => {raw.identity.cases[0].fault = "corrupt"; raw.setupSha256 = sha256(canonical(raw.identity));});
  expect(() => sealReuseRematerializationR2(f.root)).toThrow("immutable pin");
});

test("changed, unsupported or extra-field r2 receipts are preserved instead of resealed", () => {
  for (const mutate of [
    (raw: any) => {raw.v = 2;},
    (raw: any) => {raw.privateBody = "synthetic-private-body";},
    (raw: any) => {raw.setup.identity.cases[0].stages[0].sha256 = "0".repeat(64);},
    (raw: any) => {raw.bindings.sealerSha256 = "0".repeat(64);},
    (raw: any) => {raw.supersedes.reason = "different-method";},
    (raw: any) => {raw.setup.setupCosts.materializationCpuSeconds = -1;},
  ]) {
    const f = fixture(); sealReuseRematerializationR2(f.root); edit(f.receipt, mutate);
    const before = f.raw(REUSE_R2_RECEIPT);
    expect(verifyReuseRematerializationR2(f.root)).toEqual({state: "changed", receipt: null});
    expect(sealReuseRematerializationR2(f.root)).toEqual({state: "changed", receipt: null});
    expect(() => readReuseRematerializationR2(f.root)).toThrow("execution reuse rematerialization r2:");
    expect(f.raw(REUSE_R2_RECEIPT)).toEqual(before);
  }
});

test("receipt, source and parent symlinks and over-bound files refuse without publication", () => {
  const f = fixture();
  symlinkSync(join(f.root, REMATERIALIZATION_RECEIPT), f.receipt);
  expect(() => sealReuseRematerializationR2(f.root)).toThrow("physical regular file");
  unlinkSync(f.receipt);
  const protocol = join(f.root, REUSE_R2_PROTOCOL); unlinkSync(protocol); symlinkSync(join(f.root, REMATERIALIZATION_PROTOCOL), protocol);
  expect(() => sealReuseRematerializationR2(f.root)).toThrow("required source");
  const g = fixture();
  writeAtomic(g.receipt, " ".repeat(REUSE_R2_BYTES + 1), REUSE_R2_BYTES + 1);
  expect(verifyReuseRematerializationR2(g.root)).toEqual({state: "changed", receipt: null});
  const before = readBytesBounded(g.receipt, REUSE_R2_BYTES + 1);
  expect(sealReuseRematerializationR2(g.root).state).toBe("changed");
  expect(readBytesBounded(g.receipt, REUSE_R2_BYTES + 1)).toEqual(before);
  const h = fixture(), elsewhere = tempDir(), linked = join(h.root, "linked"); symlinkSync(elsewhere, linked);
  expect(() => sealReuseRematerializationR2(h.root, join(linked, "receipt.json"))).toThrow("physical directories");
});
