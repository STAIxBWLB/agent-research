// External, one-off producer generation only. Never imported by ares runtime or CI.
import {createHash, randomUUID} from "node:crypto";
import {closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, unlinkSync, writeSync, constants} from "node:fs";
import {arch, cpus, hostname, platform, release, tmpdir} from "node:os";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";

const PIN = "a470ebbd5d809e421c6fc82fab8a69434c1b2e08";
const MODULE = "src/hub/supervision-rules.ts";
const FILE_BYTES = 65_536, REQUEST_BYTES = 1024 * 1024, INPUT_BYTES = 16_384;
const RETAINED_BYTES = 16 * 1024 * 1024, WALL_MS = 7_200_000, CPU_SECONDS = 7200;
const CASE_WALL_MS = 60_000, CASE_CPU_SECONDS = 60, CASE_RSS = 256 * 1024 * 1024;
const ORDERS = [["A", "B", "C"], ["A", "C", "B"], ["B", "A", "C"], ["B", "C", "A"], ["C", "A", "B"], ["C", "B", "A"]] as const;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => {throw new Error("supervision generation refused; inspect admission, immutable inputs and pinned producer identity before retrying with a fresh output directory");};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function object(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
  return value as Record<string, any>;
}
function digest(value: unknown): string {if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(); return value;}
function text(value: unknown, bytes: number): string {if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > bytes || /[\p{Cc}\p{Cs}]/u.test(value)) fail(); return value;}
function read(file: string, maximum: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd); if (!info.isFile() || info.size > maximum) fail();
    const chunk = Buffer.alloc(Math.min(maximum + 1, 65_536)), parts: Buffer[] = []; let total = 0;
    for (;;) {const length = readSync(fd, chunk, 0, chunk.length, null); if (!length) break; total += length; if (total > maximum) fail(); parts.push(Buffer.from(chunk.subarray(0, length)));}
    return Buffer.concat(parts);
  } finally {closeSync(fd);}
}
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", {fatal: true}).decode(bytes);
function json(bytes: Uint8Array): unknown {try {return JSON.parse(decode(bytes));} catch {return fail();}}
function writeNew(file: string, value: unknown): number {
  const bytes = Buffer.from(JSON.stringify(value) + "\n"); if (bytes.length > FILE_BYTES) fail();
  const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
  try {let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset); fsyncSync(fd);} finally {closeSync(fd);}
  try {linkSync(temporary, file);} finally {unlinkSync(temporary);}
  return bytes.length;
}
function privateInput(file: string, bytes: string): void {
  if (Buffer.byteLength(bytes) > INPUT_BYTES) fail();
  const fd = openSync(file, "wx", 0o600);
  try {let offset = 0, buffer = Buffer.from(bytes); while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset); fsyncSync(fd);} finally {closeSync(fd);}
}
const usageSeconds = (start: NodeJS.CpuUsage) => {const value = process.cpuUsage(start); return (value.user + value.system) / 1_000_000;};
function environment(imageDigest: string) {
  if (platform() !== "linux" || !existsSync("/.dockerenv") || !/^sha256:[a-f0-9]{64}$/.test(imageDigest) || Bun.version !== "1.4.2") fail();
  const [quota, period] = decode(read("/sys/fs/cgroup/cpu.max", 4096)).trim().split(/\s+/);
  const cpuLimit = Number(quota) / Number(period), memoryLimitBytes = Number(decode(read("/sys/fs/cgroup/memory.max", 4096)).trim()), pidsLimit = Number(decode(read("/sys/fs/cgroup/pids.max", 4096)).trim());
  if (![cpuLimit, memoryLimitBytes, pidsLimit].every(value => Number.isFinite(value) && value > 0) || cpuLimit > 2 || memoryLimitBytes > CASE_RSS || pidsLimit > 32) fail();
  return {os: platform(), osRelease: release(), arch: arch(), bun: Bun.version, logicalCpus: cpus().length, cpuLimit, memoryLimitBytes, pidsLimit, cpuModelsSha256: hash(canonical(cpus().map(cpu => cpu.model))), containerIdentitySha256: hash(hostname()), imageDigest, sequentialChildren: 1 as const};
}
function cgroupCpuSeconds(): number {
  const match = /^usage_usec ([0-9]+)$/m.exec(decode(read("/sys/fs/cgroup/cpu.stat", 4096)));
  if (!match) fail(); const value = Number(match[1]) / 1_000_000; if (!Number.isFinite(value) || value < 0) fail(); return value;
}
function gitEnv(home: string): NodeJS.ProcessEnv {
  return {PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, TMPDIR: home, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0"};
}
function producerIdentity(root: string, home: string): string {
  if (!isAbsolute(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail();
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["/usr/bin/git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "gc.auto=0", "-c", "protocol.allow=never", ...args], {cwd: root, env: gitEnv(home), stdout: "pipe", stderr: "pipe", timeout: 5000, maxBuffer: REQUEST_BYTES});
    if (result.exitCode !== 0 || result.exitedDueToTimeout || result.exitedDueToMaxBuffer) fail(); return result.stdout;
  };
  if (decode(git(["rev-parse", "--verify", "HEAD"])).trim() !== PIN || decode(git(["rev-parse", "--show-toplevel"])).trim() !== root || git(["status", "--porcelain", "--untracked-files=no"]).length) fail();
  let directory = root;
  for (const part of MODULE.split("/").slice(0, -1)) {directory = join(directory, part); const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) fail();}
  const bytes = read(join(root, MODULE), REQUEST_BYTES), committed = git(["show", `${PIN}:${MODULE}`]);
  if (!bytes.equals(committed)) fail();
  return hash(bytes);
}
function request(raw: unknown) {
  const value = object(raw, ["code", "bindings", "cases"]), code = object(value.code, ["commit", "tree", "codeSha256", "files"]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(code.commit) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(code.tree)) fail(); digest(code.codeSha256);
  if (!Array.isArray(code.files) || code.files.length > 256 || !code.files.length) fail();
  const seen = new Set<string>(); let codeBytes = 0;
  for (const rawFile of code.files) {
    const file = object(rawFile, ["path", "sha256", "bytes"]); text(file.path, 4096); digest(file.sha256);
    if (file.path.startsWith("/") || file.path.includes("\\") || file.path.split("/").some((part: string) => !part || part === "." || part === "..") || seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > REQUEST_BYTES) fail();
    seen.add(file.path); codeBytes += file.bytes;
  }
  if (codeBytes > RETAINED_BYTES || hash(JSON.stringify(code.files)) !== code.codeSha256) fail();
  const bindings = object(value.bindings, ["v1ReceiptSha256", "v2ReceiptSha256", "reuseR2ReceiptSha256", "inputSha256", "methodSha256"]);
  for (const item of Object.values(bindings)) digest(item);
  const pinnedBindings = {v1ReceiptSha256: "72f36f856c2559bf7a626689bca3825ae3cfe49f27c9d8abf544f24bd2778e20", v2ReceiptSha256: "5fd3cc18a888bd9a11f06db2996a9cff284aae3ff52b3c47eb0609d16a4200cf", reuseR2ReceiptSha256: "2af9433e5de8a5737bcd3791f1cee57adff015686cb9b3238ff73ac607ba72fe", inputSha256: "f72dd4ec4f2591a9fd7c291ca04758e22c9b2f062dfccdf629b08ccd3f812513", methodSha256: "21ad9b9c28aed72024cc11e64c64d26d36bf865d011020bd9f34daec7acd1509"};
  if (canonical(bindings) !== canonical(pinnedBindings)) fail();
  if (!Array.isArray(value.cases) || value.cases.length !== 12) fail();
  const ids = new Set<string>();
  const cases = value.cases.map((rawCase: unknown) => {
    const row = object(rawCase, ["id", "inputSha256", "rawInput"]), id = text(row.id, 64), rawInput = row.rawInput;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || ids.has(id) || typeof rawInput !== "string" || Buffer.byteLength(rawInput) > INPUT_BYTES || hash(rawInput) !== digest(row.inputSha256)) fail(); ids.add(id);
    const wrapper = object(json(Buffer.from(rawInput)), ["v", "id", "trial", "scenario", "input"]);
    if (wrapper.v !== 1 || wrapper.id !== id || wrapper.trial !== "supervision" || !["ordinary-progress", "true-trigger", "misleading-symptom"].includes(wrapper.scenario)) fail();
    const input = object(wrapper.input, ["request", "facts"]); text(input.request, 4000);
    if (!input.facts || typeof input.facts !== "object" || Array.isArray(input.facts) || !Array.isArray(input.facts.tasks)) fail();
    return {id, inputSha256: row.inputSha256 as string, rawInput};
  });
  return {code, bindings, cases};
}

// Child mode receives one bounded raw input on stdin and produces only a snapshot envelope.
async function child(args: string[]): Promise<void> {
  if (args.length !== 3) fail();
  const [root, expectedModule, home] = args as [string, string, string];
  if (producerIdentity(root, home) !== digest(expectedModule)) fail();
  let length = 0; const parts: Buffer[] = [];
  for await (const chunk of process.stdin) {const bytes = Buffer.from(chunk); length += bytes.length; if (length > INPUT_BYTES) fail(); parts.push(bytes);}
  const input = object(json(Buffer.concat(parts)), ["request", "facts"]);
  const imported = await import(pathToFileURL(join(root, MODULE)).href);
  if (typeof imported.ShadowSupervisor !== "function") fail();
  let observeCalled = false;
  try {
    const supervisor = new imported.ShadowSupervisor();
    observeCalled = true; supervisor.observe(input.facts);
    const snapshot = supervisor.snapshot();
    const result = JSON.stringify({snapshot, observeCalled});
    if (Buffer.byteLength(result) > FILE_BYTES) fail();
    process.stdout.write(result);
  } catch {
    process.stdout.write(JSON.stringify({snapshot: null, observeCalled})); process.exitCode = 1;
  }
}
async function main(args: string[]): Promise<void> {
  const started = performance.now(), cpuStart = process.cpuUsage();
  if (args.length !== 4) fail();
  const [producerArg, requestArg, outputArg, imageDigest] = args as [string, string, string, string];
  const producer = resolve(producerArg), requestFile = resolve(requestArg), output = resolve(outputArg), self = realpathSync(import.meta.path);
  if (!isAbsolute(producerArg) || !isAbsolute(requestArg) || !isAbsolute(outputArg) || existsSync(output)) fail();
  const parent = dirname(output), parentStat = lstatSync(parent), uid = process.getuid?.();
  if (!parentStat.isDirectory() || realpathSync(parent) !== parent || uid === undefined || parentStat.uid !== uid || (parentStat.mode & 0o022)) fail();
  const env = environment(imageDigest), requestBytes = read(requestFile, REQUEST_BYTES), supplied = request(json(requestBytes)), generatorBytes = read(self, REQUEST_BYTES), generatorSha256 = hash(generatorBytes);
  const sourceReservedBytes = requestBytes.length + generatorBytes.length + supplied.cases.reduce((sum, row) => sum + Buffer.byteLength(row.rawInput), 0);
  if (sourceReservedBytes + FILE_BYTES * 145 > RETAINED_BYTES) fail();
  const cgroupCpuStart = cgroupCpuSeconds();
  const workspace = mkdtempSync(join(tmpdir(), "ares-supervision-generation-"));
  let outputCreated = false;
  try {
    const moduleHash = producerIdentity(producer, workspace), environmentSha256 = hash(canonical(env));
    const inputs = supplied.cases.map((row, index) => {const file = join(workspace, `input-${index}.json`); privateInput(file, row.rawInput); return file;});
    mkdirSync(output, {mode: 0o700}); outputCreated = true;
    const slots: {file: string; sha256: string}[] = [];
    let observeCalls = 0, observeCallsUnknown = false, stopped = false, retained = 0;
    for (const [caseIndex, row] of supplied.cases.entries()) for (const [repetition, order] of ORDERS.entries()) for (const condition of ["cold", "warm"] as const) {
      if (hash(read(self, REQUEST_BYTES)) !== generatorSha256 || !read(requestFile, REQUEST_BYTES).equals(requestBytes)) fail();
      const slot = {caseIndex, repetition, condition, permutation: [...order], shadowIndex: order.indexOf("B")};
      let status: "succeeded" | "failed" | "unknown" = "unknown", snapshot: unknown = null, failure: null | "producer-failed" | "producer-unknown" | "case-budget" | "budget-stopped" = "budget-stopped";
      let costs: {wallMs: number; cpuSeconds: number; memoryRssBytes: number} | null = null;
      const elapsed = performance.now() - started, usedCpu = Math.max(cgroupCpuSeconds() - cgroupCpuStart, usageSeconds(cpuStart));
      if (elapsed >= WALL_MS || usedCpu >= CPU_SECONDS || sourceReservedBytes + retained + FILE_BYTES * (145 - slots.length) > RETAINED_BYTES) stopped = true;
      if (!stopped) {
        const slotWall = performance.now(), slotCgroupCpu = cgroupCpuSeconds();
        const rawInput = condition === "cold" ? decode(read(inputs[caseIndex]!, INPUT_BYTES)) : row.rawInput;
        if (hash(rawInput) !== row.inputSha256) fail();
        let childResult: ReturnType<typeof Bun.spawnSync> | undefined;
        try {childResult = Bun.spawnSync([process.execPath, "--smol", self, "--slot", producer, moduleHash, workspace], {env: {...gitEnv(workspace), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, AGENTHUB_HOME: join(workspace, "family")}, cwd: workspace, stdin: Buffer.from(JSON.stringify(JSON.parse(rawInput).input)), stdout: "pipe", stderr: "pipe", timeout: Math.max(1, Math.min(CASE_WALL_MS, WALL_MS - (performance.now() - started))), maxBuffer: FILE_BYTES});}
        catch {observeCallsUnknown = true; failure = "producer-unknown"; stopped = true;}
        if (childResult) {
          const wallMs = performance.now() - slotWall, usage = childResult.resourceUsage;
          const cpuSeconds = usage ? Number(usage.cpuTime.total) / 1_000_000 : NaN, memoryRssBytes = usage ? Number(usage.maxRSS) : NaN;
          let result: Record<string, any> | null = null;
          try {result = object(json(childResult.stdout), ["snapshot", "observeCalled"]); if (typeof result.observeCalled !== "boolean") fail(); if (result.observeCalled) observeCalls++;} catch {result = null;}
          if (!result) observeCallsUnknown = true;
          if (![wallMs, cpuSeconds, memoryRssBytes].every(value => Number.isFinite(value) && value >= 0) || memoryRssBytes === 0) {failure = "producer-unknown"; stopped = true;}
          else {
            costs = {wallMs, cpuSeconds, memoryRssBytes};
            if (childResult.exitedDueToTimeout || childResult.exitedDueToMaxBuffer || wallMs > CASE_WALL_MS || cpuSeconds > CASE_CPU_SECONDS || cgroupCpuSeconds() - slotCgroupCpu > CASE_CPU_SECONDS || memoryRssBytes > CASE_RSS) {status = "failed"; failure = "case-budget"; stopped = true;}
            else if (childResult.signalCode || !result) {failure = "producer-unknown"; stopped = true;}
            else if (childResult.exitCode !== 0 || result.snapshot === null) {status = "failed"; failure = "producer-failed";}
            else if (!result.observeCalled) {failure = "producer-unknown"; stopped = true;}
            else {status = "succeeded"; failure = null; snapshot = result.snapshot;}
          }
        }
      }
      const filename = `slot-${String(slots.length).padStart(3, "0")}.json`;
      retained += writeNew(join(output, filename), {v: 1, slot, caseId: row.id, inputSha256: row.inputSha256, status, snapshot, failure, costs});
      slots.push({file: filename, sha256: hash(read(join(output, filename), FILE_BYTES))});
    }
    if (producerIdentity(producer, workspace) !== moduleHash || hash(read(self, REQUEST_BYTES)) !== generatorSha256 || !read(requestFile, REQUEST_BYTES).equals(requestBytes)) fail();
    for (const [index, row] of supplied.cases.entries()) if (hash(read(inputs[index]!, INPUT_BYTES)) !== row.inputSha256) fail();
    const containerCpuSeconds = cgroupCpuSeconds() - cgroupCpuStart;
    if (!Number.isFinite(containerCpuSeconds) || containerCpuSeconds < 0) fail();
    const generation = {containerCpuSeconds, containerCpuScope: "admitted-container-cgroup", wallMs: performance.now() - started, cpuSeconds: usageSeconds(cpuStart), cpuScope: "generator-parent-process-only", slotCpuScope: "slot-child-process", subprocessCpuSeconds: "unknown", observeCalls, observeCallsScope: "confirmed-child-receipts", observeCallsUnknown, freshShadowPerSlot: true, coldInput: "reread-private-bytes", warmInput: "retained-input-bytes-only", coldness: "not-os-or-jit"};
    const manifest = {v: 1, kind: "supervision-shadow-generated-records", code: supplied.code, environment: env,
      bindings: {...supplied.bindings, codeCommit: supplied.code.commit, codeTree: supplied.code.tree, codeSha256: supplied.code.codeSha256, producerCommit: PIN, producerModuleSha256: moduleHash, generatorSha256, imageDigest, environmentSha256}, generation, slots};
    retained += writeNew(join(output, "manifest.json"), manifest);
    if (sourceReservedBytes + retained > RETAINED_BYTES) fail();
    console.log(JSON.stringify({status: "generated-not-scored", slots: slots.length, observeCalls, manifestSha256: hash(read(join(output, "manifest.json"), FILE_BYTES))}));
  } finally {
    rmSync(workspace, {recursive: true, force: true});
    // Never delete completed or failed slot evidence from a created output directory.
    if (outputCreated && !existsSync(output)) fail();
  }
}
try {
  const args = process.argv.slice(2);
  if (args[0] === "--slot") await child(args.slice(1)); else await main(args);
} catch {console.error("supervision generation refused; preserve any existing slot evidence and inspect immutable input, producer and admission bindings before retrying"); process.exitCode = 1;}
