import { lstatSync, mkdirSync, opendirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { init, protocol as setProtocol } from "../src/commands.ts";
import { designBinding, protocolHash } from "../src/exp/protocol.ts";
import { commit, plain, STUDY_BYTES, writeAtomic } from "../src/study.ts";
import { metricAttempt, metricProtocol } from "./execution-native-fixtures.ts";

const actor = {kind: "person" as const, id: "synthetic-fixture-bootstrap"};
const offlineHttp = {env: {}, json: async () => fail("network is outside visible fixture scaffolding"), text: async () => fail("network is outside visible fixture scaffolding")};
function fail(cause: string): never {throw new Error(`execution diagnose setup: ${cause}; restore bounded visible fixture identities and provide fresh caller-owned private directories before retrying`);}
function identity(raw: unknown, pattern: RegExp, label: string): string {
  if (typeof raw !== "string" || !pattern.test(raw)) fail(`${label} is invalid`);
  return raw;
}
function freshDirectory(dir: string): void {
  let stat; try {stat = lstatSync(dir); if (realpathSync(dir) !== resolve(dir)) fail("private directory has a linked parent");} catch {return fail("private directory is missing or has a linked parent");}
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) fail("private directory is not an owned physical directory");
  const entries = opendirSync(dir);
  try {if (entries.readSync()) fail("private directory is not fresh");} finally {entries.closeSync();}
}
/** Reviewed unit scaffolding from visible payload facts only. No evaluator labels or result bytes are read. */
export async function bootstrapVisibleDiagnosticStudy(value: Record<string, unknown>, dir: string, work: string): Promise<void> {
  const study = plain(value.study) ? value.study : {}, visible = Array.isArray(value.attempts) ? value.attempts.filter(plain) : [];
  identity(study.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, "study id");
  if (study.selectedHead !== undefined) identity(study.selectedHead, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "selected head");
  if (!visible.length || visible.length > 128 || visible.length !== (value.attempts as unknown[]).length) fail("visible attempts require 1..128 objects");
  const ids = new Set<string>();
  for (const fact of visible) {
    const id = identity(fact.id, /^[a-f0-9]{16}$/, "attempt id");
    if (ids.has(id)) fail("visible attempt ids are duplicated"); ids.add(id);
    identity(fact.commit, /^[a-f0-9]{40}$/, "attempt commit");
    if (fact.run !== undefined) identity(fact.run, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "run");
    if (typeof fact.status !== "string" || !["running", "succeeded", "failed", "cancelled", "unknown"].includes(fact.status)) fail("attempt status is invalid");
    if (fact.seed !== undefined && (!Number.isSafeInteger(fact.seed) || Number(fact.seed) < -2_147_483_648 || Number(fact.seed) > 2_147_483_647)) fail("attempt seed is invalid");
    if (fact.parentAttemptId !== undefined) identity(fact.parentAttemptId, /^[a-f0-9]{16}$/, "retry parent id");
  }
  const artifact = plain(value.artifact) ? value.artifact : {}, events = Array.isArray(value.events) ? value.events.filter(plain) : [];
  if (artifact.producerAttemptId != null) identity(artifact.producerAttemptId, /^[a-f0-9]{16}$/, "artifact producer id");
  if (artifact.commit !== undefined) identity(artifact.commit, /^[a-f0-9]{40}$/, "artifact commit");
  if (artifact.digest !== undefined) identity(artifact.digest, /^[a-f0-9]{64}$/, "artifact digest");
  if (events.length > 128) fail("visible events exceed their bound");
  for (const event of events) if (event.type === "retry.requested") {
    identity(event.childAttemptId, /^[a-f0-9]{16}$/, "retry child id"); identity(event.sourceAttemptId, /^[a-f0-9]{16}$/, "retry source id");
  }
  const first = resolve(dir), second = resolve(work);
  if (relative(first, second).split(/[\\/]/)[0] !== ".." || relative(second, first).split(/[\\/]/)[0] !== "..") fail("private directories overlap");
  freshDirectory(dir); freshDirectory(work);
  const created = init(dir, {question: "Synthetic producer metadata fixture", mode: "experiment"}, {actor});
  const nativeStudy = {...created.study, id: study.id};
  writeAtomic(join(dir, "study.json"), JSON.stringify(nativeStudy) + "\n", STUDY_BYTES);
  mkdirSync(join(dir, "task", "evaluator"), {recursive: true}); writeAtomic(join(dir, "task", "task.md"), "synthetic task", 1024);
  const seeds = [...new Set(visible.map(attempt => Number.isSafeInteger(attempt.seed) ? Number(attempt.seed) : 1))];
  const protocol = {...metricProtocol(), seeds}; await setProtocol(dir, protocol, {actor, http: offlineHttp});
  for (const fact of visible) {
    const record = metricAttempt(), id = String(fact.id), run = typeof fact.run === "string" ? fact.run : "investigate", recordPath = join(dir, "runs", run, "attempts", `${id}.json`);
    Object.assign(record, {id, studyId: study.id, commit: fact.commit, status: fact.status, seed: Number.isSafeInteger(fact.seed) ? fact.seed : 1, run,
      protocol, protocolHash: protocolHash(protocol), sealBinding: designBinding(dir)!, metrics: [], outputs: [], label: "synthetic metadata scaffolding", executor: {v: 1, kind: "local", workdir: work},
      paths: {snapshot: join(work, String(study.id), id, "snapshot"), output: join(work, String(study.id), id, "output"), evaluator: join(work, String(study.id), id, "evaluator"), result: join(work, String(study.id), id, "result")}});
    if (fact.status === "running") delete record.endedAt; else record.endedAt = "2030-01-01T00:00:01Z";
    if (typeof fact.parentAttemptId === "string" && events.some(event => event.type === "retry.requested" && event.childAttemptId === fact.id && event.sourceAttemptId === fact.parentAttemptId)) record.retryOf = fact.parentAttemptId;
    if (artifact.producerAttemptId === fact.id && typeof artifact.digest === "string") record.outputs = [{path: join(work, String(study.id), id, "output", "artifact.json"), sha256: artifact.digest, bytes: 0}];
    commit(dir, [[recordPath, JSON.stringify(record) + "\n", 1024 * 1024]], [
      {actor, type: "attempt.started", data: {id, run, commit: fact.commit, seed: record.seed}},
      {actor, type: `attempt.${String(fact.status)}`, data: {id, run, stage: record.stage, status: fact.status}},
    ]);
  }
}
