import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiDecisionEvent } from '@compendiq/contracts';
const observations = vi.hoisted(() => ({ events: [] as AiDecisionEvent[] }));
vi.mock('../../../core/enterprise/ai-policy-hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/enterprise/ai-policy-hooks.js')>();
  return { ...actual, emitAiDecision: (event: AiDecisionEvent) => {
    observations.events.push(event);
    actual.emitAiDecision(event);
  } };
});
import { query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { captureEmbeddingArticle } from './embedding-article-stage.js';
import { nextExplicitEmbeddingAttempt, shadowEmbeddingAttempt } from './embedding-stage-operation.js';
import { runShadowBackfillJob } from './shadow-migration-service.js';

const available = await isDbAvailable();
describe.skipIf(!available)('durable shadow and explicit embedding attempts', () => {
  beforeAll(async () => {
    await setupTestDb();
    await query('ALTER TABLE page_embeddings ADD COLUMN IF NOT EXISTS embedding_next vector(1024)');
    await query('ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_avg_embedding_next vector(1024)');
  });
  beforeEach(truncateAllTables);
  afterAll(teardownTestDb);

  it('migrates idempotently, serializes concurrent allocations and survives reconstructed contexts', async () => {
    const sql = await readFile(new URL('../../../core/db/migrations/148_embedding_stage_attempts.sql', import.meta.url), 'utf8');
    await query(sql);
    await query(sql);
    const id = (await query("INSERT INTO pages (title, space_key, body_html) VALUES ('Title', 'DEV', '<p>Original</p>') RETURNING id")).rows[0].id;
    const article = await captureEmbeddingArticle(id, 'Title', 'DEV', '<p>Original</p>');
    const [one, two] = await Promise.all([shadowEmbeddingAttempt(id, 'epoch'), shadowEmbeddingAttempt(id, 'epoch')]);
    expect(one.operation).toEqual(two.operation);
    expect([one.attempt, two.attempt].sort()).toEqual([1, 2]);
    expect((await shadowEmbeddingAttempt(id, 'epoch')).attempt).toBe(3);
    const next = await shadowEmbeddingAttempt(id, 'next-epoch');
    expect(next.operation.operationId).not.toBe(one.operation.operationId);
    expect(next.attempt).toBe(1);
    const operation = { operationId: randomUUID(), actor: { kind: 'user' as const, id: randomUUID() }, source: 'explicit-embedding', cascadeId: null };
    expect(await nextExplicitEmbeddingAttempt(article, operation)).toBe(1);
    expect(await nextExplicitEmbeddingAttempt(article, structuredClone(operation))).toBe(2);
    expect((await Promise.all([nextExplicitEmbeddingAttempt(article, operation), nextExplicitEmbeddingAttempt(article, structuredClone(operation))])).sort()).toEqual([3, 4]);
    expect(await captureEmbeddingArticle(id, 'Title', 'DEV', '<p>Original</p>')).toEqual(article);
    await query('UPDATE pages SET image_analysis_revision = image_analysis_revision + 1 WHERE id = $1', [id]);
    expect((await shadowEmbeddingAttempt(id, 'next-epoch')).operation.operationId).not.toBe(next.operation.operationId);
  });

  it('retains explicit attempt numbering after hard deletion, including first capture of a missing page', async () => {
    const sql = await readFile(new URL('../../../core/db/migrations/149_embedding_attempt_identity_retention.sql', import.meta.url), 'utf8');
    await query(sql);
    await query(sql);
    const pageId = (await query("INSERT INTO pages (title) VALUES ('Removed') RETURNING id")).rows[0].id;
    const operation = { operationId: randomUUID(), actor: { kind: 'worker' as const, id: 'test' }, source: 'explicit-embedding', cascadeId: null };
    expect(await nextExplicitEmbeddingAttempt({ pageId }, operation)).toBe(1);
    await query('DELETE FROM pages WHERE id = $1', [pageId]);
    expect(await nextExplicitEmbeddingAttempt({ pageId }, structuredClone(operation))).toBe(2);
    const missingOperation = { ...operation, operationId: randomUUID() };
    expect(await nextExplicitEmbeddingAttempt({ pageId }, missingOperation)).toBe(1);
    expect(await nextExplicitEmbeddingAttempt({ pageId }, structuredClone(missingOperation))).toBe(2);
  });

  it('refuses later batches on a changed generation without replacing the in-flight operation', async () => {
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1) * 0.01);
    const pageId = (await query("INSERT INTO pages (title, space_key, body_html) VALUES ('Title', 'DEV', '<p>Original</p>') RETURNING id")).rows[0].id;
    const providerId = randomUUID();
    let requests = 0;
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requests++;
      // A real concurrent source edit after batch one was admitted. Batch two
      // must be a new authoritative refusal, not a silently abandoned job.
      await query('UPDATE pages SET image_analysis_revision = image_analysis_revision + 1 WHERE id = $1', [pageId]);
      const body = JSON.parse(raw) as { input: string[] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: vector })) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await query("INSERT INTO llm_providers (id, name, base_url, auth_type, default_model) VALUES ($1, 'shadow', $2, 'none', 'shadow-model')", [providerId, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`]);
      await query("INSERT INTO admin_settings (setting_key, setting_value) VALUES ('embedding_shadow_migration', $1)", [JSON.stringify({ status: 'active', providerId, model: 'shadow-model', dimensions: 1024, columnType: 'vector(1024)', indexed: false, startedAt: '2026-01-01' })]);
      for (let i = 0; i < 17; i++) {
        await query('INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding) VALUES ($1, $2, $3, $4)', [pageId, i, `chunk ${i}`, JSON.stringify(vector)]);
      }
      expect(await runShadowBackfillJob()).toEqual({ processed: 0, failed: 0, blocked: 1 });
      expect(requests).toBe(1);
      const job = (await query('SELECT operation_id FROM shadow_embedding_ai_operations WHERE page_id = $1', [pageId])).rows[0];
      expect((await query('SELECT operation_id, attempt FROM explicit_embedding_ai_attempts WHERE page_id = $1', [pageId])).rows).toEqual([{ operation_id: job.operation_id, attempt: 2 }]);
      const events = observations.events.filter((event) => event.operationId === job.operation_id);
      expect(events.map((event) => [event.attempt, event.decision])).toEqual([[1, 'admitted'], [2, 'blocked']]);
      expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
      expect(events.every((event) => event.stage === 'shadow_embedding' && event.actor.id === 'shadow-reembed')).toBe(true);
      expect((await query('SELECT COUNT(*)::int AS n FROM page_embeddings WHERE page_id = $1 AND embedding_next IS NOT NULL', [pageId])).rows[0].n).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps vanished-provider, failed HTTP and recovered shadow passes under one operation', async () => {
    let requests = 0;
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i + 1) * 0.01);
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requests++;
      if (requests === 1) { res.writeHead(500); res.end(); return; }
      const body = JSON.parse(raw) as { input: string[] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: vector })) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const providerId = randomUUID();
      const pageId = (await query("INSERT INTO pages (title, space_key, body_html) VALUES ('Title', 'DEV', '<p>Saved article prose</p>') RETURNING id")).rows[0].id;
      await query("INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding) VALUES ($1, 0, 'Saved article prose', $2)", [pageId, JSON.stringify(vector)]);
      await query("INSERT INTO admin_settings (setting_key, setting_value) VALUES ('embedding_shadow_migration', $1)", [JSON.stringify({ status: 'active', providerId, model: 'shadow-model', dimensions: 1024, columnType: 'vector(1024)', indexed: false, startedAt: '2026-01-01' })]);
      expect(await runShadowBackfillJob()).toEqual({ processed: 0, failed: 0, blocked: 1 });
      const first = (await query('SELECT operation_id, attempt FROM shadow_embedding_ai_operations WHERE page_id = $1', [pageId])).rows[0];
      expect(first.attempt).toBe(1);
      expect(requests).toBe(0);
      await query("INSERT INTO llm_providers (id, name, base_url, auth_type, default_model) VALUES ($1, 'shadow', $2, 'none', 'shadow-model')", [providerId, `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`]);
      expect(await runShadowBackfillJob()).toEqual({ processed: 0, failed: 1 });
      expect(await runShadowBackfillJob()).toEqual({ processed: 1, failed: 0 });
      expect(requests).toBe(2);
      expect((await query('SELECT operation_id, attempt FROM shadow_embedding_ai_operations WHERE page_id = $1', [pageId])).rows[0]).toEqual({ operation_id: first.operation_id, attempt: 3 });
      expect((await query('SELECT embedding_next FROM page_embeddings WHERE page_id = $1', [pageId])).rows[0].embedding_next).not.toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
