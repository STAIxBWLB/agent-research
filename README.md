# agent-research (`ares`)

Research engine for the agent family ([agent-hub](https://github.com/STAIxBWLB/agent-hub), [agent-mem](https://github.com/STAIxBWLB/agent-mem), [vault-mem](https://github.com/STAIxBWLB/vault-mem), [agent-console](https://github.com/STAIxBWLB/agent-console)). The plan and phases are in [#1](https://github.com/STAIxBWLB/agent-research/issues/1).

This checkout implements A1 literature studies, A2 container experiments and the A3 plan DAG: an append-only ledger, approval gates, verified reference identifiers, frozen candidate snapshots, separate evaluator containers, attempt records and a resumable controller with read-only hub task references. Investigation selection, idea decisions and winner/no-winner results are available; automatic idea generation, ablation/final/posthoc logic, manuscripts, memory integration and the console panel remain later work.

## Install

Requires Bun 1.4.2 or newer. Not yet published to npm; run from a checkout:

```sh
bun install --frozen-lockfile
bun bin/ares.js --help
```

Register the MCP server with an agent host by hand, for example `claude mcp add ares -- bun /path/to/agent-research/bin/ares.js mcp`.

## Literature workflow

```sh
ares init study --question "How do research agents verify citations?"
ares scope study --file scope.json          # question, subquestions, include, exclude, yearFrom, yearTo, maxCandidates
ares gate approve study scope
ares lit search study "citation verification agents"
ares lit list study
ares lit screen study <id>... --include --reason "on topic"
ares lit card study <id> --file card.json   # summary, claims, methods, findings, limitations, relevance
ares lit verify study
ares gate approve study screen
ares lit bib study                          # writes study/refs/references.bib
ares cite check study draft.md              # exit 1 on unknown or unverified [@keys]
```

`ares playbook` prints the full standalone workflow and its rules. Study commands accept `--json`; see the command list for exact usage.

## Experiment workflow

Requires Docker on the executor host and, for SSH execution, a configured SSH alias that works with `BatchMode=yes`. Images must already contain dependencies; ares does not build them and experiments have no network access. Survey is the default mode; mode is fixed at init, so create a separate experiment study.

```sh
ares init experiment --question "Does this candidate improve the declared metric?" --mode experiment
# Write experiment/task/task.md and experiment/task/evaluator/ before setting the protocol.
ares protocol experiment --file protocol.json
ares executor set experiment --kind ssh --host dgx-h100-2 --workdir /private/owned/ares
# Or: ares executor set experiment --kind local --workdir /private/owned/ares
ares executor check experiment
ares gate approve experiment design
ares attempt run experiment --repo /absolute/candidate-repo --commit <full-40-hex-SHA> --seed 1 --run main --label baseline --detach
ares attempt reconcile experiment
ares attempt list experiment
ares attempt show experiment <id>
ares attempt logs experiment <id> --stage candidate --stream stderr --tail 16384
# To stop a running attempt:
ares attempt cancel experiment <id> --reason "stop this run"
```

Create the executor workdir on that host, owned by its user with mode `0700`. The path is required and absolute; a shared `/tmp` default is not used. `executor check` reports the Docker server version, image availability and non-root uid:gid, and may pull missing images. It stores the alias, never SSH credentials.

The task contains `task.md`, evaluator entrypoint/data under `evaluator/`, and optional `rubric.md`. Use regular files only, at most 500 files and 64 MiB total; symlinks are refused. A protocol has this shape (the pinned BusyBox image below can run the synthetic shell fixtures):

```json
{
  "v": 1,
  "method": "Compare a frozen candidate using the declared evaluator",
  "candidate": {
    "image": "busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec",
    "command": ["sh", "/workspace/candidate.sh"]
  },
  "evaluator": {
    "image": "busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec",
    "command": ["sh", "/eval/evaluate.sh"]
  },
  "metrics": [{"name": "score", "unit": "points", "direction": "max"}],
  "seeds": [1],
  "limits": {"cpus": 1, "memoryMb": 64, "pidsLimit": 64, "wallSeconds": 30, "gpus": 0},
  "network": "none",
  "budget": {"maxAttempts": 4, "maxWallHours": 1, "maxGpuHours": 0}
}
```

Commands are argv arrays, never shell strings. An optional `candidate.env` accepts bounded strings; secret-like keys and `ARES_SEED`, `__proto__`, `constructor`, `prototype` are refused. The selected declared seed is supplied to both stages as `ARES_SEED`.

The candidate gets its frozen Git archive at `/workspace:ro` and writable `/out`, with no evaluator or `/result` mount. A different container gets `/eval:ro`, `/candidate:ro` and writable `/result`. Both use network none, read-only root filesystems, a temporary `/tmp`, dropped capabilities, no-new-privileges, protocol resource limits and the executor user's non-root uid:gid. The commit must be a full 40-hex SHA; the archive is capped at 256 MiB and ignores later HEAD/worktree edits.

Only the evaluator's `/result/metrics.json` supplies metrics: at most 64 KiB, exactly the declared names with finite numeric values, for example `{"score": 7}`. Units and directions come from the protocol. Missing, malformed or undeclared metrics fail at the evaluator stage; candidate-printed scores never become metrics.

Without `--detach`, `attempt run` reconciles until finished. Detached runs and MCP `ares_attempt_run` return while running; call `attempt reconcile` again to advance stages and collect results. States progress from running candidate to running evaluator, then succeeded, failed, cancelled or unknown. A gone container without an exit record becomes unknown (`lost`); reconcile never creates a new attempt. One attempt may be active per study. A host watchdog enforces each stage's wall-clock limit.

The same protocol hash, commit/tree, seed and run return the same attempt. Use `--retry <id>` for a linked new attempt; a different commit or seed is a new attempt, not a reproduction. Every status counts toward study budgets (attempt count, wall hours, GPU hours). `attempt list` returns summaries and whole-study totals for every status regardless of filters or page; default page size 50, maximum 200, with `--offset` for later pages. `attempt show` returns the full record.

Raw outputs and logs stay in the private executor attempt directory. The study holds output paths, sha256 and byte counts (regular files only, at most 500 files and 256 MiB total), plus each log stream's path, hash, bytes and truncation flag. Each stdout/stderr copy is capped at 16 MiB; excess log volume does not fail an attempt. `attempt logs` checks the recorded copies and prints tails without changing the study; `--tail` accepts 0..65536 bytes (default 16384), and omitted stage/stream filters return all recorded streams. No log content is persisted in the study.

## Investigation workflow

Set the selection rule before running baseline and candidate attempts. It fixes the run, primary protocol metric, frozen baseline commit, minimum paired seeds and improvement margin. Save this as `selection.json`, replacing the synthetic baseline SHA with your full frozen commit:

```json
{"v": 1, "run": "investigate", "metric": "score", "baseline": {"commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}, "minSeeds": 1, "minDelta": 0.01}
```

Use the experiment setup above, then:

```sh
ares selection experiment --file selection.json
ares gate approve experiment design
# Run the frozen baseline and each candidate with --run investigate and declared seeds.
ares attempt run experiment --repo /absolute/candidate-repo --commit <baseline-40-hex-SHA> --seed 1 --run investigate --label baseline --detach
ares attempt reconcile experiment
# After it stops, run candidate commits the same way, then reconcile each one.
ares investigate show experiment --json
ares investigate close experiment --json
```

`metric` must be declared in the protocol; its unit and max/min direction come from there. `minSeeds` is 1..the number of declared seeds, and `minDelta` is finite and >=0 in that unit. A new or changed rule adds its raw file hash to the design seal and reopens approval. Identical validated bytes are a no-op, so they cannot erase earlier results by moving the cutoff. Protocol edits that invalidate an existing rule refuse before writing. Studies without selection retain the original design binding and approval.

`investigate show` is read-only. Counting uses the selected run, current protocol hash and `attempt.started` ledger order after the latest recorded `selection.set`. Only the earliest successful attempt per commit/seed counts. Later successes, other-protocol, before-selection, undeclared-seed and missing-start attempts are listed with reasons; failed, cancelled, unknown and excluded records remain in run totals. Labels do not choose the baseline, its commit in the rule does.

Each candidate compares its mean primary metric against the baseline on their shared successful seeds. It needs at least `minSeeds` pairs, a direction-adjusted delta strictly above zero and at least `minDelta`. Eligible candidates rank by paired delta, not raw mean, because paired seed sets can differ. An exact best-delta tie yields no winner. Other no-winner reasons are `no-baseline`, `baseline-seeds`, `no-candidate` and `below-margin`. Means are descriptive, with no significance test.

Close refuses while any attempt in the selected run is running, including excluded attempts. It writes `runs/<run>/investigate.json` and `investigate.closed` together. The timestamp-free result includes rule/input hashes, baseline/candidate rows, paired values and means, exclusions, totals and a winner or `null` with its reason. Closing unchanged inputs writes nothing. Show/close starts no attempt, Docker process or hub; the tests use synthetic offline records.

### Idea journal

Ideas and their decisions live in ledger events, not a second file. An idea input for `ares idea add experiment --file idea.json` is:

```json
{"id": "variant-1", "title": "Synthetic candidate", "hypothesis": "The frozen candidate improves the declared metric", "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
```

Replace that synthetic commit with your candidate's frozen SHA. `id` and optional `parent` use the run-name rule (1..64 characters, alphanumeric first, then letters/digits/underscore/hyphen). Ids are unique, parent must exist, and each commit has exactly one idea owner. Limits are 1,000 ideas, 500-character titles and 4,000-character hypotheses. After inspecting terminal attempts from that idea's existing commits, record a decision:

```sh
ares idea decide experiment variant-1 refine --reason "Test the next frozen candidate" --attempts <terminal-attempt-id> --commit <next-40-hex-SHA>
# To close a tested direction:
ares idea decide experiment variant-1 pivot --reason "Drop this direction" --attempts <terminal-attempt-id>
```

Refine adds the uniquely owned commit. Pivot refuses `--commit`, closes further decisions and keeps historical attempts and totals. Evidence is at most 200 existing, non-running, same-study attempt ids from the idea's commits; reasons are at most 2,000 bytes. An untested idea may omit `commit` when added, then omit `--attempts` for a first `refine --commit` or a pivot before testing. Once it has commits, nonempty evidence is required. Investigation rows and winner references carry the owning idea id; journal changes join the result's input hash. Survey studies refuse all selection, idea and investigate commands.

A conductor can put a no-argument `investigate.close` step after its agent-work hub unit, then bind a local plan gate to that result:

```json
{
  "v": 1,
  "nodes": [
    {"id": "agent-work", "kind": "hub", "campaign": "rc-0123456789ab", "unit": "candidates"},
    {"id": "close", "kind": "step", "command": "investigate.close", "args": {}, "needs": ["agent-work"]},
    {"id": "review-result", "kind": "gate", "needs": ["close"], "binds": ["close"]}
  ],
  "edges": []
}
```

Use your real campaign/unit ids, with unit completion covering all attempts reaching terminal states. The close step emits exactly `{sha256, winner}` for the saved result; `winner: null` is a valid completed outcome, and its file explains why. The plan gate binds that reference before any later research phase. Start/resume/approve the plan as below. Ares only observes hub work; it does not generate ideas, launch coding agents or perform hub writes. Live hub/executor DAG coverage has not been run for this investigation workflow.

## Plan and conductor workflow

A plan connects existing commands, approval gates and read-only hub task references. It can close an investigation result; ablation, final and posthoc research logic remain separate work. Create a study first. This offline example checks two drafts, with an approval between them: put citation-free text in `plan-study/draft.md` and `plan-study/final.md`, and save this definition as `draft-plan.json`:

```json
{
  "v": 1,
  "nodes": [
    {"id": "check-draft", "kind": "step", "command": "cite.check", "args": {"draft": "draft.md"}},
    {"id": "review", "kind": "gate", "needs": ["check-draft"], "binds": ["check-draft"]},
    {"id": "check-final", "kind": "step", "command": "cite.check", "args": {"draft": "final.md"}, "needs": ["review"]}
  ],
  "edges": []
}
```

```sh
ares init plan-study --question "Are the draft citations ready for review?"
# Write the two draft files described above, then set the plan.
ares plan set plan-study --file draft-plan.json
ares plan show plan-study --json
# Terminal A: stays open, initially paused.
ares run plan-study --parallel 2
```

In terminal B, use the revision from `plan show` (1 for this first definition):

```sh
ares plan control plan-study resume --command-id resume-1 --expected-revision 1
ares gate list plan-study
# After plan:review is pending with complete upstream outputs:
ares gate approve plan-study plan:review
ares plan show plan-study --json
```

`run` exits 0 when the plan is done. Each controller start restores an unfinished plan paused; resume it explicitly from another terminal or MCP client. SIGINT/SIGTERM stops admission, drains active command calls, records paused when still running, and releases the controller lock. Detached attempts stay alive for `attempt reconcile`. A live or foreign controller owner is refused; a dead same-host owner is recoverable by pid and process start identity, never by lock age. Waiting observations use 1 s to 30 s backoff, reset on progress, and unchanged polls write nothing.

Plan definitions accept at most 128 nodes, 512 explicit edges and 128-byte ids, with no cycles or missing dependency endpoints. `needs` and `edges` both supply dependencies; a gate's `binds` may name only upstream nodes. A step command is one of `lit.search`, `lit.verify`, `lit.bib`, `cite.check`, `attempt.run`, `investigate.close`. The close step takes no args. Named `args` carry CLI options without `--`, including `year-from`; positional inputs are `query` for search, optional `ids` for verify, and `draft` for cite check. `attempt.run` needs `repo` and `commit`, always detaches, and accepts the existing seed/run/label/retry options. Steps refuse controller-owned `json` and `detach` arguments. Relative `repo` and `draft` resolve against the study directory. Scope, screen and design prerequisites still apply to the underlying commands.

`--parallel` admits 1..8 step nodes (default 1); the existing one-active-attempt-per-study rule still applies. Plan state is replayed from ledger events. `plan show` is lock-free and lists each node's current status, last observation, attempt/retry/task references, gate decisions, uncertain nodes and controller owner. It also shows `hubProject` when a hub read resolves a board.

Controls require a caller-chosen `--command-id` and the current definition's `--expected-revision`. Identical requests replay their original receipt, even after a definition change; reusing an id with another payload or using a stale revision for a new request refuses. Controls do not bump the definition revision. `pause` stops admission, `resume` allows it, `cancel <node>` stops that node's attempt when one exists, and `retry <node>` makes a failed, cancelled, uncertain, stale or completed node eligible for a fresh dispatch. Retry links an existing parent attempt; a predicted id with no attempt record is not a retry parent. `skip <node>` releases ordinary control dependencies without producing output, and never passes any ancestor gate. Hub cancellation is local only.

Changing a consumed node's definition or dependencies marks it and consumed descendants stale; never-run nodes remain eligible after their dependencies finish. Stale nodes need explicit retry. An unobservable interrupted step becomes uncertain and is never replayed automatically. A changed upstream output invalidates its plan gate approval; pending gates in auto autonomy are approved inside the controller's commit with actor `auto`. Which person or agent may approve a local plan gate remains workspace policy.

### Hub references

A hub node has this shape, using the campaign/unit ids from an existing agent-hub campaign:

```json
{"id": "variants", "kind": "hub", "campaign": "rc-0123456789ab", "unit": "variants", "needs": ["check-draft"]}
```

The planner drafts that campaign and a person approves/activates it in agent-hub. Ares only reads: it never drafts, revises, approves or creates hub tasks. The controller host needs `ahub` on PATH. Its bounded `ahub --project <study-dir> status --json` and `study show <campaign> --json` calls resolve the nearest hub project within the Git boundary; `status.cwd` becomes `hubProject`. A hub node whose project cannot be resolved/reached stays dispatched with a named read error. Studies outside a hub project can still run plans with steps and local gates.

A ready hub node records its unit's child task id and waits for that task's approval. Pending campaign approval or activation waits without a manual retry. An initial read outage may leave the dispatch unbound until its first successful read; the task is then pinned for that plan revision, including across restarts and retries. Missing units/tasks, cancelled tasks and a different binding fail with the reason. A new plan revision can bind the unit's new task. Hub waits use the controller backoff, do not consume step slots, and do not redispatch agent work. Their completed output is an id/hash reference, so a downstream plan gate can bind to it.

## What sealed means

The `design` gate binds the exact protocol bytes and the sorted `task/` file tree hashes, plus the raw selection file hash when present. Editing any sealed input reopens the gate. A budget-only change also reopens it, while the comparable attempt protocol hash excludes budget. The executor configuration is outside the seal; the attempt records the executor it used.

Sealing and metrics are **ares-observed**: ares builds the argv and checks the observed container configuration. They are never **host-observed** or **runner-attested**. Signed receipts await [agent-hub#1018](https://github.com/STAIxBWLB/agent-hub/issues/1018). This seal neither attests to an untrusted host nor establishes support for a research claim.

## What the checks mean

- **verified**: the DOI exists at Crossref or DataCite, or the arXiv id exists at arXiv, and the registry's title and year match the candidate. It never means a paper supports a claim.
- **unknown**: the registry could not be reached or answered incompletely (network failure, rate limit, server error, error or truncated feed). Run `ares lit verify` again; unknown is never treated as missing.
- When a record shows that two candidates are the same work, an unscreened one is folded in; otherwise both are flagged `duplicates`, and `ares lit bib` refuses while both are included.
- Only included and verified papers enter `references.bib`. Citekeys never change once assigned.

## Gates

`scope` binds to the content of `scope.json`; `screen` binds to the set of included papers; `design` binds the experiment protocol and task tree; `plan:<node-id>` binds a plan gate to all upstream observed output references. Changing bound content returns its gate to pending. With `--autonomy auto` a pending gate is approved as `auto` when a command needs it; with `gates` (default) someone must run `ares gate approve`. The ledger records who approved: a person, an agent (detected from the agent environment) or `auto`. Which of them may approve is the workspace's policy, not the tool's. For experiments, automatic design approval is committed with a verified candidate start; a failed preparation records no approval.

## Study files

| File | Content |
| --- | --- |
| `study.json` | question, mode, autonomy |
| `ledger.jsonl` | append-only events with actor and time, including plan state/dispatch/control receipts |
| `plan.json` | validated versioned plan definition and revision |
| `.ares.plan.lock` | controller pid, host, process start identity and ownership token |
| `scope.json` | the scope |
| `literature/candidates.json` | merged candidates, screening and verification |
| `literature/cards/*.json` | extraction cards |
| `refs/references.bib` | generated bibliography |
| `task/task.md`, `task/evaluator/`, optional `task/rubric.md` | experiment task and evaluator files, written directly |
| `design/protocol.json` | validated experiment protocol |
| `design/selection.json` | sealed investigation rule, when set |
| `runs/<run>/investigate.json` | deterministic winner/no-winner result, candidate rows and totals |
| `executor.json` | executor kind, optional SSH alias and required workdir |
| `runs/<run>/attempts/<id>.json` | attempt identity, stage receipts, status, metrics and artifact/log metadata |

Experiment logs and outputs live on the executor at `<workdir>/<study-id>/<attempt-id>/`, not in the study. Existing A1 survey studies remain readable without migration.

## Commands

The implemented CLI surface below comes from `src/commands-table.ts`; `ares --help` prints current usage. Every operation exposing `--json` supports structured output.

```text
ares manifest [--json]
ares init <dir> --question TEXT [--mode survey|experiment] [--autonomy auto|gates] [--json]
ares run <dir> [--parallel 1..8] [--json]
ares plan set <dir> --file PATH|- [--json]
ares plan control <dir> <pause|resume|retry|cancel|skip> [node] --command-id ID --expected-revision N [--json]
ares plan show <dir> [--json]
ares status <dir> [--json]
ares scope <dir> --file PATH|- [--json]
ares idea add <dir> --file PATH|- [--json]
ares idea decide <dir> <id> <refine|pivot> --reason TEXT [--attempts ID[,ID...]] [--commit SHA] [--json]
ares investigate show <dir> [--json]
ares investigate close <dir> [--json]
ares selection <dir> --file PATH|- [--json]
ares protocol <dir> --file PATH|- [--json]
ares executor set <dir> --kind local|ssh [--host ALIAS] --workdir PATH [--json]
ares executor check <dir> [--json]
ares gate list <dir> [--json]
ares gate approve <dir> <scope|screen|design|plan:node-id> [--reason TEXT] [--json]
ares gate reject <dir> <scope|screen|design|plan:node-id> --reason TEXT [--json]
ares attempt run <dir> --repo PATH --commit SHA [--seed N] [--run NAME] [--label TEXT] [--retry ID] [--detach] [--json]
ares attempt list <dir> [--run NAME] [--status running|succeeded|failed|cancelled|unknown] [--limit N] [--offset N] [--json]
ares attempt show <dir> <id> [--json]
ares attempt cancel <dir> <id> [--reason TEXT] [--json]
ares attempt reconcile <dir> [--json]
ares attempt logs <dir> <id> [--stage candidate|evaluator] [--stream stdout|stderr] [--tail BYTES] [--json]
ares lit search <dir> <query> [--source openalex|s2|arxiv|all] [--limit 1..50] [--year-from YYYY] [--json]
ares lit list <dir> [--status new|included|excluded] [--limit 1..500] [--json]
ares lit screen <dir> <id>... --include|--exclude [--reason TEXT] [--json]
ares lit card <dir> <id> --file PATH|- [--json]
ares lit verify <dir> [<id>...] [--json]
ares lit bib <dir> [--json]
ares cite check <dir> <draft> [--json]
ares playbook
ares mcp
```

MCP uses shared command handlers; `init`, the controller loop `run`, and the server entrypoint `mcp` are CLI-only. Investigation tools are `ares_selection_set`, `ares_idea_add`, `ares_idea_decide`, `ares_investigate_show` and `ares_investigate_close`. Plan tools are `ares_plan_set`, `ares_plan_show` and `ares_plan_control`; `ares_gate` accepts `plan:<node-id>`. Setting, showing or controlling a plan never starts the controller loop. Start `ares run` in a separate terminal before resuming through MCP. Experiment tools are `ares_protocol_set`, `ares_executor_set`, `ares_executor_check`, `ares_attempt_run`, `ares_attempt_list`, `ares_attempt_show`, `ares_attempt_cancel`, `ares_attempt_reconcile` and `ares_attempt_logs`; `ares_gate` accepts `design`. Attempt run is always detached over MCP, and executor-reaching tools carry `openWorldHint`.

## Version and format discovery

`ares manifest --json` (MCP `ares_manifest`, no arguments) reports the running package version, implemented command names/usages and the schema versions of family-readable records. It needs no study, network or executor. Current versions are `manifest`, `study`, `ledgerEvent`, `experimentProtocol`, `executor`, `experimentAttempt`, `studyPlan`, `experimentSelection` and `investigateResult`, all version 1, carried by each record's `v` field.

Within a supported schema, readers preserve additive fields on study/attempt records and keep ledger events with unknown kinds. Appending to the ledger leaves prior lines intact; updating an attempt keeps unrecognized fields and stage entries. Unknown stage entries remain readable, including logs and totals, but budget-gated starts refuse with an upgrade instruction because this version cannot account for their resource use. A future schema version or unknown execution status/stage is refused with an upgrade instruction, leaving the original data unchanged. Unknown plan versions or node kinds are refused without changing plan.json. Command input remains strict so unknown options or protocol fields cannot silently change an experiment.

The private scope/card/candidate storage and evaluator metrics object are not family interchange schemas. Signed runner receipts, campaign contracts, console plugin manifests and vault notes are not implemented or advertised here. `ares setup` and versioned install roots remain A6 work under dotfiles#318.

## Environment

| Variable | Use |
| --- | --- |
| `OPENALEX_API_KEY` | OpenAlex key (without it, requests share a small daily budget per IP) |
| `S2_API_KEY` | Semantic Scholar key (without it, searches are often rate limited) |
| `ARES_CONTACT_EMAIL` | contact address added to the User-Agent |

Keys are sent with requests only; they are never written to the study.

## Not implemented yet

Automatic idea generation, parallel attempts, ablations, final/posthoc research logic, signed executor receipts, manuscript build, vault-mem reference notes (after vault-mem#73), agent-mem conventions, the console plugin, `ares setup`, scheduled searches, the `copilot` and `step` autonomy modes.

## Development

```sh
bun install --frozen-lockfile
bun run check   # typecheck, boundary check, tests (no network), package dry-run
```

Live executor acceptance is separate from the offline gate. From a checkout with the configured SSH executor, run `bun scripts/live-exp.ts --host dgx-h100-2`. It uses a CPU-only synthetic Git repository, checks commit-specific scores, evaluator isolation, oversized logs, read-only log retrieval and archive containment, and prints a bounded summary. It removes its labeled containers and leaves private artifacts for inspection. The recorded A2 live proof is in [PR #14](https://github.com/STAIxBWLB/agent-research/pull/14); it covers that dgx Docker configuration, not every host or the local backend.
