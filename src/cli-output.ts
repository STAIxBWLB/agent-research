import { cellWidth, wrap, asciiMarkers, errorLine, errorSpans, paint, Report, resolveColor, streamEnv, streamWidth } from "@staix/cli-output";

import { COMMANDS, GLOBAL_HELP_FLAGS, flagDescription, helpFlagLabel, helpUsage, type CommandSpec } from "./commands-table.ts";

export interface OutputOptions {
  color?: string;
  ascii?: boolean;
  json?: boolean;
}

export function colorFor(options: OutputOptions, isTTY: boolean, env = process.env): boolean | Error {
  const color = resolveColor(options.color, streamEnv(isTTY, env), "ares");
  return options.json && !(color instanceof Error) ? false : color;
}

function label(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/\s+/g, " ").replace(/^./, character => character.toUpperCase());
}

function rows(report: Report, value: unknown, indent = 2): void {
  if (Array.isArray(value)) {
    if (!value.length) report.note("None");
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        rows(report, item, indent + 2);
      } else {
        report.note(String(item), "value");
      }
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    report.kv([["Result", value]], indent);
    return;
  }
  const fields = Object.entries(value).filter(([, field]) => field !== undefined);
  report.kv(fields.filter(([, field]) => field === null || typeof field !== "object").map(([key, field]) => [label(key), field]), indent);
  for (const [key, field] of fields) {
    if (field === null || typeof field !== "object") continue;
    if (indent === 2) report.section(label(key), Array.isArray(field) ? String(field.length) : undefined);
    else report.kv([[label(key), ""]], indent);
    rows(report, field, indent + (indent === 2 ? 0 : 2));
  }
}

export function renderResult(command: string, result: unknown, code: number, color: boolean, ascii: boolean, columns?: number): string {
  const report = new Report(columns, ascii).header("ares", label(command));
  if (code === 75) report.section("Attention").bullet("warn", "Temporarily deferred");
  else if (code !== 0) report.section("Attention").bullet("fail", "Command reported a failure");
  rows(report, result);
  return report.render(color).join("\n");
}

export function renderError(message: string, tty: boolean, color: boolean, ascii: boolean, columns?: number): string {
  const advice = /; ((?:use|pass|run|rerun|retry|choose|restore|explain|select)\b[\s\S]*)$/.exec(message)
    ?? /; ([^;]*\b(?:run|rerun|retry) ares [\s\S]*)$/.exec(message)
    ?? / \((run ares [^()]*)\)$/.exec(message);
  const text = advice ? message.slice(0, advice.index) : message;
  const separator = text.indexOf(": ");
  const what = separator < 0 ? text : text.slice(0, separator);
  const why = separator < 0 ? "" : text.slice(separator + 2);
  const next = advice?.[1]?.replace(/^(?:run|rerun|retry) (?=(?:cd |ares ))/, "");
  const options = { tty, ascii, ...(next === undefined ? {} : { next }) };
  const lines = color
    ? errorSpans("ares", what, why, options, columns).map(line => paint(line, true))
    : errorLine("ares", what, why, options, columns);
  return lines.join("\n");
}

export { streamWidth };

export function outputAscii(options: OutputOptions, env: NodeJS.ProcessEnv): boolean {
  return asciiMarkers(env, options.ascii);
}

const HELP_GROUPS = [
  ["Study", "init", "status", "study", "scope", "playbook"],
  ["Literature", "lit", "watch"],
  ["Gates", "gate", "autonomy"],
  ["Plan", "plan", "run"],
  ["Experiments", "protocol", "executor", "attempt", "idea", "investigate", "ablate", "posthoc", "final", "selection", "retention", "lineage"],
  ["Harness and experience", "harness", "experience"],
  ["Memory", "archive", "lesson", "lessons", "skill"],
  ["Paper and review", "paper", "review", "cite"],
  ["Integration", "setup", "console", "manifest", "mcp"],
] as const;

export function renderHelp(spec: CommandSpec | undefined, color: boolean, ascii: boolean): string {
  const report = new Report(80, ascii);
  if (!spec) {
    report.header("ares", "Help").section("Usage")
      .line("  ares <command> [options]")
      .line("  ares help <command> | ares <command> --help")
      .line("  ares --version");
    for (const [title, ...prefixes] of HELP_GROUPS) {
      const commands = COMMANDS.filter(command => prefixes.some(prefix => command.name.split(" ")[0] === prefix))
        .toSorted((left, right) => left.name.localeCompare(right.name, "en"));
      report.section(title).kv(commands.map(command => [command.name, command.summary]), 2, { colon: false });
    }
    report.section("Global flags").kv(Object.entries(GLOBAL_HELP_FLAGS), 2, { colon: false });
  } else {
    const usage = helpUsage(spec);
    report.header("ares", spec.name).section("Usage").line(`  ares ${usage}`)
      .section("Description").note(spec.summary, "value");
    if (usage.includes("<gate>")) {
      report.note("Gate names: scope, screen, design, final, review, plan:node-id,", "value")
        .note("accept:artifact or harness:round-id", "value");
    }
    const flags = Object.keys(spec.options).filter(flag => flag !== "--json")
      .map(flag => [helpFlagLabel(spec, flag), flagDescription(spec, flag)] as const);
    if (spec.options["--json"]) flags.push(["--json", GLOBAL_HELP_FLAGS["--json"]]);
    flags.push(["--color=auto|always|never", GLOBAL_HELP_FLAGS["--color"]], ["--ascii", GLOBAL_HELP_FLAGS["--ascii"]], ["--help", GLOBAL_HELP_FLAGS["--help"]]);
    report.section("Flags", String(flags.length)).kv(flags, 2, { colon: false });
    if (spec.example) report.section("Examples").next(`ares ${spec.name} ${spec.example}`);
  }
  return report.render(color).join("\n");
}

export function usageHint(spec: CommandSpec | undefined, columns = 80): string {
  const usage = spec ? helpUsage(spec) : "<command> [options]";
  const help = spec ? `ares help ${spec.name}` : "ares --help";
  return [...wrap(`Usage: ares ${usage}`, Math.min(columns, 80)), `Run '${help}' for details.`].join("\n");
}

export { cellWidth };
