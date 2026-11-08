# Guidance harness preregistration

This is issue #68 T1 and T2: prospective protocol, synthetic corpus, prerecorded data controls and fault guards. Status is **proposed, not measured**. The owner authorized these fixture-only tasks on 2026-11-08. There are no model calls, account runs, live role workers, treatment benefit measurements or adoption decisions in this delivery. A favorable fixture check cannot enable a live arm or change production policy.

The companion machine protocol is `harness-eval-preregistration.json`. Its exact bytes, code, corpus, private expected records, control records, declared orders and library boundaries are bound by a separately created versioned receipt. Reuse the #63 freeze/verify and exact-code binding pattern; do not create a competing result authority. Existing #63 protocol, corpus, seals and baseline receipts stay unchanged.

## Corpus and partition

The explicit index is `test/fixtures/harness/index.json`; no directory scan defines the denominator. It contains twelve replay-safe synthetic tasks: four tabular and four text tasks in the learning split, followed by four tasks from the reserved transfer family in the held-out split. Inputs are invented integer tables, tokens, labels and mappings, not actual user tasks, logs, deployment identifiers or credentials. No benchmark download or search is permitted during execution.

Partition task identities before constructing any library. `corpus.learningSourceIds` fixes the eight possible learning sources; `heldoutIds` fixes the four reserved identities, and `transferFamily` is `transfer`. Changing a seed does not turn a learning task into an independent holdout.

Every case has separate input, expected and control files:

- Public input: `{v, taskId, family, prompt, data}`. Roles receive only the allowlisted current-task projection, not the index, split, stream or future inputs.
- Private expected fixture: `{v, answer, rubric, evaluatorKey}`. Every evaluator key starts with `synthetic-only-` and is a dummy fixture marker, never a credential. Answers and exact-string rubrics are evaluator-only; they never enter any role DTO, library reflection or candidate output.
- Private adapter control: seven prerecorded `baseOutputs`, editor proposal/probe/composed-guidance/successor strings, a prerecorded selector slot, and a reflection string. These are synthetic data, not calls to a proposer, model or executor. The outer adapter consumes the control; roles never receive its raw fields or file/path.

All expected tasks use exact-string checking with outer whitespace trimming only. Extra explanations remain incorrect under the registered private rule. No subjective open-world case is included. Expected fixtures reserve future executable checks and evaluator-access fault tests; T2 does not turn prerecorded strings into a measured quality rate. Its receipt reports judging unavailable and quality unknown. Fixture pipeline completion is not a succeeded quality outcome: executed fixture rows occupy the judge-unavailable outcome category. Unexecuted live rows occupy unavailable, while fault cases keep a separate denominator. Any future human-rubric or open-world task group needs separate registration and reporting.

Input, expected, control and fault files are bounded to 16 KiB each; the corpus ceiling is 1 MiB. Protocol files and registration seals are bounded to 64 KiB. Control-observation receipts are bounded to 8 MiB, measured after JSON serialization. Sources must be bounded regular files without links. Runtime receipts are private 0600 files; a committed synthetic registration seal may be 0644. These source/receipt bounds are not live model or executor resource controls.

## Declared streams and transfer

Three named order/repetition settings each contain all twelve identities exactly once. Their first eight positions are learning tasks and their final four positions are held-out transfer tasks. The orders permute both segments while preserving the boundary. Each condition/order has a separate study stream of at most sixteen tasks. Task order and any future model sampling seed are separate variables; three orders over twelve synthetic identities are not evidence of statistical significance or generality.

There are five conditions and three orders: 180 planned task-condition-order records, 36 per condition, comprising 120 learning and 60 held-out presentations. These are planned presentations, not independent tasks or completed trials. Fault cases use a separate structural/fault denominator and cannot inflate task quality counts.

During learning, only completed, authorized learning-source tasks preceding the current target in its registered order can supply library entries. Record the exact ordered source IDs, source/output hashes, policy and resulting library hash; no current-task or later-task data is eligible. Freeze the same library bytes and membership for every role within a target round. Conditions without a library use the same frozen empty array for all roles.

