import { readFileSync, statSync, writeFileSync } from "node:fs";
import { scale, stableJson } from "./shared.mjs";

// /in/<port> is the declared task file itself; accept the directory form as well so the layout is not guessed.
const port = "/in/workload";
const path = statSync(port).isDirectory() ? `${port}/workload.json` : port;
const raw = JSON.parse(readFileSync(path, "utf8"));
const unique = [...new Set(raw.values)].sort((left, right) => left - right);
const values = scale(unique);

writeFileSync("/out/values.json", stableJson({ v: 1, count: values.length, values }));
