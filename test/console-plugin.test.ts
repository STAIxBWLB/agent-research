import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConsolePlugin } from "@staix/agent-console/contract";
import { registerConsoleConformance } from "@staix/agent-console/conformance";
import { scanPlugins } from "../node_modules/@staix/agent-console/src/plugins.ts";
import plugin from "../src/ui/plugin.ts";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { addStudy, readRegistry } from "../src/console/registry.ts";
import { appendEvent, openStudy, readLedger } from "../src/study.ts";
import { readProtocol, protocolHash, designBinding } from "../src/exp/protocol.ts";
import { finalGateBinding, requireFinalInputs } from "../src/exp/final.ts";
import { runSetup } from "../src/setup.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const typed: ConsolePlugin = plugin, actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const BASE = "a".repeat(40), WIN = "b".repeat(40);
function makeStudy(home: string, name: string, mode = "survey") { const dir = join(home, name); ops.init(dir, { question: `Synthetic ${name}`, mode }, ctx); return dir; }
let serial = 0;
function attempt(dir: string, frozen: string, run: string, seed: number, value: number, status = "succeeded") {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, folder = join(dir, "runs", run, "attempts"); fs.mkdirSync(folder, { recursive: true });
  const binding = run === "final" ? finalGateBinding(dir) : undefined;
  fs.writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit: frozen, seed, protocolHash: protocolHash(protocol), protocol,
    executor: { v: 1, kind: "local", workdir: "/synthetic" }, stages: {}, stage: "evaluator", status, label: "synthetic", startedAt: "2030-01-01T00:00:00Z", endedAt: "2030-01-01T00:00:01Z", sealBinding: designBinding(dir),
    ...(binding ? { finalBinding: binding, finalWinner: requireFinalInputs(dir).winner } : {}), metrics: status === "succeeded" ? [{ name: "score", value, unit: "points", provenance: "ares-observed" }] : [], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run, commit: frozen, seed }); appendEvent(dir, actor, `attempt.${status}`, { id, run, stage: "evaluator", status }); return id;
}
async function fixtures(home: string) {
  const family = join(home, "family"), survey = makeStudy(home, "survey"), experiment = makeStudy(home, "experiment", "experiment"), gone = makeStudy(home, "gone");
  await ops.scope(survey, { question: "Synthetic survey" }, ctx);
  const candidates = [{ id: "doi:10.0000/live", doi: "10.0000/live", title: "Synthetic live candidate", authors: [], year: 2024, sources: ["openalex"], status: "new", addedAt: "2030-01-01T00:00:00Z" },
    { id: "doi:10.0000/screened", doi: "10.0000/screened", title: "Synthetic screened candidate", authors: [], year: 2024, sources: ["openalex"], status: "excluded", addedAt: "2030-01-01T00:00:00Z" }];
  fs.writeFileSync(join(survey, "literature", "candidates.json"), JSON.stringify(candidates));
  await ops.watchSet(survey, { v: 1, queries: [{ id: "synthetic", query: "synthetic", source: "openalex" }], rubric: "Synthetic human rubric" }, ctx);
  appendEvent(survey, actor, "watch.ran", { configSha256: "a".repeat(64), queries: [], added: 3, addedIds: [candidates[0]!.id, candidates[1]!.id, "doi:10.0000/absorbed"], addedIdsTotal: 3, ok: false });
  await ops.skillPropose(survey, { name: "synthetic-procedure", summary: "Synthetic reusable procedure", steps: ["Inspect synthetic evidence"], evidence: ["a".repeat(32)] }, ctx);
  fs.mkdirSync(join(survey, "paper")); fs.writeFileSync(join(survey, "paper", "manuscript.md"), "Synthetic manuscript.\n"); const build = await ops.paperBuild(survey, ctx);
  await ops.reviewAdd(survey, { v: 1, reviewer: { id: "synthetic", modelFamily: "synthetic" }, buildSha256: build.evidenceSha256,
    checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings: [{ id: "contradiction", kind: "contradiction", location: "Synthetic section", text: "Synthetic open contradiction", blocking: true }] }, ctx);
  fs.mkdirSync(join(experiment, "task", "evaluator"), { recursive: true }); fs.writeFileSync(join(experiment, "task", "task.md"), "Synthetic task"); fs.writeFileSync(join(experiment, "task", "evaluator", "run"), "Synthetic evaluator");
  await ops.protocol(experiment, { v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] },
    metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1, 2], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.finalSeeds(experiment, { v: 1, seeds: [2] }, ctx); await ops.selection(experiment, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  attempt(experiment, BASE, "investigate", 1, 10); attempt(experiment, WIN, "investigate", 1, 12); await ops.investigateClose(experiment, ctx);
  await ops.gateDecide(experiment, "design", "approve", undefined, ctx); await ops.gateDecide(experiment, "final", "approve", undefined, ctx);
  attempt(experiment, BASE, "final", 2, 10); attempt(experiment, WIN, "final", 2, 12); await ops.finalClose(experiment, ctx);
  const failed = attempt(experiment, WIN, "posthoc", 1, 0, "failed"), unknown = attempt(experiment, WIN, "posthoc", 1, 0, "unknown");
  for (const dir of [survey, experiment]) {
    const events = readLedger(dir); fs.writeFileSync(join(dir, "ledger.jsonl"), events.map((event, index) => JSON.stringify({ ...event, at: `2030-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z` })).join("\n") + "\n");
  }
  for (const dir of [survey, experiment, gone]) addStudy(family, dir);
  fs.renameSync(gone, join(home, "moved"));
  return { home, family, survey, experiment, gone, failed, unknown };
}
const persistent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ares-console-conformance-"))), conf = await fixtures(persistent);
afterAll(() => fs.rmSync(persistent, { recursive: true, force: true }));
// T2 has no enabled write actions; every known/unknown action is explicitly refused below. T3 supplies destructive cases.
registerConsoleConformance(typed, { home: conf.family, destructive: [], assets: [`manuscript:${openStudy(conf.survey).study.id}`] });

