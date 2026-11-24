import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { paperRenderDir } from "../src/paper/render.ts";
import { readLedger, sha256 } from "../src/study.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const resume = (dir: string, id = "resume") => ops.planControl(dir, { action: "resume", commandId: id, expectedRevision: ops.planShow(dir).revision }, ctx);
/** Synthetic renderer: writes a fixed document and a renderReceipt v1 for the current build into {out}. */
function renderer(mode: "ok" | "fail" | "hang" | "no-receipt" = "ok") {
  const bin = join(tempDir(), "fake-render");
  writeFileSync(bin, `#!/bin/sh
study="$1"; out="$2"
case "${mode}" in fail) echo synthetic failure >&2; exit 3;; hang) sleep 30;; no-receipt) printf 'doc' > "$out/paper.pdf"; exit 0;; esac
printf '%%PDF synthetic render' > "$out/paper.pdf"
ev=$(shasum -a 256 "$study/paper/build/evidence.json" | cut -d' ' -f1)
ms=$(shasum -a 256 "$study/paper/build/manuscript.md" | cut -d' ' -f1)
pdf=$(shasum -a 256 "$out/paper.pdf" | cut -d' ' -f1)
printf '{"v":1,"tool":"fake-render","version":"v1","environment":"fixture","evidenceSha256":"%s","manuscriptSha256":"%s","template":"plain","outputs":[{"name":"paper.pdf","sha256":"%s","pages":1}]}' "$ev" "$ms" "$pdf" > "$out/receipt.json"
`);
  chmodSync(bin, 0o755); return bin;
}
async function setup() {
  const dir = tempDir(), home = tempDir(), env = { ...process.env, AGENTHUB_HOME: home };
  ops.init(dir, { question: "synthetic" }, ctx); mkdirSync(join(dir, "paper"));
  writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic cohort {{lit:2026}}.\n");
  return { dir, home, env };
}
const plan = { v: 1, nodes: [{ id: "build", kind: "step", command: "paper.build", args: {} }, { id: "render", kind: "step", command: "paper.render", args: {}, needs: ["build"] }, { id: "inspect", kind: "gate", needs: ["render"], binds: ["render"] }], edges: [] };
async function runPlan(dir: string, env: NodeJS.ProcessEnv) {
  let resumed = false, approved = false;
  return ops.planRun(dir, { env }, { ...ctx, sleep: async () => {
    if (!resumed) { resumed = true; await resume(dir); }
    else if (!approved && ops.gateList(dir).find(g => g.gate === "plan:inspect")?.state === "pending") { approved = true; await ops.gateDecide(dir, "plan:inspect", "approve", undefined, ctx); }
    await Bun.sleep(1);
  } });
}

test("AC1: paper.build then paper.render binds a plan gate to the rendered output hash", async () => {
  const { dir, env } = await setup();
  ops.rendererSet(dir, { command: [renderer(), "{study}", "{out}"] }, env);
  await ops.planSet(dir, plan, ctx);
  const state = await runPlan(dir, env), pdf = readFileSync(join(paperRenderDir(dir), "paper.pdf"));
  expect(state.state).toBe("done");
  expect(state.nodes.find(n => n.id === "render")!.output).toEqual({ sha256: sha256(pdf) });
  expect(ops.gateList(dir).find(g => g.gate === "plan:inspect")?.state).toBe("approved");
  expect(readLedger(dir).filter(e => e.type === "paper.rendered")).toHaveLength(1);
  expect(ops.paperRenderShow(dir).current).toBe(true);
});

test("AC2: without a configured renderer the step fails naming ares renderer set; plan validation accepts it", async () => {
  const { dir, env } = await setup();
  await ops.planSet(dir, plan, ctx);
  const stop = new AbortController();
  let resumed = false;
  const state = await ops.planRun(dir, { env }, { ...ctx, signal: stop.signal, sleep: async () => {
    if (!resumed) { resumed = true; await resume(dir); }
    else if (ops.planShow(dir).nodes.find(n => n.id === "render")?.status === "failed") stop.abort();
    await Bun.sleep(1);
  } }), node = state.nodes.find(n => n.id === "render")!;
  expect(node.status).toBe("failed"); expect(node.reason).toContain("ares renderer set");
  expect(readLedger(dir).some(e => e.type === "paper.rendered")).toBe(false);
  expect(ops.rendererShow(dir, env)).toMatchObject({ configured: false });
  expect(ops.rendererCheck(dir, env).ok).toBe(false);
});

