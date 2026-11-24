import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Report, errorLine, errorSpans, lineSpans, markerCell, paint, resolveColor, terminalText, wrap, wrapSpans, type ColorEnv, type MarkerName, type ReportOptions, type Role, type Span } from "@staix/cli-output";
import { readTextBounded } from "../src/study.ts";

const fixtures = join(dirname(Bun.resolveSync("@staix/cli-output", import.meta.dir)), "..", "fixtures", "v1");
function fixture<T>(file: string): T {
  return JSON.parse(readTextBounded(join(fixtures, file), 65_536)) as T;
}

type ColorCase = { id: string; flag?: string; env: ColorEnv } & ({ expected: boolean } | { expectedError: string });
for (const { id, flag, env, ...expectation } of fixture<ColorCase[]>("color.json")) {
  test(`cli-output v1 color ${id}`, () => {
    const result = resolveColor(flag, env, "tool");
    if ("expectedError" in expectation) expect(result).toEqual(new Error(expectation.expectedError));
    else expect(result).toBe(expectation.expected);
  });
}

type MarkerCase = { id: string; name: MarkerName; utf8: string; ascii: string };
for (const { id, name, utf8, ascii } of fixture<MarkerCase[]>("markers.json")) {
  test(`cli-output v1 marker ${id}`, () => {
    expect(markerCell(name, false)).toBe(utf8);
    expect(markerCell(name, true)).toBe(ascii);
  });
}

type ErrorCase = {
  id: string; tool: string; what: string; why: string; options: Parameters<typeof errorLine>[3];
  columns?: number; expected: string[]; spans: Span[][]; colored: string[];
};
for (const { id, tool, what, why, options, columns, expected, spans, colored } of fixture<ErrorCase[]>("error-line.json")) {
  test(`cli-output v1 error ${id}`, () => {
    expect(errorLine(tool, what, why, options, columns)).toEqual(expected);
    const result = errorSpans(tool, what, why, options, columns);
    expect(result).toEqual(spans);
    expect(result.map(line => paint(line, true))).toEqual(colored);
  });
}

type TextCase = { id: string; input: string; options?: Parameters<typeof terminalText>[1]; expected: string };
for (const { id, input, options, expected } of fixture<TextCase[]>("text.json")) {
  test(`cli-output v1 text ${id}`, () => expect(terminalText(input, options)).toBe(expected));
}

type WrapCase = { id: string; input: string; columns?: number; hang?: number; expected: string[] };
for (const { id, input, columns, hang, expected } of fixture<WrapCase[]>("wrap.json")) {
  test(`cli-output v1 wrap ${id}`, () => expect(wrap(input, columns, hang)).toEqual(expected));
}

type SpanWrapCase = {
  id: string; input: Span[]; columns?: number; hang?: number; expected: Span[][]; colored: string[];
  styles?: Parameters<typeof paint>[2];
};
for (const { id, input, columns, hang, expected, colored, styles } of fixture<SpanWrapCase[]>("span-wrap.json")) {
  test(`cli-output v1 span wrap ${id}`, () => {
    const lines = wrapSpans(input, columns, hang);
    expect(lines).toEqual(expected);
    expect(lines.map(line => paint(line, true, styles))).toEqual(colored);
  });
}

type Operation =
  | { op: "note"; text: string; role?: Role }
  | { op: "line"; text: string; lines?: string[] }
  | { op: "append"; lines: Span[][] }
  | { op: "header"; tool: string; name: string; context?: string }
  | { op: "section"; name: string; count?: string }
  | { op: "kv"; rows: Parameters<Report["kv"]>[0]; indent?: number; options?: Parameters<Report["kv"]>[2] }
  | { op: "bullet"; marker: MarkerName; text: string; nested?: boolean }
  | { op: "next"; command: string }
  | { op: "table"; head: string[]; rows: Parameters<Report["table"]>[1]; flexible?: number; options?: Parameters<Report["table"]>[3] }
  | { op: "summary"; counts: Parameters<Report["summary"]>[0] };
type ReportCase = {
  id: string;
  input: {
    columns: number | null; ascii: boolean; operations: Operation[];
    sanitizer?: "quote-headers" | "drop-cr"; styles?: ReportOptions["styles"]; reportOptions?: ReportOptions;
  };
  plain: string[];
  colored: string[];
};

for (const file of readdirSync(join(fixtures, "report")).filter(name => name.endsWith(".json"))) {
  const { id, input, plain, colored } = fixture<ReportCase>(join("report", file));
  test(`cli-output v1 report ${id}`, () => {
    const columns = input.columns ?? undefined;
    const options: ReportOptions = { ...input.reportOptions };
    if (input.styles) options.styles = input.styles;
    if (input.sanitizer === "quote-headers") options.sanitize = text => text.replace(/^(?=\s*(\[agent-hub\b|--- from ))/gim, "> ");
    if (input.sanitizer === "drop-cr") options.sanitize = text => text.replace(/\r/g, "");
    const report = new Report(columns, input.ascii, options);
    for (const operation of input.operations) {
      switch (operation.op) {
        case "note": report.note(operation.text, operation.role); break;
        case "line":
          report.line(operation.text);
          if (operation.lines) expect(lineSpans(operation.text, columns).map(line => paint(line, false))).toEqual(operation.lines);
          break;
        case "append": report.append(operation.lines); break;
        case "header": report.header(operation.tool, operation.name, operation.context); break;
        case "section": report.section(operation.name, operation.count); break;
        case "kv": report.kv(operation.rows, operation.indent, operation.options); break;
        case "bullet": report.bullet(operation.marker, operation.text, operation.nested); break;
        case "next": report.next(operation.command); break;
        case "table": report.table(operation.head, operation.rows, operation.flexible, operation.options); break;
        case "summary": report.summary(operation.counts); break;
        default: throw new Error("unknown cli-output fixture operation");
      }
    }
    expect(report.render(false)).toEqual(plain);
    expect(report.render(true)).toEqual(colored);
  });
}
