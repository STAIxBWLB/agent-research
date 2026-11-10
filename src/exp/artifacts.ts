import { createHash, type Hash } from "node:crypto";
import { runOnExecutor, type Executor, type ProcessRunner } from "./executor.ts";

export const ARTIFACT_FILES = 500, ARTIFACT_BYTES = 256 * 1024 * 1024;
export const ARTIFACT_CAPTURE_BYTES = 65_536;
export const ARTIFACT_HEADERS = 2048, ARTIFACT_METADATA_BYTES = 65_536;
export const ARTIFACT_WIRE_BYTES = ARTIFACT_BYTES + 16 * 1024 * 1024;
export type ArtifactErrorCode = "invalid-artifact" | "artifact-limit" | "artifact-read";
export class ArtifactError extends Error {
  constructor(readonly code: ArtifactErrorCode, cause: string) {
    super(`artifact archive: ${cause}; ${code === "artifact-limit" ? "reduce artifact file count, bytes or metadata within the declared limits" : code === "artifact-read" ? "check the executor host and archive command" : "recreate the archive using regular files/directories, valid tar headers and safe relative paths"}, then rerun ares attempt reconcile <dir>`);
    this.name = "ArtifactError";
  }
}
export interface ArtifactFile { path: string; sha256: string; bytes: number }
export interface ArtifactArchive { files: ArtifactFile[]; captured?: Uint8Array }
export interface ArtifactArchiveOptions {
  capture?: string; captureBytes?: number; maxBytes?: number; maxFiles?: number;
}
function invalid(cause: string): never { throw new ArtifactError("invalid-artifact", cause); }
function limit(cause: string): never { throw new ArtifactError("artifact-limit", cause); }
function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return invalid("invalid UTF-8 metadata"); }
}
function field(header: Buffer, start: number, length: number, strict = true): string {
  const bytes = header.subarray(start, start + length), end = bytes.indexOf(0);
  const content = end === -1 ? bytes : bytes.subarray(0, end);
  return strict ? utf8(content) : content.toString("utf8");
}
function octal(bytes: Uint8Array): number {
  // GNU base-256 numbers are accepted only when positive and exactly representable.
  if ((bytes[0]! & 128) !== 0) {
    if ((bytes[0]! & 64) !== 0) return invalid("negative numeric header field");
    let value = BigInt(bytes[0]! & 127);
    for (const byte of bytes.subarray(1)) value = value * 256n + BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return limit("numeric header field exceeds safe bounds");
    return Number(value);
  }
  if (bytes.some(byte => byte !== 0 && byte !== 32 && (byte < 48 || byte > 55))) return invalid("malformed octal header field");
  const text = Buffer.from(bytes).toString("ascii").replaceAll("\0", " ").trim();
  if (!/^[0-7]+$/.test(text)) return invalid("malformed octal header field");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) return limit("numeric header field exceeds safe bounds");
  return value;
}
function decimal(value: string): number {
  if (!/^[0-9]+$/.test(value)) return invalid("malformed PAX size field");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return limit("PAX size exceeds safe bounds");
  return number;
}
function relative(value: string, directory = false): string {
  if (!value || Buffer.byteLength(value) > 4096 || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\") || /\p{Cc}/u.test(value)) return invalid("unsafe or oversized artifact path");
  const parts = value.split("/");
  if (parts.includes("..") || (!directory && value.endsWith("/"))) return invalid("traversal or ambiguous artifact path");
  const normalized = parts.filter(part => part !== "" && part !== ".").join("/");
  if (!normalized && !directory) return invalid("empty artifact file path");
  return normalized;
}
function bound(value: number, max: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) return limit(`${what} must be an integer in 0..${max}`);
  return value;
}
const ZERO_BLOCK = Buffer.alloc(65_536);
function allZero(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < buffer.length; offset += ZERO_BLOCK.length) {
    const part = buffer.subarray(offset, offset + ZERO_BLOCK.length);
    if (!part.equals(ZERO_BLOCK.subarray(0, part.length))) return false;
  }
  return true;
}
type Pax = { path?: string | null; size?: string | null };
interface FileBody { kind: "file"; path: string; size: number; remaining: number; hash: Hash; capture?: Buffer; offset: number }
interface MetadataBody { kind: "metadata"; type: "x" | "g" | "L"; remaining: number; data: Buffer; offset: number }

