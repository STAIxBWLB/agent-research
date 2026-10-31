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

export const ARES_TOOLS: readonly McpTool[] = [
  { name: "ares_status", description: "Study summary: gates, candidate counts, verification counts, bibliography.", inputSchema: obj({ study }, ["study"]), annotations: read },
  { name: "ares_scope_set", description: "Set scope.json (question, subquestions, include, exclude, yearFrom, yearTo, maxCandidates). A change returns the scope gate to pending.", inputSchema: obj({ study, scope: SCOPE }, ["study", "scope"]), annotations: write },
  { name: "ares_gate", description: "List gates, or approve or reject the scope or screen gate. The ledger records the actor; who may approve is workspace policy.", inputSchema: obj({ study, action: { type: "string", enum: ["list", "approve", "reject"] }, gate: { type: "string", enum: ["scope", "screen"] }, reason }, ["study", "action"]), annotations: write },
  { name: "ares_lit_search", description: "Search OpenAlex, Semantic Scholar and arXiv and merge candidates. Needs the scope gate. Per-source failures are reported.", inputSchema: obj({ study, query: { type: "string", minLength: 1, maxLength: 500 }, source: { type: "string", enum: ["openalex", "s2", "arxiv", "all"] }, limit: { type: "integer", minimum: 1, maximum: 50 }, yearFrom: { type: "integer", minimum: 1000, maximum: 2100 } }, ["study", "query"]), annotations: net },
  { name: "ares_lit_list", description: "List candidates with abstracts (first 600 characters), status and verification.", inputSchema: obj({ study, status: { type: "string", enum: ["new", "included", "excluded"] }, limit: { type: "integer", minimum: 1, maximum: 500 } }, ["study"]), annotations: read },
  { name: "ares_lit_screen", description: "Include or exclude candidates. Changing the included set returns the screen gate to pending.", inputSchema: obj({ study, ids: { ...ids, minItems: 1 }, decision: { type: "string", enum: ["include", "exclude"] }, reason }, ["study", "ids", "decision"]), annotations: write },
  { name: "ares_lit_card", description: "Record an extraction card for an included candidate: summary, claims, methods, findings, limitations, relevance.", inputSchema: obj({ study, id, card: CARD }, ["study", "id", "card"]), annotations: write },
  { name: "ares_lit_verify", description: "Check DOI or arXiv identifiers at Crossref, DataCite or arXiv and compare title and year. Never judges whether a paper supports a claim.", inputSchema: obj({ study, ids }, ["study"]), annotations: net },
  { name: "ares_lit_bib", description: "Write refs/references.bib from included and verified candidates. Needs the screen gate. Citekeys never change once assigned.", inputSchema: obj({ study }, ["study"]), annotations: write },
  { name: "ares_cite_check", description: "Check [@key] citations in a draft against verified references; lists unknown and unverified keys.", inputSchema: obj({ study, draft: { type: "string", minLength: 1, maxLength: 4096 } }, ["study", "draft"]), annotations: read },
  { name: "ares_playbook", description: "The standalone literature workflow and its rules.", inputSchema: obj({}, []), annotations: read },
];

function absolute(value: unknown, what: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${what}: absolute path required`);
  return value;
}

/** MCP calls always come from an agent; the actor id is the detected agent or `mcp`. */
export function createAresMcp(env: NodeJS.ProcessEnv, http: Http = createHttp(env)): { tools: readonly McpTool[]; handlers: Record<string, McpHandler> } {
  const detected = detectActor(env), actor: Actor = { kind: "agent", id: detected.kind === "agent" ? detected.id! : "mcp" };
  const ctx = { actor, http };
  const dir = (a: Record<string, unknown>) => absolute(a.study, "study");
  const handlers: Record<string, McpHandler> = {
    ares_status: a => ops.status(dir(a)),
    ares_scope_set: a => ops.scope(dir(a), a.scope, ctx),
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
