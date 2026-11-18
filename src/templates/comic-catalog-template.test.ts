// ABOUTME: Verifies the repo-tracked ComicCatalog agent template parses and stamps cleanly.
// ABOUTME: Pins the standing rules the comic-archive workflow depends on (image Read, no guessing, no writes).
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { resolveLocalTemplate } from './local-dir.js';
import { parseTemplate } from './parse.js';

const TEMPLATES_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates');

describe('comic-catalog template', () => {
  const tpl = parseTemplate(resolveLocalTemplate('comic-catalog', TEMPLATES_BASE));

  it('parses as a conformant plugin with the ComicCatalog display name', () => {
    expect(tpl.name).toBe('comic-catalog');
    expect(tpl.agentName).toBe('ComicCatalog');
  });

  it('parses with no skipped or ignored components', () => {
    expect(tpl.report).toEqual([]);
  });

  it('declares the comic-catalog stdio server run by bun', () => {
    expect(tpl.mcpServers['comic-catalog']).toMatchObject({
      command: 'bun',
      args: ['${PLUGIN_ROOT}/server/index.ts'],
    });
  });

  it('tells the agent to Read image attachments before replying', () => {
    expect(tpl.instructions).toMatch(/`Read`/);
    expect(tpl.instructions).toMatch(/\/workspace\/inbox\//);
  });

  it('forbids fabricating cover metadata', () => {
    expect(tpl.instructions).toMatch(/never guess/i);
  });

  it('forbids record writes in this phase', () => {
    expect(tpl.instructions).toMatch(/do not create, update, or delete/i);
  });

  it('tells the agent to call identify_comic after reading the cover', () => {
    expect(tpl.instructions).toMatch(/identify_comic/);
  });

  it('tells the agent to ask for one specific photo from missing hints', () => {
    expect(tpl.instructions).toMatch(/barcode/i);
    expect(tpl.instructions).toMatch(/indicia/i);
    expect(tpl.instructions).toMatch(/ISBN/);
  });

  it('offers an in-thread retry only for retryable failures', () => {
    expect(tpl.instructions).toMatch(/retry/i);
    expect(tpl.instructions).toMatch(/retryable/);
  });

  it('uses the first missing hint and asks for no photo when missing is empty', () => {
    expect(tpl.instructions).toMatch(/first hint in `missing`/);
    expect(tpl.instructions).toMatch(/If `missing` is empty/);
  });

  it('reports every lookup_failed without naming a match and offers no retry for non-retryable ones', () => {
    expect(tpl.instructions).toMatch(/any `lookup_failed`, say what you read/);
    expect(tpl.instructions).toMatch(/never name a match/i);
    expect(tpl.instructions).toMatch(/`retryable` is false and the reason is not `auth`/);
  });
});