class TarArtifacts {
  readonly files: ArtifactFile[] = [];
  captured?: Uint8Array;
  private readonly header = Buffer.alloc(512);
  private headerBytes = 0;
  private body?: FileBody | MetadataBody;
  private padding = 0;
  private zeros = 0;
  private ended = false;
  private wireBytes = 0;
  private headers = 0;
  private totalBytes = 0;
  private fileCount = 0;
  private global: Pax = {};
  private next: Pax = {};
  private pendingMetadata = false;
  private longName?: string;
  private seen = new Map<string, "file" | "directory">();
  constructor(private capture: string | undefined, private captureBytes: number, private maxBytes: number, private maxFiles: number) {}
  push(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) return invalid("non-binary archive stream");
    this.wireBytes += chunk.byteLength;
    if (this.wireBytes > this.maxBytes + ARTIFACT_WIRE_BYTES - ARTIFACT_BYTES) return limit("archive stream exceeds its payload and metadata overhead limits");
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.ended) { if (!allZero(chunk.subarray(offset))) return invalid("nonzero data after tar end markers"); return; }
      if (this.padding && !this.body) {
        const count = Math.min(this.padding, chunk.byteLength - offset);
        if (chunk.subarray(offset, offset + count).some(byte => byte !== 0)) return invalid("nonzero tar entry padding");
        this.padding -= count; offset += count; continue;
      }
      if (this.body) {
        const body = this.body, count = Math.min(body.remaining, chunk.byteLength - offset), part = chunk.subarray(offset, offset + count);
        if (body.kind === "metadata") body.data.set(part, body.offset);
        else {
          body.hash.update(part);
          body.capture?.set(part, body.offset);
        }
        body.offset += count; body.remaining -= count; offset += count;
        if (body.remaining === 0) this.completeBody();
        continue;
      }
      const count = Math.min(512 - this.headerBytes, chunk.byteLength - offset);
      this.header.set(chunk.subarray(offset, offset + count), this.headerBytes); this.headerBytes += count; offset += count;
      if (this.headerBytes === 512) { this.headerBytes = 0; this.readHeader(); }
    }
  }
  private readHeader(): void {
    const header = this.header;
    if (header.every(byte => byte === 0)) { if (++this.zeros === 2) this.ended = true; return; }
    if (this.zeros) return invalid("entry after an incomplete tar end marker");
    if (++this.headers > ARTIFACT_HEADERS) return limit(`archive exceeds ${ARTIFACT_HEADERS} headers`);
    const expected = octal(header.subarray(148, 156));
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (checksum !== expected) return invalid("tar header checksum mismatch");
    const magic = field(header, 257, 6);
    if (magic !== "" && magic !== "ustar" && magic !== "ustar ") return invalid("unsupported tar header format");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    if (!["0", "5", "x", "g", "L"].includes(type)) return invalid("link or special tar entry is forbidden");
    if (field(header, 157, 100) !== "") return invalid("link target on a regular tar entry is forbidden");
    const hasPathOverride = ({ ...this.global, ...this.next }.path ?? this.longName) !== undefined;
    const prefix = magic === "ustar" ? field(header, 345, 155, !hasPathOverride) : "", name = field(header, 0, 100, !hasPathOverride);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    // Metadata entry paths never become artifacts, but still must be safe paths.
    relative(headerPath, type === "5" || hasPathOverride);
    const headerSize = octal(header.subarray(124, 136));
    if (type === "x" || type === "g" || type === "L") {
      if (headerSize > ARTIFACT_METADATA_BYTES) return limit(`tar metadata exceeds ${ARTIFACT_METADATA_BYTES} bytes`);
      this.body = { kind: "metadata", type, remaining: headerSize, data: Buffer.alloc(headerSize), offset: 0 };
      this.padding = (512 - headerSize % 512) % 512;
    } else {
      const overrides = { ...this.global, ...this.next }, path = relative(overrides.path ?? this.longName ?? headerPath, type === "5"), size = overrides.size === undefined || overrides.size === null ? headerSize : decimal(overrides.size);
      this.next = {}; this.longName = undefined; this.pendingMetadata = false;
      const parts = path.split("/");
      for (let count = 1; count < parts.length; count++) if (this.seen.get(parts.slice(0, count).join("/")) === "file") return invalid("artifact file is used as a parent directory");
      if (type === "5") {
        if (size !== 0) return invalid("directory tar entry has a payload");
        if (this.seen.get(path) === "file") return invalid("artifact path changes entry type");
        this.seen.set(path, "directory"); return;
      }
      if (this.seen.has(path)) return invalid("duplicate artifact file path");
      if ([...this.seen.keys()].some(existing => existing.startsWith(`${path}/`))) return invalid("artifact file replaces a parent directory");
      this.seen.set(path, "file");
      if (++this.fileCount > this.maxFiles) return limit(`archive exceeds ${this.maxFiles} regular files`);
      if (size > this.maxBytes - this.totalBytes) return limit(`regular file bytes exceed ${this.maxBytes}`);
      this.totalBytes += size;
      if (path === this.capture && size > this.captureBytes) return limit(`selected capture exceeds ${this.captureBytes} bytes`);
      this.body = { kind: "file", path, size, remaining: size, hash: createHash("sha256"), ...(path === this.capture ? { capture: Buffer.alloc(size) } : {}), offset: 0 };
      this.padding = (512 - size % 512) % 512;
    }
    if (this.body.remaining === 0) this.completeBody();
  }
  private completeBody(): void {
    const body = this.body!; this.body = undefined;
    if (body.kind === "file") {
      this.files.push({ path: body.path, sha256: body.hash.digest("hex"), bytes: body.size });
      if (body.capture) this.captured = body.capture;
    } else if (body.type === "L") {
      let end = body.data.length;
      while (end && body.data[end - 1] === 0) end--;
      this.longName = utf8(body.data.subarray(0, end)); relative(this.longName, true); this.pendingMetadata = true;
    } else {
      const values: Pax = {}, seen = new Set<string>();
      for (let offset = 0; offset < body.data.length;) {
        const separator = body.data.indexOf(32, offset);
        if (separator === -1) return invalid("malformed PAX record length");
        const lengthText = body.data.subarray(offset, separator).toString("utf8");
        if (!/^[1-9][0-9]*$/.test(lengthText)) return invalid("malformed PAX record length");
        const length = Number(lengthText), end = offset + length;
        if (!Number.isSafeInteger(length) || end > body.data.length || end <= separator + 1 || body.data[end - 1] !== 10) return invalid("truncated or malformed PAX record");
        const record = utf8(body.data.subarray(separator + 1, end - 1)), equals = record.indexOf("=");
        if (equals < 1) return invalid("malformed PAX key/value record");
        const key = record.slice(0, equals), value = record.slice(equals + 1);
        if (seen.has(key)) return invalid("duplicate PAX metadata key"); seen.add(key);
        if (key === "linkpath" || key.startsWith("GNU.sparse.") || key === "SCHILY.filetype" || key === "SCHILY.realsize") return invalid("link, sparse or special PAX metadata is forbidden");
        if (key === "path") { if (value) relative(value, true); values.path = value || null; }
        if (key === "size") { if (value) decimal(value); values.size = value || null; }
        offset = end;
      }
      if (body.type === "g") {
        for (const key of ["path", "size"] as const) if (values[key] !== undefined) { if (values[key] === null) delete this.global[key]; else this.global[key] = values[key]; }
      } else { this.next = { ...this.next, ...values }; this.pendingMetadata = true; }
    }
  }
  finish(): ArtifactArchive {
    if (this.body || this.padding || this.headerBytes || !this.ended || this.pendingMetadata) return invalid("truncated archive, missing end markers or dangling metadata");
    return { files: this.files, ...(this.captured !== undefined ? { captured: this.captured } : {}) };
  }
}

