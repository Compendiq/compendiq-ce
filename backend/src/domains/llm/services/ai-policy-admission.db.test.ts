import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { admitPageForProvider, admitPageForUsecase } from './ai-policy-admission.js';
import { createProvider, updateProvider } from './llm-provider-service.js';

const dbAvailable = await isDbAvailable();
// Idempotent: guarantees the locality columns regardless of what an earlier
// suite in the same worker did to `llm_providers`.
const migration135 = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'core', 'db', 'migrations', '135_article_ai_policy.sql'),
  'utf8',
);

async function insertPage(aiPolicy: 'all' | 'local_only' | 'none'): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, body_html, body_storage, body_text, version, labels, source, visibility,
                        embedding_dirty, embedding_status, ai_policy)
     VALUES ('p', '<p>x</p>', '<p>x</p>', 'x', 1, '{}', 'standalone', 'private', TRUE, 'not_embedded', $1)
     RETURNING id`,
    [aiPolicy],
  );
  return r.rows[0]!.id;
}


describe.skipIf(!dbAvailable)('ai-policy admission fails closed (#280)', () => {
  beforeAll(async () => { await setupTestDb(); await query(migration135); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('an undeclared (missing) provider never satisfies local_only: provider_not_local, never configRevision -1', async () => {
    const pageId = await insertPage('local_only');
    const result = await admitPageForProvider(pageId, 'embedding', randomUUID(), 'm');
    expect(result.admitted).toBe(false);
    expect(result).toMatchObject({ reason: 'provider_not_local', retryable: false, policy: 'local_only' });
    const notUuid = await admitPageForProvider(pageId, 'embedding', 'not-a-uuid', 'm');
    expect(notUuid).toMatchObject({ admitted: false, reason: 'provider_not_local' });
  });

  it('an undeclared provider reads as external at revision 0 under `all` and is refused under `none`', async () => {
    const open = await admitPageForProvider(await insertPage('all'), 'embedding', 'not-a-uuid', 'm');
    expect(open).toMatchObject({ admitted: true, locality: 'external', configRevision: 0 });
    const closed = await admitPageForProvider(await insertPage('none'), 'embedding', 'not-a-uuid', 'm');
    expect(closed).toMatchObject({ admitted: false, reason: 'policy_none', retryable: false });
  });

  it('an unassigned rerank / image_analysis / inline_completion stage is stage_disabled', async () => {
    const pageId = await insertPage('all');
    for (const usecase of ['rerank', 'image_analysis', 'inline_completion'] as const) {
      const result = await admitPageForUsecase(pageId, usecase);
      expect(result, usecase).toMatchObject({ admitted: false, reason: 'stage_disabled', retryable: true, providerId: null });
    }
  });

  it('a missing page is not_found', async () => {
    const result = await admitPageForProvider(2_000_000_000, 'embedding', randomUUID(), 'm');
    expect(result).toMatchObject({ admitted: false, reason: 'not_found', retryable: false });
  });

  it('locality declared on create/update binds to the config revision; an endpoint edit invalidates it', async () => {
    const admin = undefined;
    const pageId = await insertPage('local_only');
    const created = await createProvider(
      { name: 'lm', baseUrl: 'http://127.0.0.1:1234/v1', authType: 'none', verifySsl: false, locality: 'local' },
      admin,
    );
    expect(created.locality).toBe('local');
    expect(created.localConfirmed).toBe(true);
    expect(created.localityDeclaredAt).not.toBeNull();
    expect(created.configRevision).toBe(1);

    const admitted = await admitPageForProvider(pageId, 'embedding', created.id, 'm');
    expect(admitted).toMatchObject({ admitted: true, locality: 'local', configRevision: 1 });

    // Endpoint edit without re-declaring: the declaration is reset.
    const edited = await updateProvider(created.id, { baseUrl: 'http://127.0.0.1:4321/v1' }, admin);
    expect(edited).toMatchObject({ locality: 'external', localConfirmed: false, configRevision: 2 });
    const blocked = await admitPageForProvider(pageId, 'embedding', created.id, 'm');
    expect(blocked).toMatchObject({ admitted: false, reason: 'provider_not_local', retryable: false });

    // Endpoint edit WITH a locality in the same patch: bound to the new revision.
    const redeclared = await updateProvider(created.id, { baseUrl: 'http://127.0.0.1:5555/v1', locality: 'local' }, admin);
    expect(redeclared).toMatchObject({ locality: 'local', localConfirmed: true, configRevision: 3 });
    const again = await admitPageForProvider(pageId, 'embedding', created.id, 'm');
    expect(again).toMatchObject({ admitted: true, configRevision: 3 });
  });
});
