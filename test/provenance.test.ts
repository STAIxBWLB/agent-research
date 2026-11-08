import { expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import * as investigation from "../src/exp/investigate.ts";
import { readProvenance, validateExecutionReference, PROVENANCE_NODE_LIMIT, PROVENANCE_EDGE_LIMIT, PROVENANCE_PAGE_BYTES, type ProvenancePage, type ProvenanceNode, type ExecutionReferenceV1 } from "../src/provenance.ts";
import { appendEvent, readBytesBounded, readLedger, readTextBounded, sha256, writeAtomic } from "../src/study.ts";
import { ATTEMPT_BYTES } from "../src/exp/attempts.ts";
import { MANUSCRIPT_BYTES } from "../src/paper/placeholders.ts";
import { tempDir, fakeHttp } from "./helpers.ts";
import { provenanceFixture } from "./provenance-fixtures.ts";

const LEDGER_BYTES = 64 * 1024 * 1024;
const node = (page: ProvenancePage, kind: string, id: string) => page.nodes.find(value => value.ref.kind === kind && value.ref.id === id)!;
function bounded(page: ProvenancePage) {
  expect(page.nodes.length).toBeLessThanOrEqual(PROVENANCE_NODE_LIMIT); expect(page.edges.length).toBeLessThanOrEqual(PROVENANCE_EDGE_LIMIT);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(PROVENANCE_PAGE_BYTES);
}
function edge(page: ProvenancePage, relation: string, from: string, to: string) {
  const value = page.edges.find(value => value.relation === relation && value.from.id === from && value.to.id === to);
  expect(value).toBeDefined(); return value!;
}

test("real native sources prove retry, idea, result, dispatch, artifact, review and skill links", async () => {
  const f = await provenanceFixture(), page = readProvenance(f.dir), events = readLedger(f.dir);
  expect(page.status).toBe("ok"); expect(page.issues).toEqual([]); expect(page.truncated).toBe(false); bounded(page);
  expect(page.ledgerPosition).toBe(readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES).length);
  expect(page.totals).toEqual({ nodes: page.nodes.length, edges: page.edges.length });
  const retry = edge(page, "retryOf", f.ids.retryAttempt, f.ids.interruptedAttempt);
  expect(retry.proof.file).toBe(`runs/investigate/attempts/${f.ids.retryAttempt}.json`);
  expect(node(page, "attempt", f.ids.retryAttempt).data).toMatchObject({ status: "succeeded", seed: 1 });
  const parent = edge(page, "parent", f.ids.childIdea, f.ids.parentIdea);
  expect(events[parent.proof.ledgerIndex!]!.type).toBe("idea.added");
  for (const id of [f.ids.interruptedAttempt, f.ids.retryAttempt]) {
    const cited = edge(page, "cites-attempt", f.ids.childIdea, id);
    expect(events[cited.proof.ledgerIndex!]!.type).toBe("idea.decided");
  }
  const produced = edge(page, "produced", f.ids.retryAttempt, f.outputSHA), artifact = node(page, "artifact", f.outputSHA);
  expect(produced.to.sha256).toBe(f.outputSHA); expect(artifact.availability).toBe("not-read"); expect(artifact.data).toMatchObject({ bodyRead: false, bytes: f.outputs.retry.bytes });
  for (const attempt of f.attempts) expect(node(page, "attempt", attempt.id).ref.id).toBe(attempt.id);
  expect(node(page, "plan-revision", "1")).toMatchObject({ state: "historical", ref: { revision: "1" } });
  expect(node(page, "plan-revision", "2")).toMatchObject({ state: "current", ref: { revision: "2" } });
  const dispatched = edge(page, "dispatched", "1", f.plan.dispatchId), observed = edge(page, "observed-in", f.plan.dispatchId, "1");
  expect(events[dispatched.proof.ledgerIndex!]!.type).toBe("node.intent"); expect(events[observed.proof.ledgerIndex!]!.type).toBe("node.observed");
  expect(node(page, "dispatch", f.plan.dispatchId).data?.nodeId).toBe(f.ids.planStep);
  const closedInvestigation = node(page, "closed-result", "investigate"), closedFinal = node(page, "closed-result", "final");
  expect(closedInvestigation).toMatchObject({ state: "current", ref: { sha256: f.closed.investigation.sha256 } });
  expect(closedFinal).toMatchObject({ state: "current", ref: { sha256: f.closed.final.sha256 }, data: { status: "qualified" } });
  edge(page, "uses-attempt", "investigate", f.ids.retryAttempt); edge(page, "names-idea", "investigate", f.ids.childIdea);
  edge(page, "uses-closed-result", "final", "investigate");
  edge(page, "uses-source", f.paper.evidenceSha256, "investigate"); edge(page, "uses-source", f.paper.evidenceSha256, "final");
  const reviewed = page.edges.filter(value => value.relation === "reviewed");
  expect(reviewed).toHaveLength(2); expect(reviewed.map(value => value.proof.nativeId).sort()).toEqual([...f.ids.reviews].sort());
  for (const value of reviewed) { expect(value.to.sha256).toBe(f.paper.evidenceSha256); expect(events[value.proof.ledgerIndex!]!.type).toBe("review.added"); }
  const skill = node(page, "skill-proposal", f.ids.skill); expect(skill).toMatchObject({ state: "current", data: { status: "proposed" } });
  edge(page, "observed-output", f.plan.dispatchId, f.paper.evidenceSha256);
  edge(page, "cites-attempt", f.ids.skill, f.ids.retryAttempt);
  expect(skill.data?.additionalEvidence).toBe("declared-unresolved");
  const proposal = edge(page, "contains", f.studyId, f.ids.skill); expect(events[proposal.proof.ledgerIndex!]!.type).toBe("skill.proposed");
  for (const value of [...page.nodes, ...page.edges]) {
    expect(value.proof.sha256).toBe(sha256(readBytesBounded(join(f.dir, value.proof.file), LEDGER_BYTES)));
    if ("ref" in value) expect(value.ref.projectKey).toBe(f.studyId);
  }
});

