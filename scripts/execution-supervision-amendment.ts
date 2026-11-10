import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { types } from "node:util";
import { canonical, filePath, FROZEN_RECEIPT, PREREGISTRATION, verifyPreregistration, publishEvaluationReceipt } from "./execution-eval.ts";
import { validateSupervisionFacts, type SupervisionFacts } from "./execution-supervision-facts.ts";
import { plain, readBytesBounded, readTextBounded, sha256 } from "../src/study.ts";

export const AMENDMENT_RECEIPT = "docs/verification/execution-eval-supervision-v2-frozen.json";
export const AMENDMENT_PROTOCOL = "docs/verification/execution-eval-supervision-v2-protocol.md";
export const AMENDMENT_CORPUS = "test/fixtures/execution-eval-supervision-v2/corpus.json";
const CORPUS_PREFIX = "test/fixtures/execution-eval-supervision-v2/";
const PARENT_RECEIPT_SHA256 = "72f36f856c2559bf7a626689bca3825ae3cfe49f27c9d8abf544f24bd2778e20";
const PARENT_RAW_SHA256 = "ad2c48aade8fd430727f7c16f90bb33a9283f5fc71593b2fcf8c98f5c58a2d60";
const DOCUMENT_BYTES = 65_536, FIXTURE_BYTES = 16_384, TOTAL_BYTES = 3 * 1024 * 1024;
const SCENARIOS = ["ordinary-progress", "true-trigger", "misleading-symptom"] as const;
export type SupervisionScenario = typeof SCENARIOS[number];
export interface SupervisionIntentLabel {
  v: 1; id: string; trial: "supervision"; scenario: SupervisionScenario; trigger: boolean; task: number;
  nextAction: "escalate" | "recheck" | "request_integration" | "none"; reason: string; mustNot: string[];
}
interface FileHash { path: string; sha256: string; bytes: number }
export interface SupervisionAmendmentReceipt {
  v: 1; status: "preregistered-amendment-not-measured";
  amends: { path: typeof FROZEN_RECEIPT; sha256: string; receiptSha256: string };
  bindings: { methodSha256: string; inputSha256: string; expectedSha256: string; protocolSha256: string; thresholdsSha256: string; denominatorsSha256: string };
  files: FileHash[]; receiptSha256: string;
}
export interface SupervisionAmendmentCase {
  id: string; scenario: SupervisionScenario; inputSha256: string; expectedSha256: string;
  payload: {request: string; facts: SupervisionFacts}; expected: SupervisionIntentLabel;
}
function fail(cause: string): never {
  throw new Error(`execution supervision amendment: ${cause}; restore the approved v2 corpus, inherited method and parent v1 seal, or register a separately reviewed amendment before retrying; no evaluation is launched`);
}
function object(raw: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail(`${label} requires exactly its closed fields`);
  const keys = Reflect.ownKeys(raw), result: Record<string, unknown> = Object.create(null);
  if (keys.length !== fields.length) fail(`${label} requires exactly its closed fields`);
  for (const key of keys) {
    if (typeof key !== "string" || !fields.includes(key)) fail(`${label} requires exactly its closed fields`);
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${label} requires inert JSON fields`);
    result[key] = descriptor.value;
  }
  return result;
}
function text(raw: unknown, bound: number, label: string): string {
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw) > bound || /\p{Cc}/u.test(raw)) fail(`${label} must be bounded nonblank text without controls`);
  return raw;
}
function id(raw: unknown): string {
  const value = text(raw, 64, "case id");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail("case id must be a lowercase slug");
  return value;
}
function scenario(raw: unknown): SupervisionScenario {
  if (!(SCENARIOS as readonly unknown[]).includes(raw)) fail("case scenario is unsupported");
  return raw as SupervisionScenario;
}
/** Evaluator-only intent, never a candidate fact or a prediction that a producer rule fires. */
export function parseSupervisionIntentLabel(raw: unknown): SupervisionIntentLabel {
  const row = object(raw, ["v", "id", "trial", "scenario", "trigger", "task", "nextAction", "reason", "mustNot"], "expected wrapper");
  if (row.v !== 1 || row.trial !== "supervision") fail("expected wrapper version/trial is unsupported");
  if (typeof row.trigger !== "boolean" || !Number.isSafeInteger(row.task) || (row.task as number) < 1) fail("expected trigger and positive task identity are required");
  if (typeof row.nextAction !== "string" || !["escalate", "recheck", "request_integration", "none"].includes(row.nextAction) || row.trigger === (row.nextAction === "none")) fail("expected action must be none exactly for a non-trigger label");
  const reason = text(row.reason, 128, "intent reason");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(reason)) fail("intent reason must be a bounded kebab code");
  if (!Array.isArray(row.mustNot) || types.isProxy(row.mustNot) || Object.getPrototypeOf(row.mustNot) !== Array.prototype) fail("mustNot must be a list of at most 32 strings");
  const length = Object.getOwnPropertyDescriptor(row.mustNot, "length");
  if (!length || !("value" in length) || length.value > 32 || Reflect.ownKeys(row.mustNot).length !== length.value + 1) fail("mustNot must be a dense list of at most 32 strings");
  const mustNot: string[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(row.mustNot, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("mustNot must contain inert JSON strings");
    mustNot.push(text(descriptor.value, 256, "mustNot item"));
  }
  return { v: 1, id: id(row.id), trial: "supervision", scenario: scenario(row.scenario), trigger: row.trigger, task: row.task as number,
    nextAction: row.nextAction as SupervisionIntentLabel["nextAction"], reason, mustNot };
}
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", {fatal: true}).decode(bytes); } catch { return fail("source is not valid UTF-8"); }
}
function json(text: string): unknown { try { return JSON.parse(text); } catch { return fail("source is not valid JSON"); } }
/** Destination parents are physical directories inside the supplied fixture root. */
function receiptPath(root: string, receiptFile: string): string {
  const file = resolve(receiptFile), name = relative(root, file);
  if (!name || isAbsolute(name) || name.split(/[\\/]/).some(part => part === ".." || part === ".")) fail("receipt must be inside the fixture root");
  let parent = root;
  for (const part of relative(root, dirname(file)).split(/[\\/]/).filter(Boolean)) {
    parent = join(parent, part);
    let stat; try { stat = lstatSync(parent); } catch { return fail("receipt parent is missing or unreadable"); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("receipt parent must be a physical directory");
  }
  return file;
}
function snapshot(rootArg: string): { receipt: SupervisionAmendmentReceipt; cases: SupervisionAmendmentCase[] } {
  const root = resolve(rootArg), parent = verifyPreregistration(root, filePath(root, FROZEN_RECEIPT));
  const files: FileHash[] = []; let total = 0;
  const read = (name: string, bound: number) => {
    let bytes: Buffer;
    try { bytes = readBytesBounded(filePath(root, name), bound, {noFollow: true}); } catch { return fail("required physical source is missing, unreadable or over-bound"); }
    total += bytes.length; if (total > TOTAL_BYTES) fail("sources exceed the aggregate 3 MiB bound");
    const hash = {path: name, sha256: sha256(bytes), bytes: bytes.length}; files.push(hash);
    return {text: decode(bytes), hash};
  };
  const parentSource = read(FROZEN_RECEIPT, DOCUMENT_BYTES), method = read(PREREGISTRATION, DOCUMENT_BYTES);
  if (parent.receiptSha256 !== PARENT_RECEIPT_SHA256 || parentSource.hash.sha256 !== PARENT_RAW_SHA256) fail("parent v1 receipt differs from the approved immutable seal");
  // Parent verification binds this exact method JSON and its budgets, thresholds and denominators.
  const inherited = json(method.text); if (!plain(inherited) || !plain(inherited.budgets) || !plain(inherited.thresholds) || !Array.isArray(inherited.denominators)) fail("inherited method lacks budgets, thresholds or denominators");
  for (const source of parent.methodFiles) if (source.path !== PREREGISTRATION) read(source.path, DOCUMENT_BYTES);
  const protocol = read(AMENDMENT_PROTOCOL, DOCUMENT_BYTES), index = read(AMENDMENT_CORPUS, DOCUMENT_BYTES);
  const corpus = object(json(index.text), ["v", "cases"], "corpus index");
  if (corpus.v !== 1 || !Array.isArray(corpus.cases) || corpus.cases.length !== 12) fail("v2 corpus requires exactly twelve v1 wrappers");
  const identities = new Set<string>(), paths = new Set<string>([AMENDMENT_CORPUS]), counts = new Map<string, number>();
  const inputs: FileHash[] = [index.hash], expectedFiles: FileHash[] = [];
  const cases = corpus.cases.map(raw => {
    const row = object(raw, ["id", "trial", "scenario", "input", "expected"], "case index row"), name = id(row.id), group = scenario(row.scenario);
    if (row.trial !== "supervision" || identities.has(name)) fail("case trial is unsupported or identity is duplicated");
    identities.add(name); counts.set(group, (counts.get(group) ?? 0) + 1);
    const pair = (["input", "expected"] as const).map(kind => {
      const source = row[kind];
      if (typeof source !== "string" || source !== `${CORPUS_PREFIX}${name}.${kind}.json` || paths.has(source)) fail("case pair must have unique exact v2 corpus paths");
      paths.add(source); return read(source, FIXTURE_BYTES);
    });
    const inputSource = pair[0]!, expectedSource = pair[1]!;
    const wrapper = object(json(inputSource.text), ["v", "id", "trial", "scenario", "input"], "input wrapper");
    if (wrapper.v !== 1 || wrapper.id !== name || wrapper.trial !== "supervision" || wrapper.scenario !== group) fail("input wrapper does not match its indexed identity");
    const payload = object(wrapper.input, ["request", "facts"], "candidate input"), facts = validateSupervisionFacts(payload.facts);
    const expected = parseSupervisionIntentLabel(json(expectedSource.text));
    if (expected.id !== name || expected.scenario !== group) fail("expected wrapper does not match its indexed identity");
    inputs.push(inputSource.hash); expectedFiles.push(expectedSource.hash);
    return { id: name, scenario: group, inputSha256: inputSource.hash.sha256, expectedSha256: expectedSource.hash.sha256,
      payload: {request: text(payload.request, 4000, "candidate request"), facts}, expected };
  });
  if (SCENARIOS.some(group => counts.get(group) !== 4)) fail("each supervision scenario requires four cases");
  const body: Omit<SupervisionAmendmentReceipt, "receiptSha256"> = { v: 1 as const, status: "preregistered-amendment-not-measured" as const,
    amends: {path: FROZEN_RECEIPT, sha256: parentSource.hash.sha256, receiptSha256: parent.receiptSha256},
    bindings: { methodSha256: sha256(canonical({ inheritedMethodSha256: parent.bindings.methodSha256, methodSha256: method.hash.sha256, amendmentProtocolSha256: protocol.hash.sha256 })),
      inputSha256: sha256(canonical(inputs)), expectedSha256: sha256(canonical(expectedFiles)), protocolSha256: protocol.hash.sha256,
      thresholdsSha256: parent.bindings.thresholdsSha256, denominatorsSha256: parent.bindings.denominatorsSha256 }, files };
  return {receipt: {...body, receiptSha256: sha256(canonical(body))}, cases};
}
export function verifySupervisionAmendment(rootArg: string, receiptFile = join(resolve(rootArg), AMENDMENT_RECEIPT)): SupervisionAmendmentReceipt {
  const root = resolve(rootArg), current = snapshot(root).receipt, file = receiptPath(root, receiptFile);
  let raw: unknown;
  try { raw = json(readTextBounded(filePath(root, relative(root, file)), DOCUMENT_BYTES, {noFollow: true})); }
  catch { return fail("amendment receipt is missing, unreadable, linked or over-bound"); }
  if (!plain(raw) || raw.v !== 1) fail("amendment receipt version is unsupported; preserve original bytes");
  if (canonical(raw) !== canonical(current)) fail("amendment receipt content or seal changed");
  return current;
}
export function freezeSupervisionAmendment(rootArg: string, receiptFile = join(resolve(rootArg), AMENDMENT_RECEIPT)): SupervisionAmendmentReceipt {
  const root = resolve(rootArg), file = receiptPath(root, receiptFile);
  if (lstatSync(file, {throwIfNoEntry: false})) return verifySupervisionAmendment(root, file);
  const current = snapshot(root).receipt;
  return publishEvaluationReceipt(file, current, DOCUMENT_BYTES, () => verifySupervisionAmendment(root, file));
}
/** Callers must keep evaluator-only expected labels out of every candidate adapter invocation. */
export function loadSupervisionAmendmentCases(root: string): {receipt: SupervisionAmendmentReceipt; cases: SupervisionAmendmentCase[]} {
  const verified = verifySupervisionAmendment(root), loaded = snapshot(root);
  if (loaded.receipt.receiptSha256 !== verified.receiptSha256) fail("sources changed while loading the verified amendment");
  return {receipt: verified, cases: loaded.cases};
}
