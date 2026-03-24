/**
 * MCP Documentation Client — connects to the MCP docs sidecar.
 * The backend controls all tool calls; the LLM never talks to the sidecar directly.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../utils/logger.js';
import { getMcpDocsSettings } from './mcp-docs-settings.js';

let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;
let connectedUrl: string | null = null;

async function ensureConnected(): Promise<Client> {
  const settings = await getMcpDocsSettings();

  if (!settings.enabled) {
    throw new Error('MCP Docs is not enabled');
  }

  // Reconnect if URL changed
  if (client && connectedUrl !== settings.url) {
    await disconnect();
  }

  if (client) return client;

  try {
    transport = new StreamableHTTPClientTransport(new URL(settings.url));
    client = new Client({ name: 'atlasmind-backend', version: '1.0.0' });
    await client.connect(transport);
    connectedUrl = settings.url;
    logger.info({ url: settings.url }, 'MCP Docs client connected');
    return client;
  } catch (err) {
    client = null;
    transport = null;
    connectedUrl = null;
    throw err;
  }
}

async function disconnect(): Promise<void> {
  try {
    if (transport) {
      await transport.close();
    }
  } catch { /* ignore */ }
  client = null;
  transport = null;
  connectedUrl = null;
}

export interface McpDocResult {
  markdown: string;
  title: string;
  url: string;
  cached: boolean;
  contentLength: number;
  truncated: boolean;
}

export interface McpSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Fetch documentation from a URL via the MCP sidecar.
 * Only sends the URL — no article content (data leakage prevention layer 3).
 */
export async function fetchDocumentation(
  url: string,
  userId: string,
  maxLength?: number,
): Promise<McpDocResult> {
  const mcp = await ensureConnected();

  const result = await mcp.callTool({
    name: 'fetch_url',
    arguments: {
      url,
      max_length: maxLength ?? 10_000,
      user_id: userId,
    },
  });

  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

  if (result.isError) {
    throw new Error(text);
  }

  // Parse metadata from the response text
  const metaEnd = text.indexOf('\n\n---\n\n');
  const meta = metaEnd > 0 ? text.slice(0, metaEnd) : '';
  const markdown = metaEnd > 0 ? text.slice(metaEnd + 7) : text;

  const titleMatch = meta.match(/Title: (.+)/);
  const lengthMatch = meta.match(/Content length: (\d+)/);
  const cachedMatch = meta.match(/Cached: (true|false)/);
  const truncatedMatch = meta.match(/Truncated: true/);

  return {
    markdown,
    title: titleMatch?.[1] ?? url,
    url,
    cached: cachedMatch?.[1] === 'true',
    contentLength: parseInt(lengthMatch?.[1] ?? '0', 10),
    truncated: !!truncatedMatch,
  };
}

/**
 * Search the web for documentation via the MCP sidecar.
 * Only sends short keyword query — no article content.
 */
export async function searchDocumentation(
  query: string,
  userId: string,
  numResults?: number,
): Promise<McpSearchResult[]> {
  const mcp = await ensureConnected();

  const result = await mcp.callTool({
    name: 'search_web',
    arguments: {
      query,
      num_results: numResults ?? 5,
      user_id: userId,
    },
  });

  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

  if (result.isError) {
    throw new Error(text);
  }

  // Parse numbered results
  const results: McpSearchResult[] = [];
  const lines = text.split('\n');
  let current: Partial<McpSearchResult> = {};

  for (const line of lines) {
    const titleMatch = line.match(/^\d+\.\s+\*\*(.+)\*\*$/);
    if (titleMatch) {
      if (current.title) results.push(current as McpSearchResult);
      current = { title: titleMatch[1] };
      continue;
    }
    const urlLine = line.trim();
    if (urlLine.startsWith('http') && current.title && !current.url) {
      current.url = urlLine;
      continue;
    }
    if (current.url && !current.snippet) {
      current.snippet = urlLine;
    }
  }
  if (current.title) results.push(current as McpSearchResult);

  return results;
}

/**
 * Test connectivity to the MCP docs sidecar.
 */
export async function testConnection(): Promise<{ ok: boolean; tools: string[]; error?: string }> {
  try {
    const mcp = await ensureConnected();
    const toolList = await mcp.listTools();
    const tools = toolList.tools.map((t) => t.name);
    return { ok: true, tools };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, tools: [], error: message };
  }
}

/**
 * Check if MCP docs is enabled and available.
 */
export async function isEnabled(): Promise<boolean> {
  const settings = await getMcpDocsSettings();
  return settings.enabled;
}
