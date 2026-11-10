import {lstatSync} from "node:fs";
import {dirname, isAbsolute, join, relative, resolve} from "node:path";
import {types} from "node:util";
import {canonical, COST_FIELDS, filePath, publishEvaluationReceipt, type CostRecord} from "./execution-eval.ts";
import {REMATERIALIZATION_RECEIPT, SETUP_CODE_FILES, rematerializeFrozenReuseSetup, type ReuseSetupResult} from "./execution-reuse-rematerialize.ts";
import {readBytesBounded, readTextBounded, sha256} from "../src/study.ts";

export const REUSE_R2_RECEIPT = "docs/verification/execution-eval-reuse-rematerialization-r2-frozen.json";
export const REUSE_R2_PROTOCOL = "docs/verification/execution-eval-reuse-rematerialization-r2.md";
export const REUSE_R2_SEALER = "scripts/execution-reuse-rematerialize-r2.ts";
export const REUSE_R2_BYTES = 65_536;
export const REUSE_R2_PRIOR_SETUP_SHA256 = "dce537e27d78d1771cb8d16edea295b0d06a28bdd7b5c148eab9443137a06cef";
const PRIOR_RAW_SHA256 = "8ba0e135505fab2417a6dcaa854e2241b72e272e8ebe812cebbf170e9d582e3d";
const AUTHORIZED_MODULE = "scripts/execution-reuse.ts";
const EXPORT_DECLARATIONS = ["interface ProducerFixture", "function syntheticProtocol(", "async function withProducerFixture<", "async function completeProducer(", "async function producerValues(", "function attemptBytes(", "async function injectDeclaredFault("] as const;
export interface ReuseRematerializationR2Receipt {
  v: 1;
  status: "preregistered-rematerialization-r2-not-measured";
  supersedes: {path: typeof REMATERIALIZATION_RECEIPT; sha256: string; setupSha256: string; reason: "export-only-before-first-t3-use"};
  bindings: {protocolSha256: string; sealerSha256: string};
  setup: ReuseSetupResult;
  receiptSha256: string;
}
export type ReuseRematerializationR2State = {state: "verified"; receipt: ReuseRematerializationR2Receipt} | {state: "missing" | "changed"; receipt: null};

function fail(cause: string): never {
  throw new Error(`execution reuse rematerialization r2: ${cause}; restore the approved r2 protocol, original immutable receipt and export-only source change, or register a separately reviewed amendment before retrying; no trial is launched`);
}
function object(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail("closed JSON object required");
  const keys = Reflect.ownKeys(raw), result: Record<string, unknown> = Object.create(null);
  if (keys.length !== fields.length) fail("missing or unknown receipt fields");
  for (const key of keys) {
    if (typeof key !== "string" || !fields.includes(key)) fail("missing or unknown receipt fields");
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("receipt fields must be inert JSON data");
    result[key] = descriptor.value;
  }
  return result;
}
function digest(raw: unknown): string {
  if (typeof raw !== "string" || raw.length !== 64 || !/^[a-f0-9]{64}$/.test(raw)) fail("lowercase SHA-256 identity required");
  return raw;
}
function json(text: string): unknown {try {return JSON.parse(text);} catch {return fail("invalid receipt JSON");}}
function costs(raw: unknown): CostRecord {
  // The shared canonical encoder sorts ordinary JSON objects. A null-prototype output
  // would take its JSON.stringify fallback and change the seal merely on reread.
  const row = object(raw, COST_FIELDS), result: Record<string, number | "unknown"> = {};
  for (const key of COST_FIELDS) {
    const value = row[key];
    if (value !== "unknown" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) fail("setup costs must be nonnegative recorded units or unknown");
    result[key] = value;
  }
  return result as CostRecord;
}
function destination(root: string, receiptFile: string): string {
  const file = resolve(receiptFile), name = relative(root, file);
  if (!name || isAbsolute(name) || name.split(/[\\/]/).some(part => part === ".." || part === ".")) fail("receipt destination must stay inside the fixture root");
  const rootStat = lstatSync(root, {throwIfNoEntry: false});
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail("fixture root must be a physical directory");
  let parent = root;
  for (const part of relative(root, dirname(file)).split(/[\\/]/).filter(Boolean)) {
    parent = join(parent, part);
    const stat = lstatSync(parent, {throwIfNoEntry: false});
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail("receipt parents must be physical directories");
  }
  return file;
}
function sourceBytes(root: string, name: string): Buffer {
  try {return readBytesBounded(filePath(root, name), REUSE_R2_BYTES, {noFollow: true});}
  catch {return fail("required source is missing, linked, unreadable or over-bound");}
}

