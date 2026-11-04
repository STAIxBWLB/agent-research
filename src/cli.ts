import { version } from "../package.json";
import { findCommand, help, type CommandSpec } from "./commands-table.ts";
import * as ops from "./commands.ts";
import { createHttp, type Http } from "./http.ts";
import { PLAYBOOK } from "./playbook.ts";
import { detectActor, readTextBounded } from "./study.ts";

const INPUT_BYTES = 65_536;
export interface Io extends ops.ExperimentRuntime { readStdin?: () => Promise<string>; http?: Http; signal?: AbortSignal }

function parse(spec: CommandSpec, args: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {}, positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "-" || !word.startsWith("-")) { positional.push(word); continue; }
    const kind = spec.options[word];
    if (!kind || word in flags) throw new Error(`${spec.name}: unknown or repeated option ${word}; use ares --help and pass each supported option once`);
    if (kind === "value") {
      const value = args[++i];
      if (value === undefined || (value.startsWith("--") && value !== "-")) throw new Error(`${spec.name}: ${word} needs a value; use ares --help for its accepted values`);
      flags[word] = value;
    } else flags[word] = true;
  }
  return { flags, positional };
}
function count(spec: CommandSpec, positional: string[], min: number, max = min): void {
  if (positional.length < min || positional.length > max) throw new Error(`usage: ares ${spec.usage}`);
}
function integer(value: string | true | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,7}$/.test(value)) throw new Error(`${what}: integer required; pass a nonnegative decimal integer`);
  return Number(value);
}
function seed(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d{1,10}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < -2_147_483_648 || Number(value) > 2_147_483_647) throw new Error("--seed: invalid integer; use a declared protocol seed in -2147483648..2147483647");
  return Number(value);
}
async function readInput(path: string, io: Io): Promise<unknown> {
  let text: string;
  if (path === "-") {
    if (!io.readStdin) throw new Error("--file -: no standard input");
    text = await io.readStdin();
  } else text = readTextBounded(path, INPUT_BYTES);
  if (Buffer.byteLength(text) > INPUT_BYTES) throw new Error(`input larger than ${INPUT_BYTES} bytes`);
  try { return JSON.parse(text); } catch { throw new Error(`${path === "-" ? "standard input" : path}: not valid JSON`); }
}

