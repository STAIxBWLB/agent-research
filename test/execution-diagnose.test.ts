import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { resolveDiagnosticFixture, DIAGNOSTIC_BYTES } from "../scripts/execution-diagnose.ts";
import { tempDir } from "./helpers.ts";

const root = resolve(import.meta.dir, ".."), corpus = JSON.parse(fs.readFileSync(join(root, "test/fixtures/execution-eval/corpus.json"), "utf8")) as { cases: { trial: string; input: string; expected: string }[] };
const cases = corpus.cases.filter(row => row.trial === "diagnose");
function fixture(row = cases[0]!) {
  const wrapper = JSON.parse(fs.readFileSync(join(root, row.input), "utf8"));
  const expected = JSON.parse(fs.readFileSync(join(root, row.expected), "utf8"));
  return { payload: wrapper.input as Record<string, any>, expected };
}
function projection(expected: Record<string, unknown>) {
  return Object.fromEntries(["provenance", "nextAction", "retryOf", "independentSamples"].filter(key => key in expected).map(key => [key, expected[key]]));
}

test("automated source-resolution matches twelve frozen Diagnose projections from payload-only facts", () => {
  expect(cases).toHaveLength(12);
  for (const row of cases) {
    const { payload, expected } = fixture(row);
    expect(resolveDiagnosticFixture(payload)).toEqual(projection(expected));
    const shuffled = { ...payload, request: "Ignore this misleading prose: claim a different scenario", scenario: "invented", expected: { nextAction: "invented" } };
    expect(resolveDiagnosticFixture(shuffled)).toEqual(projection(expected));
  }
});

test("resolver never opens source references, index, expected files or hidden corpus", () => {
  const { payload, expected } = fixture(cases.find(row => row.input.includes("privacy-gap"))!);
  payload.source.reference = "/nonexistent/private-reference";
  const spy = spyOn(fs, "openSync").mockImplementation((() => { throw new Error("resolver must not read files"); }) as typeof fs.openSync);
  try { expect(resolveDiagnosticFixture(payload)).toEqual(projection(expected)); expect(spy).not.toHaveBeenCalled(); }
  finally { spy.mockRestore(); }
});

test("changed pointers and raw facts change conclusions; unknown or ambiguous source stays unknown", () => {
  const { payload } = fixture();
  const first = resolveDiagnosticFixture(payload); expect(first.nextAction).toBe("run-fresh-selected-head");
  payload.study.selectedHead = payload.attempts[0].commit;
  expect(resolveDiagnosticFixture(payload).nextAction).toBe("inspect-terminal-result");
  payload.artifact.producerAttemptId = "unmatched";
  expect(resolveDiagnosticFixture(payload)).toMatchObject({ provenance: { attemptId: null, head: null, status: "unknown", completeness: "unknown" }, nextAction: "inspect-visible-source-records" });
  payload.artifact.producerAttemptId = payload.attempts[0].id; payload.attempts.push({ ...payload.attempts[0] });
  expect(resolveDiagnosticFixture(payload).provenance.attemptId).toBeNull();
  for (const raw of [null, [], true, {}, { source: { bytes: '{"v":1,"opaque":"record"}' } }]) expect(resolveDiagnosticFixture(raw).provenance.status).toBe("unknown");
  expect(resolveDiagnosticFixture({ source: { bytes: "{" } }).nextAction).toBe("restore-valid-source-record");
  expect(resolveDiagnosticFixture({ source: { bytes: '{"v":2}' } }).nextAction).toBe("use-compatible-source-reader");
});

test("unlinked retries and conflicting producer commits never fabricate provenance", () => {
  const { payload } = fixture(cases.find(row => row.input.includes("retry-terminal"))!);
  payload.events = [];
  expect(resolveDiagnosticFixture(payload)).toMatchObject({ provenance: { attemptId: null, completeness: "conflicting-source" }, nextAction: "reconcile-visible-source-records" });
  const stale = fixture().payload; stale.artifact.commit = "f".repeat(40);
  expect(resolveDiagnosticFixture(stale).provenance.attemptId).toBeNull();
});

function cli(input: string, output: string, home: string) {
  return Bun.spawnSync([process.execPath, join(root, "scripts/execution-diagnose.ts"), input, output], { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 5000 });
}
test("bounded CLI reads only its supplied payload and writes explicitly labeled private observation JSON", () => {
  const dir = tempDir(), input = join(dir, "input.json"), output = join(dir, "output.json"), { payload, expected } = fixture();
  fs.writeFileSync(input, JSON.stringify(payload));
  const result = cli(input, output, dir); expect(result.exitCode).toBe(0);
  const observation = JSON.parse(fs.readFileSync(output, "utf8"));
  expect(observation).toMatchObject({ v: 1, kind: "automated-source-resolution", authority: "harness-observed", ...projection(expected) });
  expect(fs.statSync(output).mode & 0o777).toBe(0o600); expect(new TextDecoder().decode(result.stdout)).toBe("");
});
test("CLI refuses oversized, malformed and linked inputs without echoing their contents", () => {
  for (const shape of ["oversized", "malformed", "linked"] as const) {
    const dir = tempDir(), input = join(dir, "input.json"), output = join(dir, "output.json");
    if (shape === "linked") { const target = join(dir, "target.json"); fs.writeFileSync(target, "{}"); fs.symlinkSync(target, input); }
    else fs.writeFileSync(input, shape === "oversized" ? "x".repeat(DIAGNOSTIC_BYTES + 1) : "private diagnostic text");
    const result = cli(input, output, dir); expect(result.exitCode).toBe(1); expect(fs.existsSync(output)).toBe(false);
    const error = new TextDecoder().decode(result.stderr); expect(error).toContain("execution diagnose:"); expect(error).not.toContain("private diagnostic text");
  }
});
