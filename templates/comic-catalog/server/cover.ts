// ABOUTME: Settles which cover of a Metron issue was photographed, from the barcode and the printed markings.
// ABOUTME: Pure functions only; when it cannot settle, it returns the few choices to compare or a hint to ask for.
import type { Clues } from './clues';
import type { MetronIssueDetail } from './metron-client';
import type { MissingHint } from './verdict';

export const COVER_COMPARE_CAP = 6;
export const MAIN_COVER_LABEL = 'Main cover';

export interface CoverChoice {
  label: string;
  name: string;
  imageUrl: string | null;
  upc: string;
  price: number | null;
  imagePath?: string;
}

export interface CoverResult {
  status: 'only_cover' | 'variants_unknown' | 'settled' | 'compare' | 'not_determined';
  settledBy?: 'barcode' | 'markings' | 'user';
  label?: string;
  choices?: CoverChoice[];
  hint?: MissingHint;
}

const ADDON_LENGTH = 5;
const ORDINAL_WORDS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

function parsePrice(price: string | null): number | null {
  if (price === null) return null;
  const parsed = Number.parseFloat(price);
  return Number.isNaN(parsed) ? null : parsed;
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+/, '');
}

function wordsOf(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// The main cover first, then the variants in Metron's order. A repeated variant name keeps its own name but gets
// a numbered label (`Name`, `Name (2)`, ...) so every choice can be addressed on its own.
export function coverChoices(detail: MetronIssueDetail): CoverChoice[] {
  const choices: CoverChoice[] = [
    {
      label: MAIN_COVER_LABEL,
      name: MAIN_COVER_LABEL,
      imageUrl: detail.image || null,
      upc: detail.upc,
      price: parsePrice(detail.price),
    },
  ];
  const seen = new Map<string, number>([[MAIN_COVER_LABEL, 1]]);
  for (const variant of detail.variants) {
    const count = (seen.get(variant.name) ?? 0) + 1;
    seen.set(variant.name, count);
    choices.push({
      label: count === 1 ? variant.name : `${variant.name} (${count})`,
      name: variant.name,
      imageUrl: variant.image || null,
      upc: variant.upc,
      price: parsePrice(variant.price),
    });
  }
  return choices;
}

function byBarcode(clues: Clues, choices: CoverChoice[]): CoverChoice | undefined {
  if (clues.upcMain === undefined || clues.upcAddon?.length !== ADDON_LENGTH) return undefined;
  const read = stripLeadingZeros(clues.upcMain + clues.upcAddon);
  return choices.find((choice) => choice.upc !== '' && stripLeadingZeros(choice.upc) === read);
}

function ordinalWords(ordinal: number): string[] {
  const teens = ordinal % 100 >= 11 && ordinal % 100 <= 13;
  const suffix = teens ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[ordinal % 10] ?? 'th';
  const written = ORDINAL_WORDS[ordinal];
  return written ? [`${ordinal}${suffix}`, written] : [`${ordinal}${suffix}`];
}

function filterByPrinting(clues: Clues, choices: CoverChoice[]): CoverChoice[] {
  if (clues.printingOrdinal !== undefined) {
    const wanted = ordinalWords(clues.printingOrdinal);
    return choices.filter((choice) => wordsOf(choice.name).some((word) => wanted.includes(word)));
  }
  const unmarked = clues.printingKind === undefined || clues.printingKind === 'original';
  return unmarked ? choices.filter((choice) => !/print/i.test(choice.name)) : choices;
}

function filterByPrice(clues: Clues, choices: CoverChoice[]): CoverChoice[] {
  if (clues.price === undefined) return choices;
  const wanted = toCents(clues.price);
  return choices.filter((choice) => choice.price !== null && toCents(choice.price) === wanted);
}

function filterByVariantMarking(clues: Clues, choices: CoverChoice[]): CoverChoice[] {
  if (clues.variantMarking === undefined) return choices;
  const wanted = wordsOf(clues.variantMarking);
  return choices.filter((choice) => {
    const words = wordsOf(choice.name);
    return wanted.every((word) => words.includes(word));
  });
}

function filterByEdition(clues: Clues, choices: CoverChoice[]): CoverChoice[] {
  if (clues.edition === 'newsstand') return choices.filter((choice) => /newsstand/i.test(choice.name));
  if (clues.edition === 'direct') return choices.filter((choice) => !/newsstand/i.test(choice.name));
  return choices;
}

function hintFor(clues: Clues, choices: CoverChoice[]): MissingHint | undefined {
  if (clues.upcMain !== undefined) return clues.upcAddon?.length === ADDON_LENGTH ? undefined : 'barcode_addon';
  return choices.some((choice) => choice.upc !== '') ? 'barcode_closeup' : undefined;
}

// Cover rules, in order:
// - No variants: only_cover, labelled as the main cover.
// - Barcode: with a 5-digit add-on read, upcMain + upcAddon equal to a choice's upc (leading zeros ignored on both
//   sides, since Metron drops them) settles that choice, settledBy 'barcode'. A 5-digit add-on that matches
//   nothing is not an error; narrowing goes on.
// - Narrowing by markings, in this order: printing, price, variant marking, edition. A filter applies only if at
//   least one choice survives it, so a misread mark cannot empty the list.
//   - printing: with an ordinal N, keep names with a word equal to N's numeric form ("10th") or English word
//     ("tenth"), case-insensitive. With no printing mark (none read, or original), drop names matching /print/i.
//     A reprint or facsimile mark does not filter.
//   - price: keep choices whose price equals the cover price in whole cents; a choice with no price never matches.
//   - variant marking: keep names containing every word of the marking, case-insensitive.
//   - edition: newsstand keeps names matching /newsstand/i; direct drops them.
// - After narrowing: one choice left (and some filter removed something) is settled, settledBy 'markings'; 2 to
//   COVER_COMPARE_CAP choices is compare with those choices; more is not_determined, with barcode_addon when a main
//   barcode was read without a 5-digit add-on, barcode_closeup when no main barcode was read and a remaining choice
//   has a upc, and no hint otherwise.
export function settleCover(clues: Clues, detail: MetronIssueDetail): CoverResult {
  if (detail.variants.length === 0) return { status: 'only_cover', label: MAIN_COVER_LABEL };

  const all = coverChoices(detail);
  const barcodeMatch = byBarcode(clues, all);
  if (barcodeMatch) return { status: 'settled', settledBy: 'barcode', label: barcodeMatch.label };

  let remaining = all;
  for (const narrow of [filterByPrinting, filterByPrice, filterByVariantMarking, filterByEdition]) {
    const narrowed = narrow(clues, remaining);
    if (narrowed.length > 0) remaining = narrowed;
  }

  if (remaining.length === 1) return { status: 'settled', settledBy: 'markings', label: remaining[0]!.label };
  if (remaining.length <= COVER_COMPARE_CAP) return { status: 'compare', choices: remaining };
  const hint = hintFor(clues, remaining);
  return hint ? { status: 'not_determined', hint } : { status: 'not_determined' };
}