const context = (home: string) => ({ home, log: (_line: string) => {}, features: ["inbox.form", "action.meta"] });
const rows = (value: unknown) => value as Record<string, any>[];

test("manifest, panels and stable inbox groups use real handlers without subprocess/network or writes", async () => {
  const f = await fixtures(fs.realpathSync(tempDir())), before = [f.family + "/research/studies.json", join(f.survey, "ledger.jsonl"), join(f.experiment, "ledger.jsonl")].map(path => [path, fs.readFileSync(path)] as const);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("network forbidden in console reads"); }) as unknown as typeof fetch);
  const spawnSpy = spyOn(child, "spawn").mockImplementation((() => { throw new Error("subprocess forbidden in console reads"); }) as typeof child.spawn);
  try {
    const provider = await typed.open(context(f.family)), snapshot = await provider.snapshot({ panel: "studies", after: 0 });
    expect(typed.manifest).toMatchObject({ api: 1, tool: "ares", pollMs: 15000, capabilities: { confirm: true, inbox: true, multiProject: false, search: false } });
    const summaries = rows(snapshot.studies); expect(summaries).toHaveLength(3);
    const exp = summaries.find(row => row.dir === f.experiment)!; expect(exp.attempts.byStatus).toMatchObject({ failed: 1, unknown: 1 }); expect(exp.final.status).toBe("qualified");
    expect(exp.review.ready).toBe(false); expect(summaries.find(row => row.dir === f.gone)).toMatchObject({ available: false });
    expect(readRegistry(f.family).studies).toContain(f.gone);
    const detail = await provider.snapshot({ panel: "study", study: f.survey, after: 0 }); expect((detail.study as any).manuscript.id).toBe(`manuscript:${openStudy(f.survey).study.id}`);
    const first = await provider.snapshot({ panel: "inbox", after: 0 }), second = await provider.snapshot({ panel: "inbox", after: 0 }), items = rows(first.items);
    expect(new Set(items.map(row => row.group))).toEqual(new Set(["decision", "candidate", "review", "alert"]));
    const candidate = items.filter(row => row.group === "candidate"); expect(candidate).toHaveLength(1); expect(candidate[0]!.detail).toContain("Synthetic human rubric"); expect(candidate[0]!.title).toBe("Synthetic live candidate");
    expect(items.some(row => row.kind === "skill" && row.verbs.some((verb: any) => verb.label === "Accept" && verb.form))).toBe(true);
    expect(items.some(row => row.kind === "review" && row.verbs.length === 0)).toBe(true);
    expect(items.filter(row => row.kind === "attempt")).toHaveLength(2); expect(items.some(row => row.kind === "watch")).toBe(true);
    expect(items.map(row => [row.id, row.at])).toEqual(rows(second.items).map(row => [row.id, row.at]));
    const actualTimes = new Set([...readLedger(f.survey), ...readLedger(f.experiment)].map(event => event.at));
    for (const item of items.filter(row => row.kind !== "unavailable")) expect(actualTimes.has(item.at)).toBe(true);
    for (const item of items) for (const verb of item.verbs) expect(verb.destructive).toBe(true);
    for (const action of ["gate", "screen", "skillDecide", "archiveConfirm", "unknown"]) expect((await provider.action({ action, confirmed: true }, { identity: "local", node: "local", via: "console" })).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled(); expect(spawnSpy).not.toHaveBeenCalled();
    for (const [path, bytes] of before) expect(fs.readFileSync(path)).toEqual(bytes);
  } finally { fetchSpy.mockRestore(); spawnSpy.mockRestore(); }
});

