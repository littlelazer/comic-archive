// ABOUTME: Unit tests for candidate evidence and verdict rules, one per rule and conflict case.
// ABOUTME: Issues are plain objects in the Metron response shape for The Thing (1983) #1, Metron 13806.
import { describe, expect, test } from 'bun:test';
import type { Clues } from './clues';
import type { MetronIssueDetail, MetronIssueSummary } from './metron-client';
import { decideVerdict, evaluateCandidate } from './verdict';

function summary(overrides: Partial<MetronIssueSummary> = {}): MetronIssueSummary {
  return {
    id: 13806,
    series: { id: 1343, name: 'The Thing', volume: 1, year_began: 1983 },
    number: '1',
    issue: 'The Thing (1983) #1',
    cover_date: '1983-07-01',
    image: 'https://static.metron.cloud/media/issue/2020/06/12/thing-v1-1.jpg',
    ...overrides,
  };
}

function detail(overrides: Partial<MetronIssueDetail> = {}): MetronIssueDetail {
  const { issue: _issue, ...rest } = summary();
  return { ...rest, publisher: { name: 'Marvel' }, upc: '', isbn: '', variants: [], reprints: [], ...overrides };
}

function clues(overrides: Partial<Clues> = {}): Clues {
  return { format: 'single_issue', ...overrides };
}

const TITLE_NUMBER_YEAR = { seriesTitle: 'The Thing', issueNumber: '1', coverYear: 1983 };
const FULL_BARCODE = { upcMain: '071486029661', upcAddon: '00111' };

describe('evaluateCandidate', () => {
  test('describes the issue and what agrees', () => {
    const candidate = evaluateCandidate(clues({ ...TITLE_NUMBER_YEAR, coverMonth: 7 }), detail(), 'series_number');
    expect(candidate).toMatchObject({
      metronId: 13806,
      series: 'The Thing',
      volume: 1,
      yearBegan: 1983,
      number: '1',
      coverDate: '1983-07-01',
      publisher: 'Marvel',
      coverImageUrl: 'https://static.metron.cloud/media/issue/2020/06/12/thing-v1-1.jpg',
      conflicts: [],
      variantOrPrintingUndetermined: false,
      isReprintOrFacsimile: false,
    });
    expect(candidate.evidence).toEqual(['series matches', 'issue number matches', 'cover year matches', 'cover month matches']);
  });

  test('names the issue number in a conflict', () => {
    const candidate = evaluateCandidate(clues(TITLE_NUMBER_YEAR), summary({ number: '2' }), 'series_number');
    expect(candidate.conflicts.join(' ')).toContain('issue number');
  });

  test('a barcode that starts differently is a conflict, and an empty upc is not', () => {
    const different = evaluateCandidate(clues(FULL_BARCODE), detail({ upc: '09999999999' }), 'upc_prefix');
    expect(different.conflicts.join(' ')).toContain('barcode');
    const absent = evaluateCandidate(clues(FULL_BARCODE), detail({ upc: '' }), 'upc_prefix');
    expect(absent.conflicts).toEqual([]);
  });

  test('exact barcode match is evidence', () => {
    const candidate = evaluateCandidate(clues(FULL_BARCODE), detail({ upc: '07148602966100111' }), 'upc_exact');
    expect(candidate.evidence).toContain('barcode matches exactly');
  });

  test('a mismatched ISBN is a conflict and a matching ISBN is evidence', () => {
    const trade = clues({ format: 'trade', isbn: '9781302900533' });
    expect(evaluateCandidate(trade, detail({ isbn: '9781302900533' }), 'trade_title').evidence).toContain('ISBN matches');
    expect(evaluateCandidate(trade, detail({ isbn: '9781302900540' }), 'trade_title').conflicts.join(' ')).toContain('ISBN');
  });

  test('an ISBN Metron stores with hyphens or spaces still matches', () => {
    const trade = clues({ format: 'trade', isbn: '9781302900533' });
    const candidate = evaluateCandidate(trade, detail({ isbn: '978-1-302 90053-3' }), 'trade_title');
    expect(candidate.evidence).toContain('ISBN matches');
    expect(candidate.conflicts).toEqual([]);
  });

  test('facsimile clue against a non-reprint candidate is a conflict', () => {
    const candidate = evaluateCandidate(clues({ printingKind: 'facsimile' }), detail(), 'series_number');
    expect(candidate.conflicts).toEqual(['cover reads as facsimile but Metron does not list this issue as a reprint']);
  });

  test('a reprint candidate with no mark on the cover is a flag, not a conflict', () => {
    const reprint = detail({ reprints: [{ id: 1, issue: 'Marvel Tales (1966) #1' }] });
    const candidate = evaluateCandidate(clues(), reprint, 'series_number');
    expect(candidate.isReprintOrFacsimile).toBe(true);
    expect(candidate.conflicts).toEqual([]);
  });

  test('a reprint clue against a reprint candidate is not a conflict', () => {
    const reprint = detail({ reprints: [{ id: 1, issue: 'Marvel Tales (1966) #1' }] });
    expect(evaluateCandidate(clues({ printingKind: 'reprint' }), reprint, 'series_number').conflicts).toEqual([]);
  });

  test('flags variants and later printings as undetermined', () => {
    expect(evaluateCandidate(clues(), detail({ variants: [{ name: 'Newsstand' }] }), 'series_number').variantOrPrintingUndetermined).toBe(true);
    expect(evaluateCandidate(clues({ printingKind: 'later_printing' }), detail(), 'series_number').variantOrPrintingUndetermined).toBe(true);
    expect(evaluateCandidate(clues(), detail(), 'series_number').variantOrPrintingUndetermined).toBe(false);
  });
});

