import {expect, test} from "bun:test";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {existsSync, mkdirSync, realpathSync} from "node:fs";
import {join} from "node:path";
import {readScreenedAmem} from "../src/memory/amem-show.ts";
import {readTextBounded, writeAtomic, sha256} from "../src/study.ts";
import {canonical} from "../src/plan/state.ts";
import {tempDir} from "./helpers.ts";

const id = "a".repeat(32), PRIVATE = "synthetic-private-diagnostic";
const view = {id, kind: "finding", text: "Synthetic process-only body", at: "2030-01-01T00:00:00Z", project: "synthetic-process-project", source: "cli"};
function fixture(mode: "success" | "hang-child" | "exit-child" | "combined" | "stderr-error") {
  const home = realpathSync(tempDir()), bin = join(home, "bin"), executable = join(bin, "amem"), record = join(home, "owned-processes.json"), observed = join(home, "observed.json"), marker = `synthetic-owned-${randomUUID()}`;
  mkdirSync(bin);
  const studyModule = new URL("../src/study.ts", import.meta.url).href;
  const childProgram = "process.stdout.write('ready\\n');setInterval(()=>{},1000);";
  const script = `#!${process.execPath}
import {createInterface} from "node:readline";
import {spawn} from "node:child_process";
import {writeAtomic} from ${JSON.stringify(studyModule)};
const mode=${JSON.stringify(mode)}, record=${JSON.stringify(record)}, observed=${JSON.stringify(observed)}, marker=${JSON.stringify(marker)};
if (process.argv.slice(2).join(' ')!=='mcp') throw new Error('unexpected synthetic command');
if (process.env.ANTHROPIC_API_KEY || process.env.DOCKER_HOST) throw new Error('unexpected inherited environment');
if (mode==='hang-child' || mode==='exit-child') {
 const child=spawn(process.execPath,['-e',${JSON.stringify(childProgram)},marker],{stdio:['ignore','pipe','ignore']});
 writeAtomic(record,JSON.stringify({leader:process.pid,child:child.pid,marker,ready:false}),1024,0o600);
 child.stdout.once('data',()=>{writeAtomic(record,JSON.stringify({leader:process.pid,child:child.pid,marker,ready:true}),1024,0o600);if(mode==='exit-child')process.exit(0);});
 process.stdin.resume();setInterval(()=>{},1000);
} else {
 const emit=(request,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
 const reader=createInterface({input:process.stdin});
 reader.on('line',line=>{
  const request=JSON.parse(line);
  if(request.method==='notifications/initialized') return;
  if(request.method==='initialize') {
   if(mode==='combined') process.stderr.write('z'.repeat(2500));
   if(mode==='stderr-error') {process.stderr.write(${JSON.stringify(PRIVATE)}.repeat(300));process.exitCode=7;reader.close();process.stdin.destroy();return;}
   emit(request,{serverInfo:{name:'amem',version:'0.22.1'}});
  } else if(request.method==='tools/list') {
   if(mode==='combined') process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/synthetic',params:{padding:'x'.repeat(2000)}})+'\\n');
   emit(request,{tools:[{name:'amem_show',inputSchema:{type:'object',properties:{id:{type:'string',maxLength:80}},required:['id'],additionalProperties:false}}]});
  } else if(request.method==='tools/call') {
   writeAtomic(observed,JSON.stringify({id:request.params.arguments.id,cwd:process.cwd(),home:process.env.HOME,args:process.argv.slice(2)}),4096,0o600);
   emit(request,{content:[{type:'text',text:JSON.stringify(${JSON.stringify(view)})}]});
  }
 });
}
`;
  writeAtomic(executable, script, 65_536, 0o700);
  return {home, bin, executable, record, observed, marker, env: {HOME: home, PATH: bin, AMEM_HOME: join(home, "synthetic-amem-home"), ANTHROPIC_API_KEY: "synthetic-forbidden", DOCKER_HOST: "synthetic-forbidden"}};
}
interface Owned {leader: number; child: number; marker: string; ready: boolean}
function identity(pid: number, home: string) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid=", "-o", "stat=", "-o", "args="], {env: {HOME: home, PATH: "/usr/bin:/bin"}, encoding: "utf8", timeout: 1000, maxBuffer: 4096});
  if (result.error) throw new Error("cannot inspect the owned synthetic process");
  if (result.status === 1 && !result.stdout.trim()) return {running: false, group: -1, args: ""};
  const match = /^\s*([0-9]+)\s+(\S+)\s+([\s\S]*)$/.exec(result.stdout);
  if (result.status !== 0 || !match) throw new Error("invalid owned process identity metadata");
  return {group: Number(match[1]), running: !match[2]!.startsWith("Z"), args: match[3]!};
}
function cleanup(f: ReturnType<typeof fixture>, owned: Owned | undefined) {
  if (!owned || owned.marker !== f.marker || !Number.isSafeInteger(owned.leader) || !Number.isSafeInteger(owned.child)) return;
  // Signal only a still-owned live group. Never signal a bare PID after it could have been reused.
  const members = [owned.leader, owned.child].map(pid => identity(pid, f.home));
  if (members.some(member => member.running && member.group === owned.leader && (member.args.includes(f.marker) || member.args.includes(f.executable)))) {
    try {process.kill(-owned.leader, "SIGKILL");} catch (error) {if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;}
  }
}

