/**
 * Trust-proxy hardening helpers (v0.4 epic §3.4).
 *
 * Provides:
 *   - `parseCidrSafe`  — lenient CIDR parser that returns null on malformed input.
 *   - `matchesAny`     — dual-stack-aware address-in-CIDR-list check.
 *   - `buildTrustProxyFn` — Fastify `trustProxy` function factory used at
 *     app.ts startup in place of the previous blanket `trustProxy: true`.
 *
 * The dual-stack normalisation step is load-bearing: Node sockets surface
 * IPv4 peers as `::ffff:a.b.c.d` when IPv6 is available, and without
 * `ipaddr.process()` we would fail to match them against IPv4 CIDRs —
 * the canonical allowlist-bypass (research cluster-1 item #1).
 *
 * Note on hot-reload: Fastify reads `trustProxy` once at server construction
 * and cannot have it swapped at runtime. The IP-allowlist onRequest hook
 * therefore walks XFF itself using the live trusted-proxies list; this
 * helper only governs Fastify's own `request.ip`. See §3.4 + the plan for
 * #111 step 4b.
 */

import ipaddr from 'ipaddr.js';

export type ParsedCidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

export function parseCidrSafe(raw: string): ParsedCidr | null {
  try {
    return ipaddr.parseCIDR(raw);
  } catch {
    return null;
  }
}

export function matchesAny(rawAddr: string, cidrs: ParsedCidr[]): boolean {
  if (cidrs.length === 0) return false;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(rawAddr);
  } catch {
    return false;
  }
  for (const cidr of cidrs) {
    if (addr.kind() === cidr[0].kind() && addr.match(cidr)) return true;
  }
  return false;
}

/**
 * Build a Fastify-compatible `trustProxy` function that trusts only addresses
 * falling inside one of the given CIDRs. Malformed CIDRs in the input are
 * silently dropped — a broken config must not take down Fastify startup.
 *
 * Pass `[]` for "trust nothing" semantics (equivalent to `trustProxy: false`);
 * the v0.4 default when the IP-allowlist feature is disabled is
 * `['127.0.0.1/32', '::1/128']` (loopback only), a behaviour change from the
 * previous `trustProxy: true` blanket that MUST be flagged in CHANGELOG.
 */
export function buildTrustProxyFn(cidrs: string[]): (addr: string, hop: number) => boolean {
  const parsed = cidrs
    .map(parseCidrSafe)
    .filter((c): c is ParsedCidr => c !== null);

  return function trustProxy(addr: string): boolean {
    return matchesAny(addr, parsed);
  };
}
