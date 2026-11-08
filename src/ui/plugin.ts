/** Console api1 contract subset; runtime imports stay within ares/Node/Bun. Real contract/conformance is test-only. */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../../package.json";
import * as ops from "../commands.ts";
import { validateExecutionReference } from "../provenance.ts";
import { foldPlan, canonical, PLAN_GATE_BYTES } from "../plan/state.ts";
import { readRegistry, MAX_REGISTERED_STUDIES } from "../console/registry.ts";
import { readAttemptRecords, type Attempt } from "../exp/attempts.ts";
import { createHttp } from "../http.ts";
import { previewArchive, ARCHIVE_NOTES, ArchivePartialError } from "../memory/archive.ts";
import { spawnRunner, type ProcessRunner } from "../exp/executor.ts";
import { readProtocol } from "../exp/protocol.ts";
import { readSelection, selectionPath } from "../exp/selection.ts";
import { investigateResultPath } from "../exp/investigate.ts";
import { readClosedFinal, finalResultPath } from "../exp/final.ts";
import { readCurrentBuild, paperBuildPaths } from "../paper/build.ts";
import { loadCandidates } from "../lit/candidates.ts";
import { openStudy, readLedger, readBytesBounded, readTextBounded, sha256, boundedText, plain, isHarnessGate, type LedgerEvent } from "../study.ts";

