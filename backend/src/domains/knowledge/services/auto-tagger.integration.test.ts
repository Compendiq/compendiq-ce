import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiDecisionEvent } from '@compendiq/contracts';
import { getEnterprisePlugin } from '../../../core/enterprise/loader.js';
import { z } from 'zod';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { PAGE_LIFECYCLE_LOCK_KEY } from '../../../core/db/advisory-locks.js';
import { getPool, query } from '../../../core/db/postgres.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { enqueue, getMetrics, setConcurrency } from '../../llm/services/llm-queue.js';
import {
  applyLabelChanges,
  applyTags,
  autoTagAllPages,
  autoTagContent,
  autoTagPage,
} from './auto-tagger.js';

interface ExternalRequest {
  method: string;
  url: string;
  body: unknown;
}

type ProviderResponder = (body: unknown, response: ServerResponse) => void;

const ProviderRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
  stream: z.boolean(),
});
const dbAvailable = await isDbAvailable();
const ASSIGNED_MODEL = 'auto-tag-integration-model';
let server: Server;
let origin: string;
let requests: ExternalRequest[] = [];
let respondToProvider: ProviderResponder;
let respondToLabels: ProviderResponder;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendTags(response: ServerResponse, tags = '["architecture"]'): void {
  sendJson(response, 200, {
    choices: [{ message: { content: tags }, finish_reason: 'stop' }],
  });
}

function userMessage(body: unknown): string {
  const parsed = ProviderRequestSchema.parse(body);
  return parsed.messages.find((message) => message.role === 'user')?.content ?? '';
}

function requestedModel(body: unknown): string {
  return ProviderRequestSchema.parse(body).model;
}

