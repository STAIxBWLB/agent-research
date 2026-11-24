import { expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import * as ops from "../src/commands.ts";
import { parseProbeFixture } from "../src/harness/receipts.ts";
import { parseContrast, recordHash } from "../src/harness/transitions.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { readTextBounded, readLedger, sha256 } from "../src/study.ts";
import { canonical } from "../src/plan/state.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const, id: "synthetic-judge" };
const ctx = { actor, http: fakeHttp([]).http };
const fingerprint = "a".repeat(64);
const legacy = {
  v: 1, id: "contrast-one", fingerprint, arm: "candidate", outcome: "improved", basis: "blinded-judgment", judge: "human",
  observations: "Synthetic sample", uncertainty: "Replay only", explanations: ["Synthetic explanation"],
  evidence: [{ probe: "fixture-probe", projectionSha256: "b".repeat(64) }],
};
type Verdict = "first" | "second" | "tie";
const paired = (baselineFirst: Verdict, armFirst: Verdict) => [
  { first: "baseline" as const, verdict: baselineFirst }, { first: "arm" as const, verdict: armFirst },
];

test("legacy contrasts keep their form bytes and canonical receipt identity", () => {
  const parsed = parseContrast(legacy);
  expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacy));
  expect(recordHash(parsed, actor, fingerprint)).toBe(sha256(canonical({ form: legacy, actor, binding: fingerprint })));
  const normalized = parseContrast({ ...legacy, presentations: paired("second", "first") });
  expect(recordHash(normalized, actor, fingerprint)).not.toBe(recordHash(parsed, actor, fingerprint));
});

test("all swapped verdict combinations require exactly one outcome", () => {
  const results = [
    ["first", "first", "inconclusive"], ["first", "second", "regressed"], ["first", "tie", "inconclusive"],
    ["second", "first", "improved"], ["second", "second", "inconclusive"], ["second", "tie", "inconclusive"],
    ["tie", "first", "inconclusive"], ["tie", "second", "inconclusive"], ["tie", "tie", "unchanged"],
  ] as const;
  for (const [baseline, arm, outcome] of results) {
    const presentations = paired(baseline, arm);
    for (const candidate of ["improved", "unchanged", "regressed", "inconclusive"]) {
      const form = { ...legacy, outcome: candidate, presentations };
      if (candidate === outcome) {
        expect(parseContrast(form).presentations).toEqual(presentations);
        expect(parseContrast({ ...form, presentations: [...presentations].reverse() }).outcome).toBe(outcome);
      } else expect(() => parseContrast(form)).toThrow(`require outcome: ${outcome}`);
    }
  }
});

test("presentations refuse unblinded bases and malformed orders", () => {
  for (const basis of ["deterministic-check", "actor-claim"]) {
    const { judge: _judge, ...original } = legacy;
    expect(() => parseContrast({ ...original, basis, presentations: paired("second", "first") })).toThrow("require basis: blinded-judgment");
  }
  const repeated = [{ first: "baseline", verdict: "second" }, { first: "baseline", verdict: "first" }];
  expect(() => parseContrast({ ...legacy, presentations: repeated })).toThrow("alternate which output is first");
  for (const presentations of [null, [], [paired("second", "first")[0]], [{ first: "baseline", verdict: "arm" }, { first: "arm", verdict: "first" }]]) {
    expect(() => parseContrast({ ...legacy, presentations })).toThrow("harness transition");
  }
});

test("the round and composition project order control without changing stored forms or CLI/MCP parity", async () => {
  const dir = tempDir();
  const fixture = (name: string) => parseProbeFixture(JSON.parse(readTextBounded(join(import.meta.dir, "fixtures", "harness-rounds", `${name}.json`), 65_536)));
  const base = fixture("baseline"), candidate = fixture("candidate"), round = "round-one";
  ops.init(dir, { question: "Synthetic blinded judgments", mode: "experiment", autonomy: "auto" }, ctx);
  await ops.harnessSet(dir, {
    v: 1, id: round, task: { id: base.taskId, inputSha256: base.taskInputHash }, baseline: { guidanceSha256: base.baselineHash },
    candidates: [{ id: candidate.arm, guidanceSha256: candidate.guidanceHash }], hypothesis: { deficiency: "Synthetic", predictedChange: "Synthetic" },
    experience: [], authoring: "uncontrolled-authoring",
  }, ctx);
  await ops.harnessImport(dir, round, base, ctx);
  await ops.harnessImport(dir, round, candidate, ctx);
  const view = () => ops.harnessShow(dir, round).rounds[0]!.transitions;
  const evidence = ops.harnessShow(dir, round).rounds[0]!.probes.map(probe => ({ probe: probe.projection.id, projectionSha256: probe.projectionSha256 }));
  const form = { ...legacy, evidence, fingerprint: view().fingerprint };
  await ops.harnessContrast(dir, round, form, ctx);
  const old = view().contrasts[0]!;
  expect(old.orderControl).toBe("none");
  expect(old.sha256).toBe(recordHash(form, actor, old.binding));

  const before = readLedger(dir);
  const newForm = { ...form, id: "contrast-swapped", fingerprint: view().fingerprint, presentations: paired("second", "first") };
  await expect(ops.harnessContrast(dir, round, { ...newForm, outcome: "regressed" }, ctx)).rejects.toThrow("require outcome: improved");
  expect(readLedger(dir)).toEqual(before);
  await ops.harnessContrast(dir, round, newForm, ctx);
  const current = view();
  expect(current.contrasts.map(entry => entry.orderControl)).toEqual(["none", "swapped"]);
  expect(current.orderControlCounts).toEqual({ swapped: 1, none: 1 });

  await ops.harnessCompose(dir, round, {
    v: 1, id: "composition-one", fingerprint: current.fingerprint, successorSha256: null,
    sections: [{ section: "Synthetic section", decision: "keep", reason: "Synthetic decision",
      contrasts: current.contrasts.map(contrast => ({ id: contrast.form.id, sha256: contrast.sha256 })) }],
  }, ctx);
  expect(view().composition?.sectionOrderControl).toEqual([{ section: "Synthetic section", orderControlled: 1 }]);
  expect(view().composition?.form.sections[0]).not.toHaveProperty("orderControlled");
  const cli = await run(["harness", "show", dir, "--round", round, "--json"], {}, ctx);
  const server = createAresMcp({}, ctx.http);
  expect(JSON.parse(cli.text)).toEqual(await server.handlers.ares_harness_show!({ study: dir, round }));
});
