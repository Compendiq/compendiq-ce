import type { EnterprisePlugin } from './types.js';

/**
 * Community-mode stub that implements the EnterprisePlugin contract.
 *
 * All features are disabled. No error logging, no degradation messages.
 * Community IS the default — this is not a fallback, it is the product.
 *
 * Zero dependencies, zero side effects.
 */
export const noopPlugin: EnterprisePlugin = {
  validateLicense: () => null,

  isFeatureEnabled: () => false,

  requireFeature: () => async (_req, reply) => {
    reply.status(403).send({
      error: 'EnterpriseRequired',
      message: 'This feature requires an enterprise license',
      statusCode: 403,
    });
  },

  registerRoutes: async () => {
    // No-op: community mode does not register any enterprise routes.
  },

  version: 'community',
};