/**
 * Streaming member scan for an archive the caller transfers elsewhere: the same header, PAX and path validation as
 * artifact reads, exposing each regular member's path and digest when the archive ends.
 */
export class TarMemberScan {
  private readonly parser: TarArtifacts;
  constructor(maxBytes: number, maxFiles: number) { this.parser = new TarArtifacts(undefined, 0, bound(maxBytes, ARTIFACT_BYTES, "maxBytes"), bound(maxFiles, ARTIFACT_FILES, "maxFiles")); }
  push(chunk: Uint8Array): void { this.parser.push(chunk); }
  finish(): ArtifactFile[] { return this.parser.finish().files; }
}

/** Hash regular artifacts, retaining no payload except an explicitly selected bounded capture. */
export async function readArtifactArchive(executor: Executor, command: string, args: string[], runner: ProcessRunner, options: ArtifactArchiveOptions = {}): Promise<ArtifactArchive> {
  const capture = options.capture === undefined ? undefined : relative(options.capture), captureBytes = bound(options.captureBytes ?? ARTIFACT_CAPTURE_BYTES, ARTIFACT_CAPTURE_BYTES, "captureBytes");
  const maxBytes = bound(options.maxBytes ?? ARTIFACT_BYTES, ARTIFACT_BYTES, "maxBytes"), maxFiles = bound(options.maxFiles ?? ARTIFACT_FILES, ARTIFACT_FILES, "maxFiles");
  const parser = new TarArtifacts(capture, captureBytes, maxBytes, maxFiles), controller = new AbortController();
  let parseError: ArtifactError | undefined;
  try {
    const result = await runOnExecutor(executor, command, args, runner, { signal: controller.signal, timeoutMs: 300_000,
      stdoutSink: chunk => {
        try { parser.push(chunk); }
        catch (error) { parseError = error instanceof ArtifactError ? error : new ArtifactError("invalid-artifact", "malformed archive stream"); controller.abort(); throw parseError; }
      } });
    if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new ArtifactError("artifact-read", "executor archive read failed");
    return parser.finish();
  } catch (error) {
    controller.abort();
    if (parseError) throw parseError;
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("artifact-read", "executor archive read failed");
  }
}
