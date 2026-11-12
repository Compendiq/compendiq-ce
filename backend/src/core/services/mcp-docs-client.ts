/**
 * MCP Documentation Client — connects to the MCP docs sidecar.
 * The backend controls all tool calls; the LLM never talks to the sidecar directly.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../utils/logger.js';
import { APP_VERSION } from '../utils/version.js';
import { getMcpDocsSettings } from './mcp-docs-settings.js';

let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;
let connectedUrl: string | null = null;
/** In-flight connect shared by concurrent callers so only one transport is ever built per reset. */
let connecting: Promise<Client> | null = null;

/**
 * HTTP statuses that mean the sidecar no longer knows our session.
 * 404 is the MCP spec / SDK answer (`-32001 Session not found`, after the sidecar
 * evicted an idle session or restarted); 400 is what sidecars built before #1766
 * answered (`-32000 Invalid or missing session`). Either way the request never
 * reached a tool, so re-sending it cannot double outbound traffic.
 */
const SESSION_LOST_STATUSES: ReadonlySet<number> = new Set([404, 400]);

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
  if (connecting) return connecting;

  connecting = connect(settings.url).finally(() => {
    connecting = null;
  });
  return connecting;
}

/** Build a transport + client and run `initialize`; publish them only once connected. */
async function connect(url: string): Promise<Client> {
  // Send the shared secret (if configured) so the sidecar's /mcp guard accepts us.
  const token = process.env.MCP_DOCS_TOKEN;
  const nextTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { 'x-mcp-docs-token': token } } : undefined,
  });
  const nextClient = new Client({ name: 'compendiq-backend', version: APP_VERSION });
  // On failure the SDK closes the transport itself; nothing was published.
  await nextClient.connect(nextTransport);
  client = nextClient;
  transport = nextTransport;
  connectedUrl = url;
  logger.info({ url }, 'MCP Docs client connected');
  return nextClient;
}

async function disconnect(): Promise<void> {
  const closing = transport;
  client = null;
  transport = null;
  connectedUrl = null;
  try {
    await closing?.close();
  } catch { /* ignore */ }
}

/** Drop the cached connection, but only if `failed` is still the cached client — a concurrent caller may already have replaced it. */
async function resetConnection(failed: Client): Promise<void> {
  if (client !== failed) return;
  await disconnect();
}

function isSessionLost(err: unknown): err is StreamableHTTPError {
  return err instanceof StreamableHTTPError && err.code !== undefined && SESSION_LOST_STATUSES.has(err.code);
}

/**
 * Run one request on the sidecar session. When the sidecar reports the session
 * gone (see SESSION_LOST_STATUSES) drop the cached connection and retry exactly
 * once on a fresh `initialize`, re-sending the same arguments. Tool-level
 * `isError` results are ordinary results (`callTool` resolves), so they never
 * reach this path and are never retried.
 */
async function withSession<T>(op: (mcp: Client) => Promise<T>): Promise<T> {
  const first = await ensureConnected();
  try {
    return await op(first);
  } catch (err) {
    if (!isSessionLost(err)) throw err;
    logger.warn({ status: err.code }, 'MCP Docs session lost; reconnecting once');
    await resetConnection(first);
    const second = await ensureConnected();
    try {
      return await op(second);
    } catch (retryErr) {
      if (isSessionLost(retryErr)) await resetConnection(second);
      throw retryErr;
    }
  }
}

interface McpDocResult {
  markdown: string;
  title: string;
  url: string;
  cached: boolean;
  contentLength: number;
  truncated: boolean;
}

interface McpSearchResult {
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
  const result = await withSession((mcp) => mcp.callTool({
    name: 'fetch_url',
    arguments: {
      url,
      max_length: maxLength ?? 10_000,
      user_id: userId,
    },
  }));

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
  const result = await withSession((mcp) => mcp.callTool({
    name: 'search_web',
    arguments: {
      query,
      num_results: numResults ?? 5,
      user_id: userId,
    },
  }));

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
    const toolList = await withSession((mcp) => mcp.listTools());
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
