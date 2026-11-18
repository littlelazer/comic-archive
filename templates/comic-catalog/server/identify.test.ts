// ABOUTME: Error-path tests for identifyComic against a local stand-in that answers only with Metron failures.
// ABOUTME: Normal identification is tested against real Metron in identify.live.test.ts.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { identifyComic } from './identify';
import { createMetronClient } from './metron-client';

const servers: ReturnType<typeof Bun.serve>[] = [];
const THING_1 = { series_title: 'The Thing', issue_number: '1', cover_year: 1983 };

function clientAnswering(status: number, headers: Record<string, string> = {}) {
  return clientFor(() => new Response('', { status, headers })).client;
}

// The client's clock only moves when it sleeps, so recorded sleeps are the call's whole elapsed time.
function clientFor(fetch: (req: Request) => Response) {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const client = createMetronClient({
    baseUrl: `http://127.0.0.1:${server.port}/api/`,
    userAgent: 'comic-archive/0.2.0',
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { client, sleeps };
}

const total = (sleeps: number[]) => sleeps.reduce((sum, ms) => sum + ms, 0);

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe('identifyComic failures', () => {
  test('a 429 beyond the wait budget is a retryable rate_limited lookup failure', async () => {
    const client = clientAnswering(429, { 'Retry-After': '120' });
    expect(await identifyComic(THING_1, client)).toEqual({
      verdict: 'lookup_failed',
      reason: 'rate_limited',
      retryable: true,
      retryAfterSeconds: 120,
      candidates: [],
      missing: [],
    });
  });

  test('a 401 is a non-retryable auth lookup failure', async () => {
    expect(await identifyComic(THING_1, clientAnswering(401))).toEqual({
      verdict: 'lookup_failed',
      reason: 'auth',
      retryable: false,
      candidates: [],
      missing: [],
    });
  });

  test('repeated 5xx is a retryable metron_unavailable lookup failure', async () => {
    expect(await identifyComic(THING_1, clientAnswering(503))).toEqual({
      verdict: 'lookup_failed',
      reason: 'metron_unavailable',
      retryable: true,
      candidates: [],
      missing: [],
    });
  });

  test('a 400 is a non-retryable metron_unavailable failure and logs the query once', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await identifyComic(THING_1, clientAnswering(400))).toEqual({
        verdict: 'lookup_failed',
        reason: 'metron_unavailable',
        retryable: false,
        candidates: [],
        missing: [],
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toContain('"series_name":"Thing"');
    } finally {
      logged.mockRestore();
    }
  });
});

describe('identifyComic total wait per call', () => {
  test('a 429 with Retry-After 25 every time ends as rate_limited within 60 s of waiting', async () => {
    const { client, sleeps } = clientFor(() => new Response('', { status: 429, headers: { 'Retry-After': '25' } }));
    const result = await identifyComic(THING_1, client);
    expect(result).toMatchObject({ verdict: 'lookup_failed', reason: 'rate_limited', retryable: true });
    expect(total(sleeps)).toBeLessThanOrEqual(60_000);
  });

  test('waits across several requests stop at 60 s in total', async () => {
    // Each request is rate-limited once for 25 s and then finds nothing, so a three-request cascade
    // (exact barcode, barcode prefix, title) would wait 75 s without a per-call cap.
    const seen = new Set<string>();
    const { client, sleeps } = clientFor((req) => {
      if (seen.has(req.url)) return new Response(JSON.stringify({ count: 0, next: null, results: [] }));
      seen.add(req.url);
      return new Response('', { status: 429, headers: { 'Retry-After': '25' } });
    });
    const result = await identifyComic(
      { series_title: 'The Thing', issue_number: '1', upc_main: '759606202003', upc_addon: '00111' },
      client,
    );
    expect(result).toMatchObject({ verdict: 'lookup_failed', reason: 'rate_limited', retryable: true });
    expect(total(sleeps)).toBeLessThanOrEqual(60_000);
  });
});
