import { fileURLToPath } from "node:url";
import { version } from "../../package.json";
import { canonical, type ProtocolDefinition } from "./protocol.ts";
import { readSelection } from "./selection.ts";
import { readFinalSeeds } from "./final.ts";
import { runOnExecutor, spawnRunner } from "./executor.ts";
import { openStudy, plain, readBytesBounded, sha256 } from "../study.ts";
import type { Attempt, AttemptContext } from "./attempts.ts";

export interface StageReuseSourceFacts {
  populationSha256: string;
  runtime: { semantics: string; producerVersion: string };
  platform: { os: string; arch: string; abi: string };
}
export type StageReuseSourceMissReason = "unsupported-study" | "outside-investigation" | "population-unavailable" | "population-changed" | "unsupported-gpu-abi" | "producer-runtime-unavailable" | "producer-source-unavailable" | "platform-unavailable" | "unsupported-platform";
export type StageReuseSourceFactsResult = StageReuseSourceFacts | { reason: StageReuseSourceMissReason };
export const REUSE_FACTS_OUTPUT_BYTES = 4096, REUSE_FACTS_TIMEOUT_MS = 5000;
const PRODUCER_SOURCE_BYTES = 256 * 1024;
const PRODUCER_SOURCES = ["attempts.ts", "pipeline.ts", "executor.ts", "retention-script.ts", "reuse.ts", "reuse-runtime.ts", "reuse-admission.ts", "metrics.ts"] as const;
const PLATFORM_SCRIPT = String.raw`import hashlib,json,os,platform,subprocess,sys
cpu={'count':os.cpu_count(),'byteorder':sys.byteorder}
if sys.platform=='linux':
    with open('/proc/cpuinfo','rb') as f:
        block=f.read(65537).split(b'\n\n',1)[0]
    if len(block)>65536: raise ValueError('unsupported CPU metadata')
    keys={'vendor_id','cpu family','model','model name','stepping','microcode','flags','Features','CPU implementer','CPU architecture','CPU variant','CPU part','CPU revision'}
    fields={}
    for line in block.decode('utf8',errors='strict').splitlines():
        if ':' in line:
            key,value=line.split(':',1)
            if key.strip() in keys: fields[key.strip()]=value.strip()
    if not fields: raise ValueError('unsupported CPU metadata')
    cpu['fields']=fields
elif sys.platform=='darwin':
    cpu['fields']={key:subprocess.check_output(['/usr/sbin/sysctl','-n',key],timeout=1).decode().strip() for key in ['hw.model','hw.cpufamily','hw.cpusubtype']}
else: raise ValueError('unsupported CPU ABI')
cpu_hash=hashlib.sha256(json.dumps(cpu,sort_keys=True,separators=(',',':')).encode()).hexdigest()
libc=platform.libc_ver()
print(json.dumps({'v':1,'os':sys.platform,'arch':platform.machine(),'kernel':platform.release(),'libc':{'name':libc[0],'version':libc[1]},'macVersion':platform.mac_ver()[0],'cpuSha256':cpu_hash,'uid':os.getuid(),'gid':os.getgid()},separators=(',',':')))`;
const identity = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/\p{Cc}/u.test(value) && Buffer.byteLength(value) <= 128;

function population(dir: string, protocol: ProtocolDefinition) {
  const selection = readSelection(dir, protocol), reservedSeeds = readFinalSeeds(dir, protocol);
  // Null is deliberate: an absent file is different from any present reservation value.
  return { selection, sha256: sha256(canonical({ v: 1, selection: selection ?? null, reservedSeeds: reservedSeeds ?? null })) };
}
function producerSemantics(): string | undefined {
  const bun = process.versions.bun;
  if (!identity(bun)) return undefined;
  const sources = PRODUCER_SOURCES.map(name => [name, sha256(readBytesBounded(fileURLToPath(new URL(`./${name}`, import.meta.url)), PRODUCER_SOURCE_BYTES))]);
  return `ares-stage-v2/reuse-1:${sha256(canonical({ bun, sources }))}`;
}
export function isInvestigationRun(run: string, selection: { run: string } | undefined): boolean {
  return selection?.run === run && !["ablate", "final", "posthoc"].includes(run);
}

