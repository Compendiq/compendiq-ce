/**
 * Cross-tab mutex for every request that presents or replaces the HttpOnly
 * refresh cookie: refresh, login, registration, setup-admin, OIDC exchange
 * and logout.
 *
 * The backend treats refresh tokens as strictly single-use — a second request
 * presenting an already-rotated cookie is reuse and revokes the whole token
 * family. Tabs of one browser share that cookie, so two tabs refreshing at the
 * same moment would log the user out. Holding this lock across the request
 * guarantees each request presents the cookie the previous one left behind.
 *
 * - Secure contexts use the Web Locks API (released automatically when a tab
 *   closes or navigates).
 * - Web Locks only exist in secure contexts, so plain-HTTP deployments use an
 *   IndexedDB lease instead: a `readwrite` transaction is serialized across
 *   every tab of the origin, which makes the read-check-write below an atomic
 *   compare-and-set. The holder renews the lease while it works; a crashed
 *   tab's lease expires after LEASE_MS.
 * - If neither is available the request runs unserialized (the pre-lock
 *   behaviour).
 *
 * Callers MUST NOT request the lock again from inside `work` — it is not
 * re-entrant.
 */

const LOCK_NAME = 'compendiq-auth-cookie';
const DB_NAME = 'compendiq-auth-cookie-lock';
const STORE = 'lease';
const LEASE_KEY = 'holder';
const LEASE_MS = 20_000;
const RENEW_MS = 5_000;
const POLL_MS = 50;

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

interface Lease {
  owner: string;
  expiresAt: number;
}

export type AuthCookieLock = <T>(work: () => Promise<T>) => Promise<T>;

export interface AuthCookieLockOptions {
  /** Web Locks manager; `null` forces the fallback. Defaults to `navigator.locks`. */
  locks?: LockManagerLike | null;
  /** IndexedDB factory for the fallback. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory | null;
}

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return typeof locks?.request === 'function' ? locks : null;
}

function defaultIndexedDB(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    // Some privacy modes throw on access.
    return null;
  }
}

function newOwnerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openLeaseDb(factory: IDBFactory): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = factory.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORE);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

/**
 * One atomic read-modify-write of the lease record. `decide` returns the
 * record to store (`null` deletes, `undefined` leaves it) and the result;
 * the promise settles only once the transaction has committed. `async` so a
 * synchronous `transaction()` failure (closed connection) becomes a rejection.
 */
async function updateLease(
  db: IDBDatabase,
  decide: (current: Lease | undefined) => { next?: Lease | null; granted: boolean },
): Promise<boolean> {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  let granted = false;
  const read = store.get(LEASE_KEY);
  read.onsuccess = () => {
    const decision = decide(read.result as Lease | undefined);
    granted = decision.granted;
    if (decision.next === null) store.delete(LEASE_KEY);
    else if (decision.next) store.put(decision.next, LEASE_KEY);
  };
  tx.oncomplete = () => resolve(granted);
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error('Lease transaction aborted'));
  return promise;
}

function createIndexedDbLock(factory: IDBFactory): AuthCookieLock {
  let database: Promise<IDBDatabase> | null = null;

  return async <T>(work: () => Promise<T>): Promise<T> => {
    const owner = newOwnerId();
    let db: IDBDatabase;
    try {
      database ??= openLeaseDb(factory);
      db = await database;
      while (
        !(await updateLease(db, (current) =>
          !current || current.expiresAt <= Date.now()
            ? { next: { owner, expiresAt: Date.now() + LEASE_MS }, granted: true }
            : { granted: false },
        ))
      ) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, POLL_MS);
        await promise;
      }
    } catch {
      // IndexedDB is unusable (quota, privacy mode, blocked open): run
      // unserialized rather than blocking authentication.
      database = null;
      return work();
    }

    const ownLease = (next: Lease | null) => (current: Lease | undefined) =>
      current?.owner === owner ? { next, granted: true } : { granted: false };
    const renew = setInterval(() => {
      updateLease(db, ownLease({ owner, expiresAt: Date.now() + LEASE_MS })).catch(() => {});
    }, RENEW_MS);
    try {
      return await work();
    } finally {
      clearInterval(renew);
      await updateLease(db, ownLease(null)).catch(() => {});
    }
  };
}

export function createAuthCookieLock(options: AuthCookieLockOptions = {}): AuthCookieLock {
  const locks = options.locks !== undefined ? options.locks : defaultLocks();
  if (locks) return (work) => locks.request(LOCK_NAME, work);
  const factory = options.indexedDB !== undefined ? options.indexedDB : defaultIndexedDB();
  if (factory) return createIndexedDbLock(factory);
  return (work) => work();
}

let defaultLock: AuthCookieLock | null = null;

/** Runs `work` while holding the browser-wide auth-cookie lock. */
export function withAuthCookieLock<T>(work: () => Promise<T>): Promise<T> {
  defaultLock ??= createAuthCookieLock();
  return defaultLock(work);
}
