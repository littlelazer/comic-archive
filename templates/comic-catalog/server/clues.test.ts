// ABOUTME: Unit tests for normalizing the clues read off a cover into the Clues shape.
// ABOUTME: Covers issue numbers, UPC/ISBN validation, printing classification, and date bounds.
import { describe, expect, test } from 'bun:test';
import { normalizeClues, normalizeIssueNumber, normalizePrice } from './clues';

describe('normalizeIssueNumber', () => {
  test.each([
    ['#1', '1'],
    ['001', '1'],
    ['1A', '1A'],
    ['0.1', '0.1'],
    ['½', '½'],
    ['#0', '0'],
    ['000', '0'],
    ['  # 12 ', '12'],
  ])('%p becomes %p', (printed, expected) => {
    expect(normalizeIssueNumber(printed)).toBe(expected);
  });
});

describe('normalizeClues text fields', () => {
  test('trims series title and publisher and drops empty ones', () => {
    const clues = normalizeClues({ series_title: '  Amazing Spider-Man ', publisher: '   ' });
    expect(clues.seriesTitle).toBe('Amazing Spider-Man');
    expect(clues.publisher).toBeUndefined();
  });

  test('treats an empty issue number as absent and normalizes a present one', () => {
    expect(normalizeClues({ issue_number: '  ' }).issueNumber).toBeUndefined();
    expect(normalizeClues({ issue_number: '#' }).issueNumber).toBeUndefined();
    expect(normalizeClues({ issue_number: '#001' }).issueNumber).toBe('1');
  });

  test('defaults format to unknown and passes through the known values', () => {
    expect(normalizeClues({}).format).toBe('unknown');
    expect(normalizeClues({ format: 'trade' }).format).toBe('trade');
    expect(normalizeClues({ format: 'single_issue' }).format).toBe('single_issue');
  });

  test('treats an unknown format with a legible ISBN as a trade', () => {
    expect(normalizeClues({ isbn: '9781643375434' }).format).toBe('trade');
    expect(normalizeClues({ format: 'unknown', isbn: '9781643375434' }).format).toBe('trade');
    expect(normalizeClues({ format: 'single_issue', isbn: '9781643375434' }).format).toBe('single_issue');
    expect(normalizeClues({ format: 'unknown', isbn: '978164337543' }).format).toBe('unknown');
  });
});

describe('normalizeClues UPC', () => {
  test('removes spaces from a 12-digit UPC-A', () => {
    expect(normalizeClues({ upc_main: '0 71486 12345 2' }).upcMain).toBe('071486123452');
  });

  test('drops a main UPC that is not 12 digits', () => {
    expect(normalizeClues({ upc_main: '0 71486 1234' }).upcMain).toBeUndefined();
    expect(normalizeClues({ upc_main: '0714861234567' }).upcMain).toBeUndefined();
    expect(normalizeClues({ upc_main: 'ABCDEFGHIJKL' }).upcMain).toBeUndefined();
  });

  test('accepts a 2- or 5-digit add-on UPC and drops other lengths', () => {
    expect(normalizeClues({ upc_addon: '01 ' }).upcAddon).toBe('01');
    expect(normalizeClues({ upc_addon: '52 500' }).upcAddon).toBe('52500');
    expect(normalizeClues({ upc_addon: '525' }).upcAddon).toBeUndefined();
    expect(normalizeClues({ upc_addon: '5250012' }).upcAddon).toBeUndefined();
  });
});

describe('normalizeClues ISBN', () => {
  test('accepts an ISBN-13 with hyphens and spaces removed', () => {
    expect(normalizeClues({ isbn: '978-1-302-90188-2' }).isbn).toBe('9781302901882');
    expect(normalizeClues({ isbn: '979 10 90636 07 1' }).isbn).toBe('9791090636071');
  });

  test('drops ISBNs that are not ISBN-13 with a 978 or 979 prefix', () => {
    expect(normalizeClues({ isbn: '0-306-40615-2' }).isbn).toBeUndefined();
    expect(normalizeClues({ isbn: '978130290188' }).isbn).toBeUndefined();
    expect(normalizeClues({ isbn: '9671302901882' }).isbn).toBeUndefined();
  });
});

describe('normalizeClues printing', () => {
  test.each([
    ['2nd printing', 'later_printing'],
    ['Second Printing', 'later_printing'],
    ['3rd print', 'later_printing'],
    ['21st printing', 'later_printing'],
    ['reprint', 'reprint'],
    ['Facsimile Edition', 'facsimile'],
    ['facsimile reprint', 'facsimile'],
  ])('%p is classified as %p', (printing, kind) => {
    expect(normalizeClues({ printing }).printingKind).toBe(kind);
  });

  test.each([['first printing'], ['1st printing'], ['Direct Edition'], ['   ']])(
    '%p maps to no printing kind',
    (printing) => {
      expect(normalizeClues({ printing }).printingKind).toBeUndefined();
    },
  );

  test('is undefined when absent', () => {
    expect(normalizeClues({}).printingKind).toBeUndefined();
  });
});

describe('normalizeClues cover date', () => {
  test('keeps months 1 through 12 and drops anything outside that range', () => {
    expect(normalizeClues({ cover_month: 1 }).coverMonth).toBe(1);
    expect(normalizeClues({ cover_month: 12 }).coverMonth).toBe(12);
    expect(normalizeClues({ cover_month: 0 }).coverMonth).toBeUndefined();
    expect(normalizeClues({ cover_month: 13 }).coverMonth).toBeUndefined();
  });

  test('keeps years from 1930 through next year and drops anything outside that range', () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(normalizeClues({ cover_year: 1930 }).coverYear).toBe(1930);
    expect(normalizeClues({ cover_year: nextYear }).coverYear).toBe(nextYear);
    expect(normalizeClues({ cover_year: 1929 }).coverYear).toBeUndefined();
    expect(normalizeClues({ cover_year: nextYear + 1 }).coverYear).toBeUndefined();
  });
});

describe('normalizePrice', () => {
  test.each([
    ['$4.99', 4.99],
    ['60¢', 0.6],
    ['$1.00 US / $1.25 CAN', 1],
    ['$3', 3],
    ['free', undefined],
  ])('%p becomes %p dollars', (printed, dollars) => {
    expect(normalizePrice(printed)).toBe(dollars);
  });

  test('is carried onto the clues', () => {
    expect(normalizeClues({ price: '$1.25' }).price).toBe(1.25);
    expect(normalizeClues({}).price).toBeUndefined();
  });
});

describe('normalizeClues printing ordinal', () => {
  test.each([
    ['10th printing', 10],
    ['second printing', 2],
    ['3rd print', 3],
  ])('%p has ordinal %p', (printing, ordinal) => {
    expect(normalizeClues({ printing }).printingOrdinal).toBe(ordinal);
  });

  test.each([['first printing'], ['facsimile edition'], ['reprint']])('%p has no ordinal', (printing) => {
    expect(normalizeClues({ printing }).printingOrdinal).toBeUndefined();
  });
});

describe('normalizeClues edition and variant marking', () => {
  test('passes the edition through and trims the variant marking', () => {
    expect(normalizeClues({ edition: 'direct', variant_marking: ' Cover B ' })).toMatchObject({
      edition: 'direct',
      variantMarking: 'Cover B',
    });
  });

  test('drops a blank variant marking', () => {
    expect(normalizeClues({ variant_marking: '  ' }).variantMarking).toBeUndefined();
  });
});
