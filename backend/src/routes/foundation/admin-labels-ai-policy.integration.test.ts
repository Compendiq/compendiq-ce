import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { AI_POLICY_RESERVED_LABEL } from '@compendiq/contracts';

// admin.ts imports the cluster-wide LLM queue setters (Redis cache-bus).
// They are not under test here — keep Redis out of this suite.
vi.mock('../../domains/llm/services/llm-queue.js', () => ({
  setLlmConcurrencyClusterWide: vi.fn().mockResolvedValue(undefined),
  setLlmMaxQueueDepthClusterWide: vi.fn().mockResolvedValue(undefined),
}));

import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { adminRoutes } from './admin.js';

/**
 * #1881 design §2.5 (gap G1): the global label rename/delete must never move
 * a reserved article-AI-policy label. Refusal is a pure name check before any
 * lock or write, in both switch states (the switch is left at its seeded
 * `disabled`; nothing here reads it).
 */

const available = await isDbAvailable();

/** Every synonym in `AI_POLICY_LABEL_SYNONYMS`, plus the case/whitespace forms the normalizer folds. */
const RESERVED_SPELLINGS = [
  'all-ai', 'ai:all',
  'local-ai-only', 'local_only', 'ai:local',
  'no-ai', 'no_ai', 'ai:none',
  'No-AI', 'AI:LOCAL', 'LOCAL_ONLY', 'All-AI',
  ' no-ai ', '\tall-ai\t', '\u00a0ai:local\u00a0',
];

describe.skipIf(!available)('global label rename/delete refuses reserved AI-policy labels (#1881 G1)', () => {
  let app: FastifyInstance;
  let actorId: string;

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('requireAdmin', async (request: { userId: string; userRole: string }) => {
      request.userId = actorId;
      request.userRole = 'admin';
    });
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      reply.status(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({ error: error.message });
    });
    await app.register(adminRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const actor = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('label-admin', 'x', 'admin') RETURNING id",
    );
    actorId = actor.rows[0]!.id;
    await seedPage('Reviewed', ['review', 'keep']);
    await seedPage('Also reviewed', ['review']);
    // A stored restriction carrying its canonical label: the row G1 would
    // have stripped. Seeded before any runtime registers in this process.
    await seedPage('Restricted', ['no-ai', 'keep']);
  });

  async function seedPage(title: string, labels: string[]): Promise<number> {
    const row = await query<{ id: number }>(
      `INSERT INTO pages (source, title, body_html, body_storage, body_text, labels, created_by_user_id, visibility)
       VALUES ('standalone', $1, '<p>Body</p>', '', 'Body', $2, $3, 'shared') RETURNING id`,
      [title, labels, actorId],
    );
    return row.rows[0]!.id;
  }

  async function labels(): Promise<string[][]> {
    const rows = await query<{ labels: string[] }>('SELECT labels FROM pages ORDER BY id');
    return rows.rows.map((row) => row.labels);
  }

  async function labelAuditRows(): Promise<number> {
    const result = await query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'ADMIN_ACTION' AND resource_type = 'label'",
    );
    return result.rows[0]!.n;
  }

  function rename(oldName: string, newName: string) {
    return app.inject({ method: 'PUT', url: '/api/admin/labels/rename', payload: { oldName, newName } });
  }

  function remove(name: string) {
    return app.inject({ method: 'DELETE', url: `/api/admin/labels/${encodeURIComponent(name)}` });
  }

  const SEEDED = [['review', 'keep'], ['review'], ['no-ai', 'keep']];

  it.each(RESERVED_SPELLINGS)('refuses renaming an ordinary label to %j and writes nothing', async (reserved) => {
    const response = await rename('review', reserved);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toEqual({ error: AI_POLICY_RESERVED_LABEL, message: expect.any(String) });
    expect(await labels()).toEqual(SEEDED);
    expect(await labelAuditRows()).toBe(0);
  });

  it.each(RESERVED_SPELLINGS)('refuses renaming %j away, whether or not a page carries it', async (reserved) => {
    const response = await rename(reserved, 'approved');
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error).toBe(AI_POLICY_RESERVED_LABEL);
    expect(await labels()).toEqual(SEEDED);
    expect(await labelAuditRows()).toBe(0);
  });

  it.each(RESERVED_SPELLINGS)('refuses deleting %j globally and keeps the stored canonical label', async (reserved) => {
    const response = await remove(reserved);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error).toBe(AI_POLICY_RESERVED_LABEL);
    expect(await labels()).toEqual(SEEDED);
    expect(await labelAuditRows()).toBe(0);
  });

  it('refuses a reserved label on either side of a rename between two reserved spellings', async () => {
    const response = await rename('no-ai', 'ai:none');
    expect(response.statusCode, response.body).toBe(409);
    expect(await labels()).toEqual(SEEDED);
  });

  it('refuses the same way while enforcement is on, and ordinary renames still succeed there', async () => {
    await query('UPDATE ai_policy_activation_state SET enabled = TRUE WHERE singleton');
    const refused = await rename('review', 'ai:none');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe(AI_POLICY_RESERVED_LABEL);
    expect(await labels()).toEqual(SEEDED);

    const renamed = await rename('review', 'approved');
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(await labels()).toEqual([['approved', 'keep'], ['approved'], ['no-ai', 'keep']]);
  });

  it('leaves ordinary renames and deletes unchanged, including names that merely resemble a reserved label', async () => {
    const renamed = await rename('review', 'approved');
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().affectedPages).toBe(2);
    expect(await labels()).toEqual([['approved', 'keep'], ['approved'], ['no-ai', 'keep']]);

    const lookalike = await rename('approved', 'no-ai-review');
    expect(lookalike.statusCode, lookalike.body).toBe(200);
    expect(await labels()).toEqual([['no-ai-review', 'keep'], ['no-ai-review'], ['no-ai', 'keep']]);

    const removed = await remove('keep');
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().affectedPages).toBe(2);
    expect(await labels()).toEqual([['no-ai-review'], ['no-ai-review'], ['no-ai']]);
    expect(await labelAuditRows()).toBe(3);
  });
});
