import { isAbsolute } from "node:path";
import * as ops from "./commands.ts";
import { createHttp, type Http } from "./http.ts";
import type { McpHandler, McpTool } from "./mcp.ts";
import { PLAYBOOK } from "./playbook.ts";
import { detectActor, type Actor } from "./study.ts";

const study = { type: "string", minLength: 1, maxLength: 4096, description: "Absolute path of the study directory (holds study.json)" };
const id = { type: "string", minLength: 1, maxLength: 300 };
const ids = { type: "array", items: id, maxItems: 200 };
const reason = { type: "string", minLength: 1, maxLength: 500 };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const net = { ...write, openWorldHint: true };
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

const text = (max: number) => ({ type: "string", minLength: 1, maxLength: max });
const texts = (items: number, max: number) => ({ type: "array", items: text(max), maxItems: items });
const year = { type: "integer", minimum: 1000, maximum: 2100 };
const SCOPE = obj({ question: text(2000), subquestions: texts(30, 1000), include: texts(50, 500), exclude: texts(50, 500), yearFrom: year, yearTo: year, maxCandidates: { type: "integer", minimum: 1, maximum: 5000 } }, ["question"]);
const CARD = obj({ summary: text(4000), claims: texts(50, 1000), methods: text(4000), findings: text(4000), limitations: text(4000), relevance: text(4000) }, ["summary"]);
const integer = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const argv = { type: "array", minItems: 1, maxItems: 128, items: { type: "string", maxLength: 4096 } };
const image = { ...text(512), description: "Digest-pinned image: name@sha256:<64 lowercase hex digits>" };
const stage = { type: "string", enum: ["candidate", "evaluator"] };
const stream = { type: "string", enum: ["stdout", "stderr"] };
const attemptId = { type: "string", minLength: 16, maxLength: 16, description: "16-hex attempt id from attempt list" };
const run = text(64), seed = integer(-2_147_483_648, 2_147_483_647);
const PROTOCOL = obj({
  v: { type: "integer", enum: [1] }, method: text(4000),
  candidate: obj({ image, command: argv, env: { type: "object", maxProperties: 64, properties: {}, additionalProperties: { type: "string", maxLength: 4096 }, description: "Non-secret environment values; secret-like keys and reserved ARES_SEED are refused" } }, ["image", "command"]),
  evaluator: obj({ image, command: argv }, ["image", "command"]),
  metrics: { type: "array", minItems: 1, maxItems: 100, items: obj({ name: text(128), unit: text(64), direction: { type: "string", enum: ["max", "min"] } }, ["name", "unit", "direction"]) },
  seeds: { type: "array", minItems: 1, maxItems: 1000, items: seed },
  limits: obj({ cpus: { type: "number", minimum: 0.1, maximum: 256 }, memoryMb: integer(16, 1_048_576), pidsLimit: integer(1, 65_536), wallSeconds: integer(1, 604_800), gpus: integer(0, 64) }, ["cpus", "memoryMb", "pidsLimit", "wallSeconds", "gpus"]),
  network: { type: "string", enum: ["none"] },
  budget: obj({ maxAttempts: integer(1, 1_000_000), maxWallHours: { type: "number", minimum: 0.000001, maximum: 1_000_000 }, maxGpuHours: { type: "number", minimum: 0, maximum: 64_000_000 } }, ["maxAttempts", "maxWallHours", "maxGpuHours"]),
}, ["v", "method", "candidate", "evaluator", "metrics", "seeds", "limits", "network", "budget"]);

const planId = text(128);
const PLAN = obj({
  v: { type: "integer", enum: [1] }, revision: integer(1, Number.MAX_SAFE_INTEGER),
  nodes: { type: "array", maxItems: 128, items: obj({
    id: planId, kind: { type: "string", enum: ["step", "hub", "gate"] },
    needs: { type: "array", maxItems: 128, items: planId },
    command: { type: "string", enum: ["lit.search", "lit.verify", "lit.bib", "cite.check", "attempt.run"] },
    args: { type: "object", maxProperties: 32, properties: {}, additionalProperties: { type: ["string", "number", "boolean"], maxLength: 4096 } },
    task: obj({ title: text(500), unit: text(128) }, ["title", "unit"]),
    binds: { type: "array", maxItems: 128, items: planId },
  }, ["id", "kind"]) },
  edges: { type: "array", maxItems: 512, items: { type: "array", minItems: 2, maxItems: 2, items: planId } },
}, ["v", "nodes", "edges"]);

