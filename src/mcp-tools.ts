import { SETUP_TARGETS, type SetupMode } from "./setup.ts";
import { isAbsolute } from "node:path";
import * as ops from "./commands.ts";
import { createHttp, type Http } from "./http.ts";
import type { McpHandler, McpTool } from "./mcp.ts";
import { PLAYBOOK } from "./playbook.ts";
import { STEP_COMMANDS } from "./plan/definition.ts";
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
const REVIEW = obj({
  v: { type: "integer", enum: [1] }, reviewer: obj({ id: text(128), modelFamily: text(128) }, ["id", "modelFamily"]), buildSha256: { type: "string", minLength: 64, maxLength: 64 },
  checklist: obj({ negativeResults: { type: "boolean" }, denominators: { type: "boolean" }, limitations: { type: "boolean" }, reproducibility: { type: "boolean" } }, ["negativeResults", "denominators", "limitations", "reproducibility"]),
  findings: { type: "array", maxItems: 200, items: obj({ id: text(128), kind: { type: "string", enum: ["contradiction", "unsupported-claim", "number", "citation", "method", "clarity", "other"] }, location: text(4000), text: text(4000), blocking: { type: "boolean" } }, ["id", "kind", "location", "text", "blocking"]) },
}, ["v", "reviewer", "buildSha256", "checklist", "findings"]);
const SKILL = obj({ name: text(64), summary: text(16384), steps: { ...texts(16384, 16384), minItems: 1 },
  evidence: { ...texts(64, 16384), minItems: 1, description: "32-hex amem ids or ares:<study-id>/... refs" } }, ["name", "summary", "steps", "evidence"]);
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
    command: { type: "string", enum: [...STEP_COMMANDS] },
    args: { type: "object", maxProperties: 32, properties: {}, additionalProperties: { type: ["string", "number", "boolean", "array"], maxLength: 4096, maxItems: 500, items: text(300) } },
    campaign: planId, unit: planId,
    binds: { type: "array", maxItems: 128, items: planId },
  }, ["id", "kind"]) },
  edges: { type: "array", maxItems: 512, items: { type: "array", minItems: 2, maxItems: 2, items: planId } },
}, ["v", "nodes", "edges"]);

const SELECTION = obj({
  v: { type: "integer", enum: [1] }, run: text(64), metric: text(128),
  baseline: obj({ commit: { type: "string", minLength: 40, maxLength: 40 } }, ["commit"]),
  minSeeds: integer(1, 1000), minDelta: { type: "number", minimum: 0 },
}, ["v", "run", "metric", "baseline", "minSeeds", "minDelta"]);

const IDEA = obj({ id: text(64), title: text(500), hypothesis: text(4000), parent: text(64), commit: { type: "string", minLength: 40, maxLength: 40 } }, ["id", "title", "hypothesis"]);

