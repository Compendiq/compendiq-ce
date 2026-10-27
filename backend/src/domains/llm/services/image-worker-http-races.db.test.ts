import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { createProvider } from './llm-provider-service.js';
import { computeIdentityHash } from './image-analysis-provider.js';
import { runImageAnalysisBatch } from './image-analysis-worker.js';

const available = await isDbAvailable();
describe.skipIf(!available)('image worker HTTP publication races', () => {
  let redis: RedisClientType;
  let directory: string;
  let previousDirectory: string | undefined;
  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType;
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);
    previousDirectory = process.env.ATTACHMENTS_DIR;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-worker-http-'));
    process.env.ATTACHMENTS_DIR = directory;
  });
  beforeEach(async () => { await truncateAllTables(); await redis.flushDb(); });
  afterAll(async () => {
    await redis?.quit();
    if (previousDirectory === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousDirectory;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    await teardownTestDb();
  });

  it('records a batch containing only policy-blocked images without calling the provider', async () => {
    const baseUrl = 'http://blocked.test/v1';
    const provider = await createProvider({ name: randomUUID(), baseUrl, authType: 'none', verifySsl: true });
    const triple = { providerId: provider.id, model: 'vision', baseUrl };
    const identity = { ...triple, identityHash: computeIdentityHash(triple), assignedAt: new Date().toISOString() };
    const page = (await query(`INSERT INTO pages
      (title, source, ai_policy, image_analysis_dirty) VALUES ('blocked', 'standalone', 'none', FALSE) RETURNING id`)).rows[0];
    await query(`INSERT INTO page_image_analyses
      (page_id, source, attachment_key, content_hash, format, status)
      VALUES ($1, 'confluence', 'blocked.png', 'hash', 'png', 'pending')`, [page.id]);
    let calls = 0;
    const result = await runImageAnalysisBatch({ deps: {
      resolveIdentity: async () => identity, getRetainedIdentity: async () => identity,
      getVisionCapability: async () => true, getMaxOutputTokens: async () => 8192,
      analyzeImage: async () => { calls++; throw new Error('Forbidden dispatch'); },
    } });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ processed: 0, failed: 0, policyBlocked: 1, reconciledPages: 0 });
    const saved = (await query(`SELECT setting_value FROM admin_settings WHERE setting_key = 'image_analysis_last_run'`)).rows[0];
    expect(JSON.parse(saved.setting_value)).toMatchObject({ processed: 0, failed: 0, policyBlocked: 1 });
  });

  it.each(['allowed', 'none', 'local_only', 'endpoint'] as const)(
    're-admits retained payload reuse: %s', async (state) => {
      const baseUrl = 'http://retained.test/v1';
      const provider = await createProvider({ name: randomUUID(), baseUrl, authType: 'none', verifySsl: true });
      const triple = { providerId: provider.id, model: 'vision', baseUrl };
      const identity = { ...triple, identityHash: computeIdentityHash(triple), assignedAt: new Date().toISOString() };
      const page = (await query(`INSERT INTO pages
        (title, source, version, visibility, image_analysis_dirty, embedding_dirty, ai_policy)
        VALUES ('reuse', 'standalone', 1, 'shared', FALSE, FALSE, $1) RETURNING id`,
      [state === 'none' || state === 'local_only' ? state : 'all'])).rows[0];
      await query(`INSERT INTO page_image_analyses
        (page_id, source, attachment_key, content_hash, format, status, payload,
         provider_id, model, base_url, identity_hash, prompt_version, schema_version)
        VALUES ($1, 'confluence', 'kept.png', 'hash', 'png', 'pending', '{}'::jsonb,
                $2, $3, $4, $5, 1, 1)`,
      [page.id, provider.id, triple.model, baseUrl, identity.identityHash]);
      if (state === 'endpoint') await query("UPDATE llm_providers SET base_url = 'http://changed.test/v1' WHERE id = $1", [provider.id]);
      // Pause inference: the sweep must still authorize reuse, independently
      // of the assignment gate, without spending any outbound request.
      const result = await runImageAnalysisBatch({ deps: {
        resolveIdentity: async () => null, getRetainedIdentity: async () => identity,
        getMaxOutputTokens: async () => 8192,
      } });
      expect(result.reused).toBe(state === 'allowed' ? 1 : 0);
      expect(result.processed).toBe(0);
      const row = (await query(`SELECT a.status, p.embedding_dirty, p.image_analysis_revision
        FROM page_image_analyses a JOIN pages p ON p.id = a.page_id WHERE p.id = $1`, [page.id])).rows[0];
      expect(row.status).toBe(state === 'allowed' ? 'analyzed' : 'pending');
      expect(row.embedding_dirty).toBe(state === 'allowed');
      expect(Number(row.image_analysis_revision)).toBe(state === 'allowed' ? 1 : 0);
    },
  );

  it.each(['policy', 'content', 'provider', 'failure_successor', 'uniform_successor'] as const)(
    'preserves successor state after %s', async (change) => {
      let requests = 0;
      let handlerError: unknown;
      let mutate: () => Promise<void> = async () => {};
      const payload = { schemaVersion: 1, kind: 'screenshot', language: 'en',
        description: 'A database connection error is visible in the application.',
        visibleText: 'Connection refused', limitations: [] };
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          requests++;
          void mutate().then(() => {
            res.writeHead(change === 'uniform_successor' ? 400 : change === 'failure_successor' ? 500 : 200,
              { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] }));
          }).catch((err: unknown) => { handlerError = err; res.writeHead(500); res.end(); });
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
        const provider = await createProvider({ name: randomUUID(), baseUrl, authType: 'none', verifySsl: true });
        await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
          VALUES ('image_analysis', $1, 'vision') ON CONFLICT (usecase)
          DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`, [provider.id]);
        const triple = { providerId: provider.id, model: 'vision', baseUrl };
        const identity = { ...triple, identityHash: computeIdentityHash(triple), assignedAt: new Date().toISOString() };
        const page = (await query(`INSERT INTO pages (title, source, version, visibility, image_analysis_dirty)
          VALUES ('worker HTTP', 'standalone', 1, 'shared', FALSE) RETURNING id`)).rows[0];
        await fs.mkdir(path.join(directory, String(page.id)), { recursive: true });
        const ids: number[] = [];
        for (let i = 0; i < (change === 'uniform_successor' ? 3 : 1); i++) {
          const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 4, 0, 0, 0, 4]);
          const name = `${i}.png`;
          await fs.writeFile(path.join(directory, String(page.id), name), bytes);
          const image = (await query(`INSERT INTO page_image_analyses
            (page_id, source, attachment_key, content_hash, format, status, attempts)
            VALUES ($1, 'confluence', $2, $3, 'png', 'pending', 4) RETURNING id`,
          [page.id, name, createHash('sha256').update(bytes).digest('hex')])).rows[0];
          ids.push(image.id);
        }
        mutate = async () => {
          if (change === 'uniform_successor') {
            if (requests === 3) await query("UPDATE page_image_analyses SET error = 'successor' WHERE id = $1", [ids[0]]);
          } else if (change === 'failure_successor') {
            await query("UPDATE page_image_analyses SET status = 'failed_terminal', error = 'successor', attempts = 9 WHERE id = $1", [ids[0]]);
          } else if (change === 'provider') {
            await query("UPDATE llm_providers SET base_url = 'http://changed.test/v1' WHERE id = $1", [provider.id]);
          } else if (change === 'content') {
            await query('UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1', [page.id]);
          } else {
            await query("UPDATE pages SET ai_policy = 'none' WHERE id = $1", [page.id]);
          }
        };
        // Only assignment/vision-probe settings are supplied; policy admission,
        // queued transport, publication, PostgreSQL and Redis are all real.
        // In particular no enforcement-readiness hook is enabled.
        const result = await runImageAnalysisBatch({ deps: {
          resolveIdentity: async () => identity, getRetainedIdentity: async () => identity,
          getVisionCapability: async () => true, refreshVisionCapability: async () => undefined,
          getMaxOutputTokens: async () => 8192, getBatchSize: async () => 3,
        } });
        expect(handlerError).toBeUndefined();
        expect(requests).toBe(change === 'uniform_successor' ? 3 : 1);
        expect(result.processed).toBe(0);
        const rows = (await query('SELECT status, payload, error, attempts FROM page_image_analyses WHERE page_id = $1 ORDER BY id', [page.id])).rows;
        expect(rows.every((row) => row.payload === null)).toBe(true);
        if (change === 'uniform_successor') {
          expect(result).toMatchObject({ reason: 'uniform_rejection', failed: 3, terminal: 1 });
          expect(rows[0]).toMatchObject({ status: 'failed_terminal', error: 'successor', attempts: 5 });
          expect(rows.slice(1).every((row) => row.status === 'failed' && row.error === 'unavailable:400')).toBe(true);
        } else if (change === 'failure_successor') {
          expect(rows[0]).toMatchObject({ status: 'failed_terminal', error: 'successor', attempts: 9 });
          expect(result.failed).toBe(0);
        } else {
          expect(rows[0]).toMatchObject({ status: 'pending', error: null, attempts: 4 });
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
