import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import type * as Undici from 'undici';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { getPool, query } from '../../../core/db/postgres.js';
import { reconcilePageWriteIntent } from '../../../core/services/page-write-admission.js';
import {
  previewPageBaseline,
  setPageBaselineCreationEnabled,
} from '../../../core/services/page-baseline-service.js';
import { setPageBaselineReadinessProvider } from '../../../core/services/page-baseline-governance.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { isConfluenceEnabled } from './sync-service.js';
import {
  confluencePagePutDigest,
  registerConfluencePagePutIntentReconcilers,
} from './page-put-intent-reconciler.js';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  request: vi.fn(),
}));

const mockRequest = vi.mocked(request);
const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
let sequence = 0;

function jsonResponse(data: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {},
    body: { text: async () => JSON.stringify(data) },
  };
}

async function insertUser(role: 'user' | 'admin'): Promise<string> {
  sequence += 1;
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', $3)
     RETURNING id`,
    [`put-recovery-${sequence}`, `put-recovery-${sequence}@test.invalid`, role],
  );
  return result.rows[0]!.id;
}

async function seedPendingIntent(input: {
  kind: 'page.ai_apply' | 'page.version_restore';
  actorId: string;
  fencedBy: string;
  expectedRemoteVersion: number;
  intendedTitle: string;
  intendedStorage: string;
}): Promise<{
  intentId: string;
  pageId: number;
  confluenceId: string;
  digest: string;
  improvementId: string | null;
  targetVersion: number | null;
}> {
  const confluenceId = `conf-${sequence}-${input.kind}`;
  const page = await query<{
    id: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, body_html, body_storage, body_text, version,
        source, visibility, created_by_user_id, embedding_dirty, embedding_status)
     VALUES ($1, 'REC', 'Local title', '<p>local</p>', '<p>local</p>', 'local', $2,
             'confluence', 'private', $3, FALSE, 'not_embedded')
     RETURNING id, content_revision::text, lifecycle_revision::text`,
    [confluenceId, input.expectedRemoteVersion, input.actorId],
  );
  const pageRow = page.rows[0]!;
  const digest = confluencePagePutDigest({
    pageId: pageRow.id,
    confluenceId,
    title: input.intendedTitle,
    bodyStorage: input.intendedStorage,
    expectedRemoteVersion: input.expectedRemoteVersion,
  });
  const runtimeId = `recovery-runtime-${randomUUID()}`;
  const acknowledgmentId = randomUUID();
  await query(
    `INSERT INTO page_writer_runtimes
       (runtime_id, deployment_identity, quiesced_at, quiescence_ack, fenced_at,
        fenced_by, fence_reason, fence_proof)
     VALUES ($1, $2::jsonb, NOW(), $3, NOW(), $4,
             'Owner runtime quiesced before conditional recovery', $5::jsonb)`,
    [
      runtimeId,
      JSON.stringify({ host: 'recovery-test', pid: sequence, startedAt: new Date().toISOString() }),
      acknowledgmentId,
      input.fencedBy,
      JSON.stringify({
        kind: 'owner_quiescence_ack',
        acknowledgmentId,
        deploymentIdentity: { host: 'recovery-test' },
      }),
    ],
  );
  const intentId = randomUUID();
  const revisions = {
    [pageRow.id]: {
      contentRevision: pageRow.content_revision,
      lifecycleRevision: pageRow.lifecycle_revision,
    },
  };
  let improvementId: string | null = null;
  let targetVersion: number | null = null;
  let publicationEffect: Record<string, unknown>;
  if (input.kind === 'page.ai_apply') {
    const improvement = await query<{ id: string }>(
      `INSERT INTO llm_improvements
         (user_id, page_id, improvement_type, model, original_content, improved_content, status)
       VALUES ($1, $2, 'clarity', 'test-model', 'old', 'intended', 'completed')
       RETURNING id`,
      [input.actorId, pageRow.id],
    );
    improvementId = improvement.rows[0]!.id;
    publicationEffect = { improvementId };
  } else {
    targetVersion = 2;
    await query(
      `INSERT INTO page_versions
         (page_id, version_number, title, body_html, body_text)
       VALUES ($1, $2, $3, $4, 'intended storage')`,
      [pageRow.id, targetVersion, input.intendedTitle, input.intendedStorage],
    );
    publicationEffect = { targetVersion };
  }
  const effect = {
    effectClass: 'remote',
    pageId: pageRow.id,
    confluenceId,
    expectedRemoteVersion: String(input.expectedRemoteVersion),
    intendedStateDigest: digest,
    ...publicationEffect,
  };
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
     VALUES ($1, $2, $3, $4, ARRAY[$5]::integer[], $6::jsonb,
             'remote_conditional', $7::jsonb)`,
    [
      intentId,
      runtimeId,
      input.kind,
      input.actorId,
      pageRow.id,
      JSON.stringify(revisions),
      JSON.stringify(effect),
    ],
  );
  return {
    intentId,
    pageId: pageRow.id,
    confluenceId,
    digest,
    improvementId,
    targetVersion,
  };
}

async function statusAndProof(intentId: string): Promise<{
  status: string;
  settlement_proof: { details: Record<string, unknown> } | null;
}> {
  const result = await query<{
    status: string;
    settlement_proof: { details: Record<string, unknown> } | null;
  }>(
    `SELECT status, settlement_proof FROM page_write_intents WHERE id = $1`,
    [intentId],
  );
  return result.rows[0]!;
}

async function localPageState(pageId: number): Promise<{
  title: string;
  body_html: string;
  body_storage: string;
  body_text: string;
  version: number;
  embedding_dirty: boolean;
  image_analysis_dirty: boolean;
}> {
  const result = await query<{
    title: string;
    body_html: string;
    body_storage: string;
    body_text: string;
    version: number;
    embedding_dirty: boolean;
    image_analysis_dirty: boolean;
  }>(
    `SELECT title, body_html, body_storage, body_text, version,
            embedding_dirty, image_analysis_dirty
       FROM pages WHERE id = $1`,
    [pageId],
  );
  return result.rows[0]!;
}

describe.skipIf(!dbAvailable || !redisAvailable)('conditional Confluence page PUT intent recovery — real PostgreSQL and Redis', () => {
  let originalActorId = '';
  let administratorId = '';
  let attachmentsDir: string;
  let cacheProducer: RedisClientType;
  let cacheObserver: RedisClientType;

  beforeAll(async () => {
    await setupTestDb();
    attachmentsDir = await mkdtemp(join(tmpdir(), 'conditional-publication-'));
    vi.stubEnv('ATTACHMENTS_DIR', attachmentsDir);
    setPageBaselineReadinessProvider(async () => ({ ready: true, blockers: [] }));
    registerConfluencePagePutIntentReconcilers();
    cacheProducer = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false },
    });
    cacheObserver = cacheProducer.duplicate();
    await Promise.all([cacheProducer.connect(), cacheObserver.connect()]);
    setRedisClient(cacheProducer);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    originalActorId = await insertUser('admin');
    administratorId = await insertUser('admin');
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('REC', 'Recovery')`);
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat)
       VALUES ($1, 'https://confluence.example.com', $2)`,
      [originalActorId, encryptPat('original-actor-pat')],
    );
    await setPageBaselineCreationEnabled(administratorId, true);
  });

  afterAll(async () => {
    await Promise.all(
      [cacheProducer, cacheObserver]
        .filter((client) => client.isOpen)
        .map((client) => client.quit()),
    );
    await teardownTestDb();
    setPageBaselineReadinessProvider(null);
    vi.unstubAllEnvs();
    await rm(attachmentsDir, { recursive: true, force: true });
  });

  it.each(['page.ai_apply', 'page.version_restore'] as const)(
    'settles %s as applied only when current E+1 has the intended digest',
    async (kind) => {
      const expectedRemoteVersion = 5;
      const intendedTitle = 'Intended title';
      const intendedStorage = '<p>intended storage</p>';
      const intent = await seedPendingIntent({
        kind,
        actorId: originalActorId,
        fencedBy: administratorId,
        expectedRemoteVersion,
        intendedTitle,
        intendedStorage,
      });
      let unrelatedImprovementId: string | null = null;
      if (kind === 'page.ai_apply') {
        const unrelated = await query<{ id: string }>(
          `INSERT INTO llm_improvements
             (user_id, page_id, improvement_type, model, original_content, improved_content, status)
           VALUES ($1, $2, 'grammar', 'later-model', 'other old', 'other new', 'completed')
           RETURNING id`,
          [originalActorId, intent.pageId],
        );
        unrelatedImprovementId = unrelated.rows[0]!.id;
      } else {
        await query(
          `INSERT INTO page_versions (page_id, version_number, title)
           VALUES ($1, 5, 'Local title')`,
          [intent.pageId],
        );
      }
      const pageCacheKey = `kb:${originalActorId}:pages:article:${intent.pageId}`;
      const searchCacheKey = `kb:${administratorId}:search:recovered-${intent.pageId}`;
      const unrelatedCacheKey = `put-recovery:${randomUUID()}`;
      await cacheObserver.mSet({
        [pageCacheKey]: 'stale authored page',
        [searchCacheKey]: 'stale search result',
        [unrelatedCacheKey]: 'keep',
      });
      await query(
        `INSERT INTO page_collaborative_docs (page_id, doc_state)
         VALUES ($1, $2)`,
        [intent.pageId, Buffer.from('stale collaborative body')],
      );
      mockRequest.mockResolvedValueOnce(jsonResponse({
        id: intent.confluenceId,
        type: 'page',
        status: 'current',
        title: intendedTitle,
        version: { number: 6, when: '2026-09-01T00:00:00Z' },
        body: { storage: { value: intendedStorage } },
      }) as never);

      await expect(reconcilePageWriteIntent(intent.intentId, {
        actorId: administratorId,
        reason: 'Current E+1 exactly matches the durable intended state digest',
      })).resolves.toEqual({ intentId: intent.intentId, status: 'reconciled_applied' });

      const settled = await statusAndProof(intent.intentId);
      expect(settled.status).toBe('reconciled_applied');
      expect(settled.settlement_proof?.details).toMatchObject({
        conditionalExpectedVersion: '5',
        observedRemoteVersion: '6',
        providerResult: 'applied',
        intendedStateDigest: intent.digest,
        observedStateDigest: intent.digest,
      });
      const durableIntent = await query<{
        effect: Record<string, unknown>;
        settlement_proof: Record<string, unknown>;
      }>(
        'SELECT effect, settlement_proof FROM page_write_intents WHERE id = $1',
        [intent.intentId],
      );
      expect(Object.keys(durableIntent.rows[0]!.effect).sort()).toEqual(
        (kind === 'page.ai_apply'
          ? [
              'confluenceId',
              'effectClass',
              'expectedRemoteVersion',
              'improvementId',
              'intendedStateDigest',
              'pageId',
            ]
          : [
              'confluenceId',
              'effectClass',
              'expectedRemoteVersion',
              'intendedStateDigest',
              'pageId',
              'targetVersion',
            ]).sort(),
      );
      expect(JSON.stringify(durableIntent.rows[0]!.effect)).not.toContain(intendedTitle);
      expect(JSON.stringify(durableIntent.rows[0]!.effect)).not.toContain(intendedStorage);
      expect(JSON.stringify(durableIntent.rows[0]!.settlement_proof)).not.toContain(intendedTitle);
      expect(JSON.stringify(durableIntent.rows[0]!.settlement_proof)).not.toContain(intendedStorage);
      expect(await localPageState(intent.pageId)).toEqual({
        title: intendedTitle,
        body_html: intendedStorage,
        body_storage: intendedStorage,
        body_text: 'intended storage',
        version: 6,
        embedding_dirty: true,
        image_analysis_dirty: true,
      });
      if (kind === 'page.ai_apply') {
        const improvements = await query<{ id: string; status: string }>(
          `SELECT id, status FROM llm_improvements
            WHERE page_id = $1 ORDER BY created_at, id`,
          [intent.pageId],
        );
        expect(improvements.rows.find((row) => row.id === intent.improvementId)?.status).toBe('applied');
        expect(improvements.rows.find((row) => row.id === unrelatedImprovementId)?.status).toBe('completed');
      } else {
        const snapshot = await query<{
          title: string;
          body_html: string;
          body_text: string;
        }>(
          `SELECT title, body_html, body_text
             FROM page_versions
            WHERE page_id = $1 AND version_number = 5`,
          [intent.pageId],
        );
        expect(snapshot.rows[0]).toEqual({
          title: 'Local title',
          body_html: '<p>local</p>',
          body_text: 'local',
        });
      }
      expect(
        (await query('SELECT 1 FROM page_collaborative_docs WHERE page_id = $1', [intent.pageId])).rows,
      ).toEqual([]);
      expect(
        await cacheObserver.mGet([pageCacheKey, searchCacheKey, unrelatedCacheKey]),
      ).toEqual([null, null, 'keep']);
      await cacheObserver.del(unrelatedCacheKey);
      expect(
        (await query<{ cache_invalidation_pending: boolean }>(
          'SELECT cache_invalidation_pending FROM page_write_intents WHERE id = $1',
          [intent.intentId],
        )).rows[0]?.cache_invalidation_pending,
      ).toBe(false);
      const preview = await previewPageBaseline(intent.pageId, originalActorId);
      expect(preview.version).toBe(6);
      const baseline = await query<{
        title: string;
        body_html: string;
        body_storage: string;
        body_text: string;
        version: number;
      }>(
        `SELECT title, body_html, body_storage, body_text, version
           FROM page_baselines WHERE id = $1`,
        [preview.baselineId],
      );
      expect(baseline.rows[0]).toEqual({
        title: intendedTitle,
        body_html: intendedStorage,
        body_storage: intendedStorage,
        body_text: 'intended storage',
        version: 6,
      });
      expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({
        headers: { Authorization: 'Bearer original-actor-pat' },
      });
    },
  );

  it('completes reconciliation when the locked transaction owns the only available connection', async () => {
    const expectedRemoteVersion = 5;
    const intendedTitle = 'Intended title';
    const intendedStorage = '<p>intended storage</p>';
    const intent = await seedPendingIntent({
      kind: 'page.ai_apply',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion,
      intendedTitle,
      intendedStorage,
    });
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: intent.confluenceId,
      type: 'page',
      status: 'current',
      title: intendedTitle,
      version: { number: expectedRemoteVersion + 1, when: '2026-09-01T00:00:00Z' },
      body: { storage: { value: intendedStorage } },
    }) as never);

    const pool = getPool();
    const holders: PoolClient[] = [];
    while (holders.length < pool.options.max - 1) {
      holders.push(await pool.connect());
    }

    let settled = false;
    let outcome: 'completed' | 'second-checkout';
    let reconciliation: {
      intentId: string;
      status: 'reconciled_applied' | 'reconciled_not_applied';
    } | undefined;
    const pending = reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'The conditional update is being reconciled under pool saturation',
    });
    try {
      const completion = pending.then((result) => {
        settled = true;
        reconciliation = result;
        return 'completed' as const;
      });
      const secondCheckout = (async () => {
        while (!settled && mockRequest.mock.calls.length === 0 && pool.waitingCount === 0) {
          await nextEventLoopTurn();
        }
        return pool.waitingCount > 0 ? ('second-checkout' as const) : completion;
      })();
      outcome = await Promise.race([completion, secondCheckout]);
    } finally {
      settled = true;
      for (const holder of holders) holder.release();
      reconciliation ??= await pending;
    }

    expect(outcome).toBe('completed');
    expect((await statusAndProof(intent.intentId)).status).toBe('reconciled_applied');
    expect(reconciliation).toEqual({ intentId: intent.intentId, status: 'reconciled_applied' });
    expect(pool.waitingCount).toBe(0);
    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer original-actor-pat' },
    });
  });

  it('keeps transaction-local standalone mode separate from committed mode', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
        [originalActorId],
      );
      expect(await isConfluenceEnabled(originalActorId, client)).toBe(false);
      expect(await isConfluenceEnabled(originalActorId)).toBe(true);
      await client.query('COMMIT');
      expect(await isConfluenceEnabled(originalActorId)).toBe(false);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('keeps reconciliation pending without remote access when the original actor switched Confluence off', async () => {
    const intent = await seedPendingIntent({
      kind: 'page.version_restore',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion: 5,
      intendedTitle: 'Intended title',
      intendedStorage: '<p>intended storage</p>',
    });
    await query(
      'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
      [originalActorId],
    );

    await expect(reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'The original actor disabled Confluence before reconciliation',
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: 'intent_actor_credentials_unavailable',
    });
    expect((await statusAndProof(intent.intentId)).status).toBe('pending');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('settles not-applied when exact historical E+1 exists with a different digest', async () => {
    const intent = await seedPendingIntent({
      kind: 'page.ai_apply',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion: 5,
      intendedTitle: 'Intended title',
      intendedStorage: '<p>intended storage</p>',
    });
    mockRequest
      .mockResolvedValueOnce(jsonResponse({
        id: intent.confluenceId,
        title: 'Current later title',
        version: { number: 9 },
        body: { storage: { value: '<p>later</p>' } },
      }) as never)
      .mockResolvedValueOnce(jsonResponse({
        id: intent.confluenceId,
        title: 'Different E+1 title',
        version: { number: 6 },
        body: { storage: { value: '<p>different E+1</p>' } },
      }) as never);

    await expect(reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'Historical E+1 proves a different write consumed the conditional version',
    })).resolves.toEqual({ intentId: intent.intentId, status: 'reconciled_not_applied' });

    const settled = await statusAndProof(intent.intentId);
    expect(settled.status).toBe('reconciled_not_applied');
    expect(settled.settlement_proof?.details).toMatchObject({
      conditionalExpectedVersion: '5',
      observedRemoteVersion: '6',
      providerResult: 'historical_version_observed',
      intendedStateDigest: intent.digest,
    });
    expect(settled.settlement_proof?.details.observedStateDigest).not.toBe(intent.digest);
    expect(await localPageState(intent.pageId)).toMatchObject({
      title: 'Local title',
      body_html: '<p>local</p>',
      body_storage: '<p>local</p>',
      body_text: 'local',
      version: 5,
      embedding_dirty: false,
    });
    expect(String(mockRequest.mock.calls[1]?.[0])).toContain(
      `/${intent.confluenceId}?status=historical&version=6&expand=body.storage,version`,
    );
  });

  it('keeps malformed kind metadata pending without reading or changing the remote page', async () => {
    const intent = await seedPendingIntent({
      kind: 'page.version_restore',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion: 5,
      intendedTitle: 'Intended title',
      intendedStorage: '<p>intended storage</p>',
    });
    await query(
      `UPDATE page_write_intents
          SET effect = effect - 'targetVersion'
        WHERE id = $1`,
      [intent.intentId],
    );

    await expect(reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'The restoration target metadata must be complete before reconciliation',
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: 'intent_recovery_metadata_invalid',
    });
    expect((await statusAndProof(intent.intentId)).status).toBe('pending');
    expect(mockRequest).not.toHaveBeenCalled();
    expect(await localPageState(intent.pageId)).toMatchObject({
      title: 'Local title',
      body_storage: '<p>local</p>',
      version: 5,
    });
  });

  it('keeps an applied restore pending when its original history target is unavailable', async () => {
    const intent = await seedPendingIntent({
      kind: 'page.version_restore',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion: 5,
      intendedTitle: 'Intended title',
      intendedStorage: '<p>intended storage</p>',
    });
    await query(
      'DELETE FROM page_versions WHERE page_id = $1 AND version_number = $2',
      [intent.pageId, intent.targetVersion],
    );
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: intent.confluenceId,
      title: 'Intended title',
      version: { number: 6 },
      body: { storage: { value: '<p>intended storage</p>' } },
    }) as never);

    await expect(reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'A missing original history target cannot be silently reconstructed',
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: 'intent_restore_target_unavailable',
    });
    expect((await statusAndProof(intent.intentId)).status).toBe('pending');
    expect(await localPageState(intent.pageId)).toMatchObject({
      title: 'Local title',
      body_html: '<p>local</p>',
      body_storage: '<p>local</p>',
      version: 5,
    });
  });

  it('rolls back local publication when exact pre-restore history cannot be recorded', async () => {
    const intent = await seedPendingIntent({
      kind: 'page.version_restore',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion: 5,
      intendedTitle: 'Intended title',
      intendedStorage: '<p>intended storage</p>',
    });
    await query(
      `INSERT INTO page_versions
         (page_id, version_number, title, body_html, body_text)
       VALUES ($1, 5, 'Unrelated snapshot', '<p>unrelated</p>', 'unrelated')`,
      [intent.pageId],
    );
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: intent.confluenceId,
      title: 'Intended title',
      version: { number: 6 },
      body: { storage: { value: '<p>intended storage</p>' } },
    }) as never);

    await expect(reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'Conflicting history must roll back the local publication transaction',
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: 'intent_restore_history_unavailable',
    });
    expect((await statusAndProof(intent.intentId)).status).toBe('pending');
    expect(await localPageState(intent.pageId)).toMatchObject({
      title: 'Local title',
      body_html: '<p>local</p>',
      body_storage: '<p>local</p>',
      version: 5,
    });
    const conflicting = await query<{ title: string }>(
      'SELECT title FROM page_versions WHERE page_id = $1 AND version_number = 5',
      [intent.pageId],
    );
    expect(conflicting.rows[0]?.title).toBe('Unrelated snapshot');
  });

  it('rolls back an applied AI recovery when its exact improvement record disappeared', async () => {
    const intent = await seedPendingIntent({
      kind: 'page.ai_apply',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion: 5,
      intendedTitle: 'Intended title',
      intendedStorage: '<p>intended storage</p>',
    });
    const pageCacheKey = `kb:${originalActorId}:pages:article:${intent.pageId}`;
    const searchCacheKey = `kb:${administratorId}:search:rollback-${intent.pageId}`;
    await cacheObserver.mSet({
      [pageCacheKey]: 'old page cache',
      [searchCacheKey]: 'old search cache',
    });
    const staleDoc = Buffer.from('collaborative state before failed recovery');
    await query(
      `INSERT INTO page_collaborative_docs (page_id, doc_state)
       VALUES ($1, $2)`,
      [intent.pageId, staleDoc],
    );
    await query('DELETE FROM llm_improvements WHERE id = $1', [intent.improvementId]);
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: intent.confluenceId,
      title: 'Intended title',
      version: { number: 6 },
      body: { storage: { value: '<p>intended storage</p>' } },
    }) as never);

    await expect(reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'Missing exact improvement metadata cannot be replaced by a newer row',
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: 'intent_ai_improvement_unavailable',
    });
    expect((await statusAndProof(intent.intentId)).status).toBe('pending');
    expect(await localPageState(intent.pageId)).toMatchObject({
      title: 'Local title',
      body_html: '<p>local</p>',
      body_storage: '<p>local</p>',
      version: 5,
    });
    const persistedDoc = await query<{ doc_state: Buffer }>(
      'SELECT doc_state FROM page_collaborative_docs WHERE page_id = $1',
      [intent.pageId],
    );
    expect(persistedDoc.rows[0]?.doc_state).toEqual(staleDoc);
    expect(await cacheObserver.mGet([pageCacheKey, searchCacheKey]))
      .toEqual(['old page cache', 'old search cache']);
    expect(
      (await query<{ cache_invalidation_pending: boolean }>(
        'SELECT cache_invalidation_pending FROM page_write_intents WHERE id = $1',
        [intent.intentId],
      )).rows[0]?.cache_invalidation_pending,
    ).toBe(false);
    await cacheObserver.del([pageCacheKey, searchCacheKey]);
  });

  it('keeps proven remote work pending after the original actor is deactivated', async () => {
    const intent = await seedPendingIntent({
      kind: 'page.ai_apply',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion: 5,
      intendedTitle: 'Intended title',
      intendedStorage: '<p>intended storage</p>',
    });
    await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [originalActorId]);
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: intent.confluenceId,
      title: 'Intended title',
      version: { number: 6 },
      body: { storage: { value: '<p>intended storage</p>' } },
    }) as never);
    await expect(reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'Revoked original authority cannot publish recovered authored state',
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: 'intent_actor_authority_unavailable',
    });
    expect((await statusAndProof(intent.intentId)).status).toBe('pending');
    expect(await localPageState(intent.pageId)).toMatchObject({
      title: 'Local title', body_html: '<p>local</p>', body_storage: '<p>local</p>', version: 5,
    });
    expect((await query('SELECT status FROM llm_improvements WHERE id = $1', [intent.improvementId])).rows)
      .toEqual([{ status: 'completed' }]);
  });

  it('keeps the intent pending while the current remote version is still E', async () => {
    const intent = await seedPendingIntent({
      kind: 'page.version_restore',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion: 5,
      intendedTitle: 'Intended title',
      intendedStorage: '<p>intended storage</p>',
    });
    mockRequest.mockResolvedValueOnce(jsonResponse({
      id: intent.confluenceId,
      title: 'Still current',
      version: { number: 5 },
      body: { storage: { value: '<p>still current</p>' } },
    }) as never);

    await expect(reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'Remote version has not advanced enough to prove either terminal outcome',
    })).rejects.toMatchObject({
      statusCode: 409,
      reason: 'intent_remote_outcome_unknown',
    });
    expect((await statusAndProof(intent.intentId)).status).toBe('pending');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps the intent pending when advanced current state cannot yield exact historical E+1', async () => {
    const intent = await seedPendingIntent({
      kind: 'page.ai_apply',
      actorId: originalActorId,
      fencedBy: administratorId,
      expectedRemoteVersion: 5,
      intendedTitle: 'Intended title',
      intendedStorage: '<p>intended storage</p>',
    });
    mockRequest
      .mockResolvedValueOnce(jsonResponse({
        id: intent.confluenceId,
        title: 'Current later title',
        version: { number: 9 },
        body: { storage: { value: '<p>later</p>' } },
      }) as never)
      .mockResolvedValueOnce(jsonResponse({ message: 'historical revision unavailable' }, 404) as never);

    await expect(reconcilePageWriteIntent(intent.intentId, {
      actorId: administratorId,
      reason: 'Historical E+1 is unavailable so the remote outcome remains unknown',
    })).rejects.toThrow(/not found/i);
    expect((await statusAndProof(intent.intentId)).status).toBe('pending');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });
});
