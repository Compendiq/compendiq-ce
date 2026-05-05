import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  scanForPii,
  setPiiScanHook,
  _resetPiiScanHookForTests,
  type PiiScanResult,
} from './pii-scan-hook.js';

afterEach(() => {
  _resetPiiScanHookForTests();
});

describe('pii-scan-hook (CE noop + EE extension point)', () => {
  it('returns null when no hook is installed (CE mode)', async () => {
    const result = await scanForPii('some output with a@b.com', 'chat');
    expect(result).toBeNull();
  });

  it('delegates to the installed hook when present', async () => {
    const expected: PiiScanResult = {
      spans: [{ start: 0, end: 5, category: 'EMAIL', confidence: 1, source: 'regex' }],
      action: 'flag-only',
    };
    const hook = vi.fn().mockResolvedValue(expected);
    setPiiScanHook(hook);

    const result = await scanForPii('hello a@b.com', 'improve', { async: false });
    expect(result).toEqual(expected);
    expect(hook).toHaveBeenCalledWith('hello a@b.com', 'improve', { async: false });
  });

  it('fails open to null when the hook throws', async () => {
    const hook = vi.fn().mockRejectedValue(new Error('scanner exploded'));
    setPiiScanHook(hook);

    const result = await scanForPii('text', 'chat');
    expect(result).toBeNull();
  });

  it('setPiiScanHook(null) uninstalls', async () => {
    setPiiScanHook(vi.fn().mockResolvedValue({ spans: [], action: 'flag-only' }));
    setPiiScanHook(null);
    const result = await scanForPii('text', 'chat');
    expect(result).toBeNull();
  });
});
