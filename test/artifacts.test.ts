import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ArtifactError, ARTIFACT_BYTES, ARTIFACT_CAPTURE_BYTES, ARTIFACT_FILES, ARTIFACT_METADATA_BYTES, ARTIFACT_WIRE_BYTES, readArtifactArchive } from "../src/exp/artifacts.ts";
import type { ArtifactArchiveOptions, ArtifactErrorCode } from "../src/exp/artifacts.ts";
import type { Executor, ProcessRequest, ProcessRunner } from "../src/exp/executor.ts";

const executor: Executor = { v: 1, kind: "local", workdir: "/private/synthetic" };
const end = Buffer.alloc(1024), digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function checksum(header: Buffer): Buffer {
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}
function header(name: string, size = 0, type = "0", prefix = ""): Buffer {
  const block = Buffer.alloc(512);
  Buffer.from(name).copy(block, 0, 0, 100);
  block.write("0000644\0", 100, "ascii"); block.write("0000000\0", 108, "ascii"); block.write("0000000\0", 116, "ascii");
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii"); block.write("00000000000\0", 136, "ascii");
  block.write(type, 156, "ascii"); block.write("ustar\0", 257, "ascii"); block.write("00", 263, "ascii");
  Buffer.from(prefix).copy(block, 345, 0, 155);
  return checksum(block);
}
function entry(name: string, content: string | Uint8Array = "", type = "0", declaredSize?: number): Buffer {
  const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  return Buffer.concat([header(name, declaredSize ?? bytes.length, type), bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}
function pax(values: Record<string, string>, type = "x"): Buffer {
  const records = Object.entries(values).map(([key, value]) => {
    const record = `${key}=${value}\n`, bytes = Buffer.byteLength(record);
    let length = bytes + 2;
    while (String(length).length + 1 + bytes !== length) length = String(length).length + 1 + bytes;
    return `${length} ${record}`;
  });
  return entry("PaxHeaders/synthetic", records.join(""), type);
}
function scripted(archive: Uint8Array, chunk = 137) {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = async request => {
    requests.push(request);
    for (let offset = 0; offset < archive.byteLength; offset += chunk) await request.stdoutSink!(archive.subarray(offset, offset + chunk));
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, requests };
}
async function read(archive: Uint8Array, options: ArtifactArchiveOptions = {}, chunk = 137) {
  return readArtifactArchive(executor, "tar", ["-cf", "-", "synthetic"], scripted(archive, chunk).runner, options);
}
async function errorCode(archive: Uint8Array, code: ArtifactErrorCode, options: ArtifactArchiveOptions = {}) {
  const fake = scripted(archive);
  try { await readArtifactArchive(executor, "tar", ["-cf", "-", "synthetic"], fake.runner, options); throw new Error("unexpected success"); }
  catch (error) {
    expect(error).toBeInstanceOf(ArtifactError); expect((error as ArtifactError).code).toBe(code);
    expect((error as Error).message).toContain("then rerun ares attempt reconcile");
    expect(fake.requests[0]?.signal?.aborted).toBe(true);
  }
}

test("artifact tar parsing hashes binary files and captures only the selected payload", async () => {
  const binary = Buffer.alloc(30_000); for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
  const metrics = Buffer.from('{"score":1}'), archive = Buffer.concat([entry("./", "", "5"), entry("./binary.bin", binary), entry("./metrics.json", metrics), end]);
  const result = await read(archive, { capture: "metrics.json" }, 1);
  expect(result.files).toEqual([{ path: "binary.bin", bytes: binary.length, sha256: digest(binary) }, { path: "metrics.json", bytes: metrics.length, sha256: digest(metrics) }]);
  expect(result.captured).toEqual(metrics);
  const hashOnly = await read(archive);
  expect(hashOnly.files).toEqual(result.files);
  expect(hashOnly.captured).toBeUndefined();
});

test("zero-byte capture, absent capture and empty archives are distinct", async () => {
  const empty = await read(Buffer.concat([entry("empty"), end]), { capture: "empty", captureBytes: 0 });
  expect(empty.captured).toEqual(Buffer.alloc(0)); expect(empty.files).toEqual([{ path: "empty", bytes: 0, sha256: digest(Buffer.alloc(0)) }]);
  expect(await read(end, { capture: "missing" })).toEqual({ files: [] });
});

test("PAX local paths/sizes and global metadata are bounded and applied only to their intended entries", async () => {
  const archive = Buffer.concat([pax({ mtime: "1.25", uid: "1000" }, "g"), pax({ path: "result/metrics.json", size: "3" }), entry("placeholder", "abc", "0", 0), entry("other", "xy"), end]);
  const result = await read(archive, { capture: "result/metrics.json" }, 47);
  expect(result.files.map(file => [file.path, file.bytes])).toEqual([["result/metrics.json", 3], ["other", 2]]); expect(result.captured).toEqual(Buffer.from("abc"));
  const global = Buffer.concat([pax({ size: "1" }, "g"), entry("first", "a", "0", 0), pax({ size: "" }, "g"), entry("second", "bc"), end]);
  expect((await read(global)).files.map(file => file.bytes)).toEqual([1, 2]);
});

test("GNU long-name and USTAR prefixes preserve UTF-8 paths across arbitrary stream chunks", async () => {
  const long = "目录/".repeat(30) + "metrics.json";
  const archive = Buffer.concat([entry("././@LongLink", long + "\0", "L"), entry(long, "value"), header("nested", 0, "0", "prefix"), end]);
  const result = await read(archive, { capture: long }, 511);
  expect(result.files.map(file => file.path)).toEqual([long, "prefix/nested"]); expect(result.captured).toEqual(Buffer.from("value"));
  const paxArchive = Buffer.concat([pax({ path: "目录/" }), header("placeholder", 0, "5"), pax({ path: long }), entry("placeholder", "pax value"), end]);
  expect((await read(paxArchive, { capture: long }, 19)).captured).toEqual(Buffer.from("pax value"));
});

test("links, devices, FIFOs and sparse extensions never become artifacts", async () => {
  for (const type of ["1", "2", "3", "4", "6", "S"]) await errorCode(Buffer.concat([header("synthetic", 0, type), end]), "invalid-artifact");
  for (const key of ["linkpath", "GNU.sparse.map", "SCHILY.filetype", "SCHILY.realsize"]) await errorCode(Buffer.concat([pax({ [key]: "synthetic" }), entry("synthetic"), end]), "invalid-artifact");
});

test("absolute, traversal, control and conflicting paths are refused without echoing names", async () => {
  for (const name of ["/private/sensitive", "../sensitive", "a/../sensitive", "C:/sensitive", "bad\\path", "bad\npath", "bad\tpath"]) await errorCode(Buffer.concat([entry(name), end]), "invalid-artifact");
  await errorCode(Buffer.concat([entry("a"), entry("./a"), end]), "invalid-artifact");
  await errorCode(Buffer.concat([entry("a"), entry("a/file"), end]), "invalid-artifact");
  await errorCode(Buffer.concat([entry("a/file"), entry("a"), end]), "invalid-artifact");
  await errorCode(Buffer.concat([pax({ path: "../sensitive" }), entry("placeholder"), end]), "invalid-artifact");
});

test("checksums, payloads, padding and both end markers must be complete", async () => {
  const badChecksum = header("synthetic"); badChecksum[0] = 120;
  const nonzeroPadding = entry("synthetic", "x"); nonzeroPadding[513] = 1;
  const badSize = header("synthetic"); badSize.write("not-octal", 124, "ascii"); checksum(badSize);
  const highBitOctal = header("synthetic"); highBitOctal[125] = highBitOctal[125]! | 128; checksum(highBitOctal);
  for (const archive of [Buffer.concat([badChecksum, end]), header("synthetic").subarray(0, 511), Buffer.concat([header("synthetic", 10), Buffer.from("ab")]), Buffer.concat([nonzeroPadding, end]), Buffer.concat([entry("synthetic"), Buffer.alloc(512)]), Buffer.concat([end, Buffer.from([1])]), Buffer.concat([badSize, end]), Buffer.concat([highBitOctal, end]), Buffer.concat([pax({ path: "dangling" }), end]), Buffer.concat([entry("PaxHeaders/synthetic", "999 path=x\n", "x"), entry("placeholder"), end])]) await errorCode(archive, "invalid-artifact");
});

test("file count, aggregate payload, metadata and selected capture limits refuse before buffering payload", async () => {
  expect((await read(Buffer.concat([...Array.from({ length: ARTIFACT_FILES }, (_, i) => entry(`file-${i}`)), end]))).files).toHaveLength(ARTIFACT_FILES);
  await errorCode(Buffer.concat([...Array.from({ length: ARTIFACT_FILES + 1 }, (_, i) => entry(`file-${i}`)), end]), "artifact-limit");
  await errorCode(header("huge", ARTIFACT_BYTES + 1), "artifact-limit");
  await errorCode(header("metadata", ARTIFACT_METADATA_BYTES + 1, "x"), "artifact-limit");
  await errorCode(header("metrics.json", ARTIFACT_CAPTURE_BYTES + 1), "artifact-limit", { capture: "metrics.json" });
  const exact = Buffer.alloc(ARTIFACT_CAPTURE_BYTES, 120);
  expect((await read(Buffer.concat([entry("metrics.json", exact), end]), { capture: "metrics.json" })).captured).toEqual(exact);
});

test("wire-byte overhead is bounded even for endless zero padding", async () => {
  const chunk = Buffer.alloc(1024 * 1024); let bytes = 0;
  const runner: ProcessRunner = async request => { for (;;) { await request.stdoutSink!(chunk); bytes += chunk.length; } };
  try { await readArtifactArchive(executor, "tar", [], runner); throw new Error("unexpected success"); }
  catch (error) { expect((error as ArtifactError).code).toBe("artifact-limit"); expect(bytes).toBeLessThanOrEqual(ARTIFACT_WIRE_BYTES); }
});

test("remaining attempt budgets stop archives before exceeding caller file or byte bounds", async () => {
  const archive = Buffer.concat([entry("first", "abc"), entry("second", "xy"), end]);
  await errorCode(archive, "artifact-limit", { maxBytes: 4 });
  await errorCode(archive, "artifact-limit", { maxFiles: 1 });
  expect((await read(archive, { maxBytes: 5, maxFiles: 2 })).files.map(file => file.bytes)).toEqual([3, 2]);
  await errorCode(Buffer.concat([entry("empty"), end]), "artifact-limit", { maxFiles: 0 });
});

test("runner failures and parser errors retain only safe cause classes and abort the producer", async () => {
  const secret = "synthetic-private-payload";
  for (const result of [{ exitCode: 1, stdout: secret, stderr: secret }, { exitCode: 0, stdout: "", stderr: secret, timedOut: true }, { exitCode: 0, stdout: "", stderr: secret, truncated: true }]) {
    const runner: ProcessRunner = async () => result;
    try { await readArtifactArchive(executor, "tar", [secret], runner); throw new Error("unexpected success"); }
    catch (error) { expect(error).toBeInstanceOf(ArtifactError); expect((error as ArtifactError).code).toBe("artifact-read"); expect((error as Error).message).not.toContain(secret); }
  }
  try { await readArtifactArchive(executor, "tar", [], async () => { throw new Error(secret); }); throw new Error("unexpected success"); }
  catch (error) { expect((error as ArtifactError).code).toBe("artifact-read"); expect((error as Error).message).not.toContain(secret); }
  const unsafe = scripted(Buffer.concat([entry(secret + "/../bad"), end]));
  try { await readArtifactArchive(executor, "tar", [], unsafe.runner); throw new Error("unexpected success"); }
  catch (error) { expect((error as Error).message).not.toContain(secret); expect(unsafe.requests[0]?.signal?.aborted).toBe(true); }
});

test("SSH uses the existing BatchMode transport and invalid options start no process", async () => {
  const fake = scripted(end);
  await readArtifactArchive({ ...executor, kind: "ssh", host: "fixture-host" }, "tar", ["-C", "/private/path with spaces", "-cf", "-", "."], fake.runner);
  expect(fake.requests[0]?.command).toBe("ssh"); expect(fake.requests[0]?.args.slice(0, 4)).toEqual(["-o", "BatchMode=yes", "fixture-host", "tar"]);
  expect(fake.requests[0]?.args).toContain("'/private/path with spaces'");
  const unused = scripted(end);
  for (const options of [{ capture: "../bad" }, { captureBytes: ARTIFACT_CAPTURE_BYTES + 1 }, { captureBytes: -1 }, { maxBytes: ARTIFACT_BYTES + 1 }, { maxBytes: -1 }, { maxFiles: ARTIFACT_FILES + 1 }]) await expect(readArtifactArchive(executor, "tar", [], unused.runner, options)).rejects.toBeInstanceOf(ArtifactError);
  expect(unused.requests).toHaveLength(0);
});