export async function run(args: string[], env: NodeJS.ProcessEnv = process.env, io: Io = {}): Promise<{ text: string; code: number }> {
  if (!args.length || (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!))) return { text: help(), code: 0 };
  if (args.length === 1 && args[0] === "--version") return { text: version, code: 0 };
  const found = findCommand(args);
  if (!found) throw new Error(`unknown command: ${args.slice(0, 2).join(" ")}; use --help`);
  const { spec, rest } = found, { flags, positional } = parse(spec, rest);
  const ctx: ops.Ctx = { actor: detectActor(env), http: io.http ?? createHttp(env), ...(io.signal ? { signal: io.signal } : {}), ...(io.sleep ? { sleep: io.sleep } : {}), ...(io.runner ? { runner: io.runner } : {}), ...(io.now ? { now: io.now } : {}), ...(io.collectEvaluation ? { collectEvaluation: io.collectEvaluation } : {}), ...(io.collectStageEvidence ? { collectStageEvidence: io.collectStageEvidence } : {}) };
  const str = (flag: string) => (typeof flags[flag] === "string" ? flags[flag] as string : undefined);
  let result: unknown, code = 0;
  switch (spec.name) {
    case "run": {
      count(spec, positional, 1); const parallel = integer(flags["--parallel"], "--parallel");
      result = await ops.planRun(positional[0]!, { ...(parallel !== undefined ? { parallel } : {}) }, ctx); break;
    }
    case "manifest": count(spec, positional, 0); result = ops.manifest(); break;
    case "playbook": count(spec, positional, 0); return { text: PLAYBOOK.trimEnd(), code: 0 };
    case "mcp": throw new Error("mcp: run `ares mcp` with no other arguments");
    case "init": {
      count(spec, positional, 1);
      const question = str("--question");
      if (question === undefined) throw new Error("init: --question is required");
      result = ops.init(positional[0]!, { question, ...(str("--mode") ? { mode: str("--mode")! } : {}), ...(str("--autonomy") ? { autonomy: str("--autonomy")! } : {}) }, ctx);
      break;
    }
    case "plan set": {
      count(spec, positional, 1);
      const file = str("--file");
      if (file === undefined) throw new Error("plan set: --file is required");
      result = await ops.planSet(positional[0]!, await readInput(file, io), ctx); break;
    }
    case "plan control": {
      count(spec, positional, 2, 3);
      const commandId = str("--command-id"), expectedRevision = integer(flags["--expected-revision"], "--expected-revision");
      if (!commandId || expectedRevision === undefined) throw new Error("plan control: command id and revision required; pass --command-id ID --expected-revision N from ares plan show");
      result = await ops.planControl(positional[0]!, { action: positional[1]! as Parameters<typeof ops.planControl>[1]["action"], ...(positional[2] !== undefined ? { node: positional[2] } : {}), commandId, expectedRevision }, ctx); break;
    }
    case "plan show": count(spec, positional, 1); result = ops.planShow(positional[0]!); break;
    case "status": count(spec, positional, 1); result = ops.status(positional[0]!); break;
    case "scope": {
      count(spec, positional, 1);
      const file = str("--file");
      if (file === undefined) throw new Error("scope: --file is required");
      result = await ops.scope(positional[0]!, await readInput(file, io), ctx);
      break;
    }
    case "idea add": {
      count(spec, positional, 1); const file = str("--file");
      if (file === undefined) throw new Error("idea add: input missing; pass --file PATH or --file - for JSON");
      result = await ops.ideaAdd(positional[0]!, await readInput(file, io), ctx); break;
    }
    case "idea decide": {
      count(spec, positional, 3); const reason = str("--reason"), attempts = str("--attempts");
      if (reason === undefined) throw new Error("idea decide: reason missing; pass --reason TEXT and --commit SHA for refine, plus --attempts for an idea with commits");
      result = await ops.ideaDecide(positional[0]!, positional[1]!, { decision: positional[2], reason, ...(attempts !== undefined ? { attempts: attempts.split(",") } : {}), ...(str("--commit") !== undefined ? { commit: str("--commit") } : {}) }, ctx); break;
    }
    case "investigate show": count(spec, positional, 1); result = ops.investigateShow(positional[0]!); break;
    case "investigate close": count(spec, positional, 1); result = await ops.investigateClose(positional[0]!, ctx); break;
    case "selection": {
      count(spec, positional, 1);
      const file = str("--file");
      if (file === undefined) throw new Error("selection: input missing; pass --file PATH or --file - for a JSON rule");
      result = await ops.selection(positional[0]!, await readInput(file, io), ctx); break;
    }
    case "protocol": {
      count(spec, positional, 1);
      const file = str("--file");
      if (file === undefined) throw new Error("protocol: input file missing; use --file PATH or --file - for JSON standard input");
      result = await ops.protocol(positional[0]!, await readInput(file, io), ctx); break;
    }
    case "executor set": {
      count(spec, positional, 1);
      const kind = str("--kind"), workdir = str("--workdir");
      if (!kind || !workdir) throw new Error("executor set: kind/workdir missing; use --kind local|ssh --workdir PATH and --host ALIAS for ssh");
      result = await ops.executorSet(positional[0]!, { v: 1, kind, workdir, ...(str("--host") !== undefined ? { host: str("--host") } : {}) }, ctx); break;
    }
    case "executor check": count(spec, positional, 1); result = await ops.executorCheck(positional[0]!, ctx); break;
    case "attempt run": {
      count(spec, positional, 1);
      const repo = str("--repo"), commit = str("--commit"), chosenSeed = seed(str("--seed"));
      if (!repo || !commit) throw new Error("attempt run: repo/commit missing; use --repo PATH --commit FULL_40_HEX_SHA");
      const attempt = await ops.attemptRun(positional[0]!, { repo, commit, ...(chosenSeed !== undefined ? { seed: chosenSeed } : {}), ...(str("--run") !== undefined ? { run: str("--run") } : {}), ...(str("--label") !== undefined ? { label: str("--label") } : {}), ...(str("--retry") !== undefined ? { retry: str("--retry") } : {}), detach: !!flags["--detach"] }, ctx);
      if (attempt.status !== "running" && attempt.status !== "succeeded") code = 1;
      result = attempt; break;
    }
    case "attempt list": {
      count(spec, positional, 1); const limit = integer(flags["--limit"], "--limit"), offset = integer(flags["--offset"], "--offset");
      result = ops.attemptList(positional[0]!, { ...(str("--run") !== undefined ? { run: str("--run") } : {}), ...(str("--status") !== undefined ? { status: str("--status") } : {}), ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) }); break;
    }
    case "attempt show": count(spec, positional, 2); result = ops.attemptShow(positional[0]!, positional[1]!); break;
    case "attempt cancel": count(spec, positional, 2); result = await ops.attemptCancel(positional[0]!, positional[1]!, str("--reason"), ctx); break;
    case "attempt reconcile": count(spec, positional, 1); result = await ops.attemptReconcile(positional[0]!, ctx); break;
    case "attempt logs": {
      count(spec, positional, 2); const tailBytes = integer(flags["--tail"], "--tail");
      const logs = await ops.attemptLogs(positional[0]!, positional[1]!, { ...(str("--stage") !== undefined ? { stage: str("--stage") } : {}), ...(str("--stream") !== undefined ? { stream: str("--stream") } : {}), ...(tailBytes !== undefined ? { tailBytes } : {}) }, ctx);
      if (!flags["--json"]) return { text: logs.logs.map(log => `[${log.stage} ${log.stream}${log.truncated ? ", truncated copy" : ""}]\n${log.text}`).join("\n"), code: 0 };
      result = logs; break;
    }
    case "gate list": count(spec, positional, 1); result = ops.gateList(positional[0]!); break;
    case "gate approve": case "gate reject":
      count(spec, positional, 2);
      result = await ops.gateDecide(positional[0]!, positional[1]!, spec.name === "gate approve" ? "approve" : "reject", str("--reason"), ctx);
      break;
    case "lit search": {
      count(spec, positional, 2);
      const limit = integer(flags["--limit"], "--limit"), yearFrom = integer(flags["--year-from"], "--year-from");
      const out = await ops.search(positional[0]!, positional[1]!, { ...(str("--source") ? { source: str("--source")! } : {}), ...(limit !== undefined ? { limit } : {}), ...(yearFrom !== undefined ? { yearFrom } : {}) }, ctx);
      if (!out.sources.some(s => s.ok)) code = 1;
      result = out;
      break;
    }
    case "lit list": {
      count(spec, positional, 1);
      const limit = integer(flags["--limit"], "--limit");
      result = ops.list(positional[0]!, { ...(str("--status") ? { status: str("--status")! } : {}), ...(limit !== undefined ? { limit } : {}) });
      break;
    }
    case "lit screen": {
      if (positional.length < 2) throw new Error(`usage: ares ${spec.usage}`);
      if (!!flags["--include"] === !!flags["--exclude"]) throw new Error("lit screen: exactly one of --include or --exclude");
      result = await ops.screen(positional[0]!, positional.slice(1), flags["--include"] ? "include" : "exclude", str("--reason"), ctx);
      break;
    }
    case "lit card": {
      count(spec, positional, 2);
      const file = str("--file");
      if (file === undefined) throw new Error("lit card: --file is required");
      result = await ops.card(positional[0]!, positional[1]!, await readInput(file, io), ctx);
      break;
    }
    case "lit verify": if (!positional.length) throw new Error(`usage: ares ${spec.usage}`); result = await ops.verify(positional[0]!, positional.slice(1), ctx); break;
    case "lit bib": count(spec, positional, 1); result = await ops.bib(positional[0]!, ctx); break;
    case "cite check": {
      count(spec, positional, 2);
      const report = ops.cite(positional[0]!, positional[1]!);
      if (!report.ok) code = 1;
      result = report;
      break;
    }
    default: throw new Error(`unknown command: ${spec.name}`);
  }
  return { text: JSON.stringify(result, null, flags["--json"] ? undefined : 2), code };
}

/** `ares mcp`: stdout carries protocol frames only. */
export async function runMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [{ serveMcp }, { createAresMcp }] = await Promise.all([import("./mcp.ts"), import("./mcp-tools.ts")]);
  const server = createAresMcp(env);
  await serveMcp({ tools: server.tools, handlers: server.handlers, name: "ares", version });
}

/** Standard input stops at the input bound instead of buffering everything first. */
async function readStdinBounded(): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.byteLength;
    if (size > INPUT_BYTES) throw new Error(`standard input larger than ${INPUT_BYTES} bytes`);
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export async function main(args: string[]): Promise<number> {
  const stop = new AbortController(), interrupt = () => stop.abort();
  if (args[0] === "run") { process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt); }
  try {
    const output = await run(args, process.env, { readStdin: readStdinBounded, signal: stop.signal });
    console.log(output.text);
    return output.code;
  } catch (error) {
    console.error(`ares: ${error instanceof Error ? error.message : "operation failed"}`);
    return 1;
  } finally {
    if (args[0] === "run") { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
  }
}
