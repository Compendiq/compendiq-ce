/**
 * SSRF guard for MCP docs sidecar.
 * Blocks requests to private/internal networks.
 * Adapted from backend/src/core/utils/ssrf-guard.ts
 */

import { lookup } from 'node:dns/promises';

const BLOCKED_IPV4_PATTERNS = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/,
];

const BLOCKED_IPV6_PATTERNS = [
  /^::1$/,
  /^::$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
];

const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'instance-data',
];

const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.corp', '.home', '.lan'];

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export function validateUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new SsrfError('SSRF blocked: invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SsrfError(`SSRF blocked: protocol '${parsed.protocol}' not allowed`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    throw new SsrfError('SSRF blocked: internal hostname');
  }

  if (isBlockedIpv4(hostname) || isBlockedIpv6(hostname)) {
    throw new SsrfError('SSRF blocked: private IP address');
  }

  if (BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new SsrfError('SSRF blocked: internal domain suffix');
  }

  return parsed;
}

/**
 * DNS-resolving SSRF validation. Runs the sync `validateUrl()` checks first,
 * then resolves the hostname (A + AAAA) and runs EVERY resolved address back
 * through the private-IP blocklist. This closes the bypass where a publicly
 * registered hostname resolves to an internal address (e.g. 169.254.169.254
 * cloud metadata, 127.0.0.1, a Docker-internal service, or a DNS-rebinding
 * domain) — the literal-string checks in validateUrl() never see that IP.
 *
 * NOTE: a TOCTOU gap remains between this lookup and the TCP connect; callers
 * that follow redirects must re-validate each hop (fetch-url.ts uses
 * redirect: 'manual' and rejects 3xx, so the connect target is fixed here).
 *
 * @throws SsrfError if the URL is malformed, non-HTTP(S), or any resolved
 *   address is private/internal.
 */
export async function validateUrlWithDns(urlString: string): Promise<URL> {
  // All sync syntax/protocol/literal-IP/hostname checks first.
  const parsed = validateUrl(urlString);

  // Resolve A + AAAA records and reject if ANY resolved address is private.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch {
    // DNS failures (ENOTFOUND, etc.) are surfaced by the HTTP client later;
    // a name that does not resolve cannot reach an internal address here.
    return parsed;
  }

  for (const { address } of addresses) {
    if (isBlockedIpv4(address) || isBlockedIpv6(address)) {
      throw new SsrfError(
        `SSRF blocked: '${parsed.hostname}' resolved to private IP ${address}`,
      );
    }
  }

  return parsed;
}

function isBlockedIpv4(hostname: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false;
  return BLOCKED_IPV4_PATTERNS.some((p) => p.test(hostname));
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (BLOCKED_IPV6_PATTERNS.some((p) => p.test(normalized))) return true;

  const ipv4MappedDotted = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4MappedDotted) return isBlockedIpv4(ipv4MappedDotted[1]);

  const ipv4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (ipv4MappedHex) {
    const high = parseInt(ipv4MappedHex[1], 16);
    const low = parseInt(ipv4MappedHex[2], 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isBlockedIpv4(ipv4);
  }

  return false;
}
