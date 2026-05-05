/**
 * Unit tests for trusted-proxy.ts — epic §3.4.
 *
 * Exports:
 *   - parseCidrSafe(raw): returns a parsed CIDR or null on malformed input.
 *   - matchesAny(rawAddr, cidrs): true iff the address matches any CIDR.
 *     Must normalise IPv4-mapped-IPv6 addresses (::ffff:1.2.3.4) to IPv4
 *     before matching — this is the canonical allowlist-bypass (research
 *     cluster-1 item #1).
 *   - buildTrustProxyFn(cidrs): a Fastify `trustProxy` function. Returns
 *     true iff the peer is in one of the given CIDRs.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCidrSafe,
  matchesAny,
  buildTrustProxyFn,
} from './trusted-proxy.js';

describe('parseCidrSafe', () => {
  it('parses a valid IPv4 CIDR', () => {
    expect(parseCidrSafe('10.0.0.0/8')).not.toBeNull();
  });

  it('parses a valid IPv6 CIDR', () => {
    expect(parseCidrSafe('2001:db8::/32')).not.toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseCidrSafe('not-a-cidr')).toBeNull();
    expect(parseCidrSafe('10.0.0.0')).toBeNull(); // missing prefix length
    expect(parseCidrSafe('999.999.999.999/8')).toBeNull();
    expect(parseCidrSafe('')).toBeNull();
  });
});

describe('matchesAny', () => {
  it('returns true for an IPv4 in an IPv4 CIDR', () => {
    const cidrs = [parseCidrSafe('10.0.0.0/8')!];
    expect(matchesAny('10.1.2.3', cidrs)).toBe(true);
  });

  it('returns false for an IPv4 outside the CIDR', () => {
    const cidrs = [parseCidrSafe('10.0.0.0/8')!];
    expect(matchesAny('192.168.1.1', cidrs)).toBe(false);
  });

  it('returns true for an IPv6 in an IPv6 CIDR', () => {
    const cidrs = [parseCidrSafe('2001:db8::/32')!];
    expect(matchesAny('2001:db8:1234::1', cidrs)).toBe(true);
  });

  it('returns false when kinds mismatch (IPv4 address vs IPv6 CIDR)', () => {
    const cidrs = [parseCidrSafe('2001:db8::/32')!];
    expect(matchesAny('10.1.2.3', cidrs)).toBe(false);
  });

  it('normalises IPv4-mapped-IPv6 (::ffff:a.b.c.d) and matches the IPv4 CIDR', () => {
    // This is the canonical allowlist-bypass — Node's dual-stack sockets
    // surface IPv4 peers as `::ffff:1.2.3.4`. Without .process() normalisation,
    // an IPv4 CIDR wouldn't match and the peer would be incorrectly treated
    // as untrusted (or worse, as a spoofable IPv6 address).
    const cidrs = [parseCidrSafe('10.0.0.0/8')!];
    expect(matchesAny('::ffff:10.1.2.3', cidrs)).toBe(true);
  });

  it('handles the loopback defaults (127.0.0.1/32 + ::1/128)', () => {
    const cidrs = [parseCidrSafe('127.0.0.1/32')!, parseCidrSafe('::1/128')!];
    expect(matchesAny('127.0.0.1', cidrs)).toBe(true);
    expect(matchesAny('::1', cidrs)).toBe(true);
    expect(matchesAny('127.0.0.2', cidrs)).toBe(false);
  });

  it('returns false for a malformed address string (soft-fail)', () => {
    const cidrs = [parseCidrSafe('10.0.0.0/8')!];
    expect(matchesAny('not-an-ip', cidrs)).toBe(false);
    expect(matchesAny('', cidrs)).toBe(false);
  });

  it('returns false when the CIDR list is empty', () => {
    expect(matchesAny('10.1.2.3', [])).toBe(false);
  });

  it('short-circuits across multiple CIDRs — any match returns true', () => {
    const cidrs = [
      parseCidrSafe('127.0.0.1/32')!,
      parseCidrSafe('10.0.0.0/8')!,
      parseCidrSafe('172.16.0.0/12')!,
    ];
    expect(matchesAny('172.16.5.5', cidrs)).toBe(true);
  });
});

describe('buildTrustProxyFn', () => {
  it('returns a function that trusts addresses inside the configured CIDR', () => {
    const trust = buildTrustProxyFn(['10.0.0.0/8']);
    expect(trust('10.1.2.3', 0)).toBe(true);
    expect(trust('192.168.1.1', 0)).toBe(false);
  });

  it('the default loopback list only trusts 127.0.0.1 and ::1', () => {
    // Intentionally NOT the "blanket" behaviour of `trustProxy: true` — this
    // is the documented behaviour change called out in epic §3.4 + CHANGELOG.
    const trust = buildTrustProxyFn(['127.0.0.1/32', '::1/128']);
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('::1', 0)).toBe(true);
    expect(trust('10.1.2.3', 0)).toBe(false);
  });

  it('drops malformed CIDRs silently — a broken config must not crash Fastify init', () => {
    const trust = buildTrustProxyFn(['10.0.0.0/8', 'garbage', '', 'not/a/cidr']);
    expect(trust('10.1.2.3', 0)).toBe(true);
    expect(trust('8.8.8.8', 0)).toBe(false);
  });

  it('treats IPv4-mapped-IPv6 peers as the IPv4 they represent', () => {
    const trust = buildTrustProxyFn(['10.0.0.0/8']);
    expect(trust('::ffff:10.1.2.3', 0)).toBe(true);
  });

  it('returns false for an empty CIDR list (trust nothing)', () => {
    const trust = buildTrustProxyFn([]);
    expect(trust('127.0.0.1', 0)).toBe(false);
    expect(trust('10.1.2.3', 0)).toBe(false);
  });
});
