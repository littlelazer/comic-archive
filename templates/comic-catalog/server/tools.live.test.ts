// ABOUTME: Live get_comic test against real Metron, run through the credential gateway as ComicCatalog.
// ABOUTME: Skipped unless HTTPS_PROXY is set, which `onecli run` provides.
import { describe, expect, test } from 'bun:test';
import { METRON_BASE_URL, createMetronClient } from './metron-client';
import { getComicTool } from './tools';

describe.skipIf(!process.env.HTTPS_PROXY)('get_comic against real Metron', () => {
  const tool = getComicTool(createMetronClient({ baseUrl: METRON_BASE_URL, userAgent: 'comic-archive/0.2.0' }));

  test('live: get_comic returns The Thing #1 detail', async () => {
    const result = (await tool.handler({ metron_id: 13806 })) as { id: number; reprints: unknown[] };
    expect(result.id).toBe(13806);
    expect(Array.isArray(result.reprints)).toBe(true);
  });
});
