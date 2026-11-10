export { metricProtocol, metricAttempt } from "../scripts/execution-native-fixtures.ts";
import { shellQuote, spawnRunner, type ProcessRunner } from "../src/exp/executor.ts";
import { LOG_COPY_BYTES } from "../src/exp/metrics.ts";

/** Synthetic USTAR records; no real data or Docker process is involved. */
export function metricTar(entries: { path: string; data?: string | Uint8Array; type?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = typeof entry.data === "string" ? Buffer.from(entry.data) : Buffer.from(entry.data ?? []), header = Buffer.alloc(512);
    if (Buffer.byteLength(entry.path) > 100) throw new Error("synthetic tar fixture path too long");
    header.write(entry.path, 0); header.write("0000644", 100); header.write("0001000", 108); header.write("0001000", 116);
    header.write(content.length.toString(8).padStart(11, "0"), 124); header.write("00000000000", 136); header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156); header.write("ustar", 257); header.write("00", 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"), 148); header[154] = 0; header[155] = 32;
    parts.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
export function metricLogTar(stage: "candidate" | "evaluator", stdout: string, stderr = "", cuts = { stdout: false, stderr: false }): Buffer {
  return metricTar([{ path: `logs/${stage}.stdout.log`, data: stdout }, { path: `logs/${stage}.stderr.log`, data: stderr }, { path: `logs/${stage}.state.json`, data: JSON.stringify(cuts) }]);
}
/** Execute the real private-copy shell with an oversized local fixture, replacing Docker before execution. */
export function logCaptureFixtureRunner(fallback?: ProcessRunner): ProcessRunner {
  const producer = `process.stderr.write('fixture stderr context\\n'); process.stdout.on('error',()=>process.exit(17)); process.stdout.write('x'.repeat(${LOG_COPY_BYTES + 1024}),()=>process.exit(17));`;
  return async request => {
    if (request.command === "sh" && request.stdoutSink && request.args[1]?.includes("docker logs")) {
      const script = request.args[1].replace(/docker logs [a-f0-9]{64}/, `${shellQuote(process.execPath)} -e ${shellQuote(producer)}`);
      if (script.includes("docker logs")) throw new Error("synthetic runner refused an unhandled Docker command");
      // Exercise binary Darwin metadata even on CI Macs without automatic provenance.
      const decorated = process.platform === "darwin" ? script.replace(/\n(?=(?:COPYFILE_DISABLE=1 )?tar )/, '\nfor file in "$out" "$err" "$state"; do xattr -w -x user.ares.synthetic 00ff "$file"; done\n') + '\nfor file in "$out" "$err" "$state"; do xattr -p user.ares.synthetic "$file" > /dev/null; done' : script;
      return spawnRunner({ ...request, args: ["-c", decorated] });
    }
    if (fallback) return fallback(request);
    throw new Error("unscripted synthetic fixture process");
  };
}