For strict transfer, build experience only from the registered completed learning sources and freeze that set for the entire held-out segment. No held-out reflection, lesson, output or judgment may feed a later held-out target or another comparison arm. Quarantine held-out reflections until all held-out outputs and judgments across the comparison freeze. This is strict transfer, not online prequential learning. A denied or revoked source/policy invalidates the affected condition; never silently replace, drop or refresh an entry to rescue it.

## Conditions and aggregate opportunities

Every future live condition has the same hard per-task aggregate ceiling: eight provider calls, 8,000 provider tokens and 60,000 ms wall time across all roles and stages. These are declared opportunities, not actual fixture model usage. Keep the executor model, toolset, permitted data, environment and ceiling equal; pin the editor model/config across editing methods and disclose if it is stronger than the executor.

| Condition | Registered provider-call opportunities | Unused call allowance |
| --- | --- | --- |
| `frozen-base` | reference 1 | 7 |
| `repeated-base` | reference 7, selection 1 | 0 |
| `retrieval-only` | retrieval 0, reference 1 | 7 |
| `contrastive-no-library` | reference, proposal, probe, composition, successor, selection and reflection: 1 each; retrieval 0 | 1 |
| `contrastive-prior` | same seven calls, with a frozen eligible prior library; retrieval 0 | 1 |

Retrieval has no provider-call opportunity in this protocol; its local CPU, wall, materialization, transfer and storage work must still be counted. A zero call opportunity never means zero retrieval cost. The first and third conditions have one candidate and no selector, so the outer fixture adapter uses slot zero. Repeated base has seven opaque candidates; contrastive conditions have reference and successor candidates. Their prerecord selector slot is zero or one, valid in both settings. It is fixed data, not computed by consulting the expected answer or an oracle. Candidate strings have no condition/base/contrastive origin prefix. A selector receives only blinded candidate IDs and strings, not the selected slot.

The repeated-base arm receives the same total opportunity budget, including selection. Report actual unused calls/tokens/time; do not force waste, dummy calls or waiting. Count reference, proposal/editor, probe, composition, successor execution, selection, reflection and retrieval, not merely the winning output's path. All fixture replay/model/provider usage and cost-benefit conclusions remain unmeasured or unknown; opportunity totals cannot be substituted for observed provider calls.

## Role boundary and live availability

Each role receives a strict allowlisted DTO. Common fields are `{v:1, role, taskId, prompt, data, library, librarySha256}`. Library entries contain only `{sourceTaskId, text, sha256}` from the authorized prior learning sources; the library bytes/hash are identical across every role in the round.

| Role | Additional allowed fields |
| --- | --- |
| proposer | `guidance`, `outputs: [{id, output}]` |
| worker | `guidance` |
| composer | `proposal`, `outputs: [{id, output}]` |
| selector | `candidates: [{id, output}]` |
| reflector | `guidance`, `selectedOutput` |

Candidate IDs are opaque hashes, never origin/method labels. Selector DTOs contain no guidance, condition identifier, selected slot or judgment. No role receives expected answers, rubric, evaluator key, judge payload, raw control object/file/path or any future-task information. Full synthetic role DTOs may be committed as boundary evidence; they are not live confinement receipts.

T2's DTO validation and private-data separation are **data-only controls, not OS confinement**. A same-user harness cannot establish hostile same-UID isolation or provider confidentiality. Ordinary authoring sessions do not qualify as controlled live arms. Every live proposer, worker, composer, selector and reflector requires G2's confined role-specific local-worker lane and its one aggregate budget. Agent-hub#1225/#1226 and agent-research#66/#67 producers, exact model/environment configuration and separate budgeted authorization must also exist. If any required lane or producer is unavailable, the entire live comparison is unavailable, rather than reporting a partial set of live roles as an effective treatment.

Independent judging happens after all compared outputs freeze. For this closed synthetic group, executable checking can remain outside the role lane without a provider judge. Any separately proposed subjective/provider judging needs explicit authorization, cost accounting and a registered rubric; it cannot silently expand the current ceiling. Native probes stay typed separately from container Attempts. A prerecorded probe string is neither a native probe receipt nor an ares Attempt. No board, memory-store or vault writes occur through a fixture shortcut.

## Metrics, outcomes and prospective gates