test("small pages deterministically cover the complete graph and reject changed-source continuation", async () => {
  const f = await provenanceFixture(), full = readProvenance(f.dir), options = { nodeLimit: 3, edgeLimit: 4 };
  const first = readProvenance(f.dir, options); expect(first).toEqual(readProvenance(f.dir, options)); expect(first.nextCursor).toBeDefined();
  const nodes: ProvenanceNode[] = [], edges: ProvenancePage["edges"] = []; let cursor: string | undefined, pages = 0;
  do {
    const page = readProvenance(f.dir, { ...options, ...(cursor ? { cursor } : {}) });
    expect(page.status).toBe("ok"); expect(page.nodes.length).toBeLessThanOrEqual(3); expect(page.edges.length).toBeLessThanOrEqual(4); bounded(page);
    nodes.push(...page.nodes); edges.push(...page.edges); cursor = page.nextCursor;
    if (++pages > 100) throw new Error("provenance pagination failed to terminate");
  } while (cursor);
  expect(nodes).toEqual(full.nodes); expect(edges).toEqual(full.edges);
  expect(new Set(nodes.map(value => JSON.stringify(value.ref))).size).toBe(nodes.length);
  const ledger = readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES);
  writeAtomic(join(f.dir, "hypotheses.md"), "Synthetic extra source bytes.\n", MANUSCRIPT_BYTES);
  const changed = readProvenance(f.dir, { ...options, cursor: first.nextCursor });
  expect(changed.status).toBe("changed"); expect(changed.nodes).toEqual([]); expect(changed.issues[0]?.code).toBe("changed-cursor");
  const restarted = readProvenance(f.dir, options); expect(restarted.sourceSha256).not.toBe(first.sourceSha256); expect(restarted.nextCursor).not.toBe(first.nextCursor);
  expect(readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES)).toEqual(ledger);
  expect(readProvenance(f.dir, { ...options, cursor: "not-a-cursor" }).status).toBe("changed");
});