describe('decideVerdict', () => {
  test('confirms on exact full modern barcode with no conflicts', () => {
    const result = decideVerdict({
      clues: clues(FULL_BARCODE),
      issues: [detail({ upc: '07148602966100111' })],
      totalCount: 1,
      matchedBy: 'upc_exact',
    });
    expect(result.verdict).toBe('confirmed');
    expect(result.missing).toEqual([]);
  });

  test('confirms when series, number and year agree and one candidate remains', () => {
    const result = decideVerdict({ clues: clues(TITLE_NUMBER_YEAR), issues: [summary()], totalCount: 1, matchedBy: 'series_number' });
    expect(result.verdict).toBe('confirmed');
  });

  test('does not confirm when the issue number conflicts', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, issueNumber: '2' }),
      issues: [summary()],
      totalCount: 1,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('probable');
    expect(result.candidates[0].conflicts.join(' ')).toContain('issue number');
  });

  test('does not confirm when the cover month conflicts', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, coverMonth: 3 }),
      issues: [summary()],
      totalCount: 1,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('probable');
    expect(result.candidates[0].conflicts.join(' ')).toContain('cover month');
  });

  test('does not confirm when the cover year conflicts', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, coverYear: 1990 }),
      issues: [summary()],
      totalCount: 1,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('probable');
  });

  test('confirms only when the month agrees if a month was read', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, coverMonth: 7 }),
      issues: [summary()],
      totalCount: 1,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('confirmed');
  });

  test('is ambiguous with two equally fitting volumes and no year', () => {
    const second = summary({ id: 99, series: { id: 2000, name: 'The Thing', volume: 2, year_began: 2005 }, cover_date: '2005-01-01' });
    const result = decideVerdict({
      clues: clues({ seriesTitle: 'The Thing', issueNumber: '1' }),
      issues: [summary(), second],
      totalCount: 2,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('ambiguous');
    expect(result.missing).toContain('cover_date');
    expect(result.candidates).toHaveLength(2);
  });

  test('confirmOnlyId lets only that candidate confirm; another sole fit is probable with the usual hints', () => {
    const input = {
      clues: clues({ ...TITLE_NUMBER_YEAR, upcMain: '071486029663' }),
      issues: [detail({ id: 1, upc: '0799999999901' }), summary({ id: 2 })],
      totalCount: 2,
      matchedBy: 'series_number' as const,
    };
    expect(decideVerdict(input).verdict).toBe('confirmed');
    const result = decideVerdict({ ...input, confirmOnlyId: 1 });
    expect(result.verdict).toBe('probable');
    expect(result.candidates[0].metronId).toBe(2);
    expect(result.missing).toEqual([]);
    expect(decideVerdict({ ...input, confirmOnlyId: 2 }).verdict).toBe('confirmed');
  });

  test('is ambiguous, not no_match, when no issue was returned but Metron counts matches not inspected', () => {
    const result = decideVerdict({ clues: clues({ seriesTitle: 'Batman', format: 'trade' }), issues: [], totalCount: 250, matchedBy: 'trade_title' });
    expect(result).toEqual({ verdict: 'ambiguous', candidates: [], missing: ['issue_number', 'cover_date', 'isbn'] });
  });

  test('is ambiguous when totalCount exceeds returned results', () => {
    const result = decideVerdict({ clues: clues(TITLE_NUMBER_YEAR), issues: [summary()], totalCount: 7, matchedBy: 'series_number' });
    expect(result.verdict).toBe('ambiguous');
  });

  test('is probable with one candidate but no year read', () => {
    const result = decideVerdict({
      clues: clues({ seriesTitle: 'The Thing', issueNumber: '1' }),
      issues: [summary()],
      totalCount: 1,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('probable');
    expect(result.missing).toContain('cover_date');
  });

  test('is probable, best first, when every candidate has a conflict', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, issueNumber: '5', coverYear: 1990 }),
      issues: [summary(), summary({ id: 2, number: '5' })],
      totalCount: 2,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('probable');
    expect(result.candidates[0].metronId).toBe(2);
  });

  test('asks for a barcode close-up when no barcode was read on a barcode-era issue', () => {
    const noYear = decideVerdict({ clues: clues({ seriesTitle: 'The Thing', issueNumber: '1' }), issues: [summary()], totalCount: 1, matchedBy: 'series_number' });
    expect(noYear.missing).toContain('barcode_closeup');
    const eighties = decideVerdict({ clues: clues({ ...TITLE_NUMBER_YEAR, coverMonth: 3 }), issues: [summary()], totalCount: 1, matchedBy: 'series_number' });
    expect(eighties.missing).toContain('barcode_closeup');
    const old = decideVerdict({
      clues: clues({ seriesTitle: 'The Thing', issueNumber: '1', coverYear: 1965 }),
      issues: [summary({ cover_date: '1966-01-01' })],
      totalCount: 1,
      matchedBy: 'series_number',
    });
    expect(old.missing).not.toContain('barcode_closeup');
  });

  test('asks for the add-on when only the main barcode was read', () => {
    const result = decideVerdict({
      clues: clues({ seriesTitle: 'The Thing', upcMain: '071486029661' }),
      issues: [summary()],
      totalCount: 1,
      matchedBy: 'upc_prefix',
    });
    expect(result.verdict).toBe('probable');
    expect(result.missing).toEqual(['issue_number', 'cover_date', 'barcode_addon']);
  });

  test('asks for the add-on only on covers from the 5-digit add-on era, whose add-on pins the issue', () => {
    const missingFor = (coverYear: number) =>
      decideVerdict({
        clues: clues({ seriesTitle: 'The Thing', upcMain: '071486029661', coverYear }),
        issues: [summary({ cover_date: `${coverYear}-07-01` })],
        totalCount: 1,
        matchedBy: 'upc_prefix',
      }).missing;
    expect(missingFor(1983)).not.toContain('barcode_addon');
    expect(missingFor(2007)).not.toContain('barcode_addon');
    expect(missingFor(2008)).toContain('barcode_addon');
    expect(missingFor(2022)).toContain('barcode_addon');
  });

  test('confirms a later printing at issue level and flags variantOrPrintingUndetermined when variants exist', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, printingKind: 'later_printing' }),
      issues: [detail({ variants: [{ name: 'Newsstand' }] })],
      totalCount: 1,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('confirmed');
    expect(result.candidates[0].variantOrPrintingUndetermined).toBe(true);
  });

  test('facsimile clue against a non-reprint candidate blocks confirmation and asks for the indicia', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, printingKind: 'facsimile' }),
      issues: [detail()],
      totalCount: 1,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('probable');
    expect(result.missing).toContain('indicia');
  });

  test('a reprint mark against a reprint candidate can still confirm', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, printingKind: 'facsimile' }),
      issues: [detail({ reprints: [{ id: 1, issue: 'The Thing (1983) #1' }] })],
      totalCount: 1,
      matchedBy: 'series_number',
    });
    expect(result.verdict).toBe('confirmed');
    expect(result.candidates[0].isReprintOrFacsimile).toBe(true);
  });

  test('trade without matching ISBN is at best probable', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, format: 'trade' }),
      issues: [detail()],
      totalCount: 1,
      matchedBy: 'trade_title',
    });
    expect(result.verdict).toBe('probable');
    expect(result.missing).toEqual(['isbn']);
  });

  test('trade with matching ISBN confirms', () => {
    const result = decideVerdict({
      clues: clues({ ...TITLE_NUMBER_YEAR, format: 'trade', isbn: '9781302900533' }),
      issues: [detail({ isbn: '9781302900533' })],
      totalCount: 1,
      matchedBy: 'trade_title',
    });
    expect(result.verdict).toBe('confirmed');
  });

  test('no issues is no_match with no candidates', () => {
    const result = decideVerdict({ clues: clues(TITLE_NUMBER_YEAR), issues: [], totalCount: 0, matchedBy: 'series_number' });
    expect(result).toEqual({ verdict: 'no_match', candidates: [], missing: [] });
  });

  test('caps candidates at 5, best first', () => {
    const issues = [1, 2, 3, 4, 5, 6, 7].map((id) => summary({ id, number: id === 7 ? '1' : '9' }));
    const result = decideVerdict({ clues: clues({ issueNumber: '1' }), issues, totalCount: 7, matchedBy: 'series_number' });
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates[0].metronId).toBe(7);
  });
});
