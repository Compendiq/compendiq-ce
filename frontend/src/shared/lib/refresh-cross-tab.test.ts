import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type * as ApiModule from './api';
import type * as StoreModule from '../../stores/auth-store';

/**
 * Two same-origin tabs sharing one HttpOnly refresh cookie against a server
 * with the backend's strict single-use policy: presenting an already-rotated
 * cookie is reuse and revokes the whole family (logging every tab out).
 */

const USER = { id: 'u1', username: 'alice', role: 'user' as const };

function jwt(serial: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, serial }));
  return `${btoa('{"alg":"HS256"}')}.${payload}.sig`;
}

interface FakeServer {
  state: { cookie: string | null; inFlight: number; maxInFlight: number; reuse: number };
  live: Set<string>;
  familyOf: Map<string, string>;
  fetchImpl: (input: RequestInfo | URL) => Promise<Response>;
}

function createServer(): FakeServer {
  let serial = 0;
  const familyOf = new Map<string, string>([['c0', 'original']]);
  const live = new Set(['c0']);
  const consumed = new Set<string>();
  const state = { cookie: 'c0' as string | null, inFlight: 0, maxInFlight: 0, reuse: 0 };

  function mint(family: string): Response {
    serial += 1;
    const next = `c${serial}`;
    familyOf.set(next, family);
    live.add(next);
    // Set-Cookie is applied when the response arrives.
    state.cookie = next;
    return new Response(JSON.stringify({ accessToken: jwt(serial), user: USER }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    // The browser attaches the cookie it holds when the request is sent.
    const presented = state.cookie;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    // Real network latency lets a concurrent request from the other tab start.
    const latency = Promise.withResolvers<void>();
    setTimeout(latency.resolve, 5);
    await latency.promise;
    state.inFlight -= 1;

    if (url === '/api/auth/login') return mint(`login-${serial}`);
    if (url === '/api/auth/refresh') {
      if (presented && live.delete(presented)) {
        consumed.add(presented);
        return mint(familyOf.get(presented)!);
      }
      if (presented && consumed.has(presented)) {
        state.reuse += 1;
        const family = familyOf.get(presented);
        for (const cookie of [...live]) if (familyOf.get(cookie) === family) live.delete(cookie);
      }
      return new Response(null, { status: 401 });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  return { state, live, familyOf, fetchImpl };
}

/**
 * A tab is its own module graph (store, BroadcastChannel, refresh
 * single-flight). Dynamic import after resetModules is the only way to get a
 * second, independent instance in one test process.
 */
async function openTab(): Promise<{ api: typeof ApiModule; store: typeof StoreModule }> {
  vi.resetModules();
  const api = await import('./api');
  const store = await import('../../stores/auth-store');
  return { api, store };
}

function createFakeWebLocks() {
  let tail = Promise.resolve();
  return {
    request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
      const run = tail.then(callback);
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}

const lockBackends = [
  {
    name: 'Web Locks (secure context)',
    install: () => {
      Object.defineProperty(navigator, 'locks', { value: createFakeWebLocks(), configurable: true });
    },
  },
  {
    name: 'IndexedDB lease (no Web Locks, plain HTTP)',
    install: () => {
      vi.stubGlobal('indexedDB', new IDBFactory());
    },
  },
];

describe.each(lockBackends)('cross-tab refresh-cookie serialization with $name', ({ install }) => {
  let server: FakeServer;

  beforeEach(() => {
    localStorage.clear();
    install();
    server = createServer();
    vi.stubGlobal('fetch', vi.fn(server.fetchImpl));
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('keeps both tabs signed in when they refresh simultaneously, cycle after cycle', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    tabA.store.useAuthStore.getState().setAuth('expired-a', USER);
    tabB.store.useAuthStore.getState().setAuth('expired-b', USER);

    for (let cycle = 0; cycle < 5; cycle++) {
      const [a, b] = await Promise.all([
        tabA.api.refreshAccessTokenOnce(),
        tabB.api.refreshAccessTokenOnce(),
      ]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    }

    expect(server.state.reuse).toBe(0);
    expect(server.state.maxInFlight).toBe(1);
    // Exactly one usable refresh token remains, and it is the browser's.
    expect([...server.live]).toEqual([server.state.cookie]);
    expect(tabA.store.useAuthStore.getState().isAuthenticated).toBe(true);
    expect(tabB.store.useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('lets a freshly loaded tab refresh while another tab is mid-refresh without reuse', async () => {
    const tabA = await openTab();
    tabA.store.useAuthStore.getState().setAuth('expired-a', USER);
    const inFlight = tabA.api.refreshAccessTokenOnce();

    // A reloaded document starts with no in-memory token (useSessionInit).
    const reloaded = await openTab();
    const restored = await reloaded.api.refreshAccessTokenOnce();

    expect(await inFlight).not.toBeNull();
    expect(restored).not.toBeNull();
    expect(server.state.reuse).toBe(0);
    expect([...server.live]).toEqual([server.state.cookie]);
  });

  it('does not let a refresh in one tab overwrite the cookie a login in another tab just set', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    tabA.store.useAuthStore.getState().setAuth('expired-a', USER);

    await Promise.all([
      tabA.api.refreshAccessTokenOnce(),
      tabB.api.apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'alice', password: 'pw' }),
      }),
    ]);

    expect(server.state.maxInFlight).toBe(1);
    expect(server.state.reuse).toBe(0);
    expect(server.familyOf.get(server.state.cookie!)).toMatch(/^login-/);
    expect(server.live.has(server.state.cookie!)).toBe(true);
  });
});