export const ARES_TOOLS: readonly McpTool[] = [
  { name: "ares_manifest", description: "Read this ares version, implemented commands and shared schema versions without opening a study or reaching an executor.", inputSchema: obj({}, []), annotations: read },
  { name: "ares_plan_set", description: "Validate and set a bounded plan definition, creating a paused revision.", inputSchema: obj({ study, plan: PLAN }, ["study", "plan"]), annotations: write },
  { name: "ares_plan_show", description: "Read the plan definition without taking a lock.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_status", description: "Study summary: gates, candidate counts, verification counts, bibliography.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_scope_set", description: "Set scope.json (question, subquestions, include, exclude, yearFrom, yearTo, maxCandidates). A change returns the scope gate to pending.", inputSchema: obj({ study, scope: SCOPE }, ["study", "scope"]), annotations: write },
  { name: "ares_gate", description: "List gates, or approve or reject scope, screen or experiment design. The ledger records the actor; who may approve is workspace policy.", inputSchema: obj({ study, action: { type: "string", enum: ["list", "approve", "reject"] }, gate: { type: "string", enum: ["scope", "screen", "design"] }, reason }, ["study", "action"]), annotations: write },
  { name: "ares_protocol_set", description: "Set an experiment protocol after bounded validation of protocol and task/. Changes reopen design approval; attempt protocol identity excludes budget.", inputSchema: obj({ study, protocol: PROTOCOL }, ["study", "protocol"]), annotations: write },
  { name: "ares_executor_set", description: "Configure local or SSH Docker execution with an explicit private absolute workdir. Stores the host alias only, never credentials.", inputSchema: obj({ study, kind: { type: "string", enum: ["local", "ssh"] }, host: text(128), workdir: text(4096) }, ["study", "kind", "workdir"]), annotations: write },
  { name: "ares_executor_check", description: "Check executor Docker server, non-root uid:gid and digest-pinned image availability; pulls missing images.", inputSchema: obj({ study }, ["study"]), annotations: net },
  { name: "ares_attempt_run", description: "Start a frozen-commit experiment attempt and return without waiting for completion. Always detached; requires approved design in gates mode. Duplicate requests return the existing attempt.", inputSchema: obj({ study, repo: text(4096), commit: { type: "string", minLength: 40, maxLength: 40 }, seed, run, label: text(128), retry: attemptId }, ["study", "repo", "commit"]), annotations: net },
  { name: "ares_attempt_list", description: "List bounded attempt summaries without protocol or artifact lists. Limit defaults to 50 (maximum 200), with offset pagination. Totals cover every whole-study status regardless of filters or page.", inputSchema: obj({ study, run, status: { type: "string", enum: ["running", "succeeded", "failed", "cancelled", "unknown"] }, limit: integer(1, 200), offset: integer(0, 1_000_000) }, ["study"]), annotations: read },
  { name: "ares_attempt_show", description: "Read an attempt record, its executor, stage receipts, metrics and artifact metadata. Logs remain on the executor.", inputSchema: obj({ study, id: attemptId }, ["study", "id"]), annotations: read },
  { name: "ares_attempt_cancel", description: "Stop the running stage and record cancelled; repeated cancellation preserves the terminal attempt.", inputSchema: obj({ study, id: attemptId, reason }, ["study", "id"]), annotations: net },
  { name: "ares_attempt_reconcile", description: "Observe recorded containers, advance candidate/evaluator stages and record terminal states. Lost containers become unknown; reconcile never starts a new attempt.", inputSchema: obj({ study }, ["study"]), annotations: net },
  { name: "ares_attempt_logs", description: "Retrieve executor log text read-only without recording content in the study. Optionally select stage/stream; tailBytes is 0..65536 per selected stream, default 16384. Copies are checked against recorded size and sha256.", inputSchema: obj({ study, id: attemptId, stage, stream, tailBytes: integer(0, 65_536) }, ["study", "id"]), annotations: { ...read, openWorldHint: true } },
  { name: "ares_lit_search", description: "Search OpenAlex, Semantic Scholar and arXiv and merge candidates. Needs the scope gate. Per-source failures are reported.", inputSchema: obj({ study, query: { type: "string", minLength: 1, maxLength: 500 }, source: { type: "string", enum: ["openalex", "s2", "arxiv", "all"] }, limit: { type: "integer", minimum: 1, maximum: 50 }, yearFrom: { type: "integer", minimum: 1000, maximum: 2100 } }, ["study", "query"]), annotations: net },
  { name: "ares_lit_list", description: "List candidates with abstracts (first 600 characters), status and verification.", inputSchema: obj({ study, status: { type: "string", enum: ["new", "included", "excluded"] }, limit: { type: "integer", minimum: 1, maximum: 500 } }, ["study"]), annotations: read },
  { name: "ares_lit_screen", description: "Include or exclude candidates. Changing the included set returns the screen gate to pending.", inputSchema: obj({ study, ids: { ...ids, minItems: 1 }, decision: { type: "string", enum: ["include", "exclude"] }, reason }, ["study", "ids", "decision"]), annotations: write },
  { name: "ares_lit_card", description: "Record an extraction card for an included candidate: summary, claims, methods, findings, limitations, relevance.", inputSchema: obj({ study, id, card: CARD }, ["study", "id", "card"]), annotations: write },
  { name: "ares_lit_verify", description: "Check DOI or arXiv identifiers at Crossref, DataCite or arXiv and compare title and year. Never judges whether a paper supports a claim.", inputSchema: obj({ study, ids }, ["study"]), annotations: net },
  { name: "ares_lit_bib", description: "Write refs/references.bib from included and verified candidates. Needs the screen gate. Citekeys never change once assigned.", inputSchema: obj({ study }, ["study"]), annotations: write },
  { name: "ares_cite_check", description: "Check [@key] citations in a draft against verified references; lists unknown and unverified keys.", inputSchema: obj({ study, draft: { type: "string", minLength: 1, maxLength: 4096 } }, ["study", "draft"]), annotations: read },
  { name: "ares_playbook", description: "Standalone literature and experiment workflows, gate rules and evidence boundaries.", inputSchema: obj({}, []), annotations: read },
];

