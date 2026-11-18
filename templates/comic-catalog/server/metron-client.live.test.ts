// ABOUTME: Live Metron client tests, run through the credential gateway as the ComicCatalog agent.
// ABOUTME: Skipped unless HTTPS_PROXY is set, which `onecli run` provides.
import { describe, expect, test } from 'bun:test';
import { METRON_BASE_URL, createMetronClient } from './metron-client';

describe.skipIf(!process.env.HTTPS_PROXY)('metron client against real Metron', () => {
  const client = createMetronClient({ baseUrl: METRON_BASE_URL, userAgent: 'comic-archive/0.2.0' });

  test('live: finds The Thing 1983 #1 by series and number', async () => {
    const result = await client.searchIssues({ series_name: 'thing', number: '1', cover_year: '1983' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.count).toBe(1);
    expect(result.data.results[0].id).toBe(13806);
  });

  test('live: issue detail has upc, isbn, variants and reprints fields', async () => {
    const result = await client.getIssue(13806);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of ['upc', 'isbn', 'variants', 'reprints']) expect(result.data).toHaveProperty(key);
  });
});
