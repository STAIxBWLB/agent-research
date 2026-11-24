import { asciiMarkers, errorLine, errorSpans, paint, Report, resolveColor, streamEnv, streamWidth } from "@staix/cli-output";

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
