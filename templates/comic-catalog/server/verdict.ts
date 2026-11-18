// ABOUTME: Compares Metron issues with the clues read off a cover and decides a verdict with evidence.
// ABOUTME: Pure functions only; no numeric confidence, just evidence, conflicts and missing-evidence hints.
import { normalizeIssueNumber, type Clues } from './clues';
import type { MetronIssueDetail, MetronIssueSummary } from './metron-client';

export type Verdict = 'confirmed' | 'probable' | 'ambiguous' | 'no_match';
export type MissingHint = 'barcode_closeup' | 'barcode_addon' | 'indicia' | 'isbn' | 'issue_number' | 'cover_date';

export interface Candidate {
  metronId: number;
  series: string;
  volume: number;
  yearBegan: number;
  number: string;
  coverDate: string | null;
  publisher?: string;
  coverImageUrl: string | null;
  evidence: string[];
  conflicts: string[];
  variantOrPrintingUndetermined: boolean;
  isReprintOrFacsimile: boolean;
}

export interface MatchInput {
  clues: Clues;
  issues: (MetronIssueSummary | MetronIssueDetail)[];
  totalCount: number;
  matchedBy: 'upc_exact' | 'upc_prefix' | 'series_number' | 'trade_isbn' | 'trade_title';
}

type MetronIssue = MetronIssueSummary | MetronIssueDetail;

const MAX_CANDIDATES = 5;
const BARCODE_BODY_LENGTH = 11;
const FIRST_BARCODE_YEAR = 1977;

// A candidate plus which clues agreed, which decideVerdict needs for its confirm rule.
interface Assessment {
  candidate: Candidate;
  seriesAgrees: boolean;
  numberAgrees: boolean;
  yearAgrees: boolean;
  monthAgrees: boolean;
  isbnMatches: boolean;
  printingConflict: boolean;
}

