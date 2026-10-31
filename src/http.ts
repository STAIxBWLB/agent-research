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

export function userAgent(env: NodeJS.ProcessEnv): string {
  const email = env.ARES_CONTACT_EMAIL?.trim();
  return `agent-research/${version}${email && EMAIL.test(email) ? ` (mailto:${email})` : ""}`;
}

/** 200 returns the body, 404 returns `body: undefined`; 429, 5xx, other statuses and network failures throw HttpError. */
export function createHttp(env: NodeJS.ProcessEnv = process.env, fetchImpl: FetchLike = fetch as FetchLike): Http {
  async function get(url: string, headers: Record<string, string> = {}): Promise<HttpResult<string>> {
    const host = new URL(url).host;
    let response: Response;
    try { response = await fetchImpl(url, { headers: { "user-agent": userAgent(env), ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch { throw new HttpError("network", host); }
    if (response.status === 404) return { status: 404, body: undefined };
    if (response.status === 429) throw new HttpError("rate", host, 429);
    if (response.status >= 500) throw new HttpError("server", host, response.status);
    if (response.status !== 200) throw new HttpError("client", host, response.status);
    let text: string;
    try { text = await response.text(); } catch { throw new HttpError("network", host); }
    if (Buffer.byteLength(text) > MAX_BYTES) throw new HttpError("format", host);
    return { status: 200, body: text };
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