test("execution addresses preserve native identifiers and enforce UTF-8 byte bounds", () => {
  const reference: ExecutionReferenceV1 = { v: 1, tool: "ares", projectKey: "한".repeat(85) + "x", kind: "idea", id: "한".repeat(85) + "x", revision: "한".repeat(42) + "xx", sha256: "a".repeat(64) };
  expect(validateExecutionReference(reference)).toEqual(reference);
  const native = { ...reference, id: "native/segment:unchanged", projectKey: "synthetic-study" };
  expect(validateExecutionReference(native).id).toBe(native.id);
  for (const invalid of [{ ...reference, id: "한".repeat(86) }, { ...reference, projectKey: "한".repeat(86) }, { ...reference, revision: "한".repeat(43) }, { ...reference, id: "" }, { ...reference, id: "bad\0id" }, { ...reference, v: 2 }, { ...reference, kind: "unknown" }, { ...reference, tool: "hub" }, { ...reference, sha256: "A".repeat(64) }, { ...reference, extra: true }])
    expect(() => validateExecutionReference(invalid)).toThrow("provenance reference:");
});

test("missing closed artifacts and receipt mismatches stay unavailable or corrupt, never recomputed show results", async () => {
  for (const missing of [true, false]) {
    const f = await provenanceFixture(), file = join(f.dir, "runs", "investigate", "investigate.json"), original = readTextBounded(file, ATTEMPT_BYTES);
    if (missing) fs.unlinkSync(file); else writeAtomic(file, original + " ", ATTEMPT_BYTES);
    const show = spyOn(investigation, "showInvestigation");
    let page: ProvenancePage;
    try { page = readProvenance(f.dir); expect(show).not.toHaveBeenCalled(); }
    finally { show.mockRestore(); }
    expect(page.status).toBe("unavailable");
    expect(page.issues.some(value => value.code === (missing ? "missing-closed-artifact" : "close-receipt-mismatch"))).toBe(true);
    const closed = node(page, "closed-result", "investigate"); expect(closed.state).toBe(missing ? "unavailable" : "corrupt");
    expect(closed.ref.sha256).toBe(f.closed.investigation.sha256);
    expect(page.edges.some(value => value.from.kind === "closed-result" && value.from.id === "investigate" && value.relation === "uses-attempt")).toBe(false);
    if (missing) expect(fs.existsSync(file)).toBe(false); else expect(readTextBounded(file, ATTEMPT_BYTES)).toBe(original + " ");
  }
});

test("malformed ledgers and future source versions refuse without changing their bytes", async () => {
  for (const shape of ["ledger", "ledger-version", "study-version", "attempt-version"] as const) {
    const f = await provenanceFixture(), file = shape === "study-version" ? join(f.dir, "study.json") : shape === "attempt-version" ? join(f.dir, "runs", "investigate", "attempts", `${f.ids.retryAttempt}.json`) : join(f.dir, "ledger.jsonl");
    const original = readTextBounded(file, LEDGER_BYTES);
    const changed = shape === "ledger" ? original + "not JSON\n" : shape === "ledger-version" ? original + JSON.stringify({ v: 99, at: "2030-01-01T00:00:00Z", actor: { kind: "person" }, type: "synthetic", data: {} }) + "\n" : JSON.stringify({ ...JSON.parse(original), v: 99 }) + "\n";
    writeAtomic(file, changed, LEDGER_BYTES); const page = readProvenance(f.dir);
    expect(page.status).toBe("unavailable"); expect(page.issues.some(value => value.code === ({ ledger: "malformed-ledger", "ledger-version": "unsupported-ledger", "study-version": "unsupported-version", "attempt-version": "unsupported-attempt" }[shape]))).toBe(true);
    expect(readTextBounded(file, LEDGER_BYTES)).toBe(changed); bounded(page);
  }
});

test("traversal caps report partial unknown totals rather than claiming a complete graph", async () => {
  const f = await provenanceFixture(), page = readProvenance(f.dir, { traversalLimit: 3 });
  expect(page.status).toBe("capped"); expect(page.truncated).toBe(true); expect(page.totals).toBeNull(); expect(page.nodes.length).toBeLessThanOrEqual(3);
  expect(page.issues.some(value => value.code === "traversal-capped")).toBe(true); bounded(page);
  for (const options of [{ nodeLimit: 101 }, { edgeLimit: 201 }, { traversalLimit: 0 }]) expect(() => readProvenance(f.dir, options)).toThrow("provenance page bounds:");
});