Preregister valid output rate, independent executable correctness or separately declared human-rubric outcomes, regressions, selected-versus-best gap, false improvement claims, person review effort and complete usage/compute/wall costs. Selected-versus-best checks, if later authorized, run in the evaluator after outputs freeze; the best-slot answer never flows back into the role selector or prerecorded choice. Fixture pipeline completion alone is not valid output, model benefit or person usability.

The exact outcome denominator fields are `planned`, `executed`, `succeeded`, `failed`, `cancelled`, `denied`, `judge-unavailable`, `unknown`, `excluded` and `unavailable`. They are separate reported counts, not ten disjoint bins that can be summed. Preserve failed, denied, cancelled, unknown and excluded records within planned/executed denominators as applicable. Unavailable live work remains planned but not executed. Exclusions require a reason; publish sensitivity and the full denominator instead of successful-only conclusions.

The following gates are prospective product thresholds, never measured facts:

- Fault suite: zero authority, privacy and evaluator-access violations.
- Guidance: no increase in independently checked regressions. Versus same-budget `repeated-base`, require either at least 5 percentage points higher valid outcome rate, or at least 20% lower total cost per accepted outcome at no lower quality.
- Cross-task experience: versus `contrastive-no-library`, held-out quality must be non-worse and total cost per accepted outcome must improve by at least 10%.
- Sparse outcomes, unknown judges or missing cost/denominator measurements yield insufficient evidence, never pass.

Report per-task paired distributions, order sensitivity and small-sample uncertainty. Native/live/account evidence and model sampling uncertainty are separate from synthetic structural checks. T1/T2 make no adopt/restrict/defer benefit verdict. A later authorized T4 can consider bounded opt-in guidance and experience independently, with limitations and evidence hashes; no automatic deployment follows any result.

## Complete cost accounting

The machine protocol reuses every #63 `COST_FIELDS` dimension: process CPU seconds; GPU device-active seconds; measured provider tokens/requests; monotonic elapsed wall ms; peak storage bytes and byte-seconds; transfer bytes; verification CPU/wall subsets; retention bytes/byte-seconds; materialization CPU/wall/transfer; failure CPU/device/wall/transfer; idle wall; person minutes; and separately labeled USD estimates. Every dimension is measured in its declared unit or the literal `unknown`.

Record these dimensions for all eight stages and end-to-end. Reference runs, editor/proposal, probe, composition, successor, selection, reflection and retrieval all count, including failure and recovery overhead. Verification/materialization/failure/retention subsets annotate appropriate end-to-end totals and are not added twice. Never sum CPU, GPU, wall, idle and person clocks, or bytes, tokens and currency into an invented scalar. Monetary estimates remain distinct from measured provider usage. Zero/unknown accepted outcomes or unknown required costs prevent cost-per-accepted-outcome conclusions. Synthetic control strings, fixture quality and call allowances are not usage telemetry.

## Fault guards, stopping and resume

`test/fixtures/harness/faults.json` supplies deterministic negative payloads for evaluator-key/rubric/expected leakage, future-task and future-library access, raw control/selection-slot exposure, held-out feedback export, changed resume, denied/revoked policy, unavailable/unknown judges or usage, and within-round library drift. Malicious payload fields are test inputs to a refusal boundary, never role inputs authorized by this protocol.

Stop or refuse the affected condition on authority/privacy/evaluator access, aggregate ceiling exhaustion, changed frozen bytes on resume or policy denial/revocation. Keep incurred costs and all failed/cancelled/denied/unknown denominators. Missing G2/producers/authorization leaves the entire live comparison unavailable. Unknown telemetry, sparse outcomes and judge-unavailable leave evidence insufficient. Do not add reruns after inspecting outcomes, substitute library sources, silently change the task stream or overwrite an earlier receipt. A changed method/corpus/order/library/policy binding requires a separately reviewed registration. Code changes require a new exact-code run receipt, not a change to the preregistration seal.

Freeze/verify binds method, index/input/expected/control/fault bytes, condition budgets, all three orders, library-source eligibility and future run stream hashes. Runtime code is excluded from this preregistration seal; each run receipt separately binds the exact code, including bin/ares.js and the harness. This document does not create the frozen receipt; the parent implementation creates it after all assigned source changes are reviewable. No existing #63 bytes are rewritten. Source/fixture checks, hosted CI and native/live evidence are reported separately.
