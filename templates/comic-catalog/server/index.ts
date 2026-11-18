// ABOUTME: Entry point for the comic-catalog stdio MCP server launched by the agent container.
// ABOUTME: Builds the Metron client and serves its tools over stdin/stdout.
import { METRON_BASE_URL, createMetronClient } from './metron-client';
import { serveStdio } from './mcp-stdio';
import { getComicTool, identifyComicTool } from './tools';

const client = createMetronClient({ baseUrl: METRON_BASE_URL, userAgent: 'comic-archive/0.2.0' });

await serveStdio([identifyComicTool(client), getComicTool(client)]);
