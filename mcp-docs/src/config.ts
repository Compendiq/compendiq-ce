/**
 * Environment parsing for the MCP docs sidecar.
 *
 * Numeric env vars are parsed with explicit NaN/range guards so a malformed
 * value fails fast (PORT) or falls back (CACHE_TTL) instead of silently
 * binding a random ephemeral port or using a NaN TTL.
 */

export const DEFAULT_CACHE_TTL = 3600;

/**
 * Parse and validate a TCP port. Returns the port when it is an integer in
 * 1..65535, otherwise null (caller should treat that as fatal).
 */
export function parsePort(raw: string | undefined, fallback = '3100'): number | null {
  const port = parseInt(raw ?? fallback, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

/**
 * Parse a cache TTL in seconds, falling back to {@link DEFAULT_CACHE_TTL} when
 * the value is unset, non-numeric, or non-positive.
 */
export function parseCacheTtl(raw: string | undefined): number {
  const ttl = parseInt(raw ?? String(DEFAULT_CACHE_TTL), 10);
  return Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_CACHE_TTL;
}
