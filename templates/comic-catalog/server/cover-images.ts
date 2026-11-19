// ABOUTME: Settles an issue's cover and downloads the images of cover choices so the agent can compare them by eye.
// ABOUTME: Files are named by the image URL's basename and reused when already present.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clues } from './clues';
import { settleCover, type CoverChoice, type CoverResult } from './cover';
import type { MetronClient, MetronIssueDetail } from './metron-client';

function basenameOf(imageUrl: string): string {
  try {
    return new URL(imageUrl).pathname.split('/').pop() ?? '';
  } catch {
    return '';
  }
}

// The cover of an issue for the clues read; with no detail the variants are unknown. A compare result gets its
// images downloaded when a directory is given.
export async function resolveCover(
  clues: Clues,
  detail: MetronIssueDetail | undefined,
  getImage: MetronClient['getImage'],
  coversDir?: string,
): Promise<CoverResult> {
  if (!detail) return { status: 'variants_unknown' };
  const cover = settleCover(clues, detail);
  if (cover.status !== 'compare' || !cover.choices || !coversDir) return cover;
  return { ...cover, choices: await fetchCoverImages(cover.choices, getImage, coversDir) };
}

// Downloads one after another; a failed download leaves that choice without imagePath and never throws.
export async function fetchCoverImages(
  choices: CoverChoice[],
  getImage: MetronClient['getImage'],
  dir: string,
): Promise<CoverChoice[]> {
  const result: CoverChoice[] = [];
  for (const choice of choices) {
    result.push(await withImagePath(choice, getImage, dir));
  }
  return result;
}

async function withImagePath(
  choice: CoverChoice,
  getImage: MetronClient['getImage'],
  dir: string,
): Promise<CoverChoice> {
  if (!choice.imageUrl) return choice;
  const basename = basenameOf(choice.imageUrl);
  if (!basename) return choice;
  const path = join(dir, basename);
  try {
    if (await Bun.file(path).exists()) return { ...choice, imagePath: path };
    const image = await getImage(choice.imageUrl);
    if (!image.ok) return choice;
    await mkdir(dir, { recursive: true });
    await writeFile(path, image.data);
    return { ...choice, imagePath: path };
  } catch {
    return choice;
  }
}
