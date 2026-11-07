import { version } from "../package.json";

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
export type HttpErrorKind = "network" | "rate" | "server" | "client" | "format";
/** Errors name the host and status only: request URLs can carry API keys. */
export class HttpError extends Error {
  constructor(readonly kind: HttpErrorKind, readonly host: string, readonly status?: number) { super(`${host}: ${kind}${status ? ` ${status}` : ""}`); }
}
export interface HttpResult<T> { status: number; body: T | undefined }
export interface Http {
  json(url: string, headers?: Record<string, string>): Promise<HttpResult<unknown>>;
  text(url: string, headers?: Record<string, string>): Promise<HttpResult<string>>;
  env: NodeJS.ProcessEnv;
}
const TIMEOUT_MS = 20_000, MAX_BYTES = 5 * 1024 * 1024;
const EMAIL = /^[^\s@<>()]{1,64}@[^\s@<>()]{1,190}$/;

export const S2_START_INTERVAL_MS = 1_100;
export interface HttpPacingClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface HttpPacing {
  start<T>(request: () => Promise<T>): Promise<T>;
}

/** Serialize admissions only: an in-flight response never holds the next start. */
export function createHttpPacing(clock: HttpPacingClock = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}): HttpPacing {
  let tail = Promise.resolve(), lastStart: number | undefined;
  return {
    start<T>(request: () => Promise<T>): Promise<T> {
      const admitted = tail.then(async () => {
        if (lastStart !== undefined) {
          let remaining = S2_START_INTERVAL_MS - (clock.now() - lastStart);
          while (remaining > 0) {
            await clock.sleep(remaining);
            remaining = S2_START_INTERVAL_MS - (clock.now() - lastStart);
          }
        }
        // Measure after invocation, conservatively spacing actual fetch starts.
        let response: Promise<T>;
        try { response = request(); } finally { lastStart = clock.now(); }
        // Box the promise so admission releases without waiting for the response.
        // A later admission must not delay handling a rejected response.
        void response.catch(() => {});
        return { response };
      });
      tail = admitted.then(() => {}, () => {});
      return admitted.then(({ response }) => response);
    },
  };
}

const processS2Pacing = createHttpPacing();

/** Read the body while counting bytes; past the limit the stream is cancelled, never buffered whole. */
async function readBounded(response: Response, host: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new HttpError("format", host); }
      chunks.push(value);
    }
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError("network", host); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new HttpError("format", host); }
}

export function userAgent(env: NodeJS.ProcessEnv): string {
  const email = env.ARES_CONTACT_EMAIL?.trim();
  return `agent-research/${version}${email && EMAIL.test(email) ? ` (mailto:${email})` : ""}`;
}

/** 200 returns the body, 404 returns `body: undefined`; 429, 5xx, other statuses and network failures throw HttpError. */
export function createHttp(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch as FetchLike, pacing: HttpPacing = processS2Pacing): Http {
  async function get(url: string, headers: Record<string, string> = {}): Promise<HttpResult<string>> {
    const host = new URL(url).host;
    let response: Response;
    try {
      const request = () => fetchImpl(url, { headers: { "user-agent": userAgent(env), ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      response = await (new URL(url).hostname === "api.semanticscholar.org" ? pacing.start(request) : request());
    }
    catch { throw new HttpError("network", host); }
    if (response.status === 404) return { status: 404, body: undefined };
    if (response.status === 429) throw new HttpError("rate", host, 429);
    if (response.status >= 500) throw new HttpError("server", host, response.status);
    if (response.status !== 200) throw new HttpError("client", host, response.status);
    return { status: 200, body: await readBounded(response, host) };
  }
  return {
    env,
    text: get,
    async json(url, headers) {
      const result = await get(url, headers);
      if (result.body === undefined) return { status: result.status, body: undefined };
      try { return { status: 200, body: JSON.parse(result.body) }; } catch { throw new HttpError("format", new URL(url).host); }
    },
  };
}
