/**
 * Fastify `onRequest` hook for the IP allowlist (EE #111, Phase C).
 *
 * Resolves the effective client IP on every request and short-circuits with
 * `403 ip_blocked` when the address falls outside the configured CIDRs.
 *
 * Why walk XFF here instead of leaning on `request.ip`:
 *   Fastify reads `trustProxy` once at server construction and cannot swap it
 *   at runtime. Admins can update the trusted-proxies list via
 *   `PUT /api/admin/ip-allowlist`; we need the hook to see the NEW list on
 *   every request. So we read `req.socket.remoteAddress` directly and use
 *   `isTrustedProxy` from ip-allowlist-service (which reflects the live
 *   cached config). See trusted-proxy.ts for the companion notes.
 *
 * Order of work (matches v0.4 epic §3.4 / plan step 4b):
 *   1. Strip query string; exempt-path short-circuit (health, auth, license).
 *   2. Normalise socket peer (drop `::ffff:` IPv4-mapped-IPv6 prefix).
 *   3. If socket is trusted → walk `X-Forwarded-For` right-to-left, stop at
 *      the first untrusted hop. Otherwise ignore XFF entirely (defends
 *      against forged headers from untrusted clients).
 *   4. If !isAllowed → fire-and-forget audit, reply 403. Audit is NOT
 *      awaited so the blocked response fires immediately (explicit plan req).
 */

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  isAllowed,
  isTrustedProxy,
  isExemptPath,
} from '../services/ip-allowlist-service.js';
import { logAuditEvent } from '../services/audit-service.js';

/**
 * Strip the `::ffff:` IPv4-mapped-IPv6 prefix so an IPv4 peer surfaced by a
 * dual-stack socket compares correctly against IPv4 CIDRs. `ip-allowlist-
 * service` also normalises via `ipaddr.process()`, but the raw socket string
 * is what we feed to `isTrustedProxy`, so we strip here too for clarity
 * (and to get a clean string into the audit metadata).
 */
function normaliseSocketAddr(raw: string | undefined): string {
  if (!raw) return '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * Walk the `X-Forwarded-For` header right-to-left to find the first untrusted
 * hop, per RFC 7239 / OWASP guidance. Assumes the caller has already verified
 * the socket peer is trusted — forged headers from untrusted peers must NOT
 * reach this function.
 *
 * If every hop is trusted, returns the leftmost hop (the claimed original
 * client as seen by the most upstream proxy). If the header is empty or
 * missing, returns `socketIp`.
 */
function resolveClientIpFromXff(
  xffRaw: string | string[] | undefined,
  socketIp: string,
): string {
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw;
  if (!xff) return socketIp;

  const hops = xff
    .split(',')
    .map((h) => h.trim())
    .filter((h): h is string => h.length > 0);
  if (hops.length === 0) return socketIp;

  // Walk right-to-left. First untrusted hop from the right wins; if the
  // entire chain is trusted, the leftmost trusted hop wins (= the last one
  // we see in the reversed walk).
  let lastTrusted = '';
  for (let i = hops.length - 1; i >= 0; i--) {
    // Safe non-null assert: the loop bound guarantees `i` is within range,
    // and `filter((h): h is string)` above means every element is a string.
    // TS's `noUncheckedIndexedAccess` cannot prove this on its own.
    const hop = hops[i]!;
    if (isTrustedProxy(hop)) {
      lastTrusted = hop;
      continue;
    }
    return hop;
  }
  return lastTrusted || socketIp;
}

/**
 * Resolve the effective client IP for allowlist matching. Exported for unit
 * testing — the hook itself uses this helper internally.
 */
export function resolveClientIp(req: FastifyRequest): {
  clientIp: string;
  socketIp: string;
} {
  const socketIp = normaliseSocketAddr(req.socket.remoteAddress);
  if (!socketIp) return { clientIp: '', socketIp: '' };

  if (!isTrustedProxy(socketIp)) {
    // Untrusted peer: forged XFF headers must NOT influence the decision.
    return { clientIp: socketIp, socketIp };
  }

  const clientIp = resolveClientIpFromXff(
    req.headers['x-forwarded-for'],
    socketIp,
  );
  return { clientIp, socketIp };
}

export default fp(
  async function ipAllowlistHook(fastify: FastifyInstance): Promise<void> {
    fastify.addHook(
      'onRequest',
      async (req: FastifyRequest, reply: FastifyReply) => {
        // `split('?')` always returns at least one element, so the `?? ''`
        // is strictly defensive for `noUncheckedIndexedAccess`.
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (isExemptPath(path)) return;

        const { clientIp, socketIp } = resolveClientIp(req);

        if (!isAllowed(clientIp)) {
          // Fire-and-forget: do NOT await. The 403 must not wait on the audit
          // INSERT; logAuditEvent already swallows its own errors.
          void logAuditEvent(
            null,
            'IP_ALLOWLIST_BLOCKED',
            'request',
            path,
            {
              clientIp,
              socketIp,
              xff: req.headers['x-forwarded-for'],
            },
            req,
          );
          return reply.code(403).send({
            error: 'ip_blocked',
            message: 'Access denied from your network.',
          });
        }
      },
    );
  },
  {
    name: 'ip-allowlist-hook',
    fastify: '5.x',
  },
);
