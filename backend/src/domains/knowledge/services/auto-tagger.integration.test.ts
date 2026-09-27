import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

      if (externalRequest.method === 'POST' && externalRequest.url === '/v1/chat/completions') {
        respondToProvider(body, response);
        return;
      }
      if (
        externalRequest.method === 'POST'
        && /^\/rest\/api\/content\/[^/]+\/label$/.test(externalRequest.url)
      ) {
        sendJson(response, 200, {});
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

    await expect(autoTagContent(
      actorId,
      '<h1>Deployment</h1><p>Recover the database safely.</p>',
      { isHtml: true, modelOverride: 'operator-selected-model' },
    )).resolves.toEqual(['architecture']);

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

    await expect(autoTagContent(actorId, 'Deployment guide'))
      .rejects.toThrow(/Auto-tag failed:.*HTTP 503/);
    expect(requests).toHaveLength(1);
  });

  it('persists standalone labels and keeps a synced page local while integration is off', async () => {
    const actorId = await createUser();
    await configureConfluence(actorId, false);
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('OFF', 'Integration off')`);
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
      .resolves.toEqual(['existing', 'security']);
    await expect(applyTags(actorId, confluenceId, ['api']))
      .resolves.toEqual(['policy', 'api']);

    const persisted = await query<{ title: string; labels: string[] }>(
      `SELECT title, labels FROM pages
       WHERE title IN ('Standalone', 'Previously synced')
       ORDER BY title`,
    );
    expect(persisted.rows).toEqual([
      { title: 'Previously synced', labels: ['policy', 'api'] },
      { title: 'Standalone', labels: ['existing', 'security'] },
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
      .resolves.toEqual(['existing', 'deployment']);

    expect(requests).toEqual([{
      method: 'POST',
      url: `/rest/api/content/${confluenceId}/label`,
      body: [{ prefix: 'global', name: 'deployment' }],
    }]);
    await expect(query<{ labels: string[] }>(
      'SELECT labels FROM pages WHERE id = $1',
      [page.rows[0]!.id],
    )).resolves.toMatchObject({ rows: [{ labels: ['existing', 'deployment'] }] });
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
          ARRAY[]::text[], 'standalone', 'private', $1),
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
      { title: 'Local unlabeled', labels: ['architecture'] },
      { title: 'Visible unlabeled', labels: ['architecture'] },
    ]);
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((request) => userMessage(request.body)))).toEqual(
      new Set(['Local body', 'Visible body']),
    );
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
