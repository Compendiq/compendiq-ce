/**
 * SSRF (Server-Side Request Forgery) validation.
 * Blocks requests to private/internal networks and non-HTTP(S) protocols.
 *
 * Supports an allowlist of trusted origins (e.g., user-configured Confluence
 * base URLs) that bypass private-network checks while still enforcing
 * protocol restrictions.
 */

import { lookup } from 'node:dns/promises';

// ---------------------------------------------------------------------------
// Allowlist of trusted origins (populated from user_settings.confluence_url)
// ---------------------------------------------------------------------------

const allowedOrigins = new Set<string>();

/**
 * Register a base URL whose origin should bypass private-network checks.
 * Only the origin (protocol + host + port) is stored -- path is ignored.
 */
export function addAllowedBaseUrl(baseUrl: string): void {
  try {
    const parsed = new URL(baseUrl);
    allowedOrigins.add(parsed.origin.toLowerCase());
  } catch { /* ignore invalid URLs */ }
}

/** Remove a previously-allowed base URL origin from the allowlist. */
export function removeAllowedBaseUrl(baseUrl: string): void {
  try {
    const parsed = new URL(baseUrl);
    allowedOrigins.delete(parsed.origin.toLowerCase());
  } catch { /* ignore invalid URLs */ }
}

/** Replace all allowed origins with a fresh set (reconciliation). */
export function replaceAllowedBaseUrls(baseUrls: string[]): void {
  allowedOrigins.clear();
  for (const url of baseUrls) {
    addAllowedBaseUrl(url);
  }
}

/** Clear all allowed origins (useful in tests). */
export function clearAllowedBaseUrls(): void {
  allowedOrigins.clear();
}

/** Return current allowlist size (useful in tests). */
export function getAllowedBaseUrlCount(): number {
  return allowedOrigins.size;
}

/**
 * Private/internal IPv4 ranges as CIDR.
 * Includes RFC 1918, loopback, link-local, and special addresses.
 */
const BLOCKED_IPV4_PATTERNS = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,         // 127.0.0.0/8 loopback
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,           // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,  // 172.16.0.0/12
  /^192\.168\.\d{1,3}\.\d{1,3}$/,              // 192.168.0.0/16
  /^0\.0\.0\.0$/,                                // Unspecified
  /^169\.254\.\d{1,3}\.\d{1,3}$/,              // Link-local
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/, // CGNAT 100.64.0.0/10
];

/**
 * Private/internal IPv6 patterns.
 */
const BLOCKED_IPV6_PATTERNS = [
  /^::1$/,                  // Loopback
  /^::$/,                   // Unspecified
  /^fc[0-9a-f]{2}:/i,      // fc00::/7 Unique local
  /^fd[0-9a-f]{2}:/i,      // fd00::/8 Unique local
  /^fe[89ab][0-9a-f]:/i,   // fe80::/10 Link-local
];

const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',     // GCP metadata
  'instance-data',                // AWS metadata alias
];

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Validates a URL to prevent SSRF attacks.
 * Blocks private IPs, internal hostnames, and non-HTTP(S) protocols.
 *
 * LIMITATION: The allowlist validates the hostname/origin, not the resolved IP.
 * DNS rebinding attacks (hostname resolves to public IP during validation, then
 * to private IP during the actual request) are NOT prevented. This is acceptable
 * because allowlisted URLs are sourced from authenticated user settings stored in
 * the database, not from untrusted user input in request bodies.
 *
 * @throws SsrfError if the URL targets a private/internal address
 */
export function validateUrl(urlString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new SsrfError('SSRF blocked: invalid URL');
  }

  // Block non-HTTP(S) protocols
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new SsrfError(`SSRF blocked: protocol '${parsed.protocol}' is not allowed. Only HTTP(S) permitted.`);
  }

  // Allow explicitly trusted origins (e.g., user-configured Confluence URLs)
  if (allowedOrigins.has(parsed.origin.toLowerCase())) {
    return;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Strip IPv6 brackets if present
  const cleanHostname = hostname.replace(/^\[|\]$/g, '');

  // Check blocked hostnames
  if (BLOCKED_HOSTNAMES.includes(cleanHostname)) {
    throw new SsrfError('SSRF blocked: cannot connect to internal/private network');
  }

  // Check if it looks like an IP address
  if (isBlockedIpv4(cleanHostname)) {
    throw new SsrfError('SSRF blocked: cannot connect to internal/private network');
  }

  if (isBlockedIpv6(cleanHostname)) {
    throw new SsrfError('SSRF blocked: cannot connect to internal/private network');
  }

  // Check for DNS rebinding with numeric hostnames that could resolve to private IPs
  // Also block any hostname ending in common internal TLDs
  const blockedSuffixes = ['.local', '.internal', '.localhost', '.corp', '.home', '.lan'];
  if (blockedSuffixes.some((suffix) => cleanHostname.endsWith(suffix))) {
    throw new SsrfError('SSRF blocked: cannot connect to internal/private network');
  }
}

