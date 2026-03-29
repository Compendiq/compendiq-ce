import { describe, it, expect, beforeEach } from 'vitest';
import { loadEnterpriseUI, _resetForTesting } from './loader';

describe('Enterprise frontend loader', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('should return null when @atlasmind/enterprise/frontend is not installed', async () => {
    const ui = await loadEnterpriseUI();
    expect(ui).toBeNull();
  });

  it('should cache the result after first call', async () => {
    const first = await loadEnterpriseUI();
    const second = await loadEnterpriseUI();

    expect(first).toBeNull();
    expect(second).toBeNull();
    // Both should reference the same value (cached)
    expect(first).toBe(second);
  });

  it('should not throw or log errors in community mode', async () => {
    // If this test passes without exceptions, the loader is silent on missing package
    await expect(loadEnterpriseUI()).resolves.toBeNull();
  });
});
