import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { admitPageForProvider, admitPageForUsecase } from './ai-policy-admission.js';
import { createProvider, updateProvider, LocalityActorRequiredError } from './llm-provider-service.js';

// Enterprise event sink seam only; PostgreSQL is real.
const seams = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../../core/enterprise/ai-policy-hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/enterprise/ai-policy-hooks.js')>();
  return {
    ...actual,
    emitAiPolicyEvent: (event: Record<string, unknown>) => {
      seams.events.push(event);
      actual.emitAiPolicyEvent(event as Parameters<typeof actual.emitAiPolicyEvent>[0]);
    },
  };
});

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

let seq = 0;
async function adminUser(): Promise<string> {
  seq += 1;
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'admin') RETURNING id`,
    [`adm${seq}`, `adm${seq}@test.invalid`],
  );
  return r.rows[0]!.id;
}

const blockedEvents = () => seams.events.filter((e) => e.type === 'blocked');

describe.skipIf(!dbAvailable)('ai-policy admission fails closed (#280)', () => {
  beforeAll(async () => { await setupTestDb(); await query(migration135); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); seams.events.length = 0; });

  it('a provider id with no row is policy_unavailable (retryable) under local_only AND all — nothing is fabricated; `none` never consults the provider', async () => {
    const pageId = await insertPage('local_only');
    const missing = await admitPageForProvider(pageId, 'embedding', randomUUID(), 'm');
    expect(missing).toMatchObject({ admitted: false, reason: 'policy_unavailable', retryable: true, policy: 'local_only' });
    // A non-uuid id reads as "no such provider" (same refusal), not as a cast error.
    const notUuid = await admitPageForProvider(pageId, 'embedding', 'not-a-uuid', 'm');
    expect(notUuid).toMatchObject({ admitted: false, reason: 'policy_unavailable', retryable: true, policy: 'local_only' });
    // `none` is a policy decision and does not depend on the provider.
    const closed = await admitPageForProvider(await insertPage('none'), 'embedding', 'not-a-uuid', 'm');
    expect(closed).toMatchObject({ admitted: false, reason: 'policy_none', retryable: false });
    // `all` is NOT admitted against a provider the system cannot describe.
    const open = await admitPageForProvider(await insertPage('all'), 'embedding', 'not-a-uuid', 'm');
    expect(open).toMatchObject({ admitted: false, reason: 'policy_unavailable', retryable: true, policy: 'all' });
    expect(blockedEvents().map((e) => e.reason)).toEqual(['policy_unavailable', 'policy_unavailable', 'policy_none', 'policy_unavailable']);
    expect(seams.events.filter((e) => e.type === 'admitted')).toHaveLength(0);
  });

  it('a provider deleted after the resolver named it is policy_unavailable through admitPageForUsecase, with one blocked event', async () => {
    const admin = await adminUser();
    const provider = await createProvider(
      { name: 'ext', baseUrl: 'http://127.0.0.1:1234/v1', authType: 'none', verifySsl: false },
      admin,
    );
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('summary', $1, 'm')`, [provider.id]);
    const pageId = await insertPage('all');
    expect(await admitPageForUsecase(pageId, 'summary')).toMatchObject({ admitted: true, providerId: provider.id });
    // Bypass deleteProvider's reference guard: the assignment now points at nothing.
    await query(`DELETE FROM llm_usecase_assignments WHERE provider_id = $1`, [provider.id]);
    await query(`DELETE FROM llm_providers WHERE id = $1`, [provider.id]);
    const { bumpProviderCacheVersion } = await import('./cache-bus.js');
    await bumpProviderCacheVersion();
    seams.events.length = 0;
    const result = await admitPageForUsecase(pageId, 'summary');
    expect(result).toMatchObject({ admitted: false, reason: 'policy_unavailable', retryable: true });
    expect(blockedEvents()).toEqual([expect.objectContaining({ reason: 'policy_unavailable', pageId })]);
    expect(seams.events.filter((e) => e.type === 'admitted')).toHaveLength(0);
  });

  it('a provider row that exists (default external, undeclared) is admitted under `all` only', async () => {
    const admin = await adminUser();
    const provider = await createProvider(
      { name: 'ext', baseUrl: 'http://127.0.0.1:1234/v1', authType: 'none', verifySsl: false },
      admin,
    );
    expect(provider).toMatchObject({ locality: 'external', localConfirmed: false, localityDeclaredBy: null, configRevision: 1 });
    const open = await admitPageForProvider(await insertPage('all'), 'embedding', provider.id, 'm');
    expect(open).toMatchObject({ admitted: true, locality: 'external', configRevision: 1, providerId: provider.id });
    const local = await admitPageForProvider(await insertPage('local_only'), 'embedding', provider.id, 'm');
    expect(local).toMatchObject({ admitted: false, reason: 'provider_not_local', retryable: false });
    expect(seams.events.map((e) => e.type)).toEqual(['admitted', 'blocked']);
  });

  it('a read failure is policy_unavailable, not an exception and not an admission', async () => {
    const admin = await adminUser();
    const provider = await createProvider(
      { name: 'ext', baseUrl: 'http://127.0.0.1:1234/v1', authType: 'none', verifySsl: false },
      admin,
    );
    // A page id outside int4 makes the policy read itself fail (22003) on a
    // real connection. The schema is NOT mutated: other suites share this
    // database, and a dropped column would turn their admissions into
    // policy_unavailable for the duration of the window.
    const pageId = 2 ** 40;
    const result = await admitPageForProvider(pageId, 'embedding', provider.id, 'm');
    expect(result).toMatchObject({ admitted: false, reason: 'policy_unavailable', retryable: true, policy: null });
    expect(blockedEvents()).toEqual([
      expect.objectContaining({ reason: 'policy_unavailable', policy: null, providerId: provider.id, pageId }),
    ]);
    expect(seams.events.filter((e) => e.type === 'admitted')).toHaveLength(0);
  });

  it('an unassigned rerank / image_analysis / inline_completion stage is stage_disabled and emits one blocked event each', async () => {
    const pageId = await insertPage('all');
    for (const usecase of ['rerank', 'image_analysis', 'inline_completion'] as const) {
      const result = await admitPageForUsecase(pageId, usecase);
      expect(result, usecase).toMatchObject({ admitted: false, reason: 'stage_disabled', retryable: true, providerId: null });
    }
    expect(blockedEvents().map((e) => e.reason)).toEqual(['stage_disabled', 'stage_disabled', 'stage_disabled']);
  });

  it('a missing page is not_found with one blocked event', async () => {
    const result = await admitPageForProvider(2_000_000_000, 'embedding', randomUUID(), 'm');
    expect(result).toMatchObject({ admitted: false, reason: 'not_found', retryable: false });
    expect(blockedEvents()).toEqual([expect.objectContaining({ reason: 'not_found', policy: null })]);
  });

  it('a locality declaration without an identified administrator is refused', async () => {
    await expect(createProvider(
      { name: 'lm', baseUrl: 'http://127.0.0.1:1234/v1', authType: 'none', verifySsl: false, locality: 'local' },
    )).rejects.toBeInstanceOf(LocalityActorRequiredError);
    const admin = await adminUser();
    const created = await createProvider(
      { name: 'lm', baseUrl: 'http://127.0.0.1:1234/v1', authType: 'none', verifySsl: false },
      admin,
    );
    await expect(updateProvider(created.id, { locality: 'local' })).rejects.toBeInstanceOf(LocalityActorRequiredError);
    await expect(updateProvider(created.id, { locality: 'external' }, '')).rejects.toBeInstanceOf(LocalityActorRequiredError);
    const row = await query<{ locality: string }>('SELECT locality FROM llm_providers WHERE id = $1', [created.id]);
    expect(row.rows[0]).toEqual({ locality: 'external' });
  });

  it('locality declared on create/update is bound to the administrator and the config revision; an endpoint edit invalidates it', async () => {
    const admin = await adminUser();
    const pageId = await insertPage('local_only');
    const created = await createProvider(
      { name: 'lm', baseUrl: 'http://127.0.0.1:1234/v1', authType: 'none', verifySsl: false, locality: 'local' },
      admin,
    );
    expect(created).toMatchObject({ locality: 'local', localConfirmed: true, localityDeclaredBy: admin, configRevision: 1 });
    expect(created.localityDeclaredAt).not.toBeNull();

    const admitted = await admitPageForProvider(pageId, 'embedding', created.id, 'm');
    expect(admitted).toMatchObject({ admitted: true, locality: 'local', configRevision: 1 });

    // Endpoint edit without re-declaring: the declaration is reset.
    const edited = await updateProvider(created.id, { baseUrl: 'http://127.0.0.1:4321/v1' }, admin);
    expect(edited).toMatchObject({ locality: 'external', localConfirmed: false, localityDeclaredBy: null, configRevision: 2 });
    const blocked = await admitPageForProvider(pageId, 'embedding', created.id, 'm');
    expect(blocked).toMatchObject({ admitted: false, reason: 'provider_not_local', retryable: false });

    // Endpoint edit WITH a locality in the same patch: bound to the new revision.
    const redeclared = await updateProvider(created.id, { baseUrl: 'http://127.0.0.1:5555/v1', locality: 'local' }, admin);
    expect(redeclared).toMatchObject({ locality: 'local', localConfirmed: true, localityDeclaredBy: admin, configRevision: 3 });
    const again = await admitPageForProvider(pageId, 'embedding', created.id, 'm');
    expect(again).toMatchObject({ admitted: true, configRevision: 3 });

    // An explicit `external` declaration is recorded with its declarer too.
    const external = await updateProvider(created.id, { locality: 'external' }, admin);
    expect(external).toMatchObject({ locality: 'external', localConfirmed: false, localityDeclaredBy: admin, configRevision: 3 });
    expect(external!.localityDeclaredAt).not.toBeNull();

    // A declarer stripped from the row (e.g. a bypassing write) never confirms local.
    await query(
      `UPDATE llm_providers SET locality = 'local', locality_declared_at = clock_timestamp(),
              locality_config_revision = config_revision, locality_declared_by = NULL WHERE id = $1`,
      [created.id],
    );
    const stripped = await updateProvider(created.id, {}, admin);
    expect(stripped).toMatchObject({ locality: 'local', localConfirmed: false, localityDeclaredBy: null });
  });
});
