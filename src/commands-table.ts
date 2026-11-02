/** The single source of the CLI surface: help text is rendered from it and the parser reads its options. */
export interface CommandSpec { name: string; usage: string; mutates: boolean | "network"; options: Record<string, "flag" | "value"> }
const json = { "--json": "flag" } as const;
export const COMMANDS: readonly CommandSpec[] = [
  { name: "init", usage: "init <dir> --question TEXT [--mode survey|experiment] [--autonomy auto|gates] [--json]", mutates: true, options: { "--question": "value", "--mode": "value", "--autonomy": "value", ...json } },
  { name: "status", usage: "status <dir> [--json]", mutates: false, options: json },
  { name: "scope", usage: "scope <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "protocol", usage: "protocol <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "executor set", usage: "executor set <dir> --kind local|ssh [--host ALIAS] --workdir PATH [--json]", mutates: true, options: { "--kind": "value", "--host": "value", "--workdir": "value", ...json } },
  { name: "executor check", usage: "executor check <dir> [--json]", mutates: "network", options: json },
  { name: "gate list", usage: "gate list <dir> [--json]", mutates: false, options: json },
  { name: "gate approve", usage: "gate approve <dir> <scope|screen|design> [--reason TEXT] [--json]", mutates: true, options: { "--reason": "value", ...json } },
  { name: "gate reject", usage: "gate reject <dir> <scope|screen|design> --reason TEXT [--json]", mutates: true, options: { "--reason": "value", ...json } },
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
  { name: "cite check", usage: "cite check <dir> <draft> [--json]", mutates: false, options: json },
  { name: "playbook", usage: "playbook", mutates: false, options: {} },
  { name: "mcp", usage: "mcp", mutates: false, options: {} },
];
export function findCommand(args: string[]): { spec: CommandSpec; rest: string[] } | undefined {
  for (const words of [2, 1]) {
    const name = args.slice(0, words).join(" "), spec = COMMANDS.find(c => c.name === name);
    if (spec) return { spec, rest: args.slice(words) };
  }
  return undefined;
}
export function help(): string {
  return "ares - research engine: study ledger, literature search, verified references\n\n" + COMMANDS.map(c => `  ares ${c.usage}`).join("\n") + "\n\n  ares --help | --version\n";
}
