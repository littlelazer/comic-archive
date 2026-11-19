// ABOUTME: Tests for downloading cover images to disk, against a local stand-in image server.
// ABOUTME: Covers writing, reuse of existing files, failed downloads and choices without an image.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCoverImages } from './cover-images';
import type { CoverChoice } from './cover';
import { createMetronClient } from './metron-client';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const servers: ReturnType<typeof Bun.serve>[] = [];
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cover-images-'));
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

function imageServer(
  handler: (path: string) => Response = () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }),
) {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      requests.push(path);
      return handler(path);
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, requests };
}

const client = createMetronClient({ baseUrl: 'http://127.0.0.1:1/api/', userAgent: 'comic-archive/0.2.0' });

function choice(label: string, imageUrl: string | null): CoverChoice {
  return { label, name: label, imageUrl, upc: '', price: null };
}

describe('fetchCoverImages', () => {
  test('writes each image and sets imagePath', async () => {
    const { base } = imageServer();
    const covers = join(dir, 'covers');
    const result = await fetchCoverImages(
      [choice('Main cover', `${base}/media/a1.jpg?v=2`), choice('Variant', `${base}/media/b2.jpg`)],
      client.getImage,
      covers,
    );
    expect(result.map((c) => c.imagePath)).toEqual([join(covers, 'a1.jpg'), join(covers, 'b2.jpg')]);
    expect(new Uint8Array(await readFile(join(covers, 'a1.jpg')))).toEqual(jpeg);
    expect(new Uint8Array(await readFile(join(covers, 'b2.jpg')))).toEqual(jpeg);
  });

  test('reuses an existing file without a request', async () => {
    const { base, requests } = imageServer();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a1.jpg'), 'cached');
    const result = await fetchCoverImages([choice('Main cover', `${base}/media/a1.jpg`)], client.getImage, dir);
    expect(result[0].imagePath).toBe(join(dir, 'a1.jpg'));
    expect(requests).toEqual([]);
    expect(await readFile(join(dir, 'a1.jpg'), 'utf8')).toBe('cached');
  });

  test('a failed download leaves that choice without imagePath and still fetches the rest', async () => {
    const { base } = imageServer((path) =>
      path === '/media/bad.jpg'
        ? new Response('', { status: 404 })
        : new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }),
    );
    const result = await fetchCoverImages(
      [
        choice('One', `${base}/media/a1.jpg`),
        choice('Two', `${base}/media/bad.jpg`),
        choice('Three', `${base}/media/c3.jpg`),
      ],
      client.getImage,
      dir,
    );
    expect(result.map((c) => c.imagePath)).toEqual([join(dir, 'a1.jpg'), undefined, join(dir, 'c3.jpg')]);
    expect(await Bun.file(join(dir, 'bad.jpg')).exists()).toBe(false);
  });

  test('a choice with no imageUrl is skipped', async () => {
    const { requests } = imageServer();
    const input = [choice('No image', null)];
    const result = await fetchCoverImages(input, client.getImage, dir);
    expect(result).toEqual(input);
    expect(result[0].imagePath).toBeUndefined();
    expect(requests).toEqual([]);
  });

  test('a choice with an empty basename is treated as a failed download', async () => {
    const { base, requests } = imageServer();
    const result = await fetchCoverImages([choice('Odd', `${base}/media/`)], client.getImage, dir);
    expect(result[0].imagePath).toBeUndefined();
    expect(requests).toEqual([]);
  });

  test('does not mutate the input choices', async () => {
    const { base } = imageServer();
    const input = [choice('Main cover', `${base}/media/a1.jpg`)];
    await fetchCoverImages(input, client.getImage, dir);
    expect(input[0].imagePath).toBeUndefined();
  });
});
