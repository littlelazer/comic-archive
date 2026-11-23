// ABOUTME: Tests identifyComic's failures and search cascade against a local stand-in Metron, plus pure helpers.
// ABOUTME: Stand-in pages only steer the cascade logic; real identifications are tested in identify.live.test.ts.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchDetail, identifyComic, judgeWithDetail, prefixHitStands, tradeTitle } from './identify';
import { normalizeClues } from './clues';
import { createMetronClient, type MetronIssueSummary } from './metron-client';

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

function summary(id: number, seriesName: string): MetronIssueSummary {
  return {
    id,
    series: { id: id * 10, name: seriesName, volume: 1, year_began: 1983 },
    number: '1',
    issue: `${seriesName} (1983) #1`,
    cover_date: '1983-07-01',
    image: null,
  };
}

describe('barcode prefix hits', () => {
  test('stand when no title was read', () => {
    expect(prefixHitStands(normalizeClues({ upc_main: '071486029663' }), [summary(1, 'Rom')])).toBe(true);
  });

  test('stand when a hit is in the series the title names', () => {
    const clues = normalizeClues({ series_title: 'Thing', upc_main: '071486029663' });
    expect(prefixHitStands(clues, [summary(1, 'Rom'), summary(2, 'The Thing')])).toBe(true);
  });

  test('do not stand when no hit is in the series the title names', () => {
    const clues = normalizeClues({ series_title: 'The Thing', upc_main: '071486029663' });
    expect(prefixHitStands(clues, [summary(1, 'Rom')])).toBe(false);
  });
});

describe('judging with the leader detail', () => {
  test('a runner-up left as the only fit after the leader detail conflicts is probable, not confirmed', () => {
    const clues = normalizeClues({
      series_title: 'The Thing',
      issue_number: '1',
      cover_year: 1983,
      upc_main: '071486029663',
    });
    const { issue: _issue, ...leaderSummary } = summary(1, 'The Thing');
    const leader = { ...leaderSummary, upc: '0799999999901', isbn: '', variants: [], reprints: [] };
    const match = {
      issues: [summary(1, 'The Thing'), summary(2, 'The Thing')],
      totalCount: 2,
      matchedBy: 'series_number' as const,
    };
    const result = judgeWithDetail(clues, match, leader);
    expect(result.verdict).toBe('probable');
    expect(result.candidates.map((c) => c.metronId)).toEqual([2, 1]);
    expect(result.missing).toEqual(['barcode_addon']);
  });

  test('the leader whose detail agrees can still confirm', () => {
    const clues = normalizeClues({ series_title: 'The Thing', issue_number: '1', cover_year: 1983 });
    const { issue: _issue, ...leaderSummary } = summary(1, 'The Thing');
    const leader = { ...leaderSummary, upc: '', isbn: '', variants: [], reprints: [] };
    const match = { issues: [summary(1, 'The Thing')], totalCount: 1, matchedBy: 'series_number' as const };
    expect(judgeWithDetail(clues, match, leader).verdict).toBe('confirmed');
  });
});

describe('cascade from a barcode prefix to the title search', () => {
  // The stand-in only shapes search pages by query; issue detail answers 404, so the leader is judged as found.
  function cascade(pages: { prefix: MetronIssueSummary[]; title: MetronIssueSummary[] }) {
    const urls: string[] = [];
    const page = (results: MetronIssueSummary[]) =>
      new Response(JSON.stringify({ count: results.length, next: null, results }));
    const { client } = clientFor((req) => {
      const url = new URL(req.url);
      urls.push(url.search);
      if (url.searchParams.has('upc_starts_with')) return page(pages.prefix);
      if (url.searchParams.has('series_name')) return page(pages.title);
      return new Response('', { status: 404 });
    });
    return { client, urls };
  }

  const READ = { series_title: 'The Thing', issue_number: '1', cover_year: 1983, upc_main: '071486029663' };

  test('a prefix hit in another series falls through to the title search, whose result wins', async () => {
    const { client, urls } = cascade({ prefix: [summary(500, 'Rom')], title: [summary(13806, 'The Thing')] });
    const result = await identifyComic(READ, client);
    expect(urls.some((search) => search.includes('series_name='))).toBe(true);
    expect(result.verdict).toBe('confirmed');
    expect(result.candidates.map((c) => c.metronId)).toEqual([13806]);
  });

  test('prefix hits are kept when the title search finds nothing, and cannot confirm', async () => {
    const { client } = cascade({ prefix: [summary(13806, 'The Thing')], title: [] });
    const result = await identifyComic({ ...READ, series_title: 'The Thinq' }, client);
    expect(result.verdict).not.toBe('no_match');
    expect(result.verdict).not.toBe('confirmed');
    expect(result.candidates[0].metronId).toBe(13806);
  });
});