function isBlockedIpv4(hostname: string): boolean {
  // Quick check: does it look like an IPv4 address?
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return false;
  }

  return BLOCKED_IPV4_PATTERNS.some((pattern) => pattern.test(hostname));
}

function isBlockedIpv6(hostname: string): boolean {
  // Normalize compressed IPv6 (::1 etc.)
  const normalized = hostname.toLowerCase();

  // Check direct matches
  if (BLOCKED_IPV6_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // Handle IPv4-mapped IPv6 addresses in dotted notation (::ffff:127.0.0.1)
  const ipv4MappedDotted = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4MappedDotted) {
    return isBlockedIpv4(ipv4MappedDotted[1]!);
  }

  // Handle IPv4-mapped IPv6 addresses in hex notation (::ffff:7f00:1)
  // URL parser normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1
  const ipv4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (ipv4MappedHex) {
    const high = parseInt(ipv4MappedHex[1]!, 16);
    const low = parseInt(ipv4MappedHex[2]!, 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isBlockedIpv4(ipv4);
  }

  return false;
}

/**
 * Check whether a resolved IP address belongs to a blocked (private/internal) range.
 * Works on both IPv4 and IPv6 addresses returned by dns.lookup().
 */
function isBlockedIp(ip: string): boolean {
  return isBlockedIpv4(ip) || isBlockedIpv6(ip);
}

/**
 * DNS rebinding mitigation: resolve hostname and verify the IP is not private.
 * NOTE: This narrows the rebinding window but does not fully prevent it --
 * there is a TOCTOU gap between DNS lookup and TCP connect.
 */
async function resolveAndValidateIp(hostname: string): Promise<void> {
  try {
    const { address } = await lookup(hostname);
    if (isBlockedIp(address)) {
      throw new SsrfError(`SSRF blocked: DNS resolved to blocked IP: ${hostname} -> ${address}`);
    }
  } catch (err) {
    // Re-throw our own SsrfError
    if (err instanceof SsrfError) throw err;
    // DNS lookup failures (ENOTFOUND, etc.) are handled by the HTTP client later
  }
}

/**
 * Async URL validation with DNS rebinding mitigation.
 * Performs all sync checks from validateUrl(), then resolves the hostname
 * and verifies the IP is not private (for non-allowlisted URLs).
 *
 * Use this in async contexts where DNS rebinding protection
 * is desired. Existing sync callers keep using validateUrl().
 */
export async function validateUrlWithDns(urlString: string): Promise<void> {
  validateUrl(urlString); // all sync checks first

  const parsed = new URL(urlString);
  if (!allowedOrigins.has(parsed.origin.toLowerCase())) {
    await resolveAndValidateIp(parsed.hostname);
  }
}

// ---------------------------------------------------------------------------
// Docker-aware URL rewriting
// ---------------------------------------------------------------------------

const LOCALHOST_PATTERNS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * When the backend runs inside Docker, user-entered `localhost` / `127.0.0.1`
 * URLs point at the container itself — not the host or a sibling container.
 *
 * If `CONFLUENCE_DOCKER_HOST` is set (e.g. `confluence`), rewrite the hostname
 * so outbound requests reach the correct container on the Docker network.
 * The original user-facing URL is stored unchanged in the database.
 */
export function resolveConfluenceUrl(url: string): string {
  const dockerHost = process.env.CONFLUENCE_DOCKER_HOST;
  if (!dockerHost) return url;

  try {
    const parsed = new URL(url);
    if (LOCALHOST_PATTERNS.includes(parsed.hostname.toLowerCase())) {
      parsed.hostname = dockerHost;
      return parsed.toString().replace(/\/$/, '');
    }
  } catch { /* invalid URL — let callers deal with it */ }
  return url;
}