test("historical paper evidence remains a receipt reference while a corrupt current artifact is explicit", async () => {
  const f = await provenanceFixture(), manuscript = join(f.dir, "paper", "manuscript.md"), evidence = join(f.dir, "paper", "build", "evidence.json");
  writeAtomic(manuscript, readTextBounded(manuscript, MANUSCRIPT_BYTES) + "\nSynthetic revised discussion.\n", MANUSCRIPT_BYTES);
  const revised = await ops.paperBuild(f.dir, f.ctx), current = readProvenance(f.dir);
  expect(current.status).toBe("ok");
  expect(node(current, "paper-evidence", f.paper.evidenceSha256)).toMatchObject({ state: "historical", availability: "receipt-only" });
  expect(node(current, "paper-evidence", revised.evidenceSha256)).toMatchObject({ state: "current", availability: "available" });
  expect(current.edges.filter(value => value.relation === "reviewed").every(value => value.to.sha256 === f.paper.evidenceSha256)).toBe(true);
  const corrupted = readTextBounded(evidence, ATTEMPT_BYTES) + " "; writeAtomic(evidence, corrupted, ATTEMPT_BYTES);
  const after = readProvenance(f.dir); expect(after.status).toBe("unavailable");
  expect(node(after, "paper-evidence", revised.evidenceSha256).state).toBe("corrupt");
  expect(node(after, "paper-evidence", f.paper.evidenceSha256).state).toBe("historical");
  expect(after.issues.some(value => value.code === "close-receipt-mismatch")).toBe(true); expect(readTextBounded(evidence, ATTEMPT_BYTES)).toBe(corrupted);
});

test("consistent snapshot detects a source mutation during the native closed-result read", async () => {
  const f = await provenanceFixture(), target = join(fs.realpathSync(f.dir), "runs", "investigate", "investigate.json"), manuscript = join(f.dir, "paper", "manuscript.md"), original = readTextBounded(manuscript, MANUSCRIPT_BYTES);
  const open = fs.openSync; let opens = 0, mutations = 0;
  const spy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
    if (String(file) === target && ++opens === 2) { mutations++; writeAtomic(manuscript, original + "\nSynthetic concurrent edit.\n", MANUSCRIPT_BYTES); }
    return open(file, flags, mode);
  }) as typeof fs.openSync);
  let page: ProvenancePage;
  try { page = readProvenance(f.dir); } finally { spy.mockRestore(); }
  expect(mutations).toBe(1); expect(opens).toBeGreaterThan(1); expect(page.status).toBe("changed"); expect(page.nodes).toEqual([]); expect(page.edges).toEqual([]);
  expect(page.issues[0]?.code).toBe("source-changed");
});

test("projection takes no locks or writes, starts no process/network and never reads output bodies", async () => {
  const f = await provenanceFixture(), journal = readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES), outputPaths = new Set(Object.values(f.outputs).map(output => fs.realpathSync(output.path)));
  const open = fs.openSync, opened: string[] = [];
  const openSpy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
    const name = String(file); opened.push(name);
    if (outputPaths.has(name) || name.endsWith("/.ares.lock") || name.endsWith("/.ares.plan.lock")) throw new Error("forbidden source side effect or output read");
    return open(file, flags, mode);
  }) as typeof fs.openSync);
  const forbidden = (): never => { throw new Error("provenance reader side effect forbidden"); };
  const preconnect = mock(forbidden);
  const writes = [spyOn(fs, "writeSync").mockImplementation(forbidden), spyOn(fs, "writeFileSync").mockImplementation(forbidden), spyOn(fs, "appendFileSync").mockImplementation(forbidden), spyOn(fs, "mkdirSync").mockImplementation(forbidden), spyOn(fs, "renameSync").mockImplementation(forbidden), spyOn(fs, "unlinkSync").mockImplementation(forbidden), spyOn(fs, "chmodSync").mockImplementation(forbidden)];
  const spawn = spyOn(child, "spawn").mockImplementation(forbidden), spawnSync = spyOn(child, "spawnSync").mockImplementation(forbidden), bunSpawn = spyOn(Bun, "spawn").mockImplementation(forbidden), bunSpawnSync = spyOn(Bun, "spawnSync").mockImplementation(forbidden), fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(forbidden, { preconnect }));
  try {
    const page = readProvenance(f.dir); expect(page.status).toBe("ok");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled(); expect(spawnSync).not.toHaveBeenCalled(); expect(bunSpawn).not.toHaveBeenCalled(); expect(bunSpawnSync).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(preconnect).not.toHaveBeenCalled();
    for (const path of outputPaths) expect(opened).not.toContain(path);
  } finally { openSpy.mockRestore(); writes.forEach(write => write.mockRestore()); spawn.mockRestore(); spawnSync.mockRestore(); bunSpawn.mockRestore(); bunSpawnSync.mockRestore(); fetch.mockRestore(); }
  expect(readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES)).toEqual(journal);
});


