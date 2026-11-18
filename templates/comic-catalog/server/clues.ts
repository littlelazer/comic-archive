// ABOUTME: Normalizes the clues the agent read off a cover photo into a Clues object for lookup and verdicts.
// ABOUTME: Pure functions only; malformed or out-of-range values are dropped rather than guessed at.
export interface RawClues {
  series_title?: string;
  issue_number?: string;
  publisher?: string;
  cover_month?: number;
  cover_year?: number;
  price?: string;
  upc_main?: string;
  upc_addon?: string;
  isbn?: string;
  format?: 'single_issue' | 'trade' | 'unknown';
  printing?: string;
}

export interface Clues {
  seriesTitle?: string;
  issueNumber?: string;
  publisher?: string;
  coverMonth?: number;
  coverYear?: number;
  upcMain?: string;
  upcAddon?: string;
  isbn?: string;
  format: 'single_issue' | 'trade' | 'unknown';
  printingKind?: 'original' | 'later_printing' | 'reprint' | 'facsimile';
}

const FIRST_COVER_YEAR = 1930;
const LATER_PRINTING = /^(?:[2-9]|[1-9]\d+)(?:st|nd|rd|th) print(?:ing)?$|^(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth) print(?:ing)?$/;

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Strips a leading '#' and then leading zeros from purely numeric values; anything else is left as printed.
export function normalizeIssueNumber(printed: string): string {
  const trimmed = printed.trim();
  const unhashed = trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
  return /^\d+$/.test(unhashed) ? unhashed.replace(/^0+(?=\d)/, '') : unhashed;
}

function digitsOnly(value: string | undefined, length: number | number[]): string | undefined {
  const compact = value?.replace(/[\s-]/g, '');
  if (!compact || !/^\d+$/.test(compact)) return undefined;
  const lengths = Array.isArray(length) ? length : [length];
  return lengths.includes(compact.length) ? compact : undefined;
}

function isbn13(value: string | undefined): string | undefined {
  const compact = value?.replace(/[\s-]/g, '');
  return compact && /^97[89]\d{10}$/.test(compact) ? compact : undefined;
}

function printingKind(value: string | undefined): Clues['printingKind'] {
  const printing = text(value)?.toLowerCase();
  if (!printing) return undefined;
  if (printing.includes('facsimile')) return 'facsimile';
  if (printing.includes('reprint')) return 'reprint';
  if (LATER_PRINTING.test(printing)) return 'later_printing';
  return undefined;
}

function coverMonth(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 12 ? value : undefined;
}

function coverYear(value: number | undefined): number | undefined {
  const latest = new Date().getUTCFullYear() + 1;
  return value !== undefined && Number.isInteger(value) && value >= FIRST_COVER_YEAR && value <= latest
    ? value
    : undefined;
}

export function normalizeClues(raw: RawClues): Clues {
  const issueNumber = text(raw.issue_number);
  return {
    seriesTitle: text(raw.series_title),
    issueNumber: issueNumber && text(normalizeIssueNumber(issueNumber)),
    publisher: text(raw.publisher),
    coverMonth: coverMonth(raw.cover_month),
    coverYear: coverYear(raw.cover_year),
    upcMain: digitsOnly(raw.upc_main, 12),
    upcAddon: digitsOnly(raw.upc_addon, [2, 5]),
    isbn: isbn13(raw.isbn),
    format: raw.format ?? 'unknown',
    printingKind: printingKind(raw.printing),
  };
}