test("AC3: a renderer command in plan.json or a committed study file is refused", async () => {
  const { dir, env } = await setup();
  await expect(ops.planSet(dir, { ...plan, nodes: [plan.nodes[0], { ...plan.nodes[1], args: { command: "sh" } }, plan.nodes[2]] }, ctx)).rejects.toThrow("paper.render takes no arguments");
  ops.rendererSet(dir, { command: [renderer(), "{study}", "{out}"] }, env);
  writeFileSync(join(dir, "renderer.json"), JSON.stringify({ v: 1, command: ["sh", "-c", "true"] }));
  await ops.paperBuild(dir, ctx);
  await expect(ops.paperRenderStep(dir, ctx, env)).rejects.toThrow("committed renderer.json");
  expect(ops.rendererCheck(dir, env).checks.find(c => c.name === "Committed renderer")?.state).toBe("failed");
  expect(existsSync(paperRenderDir(dir))).toBe(false);
  expect(() => ops.rendererSet(dir, { command: ["{study}"] }, env)).toThrow("cannot contain a placeholder");
});

test("AC4: timeout, nonzero exit and a missing receipt fail with no partial files or paper.rendered event", async () => {
  const { dir, env } = await setup(); await ops.paperBuild(dir, ctx);
  for (const [mode, timeoutS, reason] of [["fail", 60, "exited with status 3"], ["hang", 1, "timed out"], ["no-receipt", 60, "receipt missing or invalid"]] as const) {
    ops.rendererSet(dir, { command: [renderer(mode), "{study}", "{out}"], timeoutS }, env);
    const ledger = readFileSync(join(dir, "ledger.jsonl"));
    await expect(ops.paperRenderStep(dir, ctx, env)).rejects.toThrow(reason);
    expect(existsSync(paperRenderDir(dir))).toBe(false);
    expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  }
}, 30_000);

test("AC5: a retried render with an unchanged build and identical output is a no-op", async () => {
  const { dir, env } = await setup(); await ops.paperBuild(dir, ctx);
  ops.rendererSet(dir, { command: [renderer(), "{study}", "{out}"] }, env);
  const first = await ops.paperRenderStep(dir, ctx, env), ledger = readFileSync(join(dir, "ledger.jsonl"));
  const second = await ops.paperRenderStep(dir, ctx, env);
  expect(first.changed).toBe(true); expect(second).toEqual({ ...first, changed: false });
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
});

test("renderer set stays machine-local; CLI and MCP agree; usage errors exit 2", async () => {
  const { dir, home, env } = await setup(), bin = renderer();
  const cli = await run(["renderer", "set", dir, "--command", JSON.stringify([bin, "{study}", "{out}"]), "--timeout-s", "30", "--json"], env);
  expect(cli.code).toBe(0);
  expect(existsSync(join(home, "research", "renderers", `${JSON.parse(readFileSync(join(dir, "study.json"), "utf8")).id}.json`))).toBe(true);
  expect(readLedger(dir).some(e => e.type.startsWith("renderer"))).toBe(false);
  expect(JSON.parse((await run(["renderer", "show", dir, "--json"], env)).text)).toMatchObject({ configured: true, timeoutS: 30 });
  expect((await run(["renderer", "check", dir, "--json"], env)).code).toBe(0);
  const mcp = createAresMcp(env, fakeHttp([]).http);
  expect(await mcp.handlers.ares_renderer_show!({ study: dir })).toMatchObject({ configured: true, command: [bin, "{study}", "{out}"] });
  mcp.terminate();
  const cliPath = join(import.meta.dir, "..", "bin", "ares.js");
  for (const args of [[], ["--command", "not-json"]]) {
    const result = Bun.spawnSync([process.execPath, cliPath, "renderer", "set", dir, ...args], { env: { PATH: process.env.PATH, LANG: "C.UTF-8", AGENTHUB_HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
  }
});

test("tests never touch the real family home: every renderer path takes an explicit AGENTHUB_HOME", async () => {
  const real = join(process.env.AGENTHUB_HOME?.trim() || join(process.env.HOME ?? "", ".agenthub"), "research", "renderers");
  const { dir, home, env } = await setup();
  ops.rendererSet(dir, { command: [renderer(), "{study}", "{out}"] }, env);
  const id = JSON.parse(readFileSync(join(dir, "study.json"), "utf8")).id;
  expect(existsSync(join(home, "research", "renderers", `${id}.json`))).toBe(true);
  expect(existsSync(join(real, `${id}.json`))).toBe(false);
});
