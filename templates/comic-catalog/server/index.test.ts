// ABOUTME: Spawns the real stdio server process and exercises it over JSON-RPC.
// ABOUTME: Confirms the entry point speaks MCP on stdout and advertises get_comic.
import { expect, test } from 'bun:test';
import path from 'path';

const SERVER = path.join(import.meta.dir, 'index.ts');

test('spawned server lists get_comic', async () => {
  const proc = Bun.spawn([process.execPath, SERVER], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) + '\n',
  );
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await proc.stdin.end();

  const output = await new Response(proc.stdout).text();
  await proc.exited;
  const replies = output.trim().split('\n').map((line) => JSON.parse(line));

  expect(replies).toHaveLength(2);
  const getComic = replies[1].result.tools.find((t: { name: string }) => t.name === 'get_comic');
  expect(getComic).toBeDefined();
  expect(getComic.inputSchema.required).toEqual(['metron_id']);
  expect(getComic.inputSchema.properties.metron_id.type).toBe('integer');
});