async function createUser(role: 'admin' | 'user' = 'user'): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO users (id, username, email, password_hash, role)
     VALUES ($1, $2, $3, 'x', $4)`,
    [id, `auto-tag-${id}`, `${id}@test.invalid`, role],
  );
  return id;
}

async function configureConfluence(
  userId: string,
  enabled: boolean,
): Promise<void> {
  await query(
    `INSERT INTO user_settings
       (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, $2, $3, $4)`,
    [userId, origin, encryptPat('auto-tag-test-pat'), enabled],
  );
}
async function waitForLabelReservation(
  pageId: number,
  applying: Promise<{ error: unknown }>,
): Promise<void> {
  const reservationWaiting = (async () => {
    for (;;) {
      const locks = await query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid = $1::oid
              AND objid = $2::oid
              AND granted = FALSE
         ) AS waiting`,
        [PAGE_LIFECYCLE_LOCK_KEY, pageId],
      );
      if (locks.rows[0]?.waiting) return;
      await nextEventLoopTurn();
    }
  })();
  await Promise.race([
    reservationWaiting,
    applying.then((result) => {
      throw result.error ?? new Error('Label mutation completed before reaching its reservation barrier');
    }),
  ]);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }
      const externalRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        body,
      };
      requests.push(externalRequest);

      if (externalRequest.method === 'GET' && externalRequest.url.startsWith('/rest/api/content/remote-model-race/label')) {
        sendJson(response, 200, { results: [], size: 0, limit: 200 });
        return;
      }
      if (externalRequest.method === 'POST' && externalRequest.url === '/v1/chat/completions') {
        respondToProvider(body, response);
        return;
      }
      if (
        externalRequest.method === 'POST'
        && /^\/rest\/api\/content\/[^/]+\/label$/.test(externalRequest.url)
      ) {
        respondToLabels(body, response);
        return;
      }
      sendJson(response, 404, { message: 'Unexpected external request' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Auto-tag provider test server did not bind a TCP port');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  requests = [];
  respondToProvider = (_body, response) => sendTags(response);
  respondToLabels = (_body, response) => sendJson(response, 200, {});
  const provider = await query<{ id: string }>(
    `INSERT INTO llm_providers
       (name, base_url, auth_type, verify_ssl, default_model)
     VALUES ('auto-tag-integration', $1, 'none', TRUE, $2)
     RETURNING id`,
    [`${origin}/v1`, ASSIGNED_MODEL],
  );
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
     VALUES ('auto_tag', $1, $2)`,
    [provider.rows[0]!.id, ASSIGNED_MODEL],
  );
});

afterAll(async () => {
  if (!dbAvailable) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await teardownTestDb();
});

const describeDb = dbAvailable ? describe : describe.skip;

describeDb('auto-tagger persistence and provider boundaries', () => {
  it('uses the persisted provider with an explicit model override and real content preparation', async () => {
    const actorId = await createUser();

    const page = await query<{ id: number }>(`INSERT INTO pages
      (title, body_html, source, visibility, created_by_user_id)
      VALUES ('Deployment', '<h1>Deployment</h1><p>Recover the database safely.</p>',
        'standalone', 'private', $1) RETURNING id`, [actorId]);
    await expect(autoTagPage(actorId, String(page.rows[0]!.id), 'operator-selected-model'))
      .resolves.toMatchObject({ suggestedTags: ['architecture'] });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model: 'operator-selected-model', stream: false },
    });
    expect(userMessage(requests[0]!.body)).toContain('Deployment');
    expect(userMessage(requests[0]!.body)).toContain('Recover the database safely.');
  });

  it('resolves both the integer primary key and Confluence identifier from persisted pages', async () => {
    const actorId = await createUser();
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('TAG', 'Tagging')`);
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ('tag-reader', 'Tag reader', ARRAY['read']) RETURNING id`,
    );
    await query(`INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
      VALUES ('TAG', 'user', $1, $2)`, [actorId, role.rows[0]!.id]);
    const numericPage = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, labels, source, visibility, created_by_user_id)
       VALUES ('Numeric page', '<p>Numeric deployment guide</p>', 'Numeric deployment guide',
               ARRAY['existing'], 'standalone', 'private', $1)
       RETURNING id`,
      [actorId],
    );
    const confluenceId = `conf-${randomUUID()}`;
    await query(
      `INSERT INTO pages
         (confluence_id, space_key, title, body_html, body_text, labels, source, visibility,
          created_by_user_id)
       VALUES ($1, 'TAG', 'Confluence page', '<p>Confluence API reference</p>',
               'Confluence API reference', ARRAY['manual'], 'confluence', 'private', $2)`,
      [confluenceId, actorId],
    );
    respondToProvider = (body, response) => {
      sendTags(response, userMessage(body).includes('Numeric') ? '["deployment"]' : '["api"]');
    };

    await expect(autoTagPage(actorId, String(numericPage.rows[0]!.id))).resolves.toEqual({
      suggestedTags: ['deployment'],
      existingLabels: ['existing'],
    });
    await expect(autoTagPage(actorId, confluenceId)).resolves.toEqual({
      suggestedTags: ['api'],
      existingLabels: ['manual'],
    });
    expect(requests.map((request) => requestedModel(request.body)))
      .toEqual([ASSIGNED_MODEL, ASSIGNED_MODEL]);
  });

  it('reports a real provider HTTP failure without manufacturing internal errors', async () => {
    const actorId = await createUser();
    respondToProvider = (_body, response) => {
      sendJson(response, 503, { error: { message: 'provider unavailable' } });
    };

    const page = await query<{ id: number }>(`INSERT INTO pages
      (title, body_html, source, visibility, created_by_user_id)
      VALUES ('Deployment', '<p>Deployment guide</p>', 'standalone', 'private', $1)
      RETURNING id`, [actorId]);
    await expect(autoTagPage(actorId, String(page.rows[0]!.id)))
      .rejects.toThrow(/Auto-tag failed:.*HTTP 503/);
    expect(requests).toHaveLength(1);
  });

  it('requires article provenance at compile time and refuses omission or a non-article marker without HTTP', async () => {
    const actorId = await createUser();
    // @ts-expect-error Article auto-tagging requires an explicit article stage.
    await expect(autoTagContent(actorId, 'Secret')).rejects.toMatchObject({ name: 'ArticleStageRefusedError' });
    await expect(autoTagContent(actorId, 'Secret', {
      // @ts-expect-error A non-article classification cannot authorize article content.
      articleStage: { kind: 'non_article', purpose: 'probe' },
    })).rejects.toMatchObject({ name: 'ArticleStageRefusedError' });
    expect(requests).toEqual([]);
  });

  it('persists standalone labels and keeps a synced page local while integration is off', async () => {
    const actorId = await createUser();
    await configureConfluence(actorId, false);
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('OFF', 'Integration off')`);
    // Switching the integration off changes where the write lands, not who may
    // make it: the synced page still needs a role on its space.
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ('auto-tag-off-editor', 'Label editor', ARRAY['read', 'write'])
       RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments
         (space_key, principal_type, principal_id, role_id)
       VALUES ('OFF', 'user', $1, $2)`,
      [actorId, role.rows[0]!.id],
    );
    const standalone = await query<{ id: number }>(
      `INSERT INTO pages
         (title, labels, source, visibility, created_by_user_id)
       VALUES ('Standalone', ARRAY['existing'], 'standalone', 'private', $1)
       RETURNING id`,
      [actorId],
    );
    const confluenceId = `off-${randomUUID()}`;
    await query(
      `INSERT INTO pages
         (confluence_id, space_key, title, labels, source, visibility, created_by_user_id)
       VALUES ($1, 'OFF', 'Previously synced', ARRAY['policy'], 'confluence', 'private', $2)`,
      [confluenceId, actorId],
    );

    await expect(applyTags(actorId, String(standalone.rows[0]!.id), ['security']))
      .resolves.toEqual(['existing', 'security', 'all-ai']);
    await expect(applyTags(actorId, confluenceId, ['api']))
      .resolves.toEqual(['policy', 'api', 'all-ai']);

    const persisted = await query<{ title: string; labels: string[] }>(
      `SELECT title, labels FROM pages
       WHERE title IN ('Standalone', 'Previously synced')
       ORDER BY title`,
    );
    expect(persisted.rows).toEqual([
      { title: 'Previously synced', labels: ['policy', 'api', 'all-ai'] },
      { title: 'Standalone', labels: ['existing', 'security', 'all-ai'] },
    ]);
    expect(requests).toEqual([]);
  });

  it('syncs an enabled Confluence page by its persisted upstream identifier before committing labels', async () => {
    const actorId = await createUser();
    await configureConfluence(actorId, true);
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('SYNC', 'Label sync')`);
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ('auto-tag-label-editor', 'Label editor', ARRAY['read', 'write'])
       RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments
         (space_key, principal_type, principal_id, role_id)
       VALUES ('SYNC', 'user', $1, $2)`,
      [actorId, role.rows[0]!.id],
    );
    const confluenceId = `remote-${randomUUID()}`;
    const page = await query<{ id: number }>(
      `INSERT INTO pages
         (confluence_id, space_key, title, labels, source, visibility, created_by_user_id)
       VALUES ($1, 'SYNC', 'Remote labels', ARRAY['existing'], 'confluence', 'private', $2)
       RETURNING id`,
      [confluenceId, actorId],
    );

    await expect(applyTags(actorId, String(page.rows[0]!.id), ['deployment']))
      .resolves.toEqual(['existing', 'deployment', 'all-ai']);

    expect(requests).toEqual([{
      method: 'POST',
      url: `/rest/api/content/${confluenceId}/label`,
      body: [{ prefix: 'global', name: 'deployment' }, { prefix: 'global', name: 'all-ai' }],
    }]);
    await expect(query<{ labels: string[] }>(
      'SELECT labels FROM pages WHERE id = $1',
      [page.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ labels: ['existing', 'deployment', 'all-ai'] }] });
  });

  it('tags accessible Confluence pages and local pages while excluding inaccessible or labeled rows', async () => {
    const actorId = await createUser();
    await configureConfluence(actorId, false);
    await query(
      `INSERT INTO spaces (space_key, space_name)
       VALUES ('VISIBLE', 'Visible'), ('HIDDEN', 'Hidden')`,
    );
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ('auto-tag-reader', 'Auto-tag reader', ARRAY['read'])
       RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments
         (space_key, principal_type, principal_id, role_id)
       VALUES ('VISIBLE', 'user', $1, $2)`,
      [actorId, role.rows[0]!.id],
    );
    await query(
      `INSERT INTO pages
         (confluence_id, space_key, title, body_html, body_text, labels, source, visibility,
          created_by_user_id)
       VALUES
         ('visible-page', 'VISIBLE', 'Visible unlabeled', '<p>Visible body</p>', 'Visible body',
          ARRAY[]::text[], 'confluence', 'private', $1),
         ('hidden-page', 'HIDDEN', 'Hidden unlabeled', '<p>Hidden body</p>', 'Hidden body',
          ARRAY[]::text[], 'confluence', 'private', $1),
         (NULL, NULL, 'Local unlabeled', '<p>Local body</p>', 'Local body',
          ARRAY['all-ai']::text[], 'standalone', 'private', $1),
         ('labeled-page', 'VISIBLE', 'Already labeled', '<p>Labeled body</p>', 'Labeled body',
          ARRAY['manual'], 'confluence', 'private', $1)`,
      [actorId],
    );

    await expect(autoTagAllPages(actorId)).resolves.toEqual({ tagged: 2, errors: 0 });

    const pages = await query<{ title: string; labels: string[] }>(
      `SELECT title, labels FROM pages ORDER BY title`,
    );
    expect(pages.rows).toEqual([
      { title: 'Already labeled', labels: ['manual'] },
      { title: 'Hidden unlabeled', labels: [] },
      { title: 'Local unlabeled', labels: ['architecture', 'all-ai'] },
      { title: 'Visible unlabeled', labels: ['architecture', 'all-ai'] },
    ]);
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request) => userMessage(request.body)))).toEqual(
      new Set(['Local body', 'Visible body']),
    );
  });
});

afterEach(() => vi.restoreAllMocks());

describeDb('auto-tag article admission and publication', () => {
  it.each(['suggestions', 'labels', 'stale-result'] as const)('records only the dispatched inference for %s', async (mode) => {
    const actorId = await createUser();
    const inserted = await query<{ id: number }>(`INSERT INTO pages
      (title, body_html, source, visibility, created_by_user_id, labels)
      VALUES ('Evidence', '<p>Deployment</p>', 'standalone', 'private', $1, ARRAY['all-ai']) RETURNING id`, [actorId]);
    const id = inserted.rows[0]!.id;
    const events: AiDecisionEvent[] = [];
    vi.spyOn(getEnterprisePlugin(), 'onAiDecision').mockImplementation((event) => { events.push(event); });
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    respondToProvider = (_body, response) => { release = () => sendTags(response); reached(); };
    let published = false;
    const work = autoTagPage(actorId, String(id), undefined, mode === 'suggestions' ? undefined : async (tags, articleStage) => {
      published = true;
      await applyLabelChanges(actorId, String(id), { add: tags, articleStage });
    }).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    await arrived;
    try {
      if (mode === 'stale-result') await query("UPDATE pages SET body_html = '<p>Successor</p>' WHERE id = $1", [id]);
    } finally { release(); }
    const result = await work;
    if (mode === 'stale-result') {
      expect(result.error).toMatchObject({ name: 'ArticleStageRefusedError' });
      expect(published).toBe(false);
    } else {
      expect(result.error).toBeNull();
      expect(result.value?.suggestedTags).toEqual(['architecture']);
      expect(published).toBe(mode === 'labels');
    }
    expect(requests).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'decision', decision: 'admitted', reason: 'allowed',
      stage: 'auto_tag', attempt: 1, actor: { kind: 'user', id: actorId },
      provider: { model: ASSIGNED_MODEL }, articles: [{ pageId: id }] });
    expect(events[0]!.operationId).toEqual(expect.any(String));
    expect((await query('SELECT labels FROM pages WHERE id = $1', [id])).rows[0].labels)
      .toEqual(mode === 'labels' ? ['architecture', 'all-ai'] : ['all-ai']);
  });
  it('rechecks policy after queue wait without sending article bytes', async () => {
    const actorId = await createUser();
    const page = await query<{ id: number }>(`INSERT INTO pages
      (title, body_html, source, visibility, created_by_user_id)
      VALUES ('Queued', '<p>Secret</p>', 'standalone', 'private', $1) RETURNING id`, [actorId]);
    const priorConcurrency = getMetrics().concurrency;
    setConcurrency(1);
    let release!: () => void;
    const blocker = enqueue(() => new Promise<void>((resolve) => { release = resolve; }));
    const work = autoTagPage(actorId, String(page.rows[0]!.id)).then(() => null, (err: unknown) => err);
    try {
      while (getMetrics().pendingCount === 0 || !release) await nextEventLoopTurn();
      await query(`UPDATE pages SET ai_policy = 'none' WHERE id = $1`, [page.rows[0]!.id]);
      release();
      await blocker;
      expect(await work).toMatchObject({ name: 'ArticleStageRefusedError' });
      expect(requests).toEqual([]);
    } finally {
      release?.();
      await blocker;
      setConcurrency(priorConcurrency);
    }
  });

  it('rejects a stale result inside label publication even after inference validation', async () => {
    const actorId = await createUser();
    const page = await query<{ id: number }>(`INSERT INTO pages
      (title, body_html, source, visibility, created_by_user_id, labels)
      VALUES ('Publish', '<p>Deployment</p>', 'standalone', 'private', $1, ARRAY[]::text[]) RETURNING id`, [actorId]);
    const id = page.rows[0]!.id;
    await expect(autoTagPage(actorId, String(id), undefined, async (tags, articleStage) => {
      await query(`UPDATE pages SET body_html = '<p>Successor</p>' WHERE id = $1`, [id]);
      await applyLabelChanges(actorId, String(id), { add: tags, articleStage });
    })).rejects.toMatchObject({ name: 'ArticleStageRefusedError' });
    expect(requests).toHaveLength(1);
    expect((await query('SELECT labels FROM pages WHERE id = $1', [id])).rows[0].labels).toEqual([]);
  });
  it.each(['policy', 'content', 'provider', 'model'] as const)('discards a generated result after a %s change during HTTP inference', async (change) => {
    const actorId = await createUser();
    const inserted = await query<{ id: number }>(`INSERT INTO pages
      (title, body_html, source, visibility, created_by_user_id, labels)
      VALUES ('Race', '<p>Deployment</p>', 'standalone', 'private', $1, ARRAY[]::text[]) RETURNING id`, [actorId]);
    const id = inserted.rows[0]!.id;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      respondToProvider = (_body, response) => { release = () => sendTags(response); resolve(); };
    });
    const work = autoTagAllPages(actorId);
    await reached;
    if (change === 'policy') await query(`UPDATE pages SET ai_policy = 'none' WHERE id = $1`, [id]);
    if (change === 'content') await query(`UPDATE pages SET body_html = '<p>New content</p>' WHERE id = $1`, [id]);
    if (change === 'provider') await query(`UPDATE llm_providers SET base_url = base_url || '/changed'`);
    if (change === 'model') await query(`UPDATE llm_usecase_assignments SET model = 'successor' WHERE usecase = 'auto_tag'`);
    release();
    await expect(work).resolves.toEqual({ tagged: 0, errors: 0, policyBlocked: 1 });
    expect(requests).toHaveLength(1);
    const result = await query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [id]);
    expect(result.rows[0]!.labels).not.toContain('architecture');
  });

  it('revalidates the effective model on the held local publication client', async () => {
    const actorId = await createUser();
    const inserted = await query<{ id: number }>(`INSERT INTO pages
      (title, body_html, source, visibility, created_by_user_id, labels)
      VALUES ('Local model race', '<p>Deployment</p>', 'standalone', 'private', $1, ARRAY[]::text[]) RETURNING id`, [actorId]);
    const id = inserted.rows[0]!.id;
    await expect(autoTagPage(actorId, String(id), undefined, async (tags, articleStage) => {
      await query(`UPDATE llm_usecase_assignments SET model = 'successor' WHERE usecase = 'auto_tag'`);
      await applyLabelChanges(actorId, String(id), { add: tags, articleStage });
    })).rejects.toMatchObject({ name: 'ArticleStageRefusedError' });
    expect((await query('SELECT labels FROM pages WHERE id = $1', [id])).rows[0].labels).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('retains a pending generated-label intent rather than claiming success after a remote in-flight model change', async () => {
    const actorId = await createUser('admin');
    await configureConfluence(actorId, true);
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('RACE', 'Race')`);
    const inserted = await query<{ id: number }>(`INSERT INTO pages
      (confluence_id, space_key, title, body_html, source, visibility, created_by_user_id, labels)
      VALUES ('remote-model-race', 'RACE', 'Remote model race', '<p>Deployment</p>', 'confluence', 'private', $1, ARRAY[]::text[]) RETURNING id`, [actorId]);
    const id = inserted.rows[0]!.id;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      respondToLabels = (_body, response) => { release = () => sendJson(response, 200, {}); resolve(); };
    });
    const work = autoTagPage(actorId, String(id), undefined, async (tags, articleStage) => {
      await applyLabelChanges(actorId, String(id), { add: tags, articleStage });
    }).then(() => null, (error: unknown) => error);
    await reached;
    await query(`UPDATE llm_usecase_assignments SET model = 'successor' WHERE usecase = 'auto_tag'`);
    release();
    expect(await work).toMatchObject({ name: 'ArticleStageRefusedError' });
    expect((await query('SELECT labels FROM pages WHERE id = $1', [id])).rows[0].labels).toEqual([]);
    const intent = (await query('SELECT status, effect FROM page_write_intents WHERE page_ids @> ARRAY[$1]::int[]', [id])).rows[0];
    expect(intent.status).toBe('pending');
    expect(intent.effect.autoTagStage.model).toBe(ASSIGNED_MODEL);
    expect(intent.effect.autoTagStage.provenance.pages[0].pageId).toBe(id);
    expect(requests).toHaveLength(3);
  });

  it('blocks restricted articles before any outbound HTTP request', async () => {
    const actorId = await createUser();
    const inserted = await query<{ id: number }>(`INSERT INTO pages
      (title, body_html, source, visibility, created_by_user_id, ai_policy)
      VALUES ('Restricted', '<p>Secret</p>', 'standalone', 'private', $1, 'none') RETURNING id`, [actorId]);
    await expect(autoTagPage(actorId, String(inserted.rows[0]!.id)))
      .rejects.toMatchObject({ statusCode: 403, body: { error: 'ai_policy_denied' } });
    expect(requests).toEqual([]);
  });
});