test("page serialization obeys the byte cap with long native project ids and complete continuation", async () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic byte cap", mode: "experiment" }, ctx);
  const file = join(dir, "study.json"), study = JSON.parse(readTextBounded(file, 65_536)); study.id = "x".repeat(256); writeAtomic(file, JSON.stringify(study), 65_536);
  for (let index = 0; index < 110; index++) await ops.ideaAdd(dir, { id: "i" + String(index).padStart(3, "0") + "a".repeat(60), title: "Synthetic", hypothesis: "Synthetic", ...(index ? { parent: "i" + String(index - 1).padStart(3, "0") + "a".repeat(60) } : {}) }, ctx);
  const first = readProvenance(dir); expect(first.status).toBe("ok"); bounded(first); expect(first.nextCursor).toBeDefined();
  expect(first.edges.length).toBeLessThan(PROVENANCE_EDGE_LIMIT);
  let current = first, nodes = first.nodes.length, edges = first.edges.length, count = 0;
  while (current.nextCursor) { current = readProvenance(dir, { cursor: current.nextCursor }); bounded(current); expect(current.status).toBe("ok"); nodes += current.nodes.length; edges += current.edges.length; if (++count > 10) throw new Error("byte-cap pagination did not finish"); }
  expect(nodes).toBe(111); expect(edges).toBe(219);
});

test("hub references remain declared/unresolved without any hub client or process", async () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic hub reference" }, ctx);
  await ops.planSet(dir, { v: 1, nodes: [{ id: "external", kind: "hub", campaign: "synthetic-campaign", unit: "synthetic-unit" }], edges: [] }, ctx);
  await ops.planControl(dir, { action: "resume", commandId: "synthetic-resume", expectedRevision: 1 }, ctx);
  appendEvent(dir, ctx.actor, "node.intent", { revision: 1, node: "external", dispatchId: "1:external:1", taskId: 17, hubProject: "synthetic-board" });
  const page = readProvenance(dir); expect(page.status).toBe("ok");
  expect(node(page, "plan-revision", "1").data?.hubState).toBe("declared-unresolved");
  expect(node(page, "dispatch", "1:external:1").data).toMatchObject({ hubState: "declared-unresolved", hubTaskId: 17, hubProject: "synthetic-board" });
  expect(page.nodes.every(value => value.ref.tool === "ares")).toBe(true);
});

test("fenced or duplicate plan observations cannot invent provenance edges", async () => {
  const f = await provenanceFixture(), prior = readLedger(f.dir).length;
  appendEvent(f.dir, f.ctx.actor, "node.observed", { revision: 1, node: "build", dispatchId: f.plan.dispatchId, status: "done", output: { attemptId: f.ids.finalWinnerAttempt, sha256: f.closed.final.sha256 } });
  const page = readProvenance(f.dir); expect(page.status).toBe("ok");
  expect(page.edges.some(value => value.proof.ledgerIndex === prior)).toBe(false);
  expect(page.edges.some(value => value.relation === "observed-attempt" && value.from.id === f.plan.dispatchId)).toBe(false);
});

test("old standalone v1 studies preserve additive fields and unknown ledger kinds", () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic legacy", autonomy: "gates" }, ctx);
  const file = join(dir, "study.json"), study = JSON.parse(readTextBounded(file, 65_536)); study.futureAdditive = { opaque: "keep" }; writeAtomic(file, JSON.stringify(study), 65_536);
  appendEvent(dir, ctx.actor, "future.additive", { opaque: "unchanged" });
  const before = [readTextBounded(file, 65_536), readTextBounded(join(dir, "ledger.jsonl"), LEDGER_BYTES)];
  const page = readProvenance(dir); expect(page.status).toBe("ok"); expect(page.nodes).toHaveLength(1); expect(page.nodes[0]!.ref.id).toBe(study.id);
  expect([readTextBounded(file, 65_536), readTextBounded(join(dir, "ledger.jsonl"), LEDGER_BYTES)]).toEqual(before);
});

