import {expect, spyOn, test} from "bun:test";
import * as fs from "node:fs";
import * as study from "../src/study.ts";
import {init} from "../src/commands.ts";
import {parseHubExecutionReference, type HubExecutionReferenceV1} from "../src/harness/hub-reference.ts";
import {readProvenance, validateExecutionReference, type ExecutionReferenceV1} from "../src/provenance.ts";
import {inspectLocalEvidence} from "../src/memory/evidence-local.ts";
import {skillEvidenceReference} from "../src/memory/evidence.ts";
import {tempDir} from "./helpers.ts";

// Synthetic golden addresses from agent-hub 50100a8:test/fixtures/execution-reference-v1.json
// and test/fixtures/guidance-variant-v1.json. These are inert fixture bytes, not hub reads.
const minimal: HubExecutionReferenceV1 = {v: 1, tool: "ahub", projectKey: "project-a", kind: "task", id: "42"};
const golden: HubExecutionReferenceV1 = {...minimal, revision: "3"};
test("pinned hub neutral and guidance golden references round-trip without identity normalization", () => {
  for (const raw of [minimal, {...minimal, revision: "7", sha256: "a".repeat(64)}, golden]) {
    expect(parseHubExecutionReference(raw)).toEqual(raw);
    expect(JSON.stringify(validateExecutionReference(raw))).toBe(JSON.stringify(raw));
  }
  for (const id of ["../opaque/path", "https://example.invalid/address", "TOKEN=synthetic-credential", "café", "café", " "]) {
    const raw = {...minimal, projectKey: " ./source-owned ", id};
    expect(parseHubExecutionReference(raw)).toEqual(raw);
  }
});

test("hub reference UTF-8 bounds and closed fields match the source-owner contract", () => {
  for (const raw of [
    {...minimal, id: "é".repeat(128)}, {...minimal, projectKey: "p".repeat(256)},
    {...minimal, revision: "r".repeat(128)}, {...minimal, kind: "k".repeat(64)},
  ]) expect(parseHubExecutionReference(raw)).toEqual(raw);
  for (const raw of [
    {...minimal, id: "é".repeat(129)}, {...minimal, projectKey: "p".repeat(257)},
    {...minimal, revision: "r".repeat(129)}, {...minimal, kind: "k".repeat(65)},
    {...minimal, v: 2}, {...minimal, tool: "other"}, {...minimal, id: ""},
    {...minimal, revision: null}, {...minimal, revision: undefined}, {...minimal, sha256: undefined},
    {...minimal, sha256: null}, {...minimal, sha256: "A".repeat(64)}, {...minimal, sha256: "a".repeat(63)},
    {...minimal, url: "https://example.invalid"}, {...minimal, kind: "ahub/task"}, {...minimal, kind: "Task"},
    {...minimal, id: "line\nbreak"}, {...minimal, projectKey: "tab\tkey"},
  ]) expect(() => parseHubExecutionReference(raw)).toThrow("hub execution reference:");
});

test("hostile hub objects are refused without running getters or proxy traps", () => {
  let calls = 0;
  const getter = Object.defineProperty({...minimal}, "id", {get() {calls++; throw new Error("private getter");}});
  const proxy = new Proxy(minimal, {get() {calls++; throw new Error("private proxy");}, ownKeys() {calls++; throw new Error("private proxy");}});
  const revoked = Proxy.revocable(minimal, {}); revoked.revoke();
  for (const raw of [getter, proxy, revoked.proxy, Object.assign(Object.create({id: "inherited"}), minimal), {...minimal, [Symbol("extra")]: 1}, [], null]) {
    expect(() => parseHubExecutionReference(raw)).toThrow("hub execution reference:");
    expect(() => validateExecutionReference(raw)).toThrow();
  }
  expect(calls).toBe(0);
  expect(parseHubExecutionReference(Object.assign(Object.create(null), minimal))).toEqual(minimal);
  const secret = "synthetic-secret";
  try {parseHubExecutionReference({...minimal, private: secret}); throw new Error("expected refusal");}
  catch (error) {expect(String(error)).not.toContain(secret); expect(String(error)).toContain("supply a plain ahub v1 address");}
});

test("foreign provenance roots return explicitly unavailable before any filesystem capture", () => {
  const forbidden = () => {throw new Error("filesystem access forbidden");};
  const realpath = spyOn(fs, "realpathSync").mockImplementation(Object.assign(forbidden, {native: forbidden}));
  try {
    const result = readProvenance("/not-a-study", {root: golden});
    expect(result.status).toBe("unavailable"); expect(result.sourceSha256).toBeNull(); expect(result.ledgerPosition).toBeNull();
    expect(result.nodes).toEqual([]); expect(result.edges).toEqual([]); expect(result.totals).toBeNull();
    expect(result.issues.map(row => row.code)).toEqual(["foreign-root-unsupported"]);
    expect(realpath).not.toHaveBeenCalled();
  } finally {realpath.mockRestore();}
});

test("same-project same-id hub references never resolve as local evidence or native skill evidence", () => {
  const dir = tempDir(), native = init(dir, {question: "Synthetic reference boundary?"}, {actor: {kind: "person", id: "synthetic"}}).study;
  const ref = {...minimal, projectKey: native.id, kind: "study", id: native.id};
  const opened = spyOn(study, "openStudy").mockImplementation(() => {throw new Error("local source access forbidden");});
  try {
    const result = inspectLocalEvidence(dir, ref);
    expect(result).toEqual({state: "unsupported", digest: null, integrity: "unverified", outcome: {status: "unverified", success: false}, support: "reviewer-judgment"});
    expect(skillEvidenceReference(ref, native.id)).toBeUndefined();
    expect(opened).not.toHaveBeenCalled();
  } finally {opened.mockRestore();}
  const nativeRef = {v: 1 as const, tool: "ares" as const, projectKey: native.id, kind: "study" as const, id: native.id};
  expect(inspectLocalEvidence(dir, nativeRef).state).toBe("available");
});

test("native ares addresses retain their type, ordering, optional omission and exact JSON bytes", () => {
  const raw = {sha256: "b".repeat(64), revision: "  native revision  ", id: " ./native-id ", kind: "attempt" as const, projectKey: "native-project", tool: "ares" as const, v: 1};
  const ref: ExecutionReferenceV1 = validateExecutionReference(raw);
  expect(JSON.stringify(ref)).toBe('{"v":1,"tool":"ares","projectKey":"native-project","kind":"attempt","id":" ./native-id ","revision":"  native revision  ","sha256":"' + "b".repeat(64) + '"}');
  expect(JSON.stringify(validateExecutionReference({v: 1, tool: "ares", projectKey: "p", kind: "study", id: "p", revision: undefined}))).toBe('{"v":1,"tool":"ares","projectKey":"p","kind":"study","id":"p"}');
});
