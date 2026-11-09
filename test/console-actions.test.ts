import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConsolePlugin, ConsoleProvider } from "@staix/agent-console/contract";
import { registerConsoleConformance } from "@staix/agent-console/conformance";
import { startServer } from "../node_modules/@staix/agent-console/src/server.ts";
import { createPlugin, CONSOLE_ARCHIVE_MS } from "../src/ui/plugin.ts";
import * as ops from "../src/commands.ts";
import { addStudy } from "../src/console/registry.ts";
import { appendEvent, openStudy, readLedger } from "../src/study.ts";
import { fakeHttp, fakeRunner, tempDir } from "./helpers.ts";

const person = { kind: "person" as const }, ctx = { actor: person, http: fakeHttp([]).http }, noteId = "a".repeat(32);
const META = { identity: "verified-person", node: "synthetic-node", via: "console" as const };
const candidateId = "doi:10.0000/action-a", otherId = "doi:10.0000/action-b", baselineId = "doi:10.0000/action-baseline", proposalName = "synthetic-procedure", pr = "https://github.com/example/synthetic/pull/1";
type Input = { action: string; [key: string]: unknown };
type Preview = { ok: false; needsConfirm: true; fingerprint: string; preview: string[] };
type WireResponse = { ok?: boolean; needsConfirm?: boolean; confirmToken?: string; readOnly?: boolean };
const responseJson = async (response: Response): Promise<WireResponse> => await response.json() as WireResponse;
const ledger = (dir: string) => fs.readFileSync(join(dir, "ledger.jsonl"), "utf8");
async function fixture(home: string) {
  const family = join(home, "family"), survey = join(home, "survey"), experiment = join(home, "experiment");
  ops.init(survey, { question: "Synthetic survey" }, ctx); ops.init(experiment, { question: "Synthetic experiment", mode: "experiment" }, ctx);
  await ops.scope(survey, { question: "Synthetic scope" }, ctx); await ops.gateDecide(survey, "scope", "approve", undefined, ctx);
  fs.writeFileSync(join(survey, "literature", "candidates.json"), JSON.stringify([
    { id: candidateId, doi: "10.0000/action-a", title: "Synthetic action A", authors: [], year: 2024, sources: ["openalex"], status: "new", addedAt: "2030-01-01T00:00:00Z" },
    { id: otherId, doi: "10.0000/action-b", title: "Synthetic action B", authors: [], year: 2024, sources: ["openalex"], status: "new", addedAt: "2030-01-01T00:00:00Z" },
    { id: baselineId, doi: "10.0000/action-baseline", title: "Synthetic included baseline", authors: [], year: 2024, sources: ["openalex"], status: "included", addedAt: "2030-01-01T00:00:00Z" },
  ]));
  const studyId = openStudy(survey).study.id;
  await ops.skillPropose(survey, { name: proposalName, summary: "Synthetic procedure", steps: ["Inspect recorded evidence"], evidence: [{v: 1, tool: "ares", projectKey: studyId, kind: "study", id: studyId}] }, ctx);
  await ops.ideaAdd(experiment, { id: "pivot", title: "Synthetic pivot", hypothesis: "Synthetic hypothesis" }, ctx);
  await ops.ideaDecide(experiment, "pivot", { decision: "pivot", reason: "Synthetic abandoned direction", cause: "Recorded cause", retryWhen: "New evidence" }, ctx);
  addStudy(family, survey); addStudy(family, experiment);
  const env = { HOME: home, AGENTHUB_HOME: family, AMEM_HOME: join(home, "never-created-amem") };
  return { home, family, survey, experiment, env };
}
function actions(f: Awaited<ReturnType<typeof fixture>>): Input[] {
  return [
    { action: "gate.approve", study: f.survey, gate: "screen" },
    { action: "screen.include", study: f.survey, ids: [candidateId], reason: "Synthetic screening" },
    { action: "skill.accept", study: f.survey, name: proposalName, reason: "Reviewed against evidence", pr },
    { action: "archive.confirm", study: f.experiment },
  ];
}
function previewActions(f: Awaited<ReturnType<typeof fixture>>): Input[] {
  return [...actions(f),
    { action: "gate.reject", study: f.survey, gate: "screen", reason: "Synthetic gate rejection" },
    { action: "screen.exclude", study: f.survey, ids: [candidateId], reason: "Synthetic exclusion" },
    { action: "skill.reject", study: f.survey, name: proposalName, reason: "Synthetic rejection" },
    { action: "skill.withdraw", study: f.survey, name: proposalName, reason: "Synthetic withdrawal" },
  ];
}
async function open(f: Awaited<ReturnType<typeof fixture>>, runner = fakeRunner([]).runner): Promise<ConsoleProvider> {
  const plugin: ConsolePlugin = createPlugin({ runner, env: f.env });
  return plugin.open({ home: f.family, log: () => {}, features: ["inbox.form", "action.meta"] });
}
async function preview(provider: ConsoleProvider, input: Input): Promise<Preview> {
  const result = await provider.action(input, META);
  expect(result.ok).toBe(false); expect("needsConfirm" in result && result.needsConfirm).toBe(true);
  if (result.ok !== false || !("needsConfirm" in result) || result.needsConfirm !== true) throw new Error("expected a confirmation preview");
  const pending = result as Preview;
  if (typeof pending.fingerprint !== "string" || !Array.isArray(pending.preview) || pending.preview.some(line => typeof line !== "string")) throw new Error("malformed confirmation preview");
  expect(pending.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(pending.preview.length).toBeGreaterThan(0); return pending;
}
function files(home: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name); if (entry.isDirectory()) { result[file + "/"] = ""; visit(file); } else result[file] = fs.readFileSync(file).toString("base64");
  } };
  visit(home); return result;
}

