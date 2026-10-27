import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setupTestDb, teardownTestDb, isDbAvailable, waitForDatabaseCondition } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';

const available = await isDbAvailable();

describe.skipIf(!available)('Generate prompt audit fingerprint', () => {
  let app: FastifyInstance;
  let provider: Server;
  let userId: string;
  let providerId: string;
  let token: string;
  let priorAssignment: { provider_id: string | null; model: string | null } | undefined;
  const received: Array<Array<{ role: string; content: string }>> = [];

  beforeAll(async () => {
    await setupTestDb();
    provider = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        received.push(JSON.parse(body).messages);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"Synthetic answer"}}]}\n\ndata: [DONE]\n\n');
      });
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const port = (provider.address() as AddressInfo).port;
    const name = `audit-${Date.now()}`;
    const user = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, 'fakehash', 'admin') RETURNING id`, [name],
    );
    userId = user.rows[0]!.id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
    token = await generateAccessToken({ sub: userId, username: name, role: 'admin' });
    const p = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, default_model) VALUES ($1, $2, 'none', 'synthetic') RETURNING id`,
      [name, `http://127.0.0.1:${port}/v1`],
    );
    providerId = p.rows[0]!.id;
    priorAssignment = (await query<{ provider_id: string | null; model: string | null }>(
      `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'chat'`,
    )).rows[0];
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('chat', $1, 'synthetic')
      ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`, [providerId]);
    app = await buildApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (provider) {
      const closed = once(provider, 'close');
      provider.close();
      await closed;
    }
    if (providerId) {
      if (priorAssignment) {
        await query(`UPDATE llm_usecase_assignments SET provider_id = $1, model = $2 WHERE usecase = 'chat' AND provider_id = $3`,
          [priorAssignment.provider_id, priorAssignment.model, providerId]);
      } else {
        await query(`DELETE FROM llm_usecase_assignments WHERE usecase = 'chat' AND provider_id = $1`, [providerId]);
      }
      await query('DELETE FROM llm_providers WHERE id = $1', [providerId]);
    }
    if (userId) await query('DELETE FROM users WHERE id = $1', [userId]);
    await teardownTestDb();
  });

  it('distinguishes equal-length prompts and repeats a stable fingerprint without cache replay', async () => {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    for (const prompt of ['alpha private prompt', 'bravo private prompt', 'alpha private prompt']) {
      // Delete only the previous request's cache key; repeat must dispatch again.
      const previous = received.at(-1);
      if (previous) await app.redis.del(buildLlmCacheKey('synthetic', previous[0]!.content, previous[1]!.content, providerId));
      const response = await fetch(`${base}/api/llm/generate`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(await waitForDatabaseCondition(async () => {
        const rows = await query<{ count: string }>(`SELECT count(*) FROM llm_audit_log WHERE user_id = $1 AND action = 'generate'`, [userId]);
        return Number(rows.rows[0]!.count) === received.length;
      })).toBe(true);
    }
    expect(received).toHaveLength(3);
    expect(received[0]!.map((m) => [m.role, m.content.length])).toEqual(received[1]!.map((m) => [m.role, m.content.length]));
    expect(received[0]).not.toEqual(received[1]);
    expect(received[0]).toEqual(received[2]);
    const result = await query<{ prompt_hash: string; row: string }>(
      `SELECT prompt_hash, to_jsonb(a)::text AS row FROM llm_audit_log a WHERE user_id = $1 AND action = 'generate' ORDER BY id`, [userId],
    );
    expect(result.rows).toHaveLength(3);
    const expected = received.map((messages) => createHash('sha256').update(JSON.stringify(messages.map((m) => [m.role, m.content]))).digest('hex'));
    expect(result.rows.map((row) => row.prompt_hash)).toEqual(expected);
    expect(expected[0]).not.toBe(expected[1]);
    expect(expected[0]).toBe(expected[2]);
    for (const row of result.rows) expect(row.row).not.toContain('private prompt');
  }, 30_000);
});
