/** Console api1 contract subset; runtime imports stay within ares/Node/Bun. Real contract/conformance is test-only. */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../../package.json";
import * as ops from "../commands.ts";
import { readRegistry, MAX_REGISTERED_STUDIES } from "../console/registry.ts";
import { readClosedFinal } from "../exp/final.ts";
import { readCurrentBuild } from "../paper/build.ts";
import { loadCandidates } from "../lit/candidates.ts";
import { openStudy, readLedger, readBytesBounded, readTextBounded, sha256, type LedgerEvent } from "../study.ts";

type Args = Record<string, unknown>;
interface Context { home: string; log(line: string): void; features?: readonly string[] }
interface Verb { id: string; label: string; destructive?: boolean; reason?: "optional" | "required"; form?: { questions: { id: string; prompt: string; options: { id: string; label: string }[]; other?: { label?: string; maxLength?: number } }[] } }
interface Item { id: string; group: "decision" | "candidate" | "review" | "alert"; kind: string; title: string; detail?: string; project?: string; at: string; verbs: Verb[]; link: { panel: string; params: Record<string, string> } }
interface Provider {
  assets: { js: string; css: string };
  snapshot(input: { after: number; panel: string } & Args): Promise<Args>;
  action(input: { action: string; confirmed?: true; fingerprint?: string } & Args, meta?: { identity: string; node: string; via: "console" }): Promise<{ ok: false; error: string }>;
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
function gateTime(gate: string, events: LedgerEvent[], fallback: string): string {
  const types: Record<string, string[]> = { scope: ["scope.set"], screen: ["lit.screen"], design: ["protocol.set", "selection.set", "final.seeds.set"], final: ["investigate.closed", "ablate.closed", "final.seeds.set"], review: ["paper.built", "review.added", "review.resolved"] };
  const event = events.findLast(row => (types[gate] ?? ["plan.set", "node.observed"]).includes(row.type));
  return stamp(event?.at, fallback);
}
function attempts(dir: string, all: boolean) {
  const first = ops.attemptList(dir, { limit: 200 }), rows = [...first.attempts];
  for (let offset = rows.length; all && offset < first.total; offset = rows.length) {
    const page = ops.attemptList(dir, { limit: 200, offset }); if (!page.attempts.length) break; rows.push(...page.attempts);
  }
  return { total: first.total, byStatus: first.totals, rows };
}
function loadStudy(dir: string, features: readonly string[], input: { panel: string; study?: string; id?: string }) {
  const { study } = openStudy(dir), events = readLedger(dir), errors: Record<string, string> = {}, key = sha256(dir).slice(0, 16);
  const detailed = input.panel === "study" && (input.study === dir || !input.study && input.id === study.id), inbox = input.panel === "inbox";
  const at = stamp(events.at(-1)?.at, stamp(study.createdAt)), items: Item[] = [], link = { panel: "study", params: { study: dir } };
  const add = (kind: string, entity: string, group: Item["group"], title: string, time: string, detail = "", verbs: Verb[] = []) => items.push({ id: `${kind}:${key}:${sha256(entity).slice(0, 16)}`, group, kind, title: line(title, 180), detail: line(detail, 1000), project: study.id, at: stamp(time, at), verbs, link });
  const status = ops.status(dir), gates = ops.gateList(dir);
  const attempt = study.mode === "experiment" ? readCall("attempts", () => attempts(dir, inbox), errors) : null;
  const investigation = detailed && study.mode === "experiment" ? readCall("investigation", () => ops.investigateShow(dir), errors) : null;
  const final = study.mode === "experiment" ? readCall("final", () => readClosedFinal(dir).result, errors) : null;
  const posthoc = detailed && study.mode === "experiment" ? readCall("posthoc", () => ops.posthocShow(dir), errors) : null;
  const review = readCall("review", () => ops.reviewShow(dir), errors), skills = detailed || inbox ? readCall("skills", () => ops.skillList(dir), errors) : null;
  const watch = readCall("watch", () => ops.watchShow(dir), errors), lastWatch = watch?.runs[0] ?? null;
  if (inbox) {
  for (const gate of gates.filter(row => row.state === "pending")) add("gate", `${gate.gate}:${gate.current}`, "decision", `Approve or reject ${gate.gate}`, gateTime(gate.gate, events, stamp(events[0]?.at, stamp(study.createdAt))), study.question,
    [{ id: "gate.approve", label: "Approve", destructive: true }, { id: "gate.reject", label: "Reject", destructive: true, reason: "required" }]);
  const current = new Map(loadCandidates(dir).filter(row => row.status === "new").map(row => [row.id, row])), watched = new Map<string, LedgerEvent>();
  for (const event of events) if (event.type === "watch.ran" && Array.isArray(event.data.addedIds)) for (const id of event.data.addedIds) if (typeof id === "string" && current.has(id)) watched.set(id, event);
  for (const [id, event] of watched) add("candidate", id, "candidate", current.get(id)!.title, event.at, `${watch?.config?.rubric ?? ""}\n${id}`,
    [{ id: "screen.include", label: "Include", destructive: true, reason: "required" }, { id: "screen.exclude", label: "Exclude", destructive: true, reason: "required" }]);
  for (const [index, event] of events.entries()) if (event.type === "watch.ran" && Array.isArray(event.data.addedIds) && Number.isSafeInteger(event.data.addedIdsTotal)) {
    const overflow = Number(event.data.addedIdsTotal) - event.data.addedIds.length;
    if (overflow > 0) add("watch-overflow", String(index), "alert", `${overflow} watch candidate ids exceed the receipt list`, event.at,
      "Only recorded ids appear as candidate items. Unrecorded ids have no individual watch provenance; inspect ares watch show and the study's new candidates.");
  }
  for (const skill of skills ?? []) if (skill.state === "proposed") {
    const verbs: Verb[] = [{ id: "skill.reject", label: "Reject", destructive: true, reason: "required" }, { id: "skill.withdraw", label: "Withdraw", destructive: true, reason: "required" }];
    if (features.includes("inbox.form")) verbs.unshift({ id: "skill.accept", label: "Accept", destructive: true, reason: "required", form: { questions: [{ id: "pr", prompt: "Provide the reviewed PR URL", options: [{ id: "reviewed", label: "Reviewed PR is ready" }, { id: "pending", label: "Keep proposed" }], other: { label: "Reviewed PR URL", maxLength: 1000 } }] } });
    add("skill", skill.name, "review", skill.name, skill.at, skill.summary, verbs);
  }
  for (const finding of review?.openBlocking ?? []) {
    const row = review!.reviews.find(row => row.id === finding.reviewId);
    add("review", `${finding.reviewId}/${finding.findingId}`, "review", `${finding.kind}: ${finding.text}`, row?.at ?? at, finding.location);
  }
  for (const row of attempt?.rows ?? []) if (row.status === "failed" || row.status === "unknown") {
    const event = events.findLast(event => event.data.id === row.id && event.data.status === row.status);
    add("attempt", row.id, "alert", `${row.status} attempt ${row.id}`, event?.at ?? at, row.reason ?? "Inspect ares attempt show before retrying");
  }
  for (const event of events) if (event.type === "watch.ran" && event.data.ok === false) add("watch", event.at + events.indexOf(event), "alert", "Every watch source failed", event.at, "Inspect ares watch show and retry after restoring source access");
  }
  const manuscript = detailed && readCall("manuscript", () => readCurrentBuild(dir), errors) ? { id: `manuscript:${study.id}` } : null;
  const summary = { id: study.id, dir, available: true, question: status.question, mode: status.mode, autonomy: status.autonomy, gates,
    attempts: attempt ? { total: attempt.total, byStatus: attempt.byStatus } : { total: 0, byStatus: {} },
    final: final ? { status: final.status, ...(final.reason ? { reason: final.reason } : {}) } : null,
    review: review ? { ready: review.ready, unmet: review.unmet } : null, lastWatch };
  return { summary, detail: detailed ? { ...summary, investigation, final, posthoc, review, skills, watch, manuscript, errors } : null, items, at };
}
export const plugin = {
  manifest: { api: 1 as const, tool: "ares", version, title: "Research", icon: "agents", pollMs: 15000,
    panels: [{ id: "studies", title: "Studies", order: 1 }, { id: "study", title: "Study", order: 2 }],
    capabilities: { actions: ["gate", "screen", "skillDecide", "archiveConfirm"], confirm: true, inbox: true, multiProject: false, search: false } },
  async open(ctx: Context): Promise<Provider> {
    const assets = { js: readTextBounded(fileURLToPath(new URL("./panel.js", import.meta.url)), 262144), css: readTextBounded(fileURLToPath(new URL("./panel.css", import.meta.url)), 262144) };
    const seen = new Map<string, string>(), lastAt = new Map<string, string>();
    return {
      assets,
      async snapshot(input) {
        const registry = readRegistry(ctx.home);
        const probe = (file: string) => { try { const info = statSync(file); return [info.isFile(), info.size, info.mtimeMs, info.ctimeMs, info.mode, info.ino]; } catch { return null; } };
        const probes = registry.studies.map(dir => ({ ledger: probe(join(dir, "ledger.jsonl")), study: probe(join(dir, "study.json")) }));
        const cursor = probes.reduce((sum, row) => sum + (row.ledger?.[0] ? row.ledger[1] as number : 0), 0);
        const view = `${input.panel}:${str(input.study) ?? str(input.id) ?? ""}`, signature = sha256(JSON.stringify([registry.studies, probes]));
        if (input.after > 0 && input.after === cursor && seen.get(view) === signature) return { cursor, changed: false };
        if (!seen.has(view) && seen.size >= MAX_REGISTERED_STUDIES + 2) seen.clear();
        seen.set(view, signature);
        const registered = new Set(registry.studies); for (const dir of lastAt.keys()) if (!registered.has(dir)) lastAt.delete(dir);
        const studies: Args[] = [], details = new Map<string, Args>(), items: Item[] = [];
        for (const dir of registry.studies) {
          try { const row = loadStudy(dir, ctx.features ?? [], { panel: input.panel, study: str(input.study), id: str(input.id) }); studies.push(row.summary); if (row.detail) details.set(dir, row.detail); items.push(...row.items); lastAt.set(dir, row.at); }
          catch (cause) {
            const key = sha256(dir).slice(0, 16), reason = error(cause);
            let at = lastAt.get(dir) ?? EPOCH; try { at = stamp(readLedger(dir).at(-1)?.at, at); } catch { /* no readable ledger; keep stable fallback */ }
            const row = { id: key, dir, available: false, reason }; studies.push(row); details.set(dir, row);
            items.push({ id: `unavailable:${key}`, group: "alert", kind: "unavailable", title: "Study unavailable", detail: `${reason}${at === EPOCH ? "; ledger time unavailable" : ""}`, project: key, at, verbs: [], link: { panel: "study", params: { study: dir } } });
          }
        }
        if (input.panel === "inbox") return { cursor, changed: true, items };
        if (input.panel === "study") {
          const selected = str(input.study) ?? registry.studies.find(dir => details.get(dir)?.id === str(input.id));
          return { cursor, changed: true, studies, study: selected ? details.get(selected) ?? null : null, ...(!selected ? { error: "Choose a registered study" } : !details.has(selected) ? { error: "Requested study is not registered; use ares console add or choose a registered study" } : {}) };
        }
        return { cursor, changed: true, studies };
      },
      async action() { return { ok: false, error: "Console actions are not enabled in this version; use the CLI or MCP" }; },
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
};
export default plugin;
