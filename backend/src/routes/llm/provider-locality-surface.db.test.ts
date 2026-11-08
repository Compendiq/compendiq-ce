import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';

describe('provider declaration surface', () => {
  let app: FastifyInstance;
  let token: string;
  beforeAll(async () => {
    await setupTestDb(); await truncateAllTables();
    const actor = (await query<{ id: string }>("INSERT INTO users (username,password_hash,role) VALUES ('locality-surface','x','admin') RETURNING id")).rows[0]!.id;
    token = await generateAccessToken({ sub: actor, username: 'locality-surface', role: 'admin' });
    app = await buildApp(); await app.ready();
  });
  afterAll(async () => { await app.close(); await teardownTestDb(); });
  it('refuses the alternate PUT while POST/PATCH declare and endpoint edits reset', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: 'POST', url: '/api/admin/llm-providers', headers,
      payload: { name: 'local declaration', baseUrl: 'http://127.0.0.1:1234/v1', authType: 'none', verifySsl: true, locality: 'local' } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().locality).toBe('local');
    const id = created.json().id;
    const removed = await app.inject({ method: 'PUT', url: `/api/admin/llm-providers/${id}/locality`, headers,
      payload: { locality: 'external', expectedConfigRevision: created.json().configRevision } });
    expect(removed.statusCode).toBe(404);
    expect((await query('SELECT locality FROM llm_providers WHERE id = $1', [id])).rows[0]!.locality).toBe('local');
    const reset = await app.inject({ method: 'PATCH', url: `/api/admin/llm-providers/${id}`, headers,
      payload: { baseUrl: 'http://127.0.0.1:1235/v1' } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().locality).toBe('external');
    const confirmed = await app.inject({ method: 'PATCH', url: `/api/admin/llm-providers/${id}`, headers,
      payload: { baseUrl: 'http://127.0.0.1:1236/v1', locality: 'local' } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ locality: 'local', localConfirmed: true });
  });
});
