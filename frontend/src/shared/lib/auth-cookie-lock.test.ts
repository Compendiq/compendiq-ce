import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createAuthCookieLock } from './auth-cookie-lock';

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Writes a lease record exactly as a tab that died while holding it would leave it. */
async function writeLease(factory: IDBFactory, lease: { owner: string; expiresAt: number }): Promise<void> {
  const open = factory.open('compendiq-auth-cookie-lock', 1);
  const opened = Promise.withResolvers<IDBDatabase>();
  open.onupgradeneeded = () => open.result.createObjectStore('lease');
  open.onsuccess = () => opened.resolve(open.result);
  open.onerror = () => opened.reject(open.error);
  const db = await opened.promise;
  const tx = db.transaction('lease', 'readwrite');
  const done = Promise.withResolvers<void>();
  tx.objectStore('lease').put(lease, 'holder');
  tx.oncomplete = () => done.resolve();
  tx.onerror = () => done.reject(tx.error);
  await done.promise;
  db.close();
}

// Web Locks only exist in secure contexts; these cover the plain-HTTP
// fallback. Each createAuthCookieLock() instance stands in for one tab, and a
// shared IDBFactory is the origin's IndexedDB they all see. Real timers on
// purpose: fake-indexeddb commits transactions on real macrotasks and the
// lease expiry compares against the wall clock, so fake timers would stall it.
describe('auth-cookie lock without Web Locks (IndexedDB lease)', () => {
  it('never lets holders from different tabs overlap', async () => {
    const origin = new IDBFactory();
    const tabs = [
      createAuthCookieLock({ locks: null, indexedDB: origin }),
      createAuthCookieLock({ locks: null, indexedDB: origin }),
    ];
    let active = 0;
    let maxActive = 0;
    const completed: string[] = [];

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        tabs[i % 2]!(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(10);
          active -= 1;
          completed.push(`work-${i}`);
        }),
      ),
    );

    expect(maxActive).toBe(1);
    expect(completed).toHaveLength(6);
  });

  it('waits out a lease left by a tab that died holding it, then proceeds', async () => {
    const origin = new IDBFactory();
    const expiresAt = Date.now() + 300;
    await writeLease(origin, { owner: 'closed-tab', expiresAt });
    const tab = createAuthCookieLock({ locks: null, indexedDB: origin });

    const startedAt = await tab(async () => Date.now());

    expect(startedAt).toBeGreaterThanOrEqual(expiresAt);
  });

  it('releases the lease when the work fails', async () => {
    const origin = new IDBFactory();
    const tabA = createAuthCookieLock({ locks: null, indexedDB: origin });
    const tabB = createAuthCookieLock({ locks: null, indexedDB: origin });

    await expect(tabA(async () => {
      throw new Error('network down');
    })).rejects.toThrow('network down');

    const startedAt = Date.now();
    await tabB(async () => undefined);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('does not block authentication when IndexedDB cannot be opened', async () => {
    const broken = {
      open: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    } as unknown as IDBFactory;
    const tab = createAuthCookieLock({ locks: null, indexedDB: broken });

    await expect(tab(async () => 'refreshed')).resolves.toBe('refreshed');
  });
});
