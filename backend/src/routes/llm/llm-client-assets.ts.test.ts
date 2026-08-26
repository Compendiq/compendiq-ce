import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
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
});
