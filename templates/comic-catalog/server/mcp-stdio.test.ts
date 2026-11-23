// ABOUTME: Tests the stdio MCP protocol layer by feeding JSON-RPC lines through the io parameter.
// ABOUTME: Covers initialize, tools/list, tools/call, ping, unknown methods and notifications.
import { describe, expect, test } from 'bun:test';
import { serveStdio, type ToolDef } from './mcp-stdio';

const echoTool: ToolDef = {
  name: 'echo',
  description: 'Echoes its arguments.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  handler: async (args) => ({ echoed: args }),
};

const failingTool: ToolDef = {
  name: 'boom',
  description: 'Always throws.',
  inputSchema: { type: 'object' },
  handler: async () => {
    throw new Error('kaput');
  },
};

async function run(requests: object[], tools: ToolDef[] = [echoTool, failingTool]): Promise<any[]> {
  const encoder = new TextEncoder();
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const request of requests) controller.enqueue(encoder.encode(JSON.stringify(request) + '\n'));
      controller.close();
    },
  });
  const lines: string[] = [];
  await serveStdio(tools, { input, write: (line) => lines.push(line) });
  return lines.map((line) => JSON.parse(line));
}

describe('serveStdio', () => {
  test('answers initialize with the client\'s protocolVersion, tools capability and serverInfo name "comic-catalog"', async () => {
    const [reply] = await run([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } },
    ]);
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe('2025-03-26');
    expect(reply.result.capabilities).toEqual({ tools: {} });
    expect(reply.result.serverInfo).toEqual({ name: 'comic-catalog', version: '0.3.1' });
  });

  test('lists tools with name, description and inputSchema', async () => {
    const [reply] = await run([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    expect(reply.result.tools[0]).toEqual({
      name: 'echo',
      description: 'Echoes its arguments.',
      inputSchema: echoTool.inputSchema,
    });
    expect(reply.result.tools).toHaveLength(2);
  });

  test('calls a tool and wraps its result as text content', async () => {
    const [reply] = await run([
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hi' } } },
    ]);
    expect(reply.result.isError).toBeUndefined();
    expect(reply.result.content).toEqual([{ type: 'text', text: JSON.stringify({ echoed: { value: 'hi' } }) }]);
  });

  test('returns isError when a handler throws', async () => {
    const [reply] = await run([{ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } }]);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('kaput');
  });

  test('returns isError for an unknown tool name', async () => {
    const [reply] = await run([{ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } }]);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('nope');
  });

  test('returns JSON-RPC error -32601 for an unknown method', async () => {
    const [reply] = await run([{ jsonrpc: '2.0', id: 6, method: 'resources/list' }]);
    expect(reply.error.code).toBe(-32601);
    expect(reply.id).toBe(6);
  });

  test('ignores notifications (no id) without replying', async () => {
    const replies = await run([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'something/unknown' },
    ]);
    expect(replies).toEqual([]);
  });

  test('answers ping with an empty result', async () => {
    const [reply] = await run([{ jsonrpc: '2.0', id: 7, method: 'ping' }]);
    expect(reply).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });

  test('answers a malformed line with a parse error and keeps serving', async () => {
    const encoder = new TextEncoder();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('not json\n' + JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }) + '\n'));
        controller.close();
      },
    });
    const lines: string[] = [];
    await serveStdio([], { input, write: (line) => lines.push(line) });
    const replies = lines.map((line) => JSON.parse(line));
    expect(replies[0].error.code).toBe(-32700);
    expect(replies[1].result).toEqual({});
  });

  test('answers a line that is not a JSON object with -32600 Invalid Request and keeps serving', async () => {
    const encoder = new TextEncoder();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('null\n42\n' + JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n'));
        controller.close();
      },
    });
    const lines: string[] = [];
    await serveStdio([], { input, write: (line) => lines.push(line) });
    const replies = lines.map((line) => JSON.parse(line));
    expect(replies[0]).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    expect(replies[1]).toEqual(replies[0]);
    expect(replies[2]).toEqual({ jsonrpc: '2.0', id: 9, result: {} });
  });
});