/** The approved old receipt is checked independently of its now-obsolete current-code verifier. */
function inheritedSetup(root: string): ReuseSetupResult {
  const bytes = sourceBytes(root, REMATERIALIZATION_RECEIPT);
  if (sha256(bytes) !== PRIOR_RAW_SHA256) fail("original receipt raw identity differs from its immutable pin");
  const raw = json(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
  const row = object(raw, ["identity", "setupSha256", "setupCosts"]);
  if (digest(row.setupSha256) !== REUSE_R2_PRIOR_SETUP_SHA256 || sha256(canonical(row.identity)) !== REUSE_R2_PRIOR_SETUP_SHA256) fail("original receipt canonical setup differs from its immutable pin");
  // Both raw and canonical pins identify this exact approved schema and all case/stage/fault values.
  return {identity: row.identity as ReuseSetupResult["identity"], setupSha256: REUSE_R2_PRIOR_SETUP_SHA256, setupCosts: costs(row.setupCosts)};
}

function currentSetup(root: string, recordedCosts?: CostRecord): ReuseSetupResult {
  const prior = inheritedSetup(root), current = rematerializeFrozenReuseSetup(root);
  const {codeSha256: _oldCode, ...oldBindings} = prior.identity.bindings;
  const {codeSha256: _newCode, ...newBindings} = current.identity.bindings;
  if (canonical(current.identity.cases) !== canonical(prior.identity.cases) || canonical(newBindings) !== canonical(oldBindings)
    || canonical(current.identity.amends) !== canonical(prior.identity.amends) || current.identity.v !== prior.identity.v || current.identity.status !== prior.identity.status) fail("r2 changes inherited cases, stages, faults or non-code bindings");
  if (current.identity.files.length !== prior.identity.files.length) fail("r2 changes the inherited source set");
  let moduleBefore: typeof prior.identity.files[number] | undefined;
  for (const [index, before] of prior.identity.files.entries()) {
    const after = current.identity.files[index];
    if (!after || after.path !== before.path) fail("r2 changes inherited source ordering or paths");
    if (before.path === AUTHORIZED_MODULE) moduleBefore = before;
    else if (canonical(before) !== canonical(after)) fail("r2 changes a source outside the authorized export-only module");
  }
  if (!moduleBefore) fail("authorized module is absent from the original source bindings");
  let normalized: string;
  try {normalized = readTextBounded(filePath(root, AUTHORIZED_MODULE), REUSE_R2_BYTES, {noFollow: true});}
  catch {return fail("authorized module is not bounded physical UTF-8 source");}
  for (const declaration of EXPORT_DECLARATIONS) {
    const prefix = `export ${declaration}`, matches = normalized.split("\n").filter(line => line.startsWith(prefix));
    if (matches.length !== 1) fail("authorized helper exports are missing or ambiguous");
    normalized = normalized.split("\n").map(line => line.startsWith(prefix) ? line.slice("export ".length) : line).join("\n");
  }
  if (sha256(normalized) !== moduleBefore.sha256 || Buffer.byteLength(normalized) !== moduleBefore.bytes) fail("authorized module differs by more than the approved helper export prefixes");
  const currentCode = SETUP_CODE_FILES.map(name => current.identity.files.find(file => file.path === name));
  if (currentCode.some(file => !file) || sha256(canonical(currentCode)) !== digest(current.identity.bindings.codeSha256)
    || sha256(canonical(current.identity)) !== digest(current.setupSha256)) fail("current setup code or canonical identity is inconsistent");
  return {...current, ...(recordedCosts ? {setupCosts: recordedCosts} : {})};
}
function build(root: string, recordedCosts?: CostRecord): ReuseRematerializationR2Receipt {
  const setup = currentSetup(root, recordedCosts);
  const body: Omit<ReuseRematerializationR2Receipt, "receiptSha256"> = {
    v: 1, status: "preregistered-rematerialization-r2-not-measured",
    supersedes: {path: REMATERIALIZATION_RECEIPT, sha256: PRIOR_RAW_SHA256, setupSha256: REUSE_R2_PRIOR_SETUP_SHA256, reason: "export-only-before-first-t3-use"},
    bindings: {protocolSha256: sha256(sourceBytes(root, REUSE_R2_PROTOCOL)), sealerSha256: sha256(sourceBytes(root, REUSE_R2_SEALER))}, setup,
  };
  return {...body, receiptSha256: sha256(canonical(body))};
}

/** Strict source-owned read: malformed, unsupported or changed receipts are never silently adopted. */
export function readReuseRematerializationR2(rootArg: string, receiptFile = join(resolve(rootArg), REUSE_R2_RECEIPT)): ReuseRematerializationR2Receipt {
  const root = resolve(rootArg), file = destination(root, receiptFile), stat = lstatSync(file, {throwIfNoEntry: false});
  if (!stat?.isFile() || stat.isSymbolicLink()) fail("r2 receipt must be an existing physical regular file");
  let raw: unknown;
  try {raw = json(readTextBounded(file, REUSE_R2_BYTES, {noFollow: true}));}
  catch {return fail("r2 receipt is unreadable, invalid UTF-8/JSON or over-bound");}
  const row = object(raw, ["v", "status", "supersedes", "bindings", "setup", "receiptSha256"]);
  if (row.v !== 1 || row.status !== "preregistered-rematerialization-r2-not-measured") fail("r2 receipt version or status is unsupported; keep original bytes unchanged");
  const supersedes = object(row.supersedes, ["path", "sha256", "setupSha256", "reason"]), bindings = object(row.bindings, ["protocolSha256", "sealerSha256"]);
  digest(supersedes.sha256); digest(supersedes.setupSha256); digest(bindings.protocolSha256); digest(bindings.sealerSha256); digest(row.receiptSha256);
  const setup = object(row.setup, ["identity", "setupSha256", "setupCosts"]); digest(setup.setupSha256);
  const current = build(root, costs(setup.setupCosts));
  if (canonical(raw) !== canonical(current)) fail("r2 receipt content, inherited identities or source bindings changed");
  return current;
}
export function verifyReuseRematerializationR2(rootArg: string, receiptFile = join(resolve(rootArg), REUSE_R2_RECEIPT)): ReuseRematerializationR2State {
  const root = resolve(rootArg), file = destination(root, receiptFile), stat = lstatSync(file, {throwIfNoEntry: false});
  if (!stat) return {state: "missing", receipt: null};
  if (!stat.isFile() || stat.isSymbolicLink()) fail("r2 receipt must be a physical regular file");
  try {return {state: "verified", receipt: readReuseRematerializationR2(root, file)};}
  catch {return {state: "changed", receipt: null};}
}
/** Exclusive create-once publication; an existing receipt is only verified and never overwritten. */
export function sealReuseRematerializationR2(rootArg: string, receiptFile = join(resolve(rootArg), REUSE_R2_RECEIPT)): ReuseRematerializationR2State {
  const root = resolve(rootArg), file = destination(root, receiptFile);
  if (lstatSync(file, {throwIfNoEntry: false})) return verifyReuseRematerializationR2(root, file);
  const receipt = build(root);
  publishEvaluationReceipt(file, receipt, REUSE_R2_BYTES, () => readReuseRematerializationR2(root, file));
  const result = verifyReuseRematerializationR2(root, file);
  if (result.state !== "verified") fail("r2 publication does not match its checked source bindings");
  return result;
}
