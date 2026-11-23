// ABOUTME: Live tests of the identifyComic search cascade against real Metron, through the credential gateway.
// ABOUTME: Skipped unless HTTPS_PROXY is set, which `onecli run` provides; each test allows for rate-limit waits.
import { describe, expect, test } from 'bun:test';
import { identifyComic } from './identify';
import { METRON_BASE_URL, createMetronClient, type MetronClient } from './metron-client';

// Fixtures, found with `onecli run … curl` against https://metron.cloud/api/ (2026-11-18):
// - The Thing (1983) #1 is Metron 13806 in series 1343, from the Phase 2 spec. Metron has no UPC for #1, but
//   `issue/?upc_starts_with=07148602966` returns ten later issues of series 1343 (e.g. #6 13811, upc
//   0714860296612), so the barcode identifies the series and the issue number finds #1 in it.
// - Modern full barcode: `issue/?series_name=amazing spider-man&number=1&cover_year=2022` gave 44879,
//   The Amazing Spider-Man (2022) #1, whose detail has upc 75960620200300111 (12-digit main with its check
//   digit, then the 5-digit add-on 00111) and eleven variants.
// - Trade with ISBN: `series/?name=civil war&series_type=Trade Paperback` gave series 16787, "Alice On the Run:
//   One Child's Journey Through the Rwandan Civil War TPB (2022)"; `issue/?series_id=16787&number=1` gave
//   177188, whose detail has isbn 9781643375434.
// - Same title across volumes: `issue/?series_name=thor&number=1` has count 113 over more than one page,
//   including Thor (1998), (2007), (2014), (2018), (2020) and (2025) #1.
// - Month-only cover: `issue/?series_name=Thing&number=1` has count 107 with 100 per page (2026-11-23); The Thing
//   (1983) #1 and The Thing (2025) #1 (145418) are both July issues.
// - Hardcover trade: the same Thor search listed 188699, "Superman: The Last Days of Lex Luthor HC (2025) #1",
//   alongside the 2023 limited series of that title.
const THE_THING_1 = 13806;
const THE_THING_2025_1 = 145418;
const THE_THING_BARCODE = '071486029663';
const ASM_2022_1 = 44879;
const ALICE_TPB_1 = 177188;
const ALICE_ISBN = '9781643375434';
const LEX_LUTHOR_HC_1 = 188699;
const LIVE_TIMEOUT_MS = 120_000;

function countingClient(client: MetronClient) {
  const counter = { requests: 0 };
  const counted: MetronClient = {
    searchIssues: (params, budget) => (counter.requests++, client.searchIssues(params, budget)),
    getIssue: (id, budget) => (counter.requests++, client.getIssue(id, budget)),
    searchSeries: (params, budget) => (counter.requests++, client.searchSeries(params, budget)),
    callBudget: client.callBudget,
  };
  return { client: counted, counter };
}

