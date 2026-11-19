// ABOUTME: Tests confirmChoice, which settles a user-chosen Metron issue and cover, against a local stand-in Metron.
// ABOUTME: Stand-in pages only steer the logic; they are not evidence of what real Metron returns.
import { afterEach, describe, expect, test } from 'bun:test';
import { confirmChoice } from './confirm';
import { MAIN_COVER_LABEL } from './cover';
import { createMetronClient } from './metron-client';

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

const variant = (name: string, upc = '') => ({ name, price: null, sku: '', upc, image: null });

function detailOf(variants: ReturnType<typeof variant>[], number = '1') {
  return {
    id: 7,
    series: { id: 70, name: 'The Thing', volume: 1, year_began: 1983 },
    number,
    cover_date: '1983-07-01',
    image: null,
    upc: '',
    isbn: '',
    price: null,
    variants,
    reprints: [],
  };
}

function metronAnswering(answer: () => Response) {
  const server = Bun.serve({ port: 0, fetch: answer });
  servers.push(server);
  return createMetronClient({ baseUrl: `http://127.0.0.1:${server.port}/api/`, userAgent: 'comic-archive/0.2.0' });
}

const detailClient = (variants: ReturnType<typeof variant>[], number = '1') =>
  metronAnswering(() => new Response(JSON.stringify(detailOf(variants, number))));

const CLUES = { series_title: 'The Thing', issue_number: '1', cover_year: 1983 };

describe('confirmChoice', () => {
  test('a chosen id with no conflicts is confirmed by the user', async () => {
    const result = await confirmChoice({ metronId: 7, clues: CLUES }, detailClient([]));
    expect(result).toMatchObject({
      verdict: 'confirmed',
      chosenBy: 'user',
      searched: true,
      missing: [],
      cover: { status: 'only_cover' },
    });
    expect(result.candidates.map((c) => c.metronId)).toEqual([7]);
  });

  test('a chosen id whose issue number conflicts is probable with the conflict', async () => {
    const result = await confirmChoice({ metronId: 7, clues: CLUES }, detailClient([], '9'));
    expect(result).toMatchObject({ verdict: 'probable', searched: true, missing: [] });
    expect(result).not.toHaveProperty('cover');
    expect(result).not.toHaveProperty('chosenBy');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].conflicts.length).toBeGreaterThan(0);
  });

  test('a chosen cover label settles the cover by the user', async () => {
    const result = await confirmChoice(
      { metronId: 7, coverLabel: 'Newsstand', clues: CLUES },
      detailClient([variant('Newsstand'), variant('Direct')]),
    );
    expect(result).toMatchObject({
      verdict: 'confirmed',
      cover: { status: 'settled', settledBy: 'user', label: 'Newsstand' },
    });
  });

  test("a chosen cover label not in Metron's list throws", async () => {
    await expect(
      confirmChoice({ metronId: 7, coverLabel: 'Gold', clues: CLUES }, detailClient([variant('Newsstand')])),
    ).rejects.toThrow("cover is not in Metron's variant list: Gold");
  });

  test('the main cover is accepted by its label', async () => {
    const result = await confirmChoice(
      { metronId: 7, coverLabel: MAIN_COVER_LABEL, clues: CLUES },
      detailClient([variant('Newsstand')]),
    );
    expect(result).toMatchObject({ cover: { status: 'settled', settledBy: 'user', label: MAIN_COVER_LABEL } });
  });

  test('the second of two same-named variants is accepted by its label', async () => {
    const result = await confirmChoice(
      { metronId: 7, coverLabel: 'Foil (2)', clues: CLUES },
      detailClient([variant('Foil'), variant('Foil')]),
    );
    expect(result).toMatchObject({ cover: { status: 'settled', settledBy: 'user', label: 'Foil (2)' } });
  });

  test("a chosen id Metron doesn't have is no_match", async () => {
    const client = metronAnswering(() => new Response('', { status: 404 }));
    expect(await confirmChoice({ metronId: 7, clues: CLUES }, client)).toEqual({
      verdict: 'no_match',
      candidates: [],
      missing: [],
      searched: true,
    });
  });

  test('a failed lookup is a lookup_failed result', async () => {
    const client = metronAnswering(() => new Response('', { status: 401 }));
    expect(await confirmChoice({ metronId: 7, clues: CLUES }, client)).toMatchObject({
      verdict: 'lookup_failed',
      reason: 'auth',
      retryable: false,
    });
  });

  test('echoes the edition read from the clues on a confirmed result', async () => {
    const result = await confirmChoice(
      { metronId: 7, coverLabel: 'Newsstand', clues: { ...CLUES, edition: 'newsstand' } },
      detailClient([variant('Newsstand'), variant('Direct')]),
    );
    expect(result).toMatchObject({ verdict: 'confirmed', edition: { edition: 'newsstand' } });
  });

  test('echoes the edition on a probable result and omits it when nothing was read', async () => {
    const probable = await confirmChoice(
      { metronId: 7, clues: { ...CLUES, edition: 'direct' } },
      detailClient([], '9'),
    );
    expect(probable).toMatchObject({ verdict: 'probable', edition: { edition: 'direct' } });
    expect(await confirmChoice({ metronId: 7, clues: CLUES }, detailClient([]))).not.toHaveProperty('edition');
  });
});
