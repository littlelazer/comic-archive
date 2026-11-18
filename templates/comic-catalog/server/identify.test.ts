// ABOUTME: Error-path tests for identifyComic against a local stand-in that answers only with Metron failures.
// ABOUTME: Normal identification is tested against real Metron in identify.live.test.ts.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { identifyComic } from './identify';
import { createMetronClient } from './metron-client';

const servers: ReturnType<typeof Bun.serve>[] = [];
const THING_1 = { series_title: 'The Thing', issue_number: '1', cover_year: 1983 };

function clientAnswering(status: number, headers: Record<string, string> = {}) {
  const server = Bun.serve({ port: 0, fetch: () => new Response('', { status, headers }) });
  servers.push(server);
  return createMetronClient({
    baseUrl: `http://127.0.0.1:${server.port}/api/`,
    userAgent: 'comic-archive/0.2.0',
    sleep: async () => {},
  });
}

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
