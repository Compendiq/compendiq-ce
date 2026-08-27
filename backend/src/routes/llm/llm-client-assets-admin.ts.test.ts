import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { llmClientAssetAdminRoutes } from './llm-client-assets-admin.js';

vi.mock('../../core/services/client-model-hub.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/client-model-hub.js')>();
  return {
    ...actual,
    inspectClientModel: vi.fn(async (repo: string) => ({
      repo,
      hasQ4: true,
      bytes: 100,
      ok: true,
    })),
    installClientModel: vi.fn(async () => {}),
    getClientModelInstallStatus: vi.fn(() => ({
      status: 'complete' as const,
      repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
      loaded: 100,
      total: 100,
      error: null,
    })),
  };
});
import { inspectClientModel, installClientModel } from '../../core/services/client-model-hub.js';
describe('admin client-asset routes', () => {
  const app = Fastify({ logger: false });
  let tmp: string;
  let originalAssetsDir: string | undefined;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'client-assets-admin-'));
    originalAssetsDir = process.env.CLIENT_MODEL_ASSETS_DIR;
    process.env.CLIENT_MODEL_ASSETS_DIR = tmp;
    await app.register(sensible);
    app.decorate('requireAdmin', async () => {});
    await app.register(llmClientAssetAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (originalAssetsDir === undefined) delete process.env.CLIENT_MODEL_ASSETS_DIR;
    else process.env.CLIENT_MODEL_ASSETS_DIR = originalAssetsDir;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.mocked(installClientModel).mockClear();
    vi.mocked(inspectClientModel).mockClear();
    for (const ent of await fs.readdir(tmp).catch(() => [])) {
      await fs.rm(path.join(tmp, ent), { recursive: true, force: true });
    }
  });

  it('returns recommended models without a query', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/client-assets/search' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { models: Array<{ repo: string; recommended: boolean }> };
    expect(body.models.some((m) => m.repo === 'onnx-community/Qwen2.5-0.5B-Instruct' && m.recommended)).toBe(true);
  });

  it('inspects a repo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/client-assets/inspect?repo=onnx-community/Qwen2.5-0.5B-Instruct',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, hasQ4: true });
    expect(inspectClientModel).toHaveBeenCalled();
  });

  it('starts a Hub install', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/client-assets/install',
      payload: { repo: 'onnx-community/Qwen2.5-0.5B-Instruct' },
    });
    expect(res.statusCode).toBe(202);
    expect(installClientModel).toHaveBeenCalled();
  });

  it('uploads a Hunspell dictionary', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/client-assets/hunspell-en_US/files/en_US.dic',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('DIC'),
    });
    expect(res.statusCode).toBe(200);
    expect(await fs.readFile(path.join(tmp, 'hunspell-en_US', 'en_US.dic'), 'utf8')).toBe('DIC');
  });

  it('accepts RFC Content-Range from the upload UI', async () => {
    const body = Buffer.from('DIC');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/client-assets/hunspell-en_US/files/en_US.dic',
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${body.length - 1}/${body.length}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(await fs.readFile(path.join(tmp, 'hunspell-en_US', 'en_US.dic'), 'utf8')).toBe('DIC');
  });
});

describe('admin client-asset routes require admin', () => {
  const app = Fastify({ logger: false });

  beforeAll(async () => {
    await app.register(sensible);
    app.decorate('requireAdmin', async (_req, reply) => {
      return reply.code(403).send({ error: 'Forbidden', statusCode: 403 });
    });
    await app.register(llmClientAssetAdminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => app.close());

  it('rejects a non-admin search', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/client-assets/search' });
    expect(res.statusCode).toBe(403);
  });
});