// Stand-in whose answers are chosen per request, recording each request's path and query.
function standInMetron(answer: (url: URL) => Response) {
  const requests: string[] = [];
  const { client } = clientFor((req) => {
    const url = new URL(req.url);
    requests.push(url.pathname.replace('/api/', '') + url.search);
    return answer(url);
  });
  return { client, requests };
}

const pageOf = (results: unknown[], count = results.length) =>
  new Response(JSON.stringify({ count, next: count > results.length ? 'next' : null, results }));

describe('what was searched', () => {
  test('with no title and no barcode nothing is searched, and the hints say what to photograph', async () => {
    const { client, requests } = standInMetron(() => new Response('', { status: 503 }));
    expect(await identifyComic({ issue_number: '1', cover_year: 1983 }, client)).toEqual({
      verdict: 'no_match',
      candidates: [],
      missing: ['title', 'barcode_closeup'],
      searched: false,
    });
    expect(requests).toEqual([]);
  });

  test('a thin clue set that searched nothing asks for the title when no other hint applies', async () => {
    const { client, requests } = standInMetron(() => new Response('', { status: 503 }));
    expect(await identifyComic({ issue_number: '1', cover_year: 1965 }, client)).toEqual({
      verdict: 'no_match',
      candidates: [],
      missing: ['title'],
      searched: false,
    });
    expect(requests).toEqual([]);
  });

  test('a trade with only an ISBN is not searched, since Metron has no ISBN filter', async () => {
    const { client, requests } = standInMetron(() => new Response('', { status: 503 }));
    expect(await identifyComic({ isbn: '9781643375434' }, client)).toEqual({
      verdict: 'no_match',
      candidates: [],
      missing: ['title', 'issue_number', 'cover_date'],
      searched: false,
    });
    expect(requests).toEqual([]);
  });

  test('a title search that finds nothing is a searched no_match', async () => {
    const { client } = standInMetron(() => pageOf([]));
    expect(await identifyComic({ series_title: 'Zzyzx', issue_number: '1' }, client)).toEqual({
      verdict: 'no_match',
      candidates: [],
      missing: [],
      searched: true,
    });
  });

  test('a barcode-only search that finds nothing is no_match with missing [title]', async () => {
    const { client } = standInMetron(() => pageOf([]));
    expect(await identifyComic({ upc_main: '071486029663' }, client)).toEqual({
      verdict: 'no_match',
      candidates: [],
      missing: ['title'],
      searched: true,
    });
  });

  test('barcode hits across several series with no title are judged, never no_match', async () => {
    const rom = { ...summary(500, 'Rom'), number: '6' };
    const thing = { ...summary(13811, 'The Thing'), number: '6' };
    const { client, requests } = standInMetron((url) => {
      if (url.searchParams.has('number')) return pageOf([]);
      if (url.searchParams.has('upc_starts_with')) return pageOf([rom, thing]);
      return new Response('', { status: 404 });
    });
    const result = await identifyComic({ upc_main: '071486029663', issue_number: '1' }, client);
    expect(result).toMatchObject({ verdict: 'probable', searched: true });
    expect(result.candidates.map((c) => c.metronId)).toEqual([500, 13811]);
    expect(requests.length).toBeLessThanOrEqual(4);
  });
});

