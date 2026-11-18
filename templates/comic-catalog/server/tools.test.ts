// ABOUTME: Unit tests for the get_comic tool using a stand-in Metron client.
// ABOUTME: Covers argument validation and passing failure results through without isError.
import { describe, expect, test } from 'bun:test';
import type { MetronClient } from './metron-client';
import { getComicTool, identifyComicTool, parseClues } from './tools';

const failure = { ok: false, reason: 'not_found', retryable: false } as const;
const client = {
  getIssue: async (id: number) => (id === 1 ? { ok: true, data: { id: 1, reprints: [] } } : failure),
} as unknown as MetronClient;

describe('getComicTool', () => {
  const tool = getComicTool(client);

  test('requires an integer metron_id in its input schema', () => {
    expect(tool.name).toBe('get_comic');
    expect(tool.inputSchema).toMatchObject({ required: ['metron_id'], properties: { metron_id: { type: 'integer' } } });
  });

  test('returns the issue detail data for a found issue', async () => {
    expect(await tool.handler({ metron_id: 1 })).toEqual({ id: 1, reprints: [] });
  });

  test('returns the failure object as the result for a failed lookup', async () => {
    expect(await tool.handler({ metron_id: 2 })).toEqual(failure);
  });

  test.each([{}, { metron_id: 0 }, { metron_id: -3 }, { metron_id: 1.5 }, { metron_id: '7' }, null])(
    'rejects invalid arguments %p',
    async (args) => {
      await expect(tool.handler(args)).rejects.toThrow(/metron_id/);
    },
  );
});

describe('identifyComicTool', () => {
  const tool = identifyComicTool({
    callBudget: () => ({ deadline: Date.now() + 60_000 }),
    searchIssues: async () => ({ ok: false, reason: 'rate_limited', retryable: true, retryAfterSeconds: 9 }),
    getIssue: async () => failure,
    searchSeries: async () => failure,
  } as unknown as MetronClient);

  test('schema has exactly the clue properties, all optional, none additional', () => {
    const schema = tool.inputSchema as { properties: object; required?: string[]; additionalProperties: boolean };
    expect(tool.name).toBe('identify_comic');
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['cover_month', 'cover_year', 'format', 'isbn', 'issue_number', 'price', 'printing', 'publisher', 'series_title', 'upc_addon', 'upc_main'],
    );
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    for (const prop of Object.values(schema.properties) as { description: string }[]) {
      expect(prop.description).toMatch(/legible/i);
      expect(prop.description).toMatch(/never guess/i);
    }
  });

  test('returns lookup_failed as a result, not an error', async () => {
    const result = await tool.handler({ series_title: 'The Thing', issue_number: '1' });
    expect(result).toMatchObject({ verdict: 'lookup_failed', reason: 'rate_limited', retryable: true, retryAfterSeconds: 9 });
  });

  test('rejects non-string issue_number with isError', async () => {
    await expect(tool.handler({ issue_number: 1 })).rejects.toThrow(/issue_number/);
  });

  test('rejects a non-integer cover_year', async () => {
    await expect(tool.handler({ cover_year: 1983.5 })).rejects.toThrow(/cover_year/);
  });

  test('rejects an unknown property', async () => {
    await expect(tool.handler({ colour: 'red' })).rejects.toThrow(/colour/);
  });

  test('rejects a format outside the enum', async () => {
    await expect(tool.handler({ format: 'omnibus' })).rejects.toThrow(/format/);
  });

  test('rejects arguments that are not an object', async () => {
    await expect(tool.handler(null)).rejects.toThrow(/object/);
  });

  test('treats a null clue as absent', async () => {
    expect(parseClues({ series_title: 'The Thing', cover_year: null, upc_addon: null })).toEqual({ series_title: 'The Thing' });
    const result = await tool.handler({ series_title: 'The Thing', issue_number: null });
    expect(result).toMatchObject({ verdict: 'lookup_failed', reason: 'rate_limited' });
  });
});
