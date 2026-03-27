import { FastifyInstance } from 'fastify';
import { getLicenseInfo } from '../../enterprise/license-service.js';
import { ENTERPRISE_FEATURES } from '../../enterprise/types.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const ADMIN_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } } };

export async function licenseRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.requireAdmin);

  /**
   * GET /api/admin/license
   * Returns current license status and feature entitlements.
   */
  fastify.get('/admin/license', ADMIN_RATE_LIMIT, async () => {
    const info = getLicenseInfo();
    const features = info.tier !== 'community'
      ? ENTERPRISE_FEATURES[info.tier] ?? []
      : [];

    return {
      tier: info.tier,
      seats: info.seats,
      expiry: info.isValid ? info.expiry.toISOString() : null,
      features,
      isValid: info.isValid,
    };
  });
}
