# Synthetic integer handoff

- Candidate objective: write the integer `7` to `/out/value.txt`.
- Evaluator input: candidate output mounted read-only at `/candidate`.
- Evaluator output: `/result/metrics.json`, containing `{"score":1}` when `value.txt` contains `7`, otherwise `{"score":0}`.
- Declared metric: `score`, unit `points`, direction `max`.
- Scores come only from the evaluator's metrics file. Candidate stdout, including printed JSON or scores, is never metric evidence.
- Isolation probe: the adversarial candidate must be unable to read `/eval/private.txt` or write `/result/probe.txt`. It records both exit codes and error messages under `/out` and repeats the errors on stderr for explicit log retrieval.
- All files and values are synthetic. The evaluator's private marker is a visibility test fixture and contains no credentials or real research data.
