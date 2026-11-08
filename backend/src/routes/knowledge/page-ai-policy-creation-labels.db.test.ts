import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { getEnterprisePlugin } from '../../core/enterprise/loader.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { insertUser } from './pages.test-helpers.js';

describe('interactive creation policy and ordinary labels', () => {
  let app: FastifyInstance;
  let token: string;
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    const userId = await insertUser('policy-create-labels');
    await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)', [userId]);
    app = await buildApp();
    await app.ready();
    token = await generateAccessToken({ sub: userId, username: 'policy-create-labels', role: 'user' });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); await teardownTestDb(); });

  it.each(['local_only', 'none'] as const)('honors explicit %s with unrelated labels', async (policy) => {
    vi.spyOn(getEnterprisePlugin(), 'aiPolicyEnforcementAvailable').mockReturnValue(true);
    const response = await app.inject({
      method: 'POST', url: '/api/pages', headers: { authorization: `Bearer ${token}` },
      payload: { source: 'standalone', title: 'Explicit choice', bodyHtml: '<p>Authored</p>', labels: ['ordinary'], aiPolicy: policy },
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = await query('SELECT ai_policy, labels FROM pages WHERE id = $1', [response.json().id]);
    expect(saved.rows[0]).toEqual({ ai_policy: policy, labels: ['ordinary', policy === 'none' ? 'no-ai' : 'local-ai-only'] });
  });

  it('still rejects a real explicit-policy/label contradiction without creating a row', async () => {
    vi.spyOn(getEnterprisePlugin(), 'aiPolicyEnforcementAvailable').mockReturnValue(true);
    const before = await query('SELECT id FROM pages ORDER BY id');
    const response = await app.inject({
      method: 'POST', url: '/api/pages', headers: { authorization: `Bearer ${token}` },
      payload: { source: 'standalone', title: 'Contradiction', bodyHtml: '<p>Authored</p>', labels: ['all-ai', 'ordinary'], aiPolicy: 'none' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'ai_policy_label_conflict' });
    expect((await query('SELECT id FROM pages ORDER BY id')).rows).toEqual(before.rows);
  });
});
