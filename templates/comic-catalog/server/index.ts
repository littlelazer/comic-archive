// ABOUTME: Entry point for the comic-catalog stdio MCP server launched by the agent container.
// ABOUTME: Builds the Metron client and serves its tools over stdin/stdout.
import { join } from 'node:path';
import { METRON_BASE_URL, createMetronClient } from './metron-client';
import { serveStdio } from './mcp-stdio';
import { confirmChoiceTool, getComicTool, identifyComicTool } from './tools';

const client = createMetronClient({ baseUrl: METRON_BASE_URL, userAgent: 'comic-archive/0.3.3' });

const coversDir = process.env.PLUGIN_DATA ? join(process.env.PLUGIN_DATA, 'covers') : undefined;

await serveStdio([identifyComicTool(client, coversDir), confirmChoiceTool(client, coversDir), getComicTool(client)]);