test("source byte caps and an active writer are explicit states without taking or removing locks", async () => {
  const f = await provenanceFixture(), lock = join(f.dir, ".ares.lock");
  writeAtomic(lock, "synthetic active writer\n", 4096, 0o600);
  const busy = readProvenance(f.dir); expect(busy.status).toBe("changed"); expect(busy.totals).toBeNull(); expect(busy.nodes).toEqual([]);
  expect(readTextBounded(lock, 4096)).toBe("synthetic active writer\n"); fs.unlinkSync(lock);
  const oversized = join(f.dir, "hypotheses.md"), fd = fs.openSync(oversized, "w");
  try { fs.ftruncateSync(fd, 2 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
  const capped = readProvenance(f.dir); expect(capped.status).toBe("capped"); expect(capped.totals).toBeNull(); expect(capped.issues[0]?.code).toBe("source-traversal-capped");
  expect(fs.statSync(oversized).size).toBe(2 * 1024 * 1024 + 1);
});

test("a future closed artifact with a matching receipt remains unsupported and untouched", async () => {
  const f = await provenanceFixture(), file = join(f.dir, "runs/investigate/investigate.json"), body = JSON.parse(readTextBounded(file, ATTEMPT_BYTES)); body.v = 99;
  const future = JSON.stringify(body, null, 2) + "\n", hash = sha256(future); writeAtomic(file, future, ATTEMPT_BYTES);
  appendEvent(f.dir, f.ctx.actor, "investigate.closed", { run: "investigate", sha256: hash, ruleSha256: body.ruleSha256, winner: body.winner?.commit ?? null });
  const before = readTextBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES), page = readProvenance(f.dir);
  expect(page.status).toBe("unavailable"); expect(page.issues.some(issue => issue.code === "unsupported-closed-version")).toBe(true);
  expect(page.nodes.find(value => value.ref.kind === "closed-result" && value.ref.sha256 === hash)?.state).toBe("unavailable");
  expect(readTextBounded(file, ATTEMPT_BYTES)).toBe(future); expect(readTextBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES)).toBe(before);
});


test("stored artifacts without producer receipts are not closed provenance", async () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic missing build receipt" }, ctx);
  fs.mkdirSync(join(dir, "paper")); writeAtomic(join(dir, "paper/manuscript.md"), "Synthetic manuscript.\n", MANUSCRIPT_BYTES); await ops.paperBuild(dir, ctx);
  const events = readLedger(dir).filter(event => event.type !== "paper.built"), ledger = events.map(event => JSON.stringify(event)).join("\n") + "\n";
  writeAtomic(join(dir, "ledger.jsonl"), ledger, LEDGER_BYTES);
  const page = readProvenance(dir); expect(page.status).toBe("unavailable"); expect(page.totals).toBeNull();
  expect(page.issues.some(issue => issue.code === "unreceipted-closed-artifact")).toBe(true); expect(page.edges.some(value => value.relation === "closed")).toBe(false);
  expect(readTextBounded(join(dir, "ledger.jsonl"), LEDGER_BYTES)).toBe(ledger);
});

test("root executor workdir is refused before any nested task output is opened", () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic private workdir" }, ctx);
  const workdir = join(dir, "task/private-output"); fs.mkdirSync(workdir, { recursive: true });
  writeAtomic(join(workdir, "private.txt"), "Synthetic private bytes", 1024);
  writeAtomic(join(dir, "executor.json"), JSON.stringify({ v: 1, kind: "local", workdir }), 65_536);
  const original = fs.openSync, opened: string[] = [], guard = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file).includes("/task/private-output/")) { opened.push(String(file)); throw new Error("private output read"); }
    return Reflect.apply(original, fs, [file, ...args]);
  }) as typeof fs.openSync);
  try { const page = readProvenance(dir); expect(page.status).toBe("unavailable"); expect(page.issues[0]?.code).toBe("executor-overlaps-source"); expect(opened).toEqual([]); }
  finally { guard.mockRestore(); }
});