// Own persistent fixture: helpers.tempDir afterEach must never remove conformance state.
const persistent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ares-actions-conformance-"))), conformance = await fixture(persistent);
afterAll(() => fs.rmSync(persistent, { recursive: true, force: true }));
registerConsoleConformance(createPlugin({ runner: fakeRunner([]).runner, env: conformance.env }), { home: conformance.family, destructive: previewActions(conformance) });

test("all eight decision-level actions preview without any filesystem mutation or amem call", async () => {
  const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([]), provider = await open(f, fake.runner), before = files(f.home);
  const original = fs.openSync, openedForWrite: string[] = [];
  const fd = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    if (typeof flags === "string" ? /[wa+]/.test(flags) : !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC))) openedForWrite.push(String(file));
    return original(file, flags, mode);
  }) as typeof fs.openSync);
  const writes = [spyOn(fs, "writeFileSync"), spyOn(fs, "appendFileSync"), spyOn(fs, "renameSync"), spyOn(fs, "unlinkSync"), spyOn(fs, "mkdirSync"), spyOn(fs, "chmodSync"), spyOn(fs, "utimesSync")];
  try { for (const input of previewActions(f)) await preview(provider, input); expect(openedForWrite).toEqual([]); for (const write of writes) expect(write).not.toHaveBeenCalled(); }
  finally { for (const write of writes) write.mockRestore(); fd.mockRestore(); }
  expect(files(f.home)).toEqual(before); expect(fake.requests).toEqual([]);
});

