import { readFileSync, writeFileSync } from "node:fs";
import { stableJson } from "./shared.mjs";

const { width, total, buckets } = JSON.parse(readFileSync("/in/buckets", "utf8"));
const counted = buckets.reduce((sum, entry) => sum + entry.count, 0);
if (counted !== total) throw new Error(`bucket total ${counted} does not match declared ${total}`);
const checksum = buckets.reduce((sum, entry) => sum + entry.bucket * entry.count, 0);

writeFileSync("/out/summary.json", stableJson({ v: 1, width, total, checksum }));
