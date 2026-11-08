import {expect, test} from "bun:test";
import {join} from "node:path";
import {recheckExperienceSources, EXPERIENCE_SOURCE_LIMIT, type ExperienceSourcePin, type ExperienceSourceObservation} from "../src/harness/experience-source.ts";
import {type ProcessRunner, type ProcessRequest} from "../src/exp/executor.ts";
import {canonical} from "../src/plan/state.ts";
import {sha256} from "../src/study.ts";
import {tempDir} from "./helpers.ts";

const at = Date.parse("2030-01-01T00:00:00Z"), A = "a".repeat(32), B = "b".repeat(32);
const view = (id = A) => ({id, kind: "finding", text: "Synthetic private screened procedural text", at: "2029-12-01T00:00:00Z", project: "synthetic-private-project", source: "cli"});
const pin = (id = A): ExperienceSourcePin => ({id, digest: sha256(canonical(view(id))), sourceVersion: "0.22.1"});
interface Plan {show?: unknown; denied?: boolean; version?: string; timeout?: boolean}
function transport(plans: Plan[]) {
  const requests: ProcessRequest[] = [], showIds: string[] = []; let closed = 0;
  const runner: ProcessRunner = async request => {
    const plan = plans[requests.length]; if (!plan) throw new Error("unscripted synthetic MCP child"); requests.push(request);
    if (plan.timeout) return {exitCode: 1, stdout: "", stderr: "private diagnostic body", timedOut: true};
    let buffer = "";
    for await (const chunk of request.stdin as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.method === "notifications/initialized") continue;
        let result: unknown;
        if (message.method === "initialize") result = {serverInfo: {name: "amem", version: plan.version ?? "0.22.1"}};
        else if (message.method === "tools/list") result = {tools: [{name: "amem_show", inputSchema: {type: "object", properties: {id: {type: "string", maxLength: 80}}, required: ["id"], additionalProperties: false}}]};
        else if (message.method === "tools/call") {
          showIds.push(message.params.arguments.id);
          result = {content: [{type: "text", text: JSON.stringify(Object.hasOwn(plan, "show") ? plan.show : view(message.params.arguments.id))}], ...(plan.denied ? {isError: true} : {})};
        } else throw new Error("unexpected synthetic request");
        const frame = Buffer.from(JSON.stringify({jsonrpc: "2.0", id: message.id, result}) + "\n"), split = Math.floor(frame.length / 2);
        await request.stdoutSink!(frame.subarray(0, split)); await request.stdoutSink!(frame.subarray(split));
      }
    }
    closed++; return {exitCode: 0, stdout: "", stderr: ""};
  };
  return {runner, requests, showIds, closed: () => closed};
}
function config(runner: ProcessRunner, home: string) {return {runner, env: {HOME: home, AMEM_HOME: join(home, "amem"), AGENTHUB_HOME: join(home, "family"), CODEX_THREAD_ID: "synthetic-existing-thread"}, now: () => at};}

test("unchanged screened digests and exact versions remain available without mutating pins", async () => {
  const home = tempDir(), fake = transport([{}, {}]), pins = Object.freeze([Object.freeze(pin(A)), Object.freeze(pin(B))]);
  const before = JSON.stringify(pins), result = await recheckExperienceSources(home, pins, config(fake.runner, home));
  expect(result.state).toBe("available"); expect(result.observations).toEqual(pins.map(value => ({id: value.id, state: "available", digest: value.digest, sourceVersion: value.sourceVersion, observedAt: new Date(at).toISOString()})));
  expect(fake.showIds).toEqual([A, B]); expect(fake.closed()).toBe(2); expect(JSON.stringify(pins)).toBe(before);
  for (const request of fake.requests) {expect(request.command).toBe("amem"); expect(request.args).toEqual(["mcp"]); expect(request.cwd).toBe(home);}
});

