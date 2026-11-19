// ABOUTME: Settles a Metron issue and cover the user chose from the choices offered, and returns it as an identify result.
// ABOUTME: A chosen id that conflicts with the clues stays probable; a chosen cover label must be one Metron lists.
import { normalizeClues, type Clues, type RawClues } from './clues';
import { coverChoices, type CoverResult } from './cover';
import { resolveCover } from './cover-images';
import { editionEcho, LookupFailed, unwrap, type IdentifyResult } from './identify';
import type { MetronClient, MetronIssueDetail } from './metron-client';
import { evaluateCandidate } from './verdict';

export interface ConfirmChoiceInput {
  metronId: number;
  coverLabel?: string;
  clues: RawClues;
}

export async function confirmChoice(
  input: ConfirmChoiceInput,
  client: MetronClient,
  coversDir?: string,
): Promise<IdentifyResult> {
  const clues = normalizeClues(input.clues);
  const edition = editionEcho(input.clues, clues);
  const echoed = edition ? { edition } : {};
  try {
    const found = await client.getIssue(input.metronId);
    if (!found.ok && found.reason === 'not_found') {
      return { verdict: 'no_match', candidates: [], missing: [], searched: true };
    }
    const detail = unwrap(found, { issue: input.metronId });
    const candidate = evaluateCandidate(clues, detail, 'series_number');
    if (candidate.conflicts.length > 0) {
      return { verdict: 'probable', candidates: [candidate], missing: [], searched: true, ...echoed };
    }
    const cover = await coverFor(input.coverLabel, clues, detail, client, coversDir);
    return {
      verdict: 'confirmed',
      candidates: [candidate],
      missing: [],
      searched: true,
      cover,
      chosenBy: 'user',
      ...echoed,
    };
  } catch (error) {
    if (error instanceof LookupFailed) return error.result;
    throw error;
  }
}

async function coverFor(
  coverLabel: string | undefined,
  clues: Clues,
  detail: MetronIssueDetail,
  client: MetronClient,
  coversDir?: string,
): Promise<CoverResult> {
  if (coverLabel === undefined) return resolveCover(clues, detail, client.getImage, coversDir);
  if (!coverChoices(detail).some((choice) => choice.label === coverLabel)) {
    throw new Error(`cover is not in Metron's variant list: ${coverLabel}`);
  }
  return { status: 'settled', settledBy: 'user', label: coverLabel };
}
