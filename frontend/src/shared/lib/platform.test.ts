import { describe, it, expect, afterEach } from 'vitest';
import { isMac } from './platform';

describe('isMac', () => {
  afterEach(() => {
    // Clean up any overrides
    Object.defineProperty(navigator, 'userAgentData', {
      value: undefined,
      configurable: true,
    });
  });

  it('returns false in default jsdom environment (non-Mac)', () => {
    // jsdom has an empty/generic userAgent, not Mac
    expect(isMac()).toBe(false);
  });

  it('returns true when userAgentData.platform is macOS', () => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'macOS' },
      configurable: true,
    });
    expect(isMac()).toBe(true);
  });

  it('returns false when userAgentData.platform is Windows', () => {
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'Windows' },
      configurable: true,
    });
    expect(isMac()).toBe(false);
  });

  it('returns true when userAgent contains Mac', () => {
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });
    expect(isMac()).toBe(true);
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUA,
      configurable: true,
    });
  });

  it('returns true when userAgent contains iPhone', () => {
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0)',
      configurable: true,
    });
    expect(isMac()).toBe(true);
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUA,
      configurable: true,
    });
  });

  it('prefers userAgentData over userAgent when both are available', () => {
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });
    // userAgentData says Windows, so isMac should return false
    Object.defineProperty(navigator, 'userAgentData', {
      value: { platform: 'Windows' },
      configurable: true,
    });
    expect(isMac()).toBe(false);
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUA,
      configurable: true,
    });
  });
});
