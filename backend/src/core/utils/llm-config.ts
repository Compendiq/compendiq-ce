import { readFileSync, existsSync } from 'fs';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { logger } from './logger.js';

/**
 * Shared LLM/Ollama connection configuration.
 *
 * Centralizes SSL verification, CA bundle loading, and auth header
 * generation for all Ollama connections (health checks, Ollama SDK,
 * and any future LLM providers).
 *
 * Environment variables:
 *   LLM_VERIFY_SSL     - Set to 'false' to skip TLS cert verification (default: true)
 *   LLM_BEARER_TOKEN   - Bearer token for authenticated Ollama proxies
 *   LLM_AUTH_TYPE       - Auth type: 'bearer' | 'none' (default: 'none')
 *   NODE_EXTRA_CA_CERTS - Path to a PEM CA bundle file (shared with tls-config.ts)
 *   OLLAMA_BASE_URL     - Ollama server URL (default: http://localhost:11434)
 */

// ---------------------------------------------------------------------------
// CA bundle loading (mirrors tls-config.ts logic for Confluence)
// ---------------------------------------------------------------------------

function loadCaBundle(): string | undefined {
  const caPath = process.env.NODE_EXTRA_CA_CERTS;

  // Try explicit path from env var first
  if (caPath) {
    try {
      const contents = readFileSync(caPath, 'utf-8');
      if (contents.includes('-----BEGIN CERTIFICATE-----')) {
        logger.info({ caPath, size: contents.length }, 'LLM: Loaded custom CA bundle from NODE_EXTRA_CA_CERTS');
        return contents;
      }
      logger.warn({ caPath }, 'LLM: CA bundle file exists but contains no PEM certificates');
    } catch (err) {
      logger.warn({ caPath, err }, 'LLM: Could not read CA bundle from NODE_EXTRA_CA_CERTS');
    }
  }

  // Fallback: try common system CA bundle paths
  const fallbackPaths = [
    '/etc/ssl/certs/ca-certificates.crt',                   // Debian/Ubuntu/Alpine
    '/etc/pki/tls/certs/ca-bundle.crt',                      // RHEL/CentOS
    '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',     // RHEL/CentOS (extracted)
  ];

  for (const path of fallbackPaths) {
    if (path === caPath) continue;
    if (!existsSync(path)) continue;
    try {
      const contents = readFileSync(path, 'utf-8');
      if (contents.includes('-----BEGIN CERTIFICATE-----')) {
        logger.info({ caPath: path, size: contents.length }, 'LLM: Loaded CA bundle from system path');
        return contents;
      }
    } catch {
      // Try next path
    }
  }

  if (!caPath) {
    logger.debug('LLM: No NODE_EXTRA_CA_CERTS set and no system CA bundle found - using Node.js defaults');
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parsed config (evaluated once at module load)
// ---------------------------------------------------------------------------

const caBundleContents = loadCaBundle();
const verifySsl = process.env.LLM_VERIFY_SSL !== 'false';
const authType = (process.env.LLM_AUTH_TYPE ?? 'none') as 'bearer' | 'none';
const bearerToken = process.env.LLM_BEARER_TOKEN ?? '';

if (!verifySsl) {
  logger.warn('LLM_VERIFY_SSL=false - TLS certificate verification is disabled for LLM/Ollama connections');
}

if (authType === 'bearer' && !bearerToken) {
  logger.warn('LLM_AUTH_TYPE=bearer but LLM_BEARER_TOKEN is empty');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LlmConnectOptions {
  rejectUnauthorized?: boolean;
  ca?: string;
}

/**
 * Build TLS connect options for undici Agent.
 * Respects LLM_VERIFY_SSL and NODE_EXTRA_CA_CERTS.
 */
export function buildLlmConnectOptions(): LlmConnectOptions | undefined {
  if (!verifySsl) {
    return { rejectUnauthorized: false };
  }
  if (caBundleContents) {
    return { ca: caBundleContents };
  }
  return undefined;
}

/**
 * Pre-configured undici Agent with TLS options for LLM/Ollama connections.
 * Returns undefined when default TLS settings are sufficient.
 */
const connectOpts = buildLlmConnectOptions();
export const llmDispatcher: Dispatcher | undefined = connectOpts
  ? new Agent({ connect: connectOpts })
  : undefined;

if (llmDispatcher) {
  logger.info(
    { verifySsl, hasCustomCa: !!caBundleContents, authType },
    'Created undici Agent with custom TLS configuration for LLM/Ollama',
  );
}

/**
 * Get auth headers for LLM/Ollama requests.
 * Reads env vars at call time to support dynamic token changes and test scenarios.
 * Returns empty object when no auth is configured.
 */
export function getLlmAuthHeaders(): Record<string, string> {
  const currentAuthType = (process.env.LLM_AUTH_TYPE ?? 'bearer').toLowerCase();
  const currentToken = process.env.LLM_BEARER_TOKEN ?? '';
  if (currentAuthType === 'bearer' && currentToken) {
    return { Authorization: `Bearer ${currentToken}` };
  }
  return {};
}

/**
 * Get the Ollama base URL from environment.
 */
export function getOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
}

/**
 * Whether SSL verification is enabled for LLM connections.
 */
export function isLlmVerifySslEnabled(): boolean {
  return verifySsl;
}

/**
 * Build a custom fetch function for the Ollama SDK that respects
 * TLS configuration and auth headers. The Ollama SDK accepts a `fetch`
 * option in its Config to override the default fetch implementation.
 *
 * When no custom TLS or auth is needed, returns undefined (use default fetch).
 */
export function buildOllamaFetch(): typeof fetch | undefined {
  const headers = getLlmAuthHeaders();
  const hasCustomHeaders = Object.keys(headers).length > 0;

  if (!llmDispatcher && !hasCustomHeaders) {
    return undefined;
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const mergedInit: RequestInit & { dispatcher?: Dispatcher } = { ...init };

    // Merge auth headers
    if (hasCustomHeaders) {
      const existingHeaders = new Headers(init?.headers);
      for (const [key, value] of Object.entries(headers)) {
        if (!existingHeaders.has(key)) {
          existingHeaders.set(key, value);
        }
      }
      mergedInit.headers = existingHeaders;
    }

    // Use custom dispatcher for TLS
    if (llmDispatcher) {
      mergedInit.dispatcher = llmDispatcher;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici fetch types differ from global fetch
    return undiciFetch(input as any, mergedInit as any) as unknown as Promise<Response>;
  };
}
