// ABOUTME: Runs the Metron search cascade for the clues read off a cover and returns the verdict with candidates.
// ABOUTME: Single issues go barcode exact, barcode prefix, then series and number; trades go series then volume.
import { normalizeClues, type Clues, type RawClues } from './clues';
import type { MetronClient, MetronIssueDetail, MetronIssueSummary, MetronPage, MetronResult } from './metron-client';
import {
  decideVerdict,
  missingFromClues,
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

// searched is false when the clues were too thin to make any Metron search, so no_match then says nothing
// about what Metron has.
export type IdentifyResult =
  | { verdict: Verdict; candidates: Candidate[]; missing: MissingHint[]; searched: boolean }
  | LookupFailure;

type Found = Omit<MatchInput, 'clues'>;

// The client's lookups with this call's wait budget already bound.
type Lookup = Pick<MetronClient, 'searchIssues' | 'getIssue' | 'searchSeries'>;

// Metron stores old barcodes without their check digit and modern ones with it, so a prefix search uses the
// 11 digits before the check digit, and only a 12-digit main plus a 5-digit add-on is looked up exactly.
const UPC_BODY_LENGTH = 11;
const FULL_ADDON_LENGTH = 5;
const TRADE_SERIES_TYPE = 'Trade Paperback';
// Bound trades that are not paperbacks, in the order they are preferred when a title has several.
const BOUND_SERIES_TYPES = ['Hardcover', 'Omnibus'];
// The spec's total wait per identify_comic call; once it has passed, no new Metron request starts.
const CALL_WAIT_BUDGET_MS = 60_000;
// The spec's target number of Metron requests per identify_comic call.
const MAX_REQUESTS = 4;
// Metron names trade series like "Batman TPB (2022)"; the suffix is dropped to compare them with a cover title.
const TRADE_SUFFIX = /\s+(?:TPB|HC|Omnibus)(?:\s+\(\d{4}\))?$/i;

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

async function searchIssues(client: Lookup, params: Record<string, string>) {
  return unwrap(await client.searchIssues(params), params);
}

async function searchSeries(client: Lookup, params: Record<string, string>) {
  return unwrap(await client.searchSeries(params), params).results;
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

// A barcode-prefix hit is never decisive on its own: when a title was read and no hit is in that series, a
// misread digit may have landed on another series' barcode, so the title search must run.
export function prefixHitStands(clues: Clues, hits: MetronIssueSummary[]): boolean {
  if (clues.seriesTitle === undefined) return true;
  const wanted = normalizeTitle(clues.seriesTitle);
  return hits.some((issue) => normalizeTitle(issue.series.name) === wanted);
}

async function findSingleIssue(clues: Clues, client: Lookup): Promise<Found | undefined> {
  // The add-on is not read as an issue number: on old barcodes it is the cover month, and modern add-ons are
  // covered by the exact UPC lookup.
  const number: Record<string, string> = clues.issueNumber ? { number: clues.issueNumber } : {};
  // cover_month and publisher_name are not sent: a misread month would hide the issue, and a printed publisher
  // ("Marvel Comics Group") does not match Metron's name ("Marvel"). The verdict still compares the month.
  const year: Record<string, string> = clues.coverYear ? { cover_year: String(clues.coverYear) } : {};
  const exactTried = clues.upcMain !== undefined && clues.upcAddon?.length === FULL_ADDON_LENGTH;

  if (exactTried) {
    const page = await searchIssues(client, { upc: `${clues.upcMain}${clues.upcAddon}` });
    if (page.results.length > 0) return found(page, 'upc_exact');
  }

  let prefixPage: MetronPage<MetronIssueSummary> | undefined;
  if (clues.upcMain) {
    const prefix = { upc_starts_with: clues.upcMain.slice(0, UPC_BODY_LENGTH) };
    prefixPage = await searchIssues(client, { ...prefix, ...number });
    if (prefixPage.results.length > 0 && prefixHitStands(clues, prefixPage.results)) {
      return found(prefixPage, 'upc_prefix');
    }

    // Metron lacks barcodes for some issues, so the barcode's other issues name the series to look in.
    // Skipped when a title can be searched instead or an exact lookup was made, to stay within 4 requests.
    // Trade-off: a full barcode and issue number with no title therefore never reach this series fallback.
    if (clues.issueNumber && !clues.seriesTitle && !exactTried) {
      const barcodePage = await searchIssues(client, prefix);
      const seriesIds = new Set(barcodePage.results.map((issue) => issue.series.id));
      if (seriesIds.size === 1) {
        const [seriesId] = seriesIds;
        return found(await searchIssues(client, { series_id: String(seriesId), ...number, ...year }), 'upc_prefix');
      }
      // With no title to choose between the series, the barcode's issues are the candidates; their numbers
      // differ from the one read, so the verdict is at best probable.
      if (seriesIds.size > 1) return found(barcodePage, 'upc_prefix');
    }
  }

  if (!clues.seriesTitle) return undefined;
  const title = clues.seriesTitle;
  const page = await searchIssues(client, { series_name: searchTitle(title), ...number, ...year });
  // A title that finds nothing may be misread, so barcode hits rejected for disagreeing with it are kept;
  // upc_prefix cannot confirm without series, number and year agreeing, so this is at best probable.
  if (page.results.length === 0 && prefixPage && prefixPage.results.length > 0) return found(prefixPage, 'upc_prefix');
  return found(
    page,
    'series_number',
    sameTitle(page.results, title, (issue) => issue.series.name),
  );
}

export function tradeTitle(seriesName: string): string {
  return seriesName.replace(TRADE_SUFFIX, '');
}

async function findTradeSeries(client: Lookup, title: string) {
  const name = searchTitle(title);
  const paperbacks = await searchSeries(client, { series_type: TRADE_SERIES_TYPE, name });
  if (paperbacks.length > 0) return paperbacks;
  // Metron's series_type filter takes one type (a list is a 400), so hardcovers and omnibuses come from one
  // unfiltered title search, picked by type here, which keeps a trade lookup within 4 requests.
  const all = await searchSeries(client, { name });
  for (const type of BOUND_SERIES_TYPES) {
    const ofType = all.filter((s) => s.series_type.name === type);
    if (ofType.length > 0) return ofType;
  }
  return [];
}

async function findTrade(clues: Clues, client: Lookup): Promise<Found | undefined> {
  if (!clues.seriesTitle) return undefined;
  const title = clues.seriesTitle;
  const series = sameTitle(await findTradeSeries(client, title), title, (s) => tradeTitle(s.series));
  if (series.length === 0) return undefined;

  // A trade's issue number is its volume number within the trade series.
  const number: Record<string, string> = clues.issueNumber ? { number: clues.issueNumber } : {};
  if (series.length === 1) {
    return found(await searchIssues(client, { series_id: String(series[0].id), ...number }), 'trade_title');
  }
  // Metron's issue search cannot filter by series type, so several trade series are found by title and kept.
  const tradeSeriesIds = new Set(series.map((s) => s.id));
  const page = await searchIssues(client, { series_name: searchTitle(title), ...number });
  const tradeIssues = page.results.filter((issue) => tradeSeriesIds.has(issue.series.id));
  if (tradeIssues.length === 0 && page.results.length < page.count) {
    // A common title's first page can hold only single issues, so the first trade series is searched by id.
    // The other trade series were not searched, so the title search's full count is kept: never no_match.
    const firstSeries = await searchIssues(client, { series_id: String(series[0].id), ...number });
    return { issues: firstSeries.results, totalCount: page.count, matchedBy: 'trade_title' };
  }
  return found(page, 'trade_title', tradeIssues);
}

// Re-judges with the leader replaced by its detail. Only the leader, whose barcode and reprint status were
// checked, may be confirmed; a runner-up left as the only fit is still a summary, so it is at best probable.
export function judgeWithDetail(clues: Clues, match: Found, leader: MetronIssueDetail) {
  const issues = match.issues.map((issue) => (issue.id === leader.id ? leader : issue));
  return decideVerdict({ clues, ...match, issues, confirmOnlyId: leader.id });
}

// Variants, reprints and printing marks are only on an issue's detail, so the leading candidate is judged on
// its detail. A detail that is not found means the search result was stale; the leader is then judged as found.
// When the searches used the whole request budget the detail is skipped, so a trade then cannot confirm.
async function judgeWithLeaderDetail(clues: Clues, client: Lookup, match: Found, detailAllowed: boolean) {
  const first = decideVerdict({ clues, ...match });
  const leaderId = first.candidates[0]?.metronId;
  if (leaderId === undefined || !detailAllowed) return first;

  const result = await client.getIssue(leaderId);
  if (!result.ok && result.reason === 'not_found') return first;
  return judgeWithDetail(clues, match, unwrap(result, { issue: leaderId }));
}

export async function identifyComic(raw: RawClues, client: MetronClient): Promise<IdentifyResult> {
  const clues = normalizeClues(raw);
  const budget = client.callBudget(CALL_WAIT_BUDGET_MS);
  let requests = 0;
  const lookup: Lookup = {
    searchIssues: (params) => (requests++, client.searchIssues(params, budget)),
    getIssue: (id) => (requests++, client.getIssue(id, budget)),
    searchSeries: (params) => (requests++, client.searchSeries(params, budget)),
  };
  try {
    const match = clues.format === 'trade' ? await findTrade(clues, lookup) : await findSingleIssue(clues, lookup);
    const searched = requests > 0;
    if (!match && !searched) return { verdict: 'no_match', candidates: [], missing: missingFromClues(clues), searched };
    if (!match) return { verdict: 'no_match', candidates: [], missing: [], searched };
    return { ...(await judgeWithLeaderDetail(clues, lookup, match, requests < MAX_REQUESTS)), searched };
  } catch (error) {
    if (error instanceof LookupFailed) return error.result;
    throw error;
  }
}
