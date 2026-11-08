import { existsSync, lstatSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseLedger, plain, readBytesBounded, hashFileBounded, sha256, validateStudy, type LedgerEvent, type Study } from "./study.ts";
import { validateAttemptRecord, type Attempt } from "./exp/attempts.ts";
import { TASK_BYTES, TASK_FILES } from "./exp/protocol.ts";
import { validateExecutor } from "./exp/executor.ts";
import { foldIdeas } from "./exp/ideas.ts";
import { readClosedInvestigation } from "./exp/investigate.ts";
import { readClosedFinal } from "./exp/final.ts";
import { readClosedAblate } from "./exp/ablate.ts";
import { validatePlan } from "./plan/definition.ts";
import { canonical, foldPlan } from "./plan/state.ts";
import { readCurrentBuild } from "./paper/build.ts";
import { foldReviews } from "./paper/review.ts";
import { foldSkills } from "./memory/skills.ts";

export const PROVENANCE_NODE_LIMIT = 100, PROVENANCE_EDGE_LIMIT = 200, PROVENANCE_PAGE_BYTES = 256 * 1024;
export const PROVENANCE_SOURCE_FILES = 512, PROVENANCE_SOURCE_BYTES = 16 * 1024 * 1024, PROVENANCE_EVENTS = 5000, PROVENANCE_TRAVERSAL = 1000;
const KINDS = ["study", "plan-revision", "dispatch", "idea", "attempt", "artifact", "closed-result", "paper-evidence", "skill-proposal"] as const;
export type ProvenanceKind = typeof KINDS[number];
export interface ExecutionReferenceV1 { v: 1; tool: "ares"; projectKey: string; kind: ProvenanceKind; id: string; revision?: string; sha256?: string }
export type ProvenanceState = "current" | "historical" | "corrupt" | "unavailable" | "declared-unresolved";
export interface ProvenanceProof { file: string; sha256: string; ledgerIndex?: number; recordType?: string; nativeId?: string }
export interface ProvenanceNode { ref: ExecutionReferenceV1; state: ProvenanceState; availability: "available" | "receipt-only" | "missing" | "not-read"; proof: ProvenanceProof; data?: Record<string, string | number | boolean | null> }
export type ProvenanceRelation = "contains" | "retryOf" | "parent" | "cites-attempt" | "produced" | "dispatched" | "observed-in" | "expected-attempt" | "observed-attempt" | "observed-output" | "closed" | "reviewed" | "uses-attempt" | "names-idea" | "uses-closed-result" | "uses-source";
export interface ProvenanceEdge { from: ExecutionReferenceV1; to: ExecutionReferenceV1; relation: ProvenanceRelation; proof: ProvenanceProof }
export interface ProvenanceIssue { code: string; message: string; ref?: ExecutionReferenceV1 }
export interface ProvenancePage {
  v: 1; status: "ok" | "changed" | "unavailable" | "capped"; sourceSha256: string | null; ledgerPosition: number | null;
  nodes: ProvenanceNode[]; edges: ProvenanceEdge[]; issues: ProvenanceIssue[]; totals: { nodes: number; edges: number } | null; truncated: boolean; nextCursor?: string;
}
export interface ProvenanceOptions { cursor?: string; nodeLimit?: number; edgeLimit?: number; traversalLimit?: number }
const HASH = /^[a-f0-9]{64}$/, ATTEMPT = /^[a-f0-9]{16}$/, RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
class SourceFailure extends Error { constructor(readonly code: string, readonly capped = false) { super(code); } }
function fail(code: string, capped = false): never { throw new SourceFailure(code, capped); }
function text(value: unknown, bound: number): value is string { return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= bound; }
/** An address is never a path, URL, subprocess or hub resolver instruction. Native ids are preserved verbatim. */
export function validateExecutionReference(raw: unknown): ExecutionReferenceV1 {
  if (!plain(raw) || Object.keys(raw).some(key => !["v", "tool", "projectKey", "kind", "id", "revision", "sha256"].includes(key)) || raw.v !== 1 || raw.tool !== "ares" || !KINDS.includes(raw.kind as ProvenanceKind) || !text(raw.projectKey, 256) || !text(raw.id, 256) || raw.revision !== undefined && !text(raw.revision, 128) || raw.sha256 !== undefined && (typeof raw.sha256 !== "string" || !HASH.test(raw.sha256))) throw new Error("provenance reference: unsupported shape or identifier bound; use an ares ExecutionReferenceV1 with native ids <=256 bytes, revision <=128 bytes and a lowercase 64-hex sha256");
  return { v: 1, tool: "ares", projectKey: raw.projectKey, kind: raw.kind as ProvenanceKind, id: raw.id, ...(raw.revision !== undefined ? { revision: raw.revision as string } : {}), ...(raw.sha256 !== undefined ? { sha256: raw.sha256 as string } : {}) };
}
interface SourceFile { bytes: Buffer; sha256: string }
interface Snapshot { files: Map<string, SourceFile>; study: Study; events: LedgerEvent[]; hash: string; ledgerPosition: number }
function decode(bytes: Uint8Array): string { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("malformed-source"); } }
function parsed(file: SourceFile): unknown { try { return JSON.parse(decode(file.bytes)); } catch (error) { if (error instanceof SourceFailure) throw error; return fail("malformed-source"); } }
function capture(dir: string): Snapshot {
  if (existsSync(join(dir, ".ares.lock"))) fail("write-in-progress");
  const files = new Map<string, SourceFile>(), directories: string[] = []; let total = 0, entries = 0;
  const forbidden: string[] = [];
  const safe = (name: string) => { if (forbidden.some(prefix => !prefix || name === prefix || name.startsWith(prefix + "/"))) fail("executor-overlaps-source"); };
  const exclude = (name: string, file: SourceFile) => {
    if (name !== "executor.json" && !/\/attempts\//.test(name)) return;
    const raw = parsed(file); if (!plain(raw)) return;
    if (name === "executor.json" && raw.v !== 1) fail("unsupported-version");
    if (name !== "executor.json" && (Object.hasOwn(raw, "executor") && !plain(raw.executor) || Object.hasOwn(raw, "paths") && !plain(raw.paths))) fail("malformed-execution-path");
    const executor = name === "executor.json" ? raw : plain(raw.executor) ? raw.executor : {}, paths = name !== "executor.json" && plain(raw.paths) ? raw.paths : {};
    const evidencePaths: unknown[] = [];
    const outputPaths = (rows: unknown) => { if (Array.isArray(rows)) for (const row of rows) if (plain(row) && Object.hasOwn(row, "path")) evidencePaths.push(row.path); };
    outputPaths(raw.outputs);
    if (plain(raw.stages)) for (const stage of Object.values(raw.stages)) if (plain(stage) && plain(stage.evidence)) {
      outputPaths(stage.evidence.outputs);
      if (plain(stage.evidence.logs)) for (const log of Object.values(stage.evidence.logs)) if (plain(log) && Object.hasOwn(log, "path")) evidencePaths.push(log.path);
    }
    // Validate host paths, including evaluator inputs; container mount targets/argv are not host locations.
    for (const location of [...(Object.hasOwn(executor, "workdir") ? [executor.workdir] : []), ...Object.values(paths), ...evidencePaths]) if (typeof location !== "string" || !isAbsolute(location) || location.includes("\0")) fail("malformed-execution-path");
    if (name === "executor.json") { try { validateExecutor(raw); } catch { fail("malformed-executor"); } }
    for (const location of [executor.workdir, paths.snapshot, paths.output, paths.result, ...evidencePaths]) if (typeof location === "string") {
      let address = resolve(location); try { address = realpathSync(address); } catch { /* An absent output location has no readable tree. */ }
      const inside = relative(dir, address); if (inside === "" || inside !== ".." && !inside.startsWith(".." + sep)) forbidden.push(inside.split(sep).join("/"));
    }
    // Reject overlapping metadata too, including locations learned from a later record.
    for (const captured of files.keys()) safe(captured);
  };
  const get = (name: string, bound: number): SourceFile | undefined => {
    safe(name);
    const parts = name.split("/"); let absolute = dir;
    for (const [index, part] of parts.entries()) {
      absolute = join(absolute, part); let stat;
      try { stat = lstatSync(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return fail("unreadable-source"); }
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) || (index === parts.length - 1 && !stat.isFile())) fail("non-regular-source");
      if (index === parts.length - 1 && (stat.size > bound || stat.size > PROVENANCE_SOURCE_BYTES - total || files.size >= PROVENANCE_SOURCE_FILES)) fail("source-traversal-capped", true);
    }
    let bytes: Buffer; try { bytes = readBytesBounded(absolute, Math.min(bound, PROVENANCE_SOURCE_BYTES - total), { noFollow: true }); } catch { return fail("unreadable-source"); }
    total += bytes.length; const file = { bytes, sha256: sha256(bytes) }; files.set(name, file); exclude(name, file); return file;
  };
  const names = (name: string): string[] => {
    safe(name);
    let stat; try { stat = lstatSync(join(dir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; return fail("unreadable-source"); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("non-regular-source");
    directories.push(name); const directory = opendirSync(join(dir, name)), result: string[] = [];
    try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) { if (++entries > PROVENANCE_SOURCE_FILES * 4) fail("source-traversal-capped", true); result.push(entry.name); } }
    finally { directory.closeSync(); }
    return result.sort();
  };
  // Learn output exclusions from native metadata before opening any other source content.
  get("executor.json", 65_536);
  const runs = names("runs");
  for (const run of runs) {
    if (!RUN.test(run)) fail("malformed-attempt-store");
    for (const entry of names(`runs/${run}/attempts`)) { if (!/^[a-f0-9]{16}\.json$/.test(entry)) fail("malformed-attempt-store"); get(`runs/${run}/attempts/${entry}`, 1_048_576); }
  }
  const studyFile = get("study.json", 65_536); if (!studyFile) fail("missing-study");
  let study: Study; try { study = validateStudy(parsed(studyFile)); } catch (error) { if (error instanceof Error && error.message.includes("unsupported")) return fail("unsupported-version"); return fail("malformed-study"); }
  const ledger = get("ledger.jsonl", 64 * 1024 * 1024); if (!ledger) fail("missing-ledger");
  let events: LedgerEvent[]; try { events = parseLedger(decode(ledger.bytes)); } catch (error) { if (error instanceof Error && error.message.includes("unsupported")) return fail("unsupported-ledger"); return fail("malformed-ledger"); }
  if (events.length > PROVENANCE_EVENTS || events.filter(event => event.type === "plan.set").length > 64) fail("ledger-traversal-capped", true);
  for (const name of ["plan.json", "hypotheses.md", "design/protocol.json", "design/selection.json", "design/final.json", "literature/candidates.json"]) get(name, name === "hypotheses.md" ? 2 * 1024 * 1024 : name.startsWith("literature/") ? 8 * 1024 * 1024 : 65_536);
  for (const name of ["plan.json", "design/protocol.json", "design/selection.json", "design/final.json"]) {
    const file = files.get(name); if (file) { const raw = parsed(file); if (!plain(raw)) fail("malformed-source"); if (raw.v !== 1) fail("unsupported-version"); }
  }
  for (const run of runs) for (const name of ["investigate.json", ...(run === "ablate" ? ["ablate.json"] : []), ...(run === "final" ? ["final.json"] : [])]) get(`runs/${run}/${name}`, 1_048_576);
  const taskHashes: [string, string][] = []; let taskBytes = 0, taskDirectories = 0;
  const task = (name: string, depth: number) => {
    safe(name); if (depth > 64 || ++taskDirectories > 1000) fail("task-traversal-capped", true);
    const stat = lstatSync(join(dir, name)); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("non-regular-source");
    directories.push(name); const directory = opendirSync(join(dir, name));
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        const child = `${name}/${entry.name}`; safe(child); const stat = lstatSync(join(dir, child));
        if (stat.isSymbolicLink()) fail("non-regular-source");
        if (stat.isDirectory()) task(child, depth + 1);
        else {
          if (!stat.isFile()) fail("non-regular-source");
          if (taskHashes.length >= TASK_FILES || stat.size > TASK_BYTES - taskBytes) fail("task-traversal-capped", true);
          let result; try { result = hashFileBounded(join(dir, child), TASK_BYTES - taskBytes, { noFollow: true }); } catch { return fail("unreadable-source"); }
          taskBytes += result.bytes; taskHashes.push([child, result.sha256]);
        }
      }
    } finally { directory.closeSync(); }
  };
  if (existsSync(join(dir, "task"))) task("task", 0);
  for (const name of ["paper/manuscript.md", "paper/build/manuscript.md", "paper/build/evidence.json"]) { safe(name); get(name, name.endsWith("evidence.json") ? 8 * 1024 * 1024 : 2 * 1024 * 1024); }
  for (const event of events) if (event.type === "skill.proposed" && plain(event.data.proposal) && typeof event.data.proposal.name === "string" && RUN.test(event.data.proposal.name)) get(`proposals/skills/${event.data.proposal.name}.md`, 16_384);
  if (existsSync(join(dir, ".ares.lock"))) fail("write-in-progress");
  return { files, study, events, ledgerPosition: ledger.bytes.length, hash: sha256(canonical({ directories: directories.sort(), files: [...taskHashes, ...[...files].map(([name, file]) => [name, file.sha256])].sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)) })) };
}
class TraversalCap extends Error {}
const key = (ref: ExecutionReferenceV1) => canonical(ref);
class Graph {
  nodes = new Map<string, ProvenanceNode>(); edges = new Map<string, ProvenanceEdge>(); issues: ProvenanceIssue[] = []; capped = false; work = 0;
  constructor(readonly source: Snapshot, readonly limit: number) {}
  touch() { if (++this.work > this.limit * 16) throw new TraversalCap(); }
  ref(kind: ProvenanceKind, id: string, extra: { revision?: string; sha256?: string } = {}) { this.touch(); return validateExecutionReference({ v: 1, tool: "ares", projectKey: this.source.study.id, kind, id, ...extra }); }
  proof(file: string, index?: number, nativeId?: string): ProvenanceProof { const source = this.source.files.get(file); if (!source) fail("missing-source-proof"); return { file, sha256: source.sha256, ...(index !== undefined ? { ledgerIndex: index, recordType: this.source.events[index]!.type } : {}), ...(nativeId !== undefined ? { nativeId } : {}) }; }
  issue(code: string, ref?: ExecutionReferenceV1) {
    const next = code.startsWith("unsupported") ? "use a compatible ares version, keeping all original bytes unchanged, then retry" : code === "historical-not-current" ? "inspect the historical receipt; use its existing close/build producer only if a current artifact is needed, then retry" : "restore the corresponding valid original record, then retry the read";
    if (this.issues.length < 64) this.issues.push({ code, message: `provenance ${code}; ${next}`, ...(ref ? { ref } : {}) });
  }
  put(node: ProvenanceNode) { const id = key(node.ref); if (!this.nodes.has(id)) { if (this.nodes.size >= this.limit) throw new TraversalCap(); } this.nodes.set(id, node); return node.ref; }
  edge(from: ExecutionReferenceV1, to: ExecutionReferenceV1, relation: ProvenanceRelation, proof: ProvenanceProof) { this.touch(); if (this.edges.size >= this.limit * 4) throw new TraversalCap(); const edge = { from, to, relation, proof }; this.edges.set(canonical(edge), edge); }
  target(kind: ProvenanceKind, id: string, proof: ProvenanceProof, extra: { revision?: string; sha256?: string } = {}) {
    const ref = this.ref(kind, id, extra); if (!this.nodes.has(key(ref))) { this.put({ ref, state: "unavailable", availability: "missing", proof }); this.issue("missing-referenced-record", ref); } return ref;
  }
}
function fileJson(source: Snapshot, file: string): Record<string, unknown> | undefined { const value = source.files.get(file); if (!value) return undefined; const raw = parsed(value); if (!plain(raw)) fail("malformed-source"); return raw; }
function build(dir: string, source: Snapshot, limit: number): Graph {
  const graph = new Graph(source, limit), study = graph.ref("study", source.study.id), ledger = "ledger.jsonl";
  graph.put({ ref: study, state: "current", availability: "available", proof: graph.proof("study.json"), data: { mode: source.study.mode } });
  const owned = (ref: ExecutionReferenceV1, proof: ProvenanceProof) => graph.edge(study, ref, "contains", proof);
  const events = source.events;
  const addedIdeas = new Map<string, number>(), decisions = new Map<string, number[]>(), latestAttempts = new Map<string, LedgerEvent>(), attemptReceipts = new Map<string, { index: number; event: LedgerEvent }>(), starts = new Map<string, LedgerEvent[]>(), reviewIndexes = new Map<string, number>(), skillIndexes = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    if (event.type.startsWith("attempt.")) {
      if (typeof event.data.id !== "string" || !ATTEMPT.test(event.data.id)) graph.issue("malformed-attempt-receipt");
      else if (!attemptReceipts.has(event.data.id)) attemptReceipts.set(event.data.id, { index, event });
    }
    if (event.type === "attempt.started" && typeof event.data.id === "string") starts.set(event.data.id, [...(starts.get(event.data.id) ?? []), event]);
    if (event.type.startsWith("attempt.") && typeof event.data.id === "string" && typeof event.data.status === "string") latestAttempts.set(event.data.id, event);
    if (event.type === "idea.added" && plain(event.data.idea) && typeof event.data.idea.id === "string") addedIdeas.set(event.data.idea.id, index);
    if (event.type === "idea.decided" && typeof event.data.id === "string") decisions.set(event.data.id, [...(decisions.get(event.data.id) ?? []), index]);
    if (event.type === "review.added" && typeof event.data.id === "string") reviewIndexes.set(event.data.id, index);
    if (event.type === "skill.proposed" && plain(event.data.proposal) && typeof event.data.proposal.name === "string") skillIndexes.set(event.data.proposal.name, index);
  }
  const attempts = new Map<string, { value: Attempt; file: string; ref: ExecutionReferenceV1 }>(), attemptCounts = new Map<string, number>();
  for (const file of source.files.keys()) { const id = /^runs\/[^/]+\/attempts\/([a-f0-9]{16})\.json$/.exec(file)?.[1]; if (id) attemptCounts.set(id, (attemptCounts.get(id) ?? 0) + 1); }
  try {
    for (const [file, bytes] of source.files) {
      const path = /^runs\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/attempts\/([a-f0-9]{16})\.json$/.exec(file); if (!path) continue;
      const raw = parsed(bytes); let value: Attempt;
      try { value = validateAttemptRecord(raw, path[1]!, path[2]!); } catch (error) { graph.issue(error instanceof Error && error.message.includes("unsupported") ? "unsupported-attempt" : "corrupt-attempt"); continue; }
      const ref = graph.ref("attempt", value.id), proof = graph.proof(file);
      if (!attempts.has(value.id)) attempts.set(value.id, { value, file, ref });
      const latest = latestAttempts.get(value.id);
      const start = starts.get(value.id) ?? [];
      const identity = value.studyId !== source.study.id || typeof value.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.commit) || !Number.isSafeInteger(value.seed);
      const retryInvalid = value.retryOf !== undefined && (typeof value.retryOf !== "string" || !ATTEMPT.test(value.retryOf) || value.retryOf === value.id);
      const outputsInvalid = !Array.isArray(value.outputs) || value.outputs.length > 500 || value.outputs.some(output => !plain(output) || typeof output.sha256 !== "string" || !HASH.test(output.sha256) || !Number.isSafeInteger(output.bytes) || output.bytes < 0);
      const issue = (attemptCounts.get(value.id) ?? 0) > 1 ? "duplicate-attempt-id" : retryInvalid ? "corrupt-retry-reference" : outputsInvalid ? "corrupt-output-inventory" : identity ? "attempt-study-identity-mismatch" : start.length === 0 ? "missing-attempt-start-receipt" : start.length > 1 ? "duplicate-attempt-start-receipt" : start[0]!.data.run !== value.run || start[0]!.data.commit !== value.commit || start[0]!.data.seed !== value.seed ? "attempt-start-identity-mismatch" : latest?.data.status !== undefined && latest.data.status !== value.status ? "attempt-receipt-mismatch" : undefined;
      graph.put({ ref, state: issue ? "corrupt" : "current", availability: "available", proof, data: { status: value.status, stage: value.stage, seed: Number.isSafeInteger(value.seed) ? value.seed : null } });
      if (value.studyId === source.study.id) owned(ref, proof);
      if (issue) graph.issue(issue, ref);
    }
    for (const [id, receipt] of attemptReceipts) if (!attemptCounts.has(id)) {
      const ref = graph.ref("attempt", id), proof = graph.proof(ledger, receipt.index, id);
      graph.put({ ref, state: "unavailable", availability: "missing", proof }); owned(ref, proof); graph.issue("missing-attempt-record", ref);
    }
    for (const { value, file, ref } of attempts.values()) {
      if (graph.nodes.get(key(ref))?.state !== "current") continue;
      const proof = graph.proof(file);
      if (value.retryOf !== undefined) graph.edge(ref, graph.target("attempt", value.retryOf, proof), "retryOf", proof);
      for (const output of value.outputs) { graph.touch();
        const artifact = graph.ref("artifact", output.sha256, { sha256: output.sha256 });
        graph.put({ ref: artifact, state: "current", availability: "not-read", proof, data: { bytes: output.bytes, bodyRead: false } }); graph.edge(ref, artifact, "produced", proof);
      }
    }
    const ideas = foldIdeas(events);
    for (const idea of ideas) { const index = addedIdeas.get(idea.id)!, proof = graph.proof(ledger, index, idea.id), ref = graph.ref("idea", idea.id); graph.put({ ref, state: "current", availability: "available", proof, data: { status: idea.state } }); owned(ref, proof); }
    for (const idea of ideas) {
      const ref = graph.ref("idea", idea.id), index = addedIdeas.get(idea.id)!, proof = graph.proof(ledger, index, idea.id);
      if (idea.parent) graph.edge(ref, graph.target("idea", idea.parent, proof), "parent", proof);
      for (const eventIndex of decisions.get(idea.id) ?? []) {
        const event = events[eventIndex]!;
        if (Array.isArray(event.data.attempts)) for (const id of event.data.attempts) { graph.touch(); if (typeof id === "string" && ATTEMPT.test(id)) { const cited = graph.proof(ledger, eventIndex, idea.id); graph.edge(ref, graph.target("attempt", id, cited), "cites-attempt", cited); } }
      }
    }
    const applied = new Map<LedgerEvent, { output?: unknown; status: string; taskId?: number; hubProject?: string }>();
    const plan = foldPlan(events, (state, event) => {
      if (!["node.intent", "node.observed"].includes(event.type)) return;
      const node = state.nodes.find(value => value.id === event.data.node);
      if (node && node.dispatchId === event.data.dispatchId) applied.set(event, { output: event.type === "node.observed" ? node.lastObserved?.output : undefined, status: node.status, taskId: node.taskId, hubProject: node.hubProject });
    }), revisions = new Set<number>(), definitions = new Map<number, ReturnType<typeof validatePlan>>();
    const planFile = fileJson(source, "plan.json");
    if (plan && (!planFile || canonical(validatePlan(planFile)) !== canonical(plan.definition))) graph.issue("plan-receipt-mismatch");
    if (planFile && !plan) graph.issue("missing-plan-receipt");
    for (const [index, event] of events.entries()) if (event.type === "plan.set" && Number.isSafeInteger(event.data.revision)) {
      const revision = Number(event.data.revision), definition = validatePlan(event.data.definition); definitions.set(revision, definition); revisions.add(revision); const proof = graph.proof(ledger, index), ref = graph.ref("plan-revision", String(revision), { revision: String(revision) }); graph.put({ ref, state: revision === plan?.revision ? "current" : "historical", availability: "available", proof, ...(definition.nodes.some(node => node.kind === "hub") ? { data: { hubState: "declared-unresolved" } } : {}) }); owned(ref, proof);
    }
    const latestApplied = new Map<string, { output?: unknown; status: string; taskId?: number; hubProject?: string }>();
    for (const [event, value] of applied) if (typeof event.data.dispatchId === "string") latestApplied.set(event.data.dispatchId, value);
    const dispatches = new Map<string, ExecutionReferenceV1>(), dispatchCommands = new Map<string, string>();
    for (const [index, event] of events.entries()) if (event.type === "node.intent" && applied.has(event) && typeof event.data.dispatchId === "string" && Number.isSafeInteger(event.data.revision)) {
      const revision = Number(event.data.revision), proof = graph.proof(ledger, index), ref = graph.ref("dispatch", event.data.dispatchId);
      dispatches.set(event.data.dispatchId, ref);
      const definition = definitions.get(revision)?.nodes.find(node => node.id === event.data.node);
      if (definition?.kind === "step") dispatchCommands.set(event.data.dispatchId, definition.command);
      const latest = latestApplied.get(event.data.dispatchId)!, current = plan?.nodes.find(node => node.dispatchId === event.data.dispatchId), data: NonNullable<ProvenanceNode["data"]> = { status: latest.status, nodeId: text(event.data.node, 256) ? event.data.node : null };
      if (Number.isSafeInteger(latest.taskId) && Number(latest.taskId) > 0) { data.hubTaskId = Number(latest.taskId); data.hubState = "declared-unresolved"; if (text(latest.hubProject, 256)) data.hubProject = latest.hubProject; }
      if (definition?.kind === "hub") data.hubState = "declared-unresolved";
      graph.put({ ref, state: current ? "current" : "historical", availability: "available", proof, data });
      if (revisions.has(revision)) graph.edge(graph.ref("plan-revision", String(revision), { revision: String(revision) }), ref, "dispatched", proof);
      if (typeof event.data.attemptId === "string" && ATTEMPT.test(event.data.attemptId)) graph.edge(ref, graph.target("attempt", event.data.attemptId, proof), "expected-attempt", proof);
    }
    for (const [index, event] of events.entries()) if (event.type === "node.observed" && applied.has(event) && typeof event.data.dispatchId === "string" && dispatches.has(event.data.dispatchId)) {
      const ref = dispatches.get(event.data.dispatchId)!, proof = graph.proof(ledger, index), output = applied.get(event)?.output;
      if (Number.isSafeInteger(event.data.revision) && revisions.has(Number(event.data.revision))) graph.edge(ref, graph.ref("plan-revision", String(event.data.revision), { revision: String(event.data.revision) }), "observed-in", proof);
      if (plain(output) && typeof output.attemptId === "string" && ATTEMPT.test(output.attemptId)) graph.edge(ref, graph.target("attempt", output.attemptId, proof), "observed-attempt", proof);
    }
    // Results and evidence are represented by close/build receipts, never recomputed show values.
    closures(dir, graph, study);
    const digestNodes = new Map<string, ExecutionReferenceV1[]>();
    for (const node of graph.nodes.values()) if (node.ref.sha256) digestNodes.set(node.ref.sha256, [...(digestNodes.get(node.ref.sha256) ?? []), node.ref]);
    for (const [index, event] of events.entries()) if (event.type === "node.observed" && applied.has(event) && typeof event.data.dispatchId === "string") {
      const command = dispatchCommands.get(event.data.dispatchId), output = applied.get(event)?.output, from = dispatches.get(event.data.dispatchId);
      if (!from || !plain(output) || typeof output.sha256 !== "string" || !HASH.test(output.sha256) || !["paper.build", "investigate.close", "ablate.close", "final.close"].includes(command ?? "")) continue;
      const target = digestNodes.get(output.sha256)?.find(ref => ref.kind === (command === "paper.build" ? "paper-evidence" : "closed-result") && graph.nodes.get(key(ref))?.data?.family === command!.split(".")[0]);
      if (target) graph.edge(from, target, "observed-output", graph.proof(ledger, index)); else graph.issue("unresolved-dispatch-output", from);
    }
    for (const review of foldReviews(events)) {
      const index = reviewIndexes.get(review.id)!, proof = graph.proof(ledger, index, review.id), hash = review.report.buildSha256;
      graph.edge(study, graph.target("paper-evidence", hash, proof, { sha256: hash }), "reviewed", proof);
    }
    for (const skill of foldSkills(events)) {
      const index = skillIndexes.get(skill.name)!, proof = graph.proof(ledger, index, skill.name), ref = graph.ref("skill-proposal", skill.name, { sha256: skill.sha256 }), file = source.files.get(`proposals/skills/${skill.name}.md`);
      const state = !file ? "unavailable" : file.sha256 !== skill.sha256 ? "corrupt" : "current";
      const unresolved = skill.evidence.some(value => !value.startsWith(`ares:${source.study.id}/attempt:`));
      graph.put({ ref, state, availability: file ? "available" : "missing", proof, data: { status: skill.state, ...(unresolved ? { additionalEvidence: "declared-unresolved" } : {}) } }); owned(ref, proof); if (state !== "current") graph.issue(state === "corrupt" ? "proposal-receipt-mismatch" : "missing-proposal", ref);
      for (const evidence of skill.evidence) {
        const prefix = `ares:${source.study.id}/attempt:`, id = evidence.startsWith(prefix) ? evidence.slice(prefix.length) : undefined;
        if (id && ATTEMPT.test(id)) graph.edge(ref, graph.target("attempt", id, proof), "cites-attempt", proof);
      }
    }
  } catch (error) { if (error instanceof TraversalCap) graph.capped = true; else if (error instanceof SourceFailure) graph.issue(error.code); else graph.issue(error instanceof Error && error.message.includes("unsupported") ? "unsupported-source" : "corrupt-provenance"); }
  return graph;
}
interface Closure { ref: ExecutionReferenceV1; file: string; hash: string; proof: ProvenanceProof; family: string; latest: boolean; raw?: Record<string, unknown> }
function closures(dir: string, graph: Graph, study: ExecutionReferenceV1): void {
  const source = graph.source, records: Closure[] = [], latest = new Map<string, number>();
  const selected = fileJson(source, "design/selection.json")?.run;
  for (const [index, event] of source.events.entries()) {
    const family = event.type === "investigate.closed" ? "investigate" : event.type === "ablate.closed" ? "ablate" : event.type === "final.closed" ? "final" : event.type === "paper.built" ? "paper" : undefined;
    if (!family) continue;
    const run = family === "investigate" ? event.data.run : family;
    const hash = family === "paper" ? event.data.evidenceSha256 : event.data.sha256;
    if (typeof run !== "string" || !RUN.test(run) || typeof hash !== "string" || !HASH.test(hash)) { graph.issue("malformed-close-receipt"); continue; }
    latest.set(`${family}:${run}`, index);
    records.push({ family, hash, file: family === "paper" ? "paper/build/evidence.json" : `runs/${run}/${family}.json`, ref: graph.ref(family === "paper" ? "paper-evidence" : "closed-result", family === "paper" ? hash : run, { sha256: hash }), proof: graph.proof("ledger.jsonl", index), latest: false });
  }
  for (const file of source.files.keys()) if ((/^runs\/[^/]+\/(investigate|ablate|final)\.json$/.test(file) || file === "paper/build/evidence.json") && !records.some(record => record.file === file)) graph.issue("unreceipted-closed-artifact");
  for (const record of records) {
    record.latest = latest.get(`${record.family}:${record.ref.kind === "paper-evidence" ? "paper" : record.ref.id}`) === record.proof.ledgerIndex;
    const file = source.files.get(record.file), matches = file?.sha256 === record.hash;
    let state: ProvenanceState = record.latest ? "current" : "historical", availability: ProvenanceNode["availability"] = matches ? "available" : record.latest ? "missing" : "receipt-only";
    if (record.latest && !file) { state = "unavailable"; graph.issue("missing-closed-artifact", record.ref); }
    else if (record.latest && !matches) { state = "corrupt"; availability = "available"; graph.issue("close-receipt-mismatch", record.ref); }
    if (matches) {
      try {
        record.raw = fileJson(source, record.file);
        if (!record.raw || record.raw.v !== 1) { state = "unavailable"; graph.issue("unsupported-closed-version", record.ref); }
        else if (record.family === "paper" ? !Array.isArray(record.raw.placeholders) || typeof record.raw.manuscriptSha256 !== "string" : typeof record.raw.inputsSha256 !== "string" || record.family === "final" && !["qualified", "not_qualified"].includes(String(record.raw.status))) { state = "corrupt"; graph.issue("malformed-closed-artifact", record.ref); }
        else if (record.latest && !(record.family === "investigate" && record.ref.id !== selected)) {
          try {
            const hash = record.family === "paper" ? readCurrentBuild(dir).evidenceSha256 : record.family === "investigate" ? readClosedInvestigation(dir).sha256 : record.family === "ablate" ? readClosedAblate(dir).sha256 : readClosedFinal(dir).sha256;
            if (hash !== record.hash) { state = "unavailable"; graph.issue("closed-source-changed", record.ref); }
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            state = /stale|current|gate|copilot|fresh/.test(message) ? "historical" : "unavailable";
            graph.issue(/unsupported/.test(message) ? "unsupported-source" : state === "historical" ? "historical-not-current" : "closed-source-unavailable", record.ref);
          }
        } else if (record.family === "investigate" && record.ref.id !== selected) state = "historical";
      } catch { state = "corrupt"; graph.issue("malformed-closed-artifact", record.ref); }
    }
    graph.put({ ref: record.ref, state, availability, proof: record.proof, data: { family: record.family, receiptMatched: matches, ...(record.family === "final" && typeof record.raw?.status === "string" ? { status: record.raw.status } : {}) } });
    graph.edge(study, record.ref, "closed", record.proof);
  }
  for (const record of records) {
    if (!record.raw || source.files.get(record.file)?.sha256 !== record.hash || record.raw.v !== 1 || graph.nodes.get(key(record.ref))?.state === "corrupt") continue;
    const raw = record.raw, proof = graph.proof(record.file);
    const attempt = (id: unknown) => { graph.touch(); if (typeof id === "string" && ATTEMPT.test(id)) graph.edge(record.ref, graph.target("attempt", id, proof), "uses-attempt", proof); };
    const statuses = (value: unknown) => {
      if (Array.isArray(value)) { if (value.length > graph.limit * 8) throw new TraversalCap(); for (const row of value) { graph.touch(); if (plain(row)) attempt(row.id); else attempt(row); } }
      else if (plain(value)) for (const status of ["running", "succeeded", "failed", "cancelled", "unknown"]) if (Array.isArray(value[status])) for (const id of value[status]) attempt(id);
    };
    if (record.family === "investigate") {
      if (plain(raw.baseline)) statuses(raw.baseline.attempts);
      if (Array.isArray(raw.candidates)) for (const candidate of raw.candidates) { graph.touch(); if (plain(candidate)) statuses(candidate.attempts); }
      if (plain(raw.winner) && typeof raw.winner.idea === "string") graph.edge(record.ref, graph.target("idea", raw.winner.idea, proof), "names-idea", proof);
    } else if (record.family === "ablate") {
      if (plain(raw.reference)) statuses(raw.reference.attempts);
      if (Array.isArray(raw.ablations)) for (const ablation of raw.ablations) { graph.touch(); if (plain(ablation)) statuses(ablation.attempts); }
    } else if (record.family === "final") statuses(raw.attempts);
    if (Array.isArray(raw.excluded)) for (const row of raw.excluded) { graph.touch(); if (plain(row)) attempt(row.id); }
    for (const name of ["investigateSha256", "ablateSha256"]) if (typeof raw[name] === "string") { const linked = records.find(value => value.hash === raw[name] && value.family === (name === "investigateSha256" ? "investigate" : "ablate")); if (linked) graph.edge(record.ref, linked.ref, "uses-closed-result", proof); }
    if (record.family === "paper" && Array.isArray(raw.placeholders)) for (const placeholder of raw.placeholders) { graph.touch();
      if (!plain(placeholder) || !plain(placeholder.source) || typeof placeholder.source.sha256 !== "string" || typeof placeholder.source.file !== "string") continue;
      const hash = placeholder.source.sha256, file = placeholder.source.file;
      const closed = records.find(value => value.hash === hash && value.file === file);
      if (closed) graph.edge(record.ref, closed.ref, "uses-source", proof);
      else {
        const id = /^runs\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/attempts\/([a-f0-9]{16})\.json$/.exec(file)?.[1];
        if (id && source.files.get(file)?.sha256 === hash) graph.edge(record.ref, graph.target("attempt", id, proof), "uses-source", proof);
      }
    }
  }
}
interface Cursor { v: 1; source: string; ledgerPosition: number; nodes: number; edges: number; options: string }
function cursor(value: Cursor): string { const text = JSON.stringify(value); return Buffer.from(text).toString("base64url") + "." + sha256(text); }
function continuation(value: string): Cursor | undefined {
  try {
    if (Buffer.byteLength(value) > 4096 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value)) return undefined;
    const [encoded, hash] = value.split("."), decoded = Buffer.from(encoded!, "base64url").toString("utf8"); if (sha256(decoded) !== hash) return undefined;
    const raw: unknown = JSON.parse(decoded);
    if (!plain(raw) || Object.keys(raw).some(key => !["v", "source", "ledgerPosition", "nodes", "edges", "options"].includes(key)) || raw.v !== 1 || typeof raw.source !== "string" || !HASH.test(raw.source) || typeof raw.options !== "string" || ![raw.ledgerPosition, raw.nodes, raw.edges].every(value => Number.isSafeInteger(value) && Number(value) >= 0)) return undefined;
    return raw as unknown as Cursor;
  } catch { return undefined; }
}
function empty(status: ProvenancePage["status"], code: string, source?: Snapshot): ProvenancePage {
  return { v: 1, status, sourceSha256: source?.hash ?? null, ledgerPosition: source?.ledgerPosition ?? null, nodes: [], edges: [], issues: [{ code, message: status === "capped" ? `provenance ${code}; use bounded producer reads such as ares attempt list/show or plan show; this graph is incomplete` : `provenance ${code}; keep unsupported source bytes unchanged, restore malformed originals or retry after the active command completes; restart pagination from the first page` }], totals: null, truncated: status === "capped" };
}
/** Lock-free, local, in-process projection. Source readers never repair files or read the executor/hub. */
export function readProvenance(dirArg: string, options: ProvenanceOptions = {}): ProvenancePage {
  if (!plain(options as unknown) || Object.keys(options).some(name => !["cursor", "nodeLimit", "edgeLimit", "traversalLimit"].includes(name)) || Object.hasOwn(options, "cursor") && typeof options.cursor !== "string") throw new Error("provenance options: use only cursor (string), nodeLimit, edgeLimit and traversalLimit; correct the options before retrying");
  const nodeLimit = options.nodeLimit ?? PROVENANCE_NODE_LIMIT, edgeLimit = options.edgeLimit ?? PROVENANCE_EDGE_LIMIT, traversal = options.traversalLimit ?? PROVENANCE_TRAVERSAL;
  if (!Number.isSafeInteger(nodeLimit) || nodeLimit < 1 || nodeLimit > PROVENANCE_NODE_LIMIT || !Number.isSafeInteger(edgeLimit) || edgeLimit < 1 || edgeLimit > PROVENANCE_EDGE_LIMIT || !Number.isSafeInteger(traversal) || traversal < 1 || traversal > PROVENANCE_TRAVERSAL) throw new Error("provenance page bounds: use 1..100 nodes, 1..200 edges and traversal 1..1000 before retrying");
  let source: Snapshot, dir: string;
  try { dir = realpathSync(resolve(dirArg)); source = capture(dir); }
  catch (error) { const code = error instanceof SourceFailure ? error.code : "unreadable-source"; return empty(error instanceof SourceFailure && error.capped ? "capped" : code === "write-in-progress" ? "changed" : "unavailable", code); }
  const configuration = canonical([nodeLimit, edgeLimit, traversal]), previous = options.cursor === undefined ? undefined : continuation(options.cursor);
  if (options.cursor !== undefined && (!previous || previous.source !== source.hash || previous.ledgerPosition !== source.ledgerPosition || previous.options !== configuration)) return empty("changed", "changed-cursor", source);
  let graph: Graph;
  try { graph = build(dir, source, traversal); } catch { return empty("unavailable", "invalid-source-reference", source); }
  try { const after = capture(dir); if (after.hash !== source.hash || after.ledgerPosition !== source.ledgerPosition) return empty("changed", "source-changed", source); }
  catch { return empty("changed", "source-changed-or-unavailable", source); }
  const nodes = [...graph.nodes.values()].sort((a, b) => (key(a.ref) < key(b.ref) ? -1 : key(a.ref) > key(b.ref) ? 1 : 0)), edges = [...graph.edges.values()].sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
  const n = previous?.nodes ?? 0, e = previous?.edges ?? 0;
  if (n > nodes.length || e > edges.length) return empty("changed", "changed-cursor", source);
  const page: ProvenancePage = { v: 1, status: graph.capped ? "capped" : graph.issues.length ? "unavailable" : "ok", sourceSha256: source.hash, ledgerPosition: source.ledgerPosition, nodes: nodes.slice(n, n + nodeLimit), edges: edges.slice(e, e + edgeLimit), issues: graph.issues, totals: graph.capped || graph.issues.length ? null : { nodes: nodes.length, edges: edges.length }, truncated: graph.capped };
  const next = () => {
    const more = n + page.nodes.length < nodes.length || e + page.edges.length < edges.length;
    page.truncated = graph.capped || more;
    if (more) page.nextCursor = cursor({ v: 1, source: source.hash, ledgerPosition: source.ledgerPosition, nodes: n + page.nodes.length, edges: e + page.edges.length, options: configuration }); else delete page.nextCursor;
  };
  if (graph.capped) page.issues = [...page.issues, { code: "traversal-capped", message: "provenance traversal capped; use bounded producer reads such as ares attempt list/show or plan show instead of treating this as a complete graph" }];
  next();
  while (Buffer.byteLength(JSON.stringify(page)) > PROVENANCE_PAGE_BYTES) {
    if (page.edges.length) page.edges.pop(); else if (page.nodes.length > 1) page.nodes.pop(); else return empty("capped", "page-byte-bound", source);
    next();
  }
  return page;
}
