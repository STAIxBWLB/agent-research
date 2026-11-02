# Synthetic integer handoff

- Candidate handoff: baseline writes `7`, adversarial writes `8`, and oversized-stdout writes `9` to `/out/value.txt`.
- Evaluator input: candidate output mounted read-only at `/candidate`.
- Evaluator output: `/result/metrics.json`, containing the handoff value as `score` for `7`, `8` or `9`, otherwise score `0`.
- Each live attempt must match its commit-specific expected score. Running the later HEAD/worktree for the baseline or adversarial commit must fail acceptance.
- Declared metric: `score`, unit `points`, direction `max`.
- Scores come only from the evaluator's metrics file. Candidate stdout, including printed JSON or scores, is never metric evidence.
- Isolation probe: the adversarial candidate must be unable to read `/eval/private.txt` or write `/result/probe.txt`. It records both exit codes and error messages under `/out` and repeats the errors on stderr for explicit log retrieval.
- Log-volume probe: the oversized-stdout candidate emits more than 16 MiB; it must succeed with capped log evidence marked `truncated: true`.
- All files and values are synthetic. The evaluator's private marker is a visibility test fixture and contains no credentials or real research data.