/** Read-only, source-owned facts. Caller still owns current design/policy/budget fencing at admission. */
export async function reuseSourceFacts(dir: string, attempt: Attempt, ctx: AttemptContext): Promise<StageReuseSourceFactsResult> {
  const protocol = attempt.pipeline?.definition ?? attempt.protocol;
  let before: ReturnType<typeof population>;
  try {
    const { study } = openStudy(dir);
    if (study.mode !== "experiment" || study.id !== attempt.studyId) return { reason: "unsupported-study" };
    before = population(dir, protocol);
  } catch { return { reason: "population-unavailable" }; }
  if (attempt.stage !== "candidate" || !isInvestigationRun(attempt.run, before.selection)) return { reason: "outside-investigation" };
  if (protocol.limits.gpus > 0) return { reason: "unsupported-gpu-abi" };
  if (!identity(process.versions.bun)) return { reason: "producer-runtime-unavailable" };
  let semantics: string | undefined;
  try { semantics = producerSemantics(); } catch { return { reason: "producer-source-unavailable" }; }
  if (!semantics) return { reason: "producer-runtime-unavailable" };
  let response;
  try {
    response = await runOnExecutor(attempt.executor, "python3", ["-I", "-S", "-c", PLATFORM_SCRIPT], ctx.runner ?? spawnRunner, { timeoutMs: REUSE_FACTS_TIMEOUT_MS, maxOutputBytes: REUSE_FACTS_OUTPUT_BYTES });
  } catch { return { reason: "platform-unavailable" }; }
  if (response.exitCode !== 0 || response.timedOut || response.truncated) return { reason: "platform-unavailable" };
  let value: unknown;
  try { value = JSON.parse(response.stdout); } catch { return { reason: "unsupported-platform" }; }
  if (!plain(value) || Object.keys(value).some(key => !["v", "os", "arch", "kernel", "libc", "macVersion", "cpuSha256", "uid", "gid"].includes(key)) || value.v !== 1 || !Number.isSafeInteger(value.uid) || (value.uid as number) < 0 || !Number.isSafeInteger(value.gid) || (value.gid as number) < 0 || typeof value.cpuSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.cpuSha256) || !["linux", "darwin"].includes(String(value.os)) || !identity(value.os) || !identity(value.arch) || !["x86_64", "amd64", "AMD64", "aarch64", "arm64"].includes(value.arch) || !identity(value.kernel) || !plain(value.libc) || Object.keys(value.libc).some(key => !["name", "version"].includes(key))) return { reason: "unsupported-platform" };
  if (value.os === "linux" && (!identity(value.libc.name) || !identity(value.libc.version))) return { reason: "unsupported-platform" };
  if (value.os === "darwin" && !identity(value.macVersion)) return { reason: "unsupported-platform" };
  if (typeof value.macVersion !== "string" || typeof value.libc.name !== "string" || typeof value.libc.version !== "string" || Buffer.byteLength(value.macVersion) > 128 || Buffer.byteLength(value.libc.name) > 128 || Buffer.byteLength(value.libc.version) > 128 || /\p{Cc}/u.test(`${value.macVersion}${value.libc.name}${value.libc.version}`)) return { reason: "unsupported-platform" };
  try {
    const current = openStudy(dir).study;
    if (current.mode !== "experiment" || current.id !== attempt.studyId) return { reason: "population-changed" };
    const after = population(dir, protocol);
    if (after.sha256 !== before.sha256 || after.selection?.run !== attempt.run) return { reason: "population-changed" };
  } catch { return { reason: "population-changed" }; }
  return { populationSha256: before.sha256, runtime: { semantics, producerVersion: version }, platform: { os: value.os, arch: value.arch,
    abi: `cpu-v1:${sha256(canonical({ observed: value, executor: attempt.executor }))}` } };
}
