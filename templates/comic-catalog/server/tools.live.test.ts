// ABOUTME: Live get_comic test against real Metron, run through the credential gateway as ComicCatalog.
// ABOUTME: Skipped unless HTTPS_PROXY is set, which `onecli run` provides.
import { describe, expect, test } from 'bun:test';
import { METRON_BASE_URL, createMetronClient } from './metron-client';
import { getComicTool, identifyComicTool } from './tools';

describe.skipIf(!process.env.HTTPS_PROXY)('get_comic against real Metron', () => {
  const tool = getComicTool(createMetronClient({ baseUrl: METRON_BASE_URL, userAgent: 'comic-archive/0.2.0' }));

  test('live: get_comic returns The Thing #1 detail', async () => {
    const result = (await tool.handler({ metron_id: 13806 })) as { id: number; reprints: unknown[] };
    expect(result.id).toBe(13806);
    expect(Array.isArray(result.reprints)).toBe(true);
  });

  test('live: identify_comic tool returns confirmed for The Thing #1 clues', async () => {
    const client = createMetronClient({ baseUrl: METRON_BASE_URL, userAgent: 'comic-archive/0.2.0' });
    const result = (await identifyComicTool(client).handler({
      series_title: 'The Thing',
      issue_number: '1',
      cover_year: 1983,
      cover_month: 7,
      format: 'single_issue',
    })) as { verdict: string; candidates: { metronId: number }[] };
    expect(result.verdict).toBe('confirmed');
    expect(result.candidates[0].metronId).toBe(13806);
  }, 120_000);
});
