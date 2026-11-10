import { readFileSync, writeFileSync } from "node:fs";

// Fresh evaluator: reads every sealed candidate stage tree under /candidate/<stage> and publishes metrics only.
const normalize = JSON.parse(readFileSync("/candidate/normalize/values.json", "utf8"));
const bucket = JSON.parse(readFileSync("/candidate/bucket/buckets.json", "utf8"));
const summary = JSON.parse(readFileSync("/candidate/summarize/summary.json", "utf8"));

if (normalize.count !== normalize.values.length) throw new Error("normalize count does not match its values");
if (bucket.total !== normalize.values.length) throw new Error("bucket total does not match normalize");
if (summary.total !== normalize.values.length) throw new Error("summary total does not match normalize");
if (summary.width !== bucket.width) throw new Error("summary width does not match bucket width");

// Independent recomputation from the candidate's own values, never from its summary.
const expected = normalize.values.reduce((sum, value) => sum + Math.floor(value / bucket.width), 0);
if (summary.checksum !== expected) throw new Error(`checksum ${summary.checksum} does not match recomputed ${expected}`);

writeFileSync("/result/metrics.json", JSON.stringify({ checksum: expected, coverage: normalize.values.length }) + "\n");