describe('issue choices in identify results', () => {
  test('an ambiguous month-only cover returns numbered choices for the conflict-free volumes', async () => {
    const later = { ...summary(2, 'The Thing'), series: { id: 20, name: 'The Thing', volume: 4, year_began: 2025 }, cover_date: '2025-07-01' };
    const { client } = standInMetron((url) => {
      if (url.searchParams.has('series_name')) return pageOf([summary(1, 'The Thing'), later]);
      return new Response('', { status: 404 });
    });
    const result = await identifyComic({ series_title: 'The Thing', issue_number: '1', cover_month: 7 }, client);
    expect(result).toMatchObject({ verdict: 'ambiguous', searched: true });
    if (result.verdict === 'lookup_failed') throw new Error('unexpected lookup failure');
    expect(result.choices?.map((c) => [c.number, c.label, c.metronId])).toEqual([
      [1, 'The Thing (1983) #1', 1],
      [2, 'The Thing (2025) #1', 2],
    ]);
  });
});

describe('trade series names', () => {
  test.each([
    ['Batman TPB (2022)', 'Batman'],
    ['Absolute Batman HC (2025)', 'Absolute Batman'],
    ['X-Men omnibus (2019)', 'X-Men'],
    ['Batman TPB', 'Batman'],
    ['Batman', 'Batman'],
    ['Hellboy HC Library Edition (2008)', 'Hellboy HC Library Edition (2008)'],
  ])('%p is compared as %p', (name, title) => {
    expect(tradeTitle(name)).toBe(title);
  });
});