export const ARES_TOOLS: readonly McpTool[] = [
  { name: "ares_setup", description: "Preview, apply or undo the local ares MCP registration for an agent client. Defaults to dry-run and lists config/receipt actions. Apply writes the receipt first; undo refuses entry drift. Root pins a release; cwd selects the workspace for agy. Never changes instruction blocks or contacts the network.", inputSchema: obj({ target: { type: "string", enum: [...SETUP_TARGETS, "all", "console"] }, mode: { type: "string", enum: ["dry-run", "apply", "undo"] }, root: text(4096), cwd: text(4096) }, ["target"]), annotations: write },
  { name: "ares_manifest", description: "Read this ares version, implemented commands and shared schema versions without opening a study or reaching an executor.", inputSchema: obj({}, []), annotations: read },
  { name: "ares_archive", description: "Preview pending derived lessons without writes. With the current full-list fingerprint, export up to 200 new amem notes and commit returned ids/hashes; remaining reports later batches. A partial failure records successes; repeat the same confirmation to continue. Applies to survey and experiment studies.", inputSchema: obj({ study, confirm: { type: "string", minLength: 64, maxLength: 64 } }, ["study"]), annotations: net },
  { name: "ares_lessons", description: "Read project-scoped amem lessons with half-life ranking. Query intent when supplied, otherwise the study question; intent also returns a brief. Output relevance, decayed score, ordinal rank and age in days. No study write or lock. Survey and experiment.", inputSchema: obj({ study, for: text(1000), halfLife: { type: "number", minimum: 1, maximum: 3650 }, limit: integer(1, 50) }, ["study"]), annotations: { ...read, openWorldHint: true } },
  { name: "ares_skill_propose", description: "Queue a reviewable skill proposal with at least one step and 1..64 evidence refs. At most 100 proposals, bounded 16 KiB Markdown plus receipt. Does not create a PR. Survey and experiment.", inputSchema: obj({ study, proposal: SKILL }, ["study", "proposal"]), annotations: write },
  { name: "ares_skill_decide", description: "Record a final accept/reject/withdraw with reason and actor. Accept requires an HTTP(S) PR URL without credentials; never checks or merges the PR. Withdraw only while proposed. Survey and experiment.", inputSchema: obj({ study, name: text(64), decision: { type: "string", enum: ["accept", "reject", "withdraw"] }, reason: text(16384), pr: text(16384) }, ["study", "name", "decision", "reason"]), annotations: write },
  { name: "ares_skill_list", description: "Read all skill proposal states after verifying bounded Markdown against receipts. No lock, subprocess or write. Survey and experiment.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_plan_set", description: "Validate a bounded revisioned DAG of existing steps, local gates and read-only hub references. Set it paused; changed consumed inputs become stale and need explicit retry. Never starts a controller.", inputSchema: obj({ study, plan: PLAN }, ["study", "plan"]), annotations: write },
  { name: "ares_plan_control", description: "Pause/resume admission or retry/cancel/skip a node. Requires a durable command id and expected definition revision: identical replay returns its original receipt; changed payloads/stale new requests refuse. Does not start a controller; run ares run separately. Cancelling an attempt may contact its executor; hub cancellation stays local.", inputSchema: obj({ study, action: { type: "string", enum: ["pause", "resume", "retry", "cancel", "skip"] }, node: text(128), commandId: text(128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["study", "action", "commandId", "expectedRevision"]), annotations: net },
  { name: "ares_plan_show", description: "Read the definition revision, ledger-derived node states and last observations, gate decisions, uncertain nodes, controller owner and resolved hubProject without taking a lock or contacting an executor/hub.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_status", description: "Study summary: gates, candidate counts, verification counts, bibliography.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_scope_set", description: "Set scope.json (question, subquestions, include, exclude, yearFrom, yearTo, maxCandidates). A change returns the scope gate to pending.", inputSchema: obj({ study, scope: SCOPE }, ["study", "scope"]), annotations: write },
  { name: "ares_gate", description: "List gates, or approve/reject scope, screen, design, final, review or plan:node-id. Plan approvals bind all upstream output references and need complete upstream outputs; skip never bypasses them. The ledger records the actor; approval authority is workspace policy.", inputSchema: obj({ study, action: { type: "string", enum: ["list", "approve", "reject"] }, gate: text(133), reason }, ["study", "action"]), annotations: write },
  { name: "ares_idea_add", description: "Add an experiment idea to the ledger, with optional existing parent and frozen commit. Unique run-name ids and commit ownership; at most 1000 ideas. Starts no work.", inputSchema: obj({ study, idea: IDEA }, ["study", "idea"]), annotations: write },
  { name: "ares_idea_decide", description: "Record refine/pivot with a reason of at most 2000 bytes. Ideas with commits require terminal own-commit attempts (at most 200). Untested ideas omit attempts to attach a first commit or pivot. Refine requires --commit with unique idea ownership; Pivot accepts optional cause/retryWhen (2000 bytes each); refine refuses them. Pivot rejects commit and closes further decisions. Starts no work.", inputSchema: obj({ study, id: text(64), decision: { type: "string", enum: ["refine", "pivot"] }, reason: text(2000), cause: text(2000), retryWhen: text(2000), attempts: { type: "array", maxItems: 200, items: attemptId }, commit: { type: "string", minLength: 40, maxLength: 40 } }, ["study", "id", "decision", "reason"]), annotations: write },
  { name: "ares_investigate_show", description: "Read investigation candidate/baseline paired-seed scores, winner or no-winner reason and all run attempt totals/exclusions. No executor or network calls.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_investigate_close", description: "Close the selected investigation run after all its attempts stop. Write a deterministic winner or no-winner result and ledger receipt; identical inputs write nothing. The no-arg investigate.close plan step emits {sha256,winner} for gates. Starts no attempts.", inputSchema: obj({ study }, ["study"]), annotations: write },
  { name: "ares_ablate_add", description: "Declare what a unique frozen ablation removes, at most 200 declarations. Winner/baseline commits are refused. Requires a current closed investigation winner; writes one journal event and starts no work.", inputSchema: obj({ study, ablation: obj({ id: text(64), commit: { type: "string", minLength: 40, maxLength: 40 }, removes: text(2000) }, ["id", "commit", "removes"]) }, ["study", "ablation"]), annotations: write },
  { name: "ares_ablate_show", description: "Read every declared ablation against the investigate winner on shared non-reserved ablate-run seeds, with statuses/exclusions and no ranking. No executor or network calls.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_ablate_close", description: "Commit a timestamp-free ablation result and receipt after all ablate attempts stop. Current investigate winner required; identical inputs write nothing. The no-arg ablate.close plan step emits {sha256,status:closed} for gates; starts no work.", inputSchema: obj({ study }, ["study"]), annotations: write },
  { name: "ares_posthoc_show", description: "Read all posthoc-run attempts and their metrics, including every status, labeled exploratory. Read-only, no executor or network calls; never changes the final result or its inputs.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_final_close", description: "Close one-shot reserved-seed evaluation under the currently approved final gate. Re-approval keeps first attempt data fixed; later retries never replace it. Winner changes cannot buy a new final; changed protocol is not comparable. Refuses running or missing decisive attempts; writes deterministic qualified/not_qualified with unchanged inputs a no-op. The no-arg final.close plan step emits {sha256,status}; both qualification outcomes complete the step.", inputSchema: obj({ study }, ["study"]), annotations: write },
  { name: "ares_final_seeds", description: "Reserve unused unique declared protocol seeds for final evaluation (new/changed values reject prior use in every run/status), at least one and at most half the declared seeds. New/changed raw file bytes join the design seal; identical bytes are a no-op. Experiment mode only; starts no work.", inputSchema: obj({ study, final: obj({ v: { type: "integer", enum: [1] }, seeds: { type: "array", minItems: 1, maxItems: 500, items: seed } }, ["v", "seeds"]) }, ["study", "final"]), annotations: write },
  { name: "ares_selection_set", description: "Set a declared investigation selection rule before results: run (not reserved ablate/final/posthoc), primary metric, frozen baseline commit, minimum paired seeds and nonnegative improvement. Changes reopen the design gate; identical bytes leave the cutoff unchanged. Requires experiment mode and a protocol; starts no investigation or executor.", inputSchema: obj({ study, selection: SELECTION }, ["study", "selection"]), annotations: write },
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
  { name: "ares_review_add", description: "Record a bounded current-evidence-hash review with self-reported model family and checklist. Contradictions are always blocking; 100 reports per build, 200 findings per report, 4000-byte texts and a 60 KiB combined payload ceiling. Starts no build or controller.", inputSchema: obj({ study, review: REVIEW }, ["study", "review"]), annotations: write },
  { name: "ares_review_resolve", description: "Resolve a recorded review-id/finding-id with an explicit reason and actor. No votes or automatic contradiction resolution; historical reports stay in the ledger.", inputSchema: obj({ study, target: text(257), reason: text(4000) }, ["study", "target", "reason"]), annotations: write },
  { name: "ares_review_show", description: "Read current build/check readiness, review families, checklists and unresolved blocking findings. Claims readiness is unavailable (agent-hub#931) and nonblocking. Starts no network, build or controller.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_paper_build", description: "Check the bounded manuscript and refuse every finding before writing. Commit rendered Markdown, a v1 evidence map with source hashes and paper.built together; identical inputs/outputs record nothing. Unknown evidence versions are preserved. The no-arg paper.build plan step emits the committed evidence {sha256} for downstream gates. Starts no controller, executor or network calls.", inputSchema: obj({ study }, ["study"]), annotations: write },
  { name: "ares_paper_check", description: "Read-only manuscript readiness check: positioned bare-number, placeholder, citation and missing-negative-result findings plus every literal escape. Experiment numbers require closed evidence; survey checks citations and refuses experiment refs. Reads bounded paper/manuscript.md, starts no build/controller/network calls.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_cite_check", description: "Check [@key] citations in a draft against verified references; lists unknown and unverified keys.", inputSchema: obj({ study, draft: { type: "string", minLength: 1, maxLength: 4096 } }, ["study", "draft"]), annotations: read },
  { name: "ares_playbook", description: "Standalone literature, experiment and plan/conductor workflows, CLI-only controller startup, gate rules and evidence boundaries.", inputSchema: obj({}, []), annotations: read },
];

function absolute(value: unknown, what: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${what}: absolute path required; pass the full filesystem path for ${what}`);
  return value;
}

/** MCP calls always come from an agent; the actor id is the detected agent or `mcp`. */
export function createAresMcp(env: NodeJS.ProcessEnv, http: Http = createHttp(env), runtime: ops.ExperimentRuntime = {}): { tools: readonly McpTool[]; handlers: Record<string, McpHandler> } {
  const detected = detectActor(env), actor: Actor = { kind: "agent", id: detected.kind === "agent" ? detected.id! : "mcp" };
  const ctx = { ...runtime, actor, http }, memoryEnv = { ...env, AGENTHUB_PEER_ID: actor.id };
  const dir = (a: Record<string, unknown>) => absolute(a.study, "study");
  const handlers: Record<string, McpHandler> = {
    ares_manifest: () => ops.manifest(),
    ares_setup: a => ops.setup(a.target as string, (a.mode ?? "dry-run") as SetupMode, env, { ...(a.root === undefined ? {} : { root: absolute(a.root, "root") }), ...(a.cwd === undefined ? {} : { cwd: absolute(a.cwd, "cwd") }) }),
    ares_archive: a => ops.archive(dir(a), { ...(a.confirm === undefined ? {} : { confirm: a.confirm as string }) }, ctx, memoryEnv),
    ares_lessons: a => ops.lessons(dir(a), { ...(a.for === undefined ? {} : { for: a.for as string }), ...(a.halfLife === undefined ? {} : { halfLife: a.halfLife as number }), ...(a.limit === undefined ? {} : { limit: a.limit as number }) }, ctx, memoryEnv),
    ares_skill_propose: a => ops.skillPropose(dir(a), a.proposal, ctx),
    ares_skill_decide: a => ops.skillDecide(dir(a), a.name as string, a.decision as string, a.reason as string, a.pr as string | undefined, ctx),
    ares_skill_list: a => ops.skillList(dir(a)),
    ares_plan_set: a => ops.planSet(dir(a), a.plan, ctx),
    ares_plan_control: a => ops.planControl(dir(a), { action: a.action as Parameters<typeof ops.planControl>[1]["action"], commandId: a.commandId as string, expectedRevision: a.expectedRevision as number, ...(a.node !== undefined ? { node: a.node as string } : {}) }, ctx),
    ares_plan_show: a => ops.planShow(dir(a)),
    ares_status: a => ops.status(dir(a)),
    ares_scope_set: a => ops.scope(dir(a), a.scope, ctx),
    ares_idea_add: a => ops.ideaAdd(dir(a), a.idea, ctx),
    ares_idea_decide: a => ops.ideaDecide(dir(a), a.id as string, { decision: a.decision, reason: a.reason, ...(a.cause !== undefined ? { cause: a.cause } : {}), ...(a.retryWhen !== undefined ? { retryWhen: a.retryWhen } : {}), ...(a.attempts !== undefined ? { attempts: a.attempts } : {}), ...(a.commit !== undefined ? { commit: a.commit } : {}) }, ctx),
    ares_investigate_show: a => ops.investigateShow(dir(a)),
    ares_investigate_close: a => ops.investigateClose(dir(a), ctx),
    ares_ablate_add: a => ops.ablateAdd(dir(a), a.ablation, ctx),
    ares_ablate_show: a => ops.ablateShow(dir(a)),
    ares_ablate_close: a => ops.ablateClose(dir(a), ctx),
    ares_posthoc_show: a => ops.posthocShow(dir(a)),
    ares_final_close: a => ops.finalClose(dir(a), ctx),
    ares_final_seeds: a => ops.finalSeeds(dir(a), a.final, ctx),
    ares_selection_set: a => ops.selection(dir(a), a.selection, ctx),
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
    ares_review_add: a => ops.reviewAdd(dir(a), a.review, ctx),
    ares_review_resolve: a => ops.reviewResolve(dir(a), a.target as string, a.reason as string, ctx),
    ares_review_show: a => ops.reviewShow(dir(a)),
    ares_paper_build: a => ops.paperBuild(dir(a), ctx),
    ares_paper_check: a => ops.paperCheck(dir(a)),
    ares_cite_check: a => ops.cite(dir(a), absolute(a.draft, "draft")),
    ares_playbook: () => ({ playbook: PLAYBOOK }),
  };
  return { tools: ARES_TOOLS, handlers };
}
