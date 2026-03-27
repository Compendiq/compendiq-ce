import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { getLicenseInfo } from './license-service.js';
import type { LicenseTier } from './types.js';

declare module 'fastify' {
  interface FastifyInstance {
    checkEnterpriseLicense: (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    licenseTier: LicenseTier;
  }
}

export default fp(async (fastify: FastifyInstance) => {
  // Attach license tier to every request (lightweight — cached)
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    request.licenseTier = getLicenseInfo().tier;
  });

  fastify.decorate('checkEnterpriseLicense', async (_request: FastifyRequest) => {
    const license = getLicenseInfo();
    if (license.tier === 'community') {
      throw fastify.httpErrors.forbidden('This feature requires an active enterprise license');
    }
  });
});