describe('trades across several series', () => {
  const tradeSeries = (id: number, series: string, type = 'Trade Paperback') => ({
    id,
    series,
    volume: 1,
    year_began: 2022,
    series_type: { id: 10, name: type },
  });
  const tradeIssue = (id: number, seriesId: number, name: string) => ({
    ...summary(id, name),
    series: { id: seriesId, name, volume: 1, year_began: 2022 },
  });
  // The title search's first page holds only single issues while Metron counts many more matches.
  const singleIssues = [summary(1, 'Batman'), summary(2, 'Batman')];

  function trades(paperbacks: unknown[], allSeries: unknown[], bySeriesId: unknown[]) {
    return standInMetron((url) => {
      if (url.pathname.endsWith('/series/'))
        return pageOf(url.searchParams.has('series_type') ? paperbacks : allSeries);
      if (url.searchParams.has('series_name')) return pageOf(singleIssues, 250);
      if (url.searchParams.has('series_id')) return pageOf(bySeriesId);
      return new Response('', { status: 404 });
    });
  }

  const BATMAN_TRADE = { series_title: 'Batman', issue_number: '1', format: 'trade' } as const;

  test('an exact title narrows to its own trade series despite the TPB (year) suffix', async () => {
    const { client, requests } = trades(
      [tradeSeries(70, 'Batman TPB (2022)'), tradeSeries(71, 'Batman: Year One TPB (2005)')],
      [],
      [tradeIssue(700, 70, 'Batman TPB (2022)')],
    );
    const result = await identifyComic(BATMAN_TRADE, client);
    expect(requests.some((r) => r.includes('series_id=70'))).toBe(true);
    expect(requests.some((r) => r.includes('series_name='))).toBe(false);
    expect(result.candidates.map((c) => c.metronId)).toEqual([700]);
  });

  test('trade issues missing from an incomplete title page are searched by the first trade series', async () => {
    const { client, requests } = trades(
      [tradeSeries(70, 'Batman TPB (2022)'), tradeSeries(72, 'Batman TPB (2016)')],
      [],
      [tradeIssue(700, 70, 'Batman TPB (2022)')],
    );
    const result = await identifyComic(BATMAN_TRADE, client);
    expect(requests.some((r) => r.includes('series_id=70'))).toBe(true);
    expect(result).toMatchObject({ verdict: 'ambiguous', searched: true });
    expect(result.candidates.map((c) => c.metronId)).toEqual([700]);
    expect(requests.length).toBeLessThanOrEqual(4);
  });

  test('when even the first trade series has no such issue the result is ambiguous, not no_match', async () => {
    const { client } = trades([tradeSeries(70, 'Batman TPB (2022)'), tradeSeries(72, 'Batman TPB (2016)')], [], []);
    const result = await identifyComic(BATMAN_TRADE, client);
    expect(result).toMatchObject({ verdict: 'ambiguous', candidates: [], searched: true });
    expect(result.missing).toContain('isbn');
  });

  test('a bound-trade title search follows page 2 when page 1 has no Hardcover or Omnibus', async () => {
    const { client, requests } = standInMetron((url) => {
      if (url.pathname.endsWith('/series/')) {
        if (url.searchParams.has('series_type')) return pageOf([]);
        if (url.searchParams.get('page') === '2') return pageOf([tradeSeries(80, 'Batman HC (2023)', 'Hardcover')]);
        return pageOf([tradeSeries(90, 'Batman Annual', 'Annual')], 150);
      }
      if (url.searchParams.has('series_id')) return pageOf([tradeIssue(800, 80, 'Batman HC (2023)')]);
      return new Response('', { status: 404 });
    });
    const result = await identifyComic(BATMAN_TRADE, client);
    expect(requests.some((r) => r.includes('series/?name=Batman&page=2'))).toBe(true);
    expect(result.candidates.map((c) => c.metronId)).toEqual([800]);
  });

  test('a lookup uses at most 5 requests', async () => {
    const { client, requests } = standInMetron((url) => {
      if (url.pathname.endsWith('/series/')) {
        if (url.searchParams.has('series_type')) return pageOf([]);
        if (url.searchParams.get('page') === '2') {
          return pageOf([tradeSeries(80, 'Batman HC (2023)', 'Hardcover'), tradeSeries(81, 'Batman HC (2019)', 'Hardcover')]);
        }
        return pageOf([tradeSeries(90, 'Batman Annual', 'Annual')], 150);
      }
      if (url.searchParams.has('series_name')) return pageOf(singleIssues, 250);
      if (url.searchParams.has('series_id')) return pageOf([tradeIssue(800, 80, 'Batman HC (2023)')]);
      return new Response('', { status: 404 });
    });
    const result = await identifyComic(BATMAN_TRADE, client);
    expect(result).toMatchObject({ verdict: 'ambiguous', searched: true });
    expect(requests).toHaveLength(5);
  });

  test('the hardcover path stays within 5 requests', async () => {
    const { client, requests } = trades(
      [],
      [tradeSeries(80, 'Batman HC (2023)', 'Hardcover'), tradeSeries(81, 'Batman HC (2019)', 'Hardcover')],
      [tradeIssue(800, 80, 'Batman HC (2023)')],
    );
    const result = await identifyComic(BATMAN_TRADE, client);
    expect(result).toMatchObject({ verdict: 'ambiguous', searched: true });
    expect(result.candidates.map((c) => c.metronId)).toEqual([800]);
    expect(requests.length).toBeLessThanOrEqual(5);
  });
});

