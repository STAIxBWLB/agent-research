import { expect, test } from "bun:test";
import { FORMAT_VERSIONS, manifest } from "../src/manifest.ts";
import { manifestTools } from "../scripts/release-smoke.ts";

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
