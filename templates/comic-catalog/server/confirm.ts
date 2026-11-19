// ABOUTME: Settles a Metron issue and cover the user chose from the choices offered, and returns it as an identify result.
// ABOUTME: A chosen id that conflicts with the clues stays probable; a chosen cover label must be one Metron lists.
import type { RawClues } from './clues';
import { normalizeClues } from './clues';
import { coverChoices } from './cover';
import { resolveCover } from './cover-images';
import { LookupFailed, unwrap, type IdentifyResult } from './identify';
import type { MetronClient } from './metron-client';
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
  try {
    const found = await client.getIssue(input.metronId);
    if (!found.ok && found.reason === 'not_found') {
      return { verdict: 'no_match', candidates: [], missing: [], searched: true };
    }
    const detail = unwrap(found, { issue: input.metronId });
    const candidate = evaluateCandidate(clues, detail, 'series_number');
    if (candidate.conflicts.length > 0) {
      return { verdict: 'probable', candidates: [candidate], missing: [], searched: true };
    }
    if (input.coverLabel !== undefined) {
      if (!coverChoices(detail).some((choice) => choice.label === input.coverLabel)) {
        throw new Error(`cover is not in Metron's variant list: ${input.coverLabel}`);
      }
      const cover = { status: 'settled', settledBy: 'user', label: input.coverLabel } as const;
      return { verdict: 'confirmed', candidates: [candidate], missing: [], searched: true, cover, chosenBy: 'user' };
    }
    const cover = await resolveCover(clues, detail, client.getImage, coversDir);
    return { verdict: 'confirmed', candidates: [candidate], missing: [], searched: true, cover, chosenBy: 'user' };
  } catch (error) {
    if (error instanceof LookupFailed) return error.result;
    throw error;
  }
}