test("snapshot cursor is ledger-byte sum and unchanged views return an empty delta", async () => {
  const f = await fixtures(fs.realpathSync(tempDir())), provider = await typed.open(context(f.family));
  const first = await provider.snapshot({ panel: "studies", after: 0 }), expected = fs.statSync(join(f.survey, "ledger.jsonl")).size + fs.statSync(join(f.experiment, "ledger.jsonl")).size;
  expect(first.cursor).toBe(expected); expect(await provider.snapshot({ panel: "studies", after: expected })).toEqual({ cursor: expected, changed: false });
  const detail = await provider.snapshot({ panel: "study", study: f.survey, after: expected }); expect(detail.changed).toBe(true); expect((detail.study as any).dir).toBe(f.survey);
  const unknown = await provider.snapshot({ panel: "study", study: "/unregistered/synthetic", after: 0 }); expect(unknown.study).toBeNull(); expect(unknown.error).toContain("not registered");
  appendEvent(f.survey, actor, "synthetic.changed", {}); const next = await provider.snapshot({ panel: "studies", after: expected }); expect(next.changed).toBe(true); expect(next.cursor).not.toBe(expected);
});

test("only known current-built manuscript ids serve bounded plain text", async () => {
  const f = await fixtures(fs.realpathSync(tempDir())), provider = await typed.open(context(f.family));
  const asset = await provider.asset!({ id: `manuscript:${openStudy(f.survey).study.id}` }); expect(asset).toMatchObject({ mime: "text/plain", name: "manuscript.md" }); expect(Buffer.from(asset!.bytes).toString()).toBe("Synthetic manuscript.\n");
  for (const id of ["unknown", "manuscript:../../private", `manuscript:${openStudy(f.experiment).study.id}`]) expect(await provider.asset!({ id })).toBeNull();
  const built = join(f.survey, "paper", "build", "manuscript.md"); fs.unlinkSync(built); fs.symlinkSync(join(f.survey, "paper", "manuscript.md"), built);
  expect(await provider.asset!({ id: `manuscript:${openStudy(f.survey).study.id}` })).toBeNull();
});

