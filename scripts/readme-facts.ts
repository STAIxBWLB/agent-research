import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../src/manifest.ts";
// Usage: bun scripts/readme-facts.ts [--write]. Renders README facts blocks from package.json and the manifest code path; no network.
const root = resolve(fileURLToPath(new URL("..", import.meta.url))), file = join(root, "README.md");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; engines: { bun: string }; bin: Record<string, string> };
const floor = /^>=(\d+\.\d+\.\d+)$/.exec(pkg.engines.bun)?.[1];
if (!floor) throw new Error(`readme-facts: engines.bun ${pkg.engines.bun} is not >=X.Y.Z; update the install renderer`);
const bin = Object.keys(pkg.bin)[0]!, m = manifest(), fence = "```";
const FACTS: Record<string, string> = {
  install: `Requires Bun ${floor} or newer. Install from npm:\n\n${fence}sh\nbun add -g ${pkg.name}\n${bin} --help\n${fence}`,
  commands: `${fence}text\n${m.commands.map(c => `${bin} ${c.usage}`).join("\n")}\n${fence}`,
  "mcp-tools": `The MCP server publishes ${m.mcp.tools.length} tools: ${m.mcp.tools.map(t => `\`${t.name}\``).join(", ")}.`,
};
function render(text: string): { text: string; diffs: string[] } {
  const diffs: string[] = [];
  for (const [name, body] of Object.entries(FACTS)) {
    const open = `<!-- facts:${name} -->`, close = `<!-- /facts:${name} -->`, start = text.indexOf(open), end = text.indexOf(close);
    if (start < 0 || end < start || text.indexOf(open, start + 1) >= 0) { diffs.push(`${name}: expected exactly one ${open} ... ${close} block`); continue; }
    const current = text.slice(start + open.length, end), wanted = `\n${body}\n`;
    if (current === wanted) continue;
    const have = current.split("\n"), want = wanted.split("\n"), index = want.findIndex((value, i) => value !== have[i]), line = index < 0 ? want.length : index;
    diffs.push(`${name}: differs at block line ${line}: have ${JSON.stringify(have[line] ?? "")}, want ${JSON.stringify(want[line] ?? "")}`);
    text = text.slice(0, start + open.length) + wanted + text.slice(end);
  }
  return { text, diffs };
}
if (import.meta.main) {
  const write = process.argv.includes("--write"), { text, diffs } = render(readFileSync(file, "utf8"));
  if (diffs.some(d => d.includes("expected exactly one"))) { console.error(diffs.map(d => `readme-facts: ${d}`).join("\n")); process.exit(1); }
  if (write) { if (diffs.length) writeFileSync(file, text); console.log(`readme-facts: ${diffs.length ? `rewrote ${diffs.length} block(s)` : "ok"}`); }
  else if (diffs.length) { console.error(`${diffs.map(d => `readme-facts: ${d}`).join("\n")}\nreadme-facts: README.md is stale; run bun scripts/readme-facts.ts --write and commit the result`); process.exit(1); }
  else console.log("readme-facts: ok");
}
