/**
 * SSRF (Server-Side Request Forgery) validation.
 * Blocks requests to private/internal networks and non-HTTP(S) protocols.
 *
 * Allowlist: URLs the user has explicitly configured (e.g. Confluence on a private network)
 * can be registered via {@link addAllowedBaseUrl} so that validateUrl permits them.
 * The allowlist check runs after the protocol check, so file:// and other dangerous
 * protocols are always blocked regardless of any allowlist entries.
 */

/**
 * In-memory set of allowed origins (lowercased protocol+hostname+explicit-port).
 * Populated at startup from user_settings.confluence_url and kept updated whenever
 * a user saves or tests a Confluence URL.
 *
 * Stored as normalised origins, e.g. "http://192.168.1.50:8090" or
 * "https://confluence.internal.corp" (no trailing slash, no path).
 */
const allowedOrigins = new Set<string>();

/**
 * Register a base URL as explicitly trusted for SSRF validation.
 *
 * Call this ONLY with URLs the user has deliberately configured, never with
 * arbitrary user-supplied data that has not been validated for intent.
 *
 * The origin is normalised to lowercase and stored without default ports
 * (port 80 for http, port 443 for https), so that
 * "https://confluence.internal.corp:443" and "https://confluence.internal.corp"
 * are treated as the same entry.
 *
 * Invalid URLs are silently ignored (no throw, no entry added).
 */
export function addAllowedBaseUrl(rawUrl: string): void {
  try {
    const parsed = new URL(rawUrl);
    // Only accept http/https — adding file:// or other protocols must be a no-op
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) return;
    // Normalise: drop explicit port when it equals the default for the protocol
    const isDefaultPort =
      (parsed.protocol === 'http:' && (parsed.port === '80' || parsed.port === '')) ||
      (parsed.protocol === 'https:' && (parsed.port === '443' || parsed.port === ''));
    const normalisedOrigin = isDefaultPort
      ? `${parsed.protocol}//${parsed.hostname}`.toLowerCase()
      : `${parsed.protocol}//${parsed.hostname}:${parsed.port}`.toLowerCase();
    allowedOrigins.add(normalisedOrigin);
  } catch {
    // Ignore invalid URLs
  }
}

/**
 * Remove all entries from the allowlist.
 *
 * FOR TEST ISOLATION ONLY — must never be called in production code paths.
 */
export function clearAllowedBaseUrls(): void {
  allowedOrigins.clear();
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
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.\d{1,3}\.\d{1,3}$/, // CGNAT 100.64.0.0/10
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
 * Allowlist: if the URL's origin matches an entry registered via
 * {@link addAllowedBaseUrl}, the URL passes without further IP/hostname checks.
 * The protocol check always runs first — non-HTTP(S) URLs are blocked regardless
 * of allowlist entries.
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

  // Block non-HTTP(S) protocols — always runs before allowlist check
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    throw new SsrfError(`SSRF blocked: protocol '${parsed.protocol}' is not allowed. Only HTTP(S) permitted.`);
  }

  // Check allowlist: if this origin was explicitly registered by the user, allow it
  if (allowedOrigins.size > 0) {
    const isDefaultPort =
      (parsed.protocol === 'http:' && (parsed.port === '80' || parsed.port === '')) ||
      (parsed.protocol === 'https:' && (parsed.port === '443' || parsed.port === ''));
    const requestOrigin = isDefaultPort
      ? `${parsed.protocol}//${parsed.hostname}`.toLowerCase()
      : `${parsed.protocol}//${parsed.hostname}:${parsed.port}`.toLowerCase();
    if (allowedOrigins.has(requestOrigin)) {
      return;
    }
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
    return isBlockedIpv4(ipv4MappedDotted[1]);
  }

  // Handle IPv4-mapped IPv6 addresses in hex notation (::ffff:7f00:1)
  // URL parser normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1
  const ipv4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (ipv4MappedHex) {
    const high = parseInt(ipv4MappedHex[1], 16);
    const low = parseInt(ipv4MappedHex[2], 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isBlockedIpv4(ipv4);
  }

  return false;
}