describe.skipIf(!process.env.HTTPS_PROXY)('identifyComic against real Metron', () => {
  const client = createMetronClient({ baseUrl: METRON_BASE_URL, userAgent: 'comic-archive/0.2.0' });

  test(
    'live: The Thing #1 confirms from series, number, year and month',
    async () => {
      const result = await identifyComic(
        { series_title: 'The Thing', issue_number: '1', cover_year: 1983, cover_month: 7, format: 'single_issue' },
        client,
      );
      expect(result.verdict).toBe('confirmed');
      expect(result.candidates[0].metronId).toBe(THE_THING_1);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: The Thing #1 from barcode prefix plus issue number',
    async () => {
      const result = await identifyComic({ upc_main: THE_THING_BARCODE, issue_number: '1' }, client);
      expect(['confirmed', 'probable']).toContain(result.verdict);
      expect(result.candidates[0].metronId).toBe(THE_THING_1);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: "The Thing" and "Thing" both find series 1343',
    async () => {
      for (const title of ['The Thing', 'Thing']) {
        const result = await identifyComic({ series_title: title, issue_number: '1', cover_year: 1983 }, client);
        expect(result.candidates[0].metronId).toBe(THE_THING_1);
        expect(result.candidates[0].series).toBe('The Thing');
      }
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: modern full barcode confirms by exact UPC',
    async () => {
      const result = await identifyComic({ upc_main: '759606202003', upc_addon: '00111' }, client);
      expect(result.verdict).toBe('confirmed');
      expect(result.candidates[0].metronId).toBe(ASM_2022_1);
      expect(result.candidates[0].evidence).toContain('barcode matches exactly');
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: trade with ISBN confirms; without ISBN is probable with missing isbn',
    async () => {
      const trade = { series_title: 'Alice On the Run', issue_number: '1', format: 'trade' } as const;
      const withIsbn = await identifyComic({ ...trade, isbn: ALICE_ISBN }, client);
      expect(withIsbn.verdict).toBe('confirmed');
      expect(withIsbn.candidates[0].metronId).toBe(ALICE_TPB_1);

      const withoutIsbn = await identifyComic(trade, client);
      expect(withoutIsbn.verdict).toBe('probable');
      expect(withoutIsbn.candidates[0].metronId).toBe(ALICE_TPB_1);
      expect(withoutIsbn.missing).toContain('isbn');
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: a hardcover trade is found after the paperback search misses, within 4 requests',
    async () => {
      const { client: counted, counter } = countingClient(client);
      const result = await identifyComic(
        { series_title: 'Superman: The Last Days of Lex Luthor', issue_number: '1', format: 'trade' },
        counted,
      );
      expect(result.verdict).toBe('probable');
      expect(result.candidates[0].metronId).toBe(LEX_LUTHOR_HC_1);
      expect(counter.requests).toBeLessThanOrEqual(4);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: a common trade title is not no_match, within 4 requests',
    async () => {
      const { client: counted, counter } = countingClient(client);
      const result = await identifyComic({ series_title: 'Batman', issue_number: '1', format: 'trade' }, counted);
      expect(['probable', 'ambiguous']).toContain(result.verdict);
      expect(result).toMatchObject({ searched: true });
      expect(counter.requests).toBeLessThanOrEqual(4);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: same-title volumes with no year are ambiguous',
    async () => {
      const result = await identifyComic({ series_title: 'Thor', issue_number: '1', format: 'single_issue' }, client);
      expect(result.verdict).toBe('ambiguous');
      expect(result.candidates.length).toBeGreaterThan(1);
      for (const candidate of result.candidates) expect(candidate.series).toBe('Thor');
      expect(result.missing).toContain('cover_date');
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: nonexistent series is no_match',
    async () => {
      const result = await identifyComic({ series_title: 'Zzyzx Quantum Platypus Brigade', issue_number: '1' }, client);
      expect(result).toEqual({ verdict: 'no_match', candidates: [], missing: [], searched: true });
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: a stale leader whose detail is not found is judged on its summary',
    async () => {
      const stale: MetronClient = {
        ...client,
        getIssue: async () => ({ ok: false, reason: 'not_found', retryable: false }),
      };
      const result = await identifyComic(
        { series_title: 'The Thing', issue_number: '1', cover_year: 1983, format: 'single_issue' },
        stale,
      );
      expect(result.verdict).toBe('confirmed');
      expect(result.candidates[0].metronId).toBe(THE_THING_1);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: each call uses at most 4 requests',
    async () => {
      // The barcode-prefix path with a number Metron has no barcode for is the deepest cascade path.
      const { client: counted, counter } = countingClient(client);
      const result = await identifyComic({ upc_main: THE_THING_BARCODE, issue_number: '1' }, counted);
      expect(result.verdict).not.toBe('lookup_failed');
      expect(counter.requests).toBeGreaterThan(0);
      expect(counter.requests).toBeLessThanOrEqual(4);
    },
    LIVE_TIMEOUT_MS,
  );

  test(
    'live: a month-only The Thing #1 cover offers the 1983 and 2025 issues as choices, the page beyond included',
    async () => {
      const counted = countingClient(client);
      const result = await identifyComic(
        { series_title: 'The Thing', issue_number: '1', cover_month: 7, upc_main: THE_THING_BARCODE.slice(0, 11) + '0', upc_addon: '07' },
        counted.client,
      );
      if (result.verdict === 'lookup_failed') throw new Error(`lookup failed: ${result.reason}`);
      expect(result.verdict).toBe('ambiguous');
      expect(result.choices?.map((c) => c.metronId)).toEqual([THE_THING_1, THE_THING_2025_1]);
      expect(counted.counter.requests).toBeLessThanOrEqual(5);
    },
    LIVE_TIMEOUT_MS,
  );
});