function isDetail(issue: MetronIssue): issue is MetronIssueDetail {
  return 'reprints' in issue;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function assess(clues: Clues, issue: MetronIssue, matchedBy: MatchInput['matchedBy']): Assessment {
  const evidence: string[] = [];
  const conflicts: string[] = [];
  const detail = isDetail(issue) ? issue : undefined;
  const reprints = detail !== undefined && detail.reprints.length > 0;

  const seriesAgrees =
    clues.seriesTitle !== undefined && normalizeTitle(clues.seriesTitle) === normalizeTitle(issue.series.name);
  if (seriesAgrees) evidence.push('series matches');

  const numberAgrees =
    clues.issueNumber !== undefined &&
    clues.issueNumber.toLowerCase() === normalizeIssueNumber(issue.number).toLowerCase();
  if (numberAgrees) evidence.push('issue number matches');
  else if (clues.issueNumber !== undefined) {
    conflicts.push(`issue number read as ${clues.issueNumber} but Metron has ${issue.number}`);
  }

  const [metronYear, metronMonth] = (issue.cover_date ?? '').split('-').map(Number);
  const yearAgrees = clues.coverYear !== undefined && metronYear === clues.coverYear;
  if (yearAgrees) evidence.push('cover year matches');
  else if (clues.coverYear !== undefined && metronYear) {
    conflicts.push(`cover year read as ${clues.coverYear} but Metron has ${metronYear}`);
  }

  const monthAgrees = clues.coverMonth !== undefined && metronMonth === clues.coverMonth;
  if (monthAgrees) evidence.push('cover month matches');
  else if (clues.coverMonth !== undefined && metronMonth) {
    conflicts.push(`cover month read as ${clues.coverMonth} but Metron has ${metronMonth}`);
  }

  if (matchedBy === 'upc_exact') evidence.push('barcode matches exactly');
  if (detail?.upc && clues.upcMain !== undefined) {
    if (!detail.upc.startsWith(clues.upcMain.slice(0, BARCODE_BODY_LENGTH))) {
      conflicts.push(`barcode read as ${clues.upcMain} but Metron has ${detail.upc}`);
    }
  }

  const isbnMatches = clues.isbn !== undefined && !!detail?.isbn && clues.isbn === detail.isbn;
  if (isbnMatches) evidence.push('ISBN matches');
  else if (clues.isbn !== undefined && detail?.isbn) {
    conflicts.push(`ISBN read as ${clues.isbn} but Metron has ${detail.isbn}`);
  }

  // Reprint series do not mark their covers, so an unmarked reprint candidate is only flagged, never a conflict.
  const printingConflict = (clues.printingKind === 'reprint' || clues.printingKind === 'facsimile') && !reprints;
  if (printingConflict) {
    conflicts.push(`cover reads as ${clues.printingKind} but Metron lists this issue as an original`);
  }

  return {
    candidate: {
      metronId: issue.id,
      series: issue.series.name,
      volume: issue.series.volume,
      yearBegan: issue.series.year_began,
      number: issue.number,
      coverDate: issue.cover_date,
      publisher: detail?.publisher?.name,
      coverImageUrl: issue.image,
      evidence,
      conflicts,
      variantOrPrintingUndetermined: (detail?.variants.length ?? 0) > 0 || clues.printingKind === 'later_printing',
      isReprintOrFacsimile: reprints,
    },
    seriesAgrees,
    numberAgrees,
    yearAgrees,
    monthAgrees,
    isbnMatches,
    printingConflict,
  };
}

export function evaluateCandidate(clues: Clues, issue: MetronIssue, matchedBy: MatchInput['matchedBy']): Candidate {
  return assess(clues, issue, matchedBy).candidate;
}

function meetsConfirmCondition(clues: Clues, matchedBy: MatchInput['matchedBy'], a: Assessment): boolean {
  if (clues.format === 'trade') return a.isbnMatches;
  if (matchedBy === 'upc_exact') return true;
  const monthOk = clues.coverMonth === undefined || a.monthAgrees;
  return a.seriesAgrees && a.numberAgrees && a.yearAgrees && monthOk;
}

function missingHints(clues: Clues, listed: Assessment[]): MissingHint[] {
  const missing: MissingHint[] = [];
  if (clues.issueNumber === undefined) missing.push('issue_number');
  if (clues.coverYear === undefined) missing.push('cover_date');
  if (clues.format === 'trade') {
    if (clues.isbn === undefined) missing.push('isbn');
  } else {
    const barcodeEra = clues.coverYear === undefined || clues.coverYear >= FIRST_BARCODE_YEAR;
    if (clues.upcMain === undefined && barcodeEra) missing.push('barcode_closeup');
    if (clues.upcMain !== undefined && clues.upcAddon === undefined) missing.push('barcode_addon');
  }
  if (listed.some((a) => a.printingConflict) || listed[0]?.candidate.variantOrPrintingUndetermined) {
    missing.push('indicia');
  }
  return missing;
}

// Verdict rules (see "Verdict rules" in the Phase 2 design spec):
// - no_match: Metron returned nothing. Candidates and missing are empty.
// - ambiguous: Metron has more matches than were returned (totalCount > issues.length), or two or more
//   candidates have no conflicting clue.
// - confirmed: exactly one candidate has no conflicting clue, and either (a) the search matched a full modern
//   barcode exactly (matchedBy 'upc_exact'), or (b) series, issue number and cover year all agree (cover month
//   too, when read). For format 'trade' only a matching ISBN confirms; nothing else does.
// - probable: anything else with at least one candidate, including when every candidate has a conflict.
// - Any conflict between a read clue and a candidate (e.g. a different issue number) prevents confirmed.
// - Printings and variants (decided by littlelazer): verdicts are at issue level. A later-printing mark, or an
//   exact barcode hit on a variant cover, can still confirm; the candidate then carries
//   variantOrPrintingUndetermined when Metron lists variants. A reprint or facsimile mark on the cover against
//   a candidate Metron lists as an original is a conflict and blocks confirmed. A reprint candidate whose cover
//   has no mark is not a conflict; it only sets isReprintOrFacsimile.
// - Candidates are ranked by fewest conflicts, then most evidence, then Metron's order, and capped at 5.
// - missing (only when not confirmed): issue_number, cover_date, then barcode_closeup (no barcode read and the
//   cover year is 1977 or later or unknown) / barcode_addon (main read, add-on not) for single issues or isbn
//   for trades, then indicia when a listed candidate has a printing conflict or the top candidate has
//   variantOrPrintingUndetermined.
export function decideVerdict(input: MatchInput): { verdict: Verdict; candidates: Candidate[]; missing: MissingHint[] } {
  const { clues, issues, totalCount, matchedBy } = input;
  if (issues.length === 0) return { verdict: 'no_match', candidates: [], missing: [] };

  const ranked = issues
    .map((issue) => assess(clues, issue, matchedBy))
    .map((assessment, order) => ({ assessment, order }))
    .sort(
      (x, y) =>
        x.assessment.candidate.conflicts.length - y.assessment.candidate.conflicts.length ||
        y.assessment.candidate.evidence.length - x.assessment.candidate.evidence.length ||
        x.order - y.order,
    )
    .map(({ assessment }) => assessment)
    .slice(0, MAX_CANDIDATES);
  const candidates = ranked.map((a) => a.candidate);

  const conflictFree = ranked.filter((a) => a.candidate.conflicts.length === 0);
  let verdict: Verdict = 'probable';
  if (totalCount > issues.length || conflictFree.length >= 2) verdict = 'ambiguous';
  else if (conflictFree.length === 1 && meetsConfirmCondition(clues, matchedBy, conflictFree[0])) {
    verdict = 'confirmed';
  }

  return { verdict, candidates, missing: verdict === 'confirmed' ? [] : missingHints(clues, ranked) };
}
