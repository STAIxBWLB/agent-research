import { STAGE_REUSE_CONTRACT_SCHEMA } from "./exp/reuse-contract.ts";
import {HARNESS_MODEL_BYTES} from "./harness/limits.ts";
import { PROVENANCE_KINDS, type ExecutionReferenceV1 } from "./provenance.ts";
import { PHASES, AUTONOMY_MODES } from "./autonomy.ts";
import { SETUP_TARGETS, type SetupMode } from "./setup.ts";
import { isAbsolute } from "node:path";
import * as ops from "./commands.ts";
import { createHttp, type Http } from "./http.ts";
import type { McpHandler, McpTool } from "./mcp.ts";
import type { RetainedRef } from "./exp/retention.ts";
import { PLAYBOOK } from "./playbook.ts";
import { PLAN_ID_BYTES, STEP_COMMANDS } from "./plan/definition.ts";
import { PLAN_GATE_BYTES } from "./plan/state.ts";
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
const EXECUTION_REFERENCE = obj({ v: { type: "integer", enum: [1] }, tool: { type: "string", enum: ["ares"] }, projectKey: text(256), kind: { type: "string", enum: [...PROVENANCE_KINDS] }, id: text(256), revision: text(128), sha256: { type: "string", minLength: 64, maxLength: 64 } }, ["v", "tool", "projectKey", "kind", "id"]);
const LINEAGE_ATTEMPTS = { type: "array", minItems: 1, maxItems: 8, items: { ...text(16), minLength: 16 } };
const LINEAGE_CANDIDATES = { type: "array", minItems: 1, maxItems: 8, items: { ...text(40), minLength: 40 } };
const REVIEW = obj({
  v: { type: "integer", enum: [1] }, reviewer: obj({ id: text(128), modelFamily: text(128) }, ["id", "modelFamily"]), buildSha256: { type: "string", minLength: 64, maxLength: 64 },
  checklist: obj({ negativeResults: { type: "boolean" }, denominators: { type: "boolean" }, limitations: { type: "boolean" }, reproducibility: { type: "boolean" } }, ["negativeResults", "denominators", "limitations", "reproducibility"]),
  findings: { type: "array", maxItems: 200, items: obj({ id: text(128), kind: { type: "string", enum: ["contradiction", "unsupported-claim", "number", "citation", "method", "clarity", "other"] }, location: text(4000), text: text(4000), blocking: { type: "boolean" } }, ["id", "kind", "location", "text", "blocking"]) },
}, ["v", "reviewer", "buildSha256", "checklist", "findings"]);
// Source-specific current-study/exact-id rules are owned by the shared validator; the MCP transport bounds both shapes.
const SKILL_REF = {...EXECUTION_REFERENCE, type: ["string", "object"], minLength: 1, maxLength: 4096, required: ["v", "tool", "id"], properties: {...EXECUTION_REFERENCE.properties, tool: {type: "string", enum: ["ares", "amem"]}}};
const SKILL = obj({name: text(64), summary: text(4000), steps: {...texts(64, 1000), minItems: 1}, evidence: {type: "array", minItems: 1, maxItems: 64, items: SKILL_REF}, applicability: text(2000), limitations: texts(16, 1000), counterevidence: {type: "array", maxItems: 64, items: SKILL_REF}}, ["name", "summary", "steps", "evidence"]);
const SCOPE = obj({ question: text(2000), subquestions: texts(30, 1000), include: texts(50, 500), exclude: texts(50, 500), yearFrom: year, yearTo: year, maxCandidates: { type: "integer", minimum: 1, maximum: 5000 } }, ["question"]);
const CARD = obj({ summary: text(4000), claims: texts(50, 1000), methods: text(4000), findings: text(4000), limitations: text(4000), relevance: text(4000) }, ["summary"]);
const integer = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
const WATCH = obj({ v: {}, queries: { type: "array", minItems: 1, maxItems: 20,
  items: obj({ id: text(64), query: text(4096), source: { type: "string", enum: ["openalex", "s2", "arxiv", "all"] }, yearFrom: year, limit: integer(1, 50) }, ["id", "query"]) }, rubric: text(8000) }, ["queries"]);