type Args = Record<string, unknown>;
interface Context { home: string; log(line: string): void; features?: readonly string[] }
interface Verb { id: string; label: string; destructive?: boolean; reason?: "optional" | "required"; form?: { questions: { id: string; prompt: string; options: { id: string; label: string }[]; other?: { label?: string; maxLength?: number } }[] } }
interface Item { id: string; group: "decision" | "candidate" | "review" | "alert"; kind: string; title: string; detail?: string; project?: string; at: string; verbs: Verb[]; link: { panel: string; params: Record<string, string> } }
type ActionResult = { ok: true; message: string } | { ok: false; error: string } | { ok: false; needsConfirm: true; fingerprint: string; preview: string[] };
interface Runtime { runner?: ProcessRunner; env?: NodeJS.ProcessEnv; now?: () => number }
// Console calls allow 30s; leave 5s for partial receipts and the response after a child timeout.
export const CONSOLE_ARCHIVE_MS = 25_000;
interface Provider {
  assets: { js: string; css: string };
  snapshot(input: { after: number; panel: string } & Args): Promise<Args>;
  action(input: { action: string; confirmed?: true; fingerprint?: string } & Args, meta?: { identity: string; node: string; via: "console" }): Promise<ActionResult>;
  asset(input: { id: string }): Promise<{ bytes: Uint8Array; mime: string; name: string } | null>;
}
const EPOCH = new Date(0).toISOString(), ASSET_BYTES = 2 * 1024 * 1024;
const str = (value: unknown) => typeof value === "string" ? value : undefined;
const line = (value: string, max = 400) => value.replace(/\s+/g, " ").slice(0, max);
const error = (value: unknown) => value instanceof Error ? line(value.message) : "unreadable study data; restore the last valid study files";
const stamp = (value: unknown, fallback = EPOCH) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
function readCall<T>(name: string, fn: () => T, errors: Record<string, string>): T | null {
  try { return fn(); } catch (cause) { errors[name] = error(cause); return null; }
}
export interface GateInputs { selectionRun?: string; review?: { manuscriptSha256: string; evidenceSha256: string; ids: ReadonlySet<string> } }
/** Every gate advances only when an input consumed by its binder changes, never merely on an event kind. */
export function gateWaitingTimes(events: LedgerEvent[], inputs: GateInputs, observeSignature?: (gate: string, signature: string | undefined) => void): Map<string, string> {
  const waiting = new Map<string, string>(), previous = new Map<string, string | undefined>();
  const observe = (gate: string, input: unknown, at: string) => {
    const signature = input === undefined ? undefined : canonical(input);
    observeSignature?.(gate, signature);
    if (previous.get(gate) === signature) return;
    previous.set(gate, signature);
    if (signature === undefined) waiting.delete(gate); else waiting.set(gate, at);
  };
  foldPlan(events, (state, event) => {
    const names = new Set<string>();
    for (const node of state.nodes) if (node.kind === "gate") { const gate = `plan:${node.id}`; names.add(gate); observe(gate, node.gate?.current, event.at); }
    for (const gate of previous.keys()) if (gate.startsWith("plan:") && !names.has(gate)) { observe(gate, undefined, event.at); previous.delete(gate); }
  });
  const included = new Set<string>();
  let investigate: string | undefined, protocol: [string, string] | undefined, selection: string | undefined, reserved: string | undefined, ablate: string | undefined, hasAblations = false;
  let paper: [string, string] | undefined, reviewChanges = 0;
  const experiment = (at: string) => {
    // These are the exact source hashes in readDesign/finalGateBinding; only the selected run's close is consumed.
    const design = protocol ? [...protocol, ...(selection === undefined ? [] : [selection]), ...(reserved === undefined ? [] : [reserved])] : undefined;
    observe("design", design, at);
    observe("final", design && selection && reserved && investigate && (!hasAblations || ablate) ? [investigate, ablate ?? null, design] : undefined, at);
  };
  const review = (at: string) => {
    const current = inputs.review;
    // reviewBinding hashes only this build's added/resolved review events. Each valid selected event adds a hash.
    observe("review", current && paper?.[0] === current.manuscriptSha256 && paper[1] === current.evidenceSha256 ? [paper, reviewChanges] : undefined, at);
  };
  for (const event of events) {
    const data = event.data;
    switch (event.type) {
      case "harness.round.set": if (plain(data.round) && isHarnessGate(`harness:${String(data.round.id)}`) && typeof data.binding === "string") observe(`harness:${data.round.id}`, data.binding, event.at); break;
      case "scope.set": if (typeof data.sha256 === "string") observe("scope", data.sha256, event.at); break;
      case "lit.screen": {
        let changed = false;
        for (const id of Array.isArray(data.ids) ? data.ids : []) if (typeof id === "string") {
          if (data.decision === "include" && !included.has(id)) { included.add(id); changed = true; }
          else if (data.decision === "exclude" && included.delete(id)) changed = true;
        }
        if (changed) observe("screen", included.size ? [...included].sort() : undefined, event.at); break;
      }
      case "protocol.set":
        if (typeof data.sha256 === "string" && typeof data.treeHash === "string") protocol = [typeof data.identitySha256 === "string" ? data.identitySha256 : data.sha256, data.treeHash];
        experiment(event.at); break;
      case "selection.set": if (typeof data.sha256 === "string") selection = data.sha256; experiment(event.at); break;
      case "final.seeds.set": if (typeof data.sha256 === "string") reserved = data.sha256; experiment(event.at); break;
      case "investigate.closed": if (data.run === inputs.selectionRun && typeof data.sha256 === "string") investigate = typeof data.winner === "string" && /^[a-f0-9]{40}$/.test(data.winner) ? data.sha256 : undefined; experiment(event.at); break;
      case "ablation.added": hasAblations = true; experiment(event.at); break;
      case "ablate.closed": if (typeof data.sha256 === "string") ablate = data.sha256; experiment(event.at); break;
      case "paper.built":
        if (typeof data.manuscriptSha256 === "string" && typeof data.evidenceSha256 === "string") paper = [data.manuscriptSha256, data.evidenceSha256];
        review(event.at); break;
      case "review.added": if (typeof data.id === "string" && inputs.review?.ids.has(data.id)) { reviewChanges++; review(event.at); } break;
      case "review.resolved": if (typeof data.reviewId === "string" && inputs.review?.ids.has(data.reviewId)) { reviewChanges++; review(event.at); } break;
    }
  }
  return waiting;
}
function attempts(dir: string, all: boolean) {
  const byStatus = { running: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0 }, rows: Pick<Attempt, "id" | "status" | "reason">[] = [];
  let total = 0;
  for (const row of readAttemptRecords(dir)) {
    total++; byStatus[row.status]++;
    if (!all || (row.status !== "failed" && row.status !== "unknown")) continue;
    if (row.reason !== undefined && (typeof row.reason !== "string" || row.reason.length > 500)) throw new Error("attempt inbox: malformed reason; restore the last valid bounded attempt record and refresh");
    rows.push({ id: row.id, status: row.status, ...(row.reason === undefined ? {} : { reason: row.reason }) });
  }
  return { total, byStatus, rows };
}
/** Presence is not validity: any present artifact is still checked by its existing bounded reader. */
function recordPresent(file: string): boolean {
  try { lstatSync(file); return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
}
function loadStudy(dir: string, features: readonly string[], input: { panel: string; study?: string; id?: string }) {
  const { study } = openStudy(dir), events = readLedger(dir), errors: Record<string, string> = {}, key = sha256(dir).slice(0, 16);
  const detailed = input.panel === "study" && (input.study === dir || !input.study && input.id === study.id), inbox = input.panel === "inbox";
  const targets = new Map<string, Args>();
  const at = stamp(events.at(-1)?.at, stamp(study.createdAt)), items: Item[] = [], link = { panel: "study", params: { study: dir } };
  const add = (kind: string, entity: string, group: Item["group"], title: string, time: string, detail = "", verbs: Verb[] = [], subject?: Args) => {
    const id = `${kind}:${key}:${sha256(entity).slice(0, 16)}`;
    items.push({ id, group, kind, title: line(title, 180), detail: line(detail, 1000), project: study.id, at: stamp(time, at), verbs, link });
    if (subject) targets.set(id, { study: dir, ...subject, actions: verbs.map(verb => verb.id) });
  };
  const status = ops.status(dir), gates = ops.gateList(dir);
  const attempt = study.mode === "experiment" ? readCall("attempts", () => attempts(dir, inbox), errors) : null;
  let investigationArtifact: { state: "missing"; recalculated: true; message: string } | undefined;
  const investigation = detailed && study.mode === "experiment" ? readCall("investigation", () => {
    const configured = recordPresent(selectionPath(dir)) || events.some(event => event.type === "selection.set" || event.type === "investigate.closed");
    if (!configured) return null;
    const result = ops.investigateShow(dir);
    if (events.some(event => event.type === "investigate.closed" && event.data.run === result.run) && !recordPresent(investigateResultPath(dir, result.run))) {
      investigationArtifact = { state: "missing", recalculated: true,
        message: `Missing receipted artifact runs/${result.run}/investigate.json; this investigation result is recalculated from current inputs. Restore the artifact or run ares investigate close before using a closed result.` };
    }
    return result;
  }, errors) : null;
  const final = study.mode === "experiment" ? readCall("final", () => {
    const recorded = recordPresent(finalResultPath(dir)) || events.some(event => event.type === "final.closed");
    return recorded ? readClosedFinal(dir).result : null;
  }, errors) : null;
  const posthoc = detailed && study.mode === "experiment" ? readCall("posthoc", () => ops.posthocShow(dir), errors) : null;
  const review = readCall("review", () => ops.reviewShow(dir), errors), skills = detailed || inbox ? readCall("skills", () => ops.skillList(dir), errors) : null;
  const reviewFailure = review?.unmet.find(row => row.code === "review-journal");
  if (reviewFailure) errors.review = line(reviewFailure.message);
  const watch = readCall("watch", () => ops.watchShow(dir), errors), lastWatch = watch?.runs[0] ?? null;
  if (inbox) {
  const protocol = gates.some(row => row.gate === "final" && row.state === "pending") ? readProtocol(dir) : undefined;
  const gateTimes = gateWaitingTimes(events, {
    ...(protocol ? { selectionRun: readSelection(dir, protocol)?.run } : {}),
    ...(review?.buildSha256 && review.manuscriptSha256 ? { review: { manuscriptSha256: review.manuscriptSha256, evidenceSha256: review.buildSha256, ids: new Set(review.reviews.map(row => row.id)) } } : {}),
  });
  for (const gate of gates.filter(row => row.state === "pending")) add("gate", `${gate.gate}:${gate.current}`, "decision", `Approve or reject ${gate.gate}`, stamp(gateTimes.get(gate.gate), stamp(events[0]?.at, stamp(study.createdAt))), study.question,
    [{ id: "gate.approve", label: "Approve", destructive: true }, { id: "gate.reject", label: "Reject", destructive: true, reason: "required" }], { gate: gate.gate });
  const current = new Map(loadCandidates(dir).filter(row => row.status === "new").map(row => [row.id, row])), watched = new Map<string, LedgerEvent>();
  for (const event of events) if (event.type === "watch.ran" && Array.isArray(event.data.addedIds)) for (const id of event.data.addedIds) if (typeof id === "string" && current.has(id)) watched.set(id, event);
  for (const [id, event] of watched) add("candidate", id, "candidate", current.get(id)!.title, event.at, `${watch?.config?.rubric ? "See study rubric in the linked study panel (display-only)." : "No study rubric recorded."}\n${id}`,
    [{ id: "screen.include", label: "Include", destructive: true, reason: "required" }, { id: "screen.exclude", label: "Exclude", destructive: true, reason: "required" }], { ids: [id] });
  for (const [index, event] of events.entries()) if (event.type === "watch.ran" && Array.isArray(event.data.addedIds) && Number.isSafeInteger(event.data.addedIdsTotal)) {
    const overflow = Number(event.data.addedIdsTotal) - event.data.addedIds.length;
    if (overflow > 0) add("watch-overflow", String(index), "alert", `${overflow} watch candidate ids exceed the receipt list`, event.at,
      "Only recorded ids appear as candidate items. Unrecorded ids have no individual watch provenance; inspect ares watch show and the study's new candidates.");
  }
  for (const skill of skills ?? []) if (skill.state === "proposed") {
    const verbs: Verb[] = [{ id: "skill.reject", label: "Reject", destructive: true, reason: "required" }, { id: "skill.withdraw", label: "Withdraw", destructive: true, reason: "required" }];
    if (features.includes("inbox.form")) verbs.unshift({ id: "skill.accept", label: "Accept", destructive: true, reason: "required", form: { questions: [{ id: "pr", prompt: "Provide the reviewed PR URL", options: [{ id: "reviewed", label: "Reviewed PR is ready" }, { id: "pending", label: "Keep proposed" }], other: { label: "Reviewed PR URL", maxLength: 1000 } }] } });
    add("skill", skill.name, "review", skill.name, skill.at, skill.summary, verbs, { name: skill.name });
  }
  for (const finding of review?.openBlocking ?? []) {
    const row = review!.reviews.find(row => row.id === finding.reviewId);
    add("review", `${finding.reviewId}/${finding.findingId}`, "review", `${finding.kind}: ${finding.text}`, row?.at ?? at, finding.location);
  }
  const attemptEvents = new Map<string, LedgerEvent>();
  for (const event of events) if (typeof event.data.id === "string" && (event.data.status === "failed" || event.data.status === "unknown")) attemptEvents.set(`${event.data.id}:${event.data.status}`, event);
  for (const row of attempt?.rows ?? []) if (row.status === "failed" || row.status === "unknown") {
    const event = attemptEvents.get(`${row.id}:${row.status}`);
    add("attempt", row.id, "alert", `${row.status} attempt ${row.id}`, event?.at ?? at, row.reason ?? "Inspect ares attempt show before retrying");
  }
  for (const [index, event] of events.entries()) if (event.type === "watch.ran" && event.data.ok === false) {
    const cause = event.data.cause, known = typeof cause === "string" && ["terminated", "filesystem", "internal", "network", "rate", "server", "client", "format"].includes(cause);
    const title = cause === undefined ? "Every watch source failed" : known ? `Watch run failed (${cause})` : "Watch run failed (unknown cause)";
    const detail = cause === undefined ? "Inspect ares watch show and retry after restoring source access" : "Inspect ares watch show and lit list; restore study storage or source access as needed, then rerun ares watch run";
    add("watch", event.at + index, "alert", title, event.at, detail);
  }
  }
  const archive = detailed ? readCall("archive", () => { const preview = previewArchive(dir); return { pendingCount: preview.notes.length, fingerprint: preview.fingerprint }; }, errors) : null;
  const manuscript = detailed && readCall("manuscript", () => {
    const paths = paperBuildPaths(dir), recorded = recordPresent(paths.manuscript) || recordPresent(paths.evidence) || events.some(event => event.type === "paper.built");
    return recorded ? readCurrentBuild(dir) : null;
  }, errors) ? { id: `manuscript:${study.id}` } : null;
  const failures = Object.entries(errors);
  if (inbox && failures.length) {
    const perFailure = Math.floor(800 / failures.length);
    add("partial-read", "records", "alert", "Study data partially unavailable", at,
      failures.map(([name, reason]) => `${name}: ${line(reason, Math.max(20, perFailure - name.length - 2))}`).join("; ") + "; Inspect the study panel, restore readable records or use a compatible ares version, then refresh.");
  }
  const summary = { id: study.id, dir, available: true, question: status.question, mode: status.mode, autonomy: status.autonomy, gates,
    attempts: attempt ? { total: attempt.total, byStatus: attempt.byStatus } : study.mode === "experiment" ? { available: false, reason: errors.attempts ?? "Attempt records could not be read; inspect ares attempt list and restore readable records, then refresh" } : { total: 0, byStatus: {} },
    final: final ? { status: final.status, ...(final.reason ? { reason: final.reason } : {}) } : null,
    review: review ? { ready: review.ready, unmet: review.unmet } : null, lastWatch };
  return { summary, targets, detail: detailed ? { ...summary, investigation, investigationArtifact: investigationArtifact ?? null, final, posthoc, review, skills, watch, archive, manuscript, errors } : null, items, at };
}
interface Selection { wireAction: string; action: "gate" | "screen" | "skill.decide" | "archive.confirm"; study: string; gate?: string; ids?: string[]; name?: string; decision?: string; reason?: string; pr?: string }
const ACTIONS: Record<string, { action: Selection["action"]; decision?: string; fields: readonly string[] }> = {
  "gate.approve": { action: "gate", decision: "approve", fields: ["gate", "reason"] }, "gate.reject": { action: "gate", decision: "reject", fields: ["gate", "reason"] },
  "screen.include": { action: "screen", decision: "include", fields: ["ids", "reason"] }, "screen.exclude": { action: "screen", decision: "exclude", fields: ["ids", "reason"] },
  "skill.accept": { action: "skill.decide", decision: "accept", fields: ["name", "reason", "pr"] }, "skill.reject": { action: "skill.decide", decision: "reject", fields: ["name", "reason"] }, "skill.withdraw": { action: "skill.decide", decision: "withdraw", fields: ["name", "reason"] },
  "archive.confirm": { action: "archive.confirm", fields: [] },
};
function refusal(message: string): never { throw new Error(`console action: ${message}; refresh the study and review a new preview before confirming`); }
function field(value: unknown, name: string, max = 500): string {
  let text: string;
  try { text = boundedText(value, `console ${name}`, max); } catch { refusal(`${name} requires nonblank text within ${max} bytes`); }
  if (Buffer.byteLength(text) > max) refusal(`${name} exceeds ${max} bytes`); return text;
}
const SHELL_FIELDS = ["action", "study", "id", "answers", "confirmed", "fingerprint"];
function validateActionInput(input: Args): void {
  if (typeof input.action !== "string" || !Object.hasOwn(ACTIONS, input.action)) refusal("unknown action");
  const route = ACTIONS[input.action]!;
  const extra = Object.keys(input).find(key => !SHELL_FIELDS.includes(key) && !route.fields.includes(key));
  if (extra !== undefined) refusal(`unknown field ${line(extra, 80)} for ${input.action}; remove it`);
}
function selection(input: Args, home: string): Selection {
  if (typeof input.action !== "string" || !Object.hasOwn(ACTIONS, input.action)) refusal("unknown action");
  const route = ACTIONS[input.action]!, action = route.action;
  const study = typeof input.study === "string" ? input.study : refusal("study must be a registered absolute directory");
  if (!readRegistry(home).studies.includes(study)) refusal("study is not registered; use ares console add for this readable study");
  const result: Selection = { action, wireAction: input.action, study };
  if (action === "archive.confirm") return result;
  result.decision = route.decision!;
  if (action === "gate") {
    result.gate = field(input.gate, "gate", PLAN_GATE_BYTES);
    if (!["approve", "reject"].includes(result.decision)) refusal("gate decision must be approve or reject");
  } else if (action === "screen") {
    if (!["include", "exclude"].includes(result.decision)) refusal("screen decision must be include or exclude");
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 200) refusal("screen requires 1..200 candidate ids");
    result.ids = [...new Set(input.ids.map(id => field(id, "candidate id", 300)))].sort();
  } else {
    result.name = field(input.name, "skill name", 64);
    if (!["accept", "reject", "withdraw"].includes(result.decision)) refusal("skill decision must be accept, reject or withdraw");
    if (input.pr !== undefined) {
      result.pr = field(input.pr, "PR URL", 1000);
      try { const url = new URL(result.pr); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); }
      catch { refusal("PR must be an HTTP(S) URL without credentials"); }
    }
    if (result.decision === "accept" && !result.pr) refusal("accept requires the reviewed PR URL");
  }
  if (input.reason !== undefined || action !== "gate" || result.decision === "reject") result.reason = field(input.reason, "reason", action === "skill.decide" ? 16384 : 500);
  return result;
}
function boundAction(value: Selection) {
  const { study, action } = value, identity = openStudy(study).study, preview = [`Study: ${identity.question}`];
  if (realpathSync(study) !== study) refusal("registered study path now resolves elsewhere; register the resolved directory");
  let binding: unknown, archiveFingerprint: string | undefined;
  if (action === "gate") {
    const gate = ops.gateList(study).find(row => row.gate === value.gate);
    if (!gate?.current || gate.state !== "pending") refusal("gate is missing or no longer pending");
    binding = gate; preview.push(`${value.decision} gate ${value.gate}`, `Binding: ${gate.current}`);
  } else if (action === "screen") {
    const all = loadCandidates(study), chosen = value.ids!.map(id => all.find(row => row.id === id));
    if (chosen.some(row => !row || row.status !== "new")) refusal("candidate selection is missing or no longer new");
    binding = all; preview.push(`${value.decision} ${chosen.length} candidate(s)`, ...chosen.map(row => line(`${row!.id}: ${row!.title}`, 250)));
  } else if (action === "skill.decide") {
    const skill = ops.skillList(study).find(row => row.name === value.name);
    if (!skill || skill.state !== "proposed") refusal("proposal is missing or already decided");
    binding = skill; preview.push(`${value.decision} skill ${skill.name}`, `Proposal: ${skill.sha256}`, ...(value.pr ? [`Reviewed PR: ${value.pr}`] : []));
  } else {
    const archive = previewArchive(study); archiveFingerprint = archive.fingerprint; binding = { fingerprint: archive.fingerprint, pending: archive.notes.map(row => row.sha256) };
    preview.push(`Export ${Math.min(ARCHIVE_NOTES, archive.notes.length)} of ${archive.notes.length} pending lesson(s) to amem`, `Archive fingerprint: ${archive.fingerprint}`);
  }
  if (value.reason) preview.push(`Reason: ${value.reason}`);
  return { fingerprint: sha256(canonical({ selection: value, study: identity, binding })), preview, archiveFingerprint };
}
const LINEAGE_PARAMS = ["rootKind", "rootId", "rootRevision", "rootSha256", "graphCursor", "attempts", "candidates"] as const;
function readParam(input: Args, name: typeof LINEAGE_PARAMS[number]): string | undefined {
  const value = input[name]; if (value === undefined) return undefined;
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 4096) throw new Error(`console ${name}: bounded text required; correct the view parameters and retry`);
  return value;
}
/** Explicit read panels only; the ordinary overview/inbox polling paths never call these operations. */
function executionPanel(dir: string, input: Args): Args {
  if (input.panel === "harness") return {harness: ops.harnessShow(dir, input.round as string | undefined)};
  if (input.panel === "compare") {
    if (["rootKind", "rootId", "rootRevision", "rootSha256", "graphCursor"].some(name => input[name] !== undefined)) throw new Error("console compare: use only attempts or candidates selection parameters; clear lineage filters and retry");
    const attempts = readParam(input, "attempts"), candidates = readParam(input, "candidates");
    if (attempts === undefined && candidates === undefined) return {comparison: null};
    return {comparison: ops.lineageCompare(dir, {...(attempts === undefined ? {} : {attempts: attempts.split(",")}), ...(candidates === undefined ? {} : {candidates: candidates.split(",")})})};
  }
  if (input.attempts !== undefined || input.candidates !== undefined) throw new Error("console lineage: use root fields and graphCursor; clear comparison selectors and retry");
  const kind = readParam(input, "rootKind"), id = readParam(input, "rootId"), revision = readParam(input, "rootRevision"), hash = readParam(input, "rootSha256"), cursor = readParam(input, "graphCursor");
  const rooted = [kind, id, revision, hash].some(value => value !== undefined);
  if (rooted && (kind === undefined || id === undefined)) throw new Error("console lineage: partial root; pass rootKind and rootId together and retry");
  let root;
  if (rooted) {
    root = validateExecutionReference({v: 1, tool: "ares", projectKey: "pending-study-identity", kind, id, ...(revision === undefined ? {} : {revision}), ...(hash === undefined ? {} : {sha256: hash})});
    try { root = {...root, projectKey: openStudy(dir).study.id}; }
    catch { return {lineage: ops.lineageShow(dir)}; }
  }
  return {lineage: ops.lineageShow(dir, {...(root === undefined ? {} : {root}), ...(cursor === undefined ? {} : {cursor})})};
}
export function createPlugin(runtime: Runtime = {}) { return {
  manifest: { api: 1 as const, tool: "ares", version, title: "Research", icon: "agents", pollMs: 15000,
    panels: [{ id: "studies", title: "Studies", order: 1 }, { id: "study", title: "Study", order: 2 }, { id: "lineage", title: "Lineage", order: 3 }, { id: "compare", title: "Compare attempts", order: 4 }, {id: "harness", title: "Harness rounds", order: 5}],
    capabilities: { actions: Object.keys(ACTIONS), confirm: true, inbox: true, multiProject: false, search: false } },
  async open(ctx: Context): Promise<Provider> {
    const assets = { js: readTextBounded(fileURLToPath(new URL("./panel.js", import.meta.url)), 262144), css: readTextBounded(fileURLToPath(new URL("./panel.css", import.meta.url)), 262144) };
    const seen = new Map<string, string>(), lastAt = new Map<string, string>(), targets = new Map<string, Args>();
    const env = { ...(runtime.env ?? process.env), AGENTHUB_HOME: ctx.home };
    const http = createHttp(env, async () => { throw new Error("console actions do not perform network searches"); });
    return {
      assets,
      async snapshot(input) {
        const explicitRead = input.panel === "lineage" || input.panel === "compare" || input.panel === "harness";
        const emptyRead = input.panel === "harness" ? {harness: null} : {lineage: null, comparison: null};
        if (explicitRead) {
          const allowed = ["panel", "study", "after", ...(input.panel === "harness" ? ["round"] : LINEAGE_PARAMS)], extra = Object.keys(input).find(name => !allowed.includes(name));
          if (extra !== undefined) return {cursor: 0, changed: true, study: null, ...emptyRead, error: `console read snapshot: unknown field ${line(extra, 80)}; allowed fields: ${allowed.join(", ")}; correct the view parameters and retry`};
          if (input.panel === "harness" && input.round !== undefined && (typeof input.round !== "string" || !isHarnessGate(`harness:${input.round}`))) return {cursor: 0, changed: true, study: null, harness: null, error: "console harness: invalid round; pass a 1..64 character ASCII run-name and retry"};
        }
        const registry = readRegistry(ctx.home);
        const cursor = registry.studies.reduce((sum, dir) => {
          try { const info = statSync(join(dir, "ledger.jsonl")); return sum + (info.isFile() ? info.size : 0); } catch { return sum; }
        }, 0);
        const view = canonical([input.panel, str(input.study) ?? str(input.id) ?? "", ...(input.panel === "harness" ? ["round"] : LINEAGE_PARAMS).map(name => typeof input[name] === "string" ? sha256(input[name] as string) : typeof input[name])]);
        const deliver = (payload: Args): Args => {
          const hash = sha256(canonical(payload));
          if (input.after === cursor && seen.get(view) === hash) return { cursor, changed: false };
          if (!seen.has(view) && seen.size >= MAX_REGISTERED_STUDIES + 2) seen.clear();
          seen.set(view, hash);
          return { ...payload, changed: true };
        };
        if (explicitRead) {
          const choices = registry.studies.map(dir => ({dir})), selected = str(input.study);
          if (!selected || !registry.studies.includes(selected)) return deliver({cursor, studies: choices, study: null, ...emptyRead, error: selected ? "Requested study is not registered; use ares console add or choose a registered study" : "Choose a registered study"});
          if (input.panel === "harness") {
            try {if (realpathSync(selected) !== selected) throw new Error();}
            catch {return deliver({cursor, studies: choices, study: {dir: selected, available: false}, harness: null, error: "Registered study is missing or now resolves elsewhere; restore its canonical directory and refresh"});}
          }
          let summary: Args = {dir: selected};
          try { const {study} = openStudy(selected); summary = {...summary, id: study.id, question: study.question, mode: study.mode, available: true}; }
          catch { summary = {...summary, available: false, reason: "Study metadata unavailable; restore valid study.json and refresh"}; }
          try { return deliver({cursor, studies: choices, study: summary, ...executionPanel(selected, input)}); }
          catch (cause) { return deliver({cursor, studies: choices, study: summary, ...emptyRead, error: error(cause)}); }
        }
        const registered = new Set(registry.studies); for (const dir of lastAt.keys()) if (!registered.has(dir)) lastAt.delete(dir);
        if (input.panel === "inbox") targets.clear();
        const studies: Args[] = [], details = new Map<string, Args>(), items: Item[] = [];
        for (const dir of registry.studies) {
          try { const row = loadStudy(dir, ctx.features ?? [], { panel: input.panel, study: str(input.study), id: str(input.id) }); studies.push(row.summary); if (row.detail) details.set(dir, row.detail); items.push(...row.items); if (input.panel === "inbox") for (const [id, target] of row.targets) targets.set(id, target); lastAt.set(dir, row.at); }
          catch (cause) {
            const key = sha256(dir).slice(0, 16), reason = error(cause);
            let at = lastAt.get(dir) ?? EPOCH; try { at = stamp(readLedger(dir).at(-1)?.at, at); } catch { /* no readable ledger; keep stable fallback */ }
            lastAt.set(dir, at);
            const row = { id: key, dir, available: false, reason }; studies.push(row); details.set(dir, row);
            items.push({ id: `unavailable:${key}`, group: "alert", kind: "unavailable", title: "Study unavailable", detail: `${reason}${at === EPOCH ? "; ledger time unavailable" : ""}`, project: key, at, verbs: [], link: { panel: "study", params: { study: dir } } });
          }
        }
        if (input.panel === "inbox") return deliver({ cursor, items });
        if (input.panel === "study") {
          const selected = str(input.study) ?? registry.studies.find(dir => details.get(dir)?.id === str(input.id));
          return deliver({ cursor, studies, study: selected ? details.get(selected) ?? null : null, ...(!selected ? { error: "Choose a registered study" } : !details.has(selected) ? { error: "Requested study is not registered; use ares console add or choose a registered study" } : {}) });
        }
        return deliver({ cursor, studies });
      },
      async action(input, meta) {
        try {
          validateActionInput(input);
          const now = runtime.now ?? (() => performance.now()), deadline = now() + CONSOLE_ARCHIVE_MS;
          let request = input;
          if (input.study === undefined && typeof input.id === "string") {
            const stored = targets.get(input.id);
            if (!stored || !Array.isArray(stored.actions) || !stored.actions.includes(input.action)) refusal("inbox selection is stale or unavailable");
            request = { ...input, ...stored };
          }
          if (input.action === "skill.accept" && request.pr === undefined && plain(input.answers) && plain(input.answers.pr)) request = { ...request, pr: input.answers.pr.other };
          const target = selection(request, ctx.home);
          if (input.confirmed !== true) return { ok: false, needsConfirm: true, ...boundAction(target) };
          if (typeof input.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.fingerprint)) refusal("confirmation requires the current preview fingerprint");
          const runner: ProcessRunner = request => {
            const remaining = Math.floor(deadline - now());
            if (remaining <= 0) return Promise.resolve({ exitCode: -1, stdout: "", stderr: "", timedOut: true });
            return (runtime.runner ?? spawnRunner)({ ...request, timeoutMs: Math.min(request.timeoutMs ?? CONSOLE_ARCHIVE_MS, remaining) });
          };
          const actor = { kind: "person" as const, ...(meta ? { id: field(meta.identity, "authenticated identity", 500) } : {}) }, command = { actor, http, runner };
          const archive = { confirm: "" };
          const guard = () => {
            let current: ReturnType<typeof boundAction>;
            try { if (!readRegistry(ctx.home).studies.includes(target.study)) refusal("study is no longer registered"); current = boundAction(target); }
            catch { refusal("stale confirmation: the selected study or bound content changed"); }
            if (current.fingerprint !== input.fingerprint) refusal("stale confirmation: the bound content changed");
            archive.confirm = current.archiveFingerprint ?? "";
          };
          if (target.action === "gate") await ops.gateDecide(target.study, target.gate!, target.decision as "approve" | "reject", target.reason, command, guard);
          else if (target.action === "screen") await ops.screen(target.study, target.ids!, target.decision as "include" | "exclude", target.reason, command, guard);
          else if (target.action === "skill.decide") await ops.skillDecide(target.study, target.name!, target.decision!, target.reason!, target.pr, command, guard);
          else await ops.archive(target.study, archive, command, env, guard);
          seen.clear(); return { ok: true, message: `${target.wireAction} recorded; refresh the study to inspect its ledger` };
        } catch (cause) {
          const message = cause instanceof ArchivePartialError
            ? line(`archive: ${cause.exportedCount} note${cause.exportedCount === 1 ? "" : "s"} exported and receipted; open a new archive preview and confirm it to export the rest; ${cause.failureMessage}`)
            : error(cause);
          return { ok: false, error: message };
        }
      },
      async asset(input) {
        if (!input.id.startsWith("manuscript:")) return null;
        const id = input.id.slice("manuscript:".length), matches = readRegistry(ctx.home).studies.filter(dir => { try { return openStudy(dir).study.id === id; } catch { return false; } });
        if (matches.length !== 1) return null;
        try {
          const dir = realpathSync(matches[0]!), file = join(dir, "paper", "build", "manuscript.md");
          for (const part of [join(dir, "paper"), join(dir, "paper", "build"), file]) if (lstatSync(part).isSymbolicLink()) return null;
          const built = readCurrentBuild(dir), bytes = readBytesBounded(file, ASSET_BYTES, { noFollow: true });
          return sha256(bytes) === built.manuscriptSha256 ? { bytes, mime: "text/plain", name: "manuscript.md" } : null;
        } catch { return null; }
      },
    };
  },
}; }
export const plugin = createPlugin();
export default plugin;
