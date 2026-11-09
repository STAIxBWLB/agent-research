# Stage protocol: T1 definition boundary

Issue #61 T1 adds a pure protocol v2 validator and identity helpers in `src/exp/stages.ts`. This PR deliberately stops after T1, as allowed by task #84. No stage runner, retained artifact store, retention command, study mutation path or v2 manifest advertisement is enabled. CLI/MCP protocol writes and the existing executor continue accepting v1 only. A v2 definition is refused before any protocol/attempt record or container effect. `PlanNode.needs` remains scheduling-only.

## Definition

`validateStageProtocol(raw)` accepts this v2 shape, retaining the existing v1 method, evaluator, metric, seed, isolation, limit and budget fields:

```json
{
  "v": 2,
  "method": "synthetic pipeline",
  "candidate": {
    "stages": [
      {
        "name": "prepare",
        "image": "synthetic@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "command": ["/bin/prepare"],
        "env": {"MODE": "fixture"},
        "seed": true,
        "code": "snapshot",
        "needs": [],
        "inputs": {"data": {"task": "data/train.json"}},
        "outputs": {"rows": "rows.json"}
      },
      {
        "name": "train",
        "image": "synthetic@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "command": ["/bin/train"],
        "seed": true,
        "code": "snapshot",
        "needs": ["prepare"],
        "inputs": {"rows": {"stage": "prepare", "output": "rows"}},
        "outputs": {"model": "model.bin"}
      }
    ]
  },
  "evaluator": {
    "image": "synthetic@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "command": ["/bin/evaluate"]
  },
  "metrics": [{"name": "score", "unit": "points", "direction": "max"}],
  "seeds": [0, 1],
  "limits": {"cpus": 1, "memoryMb": 128, "pidsLimit": 64, "wallSeconds": 60, "gpus": 0},
  "network": "none",
  "budget": {"maxAttempts": 5, "maxWallHours": 1, "maxGpuHours": 0}
}
```

- `candidate.stages` contains 1..16 uniquely named stages in explicit serial execution order. All ordering and data references must name earlier stages, making cycles impossible. Independent stages also keep their declared order.
- `needs` is an ordering edge only. An input `{stage, output}` is a data edge and requires the earlier stage's declared output name; it does not need a redundant `needs` entry. Neither edge permits reuse.
- Every stage declares `code: "snapshot"`, meaning the attempt's frozen code commit/tree, and boolean `seed` use. No mutable code locator is accepted. A stage's `seed: false` does not remove the attempt seed from attempt identity.
- Inputs are either `{task: relativePath}` within the frozen task snapshot or `{stage, output}`. Task evaluator paths are private and refused. There is no arbitrary host path, caller-chosen mount or top-level v1 external-input descriptor in this form.
- Named input/output maps each have at most 32 ports. Names contain 1..32 lowercase ASCII letters, digits, underscores or hyphens and begin with a letter. Reserved object names and `evaluator` are refused. Output values name disjoint relative files or directories within that stage's fresh output root. Dot segments, absolute paths, empty segments and unsafe characters are refused.
- Image digest, argv and explicitly declared nonsecret env entries use the authoritative v1 validator, including reserved-key and secret-like-key refusal. No inherited host environment is declared by this schema. The evaluator retains its separate v1 definition and does not accept candidate env.
- The entire formatted definition remains at most 65,536 bytes; stage count does not multiply this ceiling. There are no per-stage wall/compute budget overrides.

This validator is structural preflight only. Task paths and code bytes must be checked against frozen snapshots by the execution implementation. The existing bounded `taskTreeHash` refuses symlinks and special files; structural path validation alone cannot attest filesystem contents.

## Identity

`stageProtocolHash` validates and canonically hashes the entire v2 definition except `budget`. It binds the version, explicit stage order, image, argv, env, seed policy, code source, port names/paths, every ordering/data edge, evaluator, metrics, seeds, limits and network policy. Object key order is irrelevant; array order and argv bytes remain significant. This hash can feed the existing attempt identity formula together with frozen commit/tree, seed, run and retry identity once v2 execution is implemented.

`stageDesignBinding` hashes the validated full definition, including budget, together with a caller-supplied bounded task-tree hash. It is only the protocol/task component for future study integration. It does not read a study, record approval, replace `readDesign`, or bind selection/final-seed files. T2 integration must compose those existing seals too. No v1 hash or raw-byte design-seal formula changes.

## Migration-free compatibility matrix

| Record or operation | Current v1 CLI/MCP/executor | T1 pure v2 helper | Complete compatible v2 release |
| --- | --- | --- | --- |
| Existing v1 study/protocol/attempt | Existing reads and fresh execution unchanged | Not a v1 parser | Must retain v1 reads, identity and execution |
| Protocol v2 declaration | Refuse before mutation; keep original file | Validate/hash only, no writes | Opt-in read/write only after T2/T3 execution safety |
| Protocol future version | Refuse before mutation | Refuse | Refuse unsupported versions before mutation |
| Existing selection/final rules | Unchanged, including first-final rules | No mutation or approval | Preserve existing seal composition and first-final behavior |
| Retained output or prune | No new command or availability claim | No artifact support | Requires bounded verification, reservation, tombstone and consumption lifecycle |

No automatic migration or downgrade is provided. `FORMAT_VERSIONS.experimentProtocol` stays 1 because v2 is not an implemented family-readable record yet. `scripts/n1-check.ts` remains authoritative for the published N-1 CLI, MCP and study/ledger checks, including legacy no-input protocol hash/design-seal identity. Offline fixture tests are distinct from that network/installed-package check.

Activating protocol v2 requires a separately authorized compatible release. Because the older reader cannot interpret the new protocol format, activation belongs on a new minor line, with explicit CLI, MCP and study/ledger N-1 statements in `CHANGELOG.md` and the prior-minor published patch selected by `scripts/n1-check.ts`. Older binaries must refuse the opt-in v2 definition without mutation; existing v1 studies remain usable without migration. This PR neither bumps a version nor tags or publishes anything.

## Pending execution and evidence

T2/T3 must implement fresh sequential stages with upstream read-only snapshots, a separate fresh evaluator, atomic bounded retention after observed termination, integrity verification before every consumption, aggregate retention reservation/cap and fingerprinted prune with active-consumer refusal and tombstones. Same-user/executor tampering remains an integrity limit, not solved by filesystem permissions.

Attempt-wide limits must cover all candidate stages and evaluator work, including retries and verification: at most 500 files, 256 MiB output payload, existing total output metadata and 1 MiB attempt record bounds. Wall/compute time must also remain cumulative. Manifest sidecars cannot bypass the metadata ceiling. The default 1 GiB study retention cap must include in-flight reservations and refuse admission without eviction.

The synthetic tests in this PR cover three-stage declaration/data edges, malformed graph/path/execution refusals, bounded definitions, identity changes, atomic v2/future refusal and existing task-tree link refusal. They do not execute a fake three-stage runner, retain artifacts or test crash/prune races. T4 fake-runner proof remains pending with T2/T3. Container proof still requires its separate go-ahead. AC1-AC6 are not claimed complete by this T1 foundation.
