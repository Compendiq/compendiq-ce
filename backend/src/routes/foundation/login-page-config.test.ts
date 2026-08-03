import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

const mockGetLoginPageVariant = vi.fn();
const mockSetLoginPageVariant = vi.fn();
const mockRequireAdmin = vi.fn();
const mockGetEnterprisePlugin = vi.fn();

vi.mock('../../core/enterprise/loader.js', () => ({
  getEnterprisePlugin: () => mockGetEnterprisePlugin(),
}));

vi.mock('../../core/services/login-page-config-service.js', () => ({
  getLoginPageVariant: (...args: unknown[]) => mockGetLoginPageVariant(...args),
  setLoginPageVariant: (...args: unknown[]) => mockSetLoginPageVariant(...args),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn().mockResolvedValue({ admin: { max: 100 } }),
}));

import { logAuditEvent } from '../../core/services/audit-service.js';
import { loginPageConfigRoutes } from './login-page-config.js';

describe('login page config routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'ValidationError' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('requireAdmin', async (request: { userId: string }) => {
      mockRequireAdmin();
      request.userId = 'admin-user-id';
    });
    await app.register(loginPageConfigRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLoginPageVariant.mockResolvedValue('local-loop');
    mockSetLoginPageVariant.mockResolvedValue(undefined);
    mockGetEnterprisePlugin.mockReturnValue({ version: 'community' });
  });

  it('exposes the effective variant without authentication', async () => {
    mockGetLoginPageVariant.mockResolvedValue('change-desk');

    const response = await app.inject({ method: 'GET', url: '/api/auth/login-page-config' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ variant: 'change-desk', edition: 'community' });
    expect(mockRequireAdmin).not.toHaveBeenCalled();
  });

  // The login screen is unauthenticated and cannot read GET /api/admin/license,
  // so the edition it badges itself with comes from here. Both editions ship the
  // same CE SPA — without this the EE sign-in page brands itself "Community
  // Edition · AGPL-3.0".
  it('reports the enterprise edition when the enterprise plugin is loaded', async () => {
    mockGetEnterprisePlugin.mockReturnValue({ version: '1.4.2' });

    const response = await app.inject({ method: 'GET', url: '/api/auth/login-page-config' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ variant: 'local-loop', edition: 'enterprise' });
  });

  it('reports the community edition when the noop shim is active', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/login-page-config' });

    expect(response.json()).toMatchObject({ edition: 'community' });
  });

  it('lets an admin persist a supported variant and audits the change', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/login-page-config',
      payload: { variant: 'change-desk' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ variant: 'change-desk' });
    expect(mockRequireAdmin).toHaveBeenCalledOnce();
    expect(mockSetLoginPageVariant).toHaveBeenCalledWith('change-desk');
    expect(logAuditEvent).toHaveBeenCalledWith(
      'admin-user-id',
      'ADMIN_ACTION',
      'admin_settings',
      undefined,
      expect.objectContaining({
        action: 'update_login_page_variant',
        previousVariant: 'local-loop',
        variant: 'change-desk',
      }),
      expect.anything(),
    );
  });

  it('rejects unknown variants before persistence', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/login-page-config',
      payload: { variant: 'other' },
    });

    expect(response.statusCode).toBe(400);
    expect(mockSetLoginPageVariant).not.toHaveBeenCalled();
  });
});
