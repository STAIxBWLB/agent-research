import { readFileSync, writeFileSync } from "node:fs";
import { stableJson } from "./shared.mjs";

const width = Number(process.argv[2] ?? 50);
if (!Number.isSafeInteger(width) || width < 1) throw new Error("bucket width must be a positive integer");

const values = JSON.parse(readFileSync("/in/values", "utf8")).values;
const counts = new Map();
for (const value of values) {
  const bucket = Math.floor(value / width);
  counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
}
const buckets = [...counts.entries()].sort((left, right) => left[0] - right[0]).map(([bucket, count]) => ({ bucket, count }));

writeFileSync("/out/buckets.json", stableJson({ v: 1, width, total: values.length, buckets }));
