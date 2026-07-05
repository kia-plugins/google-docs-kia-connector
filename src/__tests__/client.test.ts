/**
 * Retry-matrix suite for the v2 DriveClient — the v1 contracts (bearer-fetch
 * retry predicate, backoff shape, Retry-After, error-message format) plus the
 * v2 additions (401 → GoogleDocsAuthError, host-shaped responses).
 */
import { DriveApiError, DriveClient, GoogleDocsAuthError, type NetFetch } from '../client';
import { bytesRes, jsonRes, textRes, type HostResponse } from '../testing/harness';

const URL_X = 'https://www.googleapis.com/drive/v3/files/x?fields=id';

function scripted(responses: Array<HostResponse | Error>): {
  fetchFn: NetFetch;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetchFn: NetFetch = async (url) => {
    calls.push(String(url));
    const r = responses[i];
    i += 1;
    if (r === undefined) throw new Error(`scripted: no response for call #${i}`);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetchFn, calls };
}

function makeClient(fetchFn: NetFetch, tokens?: string[]) {
  const sleeps: number[] = [];
  const tokenCalls: number[] = [];
  let n = 0;
  const client = new DriveClient({
    fetch: fetchFn,
    getToken: async () => {
      tokenCalls.push(n);
      const t = tokens?.[n] ?? 'ya29.test-deadbeef';
      n += 1;
      return t;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  return { client, sleeps, tokenCalls };
}

const quotaBody = {
  error: { errors: [{ reason: 'userRateLimitExceeded' }], code: 403 },
};

describe('DriveClient retry matrix', () => {
  it('retries 429 with exponential backoff and succeeds', async () => {
    const { fetchFn, calls } = scripted([
      jsonRes(429, {}),
      jsonRes(429, {}),
      jsonRes(200, { id: 'x' }),
    ]);
    const { client, sleeps } = makeClient(fetchFn);
    await expect(client.request(URL_X)).resolves.toEqual({ id: 'x' });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]); // min(60000, 1000*2^attempt) + 0 jitter
  });

  it('retries 5xx', async () => {
    const { fetchFn, calls } = scripted([jsonRes(503, {}), jsonRes(200, { ok: true })]);
    const { client } = makeClient(fetchFn);
    await expect(client.request(URL_X)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('retries 403 with a Google quota body', async () => {
    const { fetchFn, calls } = scripted([jsonRes(403, quotaBody), jsonRes(200, { ok: 1 })]);
    const { client } = makeClient(fetchFn);
    await expect(client.request(URL_X)).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a non-quota 403', async () => {
    const { fetchFn, calls } = scripted([
      jsonRes(403, { error: { message: 'The user does not have permission' } }),
    ]);
    const { client } = makeClient(fetchFn);
    await expect(client.request(URL_X)).rejects.toThrow(DriveApiError);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry 400 and throws the drive <status> <url> <body> format', async () => {
    const { fetchFn, calls } = scripted([
      jsonRes(400, { error: { message: 'Invalid Value' } }),
    ]);
    const { client } = makeClient(fetchFn);
    const err = (await client.request(URL_X).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(DriveApiError);
    expect(err.message).toMatch(
      new RegExp(`^drive 400 ${URL_X.replace(/[?.]/g, '\\$&')} `),
    );
    expect(err.message).toContain('Invalid Value');
    expect(calls).toHaveLength(1);
  });

  it('401 → GoogleDocsAuthError, never retried, message ends "— reconnect the account"', async () => {
    const { fetchFn, calls } = scripted([
      jsonRes(401, { error: { message: 'Invalid Credentials' } }),
      jsonRes(200, { never: 'reached' }),
    ]);
    const { client, sleeps } = makeClient(fetchFn);
    const err = (await client.request(URL_X).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(GoogleDocsAuthError);
    expect(err.message).toMatch(/— reconnect the account$/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('honors Retry-After (seconds) over the backoff curve', async () => {
    const { fetchFn } = scripted([
      jsonRes(429, {}, { 'retry-after': '7' }),
      jsonRes(200, { ok: true }),
    ]);
    const { client, sleeps } = makeClient(fetchFn);
    await client.request(URL_X);
    expect(sleeps).toEqual([7000]);
  });

  it('retries network errors, then rethrows the last one after 4 retries (5 requests)', async () => {
    const boom = new Error('socket hang up');
    const { fetchFn, calls } = scripted([boom, boom, boom, boom, boom]);
    const { client, sleeps } = makeClient(fetchFn);
    await expect(client.request(URL_X)).rejects.toThrow('socket hang up');
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it('gives up on persistent 429 after 4 retries (5 requests)', async () => {
    const r = jsonRes(429, {});
    const { fetchFn, calls } = scripted([r, r, r, r, r]);
    const { client } = makeClient(fetchFn);
    await expect(client.request(URL_X)).rejects.toThrow(/^drive 429 /);
    expect(calls).toHaveLength(5);
  });

  it('recovers mid-sequence: network error then 500 then 200', async () => {
    const { fetchFn, calls } = scripted([
      new Error('ECONNRESET'),
      jsonRes(500, {}),
      jsonRes(200, { done: true }),
    ]);
    const { client } = makeClient(fetchFn);
    await expect(client.request(URL_X)).resolves.toEqual({ done: true });
    expect(calls).toHaveLength(3);
  });

  it('fetches a fresh token per attempt (expiry-safe retries)', async () => {
    const { fetchFn } = scripted([jsonRes(500, {}), jsonRes(200, {})]);
    const { client, tokenCalls } = makeClient(fetchFn, ['ya29.test-old', 'ya29.test-new']);
    await client.request(URL_X);
    expect(tokenCalls).toHaveLength(2);
  });

  it('decodes responseType text and bytes', async () => {
    const raw = new Uint8Array([1, 2, 3]);
    const { fetchFn } = scripted([textRes(200, '# Hello'), bytesRes(200, raw)]);
    const { client } = makeClient(fetchFn);
    await expect(client.request(URL_X, { responseType: 'text' })).resolves.toBe('# Hello');
    await expect(client.request(URL_X, { responseType: 'bytes' })).resolves.toBe(raw);
  });
});