test("forget and privacy denial are non-enumerating and never stop later pinned rechecks", async () => {
  const home = tempDir(), missing = transport([{show: null}, {}]), denied = transport([{show: "opaque refusal", denied: true}, {}]);
  const a = await recheckExperienceSources(home, [pin(A), pin(B)], config(missing.runner, home));
  const b = await recheckExperienceSources(home, [pin(A), pin(B)], config(denied.runner, home));
  expect(a).toEqual(b); expect(a.state).toBe("unavailable"); expect(a.observations[0]).toMatchObject({id: A, state: "unavailable", digest: null});
  expect(a.observations[1]).toMatchObject({id: B, state: "available"}); expect(missing.showIds).toEqual([A, B]); expect(denied.showIds).toEqual([A, B]);
});

test("superseded, stale, changed content and server-version drift invalidate the frozen set", async () => {
  const home = tempDir();
  const cases: [Plan, ExperienceSourceObservation["state"]][] = [[{show: null}, "unavailable"], [{show: {...view(), stale: true}}, "changed"], [{show: {...view(), text: "Changed screened procedural text"}}, "changed"], [{version: "0.22.2"}, "changed"], [{version: "0.21.0"}, "unsupported"]];
  for (const [plan, state] of cases) {
    const fake = transport([plan]), result = await recheckExperienceSources(home, [pin()], config(fake.runner, home));
    expect(result.state).toBe("unavailable"); expect(result.observations[0]!.state).toBe(state); expect(fake.requests).toHaveLength(1);
  }
});

test("exact full ids are required on both sides and timeout does not prevent remaining rechecks", async () => {
  const home = tempDir(), wrong = transport([{show: {...view(), id: A.slice(0, 12)}}]);
  expect((await recheckExperienceSources(home, [pin()], config(wrong.runner, home))).observations[0]).toMatchObject({state: "unavailable", digest: null}); expect(wrong.showIds).toEqual([A]);
  const fake = transport([{timeout: true}, {}]), result = await recheckExperienceSources(home, [pin(A), pin(B)], config(fake.runner, home));
  expect(result.state).toBe("unavailable"); expect(result.observations.map(value => value.state)).toEqual(["unavailable", "available"]); expect(fake.requests).toHaveLength(2);
});

test("empty sets do no reads and malformed or over-bound pins refuse before any child", async () => {
  const home = tempDir(); let calls = 0;
  const runner: ProcessRunner = async () => {calls++; throw new Error("must not run");};
  expect(await recheckExperienceSources(home, [], config(runner, home))).toEqual({state: "available", observations: []});
  const invalid: unknown[] = [null, {}, Array(EXPERIENCE_SOURCE_LIMIT + 1).fill(pin()), [pin(), pin()], [{...pin(), id: A.slice(0, 16)}], [{...pin(), id: A.toUpperCase()}], [{...pin(), digest: "f".repeat(63)}], [{...pin(), digest: "F".repeat(64)}], [{...pin(), sourceVersion: "0.22.0"}], [{...pin(), sourceVersion: "0.22.1+" + "x".repeat(128)}], [{...pin(), sourceVersion: null}], [{...pin(), body: "must not persist"}], [pin(A), {...pin(B), digest: "invalid"}]];
  for (const entries of invalid) await expect(recheckExperienceSources(home, entries as ExperienceSourcePin[], config(runner, home))).rejects.toThrow("restore the original snapshot or freeze an explicitly reviewed new round");
  expect(calls).toBe(0);
});

test("serialized observations retain no screened bodies, project data, paths or kind payload", async () => {
  const home = tempDir(), fake = transport([{}]), result = await recheckExperienceSources(home, [pin()], config(fake.runner, home)), serialized = JSON.stringify(result);
  for (const value of [view().text, view().project, home, "kind", "title", "support", "temporal"]) expect(serialized).not.toContain(value);
  expect(Object.keys(result.observations[0]!).sort()).toEqual(["digest", "id", "observedAt", "sourceVersion", "state"]);
});