describeDb('auto-tagger label intent admission', () => {
  it('refuses a stale reservation and preserves the label mutation that committed first', async () => {
    const actorId = await createUser('admin');
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('REC', 'Recovery')`);
    await configureConfluence(actorId, true);
    const page = await query<{ id: number }>(
      `INSERT INTO pages
         (confluence_id, space_key, title, labels, source, visibility, created_by_user_id)
       VALUES ($1, 'REC', 'Label race', ARRAY['before'], 'confluence', 'private', $2)
       RETURNING id`,
      [`label-race-${randomUUID()}`, actorId],
    );
    const pageId = page.rows[0]!.id;

    const blocker = await getPool().connect();
    let transactionOpen = true;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1, $2)', [
        PAGE_LIFECYCLE_LOCK_KEY,
        pageId,
      ]);

      const applying = applyLabelChanges(actorId, String(pageId), { add: ['requested'] })
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
      await waitForLabelReservation(pageId, applying);

      await blocker.query(`UPDATE pages SET labels = ARRAY['concurrent'] WHERE id = $1`, [pageId]);
      await blocker.query('COMMIT');
      transactionOpen = false;

      const result = await applying;
      expect(result.value).toBeNull();
      expect(result.error).toMatchObject({ statusCode: 409, reason: 'stale_content_revision' });
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK');
      blocker.release();
    }

    expect(requests).toEqual([]);
    await expect(query<{ labels: string[] }>(
      'SELECT labels FROM pages WHERE id = $1',
      [pageId],
    )).resolves.toMatchObject({ rows: [{ labels: ['concurrent'] }] });
    await expect(query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM page_write_intents WHERE page_ids @> ARRAY[$1]::int[]',
      [pageId],
    )).resolves.toMatchObject({ rows: [{ count: '0' }] });
  });

  it('cancels a waiting label mutation when the actor loses page and space authority', async () => {
    const actorId = await createUser();
    await configureConfluence(actorId, true);
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('REVOKE', 'Revoked access')`);
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ('auto-tag-editor', 'Auto-tag editor', ARRAY['read', 'write'])
       RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments
         (space_key, principal_type, principal_id, role_id)
       VALUES ('REVOKE', 'user', $1, $2)`,
      [actorId, role.rows[0]!.id],
    );
    const page = await query<{ id: number }>(
      `INSERT INTO pages
         (confluence_id, space_key, title, labels, source, visibility, created_by_user_id)
       VALUES ($1, 'REVOKE', 'Authority race', ARRAY['before'], 'confluence', 'private', $2)
       RETURNING id`,
      [`authority-race-${randomUUID()}`, actorId],
    );
    const pageId = page.rows[0]!.id;

    const blocker = await getPool().connect();
    let transactionOpen = true;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1, $2)', [
        PAGE_LIFECYCLE_LOCK_KEY,
        pageId,
      ]);
      const applying = applyLabelChanges(actorId, String(pageId), { add: ['requested'] })
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
      await waitForLabelReservation(pageId, applying);

      await blocker.query(
        `DELETE FROM space_role_assignments
          WHERE space_key = 'REVOKE'
            AND principal_type = 'user'
            AND principal_id = $1`,
        [actorId],
      );
      await blocker.query('COMMIT');
      transactionOpen = false;

      const result = await applying;
      expect(result.value).toBeNull();
      expect(result.error).toMatchObject({ statusCode: 403, reason: 'intent_access_changed' });
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK');
      blocker.release();
    }

    expect(requests).toEqual([]);
    await expect(query<{ labels: string[] }>(
      'SELECT labels FROM pages WHERE id = $1',
      [pageId],
    )).resolves.toMatchObject({ rows: [{ labels: ['before'] }] });
  });

  it('does not retain credentials when Confluence is disabled while a label reservation waits', async () => {
    const actorId = await createUser('admin');
    await configureConfluence(actorId, true);
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('DISABLE', 'Disabled mode')`);
    const page = await query<{ id: number }>(
      `INSERT INTO pages
         (confluence_id, space_key, title, labels, source, visibility, created_by_user_id)
       VALUES ($1, 'DISABLE', 'Mode race', ARRAY['before'], 'confluence', 'private', $2)
       RETURNING id`,
      [`mode-race-${randomUUID()}`, actorId],
    );
    const pageId = page.rows[0]!.id;

    const blocker = await getPool().connect();
    let transactionOpen = true;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1, $2)', [
        PAGE_LIFECYCLE_LOCK_KEY,
        pageId,
      ]);
      const applying = applyLabelChanges(actorId, String(pageId), { add: ['requested'] })
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
      await waitForLabelReservation(pageId, applying);

      await blocker.query(
        'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
        [actorId],
      );
      await blocker.query('COMMIT');
      transactionOpen = false;

      const result = await applying;
      expect(result.value).toBeNull();
      expect(result.error).toMatchObject({ statusCode: 403, reason: 'intent_connection_changed' });
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK');
      blocker.release();
    }

    expect(requests).toEqual([]);
    await expect(query<{ labels: string[] }>(
      'SELECT labels FROM pages WHERE id = $1',
      [pageId],
    )).resolves.toMatchObject({ rows: [{ labels: ['before'] }] });
  });
});