test("task hashing admits the native task byte and file limits outside the retained snapshot budget", () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic large task" }, ctx); fs.mkdirSync(join(dir, "task"));
  const fd = fs.openSync(join(dir, "task/large.bin"), "w"); try { fs.ftruncateSync(fd, 64 * 1024 * 1024 - 1); } finally { fs.closeSync(fd); }
  for (let i = 1; i < 500; i++) writeAtomic(join(dir, `task/empty-${i}`), "", 1);
  const first = readProvenance(dir); expect(first.status).toBe("ok"); expect(first.nodes).toHaveLength(1);
  writeAtomic(join(dir, "task/empty-1"), "x", 1);
  const changed = readProvenance(dir); expect(changed.status).toBe("ok"); expect(changed.sourceSha256).not.toBe(first.sourceSha256);
  writeAtomic(join(dir, "task/empty-2"), "x", 1);
  expect(readProvenance(dir).issues[0]?.code).toBe("task-traversal-capped");
});

test("observed hub bindings survive removal with the native dispatch terminal status", async () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic late binding" }, ctx);
  await ops.planSet(dir, { v: 1, nodes: [{ id: "external", kind: "hub", campaign: "synthetic-campaign", unit: "synthetic-unit" }], edges: [] }, ctx);
  await ops.planControl(dir, { action: "resume", commandId: "late-binding-resume", expectedRevision: 1 }, ctx);
  appendEvent(dir, ctx.actor, "node.intent", { revision: 1, node: "external", dispatchId: "1:external:1" });
  appendEvent(dir, ctx.actor, "node.observed", { revision: 1, node: "external", dispatchId: "1:external:1", status: "done", taskId: 19, hubProject: "synthetic-late-board" });
  let page = readProvenance(dir); expect(page.status).toBe("ok");
  expect(node(page, "dispatch", "1:external:1").data).toMatchObject({ status: "done", hubTaskId: 19, hubProject: "synthetic-late-board", hubState: "declared-unresolved" });
  await ops.planSet(dir, { v: 1, nodes: [{ id: "replacement", kind: "gate", needs: [], binds: [] }], edges: [] }, ctx);
  page = readProvenance(dir); expect(page.status).toBe("ok");
  expect(node(page, "dispatch", "1:external:1").state).toBe("historical");
  expect(node(page, "dispatch", "1:external:1").data).toMatchObject({ status: "done", hubTaskId: 19, hubProject: "synthetic-late-board" });
});

