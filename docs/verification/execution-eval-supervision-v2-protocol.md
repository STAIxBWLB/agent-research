# Supervision v2 corpus

This is [#63 T2c-A](https://github.com/STAIxBWLB/agent-research/issues/63), authorized on 2026-11-10 by the decision recorded in that issue. It re-expresses the Supervision trial in the fact types the pinned shadow evaluator actually reads. It authors fixture data and this document only: no rule code, no seal, no evaluator run, no observation and no metric. The frozen v1 Supervision cases, their expected labels, `test/fixtures/execution-eval/corpus.json` and the T1 method, corpus and threshold seal stay unchanged.

The corpus is `test/fixtures/execution-eval-supervision-v2/`: twelve cases, four each of `ordinary-progress`, `true-trigger` and `misleading-symptom`, listed with their input/expected pairs in `corpus.json`. Every case is synthetic; ids, peer names and times are invented and carry no study, task or receipt identity.

## Amendment rationale

The v1 Supervision cases describe retry budgets, dispatch acknowledgements, 429 waits, worker presence and conflicting owner constraints. None of those is an admitted fact type, so `integration-check` classifies all twelve as `unsupported` with `task-state-not-admitted-rule-facts` and reports covered 0 of 12 (see `docs/verification/execution-eval-treatment-integration.md`). The trial therefore measured nothing it claimed to measure.

v2 keeps the question the trial is about, whether a careful person would want the supervisor to propose an existing action on this task now, and answers it only from facts the producer publishes: task revision history, the hub's own deliverable measurement and the hub's own declared-overlap rows. Scenarios whose evidence has no admitted equivalent are retired rather than translated by hand; a retirement is a coverage loss and must be reported as one, not as a passing case.

## Blind authoring

Sources read before any label was written:

- `agent-hub@bc6f46b077dd3a255debaee8152fa17f1f13b79c`, `src/hub/supervision-rules.ts`: the fact types only (`SupervisionFacts`, `TaskRevisionFacts`, `SupervisionHistoryFact`, `DeliverableMeasurementFact`, `DeclaredOverlapFact`) and the bounds block next to them (`MAX_RECORDS` 64, `REPEAT_FLOOR` 2, `MAX_REFS` 8, `MAX_OBSERVATIONS` 100, `MAX_PER_REVISION` 3).
- The same commit, `src/hub/board.ts`: the `HistoryEntry` fields a history fact may carry (`at`, `by`, `event`, `checkKey`, `noWrites`, `planRevision`, `evidenceOnly`, `deliverables`) and the event vocabulary.
- The same commit, `docs/design/supervision.md`: the sections "Facts the rules may read" and "Revision identity" only.
- This repository's frozen v1 Supervision inputs and expected labels, read after the v2 labels were written and used only to build the mapping table below.

Not read: the Rules section of `docs/design/supervision.md` and everything after it, any rule function body, `test/supervision-rules.test.ts`, the observation, gap and evaluation internals, and this repository's shadow record reader or scorer.

Disclosure: the grep that located the fact type declarations also printed the exported constant lists directly above them (rule ids, actions, reasons and gap codes) and the comment on `REPEAT_FLOOR` that the first failure is an incident and the second a pattern. No rule condition, comparison or suppression logic was read. The repeated-failure labels rest on scenario intent, and the ordinary true-trigger case uses three identical failing checks so its label does not depend on that floor. The plan-revision boundary case is the one place where a reader may reasonably disagree with the label.

## Cases

| Case | Label | Facts used |
| --- | --- | --- |
| ordinary-progress-quiet-check-sequence | no trigger, none | history only |
| ordinary-progress-recorded-gate-wait | no trigger, none | history, deliverable measurement |
| ordinary-progress-completed-intact-deliverables | no trigger, none | history, deliverable measurement |
| ordinary-progress-truncated-quiet-revision | no trigger, none | history (66 records, read as a 64-record prefix) |
| true-trigger-repeated-failure-same-check | trigger, escalate | history |
| true-trigger-changed-deliverable-after-pass | trigger, recheck | history, deliverable measurement |
| true-trigger-overlap-without-integration | trigger, request_integration | history, declared overlap |
| true-trigger-repeated-failure-current-plan | trigger, escalate | history |
| misleading-symptom-absent-measurement | no trigger, none | history only (no measurement row) |
| misleading-symptom-long-gap-recorded-progress | no trigger, none | history |
| misleading-symptom-failures-split-by-hand-over | no trigger, none | history |
| misleading-symptom-unmeasured-changed-ids | no trigger, none | history, unmeasured deliverable row |

Coverage: all three fact kinds appear; `absent-measurement` carries no deliverable row and `truncated-quiet-revision` exceeds the 64-record read bound, so both are incomplete-facts cases. Two cases are boundaries where a plain record pattern could read differently from intent: `repeated-failure-current-plan` (three failures under the previous plan, then two under the current one, labeled a trigger) and `failures-split-by-hand-over` (two equal failures separated by a reassignment to another owner, labeled no trigger).

## Mapping from v1

| v1 case | v2 analog |
| --- | --- |
| ordinary-progress-stage-transition | ordinary-progress-quiet-check-sequence |
| ordinary-progress-bounded-human-wait | ordinary-progress-recorded-gate-wait |
| ordinary-progress-completed-output | ordinary-progress-completed-intact-deliverables |
| ordinary-progress-successful-retry | retired: no attempt-status fact exists in T1 |
| true-trigger-exhausted-retries | true-trigger-repeated-failure-same-check |
| true-trigger-unresolved-delivery | true-trigger-changed-deliverable-after-pass |
| true-trigger-exhausted-budget | retired: no budget or extension fact exists in T1 |
| true-trigger-conflicting-owner-constraints | retired: no constraint fact exists in T1 |
| misleading-symptom-long-wall-progress | misleading-symptom-long-gap-recorded-progress |
| misleading-symptom-artifact-not-yet-due | misleading-symptom-absent-measurement |
| misleading-symptom-rate-limit-scheduled | retired: no rate-limit or wait fact exists in T1 |
| misleading-symptom-worker-absent-external-active | retired: no worker-presence fact exists in T1 |

Five v2 cases have no v1 source: `truncated-quiet-revision`, `overlap-without-integration`, `repeated-failure-current-plan`, `failures-split-by-hand-over` and `unmeasured-changed-ids`. The last four exist because the admitted facts make them answerable and because a plain counter would answer them wrongly.

## Labels and metrics

`trigger` means a careful person, reading only the facts in the case, would want the supervisor to propose the named existing action on that task now. It is not a prediction that a rule fires. `nextAction` is one of `escalate`, `recheck`, `request_integration` or `none`; `reason` is a short kebab code describing the intent, deliberately not the producer's reason vocabulary, and mapping the two belongs to the integration step. `mustNot` lists behaviors that are wrong whatever the label: creating a duplicate proposal, performing an unapproved task action, and claiming a measured benefit.

- Helpful: the label triggers, the producer reported evaluation coverage for that rule, task and revision, and an observation on that task and revision proposes `nextAction`. A stronger action than the one named does not count as helpful.
- Wrong action: the label triggers, coverage for that rule, task and revision was reported, and observations on that task and revision exist but none of them proposes `nextAction`. This is its own count and is never helpful. For acceptance it counts against the same budget as a false proposal, so an evaluator that always proposes the wrong action cannot look error-free, and it is the category that keeps a trigger-shaped case from scoring as nothing.
- False: the label does not trigger and an observation proposes any action on that task and revision.
- Missed: the label triggers, coverage for that rule, task and revision was reported, and no observation exists for that task and revision.
- Correct non-trigger: the label does not trigger, coverage was reported, and no observation exists for that task and revision.

When one observation proposes `nextAction` and another proposes a different action on the same task and revision, the case is helpful, and each extra action is also counted as a wrong action.

The partition is exhaustive. For the action it names, every covered true-trigger case lands in exactly one of helpful, wrong action or missed; every covered non-trigger case lands in exactly one of false or correct non-trigger. The multi-observation case above is the only shape that contributes to two counts, and it contributes helpful plus one wrong action per extra proposal. No observation on a covered case, and no covered case without an observation, goes unscored.

Absence is scored only inside reported coverage. Where the producer reports no coverage for a rule, task and revision, a missing observation stays insufficient evidence and is neither missed nor a correct non-trigger. `absent-measurement` and `unmeasured-changed-ids` exist to make that distinction testable rather than implicit.

No results have been seen. The corpus has never been run against the evaluator, so no helpful, wrong-action, false, missed or correct-non-trigger count exists for it, and reading these labels is not a measurement.

## Integration method: intent join and amendment seal

The integration binds each indexed input/expected pair by its raw file digests. Candidate adapters receive only `input.request` and `input.facts`; expected labels stay evaluator-only. A locally owned closed validator checks the pinned `SupervisionFacts` fields and consumer bounds without executing rule conditions, importing hub code or resolving a metadata path. Histories longer than the producer's 64-record read prefix remain valid inputs. Format coverage therefore does not establish that a rule was evaluated or that incomplete facts became complete.

The join uses the label's positive task id and the current revision derived from its input history. Revision identity follows the pinned producer document: count owner episodes (`accepted`, `reassigned`, `escalated`, `reopened`), retain the latest host plan revision, and preserve history order. Event timestamps do not infer a trigger. A missing target task has no invented revision and remains insufficient evidence.

The action mapping is `escalate` to `repeated_failure`, `recheck` to `deliverable_invalidated_check`, and `request_integration` to `declared_overlap_without_integration`. A candidate observation joins on `(rule, task, current revision)`, not on a producer trigger string. The label's `trigger` is a boolean intent label. `nextAction: none` with `trigger: false` denotes a non-trigger intent; any present action on the same task/revision is a false proposal. Task state is not re-evaluated to hide an unfavorable observation.

Record replays are deduplicated by `(rule, task, revision, trigger)` before intent scoring. One or more correct-action observations make one helpful case; each matching proposal is classified explicitly without inflating that case count. Each additional proposal with a different action contributes one wrong action. For non-trigger intent, false proposals are counted individually. The observed false-proposal budget is `false + wrongAction`; case outcomes and proposal classifications remain separate so the exhaustive partition above and intervention burden are both visible.

The current T1 snapshot has no source-owned evaluated-revision set. A present matching observation supplies positive evidence for its own rule/task/revision only. Absence is always `insufficient-evidence` with `no-evaluation-coverage`; missed and correct-non-trigger counters stay `null`. In a true-trigger case with only wrong-rule observations, the desired rule's absence likewise has no evaluation coverage: retain the unmatched proposals as unscored evidence rather than inventing a wrong-action-only or missed result. Matching gaps, truncated reading and retained-source suppression also remain explicit insufficient coverage. Caller-asserted evaluated lists cannot replace the later producer-owned coverage export. These are the current-data limits of the coverage requirements above, not a change to the intent labels or to the eventual covered-case partition.

The v2 amendment is frozen separately at `docs/verification/execution-eval-supervision-v2-frozen.json`. It binds this protocol's exact bytes (including this method), the inherited v1 method/budget/threshold/denominator bindings, the ordered v2 index/input/expected hashes, and both raw and canonical hashes of the immutable parent v1 receipt. Freeze creates once and subsequent calls verify without overwriting. The original seal `72f36f85` and every v1 frozen method/input/expected file remain unchanged. Evolving implementation code is bound per run rather than substituted for the preregistration method. Freeze, verify and integration-check execute no evaluator, treatment trial, hub or model call; integration outcomes remain null.
