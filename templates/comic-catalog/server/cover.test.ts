// ABOUTME: Unit tests for settling which cover of an issue was photographed, from barcode and printed markings.
// ABOUTME: Details are plain objects in the Metron response shape, modelled on Absolute Batman #1 (Metron 127884).
import { describe, expect, test } from 'bun:test';
import type { Clues } from './clues';
import { COVER_COMPARE_CAP, coverChoices, MAIN_COVER_LABEL, settleCover } from './cover';
import type { MetronIssueDetail, MetronVariant } from './metron-client';

const MAIN_UPC = '76194138584600111';

function variant(overrides: Partial<MetronVariant> = {}): MetronVariant {
  return {
    name: 'Variant',
    price: '4.99',
    sku: '',
    upc: '',
    image: 'https://static.metron.cloud/media/issue/variant.jpg',
    ...overrides,
  };
}

const TENTH_PRINTINGS: MetronVariant[] = [
  variant({ name: '10Th Printing', upc: '76194138584600110', price: '4.99' }),
  variant({ name: '10Th Printing Inhyuk Lee', upc: '76194138584600187', price: '5.99' }),
  variant({ name: '10Th Printing Inhyuk Lee Foil Virgin Variant', upc: '76194138584600188', price: '7.99' }),
];

function plainVariants(count: number): MetronVariant[] {
  return Array.from({ length: count }, (_, i) => variant({ name: `Cover ${i + 1}`, upc: `7619413858460${i}0${i}` }));
}

function detail(variants: MetronVariant[], overrides: Partial<MetronIssueDetail> = {}): MetronIssueDetail {
  return {
    id: 127884,
    series: { id: 1, name: 'Absolute Batman', volume: 1, year_began: 2024 },
    number: '1',
    cover_date: '2024-12-01',
    image: 'https://static.metron.cloud/media/issue/main.jpg',
    publisher: { name: 'DC Comics' },
    upc: MAIN_UPC,
    isbn: '',
    price: '4.99',
    variants,
    reprints: [],
    ...overrides,
  };
}

function clues(overrides: Partial<Clues> = {}): Clues {
  return { format: 'single_issue', ...overrides };
}

describe('coverChoices', () => {
  test('lists the main cover first, then the variants in Metron order', () => {
    const choices = coverChoices(detail(TENTH_PRINTINGS));
    expect(choices.map((c) => c.label)).toEqual([
      MAIN_COVER_LABEL,
      '10Th Printing',
      '10Th Printing Inhyuk Lee',
      '10Th Printing Inhyuk Lee Foil Virgin Variant',
    ]);
    expect(choices[0]).toEqual({
      label: 'Main cover',
      name: 'Main cover',
      imageUrl: 'https://static.metron.cloud/media/issue/main.jpg',
      upc: MAIN_UPC,
      price: 4.99,
    });
  });

  test('duplicate variant names get unique labels', () => {
    const choices = coverChoices(detail([variant({ name: 'Foil' }), variant({ name: 'Foil' }), variant({ name: 'Foil' })]));
    expect(choices.map((c) => c.label)).toEqual(['Main cover', 'Foil', 'Foil (2)', 'Foil (3)']);
    expect(choices.map((c) => c.name)).toEqual(['Main cover', 'Foil', 'Foil', 'Foil']);
  });

  test('a variant with no image keeps imageUrl null', () => {
    const choices = coverChoices(detail([variant({ name: 'Blank', image: null }), variant({ name: 'Empty', image: '' })]));
    expect(choices[1]?.imageUrl).toBeNull();
    expect(choices[2]?.imageUrl).toBeNull();
  });

  test('an absent or unparsable price is null', () => {
    const choices = coverChoices(detail([variant({ name: 'Free', price: null }), variant({ name: 'Odd', price: 'n/a' })]));
    expect(choices.map((c) => c.price)).toEqual([4.99, null, null]);
  });
});

