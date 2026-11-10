import { afterEach, expect, test } from "bun:test";
import { attemptRun, attemptShow } from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { fakeHttp } from "./helpers.ts";
import { cleanupPipelineFixtures, setup } from "./pipeline-fixture.ts";

afterEach(cleanupPipelineFixtures);

const warning = [{ code: "outside-investigation", cause: "not an investigation run", nextStep: "declare the selection run, or drop --reuse" }];

for (const scenario of [
  { name: "no selection and default run", selection: false, run: undefined, reuse: "eligible" as const, warns: true },
  { name: "a different selection run", selection: true, run: "probe-other", reuse: "eligible" as const, warns: true },
  { name: "the matching selection run", selection: true, run: "investigate", reuse: "eligible" as const, warns: false },
  { name: "reuse off outside investigation", selection: true, run: "probe-other", reuse: "off" as const, warns: false },
]) test(`reuse request warning: ${scenario.name} has CLI/MCP/shared parity without changing the attempt`, async () => {
  const f = await setup({ reuse: scenario.selection }), http = fakeHttp([]).http;
  const options = { repo: f.repo, commit: f.commit, reuse: scenario.reuse, detach: true, ...(scenario.run === undefined ? {} : { run: scenario.run }) };
  const flags = ["attempt", "run", f.dir, "--repo", f.repo, "--commit", f.commit, "--reuse", scenario.reuse, "--detach", "--json", ...(scenario.run === undefined ? [] : ["--run", scenario.run])];
  const cli = await run(flags, {}, { ...f.fake.ctx, http });
  expect(cli.code).toBe(0);
  const first = JSON.parse(cli.text);
  expect(first.status).toBe("running");
  expect(f.fake.executed).toEqual(["prepare"]);
  expect(first.warnings).toEqual(scenario.warns ? warning : undefined);
  const server = createAresMcp({}, http, f.fake.ctx);
  const mcp = await server.handlers.ares_attempt_run!({ study: f.dir, ...options });
  const shared = await attemptRun(f.dir, options, { ...f.fake.ctx, http });
  expect(mcp).toEqual(first);
  expect(shared).toEqual(first);
  const stored = attemptShow(f.dir, first.id);
  expect(Object.hasOwn(stored, "warnings")).toBe(false);
  if (scenario.selection && scenario.warns) expect(stored.reuse?.stages.prepare?.reason).toBe("outside-investigation");
});