test("every emitted edge names the source record containing its relationship", async () => {
  const f = await provenanceFixture(), page = readProvenance(f.dir), events = readLedger(f.dir);
  expect(page.status).toBe("ok");
  const witnessed = new Set<string>();
  const ids = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(row => typeof row === "string" ? [row] : row && typeof row === "object" && "id" in row && typeof row.id === "string" ? [row.id] : []);
    if (value && typeof value === "object") return ["running", "succeeded", "failed", "cancelled", "unknown"].flatMap(status => ids((value as Record<string, unknown>)[status]));
    return [];
  };
  for (const link of page.edges) {
    witnessed.add(link.relation);
    const text = readTextBounded(join(f.dir, link.proof.file), LEDGER_BYTES);
    const record = link.proof.ledgerIndex !== undefined ? events[link.proof.ledgerIndex]! : JSON.parse(text);
    const data = link.proof.ledgerIndex !== undefined ? record.data : record;
    switch (link.relation) {
      case "contains":
        if (link.to.kind === "idea") expect(data.idea.id).toBe(link.to.id);
        else if (link.to.kind === "skill-proposal") expect(data.proposal.name).toBe(link.to.id);
        else if (link.to.kind === "plan-revision") expect(String(data.revision)).toBe(link.to.id);
        else { expect(data.id).toBe(link.to.id); expect(data.studyId).toBe(link.from.id); }
        break;
      case "retryOf": expect(data.id).toBe(link.from.id); expect(data.retryOf).toBe(link.to.id); break;
      case "parent": expect(data.idea.id).toBe(link.from.id); expect(data.idea.parent).toBe(link.to.id); break;
      case "cites-attempt":
        if (link.from.kind === "idea") { expect(data.id).toBe(link.from.id); expect(data.attempts).toContain(link.to.id); }
        else { expect(data.proposal.name).toBe(link.from.id); expect(data.proposal.evidence).toContain(`ares:${f.studyId}/attempt:${link.to.id}`); }
        break;
      case "produced": expect(data.id).toBe(link.from.id); expect(data.outputs.some((row: {sha256: string}) => row.sha256 === link.to.sha256)).toBe(true); break;
      case "dispatched": expect(String(data.revision)).toBe(link.from.id); expect(data.dispatchId).toBe(link.to.id); break;
      case "observed-in": expect(data.dispatchId).toBe(link.from.id); expect(String(data.revision)).toBe(link.to.id); break;
      case "expected-attempt": expect(data.dispatchId).toBe(link.from.id); expect(data.attemptId).toBe(link.to.id); break;
      case "observed-attempt": expect(data.dispatchId).toBe(link.from.id); expect(data.output.attemptId).toBe(link.to.id); break;
      case "observed-output": expect(data.dispatchId).toBe(link.from.id); expect(data.output.sha256).toBe(link.to.sha256); break;
      case "closed": expect(data.evidenceSha256 ?? data.sha256).toBe(link.to.sha256); break;
      case "reviewed": expect(data.review.buildSha256).toBe(link.to.sha256); expect(data.id).toBe(link.proof.nativeId); break;
      case "uses-attempt":
        expect(link.proof.file).toMatch(/^runs\/[^/]+\/(investigate|ablate|final)\.json$/);
        expect([...ids(data.attempts), ...ids(data.baseline?.attempts), ...ids(data.reference?.attempts), ...(data.candidates ?? []).flatMap((row: {attempts: unknown}) => ids(row.attempts)), ...(data.ablations ?? []).flatMap((row: {attempts: unknown}) => ids(row.attempts)), ...ids(data.excluded)]).toContain(link.to.id);
        expect(sha256(text)).toBe(link.from.sha256); break;
      case "names-idea": expect(data.winner.idea).toBe(link.to.id); expect(sha256(text)).toBe(link.from.sha256); break;
      case "uses-closed-result": expect([data.investigateSha256, data.ablateSha256]).toContain(link.to.sha256); expect(sha256(text)).toBe(link.from.sha256); break;
      case "uses-source": expect(link.proof.file).toBe("paper/build/evidence.json"); expect(data.placeholders.some((row: {source: {sha256: string}}) => row.source.sha256 === link.to.sha256 || row.source.sha256 === node(page, "attempt", link.to.id)?.proof.sha256)).toBe(true); expect(sha256(text)).toBe(link.from.sha256); break;
      default: throw new Error(`Unaudited relation ${link.relation}`);
    }
  }
  for (const relation of ["uses-attempt", "names-idea", "uses-closed-result", "uses-source", "closed"]) expect(witnessed.has(relation)).toBe(true);
});

for (const scenario of ["missing", "foreign", "run", "commit", "seed", "duplicate"] as const) test(`attempt provenance refuses ${scenario} start identity`, async () => {
  const f = await provenanceFixture(), id = f.ids.retryAttempt, file = join(f.dir, `runs/investigate/attempts/${id}.json`);
  const events = readLedger(f.dir), start = events.find(event => event.type === "attempt.started" && event.data.id === id)!;
  if (scenario === "foreign") {
    const attempt = JSON.parse(readTextBounded(file, ATTEMPT_BYTES)); attempt.studyId = "foreign-synthetic-study"; writeAtomic(file, JSON.stringify(attempt), ATTEMPT_BYTES);
  } else if (scenario === "run") start.data.run = "other-run";
  else if (scenario === "commit") start.data.commit = "c".repeat(40);
  else if (scenario === "seed") start.data.seed = 987;
  const changed = scenario === "missing" ? events.filter(event => event !== start) : scenario === "duplicate" ? [...events, start] : events;
  writeAtomic(join(f.dir, "ledger.jsonl"), changed.map(event => JSON.stringify(event)).join("\n") + "\n", LEDGER_BYTES);
  const page = readProvenance(f.dir); expect(page.status).toBe("unavailable"); expect(node(page, "attempt", id).state).toBe("corrupt");
  const issue = scenario === "missing" ? "missing-attempt-start-receipt" : scenario === "foreign" ? "attempt-study-identity-mismatch" : scenario === "duplicate" ? "duplicate-attempt-start-receipt" : "attempt-start-identity-mismatch";
  expect(page.issues.some(value => value.code === issue && value.ref?.id === id)).toBe(true);
  expect(page.edges.some(value => value.from.kind === "attempt" && value.from.id === id && ["retryOf", "produced"].includes(value.relation))).toBe(false);
});
