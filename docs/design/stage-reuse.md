# Stage-artifact reuse: T1 declaration and key contract

Issue #64 T1 adds structural eligibility and deterministic key helpers. It does not look up artifacts, select a hit, skip a container, read external state, record a reuse receipt, cache model output or create a new observation. Runtime execution still follows the fresh #61 pipeline. T2/T3 and fixture-equivalence proof remain pending; the measured pilot still requires its separate go-ahead.

## Declaration

A v2 candidate may optionally declare `reuse`. The normal CLI/MCP protocol setter validates the same closed shape and includes it in the frozen protocol identity and design seal. Adding or changing it reopens design approval. Without the field, normalized bytes and existing v1/v2 hashes stay unchanged.

```json
{
  "reuse": {
    "v": 1,
    "kind": "pure-artifact",
    "inputs": "declared-only",
    "externalState": "none",
    "writableState": "fresh-output-only",
    "modelOutputs": "forbidden",
    "determinism": "byte-exact",
    "toolchain": {
      "description": "Synthetic deterministic byte transformer and its toolchain",
      "documentationSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  }
}
```

The description is at most 1,024 UTF-8 bytes; its documentation digest has 64 lowercase hex digits. Every field is required, unknown fields and future versions refuse, and strings retain their original bytes without trimming or Unicode normalization. Secret-like execution env restrictions remain the v1 validator's contract. Do not put secrets or executor locators into the description.

This is a reviewable declaration, not proof of determinism. Documentation existence or adequacy is not verified by its hash. Container isolation does not establish purity. There is no `reviewed`, `approved`, actor or caller inspection field: current approval must come from the study's actual design gate at future consumption time. A proposed contract may be stored before review, as with the rest of a protocol, and cannot authorize a hit by itself.

## Structural eligibility

`stageReuseEligibility` accepts a validated protocol, a candidate/evaluator selection, an execution phase, optional `mode: off|eligible` and optional boolean `forceFresh`.

- Default mode is `off`. Force-fresh always refuses reuse.
- Only protocol v2 candidates in phase `investigate` with an explicit pure-artifact contract and nonempty declared outputs can be structurally eligible.
- Evaluator, evaluate, ablate, final, posthoc and other phases remain fresh. Legacy protocols and undeclared contracts remain fresh. Model-output or statistical contracts are refused rather than treated as deterministic artifacts.
- The result always says `kind: declaration-only`. Its `eligible` value is not permission, a current gate check, byte verification, a source-existence claim, a hit or an independent sample.

T1 exposes no new CLI/MCP execution switches. Its pure helper controls are groundwork for T2 parity; they do not change the default runner. The phase and runtime facts accepted by helpers are internal caller context, not new public authority. The future adapter must derive them from source-owned study/executor state and must not trust a caller to classify a final run as investigate.

## Key domain

`stageReuseKey` requires structural eligibility and returns a SHA-256 key over canonical version-1 key material. It includes:

- Study id, full frozen Git tree id (40 hex) and extracted code snapshot digest (64 hex). No narrower code closure or file allow list is accepted.
- Every declared input port's actual identity digest, exactly once, with no missing or undeclared ports. For retained-stage inputs this is the verified parent manifest digest; the manifest binds output bytes and source provenance. Task input identities come from verified frozen task materialization.
- The entire selected stage: name, image digest, argv, explicit env, seed policy, frozen-code declaration, ordering/data edges, output names/paths and pure-artifact contract. Selected seed remains keyed even for a stage without seed injection, conservatively allowing extra misses.
- Frozen selection-population digest, sourced from the actual selection rule and reserved-seed identities at the approved design. A missing population identity cannot produce a key; T2 must derive this from study records rather than accept a caller assertion.
- Comparison domain: protocol version, method, evaluator definition, metrics, declared seeds, resource limits and network policy. Budget is excluded because admission enforces it anew; budget edits still change the full design seal.
- Explicit runtime semantics and producer version plus operating system, architecture and platform ABI. Each fact is nonblank, bounded to 128 UTF-8 bytes and control-free; no missing-fact fallback is provided. T2 must obtain actual supported facts from the executor, not invent an ABI or infer it from the image alone.

Other candidate definitions are outside the comparison domain. Changing only a downstream candidate's configuration can preserve an unchanged upstream key when its full code tree and inputs remain the same. A code-tree edit invalidates all keyed stages until a narrower closure is proven. Canonical object order is irrelevant; argv and array order are significant. Evaluator or selection-population domain edits always invalidate the key.

Key equality alone never authorizes cross-study sharing. T2 lookup must remain in the current study's physical executor-local store, validate source study/attempt/stage provenance and revalidate manifest and selected bytes. It must enforce current gates and permissions, ordinary budgets and fresh downstream/evaluator execution after any required reseal. A key does not carry approval or attest that runtime/ABI facts were honestly sourced.

## Remaining execution obligations

- T2: atomic, fenced lookup/admission/reconciliation; source-availability and corruption misses; current policy checks; budget admission; immutable source references and reuse receipts; original compute versus verification/materialization overhead; no automatic rerun of uncertain work.
- T3: CLI/MCP reuse off|eligible and force-fresh parity, explicit retry handling, provenance and console views, executed/reused stage counts and honest independent-sample counts. Existing terminal idempotence and first-final records must be preserved. Never reuse or overwrite evaluator metrics.
- T4: predeclared byte-exact fresh-versus-reused fixture outputs and fresh evaluator equivalence, false-hit injection detection, and separately authorized measured pilot. No savings or adoption decision is claimed here.

This PR does not bump a package version, tag, publish or perform a live run. The optional declaration requires a compatible reader; older strict v2 readers refuse the new field without mutation. The compatible minor release requirement for v2 activation remains as documented in the Unreleased changelog. Existing absent-contract studies need no migration.
