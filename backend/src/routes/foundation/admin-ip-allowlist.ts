/**
 * Admin IP-allowlist REST routes (EE #111, Phase D).
 *
 * Endpoints:
 *   - `GET  /api/admin/ip-allowlist`       — current persisted config
 *   - `PUT  /api/admin/ip-allowlist`       — replace the whole config
 *   - `POST /api/admin/ip-allowlist/test`  — dry-run `isAllowed` against an IP
 *
 * All three are admin-only (`fastify.authenticate` + `fastify.requireAdmin`)
 * and share the shared admin rate-limit bucket.
 *
 * The Phase E Fastify `onRequest` hook and the `trustProxy` rewiring live in
 * separate files; this module deliberately does NOT touch either.
 *
 * Semantic validation (CIDR well-formed, exception path starts with `/api/`)
 * happens here — the `@compendiq/contracts` Zod schemas enforce only the
 * structural shape so the contracts package stays free of backend deps.
 */

import type { FastifyInstance } from 'fastify';
import ipaddr from 'ipaddr.js';
import {
  IpAllowlistConfigSchema,
  IpAllowlistTestRequestSchema,
} from '@compendiq/contracts';
import {
  getPersistedConfig,
  updateConfig,
} from '../../core/services/ip-allowlist-service.js';
import { parseCidrSafe, matchesAny } from '../../core/utils/trusted-proxy.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: async () => (await getRateLimits()).admin.max,
      timeWindow: '1 minute',
    },
  },
};

export async function adminIpAllowlistRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET — return the current persisted config (fresh DB read, not cache).
  fastify.get(
    '/admin/ip-allowlist',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      const config = await getPersistedConfig();
      return { config };
    },
  );

  // PUT — replace the whole config. Validates every CIDR via `parseCidrSafe`
  // (well-formed + parseable) and every exception path via an `/api/` prefix
  // check so admins cannot accidentally exempt the entire app.
  fastify.put(
    '/admin/ip-allowlist',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const next = IpAllowlistConfigSchema.parse(request.body);

      for (const cidr of next.cidrs) {
        if (parseCidrSafe(cidr) === null) {
          return reply.code(400).send({ error: 'invalid_cidr', cidr });
        }
      }
      for (const cidr of next.trustedProxies) {
        if (parseCidrSafe(cidr) === null) {
          return reply.code(400).send({ error: 'invalid_cidr', cidr });
        }
      }
      for (const path of next.exceptions) {
        if (!path.startsWith('/api/')) {
          return reply.code(400).send({ error: 'invalid_exception', path });
        }
      }

      await updateConfig(next, request.userId, request);
      return { config: next };
    },
  );

  // POST /test — dry-run the allowlist check against a caller-supplied IP.
  // Re-implements the semantics inline (against a freshly read config)
  // rather than delegating to the cached `isAllowed` helpers, so the route
  // works even if `initIpAllowlistService` has not yet been wired in app.ts
  // (that wiring lands in Phase E) and so we can also surface the matched
  // CIDR back to the admin UI.
  fastify.post(
    '/admin/ip-allowlist/test',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const { ip } = IpAllowlistTestRequestSchema.parse(request.body);

      let addr: ipaddr.IPv4 | ipaddr.IPv6;
      try {
        addr = ipaddr.process(ip);
      } catch {
        return reply.code(400).send({ error: 'invalid_ip' });
      }

      const config = await getPersistedConfig();

      // Trusted-proxy check is independent of the enabled flag.
      const trustParsed = config.trustedProxies
        .map(parseCidrSafe)
        .filter((c): c is NonNullable<ReturnType<typeof parseCidrSafe>> => c !== null);
      const isTrustedProxy = matchesAny(ip, trustParsed);

      // Short-circuit: feature disabled → everything allowed.
      if (!config.enabled) {
        return {
          allowed: true,
          matchedCidr: null,
          isTrustedProxy,
          reason: 'allowed (feature disabled)',
        };
      }

      // Find the first matching CIDR so the admin UI can tell the user which
      // rule let the IP through. Preserves input order — admins typically put
      // the more specific rule first.
      let matchedCidr: string | null = null;
      for (const raw of config.cidrs) {
        const parsed = parseCidrSafe(raw);
        if (parsed === null) continue;
        if (addr.kind() === parsed[0].kind() && addr.match(parsed)) {
          matchedCidr = raw;
          break;
        }
      }

      if (matchedCidr !== null) {
        return {
          allowed: true,
          matchedCidr,
          isTrustedProxy,
          reason: `allowed (matches ${matchedCidr})`,
        };
      }

      return {
        allowed: false,
        matchedCidr: null,
        isTrustedProxy,
        reason: 'blocked (no matching CIDR)',
      };
    },
  );
}
