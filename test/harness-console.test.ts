import {expect, mock, spyOn, test} from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
import {join} from "node:path";
import {createPlugin} from "../src/ui/plugin.ts";
import * as ops from "../src/commands.ts";
import {addStudy} from "../src/console/registry.ts";
import {readBytesBounded, readTextBounded, readLedger, writeAtomic} from "../src/study.ts";
import {fakeHttp, tempDir} from "./helpers.ts";

const bound = 1024 * 1024;
function definition(id = "round-one", task = "synthetic-task") {return {v: 1, id, task: {id: task, inputSha256: "a".repeat(64)}, baseline: {guidanceSha256: "b".repeat(64)}, candidates: [{id: "candidate", guidanceSha256: "c".repeat(64)}], hypothesis: {deficiency: "Synthetic missing check", predictedChange: "Synthetic explicit check"}, experience: [], authoring: "uncontrolled-authoring"};}
async function fixture() {
  const home = fs.realpathSync(tempDir()), family = join(home, "family"), dir = join(home, "study"), ctx = {actor: {kind: "person" as const}, http: fakeHttp([]).http};
  ops.init(dir, {question: "Synthetic producer harness view", mode: "experiment"}, ctx); addStudy(family, dir);
  const plugin = createPlugin({env: {HOME: home, AGENTHUB_HOME: family}, runner: async () => {throw new Error("no process in console polling");}});
  return {home, family, dir, ctx, plugin, provider: await plugin.open({home: family, log: () => {}})};
}

test("explicit harness panel reads fresh experiments and selected native rounds only", async () => {
  const f = await fixture();
  expect(f.plugin.manifest.panels.find(panel => panel.id === "harness")?.title).toBe("Harness rounds");
  expect((await f.provider.snapshot({panel: "harness", study: f.dir, after: 0})).harness).toEqual(ops.harnessShow(f.dir));
  await ops.harnessSet(f.dir, definition(), f.ctx); await ops.harnessSet(f.dir, definition("round-two", "synthetic-other"), f.ctx);
  const original = readBytesBounded(join(f.dir, "ledger.jsonl"), bound);
  for (const round of [undefined, "round-one", "round-two"]) {
    const result = await f.provider.snapshot({panel: "harness", study: f.dir, after: 0, ...(round ? {round} : {})});
    expect(result.harness).toEqual(ops.harnessShow(f.dir, round));
    expect(result.study).toMatchObject({dir: f.dir, mode: "experiment"});
  }
  expect(readBytesBounded(join(f.dir, "ledger.jsonl"), bound)).toEqual(original);
  expect(f.plugin.manifest.capabilities.actions.some(action => action.startsWith("harness"))).toBe(false);
});

test("harness params have a separate strict allowlist and invalid input refuses before reads", async () => {
  const f = await fixture(), open = fs.openSync, opened: string[] = [];
  const spy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {opened.push(String(file)); return open(file, flags, mode);}) as typeof fs.openSync);
  try {
    for (const extra of [{attempts: "a".repeat(16)}, {rootId: "native"}, {graphCursor: "opaque"}, {roundTypo: "round-one"}]) {
      const result = await f.provider.snapshot({panel: "harness", study: f.dir, after: 0, ...extra});
      expect(result.error).toContain("allowed fields: panel, study, after, round"); expect(result.harness).toBeNull();
    }
    for (const round of ["", "../round", "_bad", "a\n", "한", "x".repeat(65), 1]) {
      const result = await f.provider.snapshot({panel: "harness", study: f.dir, round, after: 0}); expect(result.error).toContain("invalid round"); expect(result.harness).toBeNull();
    }
    expect(opened).toEqual([]);
  } finally {spy.mockRestore();}
});

