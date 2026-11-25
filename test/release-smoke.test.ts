import { expect, test } from "bun:test";
import { FORMAT_VERSIONS, manifest } from "../src/manifest.ts";
import { exactRuntimeSpecs, manifestTools, smokeChild } from "../scripts/release-smoke.ts";

test("release smoke accepts every currently advertised format version", () => {
  // Exercise the release's actual check, so a source format bump is covered by ordinary offline CI.
  const installed = JSON.parse(JSON.stringify(manifest()));
  expect(installed.formats).toEqual(FORMAT_VERSIONS);
  expect([...manifestTools(installed, installed.version)]).toEqual(installed.mcp.tools.map((tool: { name: string; readOnly: boolean }) => [tool.name, tool.readOnly]));
  installed.formats = Object.fromEntries(Object.entries(FORMAT_VERSIONS).reverse());
  expect(() => manifestTools(installed, installed.version)).not.toThrow();
});

test("release smoke refuses missing, extra, mistyped or mismatched formats with recovery guidance", () => {
  const current = manifest(), { study: _study, ...missing } = FORMAT_VERSIONS;
  for (const formats of [
    missing, { ...FORMAT_VERSIONS, futureFormat: 1 }, { ...FORMAT_VERSIONS, study: FORMAT_VERSIONS.study + 1 },
    { ...FORMAT_VERSIONS, study: String(FORMAT_VERSIONS.study) }, { ...FORMAT_VERSIONS, manifest: 2 }, null,
  ]) expect(() => manifestTools({ ...current, formats }, current.version)).toThrow("clean install smoke: installed manifest formats mismatch; inspect the staged package and rebuild it");
});

test("release smoke permits only bounded exact registry dependency pins", () => {
  expect(exactRuntimeSpecs({})).toEqual([]);
  expect(exactRuntimeSpecs({ dependencies: { "@staix/cli-output": "0.1.3", "synthetic": "2.0.0" } }))
    .toEqual(["@staix/cli-output@0.1.3", "synthetic@2.0.0"]);
  for (const version of ["^0.1.3", "latest", "1.2", "01.2.3", "1.2.3-rc.1", "https://example.invalid/private", 1]) {
    expect(() => exactRuntimeSpecs({ dependencies: { "@staix/cli-output": version } }))
      .toThrow("runtime dependency @staix/cli-output requires an exact x.y.z pin");
  }
  expect(() => exactRuntimeSpecs({ dependencies: { "--registry": "1.2.3" } })).toThrow("invalid runtime dependency name");
  const excess = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`synthetic-${index}`, "1.2.3"]));
  expect(() => exactRuntimeSpecs({ dependencies: excess })).toThrow("at most 16 entries");
});

test("release smoke child failures report the step without printing process output", async () => {
  for (const step of ["dependency fetch (@staix/cli-output@0.1.3)", "install", "--version", "manifest", "mcp"]) {
    try {
      await smokeChild(step, process.execPath, ["-e", 'console.error("https://example.invalid/private body"); process.exit(1)'], process.cwd(), {}, 5_000);
      throw new Error("expected a child failure");
    } catch (error) {
      expect(String(error)).toContain(`clean install smoke: ${step}: child exited nonzero`);
      expect(String(error)).not.toMatch(/https:|private body/);
    }
  }
});
