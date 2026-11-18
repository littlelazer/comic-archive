// ABOUTME: MCP tool definitions for the comic catalog, starting with get_comic.
// ABOUTME: Lookup failures are returned as result objects so the agent can decide how to report them.
import type { MetronClient } from './metron-client';
import type { ToolDef } from './mcp-stdio';

export function getComicTool(client: MetronClient): ToolDef {
  return {
    name: 'get_comic',
    description:
      'Fetch full Metron detail for one comic issue by its Metron issue id: series, number, cover date, publisher, UPC, ISBN, variants and reprints. A failed lookup returns { ok: false, reason, retryable }.',
    inputSchema: {
      type: 'object',
      properties: { metron_id: { type: 'integer', description: 'Metron issue id' } },
      required: ['metron_id'],
    },
    handler: async (args) => {
      const metronId = (args as { metron_id?: unknown } | null)?.metron_id;
      if (typeof metronId !== 'number' || !Number.isInteger(metronId) || metronId <= 0) {
        throw new Error('metron_id must be a positive integer');
      }
      const result = await client.getIssue(metronId);
      return result.ok ? result.data : result;
    },
  };
}
