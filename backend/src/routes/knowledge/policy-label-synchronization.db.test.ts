import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import type * as Undici from 'undici';
import type { FastifyInstance } from 'fastify';
import { setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { setAiPolicyEnforcementForTest } from '../../core/services/ai-policy-activation.js';
import { reconcilePageWriteIntent } from '../../core/services/page-write-admission.js';
import { registerOrdinaryPageWriteReconcilers } from '../../domains/confluence/services/ordinary-page-write-reconciler.js';

vi.mock('undici', async (original) => ({ ...(await original<typeof Undici>()), request: vi.fn() }));
const http = vi.mocked(request);
const reply = (data: unknown, statusCode = 200) => ({ statusCode, headers: {}, body: { text: async () => JSON.stringify(data) } }) as never;

describe('policy label durable synchronization', () => {
  let app: FastifyInstance;
  let actor: string;
  let token: string;
  let page: number;
  let remote: string[];
  let failWrite: boolean;
  let failRead: boolean;
  beforeAll(async () => {
    await setupTestDb();
    app = await buildApp();
    await app.ready();
    registerOrdinaryPageWriteReconcilers();
  });
  beforeEach(async () => {
    await truncateAllTables();
    // truncateAllTables reseeds the switch row disabled; reopen the real
    // switch (#1881) for every case — no plugin spy.
    await setAiPolicyEnforcementForTest(true);
    actor = (await query<{ id: string }>("INSERT INTO users (username,password_hash,role) VALUES ('policy-sync','x','admin') RETURNING id")).rows[0]!.id;
    token = await generateAccessToken({ sub: actor, username: 'policy-sync', role: 'admin' });
    await query("INSERT INTO spaces (space_key,space_name,source) VALUES ('SYNC','Sync','confluence')");
    await query("INSERT INTO user_settings (user_id,confluence_url,confluence_pat,confluence_enabled) VALUES ($1,'https://confluence.example.com',$2,TRUE)", [actor, encryptPat('test-pat')]);
    page = (await query<{ id: number }>("INSERT INTO pages (confluence_id,space_key,title,source,labels) VALUES ('sync-page','SYNC','Authored','confluence',ARRAY['ordinary','all-ai']) RETURNING id")).rows[0]!.id;
    remote = ['ordinary', 'all-ai']; failWrite = false; failRead = false;
    http.mockReset();
    http.mockImplementation(async (url, opts) => {
      const path = new URL(String(url)).pathname;
      if (opts?.method === 'POST' && path === '/rest/api/content') {
        const input = JSON.parse(String(opts.body));
        remote = [];
        return reply({ id: 'created-sync', title: input.title, version: { number: 1 }, body: input.body });
      }
      if (opts?.method === 'GET') {
        if (failRead) return reply({}, 403);
        return reply({ results: remote.map((name) => ({ name })) });
      }
      if (failWrite) return reply({}, 403);
      if (opts?.method === 'POST') {
        remote = [...new Set([...remote, ...JSON.parse(String(opts.body)).map((item: { name: string }) => item.name)])];
      } else if (opts?.method === 'DELETE') {
        const name = new URL(String(url)).searchParams.get('name') ?? decodeURIComponent(path.split('/').at(-1)!);
        remote = remote.filter((label) => label !== name);
      }
      return reply({});
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app.close(); await teardownTestDb(); });
  const change = (policy = 'none', expectedRevision = 0) => app.inject({ method: 'PUT', url: `/api/pages/${page}/ai-policy`,
    headers: { authorization: `Bearer ${token}` }, payload: { aiPolicy: policy, expectedRevision } });

  it('verifies canonical labels and explicit relaxation upstream', async () => {
    const first = await change();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ aiPolicy: 'none', synchronization: { status: 'complete', pendingIntentIds: [] } });
    expect(remote.sort()).toEqual(['no-ai', 'ordinary']);
    const second = await change('all', first.json().aiPolicyRevision);
    expect(second.statusCode, second.body).toBe(200);
    expect(remote.sort()).toEqual(['all-ai', 'ordinary']);
    expect((await query("SELECT status FROM page_write_intents WHERE kind = 'pages.create.labels'")).rows.every((r) => r.status === 'completed')).toBe(true);
  });

  it('Confluence off makes zero upstream calls', async () => {
    await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [actor]);
    const response = await change();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().synchronization).toEqual({ status: 'complete', pendingIntentIds: [] });
    expect(http).not.toHaveBeenCalled();
    expect((await query('SELECT id FROM page_write_intents')).rows).toEqual([]);
  });

  it('remote failure retains restriction and journal without stale overwrite', async () => {
    failWrite = true;
    const response = await change();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().synchronization.status).toBe('pending');
    const id = response.json().synchronization.pendingIntentIds[0];
    expect((await query('SELECT ai_policy, labels FROM pages WHERE id = $1', [page])).rows[0]).toEqual({ ai_policy: 'none', labels: ['ordinary', 'no-ai'] });
    expect((await query('SELECT status, effect FROM page_write_intents WHERE id = $1', [id])).rows[0]).toMatchObject({ status: 'pending', effect: { localPolicyCommitted: true, policyRevision: '1' } });
    const count = http.mock.calls.length;
    expect((await change('all')).statusCode).toBe(409);
    expect(http).toHaveBeenCalledTimes(count);
  });

  it('creation reports pending debt committed with its restriction', async () => {
    failWrite = true;
    const response = await app.inject({ method: 'POST', url: '/api/pages', headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Created restricted', bodyHtml: '<p>Authored</p>', source: 'confluence', spaceKey: 'SYNC', labels: ['ordinary'], aiPolicy: 'none' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ source: 'confluence', synchronization: { status: 'pending' } });
    expect((await query("SELECT ai_policy, labels FROM pages WHERE confluence_id = 'created-sync'")).rows[0]).toEqual({ ai_policy: 'none', labels: ['ordinary', 'no-ai'] });
    expect(response.json().synchronization.pendingIntentIds).toHaveLength(1);
  });

  it('mixed stale bulk writes publish nothing', async () => {
    const other = (await query<{ id: number }>("INSERT INTO pages (confluence_id,space_key,title,source) VALUES ('other','SYNC','Other','confluence') RETURNING id")).rows[0]!.id;
    const response = await app.inject({ method: 'POST', url: '/api/pages/bulk/ai-policy', headers: { authorization: `Bearer ${token}` },
      payload: { aiPolicy: 'none', items: [{ pageId: page, expectedRevision: 0 }, { pageId: other, expectedRevision: 1 }] } });
    expect(response.statusCode).toBe(409);
    expect((await query('SELECT ai_policy FROM pages')).rows.every((row) => row.ai_policy === 'all')).toBe(true);
    expect((await query('SELECT id FROM page_write_intents')).rows).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it('replaces only undispatched debt with an authorized fresh revision', async () => {
    failRead = true;
    const first = await change();
    const oldId = first.json().synchronization.pendingIntentIds[0];
    expect((await change('all', 0)).statusCode).toBe(409);
    expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [oldId])).rows[0]!.status).toBe('pending');
    failRead = false;
    const replacement = await change('all', 1);
    expect(replacement.statusCode, replacement.body).toBe(200);
    expect(replacement.json().synchronization.status).toBe('complete');
    expect((await query('SELECT status FROM page_write_intents WHERE id = $1', [oldId])).rows[0]!.status).toBe('cancelled');
    expect((await query('SELECT ai_policy, ai_policy_revision::text FROM pages WHERE id = $1', [page])).rows[0]).toEqual({ ai_policy: 'all', ai_policy_revision: '2' });
  });

  it('fenced no-dispatch recovery preserves the committed policy revision', async () => {
    failRead = true;
    const response = await change();
    const id = response.json().synchronization.pendingIntentIds[0];
    expect(id).toBeTypeOf('string');
    const dead = `dead-${randomUUID()}`;
    await query("INSERT INTO page_writer_runtimes (runtime_id,deployment_identity,fenced_at,fenced_by,fence_reason,fence_proof) VALUES ($1,'{\"host\":\"test-host\",\"pid\":999999,\"startedAt\":\"2026-01-01T00:00:00Z\"}',NOW(),$2,'dead writer verified','{\"kind\":\"verified_local_termination\",\"deploymentIdentity\":{\"host\":\"test-host\"}}')", [dead, actor]);
    await query('UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1', [id, dead]);
    failRead = false;
    await expect(reconcilePageWriteIntent(id, { actorId: actor, reason: 'Retry provably undispatched committed policy labels' })).resolves.toMatchObject({ status: 'reconciled_applied' });
    expect(remote.sort()).toEqual(['no-ai', 'ordinary']);
    expect((await query('SELECT ai_policy_revision::text FROM pages WHERE id = $1', [page])).rows[0]!.ai_policy_revision).toBe('1');
  });
});