const argv = { type: "array", minItems: 1, maxItems: 128, items: { type: "string", maxLength: 4096 } };
const image = { ...text(512), description: "Digest-pinned image: name@sha256:<64 lowercase hex digits>" };
const stage = { type: "string", enum: ["candidate", "evaluator"] };
const stream = { type: "string", enum: ["stdout", "stderr"] };
const attemptId = { type: "string", minLength: 16, maxLength: 16, description: "16-hex attempt id from attempt list" };
const run = text(64), seed = integer(-2_147_483_648, 2_147_483_647);
const RETAINED_REFS = { type: "array", minItems: 1, maxItems: 500, items: obj({ attemptId, stage: text(32), sha256: { ...text(64), minLength: 64 } }, ["attemptId", "stage", "sha256"]) };
const PROTOCOL_V1 = obj({
  v: { type: "integer", enum: [1] }, method: text(4000),
  candidate: obj({ image, command: argv, env: { type: "object", maxProperties: 64, properties: {}, additionalProperties: { type: "string", maxLength: 4096 }, description: "Non-secret environment values; secret-like keys and reserved ARES_SEED are refused" } }, ["image", "command"]),
  evaluator: obj({ image, command: argv }, ["image", "command"]),
  metrics: { type: "array", minItems: 1, maxItems: 100, items: obj({ name: text(128), unit: text(64), direction: { type: "string", enum: ["max", "min"] } }, ["name", "unit", "direction"]) },
  seeds: { type: "array", minItems: 1, maxItems: 1000, items: seed },
  limits: obj({ cpus: { type: "number", minimum: 0.1, maximum: 256 }, memoryMb: integer(16, 1_048_576), pidsLimit: integer(1, 65_536), wallSeconds: integer(1, 604_800), gpus: integer(0, 64) }, ["cpus", "memoryMb", "pidsLimit", "wallSeconds", "gpus"]),
  network: { type: "string", enum: ["none"] },
  inputs: { type: "object", maxProperties: 8, properties: {}, additionalProperties: obj({ path: text(4096), sha256: text(64), mount: obj({ candidate: text(256), evaluator: text(256) }, []) }, ["path", "sha256", "mount"]) },
  budget: obj({ maxAttempts: integer(1, 1_000_000), maxWallHours: { type: "number", minimum: 0.000001, maximum: 1_000_000 }, maxGpuHours: { type: "number", minimum: 0, maximum: 64_000_000 } }, ["maxAttempts", "maxWallHours", "maxGpuHours"]),
}, ["v", "method", "candidate", "evaluator", "metrics", "seeds", "limits", "network", "budget"]);

const STAGE_PROTOCOL = obj({ ...PROTOCOL_V1.properties,
  v: { type: "integer", enum: [2] },
  inputs: undefined,
  candidate: obj({ stages: { type: "array", minItems: 1, maxItems: 16, items: obj({
    name: text(32), reuse: STAGE_REUSE_CONTRACT_SCHEMA, image, command: argv, env: { type: "object", maxProperties: 64, properties: {}, additionalProperties: { type: "string", maxLength: 4096 } },
    seed: { type: "boolean" }, code: { type: "string", enum: ["snapshot"] },
    needs: { type: "array", maxItems: 16, items: text(32) },
    inputs: { type: "object", maxProperties: 32, additionalProperties: { oneOf: [obj({ task: text(256) }, ["task"]), obj({ stage: text(32), output: text(32) }, ["stage", "output"])] } },
    outputs: { type: "object", maxProperties: 32, additionalProperties: text(256) },
  }, ["name", "image", "command", "seed", "code", "needs", "inputs", "outputs"]) } }, ["stages"]),
}, PROTOCOL_V1.required);
// Omit the v1 external-input property entirely; undefined is not a JSON schema.
delete STAGE_PROTOCOL.properties.inputs;
const PROTOCOL = { oneOf: [PROTOCOL_V1, STAGE_PROTOCOL] };