test("confirming every action appends one event attributed only to verified person metadata", async () => {
  const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([{ exitCode: 0, stdout: JSON.stringify({ id: noteId, kind: "fail" }), stderr: "private diagnostic" }]), provider = await open(f, fake.runner);
  const types = ["gate.approve", "lit.screen", "skill.decided", "archive.exported"];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("console action network forbidden"); }) as unknown as typeof fetch);
  try {
    for (const [index, action] of actions(f).entries()) {
      const input: Input = { ...action }, pending = await preview(provider, input), dir = input.study as string, count = readLedger(dir).length;
      const result = await provider.action({ ...input, confirmed: true, fingerprint: pending.fingerprint }, META);
      expect(result.ok).toBe(true); expect(readLedger(dir)).toHaveLength(count + 1);
      expect(readLedger(dir).at(-1)).toMatchObject({ type: types[index], actor: { kind: "person", id: META.identity } });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
  expect(ops.gateList(f.survey).find(gate => gate.gate === "screen")?.state).toBe("pending");
  expect(ops.list(f.survey, { status: "included" }).candidates.map(row => row.id)).toEqual([candidateId, baselineId]);
  expect(ops.skillList(f.survey)[0]!.state).toBe("accepted");
  expect(fake.requests).toHaveLength(1); expect(fake.requests[0]!.env).toMatchObject({ HOME: f.home, AMEM_HOME: f.env.AMEM_HOME, AGENTHUB_HOME: f.family });
  expect(ledger(f.experiment)).not.toContain("private diagnostic"); expect(fs.existsSync(f.env.AMEM_HOME)).toBe(false);
});

test("without verified action metadata a valid action records a person without an id", async () => {
  const f = await fixture(fs.realpathSync(tempDir())), provider = await open(f), input = { ...actions(f)[0]! };
  const pending = await preview(provider, input); expect((await provider.action({ ...input, confirmed: true, fingerprint: pending.fingerprint })).ok).toBe(true);
  expect(readLedger(f.survey).at(-1)!.actor).toEqual({ kind: "person" });
});

test("gate binding and decision-state drift both refuse old confirmation without a write", async () => {
  for (const mode of ["binding", "decision"]) {
    const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([]), provider = await open(f, fake.runner), input = actions(f)[0]!, pending = await preview(provider, input);
    if (mode === "binding") await ops.screen(f.survey, [candidateId], "include", "Other screening", ctx);
    else await ops.gateDecide(f.survey, "screen", "approve", undefined, ctx);
    const before = files(f.home), result = await provider.action({ ...input, confirmed: true, fingerprint: pending.fingerprint }, META);
    expect(result.ok).toBe(false); expect("error" in result && result.error).toContain("stale"); expect(files(f.home)).toEqual(before); expect(fake.requests).toEqual([]);
  }
});

test("screen content, skill state and archive note drift refuse old confirmations", async () => {
  for (const index of [1, 2, 3]) {
    const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([]), provider = await open(f, fake.runner), input = actions(f)[index]!, pending = await preview(provider, input);
    if (index === 1) {
      const file = join(f.survey, "literature", "candidates.json"), rows = JSON.parse(fs.readFileSync(file, "utf8")); rows[0].abstract = "Changed candidate content"; fs.writeFileSync(file, JSON.stringify(rows));
    } else if (index === 2) await ops.skillDecide(f.survey, proposalName, "reject", "Other decision", undefined, ctx);
    else { await ops.ideaAdd(f.experiment, { id: "later", title: "Later idea", hypothesis: "Later hypothesis" }, ctx); await ops.ideaDecide(f.experiment, "later", { decision: "pivot", reason: "Later pivot" }, ctx); }
    const before = files(f.home), result = await provider.action({ ...input, confirmed: true, fingerprint: pending.fingerprint }, META);
    expect(result.ok).toBe(false); expect("error" in result && result.error).toContain("stale"); expect(files(f.home)).toEqual(before); expect(fake.requests).toEqual([]);
  }
});

test("canonical input changes and replacing the study identity invalidate confirmation", async () => {
  for (const mode of ["input", "identity"]) {
    const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([]), provider = await open(f, fake.runner), input = actions(f)[0]!, pending = await preview(provider, input);
    const confirmed: Input & { confirmed: true; fingerprint: string } = { ...input, confirmed: true, fingerprint: pending.fingerprint };
    if (mode === "input") { confirmed.action = "gate.reject"; confirmed.reason = "Different decision"; }
    else { const file = join(f.survey, "study.json"), study = JSON.parse(fs.readFileSync(file, "utf8")); study.id = "replacement-study"; fs.writeFileSync(file, JSON.stringify(study)); }
    const before = files(f.home), result = await provider.action(confirmed, META);
    expect(result.ok).toBe(false); expect("error" in result && result.error).toContain("stale"); expect(files(f.home)).toEqual(before); expect(fake.requests).toEqual([]);
  }
});

