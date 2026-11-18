// ABOUTME: Unit tests for the get_comic tool using a stand-in Metron client.
// ABOUTME: Covers argument validation and passing failure results through without isError.
import { describe, expect, test } from 'bun:test';
import type { MetronClient } from './metron-client';
import { getComicTool } from './tools';

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
