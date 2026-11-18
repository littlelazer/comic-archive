// ABOUTME: Minimal stdio MCP server speaking newline-delimited JSON-RPC 2.0, with no SDK dependency.
// ABOUTME: Implements initialize, ping, tools/list and tools/call; only protocol lines go to stdout.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: unknown) => Promise<unknown>;
}

export interface StdioIo {
  input: ReadableStream<Uint8Array>;
  write: (line: string) => void;
}

const SERVER_INFO = { name: 'comic-catalog', version: '0.2.0' };
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: any;
}

const defaultIo = (): StdioIo => ({
  input: Bun.stdin.stream(),
  write: (line) => process.stdout.write(line + '\n'),
});

function toolError(message: string) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(tools: ToolDef[], params: any) {
  const tool = tools.find((t) => t.name === params?.name);
  if (!tool) return toolError(`Unknown tool: ${params?.name}`);
  try {
    const result = await tool.handler(params?.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

async function handle(tools: ToolDef[], request: JsonRpcRequest): Promise<{ result: unknown } | { error: object }> {
  switch (request.method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: request.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return {
        result: {
          tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        },
      };
    case 'tools/call':
      return { result: await callTool(tools, request.params) };
    default:
      return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${request.method}` } };
  }
}

export async function serveStdio(tools: ToolDef[], io: StdioIo = defaultIo()): Promise<void> {
  const reply = (id: JsonRpcRequest['id'], body: object) => io.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }));

  async function processLine(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      reply(null, { error: { code: PARSE_ERROR, message: 'Parse error' } });
      return;
    }
    // Batches are not supported, so anything but a single request object is invalid.
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      reply(null, { error: { code: INVALID_REQUEST, message: 'Invalid Request' } });
      return;
    }
    // A request without an id is a notification and gets no reply.
    if (request.id === undefined) return;
    reply(request.id, await handle(tools, request));
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of io.input) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) await processLine(line);
    }
  }
  if (buffer.trim()) await processLine(buffer.trim());
}
