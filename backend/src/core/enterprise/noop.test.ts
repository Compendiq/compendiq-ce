import { describe, it, expect, vi } from 'vitest';
import { noopPlugin } from './noop.js';

describe('noopPlugin (community mode)', () => {
  it('should have version "community"', () => {
    expect(noopPlugin.version).toBe('community');
  });

  it('validateLicense should always return null', () => {
    expect(noopPlugin.validateLicense(undefined)).toBeNull();
    expect(noopPlugin.validateLicense('')).toBeNull();
    expect(noopPlugin.validateLicense('ATM-enterprise-50-20271231.fake')).toBeNull();
  });

  it('isFeatureEnabled should always return false', () => {
    expect(noopPlugin.isFeatureEnabled('oidc_sso', null)).toBe(false);
    expect(noopPlugin.isFeatureEnabled('anything', null)).toBe(false);
    expect(
      noopPlugin.isFeatureEnabled('oidc_sso', {
        tier: 'enterprise',
        seats: 50,
        expiresAt: new Date('2099-12-31'),
        isValid: true,
        displayKey: 'ATM-enterprise-50-20991231',
      }),
    ).toBe(false);
  });

  it('requireFeature should return a preHandler that sends 403', async () => {
    const handler = noopPlugin.requireFeature('oidc_sso');
    const mockReply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    await handler({} as never, mockReply as never);

    expect(mockReply.status).toHaveBeenCalledWith(403);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'EnterpriseRequired',
        statusCode: 403,
      }),
    );
  });

  it('registerRoutes should be a no-op (resolves without side effects)', async () => {
    // Should not throw and should resolve to undefined
    await expect(noopPlugin.registerRoutes({} as never, null)).resolves.toBeUndefined();
  });
});
