import type { FastifyInstance } from 'fastify';
import { LoginPageConfigSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import {
  getLoginPageVariant,
  setLoginPageVariant,
} from '../../core/services/login-page-config-service.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';

const PUBLIC_RATE_LIMIT = {
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
};

const ADMIN_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: async () => (await getRateLimits()).admin.max,
      timeWindow: '1 minute',
    },
  },
};

export async function loginPageConfigRoutes(fastify: FastifyInstance) {
  // Public by design: the login route needs its presentation before a user
  // has authenticated. The response contains only the two-value layout choice.
  fastify.get('/auth/login-page-config', PUBLIC_RATE_LIMIT, async () => ({
    variant: await getLoginPageVariant(),
  }));

  // Persisted globally for the deployment. Authentication logic is shared and
  // unaffected by this presentation-only setting.
  fastify.put(
    '/admin/login-page-config',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      const next = LoginPageConfigSchema.parse(request.body);
      const previousVariant = await getLoginPageVariant();

      await setLoginPageVariant(next.variant);
      await logAuditEvent(
        request.userId,
        'ADMIN_ACTION',
        'admin_settings',
        undefined,
        {
          action: 'update_login_page_variant',
          previousVariant,
          variant: next.variant,
        },
        request,
      );

      return next;
    },
  );
}