const planId = text(PLAN_ID_BYTES);
const PLAN = obj({
  v: { type: "integer", enum: [1] }, revision: integer(1, Number.MAX_SAFE_INTEGER),
  nodes: { type: "array", maxItems: 128, items: obj({
    id: planId, kind: { type: "string", enum: ["step", "hub", "gate"] }, phase: { type: "string", enum: [...PHASES] },
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
  { name: "ares_retention_inspect", description: "Inspect executor-local retained identities, quota reservations and tombstones without a study write. Active sources/consumers remain explicit; no artifact bodies are returned.", inputSchema: obj({study, offset: integer(0, 16_000_000), limit: integer(1, 500)}, ["study"]), annotations: {...read, openWorldHint: true} },
  { name: "ares_retention_prune", description: "Preview explicit retained references by default. Confirm the returned fingerprint to dispose bytes under current design policy; active producers/consumers refuse. Tombstones preserve provenance. Executor tombstones remain authoritative after a crash before the local audit receipt; inspect them before retrying.", inputSchema: obj({study, refs: RETAINED_REFS, fingerprint: {...text(64), minLength: 64}}, ["study", "refs"]), annotations: {...net, destructiveHint: true} },
  {name: "ares_lesson_propose", description: "Propose a bounded lesson from a closed native harness round. Inspect required evidence/counterevidence explicitly; fixture-only single-task observations never establish real behavior, success or transfer.", inputSchema: obj({study, proposal: {type: "object"}}, ["study", "proposal"]), annotations: net},
  {name: "ares_lesson_list", description: "Read stored lesson proposals and dispositions locally, without current source checks. Stored eligibility is not fresh proof; no body or activation.", inputSchema: obj({study}, ["study"]), annotations: read},
  {name: "ares_lesson_check", description: "Explicitly recheck a lesson's current native closure and screened evidence/counterevidence without writing. Integrity never establishes support; no body is retained.", inputSchema: obj({study, name: text(64)}, ["study", "name"]), annotations: {...read, openWorldHint: true}},
  {name: "ares_lesson_decide", description: "Record a hash-bound lesson disposition. Acceptance rechecks sources under the study lock and requires exact fixture-strength acknowledgement; not adoption, activation or transfer evidence.", inputSchema: obj({study, name: text(64), decision: obj({decision: {type: "string", enum: ["accept", "reject", "withdraw"]}, proposalSha256: text(64), evidenceFingerprint: text(64), reason: text(2000), acknowledgeStrength: text(1000)}, ["decision", "proposalSha256", "evidenceFingerprint", "reason"])}, ["study", "name", "decision"]), annotations: net},
  { name: "ares_skill_check", description: "Explicit read-only source check of a proposal under one 25s/256KiB aggregate response budget. Evidence and counterevidence share the same owner-screened exact-id/local snapshot rules. Integrity/outcome never imply support; no body, export or installation.", inputSchema: obj({study, name: text(64)}, ["study", "name"]), annotations: {...read, openWorldHint: true} },
  { name: "ares_harness_close", description: "Preview/confirm an immutable baseline-kept, inconclusive or withdrawn closure without any adoption. Record binding, current evidence fingerprint, outcome, actor and reason; source/evidence drift marks it stale and preserves it. Never scientific success or transfer.", inputSchema: obj({study, round: text(64), closure: {type: "object"}, confirm: text(64)}, ["study", "round", "closure"]), annotations: write },
  { name: "ares_harness_contrast", description: "Record an actor-attributed fixture contrast against current admitted probe/output hashes and evidence fingerprint. Subjective judgments stay separate from task checks; no native metric or transfer authority.", inputSchema: obj({study, round: text(64), contrast: {type: "object"}}, ["study", "round", "contrast"]), annotations: write },
  { name: "ares_harness_compose", description: "Record per-section keep/drop/revise decisions linked to current contrasts, declaring at most one successor hash. A new successor remains unexecuted until its own exact fixture execution; real evidence is unavailable.", inputSchema: obj({study, round: text(64), composition: {type: "object"}}, ["study", "round", "composition"]), annotations: write },
  { name: "ares_harness_adopt", description: "Preview an experimental fixture-only adoption with a distinct independent deterministic check (unavailable for current fixtures); confirm its returned fingerprint to commit disposition and closure together under the round gate. Does not create correctness, scientific success or demonstrated transfer.", inputSchema: obj({study, round: text(64), decision: {type: "object"}, confirm: text(64)}, ["study", "round", "decision"]), annotations: write },
  { name: "ares_harness_stream_set", description: "Fix an immutable ordered 1..16-task experiment stream before its first harness round. No source reads or execution.", inputSchema: obj({study, stream: {type: "object"}}, ["study", "stream"]), annotations: write },
  { name: "ares_harness_stream_show", description: "Read the receipted immutable local harness stream without writes or source reads.", inputSchema: obj({study}, ["study"]), annotations: read },
  { name: "ares_experience_select", description: "Rank project lessons, then screen only explicit full ids backed by earlier same-study accepted unchanged lesson/archive receipts. Fixture-only preparation, never live/controlled eligibility; stores no bodies or memory writes.", inputSchema: obj({study, selection: {type: "object"}}, ["study", "selection"]), annotations: {...read, openWorldHint: true} },
  { name: "ares_experience_freeze", description: "Freeze immutable body-free source pins before a round. Empty controls or screened earlier reviewed/archived fixture lessons only; model/runtime/toolset must match. Synthetic context refuses controlled/live use. No activation or memory write.", inputSchema: obj({study, context: {type: "object"}}, ["study", "context"]), annotations: net },
  { name: "ares_experience_check", description: "Pre-handoff local integrity and model/runtime check plus owning screened exact-id source recheck. Unavailable/changed sources block the frozen context. Does not launch improvement or worker sessions.", inputSchema: obj({study, round: text(64), model: text(HARNESS_MODEL_BYTES), runtime: text(128), toolsetSha256: text(64)}, ["study", "round", "model", "runtime"]), annotations: {...read, openWorldHint: true} },
  { name: "ares_harness_set", description: "Set an experiment's bounded ares-owned harness round definition; no model/probe launch. Guidance and frozen refs bind a separate harness gate.", inputSchema: obj({study, round: {type: "object"}}, ["study", "round"]), annotations: write },
  { name: "ares_harness_show", description: "Read local harness definitions and synthetic fixture declarations. End-to-end evaluation and real producer import stay unavailable.", inputSchema: obj({study, round: text(64)}, ["study"]), annotations: read },
  { name: "ares_harness_import", description: "Record a declared ares-owned synthetic probe fixture under the round gate. Not producer wire import, host-observed evidence or a matched execution; never starts probes.", inputSchema: obj({study, round: text(64), fixture: {type: "object"}}, ["study", "round", "fixture"]), annotations: write },
  { name: "ares_lineage_show", description: "Read bounded local source-proven lineage, optionally rooted at a local ExecutionReferenceV1 and continued with an opaque cursor. No executor, hub, network, repair, gate decision or result authority.", inputSchema: obj({ study, root: EXECUTION_REFERENCE, cursor: text(4096) }, ["study"]), annotations: read },
  { name: "ares_lineage_compare", description: "Compare existing source-derived attempt or closed-candidate rows. Select either 1..8 attempts or 1..8 full candidate commits. Failed/unknown outcomes remain visible; retries are not independent samples. No new arithmetic aggregation, winner or verdict.", inputSchema: obj({ study, attempts: LINEAGE_ATTEMPTS, candidates: LINEAGE_CANDIDATES }, ["study"]), annotations: read },
  { name: "ares_autonomy_show", description: "Read the study autonomy policy and effective mode for each phase; no writes.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_autonomy_set", description: `Set the default or one phase autonomy mode (${AUTONOMY_MODES.join("|")}) and record from/to/phase. Only auto approves pending gates; existing gate decisions remain unchanged. Copilot draft acceptance and step pausing are separate features.`, inputSchema: obj({ study, mode: text(16), phase: text(32) }, ["study", "mode"]), annotations: write },
  { name: "ares_watch_set", description: "Set bounded v1 literature queries and an optional display-only rubric. At most 20 queries; identical config is a no-op. Does not search, screen or start a timer. Survey and experiment studies.", inputSchema: obj({ study, watch: WATCH }, ["study", "watch"]), annotations: { ...write, idempotentHint: true } },
  { name: "ares_watch_run", description: "Start one finite watch pass and return {started:true,configSha256} after config, scope gate and year preflight. Always detached: this ack is not completion. Inspect ares_watch_show for the watch.ran outcome. The background pass holds the study lock for up to about 20 minutes; duplicate starts refuse. Adds only new candidates, never screens. No timer or daemon is started.", inputSchema: obj({ study }, ["study"]), annotations: net },
  { name: "ares_watch_show", description: "Read watch config, recent event-timed run receipts and new candidates. No lock, network or write.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_console_add", description: "Register one readable study directory in the private bounded family registry. Does not scan the disk or activate the console. An already registered directory is a no-op.", inputSchema: obj({ study }, ["study"]), annotations: { ...write, idempotentHint: true } },
  { name: "ares_console_remove", description: "Remove only a listed study registration, including an unavailable path. Does not delete the study; absent entries are a no-op.", inputSchema: obj({ study }, ["study"]), annotations: { ...write, idempotentHint: true } },
  { name: "ares_console_list", description: "Read the private bounded study registry without scanning the disk or removing unavailable entries. No lock, network or write.", inputSchema: obj({}, []), annotations: read },
  { name: "ares_setup", description: "Preview, apply or undo a local agent-client MCP entry or console plugin manifest {api,tool,module,sha256}. Defaults to dry-run and lists config/receipt actions. Apply writes the receipt first; undo refuses entry drift. Root pins a release; cwd selects the workspace for agy. Never changes instruction blocks or contacts the network.", inputSchema: obj({ target: { type: "string", enum: [...SETUP_TARGETS, "all", "console"] }, mode: { type: "string", enum: ["dry-run", "apply", "undo"] }, root: text(4096), cwd: text(4096) }, ["target"]), annotations: write },
  { name: "ares_manifest", description: "Read this ares version, implemented commands and shared schema versions without opening a study or reaching an executor.", inputSchema: obj({}, []), annotations: read },
  { name: "ares_archive", description: "Preview pending derived lessons without writes. With the current full-list fingerprint, export up to 200 new amem notes and commit returned ids/hashes; remaining reports later batches. A partial failure records successes; repeat the same confirmation to continue. Applies to survey and experiment studies.", inputSchema: obj({ study, confirm: { type: "string", minLength: 64, maxLength: 64 } }, ["study"]), annotations: net },
  { name: "ares_lessons", description: "Read project-scoped amem lessons with half-life ranking. Query intent when supplied, otherwise the study question; intent also returns a brief. Output relevance, decayed score, ordinal rank and age in days. No study write or lock. Survey and experiment.", inputSchema: obj({ study, for: text(1000), halfLife: { type: "number", minimum: 1, maximum: 3650 }, limit: integer(1, 50) }, ["study"]), annotations: { ...read, openWorldHint: true } },
  { name: "ares_skill_propose", description: "Queue a source-inspected v2 proposal; caller-supplied inspections are refused. Evidence and counterevidence share one 25s/256KiB budget. At most 100 proposals, bounded 16 KiB Markdown plus receipt. Does not create a PR. Survey and experiment.", inputSchema: obj({ study, proposal: SKILL }, ["study", "proposal"]), annotations: {...write, openWorldHint: true} },
  { name: "ares_skill_decide", description: "Record a final accept/reject/withdraw with reason and actor. Accept requires an HTTP(S) PR URL without credentials; never checks or merges the PR. V2 acceptance rechecks all evidence and counterevidence under the owned lock; changed/unavailable sources require a revised proposal. Withdraw only while proposed. Survey and experiment.", inputSchema: obj({ study, name: text(64), decision: { type: "string", enum: ["accept", "reject", "withdraw"] }, reason: text(16384), pr: text(16384) }, ["study", "name", "decision", "reason"]), annotations: {...write, openWorldHint: true} },
  { name: "ares_skill_list", description: "Read all skill proposal states after verifying bounded Markdown against receipts. No lock, subprocess or write. Survey and experiment.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_plan_set", description: "Validate a bounded revisioned DAG of existing steps, local gates and read-only hub references. Set it paused; changed consumed inputs become stale and need explicit retry. Never starts a controller.", inputSchema: obj({ study, plan: PLAN }, ["study", "plan"]), annotations: write },
  { name: "ares_plan_control", description: "Pause/resume admission or retry/cancel/skip a node. Requires a durable command id and expected definition revision: identical replay returns its original receipt; changed payloads/stale new requests refuse. Does not start a controller; run ares run separately. Cancelling an attempt may contact its executor; hub cancellation stays local.", inputSchema: obj({ study, action: { type: "string", enum: ["pause", "resume", "retry", "cancel", "skip"] }, node: text(128), commandId: text(128), expectedRevision: integer(1, Number.MAX_SAFE_INTEGER) }, ["study", "action", "commandId", "expectedRevision"]), annotations: net },
  { name: "ares_plan_show", description: "Read the definition revision, ledger-derived node states and last observations, gate decisions, uncertain nodes, controller owner and resolved hubProject without taking a lock or contacting an executor/hub.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_status", description: "Study summary: gates, candidate counts, verification counts, bibliography.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_study_export", description: "Write a content-free study bundle (manifest, reduced ledger, attempt rows, closed results, review counts, evidence hashes) from committed study files into a new or empty directory. Refuses the whole export if a path, URL, env value or key-like token would be written. list=true only names the files. No executor or network.", inputSchema: obj({ study, bundle: text(4096), list: { type: "boolean" } }, ["study", "bundle"]), annotations: write },
  { name: "ares_scope_set", description: "Set scope.json (question, subquestions, include, exclude, yearFrom, yearTo, maxCandidates). A change returns the scope gate to pending.", inputSchema: obj({ study, scope: SCOPE }, ["study", "scope"]), annotations: write },
  { name: "ares_gate", description: "List gates, or approve/reject scope, screen, design, final, review, plan:node-id, accept:hypotheses|paper|reviews or harness:<round-id>. Copilot accepts bind current draft hashes and are never automatic. Plan approvals bind all upstream output references and need complete upstream outputs; skip never bypasses them. The ledger records the actor; approval authority is workspace policy.", inputSchema: obj({ study, action: { type: "string", enum: ["list", "approve", "reject"] }, gate: text(PLAN_GATE_BYTES), reason }, ["study", "action"]), annotations: write },
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
  { name: "ares_protocol_set", description: "Set an experiment protocol after bounded validation of protocol and task/. Sealed identity changes reopen design approval; same-identity input locator-only edits preserve approval. Comparable attempt identity excludes budget and input locators.", inputSchema: obj({ study, protocol: PROTOCOL }, ["study", "protocol"]), annotations: write },
  { name: "ares_executor_set", description: "Configure local or SSH Docker execution with an explicit private absolute workdir. Stores the host alias only, never credentials. Optional gpu settings enable a one-pass device/memory/load admission check; failed admission defers without an attempt.", inputSchema: obj({ study, kind: { type: "string", enum: ["local", "ssh"] }, host: text(128), workdir: text(4096), retentionCapBytes: integer(1, 1024 ** 4), gpu: obj({ devices: { type: "array", minItems: 1, maxItems: 64, items: { type: ["string", "integer"], maxLength: 40 } }, minFreeMemoryMb: integer(0, 2147483647), maxLoadRatio: { type: "number", exclusiveMinimum: 0, maximum: 1000000 } }, ["devices", "minFreeMemoryMb", "maxLoadRatio"]) }, ["study", "kind", "workdir"]), annotations: write },
  { name: "ares_executor_inputs_hash", description: "Hash a pre-staged input directory on the configured local or SSH executor host. Returns only sha256, files and bytes; never copies input paths or bodies into the study. Read-only external host access, with no gate or ledger write.", inputSchema: obj({ study, path: text(4096) }, ["study", "path"]), annotations: { ...read, openWorldHint: true } },
  { name: "ares_executor_check", description: "Check executor Docker server, non-root uid:gid and digest-pinned image availability; pulls missing images.", inputSchema: obj({ study }, ["study"]), annotations: net },
  { name: "ares_attempt_run", description: "Start a frozen-commit experiment attempt and return without waiting for completion. Always detached; requires approved design in gates mode. Default reuse is off; eligible mode considers reviewed deterministic candidate artifacts in investigate only. forceFresh preserves the explicit retry path and never reuses evaluator/final metrics. Duplicate requests return the existing attempt. GPU admission can return status deferred with devices/load/probe reason and exitCode 75, without creating an attempt; no automatic retry.", inputSchema: obj({ study, repo: text(4096), commit: { type: "string", minLength: 40, maxLength: 40 }, seed, run, label: text(128), retry: attemptId, reuse: { type: "string", enum: ["off", "eligible"] }, forceFresh: { type: "boolean" } }, ["study", "repo", "commit"]), annotations: net },
  { name: "ares_attempt_list", description: "List bounded attempt summaries without protocol or artifact lists. Limit defaults to 50 (maximum 200), with offset pagination. Totals cover every whole-study status regardless of filters or page.", inputSchema: obj({ study, run, status: { type: "string", enum: ["running", "succeeded", "failed", "cancelled", "unknown"] }, limit: integer(1, 200), offset: integer(0, 1_000_000) }, ["study"]), annotations: read },
  { name: "ares_attempt_show", description: "Read an attempt record, its executor, stage receipts, metrics and artifact metadata. Logs remain on the executor.", inputSchema: obj({ study, id: attemptId }, ["study", "id"]), annotations: read },
  { name: "ares_attempt_cancel", description: "Stop the running stage and record cancelled; repeated cancellation preserves the terminal attempt.", inputSchema: obj({ study, id: attemptId, reason }, ["study", "id"]), annotations: net },
  { name: "ares_attempt_reconcile", description: "Observe recorded containers, advance candidate/evaluator stages and record terminal states. Lost containers become unknown; reconcile never starts a new attempt.", inputSchema: obj({ study }, ["study"]), annotations: net },
  { name: "ares_attempt_logs", description: "Retrieve executor log text read-only without recording content in the study. Optionally select stage/stream and candidateStage (a declared v2 name, including completed candidates). tailBytes is 0..65536 per selected stream; default 16384 is reduced for aggregate tails above 256KiB. Copies are checked against recorded size and sha256.", inputSchema: obj({ study, id: attemptId, stage, candidateStage: text(32), stream, tailBytes: integer(0, 65_536) }, ["study", "id"]), annotations: { ...read, openWorldHint: true } },
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
export function createAresMcp(env: NodeJS.ProcessEnv, http: Http = createHttp(env), runtime: ops.ExperimentRuntime = {}): { tools: readonly McpTool[]; handlers: Record<string, McpHandler>; waitForIdle(): Promise<void>; terminate(): void } {
  const detected = detectActor(env), actor: Actor = { kind: "agent", id: detected.kind === "agent" ? detected.id! : "mcp" };
  const ctx = { ...runtime, actor, http }, memoryEnv = { ...env, AGENTHUB_PEER_ID: actor.id };
  const dir = (a: Record<string, unknown>) => absolute(a.study, "study");
  const background = new Map<Promise<void>, () => void>();
  const track = (completion: Promise<void>, terminate: () => void) => { background.set(completion, terminate); void completion.then(() => { background.delete(completion); }); };
  const handlers: Record<string, McpHandler> = {
    ares_retention_inspect: a => ops.retentionInspect(dir(a), ctx, { ...(a.offset === undefined ? {} : { offset: a.offset as number }), ...(a.limit === undefined ? {} : { limit: a.limit as number }) }),
    ares_retention_prune: a => ops.retentionPrune(dir(a), {refs: a.refs as RetainedRef[], ...(a.fingerprint === undefined ? {} : {fingerprint: a.fingerprint as string})}, ctx),
    ares_lesson_propose: a => ops.lessonPropose(dir(a), a.proposal, ctx, env),
    ares_lesson_list: a => ops.lessonList(dir(a)),
    ares_lesson_check: a => ops.lessonCheck(dir(a), a.name as string, ctx, env),
    ares_lesson_decide: a => ops.lessonDecide(dir(a), a.name as string, a.decision, ctx, env),
    ares_skill_check: a => ops.skillCheck(dir(a), a.name as string, ctx, env),
    ares_harness_close: a => ops.harnessClose(dir(a), a.round as string, a.closure, a.confirm as string | undefined, ctx),
    ares_harness_contrast: a => ops.harnessContrast(dir(a), a.round as string, a.contrast, ctx),
    ares_harness_compose: a => ops.harnessCompose(dir(a), a.round as string, a.composition, ctx),
    ares_harness_adopt: a => ops.harnessAdopt(dir(a), a.round as string, a.decision, a.confirm as string | undefined, ctx),
    ares_harness_stream_set: a => ops.harnessStreamSet(dir(a), a.stream, ctx),
    ares_harness_stream_show: a => ops.harnessStreamShow(dir(a)),
    ares_experience_select: a => ops.experienceSelect(dir(a), a.selection, ctx, env),
    ares_experience_freeze: a => ops.experienceFreeze(dir(a), a.context, ctx, env),
    ares_experience_check: a => ops.experienceCheck(dir(a), a.round as string, {model: a.model as string, runtime: a.runtime as string, ...(a.toolsetSha256 !== undefined ? {toolsetSha256: a.toolsetSha256 as string} : {})}, ctx, env),
    ares_lineage_show: a => ops.lineageShow(dir(a), { ...(a.root === undefined ? {} : { root: a.root as ExecutionReferenceV1 }), ...(a.cursor === undefined ? {} : { cursor: a.cursor as string }) }),
    ares_lineage_compare: a => ops.lineageCompare(dir(a), { ...(a.attempts === undefined ? {} : { attempts: a.attempts as string[] }), ...(a.candidates === undefined ? {} : { candidates: a.candidates as string[] }) }),
    ares_autonomy_show: a => ops.autonomyShow(dir(a)),
    ares_autonomy_set: a => ops.autonomySet(dir(a), a.mode as string, a.phase as string | undefined, ctx),
    ares_watch_set: a => ops.watchSet(dir(a), a.watch, ctx),
    ares_watch_run: a => ops.watchRunDetached(dir(a), ctx, track),
    ares_watch_show: a => ops.watchShow(dir(a)),
    ares_console_add: a => ops.consoleAdd(dir(a), env),
    ares_console_remove: a => ops.consoleRemove(dir(a), env),
    ares_console_list: () => ops.consoleList(env),
    ares_manifest: () => ops.manifest(),
    ares_setup: a => ops.setup(a.target as string, (a.mode ?? "dry-run") as SetupMode, env, { ...(a.root === undefined ? {} : { root: absolute(a.root, "root") }), ...(a.cwd === undefined ? {} : { cwd: absolute(a.cwd, "cwd") }) }),
    ares_archive: a => ops.archive(dir(a), { ...(a.confirm === undefined ? {} : { confirm: a.confirm as string }) }, ctx, memoryEnv, undefined, {...runtime, env}),
    ares_lessons: a => ops.lessons(dir(a), { ...(a.for === undefined ? {} : { for: a.for as string }), ...(a.halfLife === undefined ? {} : { halfLife: a.halfLife as number }), ...(a.limit === undefined ? {} : { limit: a.limit as number }) }, ctx, memoryEnv),
    ares_skill_propose: a => ops.skillPropose(dir(a), a.proposal, ctx, env),
    ares_skill_decide: a => ops.skillDecide(dir(a), a.name as string, a.decision as string, a.reason as string, a.pr as string | undefined, ctx, undefined, env),
    ares_skill_list: a => ops.skillList(dir(a)),
    ares_plan_set: a => ops.planSet(dir(a), a.plan, ctx),
    ares_plan_control: a => ops.planControl(dir(a), { action: a.action as Parameters<typeof ops.planControl>[1]["action"], commandId: a.commandId as string, expectedRevision: a.expectedRevision as number, ...(a.node !== undefined ? { node: a.node as string } : {}) }, ctx),
    ares_plan_show: a => ops.planShow(dir(a)),
    ares_status: a => ops.status(dir(a)),
    ares_study_export: a => ops.studyExport(dir(a), { bundle: absolute(a.bundle, "bundle"), ...(a.list === true ? { list: true } : {}) }),
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
    ares_harness_set: a => ops.harnessSet(dir(a), a.round, ctx),
    ares_harness_show: a => ops.harnessShow(dir(a), a.round as string | undefined),
    ares_harness_import: a => ops.harnessImport(dir(a), a.round as string, a.fixture, ctx),
    ares_executor_set: a => ops.executorSet(dir(a), { v: 1, kind: a.kind, ...(a.host !== undefined ? { host: a.host } : {}), workdir: a.workdir, ...(a.retentionCapBytes !== undefined ? { retentionCapBytes: a.retentionCapBytes } : {}), ...(a.gpu !== undefined ? { gpu: a.gpu } : {}) }, ctx),
    ares_executor_inputs_hash: a => ops.executorInputsHash(dir(a), a.path as string, ctx),
    ares_executor_check: a => ops.executorCheck(dir(a), ctx),
    ares_attempt_run: a => ops.attemptRun(dir(a), { repo: absolute(a.repo, "repo"), commit: a.commit as string, ...(a.seed !== undefined ? { seed: a.seed as number } : {}), ...(a.run !== undefined ? { run: a.run as string } : {}), ...(a.label !== undefined ? { label: a.label as string } : {}), ...(a.retry !== undefined ? { retry: a.retry as string } : {}), ...(a.reuse !== undefined ? { reuse: a.reuse as "off" | "eligible" } : {}), ...(a.forceFresh !== undefined ? { forceFresh: a.forceFresh as boolean } : {}), detach: true }, ctx),
    ares_attempt_list: a => ops.attemptList(dir(a), { ...(a.run !== undefined ? { run: a.run as string } : {}), ...(a.status !== undefined ? { status: a.status as string } : {}), ...(a.limit !== undefined ? { limit: a.limit as number } : {}), ...(a.offset !== undefined ? { offset: a.offset as number } : {}) }),
    ares_attempt_show: a => ops.attemptShow(dir(a), a.id as string),
    ares_attempt_cancel: a => ops.attemptCancel(dir(a), a.id as string, a.reason as string | undefined, ctx),
    ares_attempt_reconcile: a => ops.attemptReconcile(dir(a), ctx),
    ares_attempt_logs: a => ops.attemptLogs(dir(a), a.id as string, { ...(a.stage !== undefined ? { stage: a.stage as "candidate" | "evaluator" } : {}), ...(a.candidateStage !== undefined ? { candidateStage: a.candidateStage as string } : {}), ...(a.stream !== undefined ? { stream: a.stream as "stdout" | "stderr" } : {}), ...(a.tailBytes !== undefined ? { tailBytes: a.tailBytes as number } : {}) }, ctx),
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
  return { tools: ARES_TOOLS, handlers,
    // Only for the entrypoint immediately before process exit; pending async work must not resume.
    terminate: () => { for (const stop of background.values()) { try { stop(); } catch { console.error("ares watch: termination receipt failed (storage); restore study storage and inspect ares watch show before retrying"); } } },
    waitForIdle: async () => { await Promise.all([...background.keys()]); } };
}
