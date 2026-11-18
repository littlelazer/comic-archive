// ABOUTME: Runs the Metron search cascade for the clues read off a cover and returns the verdict with candidates.
// ABOUTME: Single issues go barcode exact, barcode prefix, then series and number; trades go series then volume.
import { normalizeClues, type Clues, type RawClues } from './clues';
import type { MetronClient, MetronIssueSummary, MetronPage, MetronResult } from './metron-client';
import {
  decideVerdict,
  normalizeTitle,
  type Candidate,
  type MatchInput,
  type MissingHint,
  type Verdict,
} from './verdict';

export type LookupFailureReason = 'rate_limited' | 'metron_unavailable' | 'auth';

type LookupFailure = {
  verdict: 'lookup_failed';
  reason: LookupFailureReason;
  retryable: boolean;
  retryAfterSeconds?: number;
  candidates: [];
  missing: [];
};

export type IdentifyResult = { verdict: Verdict; candidates: Candidate[]; missing: MissingHint[] } | LookupFailure;

type Found = Omit<MatchInput, 'clues'>;

// Metron stores old barcodes without their check digit and modern ones with it, so a prefix search uses the
// 11 digits before the check digit, and only a 12-digit main plus a 5-digit add-on is looked up exactly.
const UPC_BODY_LENGTH = 11;
const FULL_ADDON_LENGTH = 5;
const TRADE_SERIES_TYPE = 'Trade Paperback';

class LookupFailed extends Error {
  constructor(readonly result: LookupFailure) {
    super(result.reason);
  }
}

function unwrap<T>(result: MetronResult<T>, query: object): T {
  if (result.ok) return result.data;
  if (result.reason === 'not_found' || result.reason === 'bad_request') {
    // Metron rejecting a query is a bug in how we build it, not an outage, so it is not offered as retryable.
    console.error(`comic-catalog: Metron rejected the query ${JSON.stringify(query)} (${result.reason})`);
    throw new LookupFailed({
      verdict: 'lookup_failed',
      reason: 'metron_unavailable',
      retryable: false,
      candidates: [],
      missing: [],
    });
  }
  const { reason, retryable, retryAfterSeconds } = result;
  throw new LookupFailed({
    verdict: 'lookup_failed',
    reason,
    retryable,
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
    candidates: [],
    missing: [],
  });
}

async function searchIssues(client: MetronClient, params: Record<string, string>) {
  return unwrap(await client.searchIssues(params), params);
}

// Metron's series_name filter matches substrings, so a leading "The" is dropped to find "The Thing" from "Thing".
function searchTitle(title: string): string {
  return title.replace(/^the\s+/i, '');
}

// Keeps the items whose title equals the clue title when any do, since a substring search also finds e.g.
// "Dejah Thoris" for "Thor"; otherwise keeps all, because cover wording can differ from Metron's names.
function sameTitle<T>(items: T[], title: string, name: (item: T) => string): T[] {
  const wanted = normalizeTitle(title);
  const exact = items.filter((item) => normalizeTitle(name(item)) === wanted);
  return exact.length > 0 ? exact : items;
}

// When Metron has more matches than one page, the unseen pages may hold more fits, so the full count is kept
// and the verdict stays ambiguous however the returned page was narrowed.
function found(page: MetronPage<MetronIssueSummary>, matchedBy: Found['matchedBy'], issues = page.results): Found {
  const complete = page.results.length >= page.count;
  return { issues, totalCount: complete ? issues.length : page.count, matchedBy };
}

async function findSingleIssue(clues: Clues, client: MetronClient): Promise<Found | undefined> {
  const number: Record<string, string> = clues.issueNumber ? { number: clues.issueNumber } : {};
  const year: Record<string, string> = clues.coverYear ? { cover_year: String(clues.coverYear) } : {};
  const exactTried = clues.upcMain !== undefined && clues.upcAddon?.length === FULL_ADDON_LENGTH;

  if (exactTried) {
    const page = await searchIssues(client, { upc: `${clues.upcMain}${clues.upcAddon}` });
    if (page.results.length > 0) return found(page, 'upc_exact');
  }

  if (clues.upcMain) {
    const prefix = { upc_starts_with: clues.upcMain.slice(0, UPC_BODY_LENGTH) };
    const page = await searchIssues(client, { ...prefix, ...number });
    if (page.results.length > 0) return found(page, 'upc_prefix');

    // Metron lacks barcodes for some issues, so the barcode's other issues name the series to look in.
    // Skipped when a title can be searched instead or an exact lookup was made, to stay within 4 requests.
    if (clues.issueNumber && !clues.seriesTitle && !exactTried) {
      const seriesIds = new Set((await searchIssues(client, prefix)).results.map((issue) => issue.series.id));
      if (seriesIds.size === 1) {
        const [seriesId] = seriesIds;
        return found(await searchIssues(client, { series_id: String(seriesId), ...number, ...year }), 'upc_prefix');
      }
    }
  }

  if (!clues.seriesTitle) return undefined;
  const title = clues.seriesTitle;
  const page = await searchIssues(client, { series_name: searchTitle(title), ...number, ...year });
  return found(
    page,
    'series_number',
    sameTitle(page.results, title, (issue) => issue.series.name),
  );
}

async function findTrade(clues: Clues, client: MetronClient): Promise<Found | undefined> {
  if (!clues.seriesTitle) return undefined;
  const title = clues.seriesTitle;
  const query = { series_type: TRADE_SERIES_TYPE, name: searchTitle(title) };
  const series = sameTitle(unwrap(await client.searchSeries(query), query).results, title, (s) => s.series);
  if (series.length === 0) return undefined;

  // A trade's issue number is its volume number within the trade series.
  const number: Record<string, string> = clues.issueNumber ? { number: clues.issueNumber } : {};
  if (series.length === 1) {
    return found(await searchIssues(client, { series_id: String(series[0].id), ...number }), 'trade_title');
  }
  // Metron's issue search cannot filter by series type, so several trade series are found by title and kept.
  const tradeSeriesIds = new Set(series.map((s) => s.id));
  const page = await searchIssues(client, { series_name: searchTitle(title), ...number });
  return found(
    page,
    'trade_title',
    page.results.filter((issue) => tradeSeriesIds.has(issue.series.id)),
  );
}

// Variants, reprints and printing marks are only on an issue's detail, so the leading candidate is judged on
// its detail. A detail that is not found means the search result was stale; the leader is then judged as found.
async function judgeWithLeaderDetail(clues: Clues, client: MetronClient, match: Found) {
  const first = decideVerdict({ clues, ...match });
  const leaderId = first.candidates[0]?.metronId;
  if (leaderId === undefined) return first;

  const result = await client.getIssue(leaderId);
  if (!result.ok && result.reason === 'not_found') return first;
  const leader = unwrap(result, { issue: leaderId });
  return decideVerdict({
    clues,
    ...match,
    issues: match.issues.map((issue) => (issue.id === leaderId ? leader : issue)),
  });
}

export async function identifyComic(raw: RawClues, client: MetronClient): Promise<IdentifyResult> {
  const clues = normalizeClues(raw);
  try {
    const match = clues.format === 'trade' ? await findTrade(clues, client) : await findSingleIssue(clues, client);
    if (!match) return { verdict: 'no_match', candidates: [], missing: [] };
    return await judgeWithLeaderDetail(clues, client, match);
  } catch (error) {
    if (error instanceof LookupFailed) return error.result;
    throw error;
  }
}
