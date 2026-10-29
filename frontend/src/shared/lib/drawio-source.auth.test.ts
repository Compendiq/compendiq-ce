import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth-store';
import { RefreshUnavailableError } from './api';
import { loadDrawioSource } from './drawio-source';

const nativeFetch = globalThis.fetch;
const user = { id: 'diagram-user', username: 'diagram-user', role: 'user' as const };
const source = '/api/attachments/1/flow.drawio';
const preview = '/api/attachments/1/flow.png';

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.getState().clearAuth();
});

describe('draw.io loader authentication over local HTTP', () => {
  it.each(['network', 'proxy503', 'proxy502', 'success', 'busy'] as const)(
    'does not replay a logical refresh through the PNG candidate (%s)', async (mode) => {
      useAuthStore.getState().setAuth('retained-token', user);
      const requests: string[] = [];
      let rotations = 0;
      let refreshRequests = 0;
      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        if (request.url === '/api/auth/refresh') {
          refreshRequests++;
          if (mode === 'busy' && refreshRequests === 1) {
            response.writeHead(503, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ code: 'refresh_busy' }));
            return;
          }
          // The synthetic upstream has consumed the cookie before the response
          // fails; another refresh would replay it. No external service is used.
          rotations++;
          if (mode === 'network') { response.destroy(); return; }
          if (mode === 'proxy503' || mode === 'proxy502') {
            response.writeHead(mode === 'proxy503' ? 503 : 502);
            response.end('upstream response lost');
            return;
          }
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ accessToken: 'fresh-token', user }));
          return;
        }
        response.writeHead(401);
        response.end('unauthorized');
      });
      const listening = Promise.withResolvers<void>();
      server.once('error', listening.reject);
      server.listen(0, '127.0.0.1', listening.resolve);
      await listening.promise;
      try {
        const address = server.address() as { port: number };
        vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
          nativeFetch(`http://127.0.0.1:${address.port}${String(input)}`, init));
        const loading = loadDrawioSource({ sourceUrl: source, previewUrl: preview });
        if (mode === 'success' || mode === 'busy') {
          await expect(loading).rejects.toThrow('editable diagram source');
          expect(requests).toEqual([
            `GET ${source}`, 'POST /api/auth/refresh',
            ...(mode === 'busy' ? ['POST /api/auth/refresh'] : []),
            `GET ${source}`, `GET ${preview}`,
          ]);
          expect(useAuthStore.getState().accessToken).toBe('fresh-token');
        } else {
          await expect(loading).rejects.toBeInstanceOf(RefreshUnavailableError);
          expect(requests).toEqual([`GET ${source}`, 'POST /api/auth/refresh']);
          expect(useAuthStore.getState().accessToken).toBe('retained-token');
        }
        expect(rotations).toBe(1);
        expect(useAuthStore.getState().user).toEqual(user);
      } finally {
        server.closeAllConnections();
        const closed = Promise.withResolvers<void>();
        server.close((error) => error ? closed.reject(error) : closed.resolve());
        await closed.promise;
      }
    },
  );
});