describe('settleCover', () => {
  test('a detail with no variants is only_cover', () => {
    expect(settleCover(clues(), detail([]))).toEqual({ status: 'only_cover', label: 'Main cover' });
  });

  test('a read add-on equal to a variant upc settles that variant by barcode', () => {
    const result = settleCover(clues({ upcMain: '761941385846', upcAddon: '00187' }), detail(TENTH_PRINTINGS));
    expect(result).toEqual({ status: 'settled', settledBy: 'barcode', label: '10Th Printing Inhyuk Lee' });
  });

  test('a read add-on equal to the main upc settles the main cover by barcode', () => {
    const result = settleCover(clues({ upcMain: '761941385846', upcAddon: '00111' }), detail(TENTH_PRINTINGS));
    expect(result).toEqual({ status: 'settled', settledBy: 'barcode', label: 'Main cover' });
  });

  test('ignores leading zeros when matching a barcode', () => {
    const solar = detail([variant({ name: 'Other', upc: '7168928706405512' })], { upc: '7168928706405511' });
    const result = settleCover(clues({ upcMain: '071689287064', upcAddon: '05511' }), solar);
    expect(result).toEqual({ status: 'settled', settledBy: 'barcode', label: 'Main cover' });
  });

  test('a 2-digit add-on is not used for the barcode rule', () => {
    const result = settleCover(clues({ upcMain: '761941385846', upcAddon: '87' }), detail(TENTH_PRINTINGS));
    expect(result.settledBy).not.toBe('barcode');
  });

  test('a 5-digit add-on that matches nothing falls through to markings', () => {
    const result = settleCover(
      clues({ upcMain: '761941385846', upcAddon: '99999', printingKind: 'later_printing', printingOrdinal: 10, price: 5.99 }),
      detail(TENTH_PRINTINGS),
    );
    expect(result).toEqual({ status: 'settled', settledBy: 'markings', label: '10Th Printing Inhyuk Lee' });
  });

  test('10th printing at $5.99 settles the Inhyuk Lee variant by markings', () => {
    const result = settleCover(
      clues({ printingKind: 'later_printing', printingOrdinal: 10, price: 5.99 }),
      detail(TENTH_PRINTINGS),
    );
    expect(result).toEqual({ status: 'settled', settledBy: 'markings', label: '10Th Printing Inhyuk Lee' });
  });

  test('a spelled-out ordinal in a variant name matches the printing ordinal', () => {
    const result = settleCover(
      clues({ printingKind: 'later_printing', printingOrdinal: 2 }),
      detail([variant({ name: 'Second Printing' }), variant({ name: 'Foil' })]),
    );
    expect(result).toEqual({ status: 'settled', settledBy: 'markings', label: 'Second Printing' });
  });

  test('no printing mark drops printing variants', () => {
    const result = settleCover(clues(), detail([...TENTH_PRINTINGS, variant({ name: 'Foil' })]));
    expect(result.status).toBe('compare');
    expect(result.choices?.map((c) => c.label)).toEqual(['Main cover', 'Foil']);
  });

  test('an original printing mark also drops printing variants', () => {
    const result = settleCover(clues({ printingKind: 'original' }), detail([...TENTH_PRINTINGS, variant({ name: 'Foil' })]));
    expect(result.choices?.map((c) => c.label)).toEqual(['Main cover', 'Foil']);
  });

  test('a reprint mark does not filter by printing', () => {
    const result = settleCover(clues({ printingKind: 'reprint' }), detail(TENTH_PRINTINGS));
    expect(result.choices).toHaveLength(4);
  });

  test('a variant marking narrows to names containing every word', () => {
    const result = settleCover(
      clues({ variantMarking: 'foil virgin', printingKind: 'later_printing', printingOrdinal: 10 }),
      detail(TENTH_PRINTINGS),
    );
    expect(result).toEqual({
      status: 'settled',
      settledBy: 'markings',
      label: '10Th Printing Inhyuk Lee Foil Virgin Variant',
    });
  });

  test('newsstand keeps newsstand names and direct drops them', () => {
    const issue = detail([variant({ name: 'Newsstand Edition' }), variant({ name: 'Foil' })]);
    expect(settleCover(clues({ edition: 'newsstand' }), issue)).toEqual({
      status: 'settled',
      settledBy: 'markings',
      label: 'Newsstand Edition',
    });
    expect(settleCover(clues({ edition: 'direct' }), issue).choices?.map((c) => c.label)).toEqual(['Main cover', 'Foil']);
  });

  test('a price filter matches in whole cents and never matches a null price', () => {
    const issue = detail([variant({ name: 'Foil', price: '5.99' }), variant({ name: 'Plain', price: null })]);
    expect(settleCover(clues({ price: 5.99 }), issue)).toEqual({ status: 'settled', settledBy: 'markings', label: 'Foil' });
  });

  test('a filter that would remove every choice is skipped', () => {
    const result = settleCover(clues({ price: 1.25, variantMarking: 'Nonexistent' }), detail(TENTH_PRINTINGS.slice(0, 1)));
    expect(result.status).toBe('settled');
    expect(result.label).toBe('Main cover');
  });

  test('a filter that keeps every choice settles nothing', () => {
    const result = settleCover(clues({ price: 4.99 }), detail([variant({ name: 'Same', price: '4.99' })]));
    expect(result.status).toBe('compare');
  });

  test('two to six choices left is compare with those choices', () => {
    const result = settleCover(clues(), detail(plainVariants(COVER_COMPARE_CAP - 1)));
    expect(result.status).toBe('compare');
    expect(result.choices).toHaveLength(COVER_COMPARE_CAP);
    expect(result.choices?.[0]?.label).toBe('Main cover');
  });

  test('more than six left with a main barcode but no add-on is not_determined with the barcode_addon hint', () => {
    const result = settleCover(clues({ upcMain: '761941385846' }), detail(plainVariants(COVER_COMPARE_CAP)));
    expect(result).toEqual({ status: 'not_determined', hint: 'barcode_addon' });
  });

  test('more than six left with a main barcode and a 2-digit add-on asks for the 5-digit add-on', () => {
    const result = settleCover(clues({ upcMain: '761941385846', upcAddon: '11' }), detail(plainVariants(COVER_COMPARE_CAP)));
    expect(result.hint).toBe('barcode_addon');
  });

  test('more than six left with no barcode is not_determined with the barcode_closeup hint', () => {
    const result = settleCover(clues(), detail(plainVariants(COVER_COMPARE_CAP)));
    expect(result).toEqual({ status: 'not_determined', hint: 'barcode_closeup' });
  });

  test('more than six left with no barcode and no upc on any choice has no hint', () => {
    const noUpcs = Array.from({ length: COVER_COMPARE_CAP }, (_, i) => variant({ name: `Cover ${i + 1}` }));
    const result = settleCover(clues(), detail(noUpcs, { upc: '' }));
    expect(result).toEqual({ status: 'not_determined' });
  });
});
