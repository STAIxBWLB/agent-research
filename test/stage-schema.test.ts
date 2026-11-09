import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateDecide, gateList } from "../src/commands.ts";
import { expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { readExecutor } from "../src/exp/executor.ts";
import { collectStageEvidence } from "../src/exp/metrics.ts";
import { validateStageProtocol } from "../src/exp/stages.ts";
import { metricAttempt, metricProtocol, metricTar } from "./metric-fixtures.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

function staged() {
  const p = metricProtocol();
  return validateStageProtocol({ ...p, v: 2, candidate: { stages: [{ name: "prepare", ...p.candidate, seed: true, code: "snapshot", needs: [], inputs: {}, outputs: { rows: "rows" } }] } });
}
test("MCP schema accepts both protocol versions and closes data-source unions", () => {
  const schema = ARES_TOOLS.find(tool => tool.name === "ares_protocol_set")!.inputSchema;
  expect(validArguments({ study: "/synthetic", protocol: metricProtocol() }, schema)).toBe(true);
  expect(validArguments({ study: "/synthetic", protocol: staged() }, schema)).toBe(true);
  expect(validArguments({ study: "/synthetic", protocol: { ...staged(), v: 3 } }, schema)).toBe(false);
  const p = staged(); p.candidate.stages[0]!.inputs.data = { task: "file" };
  expect(validArguments({ study: "/synthetic", protocol: p }, schema)).toBe(true);
  p.candidate.stages[0]!.inputs.data = { task: "file", stage: "other", output: "rows" } as { task: string };
  expect(validArguments({ study: "/synthetic", protocol: p }, schema)).toBe(false);
});
test("CLI and MCP configure byte caps up to one TiB without the generic seven-digit limit", async () => {
  const http = fakeHttp([]).http, server = createAresMcp({}, http);
  for (const cap of [1, 1073741824, 1099511627776]) {
    const dir = tempDir(); await run(["init", dir, "--question", "Synthetic?", "--mode", "experiment"], {}, { http });
    await run(["executor", "set", dir, "--kind", "local", "--workdir", "/synthetic/executor", "--retention-cap-bytes", String(cap)], {}, { http });
    expect(readExecutor(dir)?.retentionCapBytes).toBe(cap);
    await server.handlers.ares_executor_set!({ study: dir, kind: "local", workdir: "/synthetic/executor", retentionCapBytes: cap });
    expect(readExecutor(dir)?.retentionCapBytes).toBe(cap);
    for (const bad of ["0", "1099511627777", "1.5", "1e9"]) await expect(run(["executor", "set", dir, "--kind", "local", "--workdir", "/synthetic/executor", "--retention-cap-bytes", bad], {}, { http })).rejects.toThrow();
  }
});
test("default stage collector uses the named candidate log namespace", async () => {
  const attempt = metricAttempt(); attempt.stage = "candidate";
  attempt.pipeline = { definition: staged(), index: 0, completed: [], inputHashes: {}, taskTreeHash: "f".repeat(64) };
  const evidence = await collectStageEvidence(attempt, "candidate", async request => {
    if (!request.stdoutSink) throw new Error("synthetic stream sink required");
    const bytes = request.command === "sh" ? metricTar([
      { path: "logs/candidate-prepare.stdout.log", data: "synthetic output" }, { path: "logs/candidate-prepare.stderr.log", data: "" },
      { path: "logs/candidate-prepare.state.json", data: '{"stdout":false,"stderr":false}' },
    ]) : metricTar([{ path: "rows", data: "synthetic rows" }]);
    await request.stdoutSink(bytes); return { exitCode: 0, stdout: "", stderr: "" };
  });
  expect(evidence.logs.stdout.path).toEndWith("logs/candidate-prepare.stdout.log");
  expect(evidence.outputs).toHaveLength(1);
});

test("CLI/MCP share the optional declaration-only pure-artifact contract and reopen its design seal", async () => {
  const reuse = { v: 1, kind: "pure-artifact", inputs: "declared-only", externalState: "none", writableState: "fresh-output-only", modelOutputs: "forbidden", determinism: "byte-exact", toolchain: { description: "Synthetic deterministic toolchain", documentationSha256: "f".repeat(64) } };
  const value = staged(), raw = { ...value, candidate: { stages: value.candidate.stages.map(stage => ({ ...stage, reuse })) } };
  const schema = ARES_TOOLS.find(tool => tool.name === "ares_protocol_set")!.inputSchema;
  expect(validArguments({ study: "/synthetic", protocol: raw }, schema)).toBe(true);
  expect(validArguments({ study: "/synthetic", protocol: { ...raw, candidate: { stages: raw.candidate.stages.map(stage => ({ ...stage, reuse: { ...reuse, reviewed: true } })) } } }, schema)).toBe(false);
  const http = fakeHttp([]).http, mcp = createAresMcp({}, http), dirs = [tempDir(), tempDir()];
  for (const dir of dirs) {
    await run(["init", dir, "--question", "Synthetic?", "--mode", "experiment"], {}, { http });
    mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic task");
  }
  const before = JSON.parse((await run(["protocol", dirs[0]!, "--file", "-", "--json"], {}, { http, readStdin: async () => JSON.stringify(value) })).text);
  await gateDecide(dirs[0]!, "design", "approve", undefined, { actor: { kind: "person" }, http });
  expect(gateList(dirs[0]!).find(gate => gate.gate === "design")?.state).toBe("approved");
  const cli = JSON.parse((await run(["protocol", dirs[0]!, "--file", "-", "--json"], {}, { http, readStdin: async () => JSON.stringify(raw) })).text);
  const remote = await mcp.handlers.ares_protocol_set!({ study: dirs[1]!, protocol: raw }) as typeof cli;
  expect(cli.protocolHash).not.toBe(before.protocolHash);
  expect(gateList(dirs[0]!).find(gate => gate.gate === "design")?.state).toBe("pending");
  expect(cli.protocol).toEqual(remote.protocol); expect(cli.protocolHash).toBe(remote.protocolHash);
  const invalid = { ...raw, candidate: { stages: raw.candidate.stages.map(stage => ({ ...stage, reuse: { ...reuse, modelOutputs: "allowed" } })) } };
  const saved = ["design/protocol.json", "ledger.jsonl"].map(file => readFileSync(join(dirs[1]!, file)));
  await expect(mcp.handlers.ares_protocol_set!({ study: dirs[1]!, protocol: invalid })).rejects.toThrow("no model-output caching");
  for (const [i, file] of ["design/protocol.json", "ledger.jsonl"].entries()) expect(readFileSync(join(dirs[1]!, file))).toEqual(saved[i]!);
});
