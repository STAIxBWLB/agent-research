/** The single source of the CLI surface: help text is rendered from it and the parser reads its options. */
export interface CommandSpec { name: string; usage: string; mutates: boolean | "network"; options: Record<string, "flag" | "value">; summary: string; example?: string }
const json = { "--json": "flag" } as const;
export const COMMANDS: readonly CommandSpec[] = [
  { name: "retention inspect", summary: "Inspect storage use and retention records", example: "study", usage: "retention inspect <dir> [--offset N] [--limit N] [--json]", mutates: "network", options: { "--offset": "value", "--limit": "value", ...json } },
  { name: "retention prune", summary: "Preview or confirm removal of retained evidence", example: "study --file refs.json", usage: "retention prune <dir> --file PATH|- [--confirm FINGERPRINT] [--json]", mutates: "network", options: { "--file": "value", "--confirm": "value", ...json } },
  { name: "skill check", summary: "Check a skill against its supporting evidence", example: "study review-skill", usage: "skill check <dir> <name> [--json]", mutates: "network", options: json },
  { name: "harness close", summary: "Preview or confirm closing a harness round", example: "study round-one --file close.json", usage: "harness close <dir> <round> --file PATH|- [--confirm FINGERPRINT] [--json]", mutates: true, options: { "--file": "value", "--confirm": "value", ...json } },
  { name: "harness contrast", summary: "Record a controlled harness contrast", example: "study round-one --file contrast.json", usage: "harness contrast <dir> <round> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "harness compose", summary: "Record a composed harness candidate", example: "study round-one --file composition.json", usage: "harness compose <dir> <round> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "harness adopt", summary: "Preview or confirm adopting a harness candidate", example: "study round-one --file adoption.json", usage: "harness adopt <dir> <round> --file PATH|- [--confirm FINGERPRINT] [--json]", mutates: true, options: { "--file": "value", "--confirm": "value", ...json } },
  { name: "harness stream set", summary: "Set the harness experience stream", example: "study --file stream.json", usage: "harness stream set <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "harness stream show", summary: "Show the harness experience stream", example: "study", usage: "harness stream show <dir> [--json]", mutates: false, options: json },
  { name: "experience select", summary: "Select experiences for a harness round", example: "study --file selection.json", usage: "experience select <dir> --file PATH|- [--json]", mutates: "network", options: { "--file": "value", ...json } },
  { name: "experience freeze", summary: "Freeze the experience context for a round", example: "study --file freeze.json", usage: "experience freeze <dir> --file PATH|- [--json]", mutates: "network", options: { "--file": "value", ...json } },
  { name: "experience check", summary: "Check experience context for a model and runtime", example: "study round-one --model sample --runtime 1.0", usage: "experience check <dir> <round> --model MODEL --runtime VERSION [--toolset-sha256 HASH] [--json]", mutates: "network", options: { "--model": "value", "--runtime": "value", "--toolset-sha256": "value", ...json } },
  { name: "harness set", summary: "Define a harness round", example: "study --file round.json", usage: "harness set <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "harness show", summary: "Show harness rounds and evidence", example: "study", usage: "harness show <dir> [--round ID] [--json]", mutates: false, options: { "--round": "value", ...json } },
  { name: "harness import", summary: "Import fixture evidence for a harness round", example: "study round-one --file fixture.json", usage: "harness import <dir> <round> --file FIXTURE_PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "lineage show", summary: "Show the provenance of study evidence", example: "study", usage: "lineage show <dir> [--root KIND --id ID --revision REV --sha256 HASH] [--cursor CURSOR] [--json]", mutates: false, options: { "--root": "value", "--id": "value", "--revision": "value", "--sha256": "value", "--cursor": "value", ...json } },
  { name: "lineage compare", summary: "Compare the provenance of selected attempts", example: "study --attempts attempt-a,attempt-b", usage: "lineage compare <dir> (--attempts ID,... | --candidates COMMIT,...) [--json]", mutates: false, options: { "--attempts": "value", "--candidates": "value", ...json } },
  { name: "autonomy show", summary: "Show the study autonomy policy", example: "study", usage: "autonomy show <dir> [--json]", mutates: false, options: json },
  { name: "autonomy set", summary: "Set autonomy for a study or phase", example: "study gates", usage: "autonomy set <dir> <auto|gates|copilot|step> [--phase PHASE] [--json]", mutates: true, options: { "--phase": "value", ...json } },
  {name: "lesson propose", summary: "Propose a lesson from study evidence", example: "study --file lesson.json", usage: "lesson propose <dir> --file PATH|- [--json]", mutates: "network", options: {"--file": "value", ...json}},
  {name: "lesson list", summary: "List proposed and decided lessons", example: "study", usage: "lesson list <dir> [--json]", mutates: false, options: {...json}},
  {name: "lesson check", summary: "Check a lesson proposal against current evidence", example: "study lesson-one", usage: "lesson check <dir> <name> [--json]", mutates: "network", options: {...json}},
  {name: "lesson decide", summary: "Record a decision on a lesson proposal", example: "study lesson-one --file decision.json", usage: "lesson decide <dir> <name> --file PATH|- [--json]", mutates: "network", options: {"--file": "value", ...json}},
  { name: "skill propose", summary: "Propose a skill from study evidence", example: "study --file skill.json", usage: "skill propose <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "skill decide", summary: "Accept, reject or withdraw a skill proposal", example: "study review-skill reject --reason superseded", usage: "skill decide <dir> <name> <accept|reject|withdraw> --reason TEXT [--pr URL] [--json]", mutates: true, options: { "--reason": "value", "--pr": "value", ...json } },
  { name: "skill list", summary: "List proposed and decided skills", example: "study", usage: "skill list <dir> [--json]", mutates: false, options: json },
  { name: "lessons", summary: "Rank lessons relevant to the study", example: "study", usage: "lessons <dir> [--for TEXT] [--half-life DAYS] [--limit N] [--json]", mutates: false, options: { "--for": "value", "--half-life": "value", "--limit": "value", ...json } },
  { name: "archive", summary: "Preview or confirm publishing lessons", example: "study", usage: "archive <dir> [--confirm FINGERPRINT] [--json]", mutates: "network", options: { "--confirm": "value", ...json } },
  { name: "setup", summary: "Preview or change agent integration registration", example: "codex", usage: "setup <claude|codex|kimi|pi|qwen|jcode|agy|all|console> [--apply|--undo] [--root ABS] [--json]", mutates: true, options: { "--apply": "flag", "--undo": "flag", "--root": "value", ...json } },
  { name: "watch set", summary: "Set the literature watch configuration", example: "study --file watch.json", usage: "watch set <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "watch run", summary: "Run one literature watch pass", example: "study", usage: "watch run <dir> [--json]", mutates: "network", options: json },
  { name: "watch show", summary: "Show the watch configuration and last pass", example: "study", usage: "watch show <dir> [--json]", mutates: false, options: json },
  { name: "console add", summary: "Register a study with the console", example: "study", usage: "console add <dir> [--json]", mutates: true, options: json },
  { name: "console remove", summary: "Remove a study from the console registry", example: "study", usage: "console remove <dir> [--json]", mutates: true, options: json },
  { name: "console list", summary: "List studies registered with the console", usage: "console list [--json]", mutates: false, options: json },
  { name: "manifest", summary: "Show the CLI and MCP interfaces", usage: "manifest [--json]", mutates: false, options: json },
  { name: "init", summary: "Create a study", example: "study --question Question", usage: "init <dir> --question TEXT [--mode survey|experiment] [--autonomy auto|gates|copilot|step] [--json]", mutates: true, options: { "--question": "value", "--mode": "value", "--autonomy": "value", ...json } },
  { name: "run", summary: "Execute the study plan", example: "study", usage: "run <dir> [--parallel 1..8] [--json]", mutates: "network", options: { "--parallel": "value", ...json } },
  { name: "plan set", summary: "Set the study plan", example: "study --file plan.json", usage: "plan set <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "plan control", summary: "Pause, resume or control a plan node", example: "study pause --command-id pause-one --expected-revision 1", usage: "plan control <dir> <pause|resume|retry|cancel|skip> [node] --command-id ID --expected-revision N [--json]", mutates: "network", options: { "--command-id": "value", "--expected-revision": "value", ...json } },
  { name: "plan show", summary: "Show the plan, nodes and execution state", example: "study", usage: "plan show <dir> [--json]", mutates: false, options: json },
  { name: "status", summary: "Show study readiness and progress", example: "study", usage: "status <dir> [--json]", mutates: false, options: json },
  { name: "study export", summary: "Export a study bundle or preview its files", example: "study --bundle bundle --list", usage: "study export <dir> --bundle DIR [--list] [--json]", mutates: true, options: { "--bundle": "value", "--list": "flag", ...json } },
  { name: "scope", summary: "Set the study scope", example: "study --file scope.json", usage: "scope <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "idea add", summary: "Record a research idea", example: "study --file idea.json", usage: "idea add <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "idea decide", summary: "Record an idea refinement or pivot", example: "study idea-one pivot --reason evidence", usage: "idea decide <dir> <id> <refine|pivot> --reason TEXT [--attempts ID[,ID...]] [--commit SHA] [--cause TEXT] [--retry-when TEXT] [--json]", mutates: true, options: { "--cause": "value", "--retry-when": "value", "--reason": "value", "--attempts": "value", "--commit": "value", ...json } },
  { name: "investigate show", summary: "Show the investigation and selected evidence", example: "study", usage: "investigate show <dir> [--json]", mutates: false, options: json },
  { name: "investigate close", summary: "Close the investigation with current evidence", example: "study", usage: "investigate close <dir> [--json]", mutates: true, options: json },
  { name: "ablate add", summary: "Record evidence for an ablation case", example: "study --file ablation.json", usage: "ablate add <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "ablate show", summary: "Show the ablation cases and their evidence", example: "study", usage: "ablate show <dir> [--json]", mutates: false, options: json },
  { name: "ablate close", summary: "Close the ablation phase", example: "study", usage: "ablate close <dir> [--json]", mutates: true, options: json },
  { name: "posthoc show", summary: "Show posthoc investigation evidence", example: "study", usage: "posthoc show <dir> [--json]", mutates: false, options: json },
  { name: "final close", summary: "Close the final experiment phase", example: "study", usage: "final close <dir> [--json]", mutates: true, options: json },
  { name: "final seeds", summary: "Record the final experiment seeds", example: "study --file seeds.json", usage: "final seeds <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "selection", summary: "Set the investigation selection rule", example: "study --file selection.json", usage: "selection <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "protocol", summary: "Set the experiment protocol", example: "study --file protocol.json", usage: "protocol <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "executor set", summary: "Configure an experiment executor", example: "study --kind local --workdir /tmp/ares", usage: "executor set <dir> --kind local|ssh [--host ALIAS] --workdir PATH [--retention-cap-bytes BYTES] [--gpu-devices IDS --gpu-min-free-memory-mb MB --gpu-max-load-ratio RATIO] [--json]", mutates: true, options: { "--kind": "value", "--host": "value", "--workdir": "value", "--retention-cap-bytes": "value", "--gpu-devices": "value", "--gpu-min-free-memory-mb": "value", "--gpu-max-load-ratio": "value", ...json } },
  { name: "executor inputs hash", summary: "Hash an input directory on the executor", example: "study /data/inputs", usage: "executor inputs hash <dir> <path> [--json]", mutates: "network", options: json },
  { name: "executor check", summary: "Check executor readiness", example: "study", usage: "executor check <dir> [--json]", mutates: "network", options: json },
  { name: "gate list", summary: "List gates and their current decisions", example: "study", usage: "gate list <dir> [--json]", mutates: false, options: json },
  { name: "gate approve", summary: "Approve the current gate binding", example: "study scope", usage: "gate approve <dir> <scope|screen|design|final|review|plan:node-id|accept:artifact|harness:round-id> [--reason TEXT] [--json]", mutates: true, options: { "--reason": "value", ...json } },
  { name: "gate reject", summary: "Reject the current gate binding", example: "study scope --reason incomplete", usage: "gate reject <dir> <scope|screen|design|final|review|plan:node-id|accept:artifact|harness:round-id> --reason TEXT [--json]", mutates: true, options: { "--reason": "value", ...json } },
  { name: "attempt run", summary: "Start or resume an experiment attempt", example: "study --repo /repo --commit abcdef0123456789abcdef0123456789abcdef01", usage: "attempt run <dir> --repo PATH --commit SHA [--seed N] [--run NAME] [--label TEXT] [--retry ID] [--reuse off|eligible] [--force-fresh] [--detach] [--json]", mutates: "network", options: { "--repo": "value", "--commit": "value", "--seed": "value", "--run": "value", "--label": "value", "--retry": "value", "--reuse": "value", "--force-fresh": "flag", "--detach": "flag", ...json } },
  { name: "attempt list", summary: "List experiment attempts and states", example: "study", usage: "attempt list <dir> [--run NAME] [--status running|succeeded|failed|cancelled|unknown] [--limit N] [--offset N] [--json]", mutates: false, options: { "--run": "value", "--status": "value", "--limit": "value", "--offset": "value", ...json } },
  { name: "attempt show", summary: "Show one experiment attempt", example: "study attempt-id", usage: "attempt show <dir> <id> [--json]", mutates: false, options: json },
  { name: "attempt cancel", summary: "Cancel a running experiment attempt", example: "study attempt-id", usage: "attempt cancel <dir> <id> [--reason TEXT] [--json]", mutates: "network", options: { "--reason": "value", ...json } },
  { name: "attempt reconcile", summary: "Reconcile recorded attempts with the executor", example: "study", usage: "attempt reconcile <dir> [--json]", mutates: "network", options: json },
  { name: "attempt logs", summary: "Read collected attempt logs", example: "study attempt-id", usage: "attempt logs <dir> <id> [--stage candidate|evaluator] [--candidate-stage NAME] [--stream stdout|stderr] [--tail BYTES] [--json]", mutates: false, options: { "--stage": "value", "--candidate-stage": "value", "--stream": "value", "--tail": "value", ...json } },
  { name: "lit search", summary: "Search literature sources for candidates", example: "study reproducibility", usage: "lit search <dir> <query> [--source openalex|s2|arxiv|all] [--limit 1..50] [--year-from YYYY] [--intent lexical|semantic|background] [--json]", mutates: "network", options: { "--source": "value", "--limit": "value", "--year-from": "value", "--intent": "value", ...json } },
  { name: "lit queries", summary: "List literature searches and their yield", example: "study", usage: "lit queries <dir> [--json]", mutates: false, options: json },
  { name: "lit flow", summary: "Show the literature screening flow", example: "study", usage: "lit flow <dir> [--markdown] [--json]", mutates: false, options: { "--markdown": "flag", ...json } },
  { name: "lit list", summary: "List literature candidates", example: "study", usage: "lit list <dir> [--status new|included|excluded] [--limit 1..500] [--json]", mutates: false, options: { "--status": "value", "--limit": "value", ...json } },
  { name: "lit screen", summary: "Include or exclude literature candidates", example: "study doi:10.0000/example --include", usage: "lit screen <dir> <id>... --include|--exclude [--code CODE] [--reason TEXT] [--json]", mutates: true, options: { "--include": "flag", "--exclude": "flag", "--code": "value", "--reason": "value", ...json } },
  { name: "lit card", summary: "Record an extraction card for a candidate", example: "study doi:10.0000/example --file card.json", usage: "lit card <dir> <id> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "lit card export", summary: "Preview or confirm exporting extraction cards", example: "study doi:10.0000/example --vault research", usage: "lit card export <dir> <id>... --vault ID [--model-family NAME] [--confirm FINGERPRINT] [--json]", mutates: "network", options: { "--vault": "value", "--model-family": "value", "--confirm": "value", ...json } },
  { name: "lit card import", summary: "Import prior extraction cards as planning aids", example: "study doi:10.0000/example --vault research", usage: "lit card import <dir> <id>... --vault ID [--json]", mutates: "network", options: { "--vault": "value", ...json } },
  { name: "lit card list", summary: "List extraction cards", example: "study", usage: "lit card list <dir> [--json]", mutates: false, options: json },
  { name: "lit verify", summary: "Verify candidate identifiers and metadata", example: "study", usage: "lit verify <dir> [<id>...] [--json]", mutates: "network", options: json },
  { name: "lit bib", summary: "Build the verified study bibliography", example: "study", usage: "lit bib <dir> [--json]", mutates: true, options: json },
  { name: "review add", summary: "Record a review for the current paper build", example: "study --file review.json", usage: "review add <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "review resolve", summary: "Record a resolution for a review finding", example: "study review-one/finding-one --reason revised", usage: "review resolve <dir> <review-id>/<finding-id> --reason TEXT [--json]", mutates: true, options: { "--reason": "value", ...json } },
  { name: "review show", summary: "Show paper reviews and open findings", example: "study", usage: "review show <dir> [--json]", mutates: false, options: json },
  { name: "review checklist", summary: "Show the paper review checklist", usage: "review checklist [--json]", mutates: false, options: json },
  { name: "paper build", summary: "Build the checked paper manuscript", example: "study", usage: "paper build <dir> [--json]", mutates: true, options: json },
  { name: "paper render record", summary: "Record an external render of the current build", example: "study --file paper.pdf --receipt receipt.json", usage: "paper render record <dir> --file PATH --receipt PATH [--json]", mutates: true, options: { "--file": "value", "--receipt": "value", ...json } },
  { name: "paper render show", summary: "Show whether a render matches the current build", example: "study", usage: "paper render show <dir> [--json]", mutates: false, options: json },
  { name: "renderer set", summary: "Set this machine's renderer for the study", example: "study --command '[\"atex\",\"ares\",\"build\",\"{study}\",\"{out}\"]'", usage: "renderer set <dir> --command JSON [--timeout-s N] [--json]", mutates: true, options: { "--command": "value", "--timeout-s": "value", ...json } },
  { name: "renderer show", summary: "Show this machine's renderer for the study", example: "study", usage: "renderer show <dir> [--json]", mutates: false, options: json },
  { name: "renderer check", summary: "Check the renderer without running it", example: "study", usage: "renderer check <dir> [--json]", mutates: false, options: json },
  { name: "paper plan set", summary: "Set the paper plan", example: "study --file paper-plan.json", usage: "paper plan set <dir> --file PATH|- [--json]", mutates: true, options: { "--file": "value", ...json } },
  { name: "paper plan show", summary: "Show the current paper plan", example: "study", usage: "paper plan show <dir> [--json]", mutates: false, options: json },
  { name: "paper check", summary: "Check paper claims and cited evidence", example: "study", usage: "paper check <dir> [--json]", mutates: false, options: json },
  { name: "cite check", summary: "Check draft citations against verified references", example: "study draft.md", usage: "cite check <dir> <draft> [--json]", mutates: false, options: json },
  { name: "playbook", summary: "Print the research workflow and reference rules", usage: "playbook", mutates: false, options: {} },
  { name: "mcp", summary: "Start the MCP server on standard streams", usage: "mcp", mutates: false, options: {} },
];
export function findCommand(args: string[]): { spec: CommandSpec; rest: string[] } | undefined {
  const longest = Math.max(...COMMANDS.map(command => command.name.split(" ").length));
  for (let words = longest; words >= 1; words--) {
    const name = args.slice(0, words).join(" "), spec = COMMANDS.find(c => c.name === name);
    if (spec) return { spec, rest: args.slice(words) };
  }
  return undefined;
}

export const GLOBAL_HELP_FLAGS = {
  "--json": "Print the result as compact JSON when supported",
  "--color": "Set color to auto, always or never",
  "--ascii": "Use ASCII markers",
  "--help": "Show command help",
} as const;

export const FLAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "--apply": "Apply the integration changes",
  "--attempts": "Select attempt IDs as ID[,ID...]",
  "--autonomy": "Set the initial autonomy policy",
  "--bundle": "Set the export directory",
  "--candidate-stage": "Select a named candidate pipeline stage",
  "--candidates": "Select candidate commits as SHA[,SHA...]",
  "--cause": "Describe the cause of the decision",
  "--code": "Set the declared exclusion code",
  "--command-id": "Set the idempotency key",
  "--command": "Set the renderer argv as a JSON array",
  "--commit": "Select the candidate commit",
  "--confirm": "Confirm with the preview fingerprint",
  "--cursor": "Continue from a lineage cursor",
  "--detach": "Return after starting the attempt",
  "--exclude": "Exclude the selected candidates",
  "--expected-revision": "Require this plan revision",
  "--file": "Read the input file or use - for stdin",
  "--for": "Set the intent for ranking lessons",
  "--force-fresh": "Require fresh execution",
  "--gpu-devices": "Select GPU IDs as ID[,ID...]",
  "--gpu-max-load-ratio": "Set the maximum GPU load ratio",
  "--gpu-min-free-memory-mb": "Set minimum free GPU memory in MB",
  "--half-life": "Set the recency half-life in days",
  "--host": "Select the SSH host alias",
  "--id": "Select the root reference ID",
  "--include": "Include the selected candidates",
  "--intent": "Label the search intent",
  "--kind": "Select a local or SSH executor",
  "--label": "Label the attempt",
  "--limit": "Cap the number of results",
  "--list": "Preview the files without exporting",
  "--markdown": "Print the screening flow as Markdown",
  "--mode": "Choose a survey or experiment study",
  "--model": "Select the model used for the check",
  "--model-family": "Record the model family",
  "--offset": "Skip this many records",
  "--parallel": "Set concurrency from 1 to 8",
  "--phase": "Limit the policy to one phase",
  "--pr": "Link the pull request for acceptance",
  "--question": "Set the research question",
  "--reason": "Record the reason for the decision",
  "--receipt": "Read the renderer receipt JSON",
  "--repo": "Select the candidate repository",
  "--retention-cap-bytes": "Set the study storage cap in bytes",
  "--retry": "Retry the selected attempt ID",
  "--retry-when": "Describe when to retry this idea",
  "--reuse": "Choose off or eligible reuse",
  "--revision": "Select the root reference revision",
  "--root": "Select the root reference kind",
  "--round": "Select a harness round",
  "--run": "Select or name an experiment run",
  "--runtime": "Select the runtime version",
  "--seed": "Select a declared protocol seed",
  "--sha256": "Match the root reference digest",
  "--source": "Select the literature provider",
  "--stage": "Select candidate or evaluator logs",
  "--status": "Filter by recorded status",
  "--stream": "Select stdout or stderr logs",
  "--tail": "Limit the collected tail in bytes",
  "--timeout-s": "Set the renderer wall time in seconds",
  "--toolset-sha256": "Require a toolset digest",
  "--undo": "Remove the integration registration",
  "--vault": "Select the registered vault ID",
  "--workdir": "Set the executor working directory",
  "--year-from": "Set the earliest publication year",
};

export const FLAG_OVERRIDES: Readonly<Record<string, string>> = {
  "setup --root": "Pin an absolute release directory",
  "lit search --limit": "Return 1 to 50 candidates",
  "lit list --limit": "Return 1 to 500 candidates",
  "lit card --file": "Read the extraction card JSON",
  "harness import --file": "Read fixture JSON from a file or stdin",
  "paper render record --file": "Read the rendered document file",
};

export function flagDescription(spec: CommandSpec, flag: string): string | undefined {
  return FLAG_OVERRIDES[`${spec.name} ${flag}`] ?? FLAG_DESCRIPTIONS[flag];
}

/** Keep published manifest usages byte-stable while normalizing human help. */
export function helpUsage(spec: CommandSpec): string {
  return spec.usage.replace(/ \[--json\]$/, "")
    .replace("[node]", "[<node>]")
    .replace("--gpu-devices IDS", "--gpu-devices ID[,ID...]")
    .replace(/--(parallel|limit) 1\.\.\d+/g, "--$1 N")
    .replace(/<scope\|screen\|design\|final\|review\|plan:node-id\|accept:artifact\|harness:round-id>/, "<gate>")
    .replace("--root KIND --id ID --revision REV --sha256 HASH", "--root KIND --id ID [--revision REV] [--sha256 HASH]")
    .replace("(--attempts ID,... | --candidates COMMIT,...)", "[--attempts ID[,ID...]|--candidates SHA[,SHA...]]");
}

/** Prefer the usage's value notation while keeping each flag's description on one row. */
export function helpFlagLabel(spec: CommandSpec, flag: string): string {
  if (spec.options[flag] !== "value") return flag;
  const after = helpUsage(spec).split(`${flag} `)[1];
  const token = after?.split(/ |\|--/, 1)[0];
  const value = token?.endsWith("]") && (!token.includes("[") || token.endsWith("]]")) ? token.slice(0, -1) : token;
  if (!value) return flag;
  const label = `${flag} ${value}`;
  return label.length <= 28 ? label : `${flag} VALUE`;
}
