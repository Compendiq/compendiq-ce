import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import compress from '@fastify/compress';
import sensible from '@fastify/sensible';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { setClientModelAssetPolicy } from '../../core/services/client-model-asset-policy.js';
import { llmClientAssetRoutes } from './llm-client-assets.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('GET /api/models/client-assets (#1418)', () => {
  const app = Fastify({ logger: false });
  let tmp: string;
  let canQuery = true;
  let originalAssetsDir: string | undefined;

  beforeAll(async () => {
    await setupTestDb();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'client-assets-route-'));
    originalAssetsDir = process.env.CLIENT_MODEL_ASSETS_DIR;
    process.env.CLIENT_MODEL_ASSETS_DIR = tmp;

    await app.register(sensible);
    app.decorate('authenticate', async () => {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = '00000000-0000-4000-8000-000000000141';
      request.userCan = async () => canQuery;
    });
    await app.register(llmClientAssetRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalAssetsDir === undefined) delete process.env.CLIENT_MODEL_ASSETS_DIR;
    else process.env.CLIENT_MODEL_ASSETS_DIR = originalAssetsDir;
    await fs.rm(tmp, { recursive: true, force: true });
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    canQuery = true;
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('client_inference_enabled', 'false', NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'false'`,
    );
    for (const name of await fs.readdir(tmp)) {
      await fs.rm(path.join(tmp, name), { recursive: true, force: true });
    }
  });

  async function writeAsset(modelId: string, file: string, body: string | Buffer): Promise<void> {
    const abs = path.join(tmp, modelId, file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }

  it('returns an empty hunspell-available manifest when the directory is missing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/models/client-assets' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.enabled).toBe(false);
    const onnx = body.models.find((m: { kind: string }) => m.kind === 'onnx');
    const hunspell = body.models.filter((m: { kind: string }) => m.kind === 'hunspell');
    expect(onnx.available).toBe(false);
    expect(hunspell.length).toBe(2);
    expect(hunspell.every((m: { available: boolean }) => m.available)).toBe(true);
  });

  it('404s ONNX while the admin flag is off and still serves Hunspell', async () => {
    await writeAsset('qwen2.5-0.5b-instruct-q4', 'onnx/model_q4.onnx', 'ONNXBYTES');
    await writeAsset('hunspell-en_US', 'en_US.dic', 'DICBYTES');
    const onnxOff = await app.inject({
      method: 'GET',
      url: '/api/models/client-assets/qwen2.5-0.5b-instruct-q4/onnx/model_q4.onnx',
    });
    expect(onnxOff.statusCode).toBe(404);
    const hunspell = await app.inject({
      method: 'GET',
      url: '/api/models/client-assets/hunspell-en_US/en_US.dic',
    });
    expect(hunspell.statusCode).toBe(200);
    expect(hunspell.body).toBe('DICBYTES');

    await query(
      `UPDATE admin_settings SET setting_value = 'true' WHERE setting_key = 'client_inference_enabled'`,
    );
    const onnxOn = await app.inject({
      method: 'GET',
      url: '/api/models/client-assets/qwen2.5-0.5b-instruct-q4/onnx/model_q4.onnx',
    });
    expect(onnxOn.statusCode).toBe(200);
    expect(onnxOn.body).toBe('ONNXBYTES');
  });

  it('streams an allow-listed file with a revalidatable ETag, not immutable', async () => {
    await writeAsset('hunspell-en_US', 'en_US.dic', 'DICBYTES');
    const response = await app.inject({
      method: 'GET',
      url: '/api/models/client-assets/hunspell-en_US/en_US.dic',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(response.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(response.headers['etag']).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(String(response.headers['cache-control'])).not.toMatch(/immutable/);
    expect(response.body).toBe('DICBYTES');

    const again = await app.inject({
      method: 'GET',
      url: '/api/models/client-assets/hunspell-en_US/en_US.dic',
      headers: { 'if-none-match': String(response.headers['etag']) },
    });
    expect(again.statusCode).toBe(304);
  });

  it('honours Range with 206', async () => {
    await writeAsset('hunspell-en_US', 'en_US.aff', 'ABCDEFGH');
    const response = await app.inject({
      method: 'GET',
      url: '/api/models/client-assets/hunspell-en_US/en_US.aff',
      headers: { range: 'bytes=2-5' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 2-5/8');
    expect(response.body).toBe('CDEF');
  });

  it('serves HEAD metadata without a body for a community asset', async () => {
    await writeAsset('hunspell-en_US', 'en_US.aff', 'ABCDEFGH');
    const response = await app.inject({
      method: 'HEAD',
      url: '/api/models/client-assets/hunspell-en_US/en_US.aff',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe('8');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.body).toBe('');
  });

  it('404s a missing file', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/models/client-assets/hunspell-de_DE/de_DE.dic',
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s traversal', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/models/client-assets/qwen2.5-0.5b-instruct-q4/..%2F..%2Fetc%2Fpasswd',
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s a reserved attachment-root name used as a modelId', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/models/client-assets/page-icons/mark.png',
    });
    expect(response.statusCode).toBe(404);
  });

  it('does not register an upload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/models/client-assets',
      payload: { file: 'nope' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires llm:query', async () => {
    canQuery = false;
    const response = await app.inject({ method: 'GET', url: '/api/models/client-assets' });
    expect(response.statusCode).toBe(403);
    const download = await app.inject({
      method: 'GET', url: '/api/models/client-assets/hunspell-en_US/en_US.aff',
    });
    expect(download.statusCode).toBe(403);
  });
});

describe('GET /api/models/client-assets unauthenticated (#1418 SPEC-045)', () => {
  const app = Fastify({ logger: false });

  beforeAll(async () => {
    app.decorate('authenticate', async (_request, reply) => {
      return reply.code(401).send({ error: 'Unauthorized', statusCode: 401 });
    });
    await app.register(llmClientAssetRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => app.close());

  it('does not 200 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/models/client-assets' });
    expect(response.statusCode).toBe(401);
  });

  it('requires authentication on HEAD file requests too', async () => {
    const response = await app.inject({
      method: 'HEAD', url: '/api/models/client-assets/hunspell-en_US/en_US.aff',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('verified client-asset lifetime (#1793)', () => {
  const app = Fastify({ logger: false });
  const url = '/api/models/client-assets/hunspell-en_US/en_US.dic';
  const BODY = ['AAAA', 'BBBB', 'CCCC'];
  const SIZE = BODY.join('').length;
  let events: string[];
  let mode: 'delayed' | 'error' | 'throw';
  let unregister: () => void;
  let base: string;

  const count = (event: string) => events.filter((e) => e === event).length;

  beforeAll(async () => {
    await app.register(sensible);
    // Production registers compression globally (app.ts); this route opts out.
    await app.register(compress, { threshold: 4096 });
    app.decorate('authenticate', async () => {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = '00000000-0000-4000-8000-000000001793';
      request.userCan = async () => true;
    });
    await app.register(llmClientAssetRoutes, { prefix: '/api' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    events = [];
    mode = 'delayed';
    unregister = setClientModelAssetPolicy({
      beforeHubRequest: async () => {},
      listAssets: async () => [],
      resolveFile: async () => ({
        size: SIZE,
        etag: '"verified"',
        async stream(range?: { start: number; end: number }) {
          if (mode === 'throw') throw new Error('verified stream unavailable');
          events.push(range ? `stream:${range.start}-${range.end}` : 'stream');
          const chunks = range ? [BODY.join('').slice(range.start, range.end + 1)] : BODY;
          let next = 0;
          // Real 20 ms gaps over a real socket: the bug is dispose running
          // before Fastify reads a body that is still being produced.
          const body = new Readable({
            read() {
              events.push(events.includes('dispose') ? 'read-after-dispose' : 'read');
              setTimeout(() => {
                if (mode === 'error' && next === 1) {
                  this.destroy(new Error('verified source failed'));
                  return;
                }
                this.push(next < chunks.length ? chunks[next++] : null);
              }, 20);
            },
          });
          body.once('close', () => events.push('closed'));
          return body;
        },
        async dispose() {
          events.push('dispose');
        },
      }),
    });
  });

  afterEach(() => unregister());

  // Both release triggers (response end and stream close) have fired once the
  // stream is closed and dispose ran; one more macrotask exposes a double call.
  async function settled(): Promise<void> {
    await vi.waitFor(() => {
      expect(count('dispose')).toBeGreaterThan(0);
      expect(count('closed')).toBe(1);
    }, { timeout: 2000 });
    await new Promise(setImmediate);
  }

  it('keeps the resource until a delayed body is fully sent', async () => {
    const response = await fetch(`${base}${url}`);
    expect(await response.text()).toBe(BODY.join(''));
    await settled();
    expect(events[0]).toBe('stream');
    expect(events.indexOf('dispose')).toBeGreaterThan(events.lastIndexOf('read'));
    expect(count('read')).toBeGreaterThanOrEqual(BODY.length);
    expect(count('read-after-dispose')).toBe(0);
    expect(count('dispose')).toBe(1);
  });

  it('releases once when the client disconnects mid-body', async () => {
    const disconnected = Promise.withResolvers<void>();
    const request = http.get(`${base}${url}`, (response) => {
      response.once('data', () => {
        request.destroy();
        disconnected.resolve();
      });
    });
    request.on('error', (err) => {
      if (!request.destroyed) disconnected.reject(err);
    });
    await disconnected.promise;
    await settled();
    expect(count('read')).toBeGreaterThan(0);
    // The body is destroyed before its resource is released.
    expect(events.indexOf('closed')).toBeLessThan(events.indexOf('dispose'));
    expect(count('dispose')).toBe(1);
  });

  it('keeps the resource for a delayed ranged body and serves it uncompressed', async () => {
    const response = await fetch(`${base}${url}`, { headers: { range: 'bytes=4-7', 'accept-encoding': 'gzip' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBe('4');
    expect(await response.text()).toBe('BBBB');
    await settled();
    expect(events[0]).toBe('stream:4-7');
    expect(events.indexOf('closed')).toBeLessThan(events.indexOf('dispose'));
    expect(count('dispose')).toBe(1);
  });

  it('releases once when the verified stream fails mid-body', async () => {
    mode = 'error';
    await fetch(`${base}${url}`).then((response) => response.text()).catch(() => undefined);
    await settled();
    expect(count('read')).toBeGreaterThan(0);
    expect(count('read-after-dispose')).toBe(0);
    expect(count('dispose')).toBe(1);
  });

  it('releases once when opening the verified stream fails', async () => {
    mode = 'throw';
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(500);
    expect(count('dispose')).toBe(1);
  });

  it.each([
    ['HEAD', { method: 'HEAD' as const, headers: {} }, 200, ''],
    ['HEAD with Range', { method: 'HEAD' as const, headers: { range: 'bytes=0-3' } }, 200, ''],
    ['304', { method: 'GET' as const, headers: { 'if-none-match': '"verified"' } }, 304, ''],
    ['416', { method: 'GET' as const, headers: { range: 'bytes=50-60' } }, 416, undefined],
  ])('releases %s immediately without opening the body', async (_name, request, status, body) => {
    const response = await app.inject({ ...request, url });
    expect(response.statusCode).toBe(status);
    if (body !== undefined) expect(response.body).toBe(body);
    if (request.method === 'HEAD') expect(response.headers['content-length']).toBe(String(SIZE));
    expect(events).toEqual(['dispose']);
  });
});
