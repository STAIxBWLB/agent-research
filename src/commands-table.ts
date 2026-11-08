/** The single source of the CLI surface: help text is rendered from it and the parser reads its options. */
export interface CommandSpec { name: string; usage: string; mutates: boolean | "network"; options: Record<string, "flag" | "value"> }
const json = { "--json": "flag" } as const;
export const COMMANDS: readonly CommandSpec[] = [
  { name: "harness set", usage: "harness set <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "harness show", usage: "harness show <dir> [--round ID] [--json]", mutates: false, options: { "--round": "value", ...json } },
  { name: "harness import", usage: "harness import <dir> <round> --file FIXTURE_PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "lineage show", usage: "lineage show <dir> [--root KIND --id ID --revision REV --sha256 HASH] [--cursor CURSOR] [--json]", mutates: false, options: { "--root": "value", "--id": "value", "--revision": "value", "--sha256": "value", "--cursor": "value", ...json } },
  { name: "lineage compare", usage: "lineage compare <dir> (--attempts ID,... | --candidates COMMIT,...) [--json]", mutates: false, options: { "--attempts": "value", "--candidates": "value", ...json } },
  { name: "autonomy show", usage: "autonomy show <dir> [--json]", mutates: false, options: json },
  { name: "autonomy set", usage: "autonomy set <dir> <auto|gates|copilot|step> [--phase PHASE] [--json]", mutates: true, options: { "--phase": "value", ...json } },
  { name: "skill propose", usage: "skill propose <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "skill decide", usage: "skill decide <dir> <name> <accept|reject|withdraw> --reason TEXT [--pr URL] [--json]", mutates: true, options: { "--reason": "value", "--pr": "value", ...json } },
  { name: "skill list", usage: "skill list <dir> [--json]", mutates: false, options: json },
  { name: "lessons", usage: "lessons <dir> [--for TEXT] [--half-life DAYS] [--limit N] [--json]", mutates: false, options: { "--for": "value", "--half-life": "value", "--limit": "value", ...json } },
  { name: "archive", usage: "archive <dir> [--confirm FINGERPRINT] [--json]", mutates: "network", options: { "--confirm": "value", ...json } },
  { name: "setup", usage: "setup <claude|codex|kimi|pi|qwen|jcode|agy|all|console> [--apply|--undo] [--root ABS] [--json]", mutates: true, options: { "--apply": "flag", "--undo": "flag", "--root": "value", ...json } },
  { name: "watch set", usage: "watch set <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "watch run", usage: "watch run <dir> [--json]", mutates: "network", options: json },
  { name: "watch show", usage: "watch show <dir> [--json]", mutates: false, options: json },
  { name: "console add", usage: "console add <dir> [--json]", mutates: true, options: json },
  { name: "console remove", usage: "console remove <dir> [--json]", mutates: true, options: json },
  { name: "console list", usage: "console list [--json]", mutates: false, options: json },
  { name: "manifest", usage: "manifest [--json]", mutates: false, options: json },
  { name: "init", usage: "init <dir> --question TEXT [--mode survey|experiment] [--autonomy auto|gates|copilot|step] [--json]", mutates: true, options: { "--question": "value", "--mode": "value", "--autonomy": "value", ...json } },
  { name: "run", usage: "run <dir> [--parallel 1..8] [--json]", mutates: "network", options: { "--parallel": "value", ...json } },
  { name: "plan set", usage: "plan set <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "plan control", usage: "plan control <dir> <pause|resume|retry|cancel|skip> [node] --command-id ID --expected-revision N [--json]", mutates: "network", options: { "--command-id": "value", "--expected-revision": "value", ...json } },
  { name: "plan show", usage: "plan show <dir> [--json]", mutates: false, options: json },
  { name: "status", usage: "status <dir> [--json]", mutates: false, options: json },
  { name: "study export", usage: "study export <dir> --bundle DIR [--list] [--json]", mutates: true, options: { "--bundle": "value", "--list": "flag", ...json } },
  { name: "scope", usage: "scope <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "idea add", usage: "idea add <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "idea decide", usage: "idea decide <dir> <id> <refine|pivot> --reason TEXT [--attempts ID[,ID...]] [--commit SHA] [--cause TEXT] [--retry-when TEXT] [--json]", mutates: true, options: { "--cause": "value", "--retry-when": "value", "--reason": "value", "--attempts": "value", "--commit": "value", ...json } },
  { name: "investigate show", usage: "investigate show <dir> [--json]", mutates: false, options: json },
  { name: "investigate close", usage: "investigate close <dir> [--json]", mutates: true, options: json },
  { name: "ablate add", usage: "ablate add <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "ablate show", usage: "ablate show <dir> [--json]", mutates: false, options: json },
  { name: "ablate close", usage: "ablate close <dir> [--json]", mutates: true, options: json },
  { name: "posthoc show", usage: "posthoc show <dir> [--json]", mutates: false, options: json },
  { name: "final close", usage: "final close <dir> [--json]", mutates: true, options: json },
  { name: "final seeds", usage: "final seeds <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "selection", usage: "selection <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "protocol", usage: "protocol <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "executor set", usage: "executor set <dir> --kind local|ssh [--host ALIAS] --workdir PATH [--gpu-devices IDS --gpu-min-free-memory-mb MB --gpu-max-load-ratio RATIO] [--json]", mutates: true, options: { "--kind": "value", "--host": "value", "--workdir": "value", "--gpu-devices": "value", "--gpu-min-free-memory-mb": "value", "--gpu-max-load-ratio": "value", ...json } },
  { name: "executor inputs hash", usage: "executor inputs hash <dir> <path> [--json]", mutates: "network", options: json },
  { name: "executor check", usage: "executor check <dir> [--json]", mutates: "network", options: json },
  { name: "gate list", usage: "gate list <dir> [--json]", mutates: false, options: json },
  { name: "gate approve", usage: "gate approve <dir> <scope|screen|design|final|review|plan:node-id|accept:artifact|harness:round-id> [--reason TEXT] [--json]", mutates: true, options: { "--reason": "value", ...json } },
  { name: "gate reject", usage: "gate reject <dir> <scope|screen|design|final|review|plan:node-id|accept:artifact|harness:round-id> --reason TEXT [--json]", mutates: true, options: { "--reason": "value", ...json } },
  { name: "attempt run", usage: "attempt run <dir> --repo PATH --commit SHA [--seed N] [--run NAME] [--label TEXT] [--retry ID] [--detach] [--json]", mutates: "network", options: { "--repo": "value", "--commit": "value", "--seed": "value", "--run": "value", "--label": "value", "--retry": "value", "--detach": "flag", ...json } },
  { name: "attempt list", usage: "attempt list <dir> [--run NAME] [--status running|succeeded|failed|cancelled|unknown] [--limit N] [--offset N] [--json]", mutates: false, options: { "--run": "value", "--status": "value", "--limit": "value", "--offset": "value", ...json } },
  { name: "attempt show", usage: "attempt show <dir> <id> [--json]", mutates: false, options: json },
  { name: "attempt cancel", usage: "attempt cancel <dir> <id> [--reason TEXT] [--json]", mutates: "network", options: { "--reason": "value", ...json } },
  { name: "attempt reconcile", usage: "attempt reconcile <dir> [--json]", mutates: "network", options: json },
  { name: "attempt logs", usage: "attempt logs <dir> <id> [--stage candidate|evaluator] [--stream stdout|stderr] [--tail BYTES] [--json]", mutates: false, options: { "--stage": "value", "--stream": "value", "--tail": "value", ...json } },
  { name: "lit search", usage: "lit search <dir> <query> [--source openalex|s2|arxiv|all] [--limit 1..50] [--year-from YYYY] [--json]", mutates: "network", options: { "--source": "value", "--limit": "value", "--year-from": "value", ...json } },
  { name: "lit list", usage: "lit list <dir> [--status new|included|excluded] [--limit 1..500] [--json]", mutates: false, options: { "--status": "value", "--limit": "value", ...json } },
  { name: "lit screen", usage: "lit screen <dir> <id>... --include|--exclude [--reason TEXT] [--json]", mutates: true, options: { "--include": "flag", "--exclude": "flag", "--reason": "value", ...json } },
  { name: "lit card", usage: "lit card <dir> <id> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "lit verify", usage: "lit verify <dir> [<id>...] [--json]", mutates: "network", options: json },
  { name: "lit bib", usage: "lit bib <dir> [--json]", mutates: true, options: json },
  { name: "review add", usage: "review add <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "review resolve", usage: "review resolve <dir> <review-id>/<finding-id> --reason TEXT [--json]", mutates: true, options: { "--reason": "value", ...json } },
  { name: "review show", usage: "review show <dir> [--json]", mutates: false, options: json },
  { name: "paper build", usage: "paper build <dir> [--json]", mutates: true, options: json },
  { name: "paper check", usage: "paper check <dir> [--json]", mutates: false, options: json },
  { name: "cite check", usage: "cite check <dir> <draft> [--json]", mutates: false, options: json },
  { name: "playbook", usage: "playbook", mutates: false, options: {} },
  { name: "mcp", usage: "mcp", mutates: false, options: {} },
];
export function findCommand(args: string[]): { spec: CommandSpec; rest: string[] } | undefined {
  const longest = Math.max(...COMMANDS.map(command => command.name.split(" ").length));
  for (let words = longest; words >= 1; words--) {
    const name = args.slice(0, words).join(" "), spec = COMMANDS.find(c => c.name === name);
    if (spec) return { spec, rest: args.slice(words) };
  }
  return undefined;
}
export function help(): string {
  return "ares - research engine: study ledger, literature search, verified references\n\n" + COMMANDS.map(c => `  ares ${c.usage}`).join("\n") + "\n\n  ares --help | --version\n";
}
