// ABOUTME: Live tests of the cover steps against real Metron, through the credential gateway.
// ABOUTME: Skipped unless HTTPS_PROXY is set, which `onecli run` provides; at most 4 API requests and one image.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { identifyComic } from './identify';
import { METRON_BASE_URL, createMetronClient, type MetronClient } from './metron-client';

// Fixtures, from the Phase 3 spec (verified live 2026-11-18):
// - Absolute Batman (2024) #1 is Metron 127884, with 74 variants. Its main barcode is 761941385846 with add-on
//   00111; the 10th printing has add-on 00110, so the exact barcode search lands on the issue through a variant.
// - Solar, Man of the Atom #55 (Metron 140438) has its cover on static.metron.cloud, outside the API.
const ABSOLUTE_BATMAN_1 = 127884;
const SOLAR_55_COVER = 'https://static.metron.cloud/media/issue/2025/03/24/c415c91e00f8481c947e61f986457860.jpg';
const LIVE_TIMEOUT_MS = 120_000;

// Rate-limit headers seen on each response, to check whether an image download uses up the API allowance.
// Observed on the first run (2026-11-18): the API responses carried X-RateLimit-Burst-* (limit 20) and
// X-RateLimit-Sustained-* (limit 5000) headers; the image response from static.metron.cloud carried none. Burst
// remaining went 19, 18, then 17 on the API request right after the image, and sustained remaining 4815, 4814,
// 4813, all in the same reset window: the image download did not use up either allowance.
const seen: { url: string; headers: Record<string, string> }[] = [];
const realFetch = globalThis.fetch;

function countingClient(client: MetronClient) {
  const counter = { requests: 0 };
  const counted: MetronClient = {
    ...client,
    searchIssues: (params, budget) => (counter.requests++, client.searchIssues(params, budget)),
    getIssue: (id, budget) => (counter.requests++, client.getIssue(id, budget)),
    searchSeries: (params, budget) => (counter.requests++, client.searchSeries(params, budget)),
  };
  return { client: counted, counter };
}

describe.skipIf(!process.env.HTTPS_PROXY)('cover steps against real Metron', () => {
  const { client, counter } = countingClient(
    createMetronClient({ baseUrl: METRON_BASE_URL, userAgent: 'comic-archive/0.3.1' }),
  );

  beforeAll(() => {
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await realFetch(input, init);
      seen.push({
        url: String(input instanceof Request ? input.url : input),
        headers: Object.fromEntries([...res.headers].filter(([name]) => /ratelimit|burst/i.test(name))),
      });
      return res;
    }, realFetch);
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test(
    'live: Absolute Batman #1 with the 10th-printing barcode settles the cover by barcode',
    async () => {
      const result = await identifyComic({ upc_main: '761941385846', upc_addon: '00110' }, client);
      expect(result.verdict).toBe('confirmed');
      if (result.verdict !== 'confirmed') return;
      expect(result.candidates[0].metronId).toBe(ABSOLUTE_BATMAN_1);
      expect(result.cover?.settledBy).toBe('barcode');
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: a cover image downloads as bytes',
    async () => {
      const image = await client.getImage(SOLAR_55_COVER);
      expect(image.ok).toBe(true);
      if (!image.ok) return;
      expect(image.data.byteLength).toBeGreaterThan(0);
      expect(seen.find((response) => response.url === SOLAR_55_COVER)?.headers).toEqual({});

      // One API request after the image shows whether the download moved the API's remaining allowance.
      expect((await client.getIssue(ABSOLUTE_BATMAN_1)).ok).toBe(true);
      expect(counter.requests).toBeLessThanOrEqual(4);
    },
    LIVE_TIMEOUT_MS,
  );
});
