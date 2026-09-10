import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

vi.mock('../../domains/llm/services/llm-queue.js', () => ({
  setLlmConcurrencyClusterWide: vi.fn().mockResolvedValue(undefined),
  setLlmMaxQueueDepthClusterWide: vi.fn().mockResolvedValue(undefined),
}));

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { adminRoutes } from './admin.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('PUT /admin/settings clientInferenceEnabled', () => {
  let app: FastifyInstance;
  let adminId = '';
  let tmp: string;
  let originalAssetsDir: string | undefined;

  beforeAll(async () => {
    await setupTestDb();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'client-inf-flag-'));
    originalAssetsDir = process.env.CLIENT_MODEL_ASSETS_DIR;
    process.env.CLIENT_MODEL_ASSETS_DIR = tmp;
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate(
      'requireAdmin',
      async (request: { userId: string; username: string; userRole: string }) => {
        request.userId = adminId;
        request.username = 'client_inf_admin';
        request.userRole = 'admin';
      },
    );
    await app.register(adminRoutes, { prefix: '/api' });
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
    const r = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('client_inf_admin', 'fakehash', 'admin') RETURNING id`,
    );
    adminId = r.rows[0]!.id;
    for (const ent of await fs.readdir(tmp).catch(() => [])) {
      await fs.rm(path.join(tmp, ent), { recursive: true, force: true });
    }
  });

  it('rejects enabling on-device suggestions when ONNX is missing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { clientInferenceEnabled: true },
    });
    expect(res.statusCode).toBe(422);
  });

  it('allows enabling after required ONNX files are on the volume', async () => {
    const id = 'onnx-community--Qwen2.5-0.5B-Instruct';
    await fs.mkdir(path.join(tmp, id, 'onnx'), { recursive: true });
    await fs.writeFile(path.join(tmp, id, 'config.json'), '{}');
    await fs.writeFile(path.join(tmp, id, 'tokenizer.json'), '{}');
    await fs.writeFile(path.join(tmp, id, 'onnx/model_q4.onnx'), 'ONNX');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      payload: { clientInferenceEnabled: true },
    });
    expect(res.statusCode).toBe(200);
  });
});
