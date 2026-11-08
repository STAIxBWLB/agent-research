# Guidance experiment control evidence

This evidence-only PR records issue #68 T2's deterministic controls against merged main commit `f9f2934fa37d9fee7d55858d8b725fdb4a0638d9`. It changes no implementation. No model, account, admitted worker, native probe or container Attempt ran. All five live arms stay unavailable; no quality, efficiency, transfer or adoption result follows from data-only replay.

The historical registration seal is `45a3c21fc5f1280ce0e7433fe5461825547ee417fb56190a2d7080c596afec8d`. The receipt is `harness-eval-controls.json`, self-hash `553142a3612d4ccd5d880631efa8d440c5b26578ad670192558307b8eecb3fa8`, binding source tree `8870dfb1d3de820ba6b4230e22a435b96788e616` and code SHA-256 `98da30d0165289ddb5e8eaa2c23a4b3b4c9fc2fc5e0ab95b27eaefa8e86a2504`. Repeating verification returns the same receipt hash without rewriting it. The #63 registration/results are untouched and its seal still verifies as `72f36f856c2559bf7a626689bca3825ae3cfe49f27c9d8abf544f24bd2778e20`.

# Exact source identity

The preregistration excludes code. Each control receipt separately binds the exact committed runtime source, including `bin/ares.js`, both harnesses, package and lockfile. Verification checks the stored commit exists, its tree agrees, it is an ancestor of HEAD, and every source blob matches the stored SHA-256 and byte count. It also requires current source bytes to agree before resume. A self-hash alone cannot establish source identity.

Generating evidence from a pre-merge branch commit would make that commit unreachable after squash merge. Recording against main after merge avoids this: the execution commit remains in main history when the evidence-only PR is squash-merged. No merge commit or weakened ancestry rule is used.

# Recorded fixture denominators and accounting

The twelve cases, three orders and five conditions define 180 fixture presentations; all 180 prerecorded pipelines completed, with 180 judge-unavailable outcomes. Completion of the prerecorded pipeline is not a successful measured outcome: judging and quality remain unavailable/unknown. The live denominator is 180 planned, zero executed and 180 unavailable. Eighteen fault fixtures have separate denominators: sixteen refused, one judge-unavailable and one unknown. Every failed/cancelled/denied/unknown/excluded field remains present; missing judging cannot be interpreted as a measured zero success rate.

Each row names all eight cost stages, using shared complete cost profiles, plus an independent end-to-end cost record. The receipt also has its own end-to-end record. All records use the same 22-dimensional schema. Unmeasured compute, wall, storage, transfer, verification, retention/materialization, failure, idle, person, tokens and monetary costs stay unknown. Observed provider requests are zero because the fixture adapter never invokes a provider. Stage/subset costs are not added to end-to-end totals or combined across incomparable clocks.

Shared per-condition profiles hold the equal aggregate ceiling and declared opportunity/unused allowances. This removes duplicate JSON without hiding stages or altering budgets. No call, token or wait is forced to consume an allowance. Prepared role hashes describe DTO construction, not model execution or OS confinement. Held-out reflections never enter an active library or a receipt as text: rows retain only a content hash, byte length and deferred status. Nested library entries are validated against the frozen learning set, stream position and source text hashes. Candidate/output objects have exact shapes and opaque blinded ids, with no method/origin fields. Live role-lane trust boundaries remain untested.

# Reproduction and evidence checks

The receipt was recorded from the clean merged main commit above, with Bun and Git available, before editing this report or artifact assertions:

```sh
bun scripts/harness-eval.ts verify
bun scripts/harness-eval.ts live-status
bun scripts/harness-eval.ts controls /absolute/repository/docs/verification/harness-eval-controls.json
```

The first command verifies the registration. The control command bound the main commit and verified registration before replay. A new output is published privately as 0600; an existing output is verified without rewriting. Changed registered input bytes, bound source code or stored commit/tree identity refuse. Receipt contents are verified semantically by canonical value comparison: object-key order and whitespace alone are accepted and the existing file is not rewritten. Changed receipt values refuse; this is not a byte-for-byte receipt check. The evidence PR committed only that generated receipt, this report and artifact assertions. The assertions inspect source and registration bytes at the recorded commit, so later implementation changes do not silently rebind old observations to new code. Strict resume additionally requires current source bytes and executable modes to agree.

The fixture adapter is in-process and sequential; it launches no child worker or GPU. The future live ceiling is 8 provider calls, 8000 tokens and 60000 ms per task, with equal tool/data/environment constraints. T3 needs separate budgeted authorization, required producers and the confined G2 lane. T4 adoption also needs separate authorization. The conclusion remains `insufficient-evidence`.


# Limits

These are fixture/control observations with unavailable judging and unknown quality, not a measured treatment/control result or a control arm for an authorized live experiment. Temporary-root CLI tests establish source identity and structural refusals only; no same-user/provider confinement claim follows. Follow-up #110 is outside this evidence PR and must land before live T3 lanes. Neither its remaining validation refinements nor later code changes rewrite the historical receipt.


## Validation refinement (#110)

The current registration seal is `c43edb283f40de7537cf9da969dc643678fd16612348fd730ce974ff54c1841c`. It was re-sealed once because the fault fixture now adds empty, subset and reordered round-library replacements, with every role's hash recomputed consistently. Validation compares the canonical registered snapshot for the exact condition and target, including array order. Conditions with no library still require the registered empty library. Source read refusals now identify the registered path and give restore or re-registration guidance.

The method, task inputs, expected values, prerecorded controls, stream orders, thresholds and denominators are unchanged. The #63 sealed files and the historical #111 control receipt are not rewritten. The new registration has 21 fault cases; the historical receipt above continues to describe its original 18. No new control receipt or measured evidence is committed with this refinement.

Receipt verification remains semantic (canonical), the smaller AC3 change: formatting and object-key order alone do not invalidate an otherwise identical receipt. Array order and changed values remain significant. Historical artifact assertions verify the original receipt against its recorded Git tree and registration; strict resume with the current changed code/registration is expected to refuse. A new control receipt for this refined registration must be recorded against the clean merged main commit in a separate evidence PR containing only that generated receipt, report and artifact assertions, following the #109/#111 two-PR shape. It cannot silently replace or rebind the old observations. Live arms remain unavailable.
