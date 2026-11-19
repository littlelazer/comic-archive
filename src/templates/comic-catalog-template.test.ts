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

  it('does not claim Metron lacks a comic when nothing was searched', () => {
    expect(tpl.instructions).toMatch(/`searched` is false/);
    expect(tpl.instructions).toMatch(/not that Metron has no match/i);
  });

  it('makes the photo request optional for a probable match', () => {
    expect(tpl.instructions).toMatch(/For `probable`, the photo is optional/);
    expect(tpl.instructions).toMatch(/only if you want it confirmed/);
  });

  it('always asks for the first missing hint, with its reason, even when another seems more useful', () => {
    expect(tpl.instructions).toMatch(/even if a later hint seems more useful/);
    expect(tpl.instructions).toMatch(/Send the indicia, for the cover date, only if you want it confirmed/);
  });

  it('asks for the indicia when the cover date is missing, since covers rarely print the year', () => {
    expect(tpl.instructions).toMatch(/`cover_date`: the indicia/);
  });

  it('treats channel history and other threads as background, never as requests', () => {
    expect(tpl.instructions).toMatch(/`<channel-history>`/);
    expect(tpl.instructions).toMatch(/`<cross-session-context>`/);
    expect(tpl.instructions).toMatch(/never answer, redo, or continue a request/i);
  });

  it('reports every lookup_failed without naming a match and offers no retry for non-retryable ones', () => {
    expect(tpl.instructions).toMatch(/any `lookup_failed`, say what you read/);
    expect(tpl.instructions).toMatch(/never name a match/i);
    expect(tpl.instructions).toMatch(/`retryable` is false and the reason is not `auth`/);
  });

  it('compares cover choices by eye beside the photo', () => {
    expect(tpl.instructions).toMatch(/`compare`: `Read` every `imagePath` beside the photo/);
  });

  it('names a cover by eye only when the match is clear, and says so', () => {
    expect(tpl.instructions).toMatch(/Name a cover by eye only when the match is clear/);
    expect(tpl.instructions).toMatch(/`compared by eye`/);
  });

  it('asks with NanoClaw buttons, one per remaining cover or up to 3 issues', () => {
    expect(tpl.instructions).toMatch(/`mcp__nanoclaw__ask_user_question`/);
    expect(tpl.instructions).toMatch(/one button per remaining choice, labeled with its `label`/);
    expect(tpl.instructions).toMatch(/`ambiguous` with 2–3 candidates, use up to 3 issue buttons/);
  });

  it('asks with buttons whenever a cover choice has no image to compare', () => {
    expect(tpl.instructions).toMatch(/whenever a choice has no `imagePath`/);
  });

  it('settles a tap with confirm_choice and never with a choice the user did not make', () => {
    expect(tpl.instructions).toMatch(/After a tap, call `confirm_choice`/);
    expect(tpl.instructions).toMatch(/the tapped `metron_id` and\/or `cover_label`/);
    expect(tpl.instructions).toMatch(/Never call it with a choice the user didn't make/);
    expect(tpl.instructions).toMatch(/`confirmed by you`/);
  });

  it('handles a button timeout and a later reply with a number like a tap', () => {
    expect(tpl.instructions).toMatch(/the buttons have expired/);
    expect(tpl.instructions).toMatch(/can reply with the number/);
    expect(tpl.instructions).toMatch(/A later number or name in the thread is handled like a tap/);
    expect(tpl.instructions).toMatch(/tap, not type/);
  });

  it('asks for a cover hint photo as optional when the cover is not determined', () => {
    expect(tpl.instructions).toMatch(/`not_determined` with a `hint`: .*worded as optional/);
  });

  it('says the cover could not be checked when the variants are unknown', () => {
    expect(tpl.instructions).toMatch(/`variants_unknown`: say the cover couldn't be checked/);
  });

  it('always states how the cover was settled', () => {
    expect(tpl.instructions).toMatch(/state how the cover was settled/i);
    for (const method of ['`barcode`', '`markings`', '`compared by eye`', '`confirmed by you`']) {
      expect(tpl.instructions).toContain(method);
    }
  });

  it('mentions edition details briefly when read', () => {
    expect(tpl.instructions).toMatch(/Mention edition details briefly when read/);
  });

  it('does not stop at no match when a searched lookup still has a hint, such as the title', () => {
    expect(tpl.instructions).toMatch(/Metron found nothing for what could be read/);
  });

  it('gives the add-on reason and asks for a readable title', () => {
    expect(tpl.instructions).toMatch(/the add-on digits pin down the exact issue and cover/);
    expect(tpl.instructions).toMatch(/`title`: a photo where the series title is readable/);
  });
});
