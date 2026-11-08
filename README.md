# agent-research (`ares`)

Research engine for the agent family ([agent-hub](https://github.com/STAIxBWLB/agent-hub), [agent-mem](https://github.com/STAIxBWLB/agent-mem), [vault-mem](https://github.com/STAIxBWLB/vault-mem), [agent-console](https://github.com/STAIxBWLB/agent-console)). The plan and phases are in [#1](https://github.com/STAIxBWLB/agent-research/issues/1).

This checkout implements A1 literature studies, A2 container experiments and the A3 plan DAG: an append-only ledger, approval gates, verified reference identifiers, frozen candidate snapshots, separate evaluator containers, attempt records and a resumable controller with read-only hub task references. Investigation selection, idea decisions, winner/no-winner results, declared ablations, reserved-seed final evaluation and exploratory posthoc results are available. Paper check/build and build-bound review gates render evidence-backed Markdown. A5 adds amem lesson reads/archive and a reviewed skill proposal queue. A6 adds local client setup, registered-study console panels and confirmed decisions, and finite literature watch passes. Per-phase autonomy (`auto`, `gates`, `copilot`, `step`) sets how far each phase runs before a recorded approval, and `study export` writes a content-free dataset bundle. Automatic idea generation/writing/reviewing remains later work.

## Install

<!-- facts:install -->
Requires Bun 1.4.2 or newer. Install from npm:

```sh
bun add -g @staix/agent-research
ares --help
```
<!-- /facts:install -->

0.1.0 was the first npm release. v0.2.0 was tagged but never published because its release smoke failed; 0.2.1 carries the fix without moving that tag.

Or run from a checkout:

```sh
bun install --frozen-lockfile
bun bin/ares.js --help
```

In the examples below, `ares` means the executable `bin/ares.js`; use `bun bin/ares.js` from the checkout when it is not on PATH. Register its MCP entry with an agent client using a write-free preview, then apply only the inspected plan:

```sh
ares setup all --json
ares setup all --apply --json
ares setup agy --apply --json
ares setup console --apply --json
```

Targets are `claude`, `codex`, `kimi`, `pi`, `qwen`, `jcode`, `agy`, `all` and `console`. `all` covers the six user-level agent clients; it excludes workspace-local `agy` and the separate console registration. Run `setup agy` from its workspace. Only the ares MCP server entry is edited; instruction blocks remain dotfiles-owned. The command is `bun --smol <root>/bin/ares.js mcp`.

Setup is dry-run by default and lists config, receipt and lock paths plus the entry it would change. `--apply` writes a private receipt under `$AGENTHUB_HOME/research/setup/` before changing the client file, is idempotent, and preserves unrelated settings. `--undo` restores the prior entry only while the installed entry is unchanged; user edits are refused and retained. Config/receipt links and foreign-owned mutable paths are refused. A per-config exclusive lock serializes writers; a stale lock requires checking that its owner is no longer active before manual cleanup.

`--root ABS` selects and pins an existing agent-research release root, including its `package.json` and `bin/ares.js`; relative roots are refused. For example, preview `ares setup codex --root /absolute/releases/0.1.0 --json`, then add `--apply`. Console registration writes the API-1 `{api, tool, module, sha256}` manifest at `$AGENTHUB_HOME/console/plugins/ares.json`, or `ares@<version>.json` with `--root`. The module is the absolute `<root>/src/ui/plugin.ts` path. Re-run setup after a package change; use the same versioned root when undoing its console registration. The console loader verifies the module hash and trusted package tree. Setup starts no client or console process.

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

## Literature watch workflow

A watch is a saved, bounded search pass for either a survey or an experiment study. It is not a resident watcher. Configure an initialized study with a scope first; in gates mode, approve its current scope before running:

```json
{
  "v": 1,
  "queries": [
    {"id": "recent", "query": "synthetic research topic", "source": "all", "yearFrom": 2020, "limit": 20}
  ],
  "rubric": "Display this context beside new candidates for the human screener."
}
```

```sh
ares lessons study --for "refresh the literature watch"
ares watch set study --file watch.json
ares watch run study --json
ares watch show study --json
```

There are at most 20 uniquely named queries, each at most 500 characters, with source `openalex|s2|arxiv|all`, optional yearFrom and limit 1..50. The rubric is at most 8,000 UTF-8 bytes and is display-only: ares never scores against it. `watch set` writes bounded `literature/watch.json` and `watch.set`; identical stored bytes are a no-op. Valid input can repair corrupt JSON and malformed version values, including string "1", null, a missing v or fractional 1.5; the refusal says to set v to 1. Only a safe integer v greater than 1 is an unsupported future version, which remains unchanged. Read failures name the file and set/restore recovery.

`watch run` holds one study lock for the full pass, reusing the existing scope gate and `lit search` merge path for each query. Other mutating commands for that study, including another watch start, are refused until it finishes. At the maximum, sequential HTTP deadlines can total 20 minutes (20 queries x 3 sources x 20 seconds), plus parsing and local file work. Queries do not run in parallel and ares starts no timer, daemon or recurring process. Each query records `lit.search`, then one `watch.ran` records counts, source errors as host/status only, the stored config byte hash, and up to 500 surviving new candidate ids plus their full total. The rubric stays in config rather than being copied to every run. Aggregate `added` retains the per-query search counts, even when a later merge absorbs an earlier new record. CLI `watch run` waits for completion; a run where every source fails is still recorded and exits 1.

MCP `ares_watch_run` is always detached: after validating config, scope and query years under the study lock, it returns `{started:true,configSha256}`. This acknowledges admission, not completion. The same MCP process runs the finite pass while remaining responsive to ping and tool listing; no separate background daemon is spawned. Use `ares_watch_show` to inspect the eventual `watch.ran` outcome, including `ok:false` if every source failed. A second start while the study is locked refuses; wait for the recorded outcome before starting another pass.

Watch never includes, excludes or verifies candidates, and never approves the screen gate. New records remain `new`; existing screening states survive merges. Inspect `watch show`, then screen and verify through the normal literature workflow. Show is read-only, with current config/rubric, the ten most recent runs, and a bounded list of still-new candidates. The `watch.run` plan step takes `{}` and returns `{added}`; an all-source failure fails the node.

## Scheduling watch passes

Recurrence belongs to the person. Ares does not register or enable a schedule. Choose one of these approaches and replace every absolute path, task class and peer with values for the intended project.

### Agent-hub schedule

Merge an entry into that project's machine-local `.agenthub/config.local.json` (not committed `config.json`):

```json
{
  "schedules": [
    {
      "id": "ares-watch",
      "every": "1h",
      "class": "implement",
      "title": "Run one saved literature watch",
      "owner": "codex",
      "queue": "ready",
      "detail": "Run one pass: /absolute/path/to/bun --smol /absolute/path/to/agent-research/bin/ares.js watch run /absolute/path/to/study --json. Inspect new candidates; do not screen automatically."
    }
  ]
}
```

Use an existing class and configured peer. Agent-hub requires intervals of at least 15 minutes; `every` accepts `<n>m`, `<n>h` or `<n>d`. This schedule proposes a board task for the peer, never executes the command itself. The peer must accept and perform the task through its normal workflow. A still-open task from the previous scheduled run prevents another proposal; held or missed periods do not replay as a burst. The person can inspect it with `ahub schedule list`. Only the person's local configuration enables this behavior.

### User cron

A user crontab can run one pass directly, without agent-hub. The absolute Bun executable and ares entrypoint avoid cron's restricted PATH:

```cron
0 * * * * /absolute/path/to/bun --smol /absolute/path/to/agent-research/bin/ares.js watch run /absolute/path/to/study --json >> /absolute/path/to/ares-watch.log 2>&1
```

Use the intended user's HOME/family configuration and required search environment, with the study scope already approved. This is a user crontab line, with no username column. Overlapping runs are refused by the study lock; cron does not bypass approval or screening. Neither recipe creates an ares resident watcher.

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

Executor hosts need `tar --no-xattrs` support (GNU tar >=1.27 or bsdtar). Unsupported implementations such as BusyBox tar fail with the generic "stage log collection failed" executor error; ares does not fall back to archives containing metadata.

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

Large or private inputs stay on the executor, staged by a person or an external setup script. Hash a directory with `ares executor inputs hash experiment /absolute/staged/input --json` (MCP `ares_executor_inputs_hash`); ares never downloads inputs or copies their contents into the study. Declare optional protocol `inputs`, for example `{ "weights": { "path": "/absolute/staged/weights", "sha256": "<manifest digest>", "mount": { "candidate": "/in/weights", "evaluator": "/in/weights" } } }`. At most 8 names use `[a-z0-9_-]{1,32}`; `__proto__`, `prototype` and `constructor` are reserved. Mount targets are normalized, disjoint paths under `/in/`, always read-only; evaluator-only inputs are absent from the candidate. Sources must stay separate from the attempt workspace, and overlapping sources cannot cross stage privacy boundaries.

With inputs, `executor check` requires and reports Python3 on that host; no-input protocols require no Python. The manifest is SHA-256 over UTF-8 byte-sorted compact JSON lines `[relativePath,size,sha256]`, each terminated by a newline. Only regular files/directories are read, without symlinks or special files. The input path and every ancestor directory must be symlink-free; on macOS use canonical `/private/tmp/...` rather than the `/tmp/...` symlink. Hashing streams in 1 MiB chunks, with ceilings of 100,000 files, 100,000 directories, 200,000 total entries, depth 64, 4,096 UTF-8 bytes per relative path and 5 minutes per input; only the bounded digest/count/byte summary crosses the transport. GB-sized files are not subject to the task or output byte cap. Keep staged inputs stable: read-only container mounts do not prevent an independent host writer changing them after verification.

Before admission and when preparing a stage launch, ares verifies input manifests outside the launch claim/control transaction and refuses mismatches naming the input. Inside the short launch claim it rechecks that current input identities still match the frozen attempt before starting the container. The design seal and protocol identity bind names, hashes and mounts, so locator-only edits preserve approval; content-hash or mount edits require design approval again. Attempts freeze path-free descriptors plus `verifiedInputs`; stage receipts contain mount targets only. Reconciliation resolves locators from the current design only when its input identities match the frozen attempt, otherwise it names the restore step. Input inspection checks stage targets, read-only flags and source isolation rather than requiring the current locator to equal an already-running mount. An evaluator blocked before launch by input verification stays pending; after restoring the input, reconcile re-verifies and launches that stage instead of marking it lost. There is no locator store. Study bundles export input names and verified hashes only. Protocols without inputs retain their existing hashes, raw-byte design bindings and execution behavior; earlier readers refuse the optional inputs field rather than silently accepting it. Network remains none, and candidate outputs remain limited to 500 files / 256 MiB (pass adapters rather than full model weights).


Only the evaluator's `/result/metrics.json` supplies metrics: at most 64 KiB, exactly the declared names with finite numeric values, for example `{"score": 7}`. Units and directions come from the protocol. Missing, malformed or undeclared metrics fail at the evaluator stage; candidate-printed scores never become metrics.

Without `--detach`, `attempt run` reconciles until finished. Detached runs and MCP `ares_attempt_run` return while running; call `attempt reconcile` again to advance stages and collect results. States progress from running candidate to running evaluator, then succeeded, failed, cancelled or unknown. A gone container without an exit record becomes unknown (`lost`); reconcile never creates a new attempt. One attempt may be active per study. A host watchdog enforces each stage's wall-clock limit.

The same protocol hash, commit/tree, seed and run return the same attempt. Use `--retry <id>` for a linked new attempt; a different commit or seed is a new attempt, not a reproduction. Every status counts toward study budgets (attempt count, wall hours, GPU hours). `attempt list` returns summaries and whole-study totals for every status regardless of filters or page; default page size 50, maximum 200, with `--offset` for later pages. `attempt show` returns the full record.

Raw outputs and logs stay in the private executor attempt directory. The study holds output paths, sha256 and byte counts (regular files only, at most 500 files and 256 MiB total), plus each log stream's path, hash, bytes and truncation flag. Each stdout/stderr copy is capped at 16 MiB; excess log volume does not fail an attempt. `attempt logs` checks the recorded copies and prints tails without changing the study; `--tail` accepts 0..65536 bytes (default 16384), and omitted stage/stream filters return all recorded streams. No log content is persisted in the study.


On a shared Linux NVIDIA executor, admission can be enabled explicitly:

```sh
ares executor set experiment --kind ssh --host ALIAS --workdir /private/owned/path --gpu-devices 0,1 --gpu-min-free-memory-mb 8192 --gpu-max-load-ratio 0.8
```

The equivalent MCP `ares_executor_set` setting is `gpu: { devices: [0, 1], minFreeMemoryMb: 8192, maxLoadRatio: 0.8 }`. All three fields are required together; omitting GPU settings preserves the existing behavior. The allow list has 1..64 device indexes or full `GPU-...` UUIDs. Memory is a per-device minimum in MB, and load ratio is the one-minute host load average divided by CPU count. Configuration itself performs no probe.

For a new attempt with GPUs and admission settings, ares makes one bounded read-only transport call to `nvidia-smi`, `/proc/loadavg` and `getconf _NPROCESSORS_ONLN`. It picks the first eligible devices in allow-list order, deduplicating index/UUID aliases for the same device. Not enough free devices, excessive load, or missing/malformed telemetry returns `{status:"deferred",reason:"devices"|"load"|"probe",message,exitCode:75}`. The CLI exits 75 and MCP returns the same object. No attempt, approval event or budget is recorded, and no container starts. Ares never queues, waits for admission, automatically retries or preempts other jobs; invoke the command again explicitly when conditions improve. A plan step records a known failed node with the same guidance and requires explicit recovery, without creating an Attempt or automatically probing again.

Chosen UUIDs are frozen in `gpuDevices` and reused for both stages with explicit Docker device selection; inspection checks those UUIDs. Study bundles retain `gpuDeviceCount` only. Duplicate requests for an existing attempt do not probe again. Admission is a point-in-time check, not a resource reservation: host pressure can change after it. GPU settings affect new attempts only; without settings, GPU argv remains the existing `--gpus <n>` path. CPU-only attempts do not probe, even when the executor has GPU settings. Missing telemetry is never treated as an idle host. Tests use fake transport responses; no live GPU admission or training run is claimed.

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

Pivot optionally records `--cause` and `--retry-when` (at most 2,000 UTF-8 bytes each); refine refuses these fields. Missing pivot fields export as `not recorded`. Refine adds the uniquely owned commit. Pivot refuses `--commit`, closes further decisions and keeps historical attempts and totals. Evidence is at most 200 existing, non-running, same-study attempt ids from the idea's commits; reasons are at most 2,000 bytes. An untested idea may omit `commit` when added, then omit `--attempts` for a first `refine --commit` or a pivot before testing. Once it has commits, nonempty evidence is required. Investigation rows and winner references carry the owning idea id; journal changes join the result's input hash. Survey studies refuse all selection, idea and investigate commands.

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

## Ablation, final and posthoc workflow

Before collecting results, reserve unseen seeds with `ares final seeds experiment --file final-seeds.json`, where the input is `{"v":1,"seeds":[3,4]}` and all seeds are declared in the protocol. Reserve at least one and at most half of the protocol seeds. New or changed reservations refuse seeds used by any existing attempt, across all runs and statuses; identical bytes are a no-op. The file joins the design seal, so approve design again after a change. Protocol edits cannot drop reserved seeds or leave more than half reserved. Only run `final` may use them; investigate and ablate report reserved samples as excluded. Selection run names `ablate`, `final` and `posthoc` are reserved phase names and refused.

After `investigate close` has a current winner, declare each ablation with `ares ablate add experiment --file ablation.json`: `{"id":"without-component","commit":"<full-40-hex-SHA>","removes":"Component removed"}`. Ids and commits are unique, up to 200 declarations; `removes` is at most 2,000 bytes. The winner and baseline cannot be ablation commits. Run each declared commit and the winner replication using non-reserved seeds and `--run ablate`, then reconcile them. `ares ablate show experiment` pairs each declaration against the winner's own ablate-run successes on shared seeds, using the current protocol and earliest success after the selection cutoff. It never reuses investigate samples. Every declaration appears even without data, with all statuses/exclusions and no ranking. `ares ablate close experiment` requires a current closed investigate winner and no running ablate attempts; it writes timestamp-free `runs/ablate/ablate.json` and `ablate.closed`. Unchanged inputs record nothing.

Approve the global final gate after investigation and, if ablations were declared, ablation closure:

```sh
ares gate approve experiment final
# Repeat for every reserved seed and both the winner and baseline frozen commits:
ares attempt run experiment --repo /absolute/repo --commit <winner-or-baseline-SHA> --seed 3 --run final --detach
ares attempt reconcile experiment
ares final close experiment
```

The final gate binds SHA-256 of the investigate result sha, the ablate result sha or none, and the design binding. Approval requires current closed upstream results. Changed content reopens it; re-close changed upstream inputs and re-approve before final close. Start checks require a reserved seed, the current winner or selection baseline, and final-gate authorization before any Git resolution, record or container. In auto autonomy, final approval is recorded only with a verified candidate start, so failed preparation records no automatic approval.

Final is one shot: the first ledger-started attempt for each winner/baseline commit and reserved seed is decisive, whatever its status. Retries stay visible and never replace it. Close refuses running final attempts or missing decisive pairs. It requires the final gate currently approved even for a negative result. Every decisive attempt must succeed and the direction-adjusted paired delta must be positive and at least `minDelta`; otherwise the result is `not_qualified` with a named reason. There is no significance test. Reapproval keeps existing data fixed; old seal/input bindings alone never disqualify it. A changed comparable evaluation identity gives `protocol-changed`; input locator-only and budget-only edits do not change that identity. A winner change after any final attempt, including baseline-only trials, gives `winner-changed` without demanding new-winner pairs and blocks new final starts. Reason priority is winner change, protocol change, first decisive failure status, then below-margin. `runs/final/final.json` and `final.closed` are committed together; unchanged inputs record nothing, unsupported versions are preserved.

After a historical `final.closed` receipt exists, run additional non-reserved seeds/commits with `--run posthoc`. `ares posthoc show experiment` lists all posthoc statuses and metrics labeled `exploratory`. Posthoc work never changes final result bytes, the final input fingerprint or its close receipt, even while an exploratory attempt runs. These are experiment-only commands; survey studies refuse them on CLI and MCP.

A conductor can use no-argument `ablate.close` and `final.close` steps. Outputs are `{sha256,status}`, with the hash of the committed result bytes and status `closed` for ablate, or `qualified`/`not_qualified` for final. Both final outcomes complete the step normally. A downstream plan gate binds these references; the global `final` gate remains a separate prerequisite for final attempts and closure. Put attempt-completion dependencies before each close and approve the global final gate after ablate closure.

Final here means reserved seeds, the frozen Git snapshot and the sealed evaluator. Held-out evaluator data outside the study repository is deferred; data already in `task/` is not hidden from agents. Acceptance uses offline synthetic fixtures; no live hub campaign or live executor DAG coverage is claimed.

## Paper and review workflow

A4 renders Markdown from recorded evidence; it does not write a manuscript or run reviewers for you. Write `paper/manuscript.md` (at most 2 MiB) and put measured values in `{{n:REF}}` placeholders, optionally `{{n:REF|.Nf}}` with N from 0 to 6. At most 5,000 numeric and literal placeholders are allowed together. Use `{{lit:TEXT}}` for a reviewer-visible literal such as a year or cohort label. Every literal is listed by the check; it is an explicit exception, not a measured-value match.

| Ref | Closed source |
| --- | --- |
| `final.status`, `final.reason`, `final.delta`, `final.mean`, `final.baselineMean`, `final.attempts.<status>` | current final result and all-final-attempt status counts |
| `investigate.winner`, `investigate.reason`, `investigate.winner.delta`, `investigate.winner.mean`, `investigate.baseline.mean`, `investigate.totals.<status>` | current closed investigate result |
| `ablate:<id>.delta`, `ablate:<id>.mean`, `ablate:<id>.referenceMean`, `ablate.totals.<status>` | current closed ablate result |
| `attempt:<id>.<metric>`, `posthoc:<id>.<metric>` | succeeded current-protocol attempt with a finite ares-observed metric; posthoc always appends ` (exploratory)` |

Status counts use `running`, `succeeded`, `failed`, `cancelled` or `unknown`. Text refs take no numeric format; an investigate winner renders as its 12-hex commit prefix. Missing, null, unclosed, stale or unsupported sources give `unresolved-ref`. Final refs also need the final gate currently approved. Metric names are exact declared names, including spaces and punctuation such as `accuracy (%)`; names containing `|` or `}` are unreferenceable in this grammar and need a new protocol/name. The ordinary `attempt:` prefix refuses posthoc records, and `posthoc:` refuses other runs.

```sh
ares paper check experiment --json
ares paper build experiment --json
```

In experiment prose, other digits give `bare-number`; matching a free number against an existing metric is never allowed. Digits are allowed in link targets, placeholder/literal payloads and line-start ordered-list markers. Citation keys may contain digits, but bracket prose is checked: only locator terms (`p.`, `pp.`, `sec.`, `§`, `ch.`, `chap.`, `fig.`, `tbl.`, `table`, `eq.`, `l.`, `ll.`, `para.`) followed by integers, ranges or lists are exempt. `[@key, improved accuracy by 12.5%]` still fails. Inline/fenced/indented code numbers are nonblocking but listed as `codeNumbers` (first 500 values with line/column) and `codeNumberCount` (total). Paragraph and list continuations are prose. Unknown or unverified citation keys fail, including citations inside literal escapes; verification means identifier existence plus title/year match, never support for a claim.

Negative results must be visible: when final.json exists, include `{{n:final.status}}`; when the closed investigation has no winner, include `{{n:investigate.reason}}`. Code examples, link targets, HTML comments and reference-definition metadata cannot satisfy this rule. Include a reason or numeric ref only when that source field exists; null values stay unresolved. The check is read-only and reports positions for every finding; a failing CLI check exits 1. Survey studies check citations without the experiment bare-number rule and refuse experiment placeholders with `unresolved-ref`; they can build citation-only manuscripts.

Build refuses every finding before writes. It commits `paper/build/manuscript.md` (rendered values), `paper/build/evidence.json` (`paperEvidence: 1`) and `paper.built` together. The evidence map keeps the input manuscript hash and each active placeholder's syntax, value, rendering, position, source file and raw source hash; literal sources point to the input manuscript. Outputs are bounded to 2 MiB rendered Markdown and 8 MiB evidence. Identical outputs with a matching receipt are a no-op. Changed provenance rebuilds evidence even if rendered text is identical; unknown evidence versions preserve original bytes. The returned `manuscriptSha256` is the rendered output hash; `evidenceSha256` is the review's build identity.

Have reviewers inspect the current output, evidence, literals and code-number list. Save each report and add it against the current evidence hash:

```json
{
  "v": 1,
  "reviewer": {"id": "reviewer-a", "modelFamily": "family-a"},
  "buildSha256": "<current-evidenceSha256>",
  "checklist": {"negativeResults": true, "denominators": true, "limitations": true, "reproducibility": true},
  "findings": []
}
```

```sh
ares review add experiment --file review-a.json
# Add a report from a second, distinct model family with the same current evidence hash.
ares review add experiment --file review-b.json
ares review show experiment --json
# For an existing finding, using the review id returned by add:
ares review resolve experiment <review-id>/<finding-id> --reason "How the issue was resolved"
ares gate approve experiment review
```

A finding is `{id,kind,location,text,blocking}`; kinds are `contradiction`, `unsupported-claim`, `number`, `citation`, `method`, `clarity`, `other`. Contradictions are always blocking, even if submitted as false. A reasoned resolution records its actor; clean votes never resolve another review's finding. Reports use self-reported family labels, normalized for whitespace at the ends and case; ares neither launches nor attests to the reviewers. Limits: 100 reports per build, 200 findings per report, 4,000-byte texts/reasons, 128-byte reviewer/family/finding identifiers. The existing ledger event ceiling also limits a combined report to 60 KiB; shorten a report rather than raising the ledger bound.

The global `review` gate needs a clean current check/build, at least two distinct model families for that evidence hash, and no open blocking finding. Checklist answers are shown, including false answers, rather than adding a separate approval condition. Readiness names every unmet condition. Approval is checked in the shared command under the study lock; reject still needs a reason but no readiness. No current command auto-requires the review gate. The gate binds both output hashes and sorted added/resolved event hashes for that build. A changed build, added review or resolution reopens it; old reviews stay in the ledger but do not count toward a new build.

A no-argument `paper.build` conductor step emits `{sha256}` of the committed evidence file; a downstream `plan:<id>` gate binds it. That local gate does not replace the global manuscript `review` gate. MCP paper/review operations never start the controller loop. Claim-to-passage evidence and its contradictions await [agent-hub#931](https://github.com/STAIxBWLB/agent-hub/issues/931); readiness currently reports `claims: unavailable (STAIxBWLB/agent-hub#931)` without blocking on it. Claim verdicts stay outside ares. LaTeX/PDF container builds and venue templates are out of scope. Acceptance uses offline synthetic fixtures, not live hub/executor DAG proof.

## Memory and skill proposal workflow

Lessons and archive call the `amem` CLI on PATH (`search --json --explain`, `brief --json`, `note add - --json`). Its output parser was written against amem 0.20.3; the tests use a fake runner, so no amem version is tested live here. Start each phase with an intent-specific lesson read, then archive only at the end of the study:

```sh
ares lessons study --for "compare candidate hypotheses" --half-life 180 --limit 50 --json
ares skill propose study --file proposal.json
ares skill list study --json
ares skill decide study reusable-procedure accept --reason "Reviewed against recorded evidence" --pr https://github.com/example/project/pull/1
ares archive study --json
ares archive study --confirm <fingerprint> --json
```

`lessons` searches with `--for` text, otherwise with the study question, in the study's amem project. An intent also adds a typed `amem brief`. It reports age in fractional days (future timestamps clamp to zero), T1 relevance with amem recency removed, half-life-decayed score and 1-based rank. The formula is `score = relevance * 0.5^(age / halfLife)`; ties put fail notes first, then lexical id. Half-life defaults to 180 days, bounded to 1..3650; result limit defaults to 50, bounded to 1..50. The command is read-only and takes no study lock.

Archive derives fail notes from pivot decisions, findings from current closed investigation/final results and resolved review contradictions, and decisions from selection/final seeds. Fail fields use recorded cause/retryWhen or `not recorded`; outcomes retain negative reasons. Open contradictions stay out. Each note starts with study id/question; evidence uses study-scoped attempt/run refs, split into consecutive notes of at most 16 refs so none are dropped. Preview writes nothing. Its fingerprint binds the full canonical note list and stays valid across receipts. Confirmation writes at most the first 200 pending notes in stable order, reports `remaining`, and records returned ids/content hashes in one `archive.exported` event. Repeat the same confirmation for later batches; already-exported hashes are skipped. Partial failures commit successful receipts and explain how to continue. Changed source notes invalidate confirmation. Receipt capacity is checked before any outward write, and confirmed calls hold the study lock. Errors never include amem stdout/stderr. Note text travels on stdin, and `--`-leading option values get one leading space for the amem parser. Agent markers and home/config context are allowlisted; API credentials stay stripped.

A proposal input is `{name, summary, steps, evidence}`: a run-name `name`, nonblank summary, at least one step, and 1..64 evidence refs (32-hex amem ids or `ares:<study-id>/...`). Unknown fields are refused. Deterministic Markdown at `proposals/skills/<name>.md` is bounded to 16 KiB and bound to its `skill.proposed` hash receipt. At most 100 proposals, including terminal states, are retained. List verifies bounded file bytes against receipts and shows proposed/accepted/rejected/withdrawn. Accept requires an HTTP(S) PR URL without credentials; ares records the actor's reference without opening, checking or merging the PR. Every terminal state is final; withdraw is allowed only while proposed. Durable vault promotion remains amem's `vault-candidates` pipeline; ares never writes the vault.

Survey and experiment studies both support lessons, archive and all skill commands. Survey archives can export resolved review contradictions, and are empty when no eligible lessons exist. Selection, ideas and experiment-result operations remain experiment-only. All A5 acceptance tests use synthetic records and fake runners; no live amem or vault interoperability is claimed.

## Console workflow

Register only studies the console should read; ares never scans the disk:

```sh
ares console add /absolute/path/to/study
ares console list --json
ares setup console --json
ares setup console --apply --json
# To remove only the registration, including one whose study moved:
ares console remove /absolute/path/to/study
```

The bounded version-1 registry is `$AGENTHUB_HOME/research/studies.json` (at most 200 absolute/canonical study directories, private 0600 file in a 0700 directory). Add requires a readable study; add/remove are idempotent. A moved or unreadable study remains registered and appears as `unavailable`, with its restore reason. Remove can use its listed path without reopening the study.

The API-1 plugin supplies `studies`, `study`, `lineage` and `compare` panels, plus inbox items for pending gates, still-new recorded watch candidates with the current display rubric, proposed skills, open review findings, failed/unknown attempts and unavailable studies. A truncated watch receipt produces an event-timed overflow notice rather than guessing provenance for unrecorded ids. Partially unreadable records produce an alert instead of false zero counts; empty stores and unfinished optional phases are normal. The study view links only the fresh built manuscript (at most 2 MiB) as `text/plain`; ares generates no PDF or figures. Reads stay in process, with no search, container or plan-control subprocess.

The study detail's Lineage and Compare buttons open local read-only views. Lineage rows preserve typed native ids, revisions and hashes; relationship rows show their source proof. Current, historical, corrupt, missing and not-read states stay explicit. Continue with Next lineage page, or restart when the source snapshot changes; capped graphs remain partial. Graph pagination uses its own opaque cursor, separate from the console polling cursor. Compare accepts one to eight attempt ids or full candidate commits, keeps failed/unknown attempts and retry ancestry visible, and shows original metrics, units, code/protocol hashes, artifact digests, recorded wall milliseconds and output bytes. Unmeasured cost dimensions remain unknown. Aggregation is unavailable and never performed; the panels create no winner, result receipt, gate decision or recovery action. Existing closed investigation and fresh final results remain the authorities.

Every console write first returns a write-free preview and fingerprint. Confirmation recomputes the selected study and bound content under the existing command lock and refuses drift. The wire ids are `gate.approve`, `gate.reject`, `screen.include`, `screen.exclude`, `skill.accept`, `skill.reject`, `skill.withdraw` and `archive.confirm`. The id selects the decision; there is no separate page-supplied decision field. Rejections and screening/skill decisions require reasons; skill acceptance also requires the reviewed HTTP(S) PR URL. The ledger actor is the person, with verified `meta.identity` when the console supplies it; page actor/meta fields and other unsupported action fields are refused. A read-only console (`acon serve --read-only`) refuses actions before invoking the plugin.

Console archive writes to amem only after confirmation and has a 25-second total child-process budget inside the console's 30-second provider ceiling. Returned note ids are receipted on partial failure; refresh and review a new console preview to continue, or inspect `ares archive` from the CLI. The final study step remains archive, after paper/review and skill decisions. No live amem/vault or deployed-console interoperability is claimed by the offline fixture tests.

## Plan and conductor workflow

A plan connects existing commands, approval gates and read-only hub task references. It can close investigate, ablate and final results and bind their output references to downstream gates. Create a study first. This offline example checks two drafts, with an approval between them: put citation-free text in `plan-study/draft.md` and `plan-study/final.md`, and save this definition as `draft-plan.json`:

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

Plan definitions accept at most 128 nodes, 512 explicit edges and 128-byte ids, with no cycles or missing dependency endpoints. `needs` and `edges` both supply dependencies; a gate's `binds` may name only upstream nodes. A step command is one of `lit.search`, `lit.verify`, `lit.bib`, `cite.check`, `attempt.run`, `investigate.close`, `ablate.close`, `final.close`, `paper.build`, `watch.run`. Close/build and `watch.run` steps take no args. `watch.run` uses the saved watch synchronously and emits the completed `{added}` count; every-source failure records the run and fails the node. Named `args` carry CLI options without `--`, including `year-from`; positional inputs are `query` for search, optional `ids` for verify, and `draft` for cite check. `attempt.run` needs `repo` and `commit`, always detaches, and accepts the existing seed/run/label/retry options. Steps refuse controller-owned `json` and `detach` arguments. Relative `repo` and `draft` resolve against the study directory. Scope, screen and design prerequisites still apply to the underlying commands.

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

## Execution lineage

Read local execution references and their recorded relationships with `ares lineage show <dir> --json`. Focus the read with `--root KIND --id ID`; optional `--revision REV` and `--sha256 HASH` preserve the exact source address. The CLI supplies the current study's project key. `--cursor CURSOR` continues the same source snapshot; restart from the first page after source bytes change. Pages contain at most 100 nodes, 200 edges and 256 KiB, with explicit unavailable, changed or capped results instead of a claim of complete provenance.

`ares lineage compare <dir> --attempts ID,... --json` selects up to eight existing attempts. Alternatively, `--candidates COMMIT,...` selects up to eight full commits from the closed investigation. The flags are mutually exclusive. Rows retain failed and unknown outcomes, retry relationships, original metrics and source hashes. Retries are not independent samples. The result exposes `aggregation.compatible` and its reasons, with `aggregation.available: false` even for compatible rows. Comparison performs no new arithmetic aggregation and supplies no new winner or verdict; current closed investigation, selection and fresh final results remain the authorities.

MCP exposes the same reads as `ares_lineage_show({study, root?, cursor?})` and `ares_lineage_compare({study, attempts?, candidates?})`. An MCP root is a local `ExecutionReferenceV1` with `v: 1`, `tool: "ares"`, `projectKey`, `kind`, native `id`, and optional `revision`/`sha256`. Both tools are read-only and closed-world. Reads do not acquire study locks, repair files, read executor output bodies, contact a hub or executor, or start network requests. Source receipts can remain historical or unavailable; an artifact digest is not proof that its bytes are retained. Synthetic fixture checks establish surface parity only, with no measured diagnosis or usability benefit claimed.

## Study export

```sh
ares study export study --bundle /absolute/path/to/new-bundle --list --json
ares study export study --bundle /absolute/path/to/new-bundle --json
```

`study export` writes a dataset bundle from committed study files only; it never reads the executor workdir or logs. The target must be a new or empty directory outside the study (symlinks are resolved first); `--list` names the six files and writes nothing. Reads take the study lock once; files are written after it is released.

| File | Content |
| --- | --- |
| `manifest.json` | `bundle: 1`, format versions, hashed study id, protocol hash, seal binding, ledger time window, counts by status and run, and each file's sha256 |
| `ledger.jsonl` | event envelopes with hashed actor ids; `data` keeps only per-event-type allowlisted closed fields |
| `attempts.jsonl` | one row per attempt: identity hashes, seed, `labelSha256`, status, stage, reason class, per-stage exit code, duration, network, limits and image digest, metrics with provenance, output hashes and sealing booleans |
| `results.json` | receipt-verified closed investigate, ablate and final results reduced to numbers, booleans, hashes, closed tokens and metric identifiers |
| `reviews.jsonl` | reviewer model family, build hash, finding kinds and counts, blocking count and resolutions |
| `evidence.json` | placeholder ref hashes, families, attempt bindings and source hashes |

Paths, mounts, container ids, argv, env, image names (digests are kept), free text and malformed identity fields are dropped. Metric names/units and the selection metric stay because the dataset needs them to read values. Every key and string value is then scanned; an absolute POSIX/Windows/UNC path, URL, `NAME=value` assignment or key-like token refuses the whole export, and nothing is written. Each file is bound-checked in memory first.

## What sealed means

The `design` gate binds the sorted `task/` file tree hashes and optional raw selection/final-seed file hashes. For protocols without `inputs`, the original exact protocol bytes remain sealed. With `inputs`, it binds the canonical path-free protocol identity, including input names, content hashes and stage mounts. Editing sealed identity reopens approval; relocating the same input identity does not. A budget-only change still reopens the gate, while the comparable attempt protocol hash excludes budget and input locators. The executor configuration is outside the seal; the attempt records the executor it used.

Sealing and metrics are **ares-observed**: ares builds the argv and checks the observed container configuration. They are never **host-observed** or **runner-attested**. agent-hub 0.26.0 added signed receipts from a registered external runner for hub research attempts ([agent-hub#1018](https://github.com/STAIxBWLB/agent-hub/issues/1018)), so far covered by source and test-key fixtures only. Ares does not read or bind those receipts; that integration and a live registered runner are still needed before an ares attempt can be runner-attested. This seal neither attests to an untrusted host nor establishes support for a research claim.

## What the checks mean

- **verified**: the DOI exists at Crossref or DataCite, or the arXiv id exists at arXiv, and the registry's title and year match the candidate. It never means a paper supports a claim.
- **unknown**: the registry could not be reached or answered incompletely (network failure, rate limit, server error, error or truncated feed). Run `ares lit verify` again; unknown is never treated as missing.
- When a record shows that two candidates are the same work, an unscreened one is folded in; otherwise both are flagged `duplicates`, and `ares lit bib` refuses while both are included.
- Only included and verified papers enter `references.bib`. Citekeys never change once assigned.

## Gates

`scope` binds to the content of `scope.json`; `screen` binds to the set of included papers; `design` binds the experiment protocol and task tree, plus selection/final-seeds files when present; `final` binds closed upstream results and design; `review` binds the current rendered/evidence hashes and current-build review/resolution event hashes; `plan:<node-id>` binds a plan gate to all upstream observed output references. Changing bound content returns its gate to pending. With `--autonomy auto` a pending gate is approved as `auto` when a command needs it; with `gates` (default) someone must run `ares gate approve`. The ledger records who approved: a person, an agent (detected from the agent environment) or `auto`. Which of them may approve is the workspace's policy, not the tool's. For experiments, automatic design and final approval is committed with a verified candidate start; a failed preparation records no approval. The review gate is approved explicitly after its readiness conditions pass; no current command auto-requires it.

### Autonomy policy

`ares autonomy show <dir> --json` reads the stored policy and effective mode for every phase. `ares autonomy set <dir> <auto|gates|copilot|step> [--phase PHASE]` changes the default or one override in a single study/ledger commit. The event records the actor, the complete `from` and `to` policies, and `phase` (null for a default change). A default change retains existing overrides. Earlier gate approvals and rejections are kept; policy changes do not re-decide them.

```sh
ares autonomy set study gates
ares autonomy set study auto --phase literature
ares autonomy show study --json
```

Phases are `scope`, `literature`, `hypotheses`, `design`, `investigate`, `ablate`, `final`, `posthoc`, `write`, `review` and `archive`. Only `auto` approves pending gates automatically; `gates`, `copilot` and `step` require recorded approval. Step execution and copilot draft acceptance are described below. Approval authority remains workspace policy, with no person-only restriction.

| Gate | Phase |
| --- | --- |
| `scope` | `scope` |
| `screen` | `literature` |
| `design` | `design` |
| `final` | `final` |
| `review` | `review` |
| `accept:hypotheses` | `hypotheses` |
| `accept:paper` | `write` |
| `accept:reviews` | `review` |
| `plan:<id>` | The declared phase shared by every guarded immediate downstream node; otherwise the study default |

Plan nodes may declare `phase` from the same list. Dependencies through `needs` and explicit edges both identify guarded downstream nodes. Mixed phases, any undeclared target, no targets or a hub target use the study default; a gate's own `phase` is not a substitute, and command/run names are not inferred. Phase edits participate in node staleness; changing policy does not invalidate already-approved gates. The controller reloads policy inside each approval transaction.

With an effective `step` policy, the CLI controller keeps step work exclusive even with `--parallel` greater than 1. For effect nodes (step and hub), every terminal outcome (`done`, `failed`, `cancelled`, `uncertain`, including reconciliation) and its `plan.paused` receipt (`reason: step`) are committed together when work remains. Gate approvals do not consume a step. When no work remains, the plan finishes `done` or `failed` without a pause or acknowledgement resume; a failed terminal plan makes `ares run` exit nonzero. `ares plan show` exposes `pauseReason: step`; that pause survives controller restart, and unchanged observation polls do not append receipts. Detached attempt admission is not completion: the pause follows the observed terminal result. Gates in a step phase still require approval, with no automatic grant.

Use `ares plan control <dir> resume --command-id <new-id> --expected-revision <revision>` to continue. A resume through CLI or MCP changes the same durable plan state; MCP does not start a controller. The controller must already be running via `ares run` to admit work. Mode and phase are read again inside admission and completion transactions, so pending work follows the current recorded policy. Manual-only pending gate polls do not take a study lock.

Legacy `auto|gates` string studies retain study v1 and their existing JSON layout. Object policies (`{default, phases}`), `copilot` and `step` require study v2. Once a study is v2, later policy changes never downgrade it. This reader supports v1 and v2; the published 0.1.0 reader rejects v2 with its unsupported-version guidance and leaves the file untouched. Plan `phase` is an optional v1 field: phase-free plans keep their previous shape, while the older strict 0.1.0 plan reader rejects a declared phase without changing the file.

### Copilot draft acceptance

A copilot phase produces drafts until an ordinary `accept:<artifact>` gate approves their current content hash. There are three aggregate artifacts; the guard is enabled by the **producing** phase's mode, not the consuming phase. `auto`, `gates` and `step` do not enable these guards. New studies still default to `gates`, with no implicit copilot override or automatic drafting.

| Artifact gate and phase | Producer and content | Guarded consumers |
| --- | --- | --- |
| `accept:hypotheses`, `hypotheses` | Optional `hypotheses.md` plus the complete `idea.added`/`idea.decided` journal, produced by source edits and `idea add`/`idea decide` | `protocol`, attempt admission (all runs and plan preparation), `investigate close`, the closed-investigation reader used by ablate/final trusted-source paths, `paper build`, archive preview/export |
| `accept:paper`, `write` | Manuscript source files under `paper/`, including notes/assets; `paper/build/` is derived and excluded | `review add`, `review resolve`, review readiness/approval, archive preview/export |
| `accept:reviews`, `review` | Complete `review.added`/`review.resolved` journal across all builds, produced by `review add`/`review resolve` | Review readiness/approval, archive preview/export |

Source edits or new relevant journal records make the prior accept stale (the gate becomes pending for its new hash). Gate decisions and unrelated ledger entries are excluded from artifact hashes, so approval never invalidates itself. Rebuilding or repairing `paper/build/` does not stale `accept:paper`; existing fresh-build, citation, number and review-readiness checks still apply. Acceptance is a workflow checkpoint, not scientific verification or a way to clear blocking findings.

```sh
ares autonomy set study copilot --phase write
# Author or edit paper/manuscript.md and any source assets.
ares paper check study
ares paper build study
ares gate list study
ares gate approve study accept:paper
```

In-phase editing and own-draft diagnostics remain usable before acceptance: idea edits/list, paper check/build and review edits/show do not require accepting the artifact they produce. A build still consumes accepted hypotheses when that producing phase is copilot; review edits consume accepted paper source. Diagnostics that cannot use an unaccepted trusted source report the required gate and approval command. Plan adapters preserve the same refusal guidance and do not prepare an attempt backend before hypotheses acceptance.

Approvals use the existing CLI/MCP gate handler, record the actor and bind the current hash. No agent/person exemption or person-only restriction is added, and accepts are never implicit auto approvals. Source reads are bounded: hypotheses Markdown at most 2 MiB; paper source at most 500 regular files, 64 MiB total, 1000 directories and 64 levels. Source links and special files are refused. Existing study-v2 copilot policy and version-1 gate/ledger records carry the feature; no new draft store or interchange format is introduced.

## Study files

| File | Content |
| --- | --- |
| `study.json` | question, mode, autonomy |
| `ledger.jsonl` | append-only events with actor and time, including plan state/dispatch/control receipts |
| `plan.json` | validated versioned plan definition and revision |
| `.ares.plan.lock` | controller pid, host, process start identity and ownership token |
| `scope.json` | the scope |
| `literature/watch.json` | bounded saved queries and display-only rubric |
| `literature/candidates.json` | merged candidates, screening and verification |
| `literature/cards/*.json` | extraction cards |
| `refs/references.bib` | generated bibliography |
| `task/task.md`, `task/evaluator/`, optional `task/rubric.md` | experiment task and evaluator files, written directly |
| `design/protocol.json` | validated experiment protocol |
| `design/selection.json` | sealed investigation rule, when set |
| `design/final.json` | sealed unused reserved seeds |
| `runs/ablate/ablate.json` | declaration rows paired with winner replication, without ranking |
| `runs/final/final.json` | one-shot qualification, decisive attempts and all final attempts |
| `runs/<run>/investigate.json` | deterministic winner/no-winner result, candidate rows and totals |
| `paper/manuscript.md` | source Markdown with numeric refs and literal escapes |
| `paper/build/manuscript.md` | rendered manuscript |
| `paper/build/evidence.json` | versioned placeholder values, source paths/hashes and input manuscript hash |
| `proposals/skills/<name>.md` | bounded versioned skill proposal, hash-bound to its ledger receipt |
| `executor.json` | executor kind, optional SSH alias and required workdir |
| `runs/<run>/attempts/<id>.json` | attempt identity, stage receipts, status, metrics and artifact/log metadata |

Experiment logs and outputs live on the executor at `<workdir>/<study-id>/<attempt-id>/`, not in the study. Existing A1 survey studies remain readable without migration. Family-local setup receipts and the study registry live under `$AGENTHUB_HOME/research/`; they are not copied into each study.

## Commands

The implemented CLI surface below comes from `src/commands-table.ts`; `ares --help` prints current usage. Every operation exposing `--json` supports structured output.

<!-- facts:commands -->
```text
ares lineage show <dir> [--root KIND --id ID --revision REV --sha256 HASH] [--cursor CURSOR] [--json]
ares lineage compare <dir> (--attempts ID,... | --candidates COMMIT,...) [--json]
ares autonomy show <dir> [--json]
ares autonomy set <dir> <auto|gates|copilot|step> [--phase PHASE] [--json]
ares skill propose <dir> --file PATH|- [--json]
ares skill decide <dir> <name> <accept|reject|withdraw> --reason TEXT [--pr URL] [--json]
ares skill list <dir> [--json]
ares lessons <dir> [--for TEXT] [--half-life DAYS] [--limit N] [--json]
ares archive <dir> [--confirm FINGERPRINT] [--json]
ares setup <claude|codex|kimi|pi|qwen|jcode|agy|all|console> [--apply|--undo] [--root ABS] [--json]
ares watch set <dir> --file PATH|- [--json]
ares watch run <dir> [--json]
ares watch show <dir> [--json]
ares console add <dir> [--json]
ares console remove <dir> [--json]
ares console list [--json]
ares manifest [--json]
ares init <dir> --question TEXT [--mode survey|experiment] [--autonomy auto|gates|copilot|step] [--json]
ares run <dir> [--parallel 1..8] [--json]
ares plan set <dir> --file PATH|- [--json]
ares plan control <dir> <pause|resume|retry|cancel|skip> [node] --command-id ID --expected-revision N [--json]
ares plan show <dir> [--json]
ares status <dir> [--json]
ares study export <dir> --bundle DIR [--list] [--json]
ares scope <dir> --file PATH|- [--json]
ares idea add <dir> --file PATH|- [--json]
ares idea decide <dir> <id> <refine|pivot> --reason TEXT [--attempts ID[,ID...]] [--commit SHA] [--cause TEXT] [--retry-when TEXT] [--json]
ares investigate show <dir> [--json]
ares investigate close <dir> [--json]
ares ablate add <dir> --file PATH|- [--json]
ares ablate show <dir> [--json]
ares ablate close <dir> [--json]
ares posthoc show <dir> [--json]
ares final close <dir> [--json]
ares final seeds <dir> --file PATH|- [--json]
ares selection <dir> --file PATH|- [--json]
ares protocol <dir> --file PATH|- [--json]
ares executor set <dir> --kind local|ssh [--host ALIAS] --workdir PATH [--gpu-devices IDS --gpu-min-free-memory-mb MB --gpu-max-load-ratio RATIO] [--json]
ares executor inputs hash <dir> <path> [--json]
ares executor check <dir> [--json]
ares gate list <dir> [--json]
ares gate approve <dir> <scope|screen|design|final|review|plan:node-id|accept:artifact> [--reason TEXT] [--json]
ares gate reject <dir> <scope|screen|design|final|review|plan:node-id|accept:artifact> --reason TEXT [--json]
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
ares review add <dir> --file PATH|- [--json]
ares review resolve <dir> <review-id>/<finding-id> --reason TEXT [--json]
ares review show <dir> [--json]
ares paper build <dir> [--json]
ares paper check <dir> [--json]
ares cite check <dir> <draft> [--json]
ares playbook
ares mcp
```
<!-- /facts:commands -->

<!-- facts:mcp-tools -->
The MCP server publishes 58 tools: `ares_lineage_show`, `ares_lineage_compare`, `ares_autonomy_show`, `ares_autonomy_set`, `ares_watch_set`, `ares_watch_run`, `ares_watch_show`, `ares_console_add`, `ares_console_remove`, `ares_console_list`, `ares_setup`, `ares_manifest`, `ares_archive`, `ares_lessons`, `ares_skill_propose`, `ares_skill_decide`, `ares_skill_list`, `ares_plan_set`, `ares_plan_control`, `ares_plan_show`, `ares_status`, `ares_study_export`, `ares_scope_set`, `ares_gate`, `ares_idea_add`, `ares_idea_decide`, `ares_investigate_show`, `ares_investigate_close`, `ares_ablate_add`, `ares_ablate_show`, `ares_ablate_close`, `ares_posthoc_show`, `ares_final_close`, `ares_final_seeds`, `ares_selection_set`, `ares_protocol_set`, `ares_executor_set`, `ares_executor_inputs_hash`, `ares_executor_check`, `ares_attempt_run`, `ares_attempt_list`, `ares_attempt_show`, `ares_attempt_cancel`, `ares_attempt_reconcile`, `ares_attempt_logs`, `ares_lit_search`, `ares_lit_list`, `ares_lit_screen`, `ares_lit_card`, `ares_lit_verify`, `ares_lit_bib`, `ares_review_add`, `ares_review_resolve`, `ares_review_show`, `ares_paper_build`, `ares_paper_check`, `ares_cite_check`, `ares_playbook`.
<!-- /facts:mcp-tools -->

Memory tools are `ares_archive`, `ares_lessons`, `ares_skill_propose`, `ares_skill_decide` and `ares_skill_list`; `ares_idea_decide` accepts pivot cause/retryWhen. Archive may write external amem notes; lessons reads external amem. Both carry `openWorldHint`; skill operations stay local. MCP calls preserve agent attribution even without a native shell marker.

Watch tools are `ares_watch_set` (`{study, watch}`), `ares_watch_run` and `ares_watch_show` (`{study}`). `ares_watch_run` always returns the detached admission result `{started:true,configSha256}` after config/scope/year preflight under the study lock. Read the eventual completed result through `ares_watch_show`; `watch.ran` records an all-source failure as `ok:false`. The finite pass stays in the MCP process, which can still answer ping and `tools/list`; another start while locked refuses. CLI `watch run` and the `watch.run` plan step remain synchronous. Registry tools are `ares_console_add` and `ares_console_remove` (`{study}`), and `ares_console_list` (no arguments). These use the same shared operations as the CLI. Registry commands manage local registration only; they do not start a console.

MCP uses shared command handlers; `ares_setup` exposes the same registration preview/apply/undo operations. `init`, the controller loop `run`, and the server entrypoint `mcp` are CLI-only. Investigation tools are `ares_selection_set`, `ares_idea_add`, `ares_idea_decide`, `ares_investigate_show` and `ares_investigate_close`. Plan tools are `ares_plan_set`, `ares_plan_show` and `ares_plan_control`; `ares_gate` accepts `plan:<node-id>`. Setting, showing or controlling a plan never starts the controller loop. Start `ares run` in a separate terminal before resuming through MCP. Autonomy tools are `ares_autonomy_show` and `ares_autonomy_set`; `ares_gate` also accepts `accept:<artifact>`. `ares_study_export` writes the same bundle as `study export` and needs an absolute `bundle`. Experiment tools are `ares_protocol_set`, `ares_executor_set`, `ares_executor_check`, `ares_attempt_run`, `ares_attempt_list`, `ares_attempt_show`, `ares_attempt_cancel`, `ares_attempt_reconcile` and `ares_attempt_logs`; `ares_gate` accepts `design`, `final` and `review`. Paper/review tools are `ares_paper_check`, `ares_paper_build`, `ares_review_add`, `ares_review_resolve` and `ares_review_show`. Phase tools include `ares_final_seeds`, `ares_ablate_add`, `ares_ablate_show`, `ares_ablate_close`, `ares_final_close` and `ares_posthoc_show`. Attempt run is always detached over MCP, and executor-reaching tools carry `openWorldHint`.

## Version and format discovery

`ares manifest --json` (MCP `ares_manifest`, no arguments) reports the running package version, implemented command names/usages and the schema versions of family-readable records. It needs no study, network or executor. Current versions are `manifest`, `ledgerEvent`, `experimentProtocol`, `executor`, `experimentAttempt`, `studyPlan`, `experimentSelection`, `investigateResult`, `experimentFinalSeeds`, `ablateResult`, `finalResult` and `paperEvidence`, all version 1, carried by each record's `v` field. `study: 2` is the latest supported study format; legacy v1 is also supported. `skillProposal: 1` is also listed; proposal Markdown carries `skillProposal: 1` frontmatter and skill events carry that version in their data. The `ledgerEvents` list advertises `archive.exported`, `skill.proposed`, `skill.decided`, `watch.set`, `watch.ran` and `autonomy.set` in the version-1 ledger envelope. The manifest also lists `studyRegistry: 1`, `watchConfig: 1` and `studyBundle: 1`; a `study export` bundle manifest carries its version as `bundle: 1` rather than `v`. Unsupported ledger/proposal/registry/watch versions are refused without rewriting their bytes. `mcp.tools` publishes `{name, readOnly}` for installers; grants are fail-closed for mutating or outside-reaching tools.

Within a supported schema, readers preserve additive fields on study/attempt records and keep ledger events with unknown kinds. Appending to the ledger leaves prior lines intact; updating an attempt keeps unrecognized fields and stage entries. Unknown stage entries remain readable, including logs and totals, but budget-gated starts refuse with an upgrade instruction because this version cannot account for their resource use. A future schema version or unknown execution status/stage is refused with an upgrade instruction, leaving the original data unchanged. Unknown plan versions or node kinds are refused without changing plan.json. Command input remains strict so unknown options or protocol fields cannot silently change an experiment.

The private scope/card/candidate storage and evaluator metrics object are not family interchange schemas. The console registration uses agent-console API 1 rather than an ares interchange format. Signed runner receipts, campaign contracts and vault notes are not implemented or advertised here. Setup and `--root` registration are available. See Release below for the first-publication procedure.

## Environment

| Variable | Use |
| --- | --- |
| `OPENALEX_API_KEY` | OpenAlex key (without it, requests share a small daily budget per IP) |
| `S2_API_KEY` | Semantic Scholar key (without it, searches are often rate limited) |
| `ARES_CONTACT_EMAIL` | contact address added to the User-Agent |

Keys are sent with requests only; they are never written to the study.

## Not implemented yet

Automatic idea generation, parallel attempts, significance tests, binding agent-hub runner receipts (agent-hub#1018) to ares attempts, automatic manuscript writing/reviewing, LaTeX/PDF builds and venue templates, claim-passage evidence pending agent-hub#931, exporting verified references as vault-mem reference notes (vault-mem 0.5.0 accepts reference metadata since vault-mem#73; the ares side is not built).

## Release

Prepare a release on a clean release branch with `bun run release:prepare <version>`. This bumps `package.json` and moves the Unreleased notes into a dated CHANGELOG section. Review and merge that bump through a PR, then fast-forward local `main` to `origin/main`. On clean, synchronized `main`, the owner runs `bun run release:tag`. It verifies the version, dated notes and successful `Check` / `ci-ok` result for that exact main commit, refuses an existing local or remote tag, and creates and pushes an annotated `v<version>` tag. Never hand-create or move a release tag or reuse a published version.

Documentation stamps must be fresh before tagging. `docs/verified.json` records, for `README.md` and `src/playbook.ts` (the `ares playbook` text), the commit their prose was last checked against and the source paths it describes; edits to the stamped documents themselves are not counted as source drift. `bun run check` warns about a stale document; `bun run release:tag` and the tag workflow run `bun scripts/check-docs.mjs --require-fresh` and refuse. To restamp in the release PR, reread each stale document against the release PR's base commit on `origin/main`, fix the prose, and set its `verifiedAgainst` to that base commit (it survives the squash merge; never stamp a branch commit). Mechanical README facts (install line, command list, MCP tools) are generated: run `bun scripts/readme-facts.ts --write` after changing `package.json`, `src/commands-table.ts` or the MCP tool table.

The tag workflow first waits up to 30 minutes for the exact commit's main-push `Check` workflow and `ci-ok` aggregate to succeed. A failed, skipped or cancelled result refuses release. It checks fresh documentation stamps, the matching package version, dated CHANGELOG and main ancestry before staging. It reuses CI rather than rerunning the full suite, then installs dependencies, stages a hash-bound tarball and runs clean-prefix CLI, manifest and MCP smoke checks on Ubuntu and macOS. Publication uses the exact validated Linux tarball with provenance. The GitHub release follows with the dated notes, tarball and hash manifest; reruns edit the existing release and replace assets, with three bounded attempts for GitHub 429/5xx errors. When the `SITE_DISPATCH_TOKEN` secret is set, the workflow then sends a `product-release` dispatch to STAIxBWLB/agent-hub-site so the family portal re-syncs; a dispatch failure does not fail the release. npm publication remains one-time; an already published version cannot be republished.

Publication runs only when `NPM_PUBLISH_ENABLED` is `true` and a reviewer approves `npm-production`. It uses Node 24 and npm 11.5.1 or newer with [npm OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers), without an npm token. The owner manages trusted-publisher settings, environment approval and branch protection requiring `ci-ok`; the scripts do not change those settings.

N-1 compatibility is stated per minor release in CHANGELOG.md, separately for CLI, MCP tools and study/ledger formats. For 0.2.0, N-1 is 0.1.0: every 0.1.0 CLI command and usage and every 0.1.0 MCP tool with its `readOnly` value remain, and this version reads 0.1.0 studies and ledgers without rewriting them. 0.1.0 refuses records only newer features write: study v2 (object, `copilot` or `step` autonomy policies) and plans with a node `phase`, each without changing the file. The `n1` CI job (`bun scripts/n1-check.ts`), required by `ci-ok`, checks these claims on every build against the latest published patch of the minor line directly below the checkout's version (0.1.x for every 0.2 release). On the initial publication line it prints a skip.

## Development

```sh
bun install --frozen-lockfile
bun run check   # typecheck, boundary check, README facts, doc stamps, tests (no network), package dry-run
```

Live executor acceptance is separate from the offline gate. From a checkout with the configured SSH executor, run `bun scripts/live-exp.ts --host dgx-h100-2`. It uses a CPU-only synthetic Git repository, checks commit-specific scores, evaluator isolation, oversized logs, read-only log retrieval and archive containment, and prints a bounded summary. It removes its labeled containers and leaves private artifacts for inspection. The recorded A2 live proof is in [PR #14](https://github.com/STAIxBWLB/agent-research/pull/14); it covers that dgx Docker configuration, not every host or the local backend.
