import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadEnterpriseUI,
  _resetForTesting,
  _setScriptLoaderForTesting,
} from './loader';

describe('Enterprise frontend loader', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('should return null when /api/enterprise/frontend.js is not available', async () => {
    _setScriptLoaderForTesting(() => Promise.reject(new Error('404')));
    const ui = await loadEnterpriseUI();
    expect(ui).toBeNull();
  });

  it('should cache the result after first call', async () => {
    _setScriptLoaderForTesting(() => Promise.reject(new Error('404')));
    const first = await loadEnterpriseUI();
    const second = await loadEnterpriseUI();

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(first).toBe(second);
  });

  it('should not throw or log errors in community mode', async () => {
    _setScriptLoaderForTesting(() => Promise.reject(new Error('404')));
    await expect(loadEnterpriseUI()).resolves.toBeNull();
  });

  it('should return ui when bundle registers on window.__COMPENDIQ_UI__', async () => {
    const mockCard = () => null;
    _setScriptLoaderForTesting(async () => {
      // Simulate IIFE bundle: registers itself on window global
      (window as any).__COMPENDIQ_UI__ = {
        LicenseStatusCard: mockCard,
        version: '1.0.0',
      };
    });

    const ui = await loadEnterpriseUI();
    expect(ui).not.toBeNull();
    expect(ui?.LicenseStatusCard).toBe(mockCard);
  });
});