test("harness view keys include round and same-cursor corruption/repair changes the payload", async () => {
  const f = await fixture(); await ops.harnessSet(f.dir, definition(), f.ctx); await ops.harnessSet(f.dir, definition("round-two", "synthetic-other"), f.ctx);
  const a = await f.provider.snapshot({panel: "harness", study: f.dir, round: "round-one", after: 0});
  expect((await f.provider.snapshot({panel: "harness", study: f.dir, round: "round-two", after: a.cursor as number})).changed).toBe(true);
  expect(await f.provider.snapshot({panel: "harness", study: f.dir, round: "round-one", after: a.cursor as number})).toEqual({cursor: a.cursor, changed: false});
  const file = join(f.dir, "design", "harness.json"), original = readTextBounded(file, bound); writeAtomic(file, "{", bound);
  const bad = await f.provider.snapshot({panel: "harness", study: f.dir, round: "round-one", after: a.cursor as number});
  expect(bad.cursor).toBe(a.cursor); expect(bad.changed).toBe(true); expect(bad.harness).toBeNull(); expect(bad.error).toBeString();
  writeAtomic(file, original, bound);
  const repaired = await f.provider.snapshot({panel: "harness", study: f.dir, round: "round-one", after: a.cursor as number}); expect(repaired.changed).toBe(true); expect(repaired.harness).toEqual(a.harness);
});

test("unregistered, moved and redirected studies never invoke the harness reader", async () => {
  const f = await fixture(), show = spyOn(ops, "harnessShow");
  try {
    const choices = await f.provider.snapshot({panel: "harness", after: 0}); expect(choices.harness).toBeNull(); expect(choices.studies).toEqual([{dir: f.dir}]);
    expect((await f.provider.snapshot({panel: "harness", study: join(f.home, "unregistered"), after: 0})).harness).toBeNull();
    const moved = join(f.home, "moved"); fs.renameSync(f.dir, moved);
    expect((await f.provider.snapshot({panel: "harness", study: f.dir, after: 0})).error).toContain("missing or now resolves elsewhere");
    fs.symlinkSync(moved, f.dir);
    expect((await f.provider.snapshot({panel: "harness", study: f.dir, after: 0})).error).toContain("missing or now resolves elsewhere");
    expect(show).not.toHaveBeenCalled();
  } finally {show.mockRestore();}
});

test("harness polling stays local/read-only, and overview/inbox never call harnessShow", async () => {
  const f = await fixture(); await ops.harnessSet(f.dir, definition(), f.ctx); const original = readBytesBounded(join(f.dir, "ledger.jsonl"), bound);
  const forbidden = (): never => {throw new Error("console read side effect forbidden");}, preconnect = mock(forbidden);
  const writes = [spyOn(fs, "writeSync").mockImplementation(forbidden), spyOn(fs, "appendFileSync").mockImplementation(forbidden), spyOn(fs, "renameSync").mockImplementation(forbidden), spyOn(fs, "mkdirSync").mockImplementation(forbidden)];
  const processes = [spyOn(child, "spawn").mockImplementation(forbidden), spyOn(child, "spawnSync").mockImplementation(forbidden), spyOn(Bun, "spawn").mockImplementation(forbidden), spyOn(Bun, "spawnSync").mockImplementation(forbidden)], fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(forbidden, {preconnect})), show = spyOn(ops, "harnessShow");
  try {
    expect((await f.provider.snapshot({panel: "harness", study: f.dir, after: 0})).harness).toEqual(ops.harnessShow(f.dir)); show.mockClear();
    await f.provider.snapshot({panel: "studies", after: 0}); await f.provider.snapshot({panel: "inbox", after: 0}); expect(show).not.toHaveBeenCalled();
    for (const spy of [...writes, ...processes, fetch, preconnect]) expect(spy).not.toHaveBeenCalled();
  } finally {writes.forEach(spy => spy.mockRestore()); processes.forEach(spy => spy.mockRestore()); fetch.mockRestore(); preconnect.mockRestore(); show.mockRestore();}
  expect(readBytesBounded(join(f.dir, "ledger.jsonl"), bound)).toEqual(original);
});

test("harness gate waiting time follows only its definition binding, not transition/probe activity", async () => {
  const {gateWaitingTimes} = await import("../src/ui/plugin.ts");
  const f = await fixture(); await ops.harnessSet(f.dir, definition(), f.ctx);
  const original = readLedger(f.dir).find(event => event.type === "harness.round.set")!;
  const first = {...original, at: "2030-01-01T00:00:00Z"}, later = {...original, at: "2030-01-02T00:00:00Z"};
  const irrelevant = {...later, type: "harness.contrast.recorded", data: {round: "round-one"}};
  expect(gateWaitingTimes([first, later, irrelevant], {}).get("harness:round-one")).toBe(first.at);
  const changed = {...later, data: {...later.data, binding: "b".repeat(64)}};
  expect(gateWaitingTimes([first, irrelevant, changed], {}).get("harness:round-one")).toBe(changed.at);
});
