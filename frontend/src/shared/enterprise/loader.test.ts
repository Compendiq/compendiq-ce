import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadEnterpriseUI,
  _resetForTesting,
  _setScriptLoaderForTesting,
  _setScriptInjectorForTesting,
} from './loader';

const BUNDLE_URL = '/api/enterprise/frontend.js';

/** Minimal fetch Response stand-in for the HEAD probe. */
function probeResponse(ok: boolean, contentType: string | null) {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
  };
}

describe('Enterprise frontend loader', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('should not throw when the bundle is unavailable', async () => {
    _setScriptLoaderForTesting(() => Promise.reject(new Error('404')));
    await expect(loadEnterpriseUI()).resolves.toBeNull();
  });

  it('warns once, naming the bundle URL, when loading fails (EE-only path)', async () => {
    // loadEnterpriseUI is license-gated to EE backends (context.tsx), so a
    // failure here means a real EE deployment lost its overlay — e.g. a proxy
    // stripping the bundle's content-type. That must not stay silent.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setScriptLoaderForTesting(() =>
      Promise.reject(new Error(`EE bundle not available at ${BUNDLE_URL}`)),
    );

    await expect(loadEnterpriseUI()).resolves.toBeNull();
    // Second call hits the cached null — no second warning.
    await expect(loadEnterpriseUI()).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain(BUNDLE_URL);
    warnSpy.mockRestore();
  });

  it('should return ui when bundle registers on window.__COMPENDIQ_UI__', async () => {
    const mockCard = () => null;
    _setScriptLoaderForTesting(async () => {
      // Simulate IIFE bundle: registers itself on window global
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__COMPENDIQ_UI__ = {
        LicenseStatusCard: mockCard,
        version: '1.0.0',
      };
    });

    const ui = await loadEnterpriseUI();
    expect(ui).not.toBeNull();
    expect(ui?.LicenseStatusCard).toBe(mockCard);
  });

  describe('HEAD probe (default loader)', () => {
    it('should not inject a script tag when the probe returns 404', async () => {
      const fetchMock = vi.fn().mockResolvedValue(probeResponse(false, 'application/json'));
      vi.stubGlobal('fetch', fetchMock);

      const ui = await loadEnterpriseUI();

      expect(ui).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(BUNDLE_URL, { method: 'HEAD' });
      expect(document.head.querySelector(`script[src="${BUNDLE_URL}"]`)).toBeNull();
    });

    it('should not reach the script injector when the probe returns a non-JS content type', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(probeResponse(true, 'application/json; charset=utf-8')),
      );
      const injector = vi.fn().mockResolvedValue(undefined);
      _setScriptInjectorForTesting(injector);

      const ui = await loadEnterpriseUI();

      expect(ui).toBeNull();
      expect(injector).not.toHaveBeenCalled();
      expect(document.head.querySelector(`script[src="${BUNDLE_URL}"]`)).toBeNull();
    });

    it('should proceed to script injection when the probe returns 200 with a JS content type', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(probeResponse(true, 'text/javascript; charset=utf-8')),
      );
      const mockCard = () => null;
      const injector = vi.fn().mockImplementation(async () => {
        // Simulate IIFE bundle: registers itself on window global
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__COMPENDIQ_UI__ = {
          LicenseStatusCard: mockCard,
          version: '1.0.0',
        };
      });
      _setScriptInjectorForTesting(injector);

      const ui = await loadEnterpriseUI();

      expect(injector).toHaveBeenCalledWith(BUNDLE_URL);
      expect(ui).not.toBeNull();
      expect(ui?.LicenseStatusCard).toBe(mockCard);
    });

    it('should resolve null when the probe itself rejects (network error)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));

      await expect(loadEnterpriseUI()).resolves.toBeNull();
      expect(document.head.querySelector(`script[src="${BUNDLE_URL}"]`)).toBeNull();
    });
  });
});