function absolute(value: unknown, what: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${what}: absolute path required; pass the full filesystem path for ${what}`);
  return value;
}

/** MCP calls always come from an agent; the actor id is the detected agent or `mcp`. */
export function createAresMcp(env: NodeJS.ProcessEnv, http: Http = createHttp(env), runtime: ops.ExperimentRuntime = {}): { tools: readonly McpTool[]; handlers: Record<string, McpHandler> } {
  const detected = detectActor(env), actor: Actor = { kind: "agent", id: detected.kind === "agent" ? detected.id! : "mcp" };
  const ctx = { ...runtime, actor, http };
  const dir = (a: Record<string, unknown>) => absolute(a.study, "study");
  const handlers: Record<string, McpHandler> = {
    ares_manifest: () => ops.manifest(),
    ares_plan_set: a => ops.planSet(dir(a), a.plan, ctx),
    ares_plan_show: a => ops.planShow(dir(a)),
    ares_status: a => ops.status(dir(a)),
    ares_scope_set: a => ops.scope(dir(a), a.scope, ctx),
    ares_protocol_set: a => ops.protocol(dir(a), a.protocol, ctx),
    ares_executor_set: a => ops.executorSet(dir(a), { v: 1, kind: a.kind, ...(a.host !== undefined ? { host: a.host } : {}), workdir: a.workdir }, ctx),
    ares_executor_check: a => ops.executorCheck(dir(a), ctx),
    ares_attempt_run: a => ops.attemptRun(dir(a), { repo: absolute(a.repo, "repo"), commit: a.commit as string, ...(a.seed !== undefined ? { seed: a.seed as number } : {}), ...(a.run !== undefined ? { run: a.run as string } : {}), ...(a.label !== undefined ? { label: a.label as string } : {}), ...(a.retry !== undefined ? { retry: a.retry as string } : {}), detach: true }, ctx),
    ares_attempt_list: a => ops.attemptList(dir(a), { ...(a.run !== undefined ? { run: a.run as string } : {}), ...(a.status !== undefined ? { status: a.status as string } : {}), ...(a.limit !== undefined ? { limit: a.limit as number } : {}), ...(a.offset !== undefined ? { offset: a.offset as number } : {}) }),
    ares_attempt_show: a => ops.attemptShow(dir(a), a.id as string),
    ares_attempt_cancel: a => ops.attemptCancel(dir(a), a.id as string, a.reason as string | undefined, ctx),
    ares_attempt_reconcile: a => ops.attemptReconcile(dir(a), ctx),
    ares_attempt_logs: a => ops.attemptLogs(dir(a), a.id as string, { ...(a.stage !== undefined ? { stage: a.stage as "candidate" | "evaluator" } : {}), ...(a.stream !== undefined ? { stream: a.stream as "stdout" | "stderr" } : {}), ...(a.tailBytes !== undefined ? { tailBytes: a.tailBytes as number } : {}) }, ctx),
    ares_gate: a => {
      if (a.action === "list") return ops.gateList(dir(a));
      if (typeof a.gate !== "string") throw new Error("gate: required for approve and reject");
      return ops.gateDecide(dir(a), a.gate, a.action === "approve" ? "approve" : "reject", a.reason as string | undefined, ctx);
    },
    ares_lit_search: a => ops.search(dir(a), a.query as string, { ...(a.source ? { source: a.source as string } : {}), ...(a.limit ? { limit: a.limit as number } : {}), ...(a.yearFrom ? { yearFrom: a.yearFrom as number } : {}) }, ctx),
    ares_lit_list: a => ops.list(dir(a), { ...(a.status ? { status: a.status as string } : {}), ...(a.limit ? { limit: a.limit as number } : {}) }),
    ares_lit_screen: a => ops.screen(dir(a), a.ids as string[], a.decision as "include" | "exclude", a.reason as string | undefined, ctx),
    ares_lit_card: a => ops.card(dir(a), a.id as string, a.card, ctx),
    ares_lit_verify: a => ops.verify(dir(a), (a.ids as string[] | undefined) ?? [], ctx),
    ares_lit_bib: a => ops.bib(dir(a), ctx),
    ares_cite_check: a => ops.cite(dir(a), absolute(a.draft, "draft")),
    ares_playbook: () => ({ playbook: PLAYBOOK }),
  };
  return { tools: ARES_TOOLS, handlers };
}
