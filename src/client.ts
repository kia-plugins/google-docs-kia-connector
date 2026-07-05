/**
 * v2 port of the v1 Drive client (alpha-cent `git show
 * main:src/main/connectors/google-docs/client.ts` +
 * `main:src/main/connectors/http-shared/bearer-fetch.ts`).
 *
 * Preserved verbatim from v1:
 *  - Retry policy: up to MAX_RETRIES=4 retries after the initial request
 *    (v1's MAX_ATTEMPTS loop shape), backoff `min(60000, 1000*2^attempt) +
 *    jitter*250`, `Retry-After` (seconds) honored when finite and > 0.
 *  - Retryable = 429, >=500, or 403 whose body matches Google's quota
 *    throttle regex (`isRetryableGoogleFailure`). Network errors are always
 *    retried.
 *  - Thrown message CONTRACT: `drive <status> <url> <body>` — the delta
 *    invalid-page-token regex (`/page token is invalid|invalid value|400|404/i`)
 *    matches against this exact format. Do not reformat.
 *  - Token fetched fresh per attempt via the `getToken` seam (in pull this is
 *    `session.credentials()` per request — the platform refreshes OAuth
 *    tokens near expiry; in connect it is the accessToken from `auth.oauth`).
 *
 * Deltas from v1:
 *  1. All I/O goes through `deps.fetch` — the host's `net.fetch` surface —
 *     never global fetch. The host resolves to a plain object (status /
 *     statusText / headers with lowercase keys / body: Uint8Array), so
 *     responses are decoded manually and there is no `.ok`.
 *  2. The v1 90s per-attempt AbortController timeout is DROPPED:
 *     `host.net.fetch` owns the transport (platform-level retry/backoff and
 *     socket hygiene), so the connector no longer arms its own timers.
 *  3. HTTP 401 throws `GoogleDocsAuthError` (message ends "— reconnect the
 *     account"), is NEVER retried, and always propagates — the engine flips
 *     the account to needsReauth on auth errors. v1 had no 401 special-case.
 *  4. `sleep`/`random` are injectable so tests never actually wait.
 */

export type NetFetch = (url: string, init?: unknown) => Promise<unknown>;

export type ResponseType = 'json' | 'text' | 'bytes';

/** Max retries AFTER the initial request (v1 bearer-fetch MAX_ATTEMPTS). */
const MAX_RETRIES = 4;
/** Error bodies are truncated to this many chars in thrown messages. */
const BODY_SNIPPET_CHARS = 500;

/** The host `net.fetch` surface resolves to this shape — header keys are
 *  lowercase (built via Object.fromEntries(res.headers.entries())). */
interface HostResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Non-2xx Drive response (except 401). Message format is load-bearing —
 *  see the module doc. */
export class DriveApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    body: string,
  ) {
    super(`drive ${status} ${url} ${body}`);
    this.name = 'DriveApiError';
  }
}

/** HTTP 401 (or missing credentials). Never retried, always propagated —
 *  every later call would fail identically. */
export class GoogleDocsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleDocsAuthError';
  }
}

export const isAuthError = (e: unknown): e is GoogleDocsAuthError =>
  e instanceof GoogleDocsAuthError;

// Google-API retry predicate (v1 http-shared/bearer-fetch.ts, verbatim
// semantics). 429 = Too Many Requests; 5xx = transient server errors; 403
// with a quota reason = Google's per-user throttle (returned instead of 429
// in some cases).
export function isRetryableGoogleFailure(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 403) {
    return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body);
  }
  return false;
}

export interface DriveClientDeps {
  fetch: NetFetch;
  /** Fresh token per attempt — see module doc. */
  getToken: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source for backoff (default Math.random) — injectable so retry
   *  tests can assert exact delays. */
  random?: () => number;
}

export class DriveClient {
  private readonly fetchFn: NetFetch;

  private readonly getToken: () => Promise<string>;

  private readonly sleepFn: (ms: number) => Promise<void>;

  private readonly random: () => number;

  constructor(deps: DriveClientDeps) {
    this.fetchFn = deps.fetch;
    this.getToken = deps.getToken;
    this.sleepFn =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
  }

  async request<T>(
    url: string,
    opts: { responseType?: ResponseType } = {},
  ): Promise<T> {
    const responseType = opts.responseType ?? 'json';
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken(); // fresh per attempt
      let res: HostResponse | undefined;
      let netError: Error | undefined;
      try {
        res = (await this.fetchFn(url, {
          headers: { authorization: `Bearer ${token}` },
        })) as HostResponse;
      } catch (e) {
        netError = e instanceof Error ? e : new Error(String(e));
      }

      if (netError) {
        if (attempt < MAX_RETRIES) {
          await this.sleepFn(this.backoff(attempt));
          continue;
        }
        throw netError;
      }

      const r = res!;
      if (r.status >= 200 && r.status < 300) {
        if (responseType === 'bytes') return r.body as unknown as T;
        const text = new TextDecoder().decode(r.body);
        if (responseType === 'text') return text as unknown as T;
        return JSON.parse(text) as T;
      }

      const body = new TextDecoder()
        .decode(r.body)
        .slice(0, BODY_SNIPPET_CHARS);
      if (r.status === 401) {
        throw new GoogleDocsAuthError(
          `drive 401 ${url} ${body} — reconnect the account`,
        );
      }
      if (attempt < MAX_RETRIES && isRetryableGoogleFailure(r.status, body)) {
        const retryAfterS = Number(r.headers['retry-after']);
        const delay =
          Number.isFinite(retryAfterS) && retryAfterS > 0
            ? retryAfterS * 1000
            : this.backoff(attempt);
        await this.sleepFn(delay);
        continue;
      }
      throw new DriveApiError(r.status, url, body);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(60_000, 1000 * 2 ** attempt) + this.random() * 250;
  }
}
