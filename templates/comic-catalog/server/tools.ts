// ABOUTME: MCP tool definitions for the comic catalog: identify_comic, confirm_choice and get_comic.
// ABOUTME: Lookup failures are returned as result objects so the agent can decide how to report them.
import type { RawClues } from './clues';
import { confirmChoice } from './confirm';
import { identifyComic } from './identify';
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

const LEGIBLE = 'Give it only if it is legible on the photo; never guess.';
const FORMATS = ['single_issue', 'trade', 'unknown'];
const EDITIONS = ['newsstand', 'direct'];

const CLUE_PROPERTIES = {
  series_title: { type: 'string', description: `Series title as printed on the cover. ${LEGIBLE}` },
  issue_number: { type: 'string', description: `Issue number exactly as printed, for example "1" or "12A". ${LEGIBLE}` },
  publisher: { type: 'string', description: `Publisher name or logo text. ${LEGIBLE}` },
  cover_month: { type: 'integer', description: `Month (1-12) of the cover date. ${LEGIBLE}` },
  cover_year: { type: 'integer', description: `Four-digit year of the cover date. ${LEGIBLE}` },
  price: { type: 'string', description: `Cover price as printed, for example "$1.25". ${LEGIBLE}` },
  upc_main: { type: 'string', description: `The 12 digits under the main barcode. ${LEGIBLE}` },
  upc_addon: { type: 'string', description: `The small 2- or 5-digit code beside the main barcode. ${LEGIBLE}` },
  isbn: { type: 'string', description: `ISBN printed on a trade paperback or hardcover. ${LEGIBLE}` },
  format: { type: 'string', enum: FORMATS, description: `Whether the cover is a single issue or a trade collection. ${LEGIBLE}` },
  printing: { type: 'string', description: `Printing or edition marking, for example "2nd printing" or "facsimile edition". ${LEGIBLE}` },
  edition: {
    type: 'string',
    enum: EDITIONS,
    description: `newsstand (price barcode, no direct-market mark) or direct (logo or "Direct Edition" in the barcode box). ${LEGIBLE}`,
  },
  variant_marking: {
    type: 'string',
    description: `variant text as printed, e.g. "Cover B", "1:25", "Virgin", an artist credit. ${LEGIBLE}`,
  },
};

const CLUE_TYPES: Record<string, 'string' | 'integer'> = Object.fromEntries(
  Object.entries(CLUE_PROPERTIES).map(([name, { type }]) => [name, type as 'string' | 'integer']),
);

// A null clue means the agent could not read it, so it is dropped like an omitted one.
export function parseClues(args: unknown): RawClues {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('arguments must be an object');
  }
  const clues: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    const type = CLUE_TYPES[name];
    if (!type) throw new Error(`unknown property: ${name}`);
    if (value === null) continue;
    if (type === 'string' && typeof value !== 'string') throw new Error(`${name} must be a string`);
    if (type === 'integer' && !Number.isInteger(value)) throw new Error(`${name} must be an integer`);
    if (name === 'format' && !FORMATS.includes(value as string)) {
      throw new Error(`format must be one of ${FORMATS.join(', ')}`);
    }
    if (name === 'edition' && !EDITIONS.includes(value as string)) {
      throw new Error(`edition must be one of ${EDITIONS.join(', ')}`);
    }
    clues[name] = value;
  }
  return clues as RawClues;
}

export function identifyComicTool(client: MetronClient, coversDir?: string): ToolDef {
  return {
    name: 'identify_comic',
    description:
      'Identify a comic from the clues read off its cover photos and return a verdict (confirmed, probable, ambiguous, no_match or lookup_failed) with candidates, evidence, hints for which extra photo would help, and searched (false when the clues were too thin to search Metron at all). Call it once per comic, after reading every photo of that comic. When the user asks to retry, call it again with the same clues. A failed lookup returns verdict lookup_failed with reason, retryable and retryAfterSeconds.',
    inputSchema: { type: 'object', properties: CLUE_PROPERTIES, additionalProperties: false },
    handler: async (args) => identifyComic(parseClues(args), client, coversDir),
  };
}

export function confirmChoiceTool(client: MetronClient, coversDir?: string): ToolDef {
  return {
    name: 'confirm_choice',
    description:
      "Settle a comic the user chose by tapping a button or replying with a number or name. Call it only with the metron_id (and, for a cover choice, the cover_label) the user actually chose, never with a choice the user didn't make. Pass the clues already read from the photos. For a cover choice, pass the settled issue's metron_id with the tapped cover_label. Returns the same verdict shape as identify_comic.",
    inputSchema: {
      type: 'object',
      properties: {
        metron_id: { type: 'integer', description: 'Metron issue id the user chose' },
        cover_label: { type: 'string', description: 'Cover label the user chose, exactly as offered' },
        ...CLUE_PROPERTIES,
      },
      required: ['metron_id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new Error('arguments must be an object');
      }
      const { metron_id: metronId, cover_label: coverLabel, ...clues } = args as Record<string, unknown>;
      if (typeof metronId !== 'number' || !Number.isInteger(metronId) || metronId <= 0) {
        throw new Error('metron_id must be a positive integer');
      }
      if (coverLabel !== undefined && coverLabel !== null && typeof coverLabel !== 'string') {
        throw new Error('cover_label must be a string');
      }
      return confirmChoice(
        { metronId, coverLabel: coverLabel ?? undefined, clues: parseClues(clues) },
        client,
        coversDir,
      );
    },
  };
}
