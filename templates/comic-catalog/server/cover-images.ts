// ABOUTME: Downloads the images of cover choices into a directory so the agent can compare them by eye.
// ABOUTME: Files are named by the image URL's basename and reused when already present.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoverChoice } from './cover';
import type { MetronClient } from './metron-client';

function basenameOf(imageUrl: string): string {
  try {
    return new URL(imageUrl).pathname.split('/').pop() ?? '';
  } catch {
    return '';
  }
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