test("invalid reasons, PR references, unknown actions and unregistered studies never write", async () => {
  const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([]), provider = await open(f, fake.runner), before = files(f.home);
  const invalid: Input[] = [
    { ...actions(f)[0]!, action: "gate.reject" }, { ...actions(f)[1]!, reason: " " }, { ...actions(f)[2]!, reason: "" },
    { ...actions(f)[2]!, pr: undefined }, { ...actions(f)[2]!, pr: "file:///synthetic" }, { ...actions(f)[2]!, pr: "https://user:secret@example.com/pull/1" },
    { action: "unknown", study: f.survey }, { action: "attempt.run", study: f.experiment }, { ...actions(f)[0]!, study: join(f.home, "not-registered") },
  ];
  for (const input of invalid) { const result = await provider.action(input, META); expect(result.ok).toBe(false); expect("needsConfirm" in result && result.needsConfirm).toBe(false); }
  const valid = actions(f)[0]!; expect((await provider.action({ ...valid, confirmed: true, fingerprint: "invalid" }, META)).ok).toBe(false);
  expect(files(f.home)).toEqual(before); expect(fake.requests).toEqual([]);
});

test("the pinned console read-only server refuses an action before invoking the provider, without listening", async () => {
  const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([]), provider = await open(f, fake.runner), plugin: ConsolePlugin = createPlugin({ runner: fake.runner, env: f.env }), before = files(f.home);
  let handle: ((request: Request) => Promise<Response>) | undefined;
  const serve = spyOn(Bun, "serve").mockImplementation(((options: { fetch(request: Request): Promise<Response> }) => { handle = request => options.fetch(request); return { port: 43179, stop: () => {} }; }) as unknown as typeof Bun.serve);
  const action = spyOn(provider, "action");
  const server = startServer({ plugins: [{ tool: "ares", file: join(f.family, "synthetic-plugin.json"), status: "ready", manifest: plugin.manifest, provider }], version: "synthetic", pluginsDir: f.family,
    serve: { hostname: "127.0.0.1", port: 43179, origins: ["http://127.0.0.1:43179"], hosts: ["127.0.0.1:43179"], mode: "loopback", authenticate: async () => META.identity, readOnly: true }, log: () => {} });
  try {
    expect(handle).toBeDefined();
    const response = await handle!(new Request("http://127.0.0.1:43179/p/ares/action", { method: "POST", headers: { host: "127.0.0.1:43179", origin: "http://127.0.0.1:43179", "content-type": "application/json" }, body: JSON.stringify(actions(f)[0]) }));
    expect(response.status).toBe(403); expect((await responseJson(response)).readOnly).toBe(true); expect(action).not.toHaveBeenCalled();
    expect(files(f.home)).toEqual(before); expect(fake.requests).toEqual([]);
  } finally { await server.stop(); action.mockRestore(); serve.mockRestore(); }
});


