import { expect, test } from "bun:test";
import { ROLE_SGR, paint } from "@staix/cli-output";
import { cellWidth, fillMessage, renderResult } from "../src/cli-output.ts";
import { COMMANDS } from "../src/commands-table.ts";
import { run } from "../src/cli.ts";
import { experimentTree, experimentFixture } from "./exp-fixture.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
import * as ops from "../src/commands.ts";
import expectedGoldens from "./fixtures/cli-human-output-v1.json";

const now = Date.parse("2026-01-02T00:00:00Z");
const values = { dir: "/work/synthetic study", "--file": "refs.json" };
const context = { now, values, args: ["retention", "prune", values.dir, "--file", values["--file"]] };
const esc = ROLE_SGR.header[0]!;
const render = (command: string, result: unknown, code = 0, color = false, ascii = false) => renderResult(command, result, code, color, ascii, 80, context);

const cases = [
  ["selection calibrate", { method: "seed-sd", recommendedMinDelta: 0.5, sha256: "a".repeat(64) },
    ["Recorded the calibration recommendation", "Recommendation", "seed-sd", "0.5"]],
  ["status", { question: "Synthetic?", mode: "survey", scope: { set: true }, gates: [{ gate: "scope", state: "pending", current: "private-sha" }], literature: { unverified: 1 }, events: 99 },
    ["▸ Attention", "ares gate approve '/work/synthetic study' scope", "▸ Study", "▸ Gates"]],
  ["lit list", { total: 1, candidates: [{ id: "doi:10.0000/example", year: 2024, status: "included", verified: true, title: "Synthetic title", abstract: "Hidden abstract", authors: ["Hidden author"] }] },
    ["ID", "YEAR", "STATUS", "VERIFIED", "TITLE", "Synthetic title"]],
  ["attempt show", { id: "1234", run: "investigate", seed: 1, status: "unknown", startedAt: "2026-01-01T00:00:00Z", protocolHash: "private-sha" },
    ["▸ Attention", "▸ Attempt", "1d ago"]],
  ["plan show", { definition: { nodes: [{ id: "scope", kind: "gate" }] }, controller: "none", binding: "private-sha" },
    ["Controller:", "▸ Definition"]],
  ["paper check", { ok: false, rendered: "Hidden manuscript", findings: [{ severity: "warning", line: 3, column: 2, code: "warning", message: "Synthetic warning" }, { severity: "blocking", line: 2, column: 1, code: "bad-format", message: "Synthetic failure" }] },
    ["▸ Failures", "2:1 bad-format: Synthetic failure", "▸ Warnings", "3:2 warning: Synthetic warning", "1 failed"]],
  ["scope", { changed: true, id: "scope-one" }, ["✓", "scope-one", "ares gate list '/work/synthetic study'"]],
  ["retention prune", { fingerprint: "a".repeat(64), pruned: 0 }, ["▸ Preview", "--file refs.json", "--confirm", "a".repeat(64)]],
  ["attempt logs", { logs: [{ stage: "candidate", stream: "stdout", text: `hello ${ROLE_SGR.error}world` }] }, ["▸ candidate stdout", "hello world"]],
] as const;

for (const [command, result, snippets] of cases) {
  test(`human output golden: ${command}`, () => {
    const plain = render(command, result), colored = render(command, result, 0, true);
    for (const snippet of snippets) expect(plain).toContain(snippet);
    for (const output of [plain, colored]) {
      expect(output).toBe(output.trimEnd());
      expect(output).not.toContain("\n\n\n");
      for (const line of output.split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(80);
    }
    expect(plain).not.toMatch(/Hidden|private-sha/);
    expect(plain).not.toContain(esc);
    expect(colored.split("\n")[0]).toBe(paint([{ text: plain.split("\n")[0]!, role: "header" }], true));
  });
}

test("ASCII markers and concrete arguments use the package", () => {
  expect(render("status", { gates: [{ gate: "scope", state: "pending" }] }, 0, false, true)).toContain("> Attention\n  !  scope gate is pending");
  expect(fillMessage("run ares executor inputs hash <dir> <path> --file PATH|-", { ...values, path: "input path" }))
    .toBe("run ares executor inputs hash '/work/synthetic study' 'input path' --file refs.json");
});

test("human executor checks continue after independent failures, while JSON keeps the first failure", async () => {
  const dir = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic?", mode: "experiment" }, ctx);
  experimentTree(dir);
  await ops.protocol(dir, experimentFixture(dir).protocol, ctx);
  await ops.executorSet(dir, { v: 1, kind: "local", workdir: "/synthetic" }, ctx);
  const seen: string[] = [];
  const io = { ...ctx, runner: async ({ command, args }: { command: string; args: string[] }) => {
    seen.push(`${command} ${args[0]}`);
    return { exitCode: 1, stdout: "", stderr: "private transport diagnostic" };
  } };
  const human = await run(["executor", "check", dir], { LANG: "C", COLUMNS: "80" }, io);
  expect(human.code).toBe(1);
  expect(human.text).toContain("Docker server version");
  expect(human.text).toContain("UID");
  expect(human.text).toContain("GID");
  expect(human.text).toContain("Skipped");
  expect(human.text).not.toContain("private transport diagnostic");
  expect(seen).toEqual(["docker version", "id -u", "id -g"]);
  seen.length = 0;
  await expect(run(["executor", "check", dir, "--json"], {}, io)).rejects.toThrow("Docker server version failed");
  expect(seen).toEqual(["docker version"]);

  await ops.executorSet(dir, { v: 1, kind: "ssh", host: "synthetic", workdir: "/synthetic" }, ctx);
  seen.length = 0;
  const unavailable = await run(["executor", "check", dir], { LANG: "C", COLUMNS: "80" }, io);
  expect(unavailable.code).toBe(1);
  expect(unavailable.text).toContain("SSH connection failed");
  expect(unavailable.text).toContain("Executor unavailable");
  expect(seen).toEqual(["ssh -o"]);
});

test("every rendered command has 80-cell plain and colored goldens", () => {
  const goldens: Record<string, string[]> = {};
  for (const spec of COMMANDS) {
    if (spec.name === "playbook" || spec.name === "mcp") continue;
    const specific = cases.find(([name]) => name === spec.name)?.[1];
    const sample = specific ?? { id: "synthetic", state: "available", changed: true, startedAt: "2026-01-01T00:00:00Z" };
    const example = spec.example?.split(" ") ?? [];
    const request = { ...context, args: [...spec.name.split(" "), ...example] };
    const versions = [false, true].map(color => {
      const output = renderResult(spec.name, sample, 0, color, false, 80, request);
      for (const line of output.split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(80);
      expect(output).toBe(output.trimEnd());
      expect(output).not.toContain("\n\n\n");
      return output;
    });
    goldens[spec.name] = versions;
  }
  expect(goldens).toEqual(expectedGoldens);
});
