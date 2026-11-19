/**
 * #1881 — the article AI policy enforcement switch over HTTP, on the real
 * application (`buildApp`: auth plugin, admin rate limit, global error
 * handler, every route), real PostgreSQL, real Redis.
 *
 * Design §5 rows A2 (enable → actor/time + one audit row, idempotent repeat,
 * 403s, 400), A3/I1 (never enabled: detail `foundation_only`, PUT/bulk/create
 * 409; restrictions present while disabled still `foundation_only` and the
 * activation GET stays `ready`), A4 (refusal with named blockers over the
 * wire), I2 (CE noop plugin + enabled keeps a `none` page's admission
 * refused), I3 (stale `expectedRevision` → 409), I4 (set `none` → admission
 * refused, switch off → still refused) and I5 (scoped editor 200, shared
 * viewer 403 `ai_policy_denied`).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { ConversationTurnAiProvenance } from '@compendiq/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { query } from '../../core/db/postgres.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { setAiPolicyEnforcementForTest } from '../../core/services/ai-policy-activation.js';
import { getEnterprisePlugin } from '../../core/enterprise/loader.js';
import { admitArticleStage } from '../../domains/llm/services/article-stage-admission.js';
import { createProvider } from '../../domains/llm/services/llm-provider-service.js';
import {
  fenceTestRuntime,
  insertPreexistingLegacyRuntime,
  insertTestRuntime,
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { insertLocalSpace, insertStandalonePage, insertUser } from '../knowledge/pages.test-helpers.js';

const available = await isDbAvailable();
const SPACE = 'AIPOL-ACT';
const ACTIVATION = '/api/admin/ai-policy/activation';

describe.skipIf(!available)('article AI policy activation over HTTP (#1881)', () => {
  let app: FastifyInstance;
  let adminId: string;
  let adminToken: string;
  let editorToken: string;
  let viewerToken: string;
  let pageId: number;

  async function adminUser(username: string): Promise<{ id: string; token: string }> {
    const result = await query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, 'Grace Admin', 'x', 'admin') RETURNING id`,
      [username],
    );
    const id = result.rows[0]!.id;
    await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)', [id]);
    return { id, token: await generateAccessToken({ sub: id, username, role: 'admin' }) };
  }

  async function memberUser(username: string): Promise<{ id: string; token: string }> {
    const id = await insertUser(username);
    await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)', [id]);
    return { id, token: await generateAccessToken({ sub: id, username, role: 'user' }) };
  }

  function send(method: InjectOptions['method'], url: string, token: string, payload?: unknown) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });
  }

  async function activationAudits(): Promise<Array<{ user_id: string | null; action: string }>> {
    const result = await query<{ user_id: string | null; action: string }>(
      `SELECT user_id, action FROM audit_log
        WHERE action IN ('AI_POLICY_ENFORCEMENT_ACTIVATED', 'AI_POLICY_ENFORCEMENT_DEACTIVATED') ORDER BY created_at, id`,
    );
    return result.rows;
  }

  async function pageRow(id: number) {
    return (await query<{ ai_policy: string; ai_policy_revision: string }>(
      'SELECT ai_policy, ai_policy_revision::text FROM pages WHERE id = $1', [id],
    )).rows[0]!;
  }

  /** A `none` page's worker admission against a real provider row: the I2/I4 probe. */
  async function admissionFor(id: number): Promise<'admitted' | string> {
    const provider = await createProvider({ name: `probe-${randomUUID()}`, baseUrl: 'http://probe.test/v1', authType: 'none', verifySsl: true });
    const row = (await query<{ ai_policy: 'all' | 'local_only' | 'none'; ai_policy_revision: string; content_revision: string }>(
      'SELECT ai_policy, ai_policy_revision::text, content_revision::text FROM pages WHERE id = $1', [id],
    )).rows[0]!;
    const provenance: ConversationTurnAiProvenance = {
      version: 1, providerId: provider.id, configRevision: provider.configRevision!, locality: 'external',
      pages: [{ pageId: id, policy: row.ai_policy, policyRevision: Number(row.ai_policy_revision), contentRevision: Number(row.content_revision) }],
    };
    return admitArticleStage(provenance, null, 'summary').then(
      () => 'admitted',
      (err: unknown) => (err instanceof Error && 'reason' in err && typeof err.reason === 'string' ? err.reason : 'unknown'),
    );
  }

  beforeAll(async () => {
    await setupTestDb();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    // truncateAllTables reseeds the row disabled; align the process cache
    // with it the way production does (read back from the database).
    await setAiPolicyEnforcementForTest(false);
    const admin = await adminUser(`act-admin-${randomUUID().slice(0, 8)}`);
    adminId = admin.id;
    adminToken = admin.token;
    const editor = await memberUser(`act-editor-${randomUUID().slice(0, 8)}`);
    editorToken = editor.token;
    viewerToken = (await memberUser(`act-viewer-${randomUUID().slice(0, 8)}`)).token;
    const owner = await memberUser(`act-owner-${randomUUID().slice(0, 8)}`);
    await insertLocalSpace(SPACE, owner.id);
    pageId = await insertStandalonePage('Governed article', 'shared', owner.id, SPACE);
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, is_system, permissions)
       VALUES ('editor', 'Editor', TRUE, ARRAY['read','comment','edit','delete']) RETURNING id`,
    );
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id) VALUES ($1, 'user', $2, $3)`,
      [SPACE, editor.id, role.rows[0]!.id],
    );
  });

  it('never enabled (A3/I1): GET reports disabled and ready, detail is foundation_only, PUT/bulk/create tightening answer 409 and write nothing', async () => {
    const state = await send('GET', ACTIVATION, adminToken);
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json()).toEqual({
      enabled: false, ready: true, blockers: [], changedAt: null, changedBy: null, changedByName: null, legacyClientsAcknowledged: false,
    });

    const detail = await send('GET', `/api/pages/${pageId}`, adminToken);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ aiPolicyActivation: 'foundation_only', aiPolicy: 'all', aiPolicyRevision: 0 });

    const before = await query('SELECT * FROM pages ORDER BY id');
    const single = await send('PUT', `/api/pages/${pageId}/ai-policy`, adminToken, { aiPolicy: 'local_only', expectedRevision: 0 });
    expect(single.statusCode).toBe(409);
    expect(single.json()).toMatchObject({ error: 'ai_policy_enforcement_unavailable', pageIds: [pageId] });
    const bulk = await send('POST', '/api/pages/bulk/ai-policy', adminToken, { aiPolicy: 'none', items: [{ pageId, expectedRevision: 0 }] });
    expect(bulk.statusCode).toBe(409);
    expect(bulk.json()).toMatchObject({ error: 'ai_policy_enforcement_unavailable' });
    const created = await send('POST', '/api/pages', adminToken, {
      source: 'standalone', title: 'Closed creation', bodyHtml: '<p>authored</p>', aiPolicy: 'none',
    });
    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({ error: 'ai_policy_enforcement_unavailable' });
    expect((await query('SELECT * FROM pages ORDER BY id')).rows).toEqual(before.rows);
  });

  it('authority (A2): members get 403 on GET and PUT, a bad body is the global 400, no bearer is 401', async () => {
    for (const token of [editorToken, viewerToken]) {
      expect((await send('GET', ACTIVATION, token)).statusCode).toBe(403);
      expect((await send('PUT', ACTIVATION, token, { enabled: true })).statusCode).toBe(403);
    }
    const bad = await send('PUT', ACTIVATION, adminToken, { enabled: 'yes' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'ValidationError' });
    const unknownKey = await send('PUT', ACTIVATION, adminToken, { enabled: true, force: true });
    expect(unknownKey.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: ACTIVATION })).statusCode).toBe(401);
    expect((await query('SELECT enabled FROM ai_policy_activation_state')).rows[0]).toEqual({ enabled: false });
    expect(await activationAudits()).toEqual([]);
  });

  it('enable (A2): 200 with actor and time, one audit row, an idempotent repeat, and page detail turns active', async () => {
    const enabled = await send('PUT', ACTIVATION, adminToken, { enabled: true });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({
      enabled: true, ready: true, blockers: [], legacyClientsAcknowledged: false, changedBy: adminId, changedByName: 'Grace Admin',
    });
    expect(Math.abs(Date.parse(enabled.json().changedAt) - Date.now())).toBeLessThan(10_000);
    expect(await activationAudits()).toEqual([{ user_id: adminId, action: 'AI_POLICY_ENFORCEMENT_ACTIVATED' }]);

    const repeat = await send('PUT', ACTIVATION, adminToken, { enabled: true });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual(enabled.json());
    expect(await activationAudits()).toHaveLength(1);
    expect((await send('GET', ACTIVATION, adminToken)).json()).toEqual(enabled.json());

    const detail = await send('GET', `/api/pages/${pageId}`, adminToken);
    expect(detail.json()).toMatchObject({ aiPolicyActivation: 'active' });
  });

  it('active mode (I5/I3): a scoped editor stores local_only, a shared viewer is 403 ai_policy_denied, a stale expectedRevision is 409 and keeps the row', async () => {
    expect((await send('PUT', ACTIVATION, adminToken, { enabled: true })).statusCode).toBe(200);

    const tightened = await send('PUT', `/api/pages/${pageId}/ai-policy`, editorToken, { aiPolicy: 'local_only', expectedRevision: 0 });
    expect(tightened.statusCode, tightened.body).toBe(200);
    expect(tightened.json()).toMatchObject({ pageId, aiPolicy: 'local_only', aiPolicyRevision: 1 });
    expect(await pageRow(pageId)).toEqual({ ai_policy: 'local_only', ai_policy_revision: '1' });

    const denied = await send('PUT', `/api/pages/${pageId}/ai-policy`, viewerToken, { aiPolicy: 'none', expectedRevision: 1 });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'ai_policy_denied', pageIds: [pageId] });

    const stale = await send('PUT', `/api/pages/${pageId}/ai-policy`, editorToken, { aiPolicy: 'none', expectedRevision: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'ai_policy_conflict', reason: 'stale_revision', pageIds: [pageId] });
    expect(await pageRow(pageId)).toEqual({ ai_policy: 'local_only', ai_policy_revision: '1' });
  });

  it('active mode (I4/I2): a committed none refuses admission with the CE noop plugin, and switching off keeps refusing while closing new tightening', async () => {
    // No plugin hook participates in either edition: the switch alone decides.
    expect('aiPolicyEnforcementAvailable' in getEnterprisePlugin()).toBe(false);
    expect((await send('PUT', ACTIVATION, adminToken, { enabled: true })).statusCode).toBe(200);
    expect(await admissionFor(pageId)).toBe('admitted');

    const restricted = await send('PUT', `/api/pages/${pageId}/ai-policy`, adminToken, { aiPolicy: 'none', expectedRevision: 0 });
    expect(restricted.statusCode, restricted.body).toBe(200);
    expect(await admissionFor(pageId)).toBe('ai_policy_denied');

    const disabled = await send('PUT', ACTIVATION, adminToken, { enabled: false });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({ enabled: false, changedBy: adminId, legacyClientsAcknowledged: false });
    expect((await activationAudits()).map((row) => row.action))
      .toEqual(['AI_POLICY_ENFORCEMENT_ACTIVATED', 'AI_POLICY_ENFORCEMENT_DEACTIVATED']);

    // Stored restrictions outlive the switch: admission still refuses and the
    // detail still carries the policy, only new tightening is closed.
    expect(await admissionFor(pageId)).toBe('ai_policy_denied');
    const detail = await send('GET', `/api/pages/${pageId}`, adminToken);
    expect(detail.json()).toMatchObject({ aiPolicyActivation: 'foundation_only', aiPolicy: 'none', aiPolicyRevision: 1 });
    const other = await insertStandalonePage('Second article', 'shared', adminId, SPACE);
    const closed = await send('PUT', `/api/pages/${other}/ai-policy`, adminToken, { aiPolicy: 'local_only', expectedRevision: 0 });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ error: 'ai_policy_enforcement_unavailable' });
    // An authorized relaxation stays available through the API while off.
    const relaxed = await send('PUT', `/api/pages/${pageId}/ai-policy`, adminToken, { aiPolicy: 'all', expectedRevision: 1 });
    expect(relaxed.statusCode, relaxed.body).toBe(200);
    expect(await pageRow(pageId)).toEqual({ ai_policy: 'all', ai_policy_revision: '2' });
  });

  it('restrictions present while disabled (I1): detail stays foundation_only with its stored policy, and the activation GET is still ready', async () => {
    await query(`UPDATE pages SET ai_policy = 'none', labels = ARRAY['no-ai']::text[] WHERE id = $1`, [pageId]);
    const detail = await send('GET', `/api/pages/${pageId}`, adminToken);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({ aiPolicyActivation: 'foundation_only', aiPolicy: 'none' });
    expect(await admissionFor(pageId)).toBe('ai_policy_denied');
    const state = await send('GET', ACTIVATION, adminToken);
    expect(state.json()).toMatchObject({ enabled: false, ready: true, blockers: [] });
  });

  it('a demoted or deactivated administrator that still passes the 30 s auth cache is refused 403 by the activation transaction', async () => {
    expect((await send('GET', ACTIVATION, adminToken)).statusCode).toBe(200);
    await query(`UPDATE users SET role = 'user' WHERE id = $1`, [adminId]);
    const demoted = await send('PUT', ACTIVATION, adminToken, { enabled: true });
    expect(demoted.statusCode, demoted.body).toBe(403);
    expect(demoted.json()).toMatchObject({ error: 'not_authorized' });

    await query(`UPDATE users SET role = 'admin', deactivated_at = NOW() WHERE id = $1`, [adminId]);
    const deactivated = await send('PUT', ACTIVATION, adminToken, { enabled: true });
    expect(deactivated.statusCode, deactivated.body).toBe(403);
    expect(deactivated.json()).toMatchObject({ error: 'not_authorized' });
    expect((await query('SELECT enabled FROM ai_policy_activation_state')).rows[0]).toEqual({ enabled: false });
    expect(await activationAudits()).toEqual([]);
  });

  it('refusal (A4): named blockers over the wire; legacy clients are overridable by the acknowledgement, a legacy runtime is not', async () => {
    const legacyUser = await memberUser(`act-legacy-${randomUUID().slice(0, 8)}`);
    await query(
      `INSERT INTO ai_policy_legacy_client_observations (user_id, last_seen_at, token_expires_at, observations)
       VALUES ($1, NOW(), NOW() + interval '1 hour', 3)`,
      [legacyUser.id],
    );
    const state = await send('GET', ACTIVATION, adminToken);
    expect(state.json()).toMatchObject({ enabled: false, ready: false });
    expect(state.json().blockers).toEqual([expect.objectContaining({
      code: 'legacy_clients_active', overridable: true, users: 1,
      recent: [expect.objectContaining({ userId: legacyUser.id })],
    })]);

    const refused = await send('PUT', ACTIVATION, adminToken, { enabled: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'ai_policy_activation_refused' });
    expect(refused.json().blockers.map((blocker: { code: string }) => blocker.code)).toEqual(['legacy_clients_active']);
    expect(await activationAudits()).toEqual([]);

    const legacyRuntime = await insertTestRuntime({ legacy: true, runtimeId: 'legacy-http-writer' });
    const vetoed = await send('PUT', ACTIVATION, adminToken, { enabled: true, acknowledgeLegacyClients: true });
    expect(vetoed.statusCode).toBe(409);
    expect(vetoed.json().blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'incompatible_ai_policy_runtime', overridable: false, total: 1, runtimes: [expect.objectContaining({ runtimeId: legacyRuntime })] }),
      expect.objectContaining({ code: 'legacy_clients_active' }),
    ]));
    await query(
      `UPDATE page_writer_runtimes SET fenced_at = NOW(), fence_reason = 'Test fixture: verified terminated writer',
              fence_proof = '{"kind":"verified_local_termination"}'::jsonb WHERE runtime_id = $1`,
      [legacyRuntime],
    );

    const acknowledged = await send('PUT', ACTIVATION, adminToken, { enabled: true, acknowledgeLegacyClients: true });
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    expect(acknowledged.json()).toMatchObject({ enabled: true, ready: false, legacyClientsAcknowledged: true, changedBy: adminId });
    expect(acknowledged.json().blockers.map((blocker: { code: string }) => blocker.code)).toEqual(['legacy_clients_active']);
    expect(await activationAudits()).toEqual([{ user_id: adminId, action: 'AI_POLICY_ENFORCEMENT_ACTIVATED' }]);
    expect((await send('GET', `/api/pages/${pageId}`, adminToken)).json()).toMatchObject({ aiPolicyActivation: 'active' });
  });

  it('a tightening while an old runtime is active is a 409 incompatible_runtime_active over HTTP that writes nothing, and succeeds once it is fenced (N24)', async () => {
    expect((await send('PUT', ACTIVATION, adminToken, { enabled: true })).statusCode).toBe(200);
    // An old binary registered before migration 151 installed the door: the
    // only way an active version-0 runtime can coexist with the switch on.
    const oldRuntime = await insertPreexistingLegacyRuntime();

    const refused = await send('PUT', `/api/pages/${pageId}/ai-policy`, editorToken, { aiPolicy: 'local_only', expectedRevision: 0 });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'ai_policy_enforcement_unavailable', reason: 'incompatible_runtime_active' });
    expect(await pageRow(pageId)).toEqual({ ai_policy: 'all', ai_policy_revision: '0' });

    await fenceTestRuntime(oldRuntime);
    const stored = await send('PUT', `/api/pages/${pageId}/ai-policy`, editorToken, { aiPolicy: 'local_only', expectedRevision: 0 });
    expect(stored.statusCode, stored.body).toBe(200);
  });

  it('the assembled app refuses a legacy browser session request while enabled, before credentials are checked', async () => {
    const legacy = { 'sec-fetch-mode': 'cors', 'content-type': 'application/json' };
    const login = { username: 'nobody', password: 'not-a-real-password' };
    // Off: the legacy request reaches the handler (401 for bad credentials).
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: legacy, payload: login })).statusCode).toBe(401);

    expect((await send('PUT', ACTIVATION, adminToken, { enabled: true })).statusCode).toBe(200);
    const refused = await app.inject({ method: 'POST', url: '/api/auth/login', headers: legacy, payload: login });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'client_reload_required' });
    const marked = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: login,
      headers: { ...legacy, 'x-compendiq-client-protocol': '1' },
    });
    expect(marked.statusCode).toBe(401);
  });
});