test("console archive budget stops before another child and commits returned ids for safe retry", async () => {
  const f = await fixture(fs.realpathSync(tempDir()));
  await ops.ideaAdd(f.experiment, { id: "second", title: "Second pivot", hypothesis: "Second hypothesis" }, ctx);
  await ops.ideaDecide(f.experiment, "second", { decision: "pivot", reason: "Second abandoned direction" }, ctx);
  let clock = 0;
  const fake = fakeRunner([noteId, "b".repeat(32)].map(id => ({ exitCode: 0, stdout: JSON.stringify({ id, kind: "fail" }), stderr: "private diagnostic" })));
  const plugin: ConsolePlugin = createPlugin({ env: f.env, now: () => clock, runner: async request => { const result = await fake.runner(request); clock += CONSOLE_ARCHIVE_MS + 1; return result; } });
  const provider = await plugin.open({ home: f.family, log: () => {}, features: ["action.meta"] }), input = actions(f)[3]!, pending = await preview(provider, input), count = readLedger(f.experiment).length;
  const result = await provider.action({ ...input, confirmed: true, fingerprint: pending.fingerprint }, META);
  expect(result.ok).toBe(false); expect("error" in result && result.error).toContain("1 note exported and receipted"); expect("error" in result && result.error).toContain("open a new archive preview and confirm it"); expect("error" in result && result.error).not.toContain("--confirm");
  expect(fake.requests).toHaveLength(1); expect(fake.requests[0]!.timeoutMs!).toBeGreaterThan(0); expect(fake.requests[0]!.timeoutMs!).toBeLessThanOrEqual(CONSOLE_ARCHIVE_MS);
  expect(readLedger(f.experiment)).toHaveLength(count + 1);
  expect(readLedger(f.experiment).at(-1)).toMatchObject({ type: "archive.exported", actor: { kind: "person", id: META.identity }, data: { notes: [{ id: noteId }] } });
  expect(ledger(f.experiment)).not.toContain("private diagnostic"); expect(fs.existsSync(join(f.experiment, ".ares.lock"))).toBe(false);
  const stale = await provider.action({ ...input, confirmed: true, fingerprint: pending.fingerprint }, META);
  expect(stale.ok).toBe(false); expect("error" in stale && stale.error).toContain("stale"); expect(fake.requests).toHaveLength(1);
  const fresh = await preview(provider, input); expect(fresh.fingerprint).not.toBe(pending.fingerprint);
  expect((await provider.action({ ...input, confirmed: true, fingerprint: fresh.fingerprint }, META)).ok).toBe(true);
  expect(fake.requests).toHaveLength(2); expect(readLedger(f.experiment)).toHaveLength(count + 2);
  expect(readLedger(f.experiment).filter(event => event.type === "archive.exported").flatMap(event => (event.data.notes as { id: string }[]).map(note => note.id))).toEqual([noteId, "b".repeat(32)]);
  expect(fs.existsSync(join(f.experiment, ".ares.lock"))).toBe(false);
});

