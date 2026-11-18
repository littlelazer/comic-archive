// ABOUTME: Error-path tests for the Metron client against a local stand-in HTTP server.
// ABOUTME: Covers 429/Retry-After, burst slowdown, 5xx retries, timeouts, auth failures and request headers.
import { afterEach, describe, expect, test } from 'bun:test';
import { createMetronClient } from './metron-client';

const emptyPage = JSON.stringify({ count: 0, next: null, results: [] });
const servers: ReturnType<typeof Bun.serve>[] = [];

function standIn(fetch: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/api/`;
}

function clientFor(baseUrl: string, extra: { totalWaitBudgetMs?: number; requestTimeoutMs?: number } = {}) {
  const sleeps: number[] = [];
  const client = createMetronClient({
    baseUrl,
    userAgent: 'comic-archive/0.2.0',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { client, sleeps };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe('metron client error paths', () => {
  test('retries after Retry-After on 429 then succeeds', async () => {
    let calls = 0;
    const { client, sleeps } = clientFor(
      standIn(() =>
        ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '3' } }) : new Response(emptyPage),
      ),
    );
    const result = await client.searchIssues({ number: '1' });
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([3000]);
  });

  test('gives up on 429 beyond the wait budget', async () => {
    const { client } = clientFor(
      standIn(() => new Response('', { status: 429, headers: { 'Retry-After': '120' } })),
      { totalWaitBudgetMs: 60_000 },
    );
    expect(await client.searchIssues({ number: '1' })).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryable: true,
      retryAfterSeconds: 120,
    });
  });

  test('slows down when burst remaining is low', async () => {
    const { client, sleeps } = clientFor(
      standIn(
        () =>
          new Response(emptyPage, {
            headers: {
              'X-RateLimit-Burst-Remaining': '1',
              'X-RateLimit-Burst-Reset': String(Math.floor(Date.now() / 1000) + 5),
            },
          }),
      ),
    );
    await client.searchIssues({ number: '1' });
    expect(sleeps).toEqual([]);
    await client.searchIssues({ number: '1' });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(3000);
    expect(sleeps[0]).toBeLessThanOrEqual(5000);
  });

  test('retries 5xx twice then reports metron_unavailable', async () => {
    let calls = 0;
    const { client, sleeps } = clientFor(
      standIn(() => {
        calls++;
        return new Response('', { status: 503 });
      }),
    );
    expect(await client.searchIssues({ number: '1' })).toEqual({
      ok: false,
      reason: 'metron_unavailable',
      retryable: true,
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  test('retries a 200 whose body is not JSON then reports metron_unavailable', async () => {
    let calls = 0;
    const { client, sleeps } = clientFor(
      standIn(() => {
        calls++;
        return new Response('<html>Bad gateway</html>', { status: 200 });
      }),
    );
    expect(await client.searchIssues({ number: '1' })).toEqual({
      ok: false,
      reason: 'metron_unavailable',
      retryable: true,
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  test('times out a hung request', async () => {
    const { client } = clientFor(
      standIn(() => new Promise<Response>(() => {})),
      { requestTimeoutMs: 50 },
    );
    expect(await client.searchIssues({ number: '1' })).toEqual({
      ok: false,
      reason: 'metron_unavailable',
      retryable: true,
    });
  });

  test.each([401, 403])('does not retry %d', async (status) => {
    let calls = 0;
    const { client, sleeps } = clientFor(
      standIn(() => {
        calls++;
        return new Response('', { status });
      }),
    );
    expect(await client.getIssue(1)).toEqual({ ok: false, reason: 'auth', retryable: false });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test.each([
    [404, 'not_found'],
    [400, 'bad_request'],
  ] as const)('maps %d to %s without retry', async (status, reason) => {
    let calls = 0;
    const { client, sleeps } = clientFor(
      standIn(() => {
        calls++;
        return new Response('', { status });
      }),
    );
    expect(await client.getIssue(1)).toEqual({ ok: false, reason, retryable: false });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('a call budget past its deadline sends no request and names the last wait', async () => {
    let calls = 0;
    const { client } = clientFor(
      standIn(() => {
        calls++;
        return new Response(emptyPage);
      }),
    );
    const spent = client.callBudget(0);
    expect(await client.searchIssues({ number: '1' }, spent)).toEqual({
      ok: false,
      reason: 'metron_unavailable',
      retryable: true,
    });
    spent.lastWait = 'rate_limit';
    expect(await client.getIssue(1, spent)).toEqual({ ok: false, reason: 'rate_limited', retryable: true });
    expect(calls).toBe(0);
  });

  test('a 429 whose Retry-After outlasts the call budget is rate_limited without waiting', async () => {
    const { client, sleeps } = clientFor(
      standIn(() => new Response('', { status: 429, headers: { 'Retry-After': '25' } })),
    );
    expect(await client.searchSeries({ name: 'thing' }, client.callBudget(10_000))).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryable: true,
      retryAfterSeconds: 25,
    });
    expect(sleeps).toEqual([]);
  });

  test('waits inside a call budget are recorded on it', async () => {
    let calls = 0;
    const { client } = clientFor(
      standIn(() =>
        ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '3' } }) : new Response(emptyPage),
      ),
    );
    const budget = client.callBudget(60_000);
    expect((await client.searchIssues({ number: '1' }, budget)).ok).toBe(true);
    expect(budget.lastWait).toBe('rate_limit');
  });

  test('sends the User-Agent and no Authorization header', async () => {
    let seen: Headers | undefined;
    const { client } = clientFor(
      standIn((req) => {
        seen = req.headers;
        return new Response(emptyPage);
      }),
    );
    await client.searchSeries({ name: 'thing' });
    expect(seen?.get('user-agent')).toBe('comic-archive/0.2.0');
    expect(seen?.has('authorization')).toBe(false);
  });
});
