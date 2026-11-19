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

  // #1882: the DTO names the declarer for display, always describing the
  // row's own (post-trigger) `locality_declared_by`, never outliving it.
  it('names the declaring administrator in every DTO read and drops the name with the declarer', async () => {
    const dana = (await query<{ id: string }>(
      "INSERT INTO users (username,password_hash,role,display_name) VALUES ('dana','x','admin','  Dana Admin  ') RETURNING id",
    )).rows[0]!.id;
    const blank = (await query<{ id: string }>(
      "INSERT INTO users (username,password_hash,role,display_name) VALUES ('blank-name','x','admin','   ') RETURNING id",
    )).rows[0]!.id;
    const as = async (sub: string, username: string) =>
      ({ authorization: `Bearer ${await generateAccessToken({ sub, username, role: 'admin' })}` });
    const danaHeaders = await as(dana, 'dana');
    const blankHeaders = await as(blank, 'blank-name');

    const undeclared = await app.inject({ method: 'POST', url: '/api/admin/llm-providers', headers: danaHeaders,
      payload: { name: 'undeclared', baseUrl: 'http://127.0.0.1:2233/v1', authType: 'none', verifySsl: true } });
    expect(undeclared.statusCode, undeclared.body).toBe(201);
    expect(undeclared.json()).toMatchObject({ localityDeclaredBy: null, localityDeclaredByName: null });

    const created = await app.inject({ method: 'POST', url: '/api/admin/llm-providers', headers: danaHeaders,
      payload: { name: 'named declaration', baseUrl: 'http://127.0.0.1:2234/v1', authType: 'none', verifySsl: true, locality: 'local' } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      locality: 'local', localConfirmed: true, localityDeclaredBy: dana, localityDeclaredByName: 'Dana Admin',
    });
    const id = created.json().id as string;

    // Endpoint edit without a fresh declaration: the migration-135 trigger
    // resets the row, and the name follows the post-trigger declarer.
    const reset = await app.inject({ method: 'PATCH', url: `/api/admin/llm-providers/${id}`, headers: danaHeaders,
      payload: { baseUrl: 'http://127.0.0.1:2235/v1' } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({ locality: 'external', localConfirmed: false, localityDeclaredBy: null, localityDeclaredByName: null });

    // A blank display name falls back to the username.
    const redeclared = await app.inject({ method: 'PATCH', url: `/api/admin/llm-providers/${id}`, headers: blankHeaders,
      payload: { locality: 'local' } });
    expect(redeclared.statusCode, redeclared.body).toBe(200);
    expect(redeclared.json()).toMatchObject({ localConfirmed: true, localityDeclaredBy: blank, localityDeclaredByName: 'blank-name' });

    const byDana = await app.inject({ method: 'PATCH', url: `/api/admin/llm-providers/${id}`, headers: danaHeaders,
      payload: { locality: 'local' } });
    expect(byDana.json()).toMatchObject({ localityDeclaredBy: dana, localityDeclaredByName: 'Dana Admin' });

    const listed = await app.inject({ method: 'GET', url: '/api/admin/llm-providers', headers: danaHeaders });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().find((p: { id: string }) => p.id === id)).toMatchObject({ localityDeclaredByName: 'Dana Admin' });

    // Deleting the declarer (FK ON DELETE SET NULL) leaves no name behind,
    // and the declaration stops confirming local exactly as before.
    await query('DELETE FROM users WHERE id = $1', [dana]);
    const afterDelete = await app.inject({ method: 'GET', url: '/api/admin/llm-providers', headers: blankHeaders });
    expect(afterDelete.json().find((p: { id: string }) => p.id === id)).toMatchObject({
      locality: 'local', localConfirmed: false, localityDeclaredBy: null, localityDeclaredByName: null,
    });
    expect(afterDelete.json().find((p: { id: string }) => p.id === id).localityDeclaredAt).not.toBeNull();
  });
});
