/**
 * N-1 resolution and manifest comparison, pure so they are unit-tested offline.
 *
 * Choice (#85 round 3): N-1 is the latest published stable patch of the minor line directly below the checkout's
 * major.minor core (-pre/+build stripped), whether or not the checkout version is published. Publishing 0.2.0 or a 0.2.1
 * patch keeps N-1 on 0.1.x; the release bump to 0.3.0 moves it to 0.2.x. Prereleases in the registry list never count.
 * With no stable version below the checkout's minor line (the initial publication line), there is nothing to check:
 * resolveN1 returns undefined and the job skips.
 */
type Triple = [number, number, number];
function parse(version: string): Triple | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
const below = (a: Triple, b: Triple) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

export function resolveN1(current: string, published: readonly string[]): string | undefined {
  // Prerelease or build tags on the checkout only (0.2.0-rc.1) mark the same target minor; published lists stay stable-only.
  const core = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(current)?.[1], here = core ? parse(core) : undefined;
  if (!here) throw new Error(`n1: package version ${current} is not x.y.z[-pre][+build]; fix package.json version and rerun bun scripts/n1-check.ts`);
  const target = here;
  const stable = published.map(v => [v, parse(v)] as const).filter((e): e is readonly [string, Triple] => e[1] !== undefined && below(e[1], target));
  if (!stable.length) return undefined;
  stable.sort(([, a], [, b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  // The minor line directly below: the highest major.minor present, then its latest patch.
  const [, top] = stable.at(-1)!, line = stable.filter(([, v]) => v[0] === top[0] && v[1] === top[1]);
  return line.at(-1)![0];
}

export interface ManifestLike { commands: { name: string; usage: string }[]; mcp: { tools: { name: string; readOnly: boolean }[] } }

/** Every N-1 command (name and usage) and MCP tool (name and readOnly) must remain. Returns the breaks found. */
export function compareManifests(old: ManifestLike, next: ManifestLike): string[] {
  const breaks: string[] = [];
  const commands = new Map(next.commands.map(c => [c.name, c.usage]));
  for (const c of old.commands) {
    if (!commands.has(c.name)) breaks.push(`CLI: command "${c.name}" removed`);
    else if (!usageKept(c.usage, commands.get(c.name)!)) breaks.push(`CLI: command "${c.name}" usage changed from "${c.usage}" to "${commands.get(c.name)}"`);
  }
  const tools = new Map(next.mcp.tools.map(t => [t.name, t.readOnly]));
  for (const t of old.mcp.tools) {
    if (!tools.has(t.name)) breaks.push(`MCP: tool "${t.name}" removed`);
    else if (tools.get(t.name) !== t.readOnly) breaks.push(`MCP: tool "${t.name}" readOnly changed from ${t.readOnly} to ${tools.get(t.name)}`);
  }
  return breaks;
}

/**
 * A usage is kept when every N-1 word still appears in order and every added word is optional syntax, meaning it sits
 * inside a `[...]` group (bracket depth is tracked across words). Widened enums (`auto|gates` to `auto|gates|copilot|step`)
 * are compatible; a removed or renamed word, or a new required positional or option, is not.
 */
function usageKept(old: string, next: string): boolean {
  const oldWords = old.split(/\s+/).filter(Boolean);
  let at = 0, depth = 0;
  for (const word of next.split(/\s+/).filter(Boolean)) {
    const optional = depth > 0 || word.startsWith("[");
    depth += (word.match(/\[/g)?.length ?? 0) - (word.match(/\]/g)?.length ?? 0);
    const wanted = oldWords[at];
    if (wanted !== undefined && (word === wanted || widened(wanted, word))) { at++; continue; }
    if (!optional) return false;
  }
  return at === oldWords.length;
}
function widened(old: string, next: string): boolean {
  const split = (s: string) => /^([[<(]*)(.*?)([\]>)]*)$/.exec(s)!;
  const [, oldOpen, oldBody, oldClose] = split(old), [, nextOpen, nextBody, nextClose] = split(next);
  if (!oldBody!.includes("|") || oldOpen !== nextOpen || oldClose !== nextClose) return false;
  const values = new Set(nextBody!.split("|"));
  return oldBody!.split("|").every(v => values.has(v));
}

/** Study format check from the two manifests: N-1 must refuse a study version it does not support, or read it unchanged. */
export type StudyFormatCheck = { expect: "refuse"; version: number } | { expect: "read"; version: number };
export function studyFormatCheck(old: { formats?: { study?: unknown } }, next: { formats?: { study?: unknown } }): StudyFormatCheck {
  const checkout = next.formats?.study, supported = old.formats?.study;
  if (!Number.isSafeInteger(checkout) || (checkout as number) < 1) throw new Error("n1: checkout manifest has no valid formats.study; fix src/manifest.ts and rerun bun scripts/n1-check.ts");
  if (!Number.isSafeInteger(supported) || (supported as number) < 1) throw new Error("n1: N-1 manifest has no valid formats.study; the installed N-1 package failed, check the install and rerun bun scripts/n1-check.ts");
  return (supported as number) < (checkout as number) ? { expect: "refuse", version: checkout as number } : { expect: "read", version: checkout as number };
}
