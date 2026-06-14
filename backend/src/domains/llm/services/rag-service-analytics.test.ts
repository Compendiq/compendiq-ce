import { describe, it, expect, vi, beforeEach } from 'vitest';

// Root-cause regression test for #805: search-analytics writes are fired
// without await from the search path, so a late INSERT can race a test's
// TRUNCATE and deadlock. The fix tracks in-flight writes so callers can drain
// them via flushSearchAnalytics(). This proves the drain semantics
// deterministically (the production flake is CI-load-dependent and doesn't
// reproduce locally), by controlling the INSERT's completion timing.

const queryMock = vi.fn();
vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  getVectorPool: vi.fn(),
  getPool: vi.fn(),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
  checkConnection: vi.fn(),
}));

const { trackSearchAnalytics, flushSearchAnalytics } = await import('./rag-service.js');

describe('search-analytics flush (#805)', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('flushSearchAnalytics() does not resolve until the in-flight write settles', async () => {
    // Make the analytics INSERT hang until we explicitly release it.
    let release!: () => void;
    queryMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ rows: [] });
      }),
    );

    trackSearchAnalytics('user-1', 'q', 0, null, 'hybrid'); // fire-and-forget; query() now pending

    let flushed = false;
    const flushP = flushSearchAnalytics().then(() => {
      flushed = true;
    });

    // Let microtasks run — flush must still be blocked on the pending INSERT.
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);

    release(); // INSERT completes
    await flushP;
    expect(flushed).toBe(true); // flush resolved only after the write settled
  });

  it('flushSearchAnalytics() resolves immediately when nothing is in flight', async () => {
    await expect(flushSearchAnalytics()).resolves.toBeUndefined();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
