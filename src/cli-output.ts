import { cellWidth, wrap, asciiMarkers, errorLine, errorSpans, paint, Report, resolveColor, streamEnv, streamWidth, terminalText, MARKERS, markerCell, type MarkerName } from "@staix/cli-output";

import { COMMANDS, GLOBAL_HELP_FLAGS, flagDescription, helpFlagLabel, helpUsage, type CommandSpec } from "./commands-table.ts";

import { shellQuote } from "./exp/executor.ts";

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

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
const commandLine = (args: string[]) => ["ares", ...args.map(shellQuote)].join(" ");
const statusMarker = (value: string): MarkerName =>
  ["approved", "succeeded", "done", "qualified", "verified", "included", "ok"].includes(value) ? "ok"
    : ["failed", "rejected", "lost", "not_qualified"].includes(value) ? "fail"
      : ["unknown", "skipped"].includes(value) ? "unknown"
        : ["pending", "running", "new", "paused"].includes(value) ? "pending" : "absent";

function stateCell(report: Report, state: string) {
  const marker = statusMarker(state);
  return { text: `${markerCell(marker, report.ascii)} ${state}`, role: MARKERS[marker].role };
}

export interface OutputContext {
  args: string[];
  values: Readonly<Record<string, string>>;
  now: number;
  previewCount?: number;
}

export function fillMessage(message: string, values: Readonly<Record<string, string>>): string {
  const quoted = (key: string, original: string) => Object.hasOwn(values, key) ? shellQuote(values[key]!) : original;
  return message.replace(/<([a-z][a-z0-9-]*)>/g, (match, key: string) => quoted(key, match))
    .replace(/(--[a-z][a-z-]*) (PATH|DIR|ID|RUN|ALIAS|SHA|TEXT|N)(?![A-Za-z0-9_])(?:\|-)?/g, (match, flag: string, metavar: string) =>
      Object.hasOwn(values, flag) ? `${flag} ${shellQuote(values[flag]!)}` : Object.hasOwn(values, metavar) ? `${flag} ${shellQuote(values[metavar]!)}` : match);
}