test("native transport invokes only the synthetic exact-id MCP executable with private HOME", async () => {
  const f = fixture("success"), result = await readScreenedAmem(f.home, id, {env: f.env, timeoutMs: 4000, maxOutputBytes: 4096});
  expect(result).toMatchObject({state: "available", digest: sha256(canonical(view)), sourceVersion: "0.22.1", kind: "finding"});
  expect(JSON.parse(readTextBounded(f.observed, 4096))).toEqual({id, cwd: f.home, home: f.home, args: ["mcp"]});
  for (const value of [view.text, view.project, f.home]) expect(JSON.stringify(result)).not.toContain(value);
}, 10_000);

test("native transport spawn failure stays unavailable without real PATH fallback", async () => {
  const home = realpathSync(tempDir()), bin = join(home, "empty-bin"); mkdirSync(bin);
  const result = await readScreenedAmem(home, id, {env: {HOME: home, PATH: bin}, timeoutMs: 250, maxOutputBytes: 4096});
  expect(result.state).toBe("unavailable"); expect(result.digest).toBeNull(); expect(JSON.stringify(result)).not.toContain(home);
});

for (const mode of ["combined", "stderr-error"] as const) test(`native ${mode} output refuses at the total stdout/stderr cap`, async () => {
  const f = fixture(mode), result = await readScreenedAmem(f.home, id, {env: f.env, timeoutMs: 4000, maxOutputBytes: 4096});
  expect(result.state).toBe("unavailable"); expect(result.digest).toBeNull();
  expect(JSON.stringify(result)).not.toContain(PRIVATE); expect(JSON.stringify(result)).not.toContain(f.home);
});

for (const mode of ["hang-child", "exit-child"] as const) test(`${mode === "hang-child" ? "deadline" : "leader exit"} cleans the owned synthetic process group including its forked child`, async () => {
  const f = fixture(mode); let owned: Owned | undefined;
  try {
    const result = await readScreenedAmem(f.home, id, {env: f.env, timeoutMs: mode === "hang-child" ? 2000 : 4000, maxOutputBytes: 4096});
    expect(result.state).toBe("unavailable"); expect(result.digest).toBeNull();
    expect(existsSync(f.record)).toBe(true); owned = JSON.parse(readTextBounded(f.record, 1024)) as Owned;
    expect(owned.marker).toBe(f.marker); expect(owned.ready).toBe(true);
    // Give the kernel one short turn to deliver SIGKILL/reap; there is no product retry or polling loop.
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    expect(identity(owned.leader, f.home).running).toBe(false); expect(identity(owned.child, f.home).running).toBe(false);
  } finally {
    if (!owned && existsSync(f.record)) owned = JSON.parse(readTextBounded(f.record, 1024)) as Owned;
    cleanup(f, owned);
  }
}, 10_000);