test("console setup registers a verifiable plugin and changed module is stale", () => {
  const home = fs.realpathSync(tempDir()), family = join(home, "family"), env = { HOME: home, AGENTHUB_HOME: family };
  const report = runSetup("console", "apply", { env }); expect(report.applied).toBe(true);
  expect(scanPlugins(family).entries.find(row => row.tool === "ares")?.status).toBe("verified");
  const fake = fs.realpathSync(tempDir()); fs.mkdirSync(join(fake, "bin")); fs.mkdirSync(join(fake, "src", "ui"), { recursive: true });
  fs.writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "@staix/agent-research", version: "9.0.0" })); fs.writeFileSync(join(fake, "bin", "ares.js"), "// synthetic\n");
  fs.writeFileSync(join(fake, "src", "ui", "plugin.ts"), "export default {};\n"); const other = join(home, "other-family");
  const versioned = runSetup("console", "apply", { env: { ...env, AGENTHUB_HOME: other }, root: fake }); expect(versioned.applied).toBe(true);
  expect(scanPlugins(other).entries[0]?.status).toBe("verified"); fs.appendFileSync(join(fake, "src", "ui", "plugin.ts"), "// changed\n"); expect(scanPlugins(other).entries[0]?.status).toBe("stale");
});

test("registry CLI add/remove/list and setup console operate only on temp family paths", async () => {
  const home = fs.realpathSync(tempDir()), family = join(home, "family"), env = { HOME: home, AGENTHUB_HOME: family }, study = makeStudy(home, "cli");
  expect((await run(["console", "add", study, "--json"], env)).code).toBe(0); expect(JSON.parse((await run(["console", "list", "--json"], env)).text).studies).toEqual([fs.realpathSync(study)]);
  expect((await run(["setup", "console", "--json"], env)).code).toBe(0); expect(fs.existsSync(join(family, "console"))).toBe(false);
  expect((await run(["console", "remove", study, "--json"], env)).code).toBe(0); expect(JSON.parse((await run(["console", "list", "--json"], env)).text).studies).toEqual([]);
});

test("registry and availability changes refresh even when the ledger-byte cursor collides", async () => {
  const home = fs.realpathSync(tempDir()), family = join(home, "family"), first = makeStudy(home, "first"); addStudy(family, first);
  const provider = await typed.open(context(family)), initial = await provider.snapshot({ panel: "studies", after: 0 });
  const zero = makeStudy(home, "zero"); fs.writeFileSync(join(zero, "ledger.jsonl"), ""); addStudy(family, zero);
  const added = await provider.snapshot({ panel: "studies", after: initial.cursor as number }); expect(added.cursor).toBe(initial.cursor); expect(added.changed).toBe(true); expect(rows(added.studies)).toHaveLength(2);
  fs.renameSync(zero, join(home, "moved-zero"));
  const moved = await provider.snapshot({ panel: "studies", after: added.cursor as number }); expect(moved.cursor).toBe(added.cursor); expect(moved.changed).toBe(true); expect(rows(moved.studies).find(row => row.dir === zero)).toMatchObject({ available: false });
});


test("an unrelated ledger event does not change when an unchanged pending gate started waiting", async () => {
  const home = fs.realpathSync(tempDir()), family = join(home, "family"), study = makeStudy(home, "waiting"); addStudy(family, study);
  fs.writeFileSync(join(study, "literature", "candidates.json"), JSON.stringify([{ id: "doi:10.0000/waiting", title: "Synthetic included candidate", authors: [], sources: ["openalex"], status: "included", addedAt: "2030-01-01T00:00:00Z" }]));
  const provider = await typed.open(context(family)), first = await provider.snapshot({ panel: "inbox", after: 0 });
  const scope = rows(first.items).find(row => row.kind === "gate" && row.title.includes("screen"))!;
  appendEvent(study, actor, "synthetic.unrelated", {});
  const next = await provider.snapshot({ panel: "inbox", after: first.cursor as number });
  expect(rows(next.items).find(row => row.id === scope.id)?.at).toBe(scope.at);
});