function relativeTime(value: unknown, now: number): string {
  if (typeof value !== "string") return "";
  const seconds = Math.floor((now - Date.parse(value)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  const absolute = Math.abs(seconds);
  for (const [unit, duration] of [["d", 86_400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    if (absolute >= duration) return seconds >= 0 ? `${Math.floor(absolute / duration)}${unit} ago` : `in ${Math.floor(absolute / duration)}${unit}`;
  }
  return "now";
}

function gates(report: Report, values: unknown[], context: OutputContext, includeAttention = true): void {
  const entries = values.map(record);
  const needsAction = entries.filter(row => row.state === "pending" || row.state === "rejected");
  if (includeAttention && needsAction.length) report.section("Attention");
  for (const gate of includeAttention ? needsAction : []) {
    report.bullet("warn", `${text(gate.gate)} gate is ${text(gate.state)}`);
    if (context.values.dir) report.next(commandLine(["gate", "approve", context.values.dir, text(gate.gate)]));
  }
  report.section("Gates", String(entries.length));
  report.table(["Gate", "State", "Actor", "When"], entries.map(gate => {
    const decision = record(gate.decided), actor = record(decision.actor);
    return [text(gate.gate), stateCell(report, text(gate.state)), text(actor.id ?? actor.kind), relativeTime(decision.at, context.now)];
  }), 2, { dropEmptyColumns: false });
}

const HIDDEN = /(?:sha256|hash|binding|^events$|manifestbytes|^rendered$|^abstract$)/i;
function readable(value: unknown, now: number): unknown {
  if (Array.isArray(value)) return value.map(item => readable(item, now));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).flatMap(([key, field]) => {
      if (HIDDEN.test(key) || (typeof field === "string" && field.startsWith("/") && /path|dir|root|study/i.test(key))) return [];
      const when = /^(?:at|createdAt|startedAt|endedAt|updatedAt|decidedAt)$/.test(key) ? relativeTime(field, now) : "";
      return [[key, when || readable(field, now)]];
    }));
  }
  return value;
}

interface Finding { state: "failed" | "warning" | "skipped" | "ok"; message: string }
function checks(command: string, value: Row): Finding[] {
  if (Array.isArray(value.checks)) return value.checks.map(entry => {
    const row = record(entry);
    return { state: row.state === "failed" || row.state === "skipped" || row.state === "warning" ? row.state : "ok",
      message: [row.name, row.detail].map(text).filter(Boolean).join(": ") };
  });
  if (command === "paper check") return array(value.findings).map(entry => {
    const row = record(entry);
    return { state: row.severity === "blocking" ? "failed" : "warning", message: `${text(row.line)}:${text(row.column)} ${text(row.code)}: ${text(row.message)}` };
  });
  if (command === "cite check") return [
    ...array(value.unknown).map(key => ({ state: "failed" as const, message: `Unknown citation ${text(key)}` })),
    ...array(value.notVerified).map(key => ({ state: "failed" as const, message: `Unverified citation ${text(key)}` })),
  ];
  if (command === "watch run") return array(value.queries).map(entry => {
    const row = record(entry);
    const failed = array(row.errors).length;
    const passed = array(row.sources).some(source => record(source).ok === true);
    return { state: failed ? passed ? "warning" : "failed" : "ok", message: [row.id, failed ? `${failed} source errors` : "", row.added === undefined ? "" : `${text(row.added)} added`].map(text).filter(Boolean).join(": ") };
  });
  if (Array.isArray(value.findings)) return value.findings.map(entry => {
    const row = record(entry);
    return { state: row.severity === "blocking" || row.level === "error" ? "failed" : "warning",
      message: text(row.message ?? row.reason ?? row.code ?? entry) };
  });
  const state = text(value.state ?? value.status ?? record(value.readiness).state);
  const available = ["ok", "ready", "passed", "pass", "accepted", "available", "verified", "screened"];
  const findings: Finding[] = [{ state: value.ok === false ? "failed" : state && !available.includes(state) ? "warning" : "ok",
    message: [state || "Check completed", value.reason ?? value.nextStep].map(text).filter(Boolean).join(": ") }];
  for (const observation of [...array(value.inspections), ...array(value.observations)]) {
    const row = record(observation), status = text(row.state);
    findings.push({ state: available.includes(status) ? "ok" : "warning",
      message: [row.id ?? record(row.ref).id, status, row.reason ?? row.nextStep].map(text).filter(Boolean).join(": ") });
  }
  return findings;
}

function checkReport(report: Report, command: string, value: Row, context: OutputContext) {
  const findings = checks(command, value);
  const counts = { failed: 0, warnings: 0, unknown: 0, ok: 0 };
  for (const [state, name, marker, count] of [
    ["failed", "Failures", "fail", "failed"], ["warning", "Warnings", "warn", "warnings"],
    ["skipped", "Skipped", "unknown", "unknown"], ["ok", "Passed", "ok", "ok"],
  ] as const) {
    const group = findings.filter(row => row.state === state);
    counts[count] = group.length;
    if (group.length) report.section(name, String(group.length));
    for (const row of group) report.bullet(marker, fillMessage(row.message, context.values) || name);
  }
  if (!findings.length) {
    counts[value.ok === false ? "failed" : "ok"] = 1;
    report.section(value.ok === false ? "Failures" : "Passed").bullet(value.ok === false ? "fail" : "ok", value.ok === false ? "Check failed" : "No findings");
  }
  report.summary(counts);
}

const CHECKS = new Set(["paper check", "cite check", "executor check", "renderer check", "lesson check", "skill check", "experience check", "watch run"]);
const VIEW_NAMES = new Set(["lessons", "lit flow", "lit queries", "retention inspect", "review checklist", "manifest", "lineage compare", "executor inputs hash"]);
const PREVIEWS = new Set(["archive", "retention prune", "lit card export", "harness close", "harness adopt"]);
const COMPLETED: Readonly<Record<string, string>> = {
  init: "Created the study", scope: "Saved the study scope", protocol: "Saved the experiment protocol",
  selection: "Saved the selection rule", "selection calibrate": "Recorded the calibration recommendation",
  "autonomy set": "Saved the autonomy policy", "executor set": "Saved the executor",
  "gate approve": "Approved the gate", "gate reject": "Rejected the gate",
  "lit search": "Recorded the literature search", "lit screen": "Recorded the screening decision",
  "lit verify": "Checked the selected identifiers", "lit card": "Saved the extraction card", "lit bib": "Built the verified bibliography",
  "plan set": "Saved the study plan", "watch set": "Saved the watch configuration", "paper build": "Built the checked manuscript", "renderer set": "Saved the renderer for this machine", "paper render record": "Recorded the render",
  "paper plan set": "Saved the paper plan", "review add": "Recorded the review", "review resolve": "Resolved the review finding",
  "attempt run": "Recorded the attempt", "attempt cancel": "Cancelled the attempt", "attempt reconcile": "Reconciled the attempts",
  "console add": "Registered the study", "console remove": "Removed the study registration",
  archive: "Published the selected notes", "retention prune": "Pruned the retained references", "lit card export": "Exported the selected cards",
};

const NEXT: Readonly<Record<string, string[]>> = {
  init: ["status"], scope: ["gate", "list"], protocol: ["executor", "check"], "protocol set": ["executor", "check"],
  "executor set": ["executor", "check"], "lit search": ["lit", "list"], "lit screen": ["lit", "list"], "lit verify": ["lit", "list"],
  "plan set": ["plan", "show"], "watch set": ["watch", "show"], "paper plan set": ["paper", "plan", "show"],
  "paper build": ["review", "show"], "renderer set": ["renderer", "check"], "paper render record": ["paper", "render", "show"], "review add": ["review", "show"], selection: ["investigate", "show"],
  "investigate close": ["investigate", "show"], "attempt reconcile": ["attempt", "list"], "gate approve": ["gate", "list"],
};

function renderView(report: Report, command: string, result: unknown, context: OutputContext) {
  const value = record(result);
  if (command === "status") {
    const literature = record(value.literature), active = array(value.gates).map(record).filter(row => ["pending", "rejected"].includes(text(row.state)));
    if (active.length || Number(literature.unverified) > 0) report.section("Attention");
    for (const gate of active) {
      report.bullet("warn", `${text(gate.gate)} gate is ${text(gate.state)}`);
      if (context.values.dir) report.next(commandLine(["gate", "approve", context.values.dir, text(gate.gate)]));
    }
    if (Number(literature.unverified) > 0) {
      report.bullet("warn", `${text(literature.unverified)} included references need verification`);
      if (context.values.dir) report.next(commandLine(["lit", "verify", context.values.dir]));
    }
    report.section("Study").kv([["Question", value.question], ["Mode", value.mode], ["Scope", record(value.scope).set ? "Set" : "Unset"]]);
    gates(report, array(value.gates), context, false);
    report.section("Literature").kv(Object.entries(literature).map(([key, field]) => [label(key), field]));
    return;
  }
  if (command === "gate list") { gates(report, array(result), context); return; }
  if (command === "lit list") {
    const candidates = array(value.candidates).map(record);
    const unverified = candidates.filter(row => row.status === "included" && row.verified !== true);
    if (unverified.length) {
      report.section("Attention").bullet("warn", `${unverified.length} listed references need verification`);
      if (context.values.dir) report.next(commandLine(["lit", "verify", context.values.dir]));
    }
    report.section("Candidates", `${candidates.length} of ${text(value.total)}`).table(
      ["ID", "Year", "Status", "Verified", "Title"],
      candidates.map(candidate => [text(candidate.id), text(candidate.year), stateCell(report, text(candidate.status)), candidate.verified === true ? "yes" : "no", text(candidate.title)]),
      4, { columnCaps: [22, 4, 12, 8, null], dropEmptyColumns: false, clip: true },
    );
    if (!candidates.length) report.note("No candidates");
    return;
  }
  if (command === "attempt list" || command === "attempt show") {
    const attempts = command === "attempt list" ? array(value.attempts).map(record) : [value];
    const problems = attempts.filter(row => ["unknown", "failed"].includes(text(row.status)));
    if (problems.length) {
      report.section("Attention");
      for (const row of problems) report.bullet(statusMarker(text(row.status)), `${text(row.id)} ${text(row.status)} ${text(row.reason)}`.trimEnd());
      if (context.values.dir) report.next(commandLine(["attempt", "reconcile", context.values.dir]));
    }
    if (command === "attempt list") {
      report.section("Attempts", String(attempts.length)).table(["ID", "Run", "Seed", "State", "Started"], attempts.map(row =>
        [text(row.id), text(row.run), text(row.seed), stateCell(report, text(row.status)), relativeTime(row.startedAt, context.now)]), 1);
    } else {
      report.section("Attempt").kv([["ID", value.id], ["Run", value.run], ["Seed", value.seed], ["State", value.status], ["Started", relativeTime(value.startedAt, context.now)]]);
      const metrics = array(value.metrics).map(record);
      if (metrics.length) report.section("Metrics").kv(metrics.map(metric => [text(metric.name), `${text(metric.value)} ${text(metric.unit)}`.trimEnd()]));
    }
    return;
  }
  if (command === "plan show" && Array.isArray(value.nodes)) {
    const nodes = array(value.nodes).map(record);
    const actionable = nodes.filter(node => ["failed", "unknown"].includes(text(node.status)));
    if (actionable.length) {
      report.section("Attention");
      for (const node of actionable) report.bullet(statusMarker(text(node.status)), [node.id, node.reason ?? node.status].map(text).join(": "));
      if (context.values.dir) report.next(commandLine(["run", context.values.dir]));
    }
    report.section("Plan").kv([["State", value.state], ["Revision", value.revision]]);
    report.section("Nodes", String(nodes.length)).table(["ID", "Kind", "State", "Details"], nodes.map(node =>
      [text(node.id), text(node.kind), stateCell(report, text(node.status)), text(node.reason)]), 3);
    return;
  }
  if (command === "review show") {
    const unmet = array(value.unmet), findings = array(value.openBlocking).map(record);
    if (unmet.length || findings.length) report.section("Attention");
    for (const item of unmet) report.bullet("warn", fillMessage(text(record(item).message), context.values));
    for (const row of findings) {
      report.bullet("fail", [row.location, row.text].map(text).filter(Boolean).join(": "));
      report.note(`Resolve ${text(row.reviewId)}/${text(row.findingId)} with the reason for the repair`);
    }
    report.section("Reviews").kv([["Ready", value.ready], ["Reviews", array(value.reviews).length], ["Model families", array(value.families).join(", ")]]);
    return;
  }
  if (command === "executor inputs hash") {
    report.section("Input manifest").kv([["SHA-256", value.sha256], ["Files", value.files], ["Bytes", value.bytes]]);
    return;
  }
  const calibration = record(value.calibration);
  if (calibration.belowNoise === true) report.section("Attention").bullet("warn", "The sealed minimum delta is below the calibration recommendation");
  rows(report, readable(result, context.now));
}

export function renderResult(command: string, result: unknown, code: number, color: boolean, ascii: boolean, columns?: number,
  context: OutputContext = { args: [], values: {}, now: Date.now() },
): string {
  const report = new Report(columns, ascii).header("ares", label(command)), value = record(result);
  if (command === "attempt logs") {
    for (const entry of array(value.logs)) {
      const log = record(entry);
      const stage = text(log.candidateStage ? `candidate:${text(log.candidateStage)}` : log.stage);
      report.section(`${stage} ${text(log.stream)}${log.truncated ? ", truncated copy" : ""}`);
      const body = terminalText(log.text).trimEnd();
      if (body) report.line(body);
    }
  } else if (command === "setup" && Array.isArray(value.actions)) {
    const actions = array(value.actions).map(record);
    if (code) report.section("Attention").bullet("fail", "One or more integration changes were refused");
    report.section(value.applied === true ? "Changes" : "Preview").table(["Target", "Change", "Reason"], actions.map(action =>
      [text(action.target), text(action.change), text(action.reason)]), 2);
    for (const note of array(value.notes)) report.note(text(note));
  } else if (command === "study export" && value.wouldWrite === true) {
    report.section("Preview").kv([["Bundle", value.bundle]]);
    for (const name of array(value.files)) report.note(text(name), "value");
    if (context.args.length) report.next(commandLine(context.args.filter(argument => argument !== "--list")));
  } else if (CHECKS.has(command)) {
    checkReport(report, command, value, context);
  } else if (VIEW_NAMES.has(command) || command === "status" || / (?:list|show)$/.test(command)) {
    renderView(report, command, result, context);
  } else if (PREVIEWS.has(command) && typeof value.fingerprint === "string" && !Object.hasOwn(context.values, "--confirm")) {
    report.section("Preview");
    for (const item of array(value.preview)) report.note(text(item), "value");
    if (command === "archive") {
      const notes = array(value.notes).map(record);
      report.note(`Publish ${notes.length} notes`, "value");
      for (const note of notes) report.note(text(record(note.note).title), "value");
    }
    if (command === "lit card export") {
      const cards = array(value.cards).map(record);
      report.note(`Export ${cards.length} cards`, "value");
      for (const card of cards) report.note(text(card.id), "value");
    }
    if (command === "retention prune") report.note(`Remove ${context.previewCount ?? "the"} retained references from ${context.values["--file"] ?? "the supplied input"}`, "value");
    if (value.recovery) report.note(text(value.recovery));
    if (context.args.length) report.next(commandLine([...context.args, "--confirm", value.fingerprint]));
  } else if (code !== 0) {
    report.section("Attention").bullet(code === 75 ? "warn" : "fail", text(value.reason ?? value.state ?? value.status) || (code === 75 ? "Temporarily deferred" : "Command reported a failure"));
    rows(report, readable(result, context.now));
  } else {
    const identifier = text(value.id ?? value.name ?? value.gate ?? record(value.study).id ?? record(value.record).id ?? record(value.attempt).id ?? record(value.winner).commit);
    const state = text(value.state ?? value.status);
    const description = COMPLETED[command] ?? `${label(command)} completed`;
    const receipt = [value.changed === false ? "Already current" : description, identifier, state].filter(Boolean).join(" · ");
    report.bullet("ok", receipt);
    if (command === "selection calibrate") report.section("Recommendation").kv([
      ["Method", value.method], ["Minimum delta", value.recommendedMinDelta], ["Receipt SHA-256", value.sha256],
    ]);
    if (context.values.dir && NEXT[command]) report.next(commandLine([...NEXT[command], context.values.dir]));
    const warnings = array(value.warnings);
    if (warnings.length) {
      report.section("Attention");
      for (const warning of warnings.map(record)) report.bullet("warn", [warning.cause ?? warning.code, warning.nextStep].map(text).filter(Boolean).join(": "));
    }
  }
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
  ["Paper and review", "paper", "renderer", "review", "cite"],
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