describe('covers in identify results', () => {
  const variant = (name: string, upc: string, image: string | null = null) => ({
    name,
    price: null,
    sku: '',
    upc,
    image,
  });
  const detailOf = (id: number, variants: ReturnType<typeof variant>[], upc = '') => {
    const { issue: _issue, ...rest } = summary(id, 'The Thing');
    return { ...rest, upc, isbn: '', price: null, variants, reprints: [] };
  };
  const READ = { series_title: 'The Thing', issue_number: '1', cover_year: 1983 };

  function withDetail(detail: ReturnType<typeof detailOf> | undefined, search = [summary(7, 'The Thing')]) {
    return standInMetron((url) => {
      if (url.pathname.includes('/issue/7/')) {
        return detail ? new Response(JSON.stringify(detail)) : new Response('', { status: 404 });
      }
      if (url.pathname.endsWith('/issue/')) return pageOf(search);
      return new Response('', { status: 404 });
    });
  }

  test('a confirmed exact barcode on a variant returns the cover settled by barcode', async () => {
    const detail = detailOf(7, [variant('Newsstand', '75960620200300111')]);
    const { client } = withDetail(detail);
    const result = await identifyComic({ ...READ, upc_main: '759606202003', upc_addon: '00111' }, client);
    expect(result).toMatchObject({
      verdict: 'confirmed',
      cover: { status: 'settled', settledBy: 'barcode', label: 'Newsstand' },
    });
  });

  test('a probable verdict has no cover', async () => {
    // The only hit is issue #2 while the cover says #1, so the number conflicts and nothing can confirm.
    const hit = { ...summary(7, 'The Thing'), number: '2' };
    const { client } = withDetail({ ...detailOf(7, [variant('Newsstand', '')]), number: '2' }, [hit]);
    const result = await identifyComic(READ, client);
    expect(result.verdict).toBe('probable');
    expect(result).not.toHaveProperty('cover');
  });

  test('a confirmed match whose detail fetch fails has cover variants_unknown', async () => {
    const { client } = standInMetron((url) => {
      if (url.pathname.endsWith('/issue/')) return pageOf([summary(7, 'The Thing')]);
      // Not found for the verdict's own fetch (stale result), then still unavailable for the cover's.
      return new Response('', { status: 404 });
    });
    const result = await identifyComic(READ, client);
    expect(result).toMatchObject({ verdict: 'confirmed', cover: { status: 'variants_unknown' } });
  });

  test('a compare cover downloads its choices when a covers dir is given', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const images = Bun.serve({
      port: 0,
      fetch: () => new Response(png, { headers: { 'Content-Type': 'image/png' } }),
    });
    servers.push(images);
    const base = `http://127.0.0.1:${images.port}`;
    const detail = detailOf(7, [variant('A', '', `${base}/a.png`), variant('B', '', `${base}/b.png`)]);
    const { client } = withDetail({ ...detail, image: `${base}/main.png` });
    const dir = await mkdtemp(join(tmpdir(), 'identify-covers-'));
    try {
      const result = await identifyComic(READ, client, dir);
      expect(result).toMatchObject({ verdict: 'confirmed', cover: { status: 'compare' } });
      const choices = (result as { cover: { choices: { imagePath?: string }[] } }).cover.choices;
      expect(choices.map((c) => c.imagePath)).toEqual([join(dir, 'main.png'), join(dir, 'a.png'), join(dir, 'b.png')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('edition clues are echoed', async () => {
    const { client } = withDetail(detailOf(7, []));
    const result = await identifyComic(
      { ...READ, edition: 'newsstand', variant_marking: 'Foil', printing: ' 2nd printing ' },
      client,
    );
    expect(result).toMatchObject({
      edition: { edition: 'newsstand', variantMarking: 'Foil', printing: '2nd printing' },
    });
  });

  test('no edition field is returned when none of the clues were read', async () => {
    const { client } = withDetail(detailOf(7, []));
    expect(await identifyComic(READ, client)).not.toHaveProperty('edition');
  });

  test('the cover fetch for a leader whose detail was skipped fetches and settles the detail', async () => {
    const { client } = withDetail(detailOf(7, [variant('Newsstand', '')]));
    expect(await fetchDetail(client, 7, client.callBudget(60_000))).toMatchObject({ id: 7 });
  });

  test('the cover fetch keeps to the call wait budget, so a spent budget fails fast without waiting', async () => {
    const { client, sleeps } = clientFor(() => new Response('', { status: 429, headers: { 'Retry-After': '25' } }));
    expect(await fetchDetail(client, 7, client.callBudget(0))).toBeUndefined();
    expect(sleeps).toEqual([]);
  });

  test('a leader detail that was not found is not fetched again for the cover', async () => {
    const { client, requests } = withDetail(undefined);
    const result = await identifyComic(READ, client);
    expect(result).toMatchObject({ verdict: 'confirmed', cover: { status: 'variants_unknown' } });
    expect(requests.filter((r) => r.startsWith('issue/7/'))).toHaveLength(1);
  });
});