test("the pinned writable console routes all four actions through shell-issued confirm tokens", async () => {
  const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([{ exitCode: 0, stdout: JSON.stringify({ id: noteId, kind: "fail" }), stderr: "private diagnostic" }]), provider = await open(f, fake.runner);
  const plugin: ConsolePlugin = createPlugin({ runner: fake.runner, env: f.env });
  let handle: ((request: Request) => Promise<Response>) | undefined;
  const serve = spyOn(Bun, "serve").mockImplementation(((options: { fetch(request: Request): Promise<Response> }) => { handle = request => options.fetch(request); return { port: 43179, stop: () => {} }; }) as unknown as typeof Bun.serve);
  const server = startServer({ plugins: [{ tool: "ares", file: join(f.family, "synthetic-plugin.json"), status: "ready", manifest: plugin.manifest, provider }], version: "synthetic", pluginsDir: f.family,
    serve: { hostname: "127.0.0.1", port: 43179, origins: ["http://127.0.0.1:43179"], hosts: ["127.0.0.1:43179"], mode: "loopback", authenticate: async () => META.identity }, log: () => {} });
  const request = (body: Record<string, unknown>) => handle!(new Request("http://127.0.0.1:43179/p/ares/action", { method: "POST", headers: { host: "127.0.0.1:43179", origin: "http://127.0.0.1:43179", "content-type": "application/json" }, body: JSON.stringify(body) }));
  try {
    expect(handle).toBeDefined();
    const previewBefore = files(f.home);
    for (const input of previewActions(f)) {
      expect(Object.hasOwn(input, "decision")).toBe(false);
      const response = await request(input), result = await responseJson(response);
      expect(response.status).toBe(200); expect(result.needsConfirm).toBe(true); expect(result.confirmToken).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(files(f.home)).toEqual(previewBefore); expect(fake.requests).toEqual([]);
    for (const [index, action] of actions(f).entries()) {
      const input: Input = { ...action }, before = files(f.home), dir = input.study as string, count = readLedger(dir).length, requested = fake.requests.length;
      const pendingResponse = await request(input), pending = await responseJson(pendingResponse);
      expect(pendingResponse.status).toBe(200); expect(pending.needsConfirm).toBe(true); expect(pending.confirmToken).toMatch(/^[a-f0-9]{64}$/);
      expect(files(f.home)).toEqual(before); expect(fake.requests).toHaveLength(requested);
      const response = await request({ ...input, confirmToken: pending.confirmToken });
      expect(response.status).toBe(200); expect((await responseJson(response)).ok).toBe(true); expect(readLedger(dir)).toHaveLength(count + 1);
      expect(readLedger(dir).at(-1)).toMatchObject({ type: ["gate.approve", "lit.screen", "skill.decided", "archive.exported"][index], actor: { kind: "person", id: META.identity } });
      const committed = files(f.home), replay = await request({ ...input, confirmToken: pending.confirmToken });
      expect(replay.status).toBe(409); expect(files(f.home)).toEqual(committed);
    }
    expect(fake.requests).toHaveLength(1); expect(fs.existsSync(f.env.AMEM_HOME)).toBe(false);
  } finally { await server.stop(); serve.mockRestore(); }
});


test("inbox verbs use declared decision ids and resolve subjects and PR forms without page authority", async () => {
  const f = await fixture(fs.realpathSync(tempDir()));
  appendEvent(f.survey, person, "watch.ran", { addedIds: [candidateId, otherId], addedIdsTotal: 2, added: 2, ok: true });
  const provider = await open(f), snapshot = await provider.snapshot({ panel: "inbox", after: 0 }), items = snapshot.items as Record<string, any>[];
  const declared = createPlugin().manifest.capabilities.actions;
  for (const item of items) for (const verb of item.verbs) expect(declared).toContain(verb.id);
  const gate = items.find(row => row.kind === "gate" && row.title.includes("screen"))!, candidate = items.find(row => row.kind === "candidate")!, skill = items.find(row => row.kind === "skill")!;
  await preview(provider, { action: "gate.reject", id: gate.id, reason: "Synthetic gate reason" });
  await preview(provider, { action: "screen.exclude", id: candidate.id, reason: "Synthetic screening reason" });
  const input = { action: "skill.accept", id: skill.id, reason: "Reviewed evidence", answers: { pr: { selected: [], other: pr } } }, pending = await preview(provider, input);
  expect((await provider.action({ ...input, confirmed: true, fingerprint: pending.fingerprint }, META)).ok).toBe(true);
  expect(readLedger(f.survey).at(-1)).toMatchObject({ type: "skill.decided", data: { name: proposalName, pr }, actor: { kind: "person", id: META.identity } });
  const old = await createPlugin({ env: f.env, runner: fakeRunner([]).runner }).open({ home: f.family, log: () => {} });
  const olderItems = (await old.snapshot({ panel: "inbox", after: 0 })).items as Record<string, any>[];
  expect(olderItems.find(row => row.id === gate.id)!.verbs.map((verb: any) => verb.id)).toEqual(["gate.approve", "gate.reject"]);
  expect(olderItems.flatMap(row => row.verbs).some(verb => verb.form)).toBe(false);
});

test("confirmation guard catches content changed as the mutation lock is acquired", async () => {
  const f = await fixture(fs.realpathSync(tempDir())), provider = await open(f), input = actions(f)[1]!, pending = await preview(provider, input), before = ledger(f.survey);
  const original = fs.openSync, file = join(f.survey, "literature", "candidates.json"); let changed = false;
  const spy = spyOn(fs, "openSync").mockImplementation(((location: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = original(location, flags, mode);
    if (!changed && String(location) === join(f.survey, ".ares.lock") && flags === "wx") {
      changed = true; const candidates = JSON.parse(fs.readFileSync(file, "utf8")); candidates[0].title = "Changed at lock acquisition"; fs.writeFileSync(file, JSON.stringify(candidates));
    }
    return fd;
  }) as typeof fs.openSync);
  try { const result = await provider.action({ ...input, confirmed: true, fingerprint: pending.fingerprint }, META); expect(result.ok).toBe(false); expect("error" in result && result.error).toContain("stale"); }
  finally { spy.mockRestore(); }
  expect(changed).toBe(true); expect(ledger(f.survey)).toBe(before); expect(ops.list(f.survey, { status: "new" }).candidates.find(row => row.id === candidateId)?.title).toBe("Changed at lock acquisition");
});


test("maximum-byte plan gate ids approve and reject through direct and inbox confirmation routes", async () => {
  const nodeId = "g".repeat(128), gate = `plan:${nodeId}`;
  expect(Buffer.byteLength(nodeId)).toBe(128); expect(Buffer.byteLength(gate)).toBe(133);
  for (const route of ["direct", "inbox"] as const) for (const decision of ["approve", "reject"] as const) {
    const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([]);
    await ops.planSet(f.survey, { v: 1, nodes: [{ id: nodeId, kind: "gate", binds: [] }], edges: [] }, ctx);
    const provider = await open(f, fake.runner);
    let input: Input = { action: `gate.${decision}`, study: f.survey, gate, reason: "Synthetic maximum-id decision" };
    if (route === "inbox") {
      const snapshot = await provider.snapshot({ panel: "inbox", after: 0 });
      const item = (snapshot.items as Record<string, any>[]).find(row => row.kind === "gate" && row.title === `Approve or reject ${gate}`);
      expect(item).toBeDefined();
      input = { action: `gate.${decision}`, id: item!.id, reason: "Synthetic maximum-id decision" };
    }
    const before = ledger(f.survey), count = readLedger(f.survey).length, pending = await preview(provider, input);
    expect(ledger(f.survey)).toBe(before); expect(fake.requests).toEqual([]);
    expect((await provider.action({ ...input, confirmed: true, fingerprint: pending.fingerprint }, META)).ok).toBe(true);
    expect(readLedger(f.survey)).toHaveLength(count + 1);
    expect(readLedger(f.survey).at(-1)).toMatchObject({ type: `gate.${decision}`, actor: { kind: "person", id: META.identity }, data: { gate } });
    expect(fake.requests).toEqual([]);
  }
});


test("page identity claims are unknown fields and refuse before preview or confirmed writes", async () => {
  const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([]), provider = await open(f, fake.runner);
  const input = actions(f)[0]!, pending = await preview(provider, input), before = files(f.home);
  for (const claim of [{ actor: { kind: "agent", id: "page-spoof" } }, { meta: { identity: "page-spoof" } }, { identity: "page-spoof" }]) {
    for (const envelope of [{}, { confirmed: true as const, fingerprint: pending.fingerprint }]) {
      const result = await provider.action({ ...input, ...claim, ...envelope }, META);
      expect(result.ok).toBe(false); expect("needsConfirm" in result && result.needsConfirm).toBe(false);
      expect(files(f.home)).toEqual(before); expect(fake.requests).toEqual([]);
    }
  }
});

test("all eight wire actions reject unknown and cross-action fields before any outward write", async () => {
  const f = await fixture(fs.realpathSync(tempDir())), fake = fakeRunner([]), provider = await open(f, fake.runner), before = files(f.home);
  for (const input of previewActions(f)) {
    const pending = await preview(provider, input);
    const crossAction = input.action.startsWith("gate.") ? { ids: [candidateId] }
      : input.action.startsWith("screen.") ? { name: proposalName }
      : input.action === "skill.accept" ? { gate: "screen" }
      : input.action.startsWith("skill.") ? { pr }
      : { reason: "Archive does not accept a reason" };
    for (const extra of [{ unknown: true }, { decision: input.action.split(".")[1] }, crossAction]) {
      for (const envelope of [{}, { confirmed: true as const, fingerprint: pending.fingerprint }]) {
        const result = await provider.action({ ...input, ...extra, ...envelope }, META);
        expect(result.ok).toBe(false); expect("needsConfirm" in result && result.needsConfirm).toBe(false);
        expect(files(f.home)).toEqual(before); expect(fake.requests).toEqual([]);
      }
    }
  }
});
