/**
 * Integration tests for /api/pages/:id/presence routes (issue #301).
 *
 * These tests use the full buildApp() harness with real Postgres + real Redis
 * — per CLAUDE.md, routes are exercised against real infrastructure. When
 * Redis or Postgres isn't reachable (fresh dev box) the suite auto-skips.
 *
 * Coverage:
 *   - 401 when unauthenticated
 *   - 403 when the user lacks space-read access
 *   - Two concurrent SSE clients on the same page see each other's heartbeats
 *     propagated via the pub/sub fan-out within a few hundred ms.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient } from 'redis';

// Short-circuit DNS lookups performed by the SSRF guard during buildApp().
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';

async function checkRedisReachable(): Promise<boolean> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const probe = createClient({ url });
  probe.on('error', () => { /* swallow */ });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    try { await probe.quit(); } catch { /* best effort */ }
    return false;
  }
}

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await checkRedisReachable() : false;
const canRun = dbAvailable && redisAvailable;

let app: FastifyInstance;

async function createUserAndLogin(
  username: string,
  opts: { admin?: boolean } = {},
): Promise<{ token: string; userId: string }> {
  const role = opts.admin ? 'admin' : 'user';
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', $2) RETURNING id`,
    [username, role],
  );
  const userId = r.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: role as 'user' | 'admin' });
  return { token, userId };
}

async function insertPage(spaceKey: string, confluenceId: string): Promise<{ id: number }> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (
        confluence_id, space_key, title, body_storage, body_html, body_text,
        version, source, visibility, last_synced
     ) VALUES ($1, $2, 'Test', '<p></p>', '<p></p>', '', 1, 'confluence', 'shared', NOW())
     RETURNING id`,
    [confluenceId, spaceKey],
  );
  return { id: r.rows[0]!.id };
}

async function grantSpaceRead(userId: string, spaceKey: string): Promise<void> {
  // Mint a minimal read-only role and assign it to the user for the space.
  // `getUserAccessibleSpaces()` only cares whether a `space_role_assignments`
  // row exists for the principal and space_key — any role is enough.
  await query(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('presence_test_reader', 'Presence Test Reader', FALSE, ARRAY['read'])
     ON CONFLICT (name) DO NOTHING`,
  );
  const roleRes = await query<{ id: number }>(
    "SELECT id FROM roles WHERE name = 'presence_test_reader' LIMIT 1",
  );
  const roleId = roleRes.rows[0]!.id;

  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT DO NOTHING`,
    [spaceKey, userId, roleId],
  );
}

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (!canRun) return;
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun) return;
  await truncateAllTables();
});

describe.skipIf(!canRun)('POST /api/pages/:id/presence/heartbeat', () => {
  it('returns 401 without auth', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/pages/1/presence/heartbeat',
      payload: { isEditing: false },
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 403 when the user cannot read the page space', async () => {
    const { token } = await createUserAndLogin('presence_noaccess');
    const { id } = await insertPage('LOCKED', 'cf-1');

    const r = await app.inject({
      method: 'POST',
      url: `/api/pages/${id}/presence/heartbeat`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isEditing: false },
    });
    expect(r.statusCode).toBe(403);
  });

  it('returns 204 and records a heartbeat for an authorised user', async () => {
    const { token, userId } = await createUserAndLogin('presence_ok');
    const { id } = await insertPage('SPACE1', 'cf-2');
    await grantSpaceRead(userId, 'SPACE1');

    const r = await app.inject({
      method: 'POST',
      url: `/api/pages/${id}/presence/heartbeat`,
      headers: { authorization: `Bearer ${token}` },
      payload: { isEditing: true },
    });
    expect(r.statusCode).toBe(204);
  });
});

describe.skipIf(!canRun)('GET /api/pages/:id/presence (SSE)', () => {
  it('returns 401 without auth', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/pages/1/presence',
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 403 when the user cannot read the page space', async () => {
    const { token } = await createUserAndLogin('presence_sse_noaccess');
    const { id } = await insertPage('LOCKED2', 'cf-3');

    const r = await app.inject({
      method: 'GET',
      url: `/api/pages/${id}/presence`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('two SSE clients on the same page see each other within 2s of a heartbeat', async () => {
    // Start a real listening HTTP server so we can stream SSE via fetch —
    // app.inject() buffers the entire response and is unsuitable for streaming.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no server address');
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const { token: tokenAlice, userId: aliceId } = await createUserAndLogin('presence_alice');
      const { token: tokenBob, userId: bobId } = await createUserAndLogin('presence_bob');
      const { id } = await insertPage('SPACE2', 'cf-4');
      await grantSpaceRead(aliceId, 'SPACE2');
      await grantSpaceRead(bobId, 'SPACE2');

      // Open two concurrent SSE streams (Alice + Bob) and collect events.
      const openStream = async (token: string): Promise<{
        events: Array<{ viewers: Array<{ userId: string; isEditing: boolean }> }>;
        close: () => void;
      }> => {
        const events: Array<{ viewers: Array<{ userId: string; isEditing: boolean }> }> = [];
        const controller = new AbortController();
        const res = await fetch(`${base}/api/pages/${id}/presence`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.body) throw new Error('no body');

        // Consume the event stream in the background and parse SSE frames.
        (async () => {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              // Split on the SSE frame separator.
              const frames = buf.split('\n\n');
              buf = frames.pop() ?? '';
              for (const frame of frames) {
                const dataLine = frame
                  .split('\n')
                  .find((l) => l.startsWith('data: '));
                if (!dataLine) continue;
                try {
                  const parsed = JSON.parse(dataLine.slice(6));
                  events.push(parsed);
                } catch { /* ignore malformed */ }
              }
            }
          } catch {
            // aborted
          }
        })();

        return { events, close: () => controller.abort() };
      };

      const alice = await openStream(tokenAlice);
      const bob = await openStream(tokenBob);

      try {
        // Let both streams send their initial empty snapshot.
        await new Promise((r) => setTimeout(r, 200));

        // Alice heartbeats — Bob's stream should see it.
        const hbAlice = await fetch(`${base}/api/pages/${id}/presence/heartbeat`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokenAlice}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ isEditing: false }),
        });
        expect(hbAlice.status).toBe(204);

        // Bob heartbeats (editing) — Alice's stream should see both.
        const hbBob = await fetch(`${base}/api/pages/${id}/presence/heartbeat`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${tokenBob}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ isEditing: true }),
        });
        expect(hbBob.status).toBe(204);

        // Wait up to 2s for the fan-out to arrive on both streams.
        const deadline = Date.now() + 2_000;
        const hasBoth = (evts: typeof alice.events): boolean => {
          return evts.some((e) =>
            e.viewers.some((v) => v.userId === aliceId)
            && e.viewers.some((v) => v.userId === bobId),
          );
        };
        while (Date.now() < deadline) {
          if (hasBoth(alice.events) && hasBoth(bob.events)) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        expect(hasBoth(alice.events)).toBe(true);
        expect(hasBoth(bob.events)).toBe(true);

        // Bob's editing flag must propagate to Alice's stream.
        const aliceSawBobEditing = alice.events.some((e) =>
          e.viewers.some((v) => v.userId === bobId && v.isEditing === true),
        );
        expect(aliceSawBobEditing).toBe(true);
      } finally {
        alice.close();
        bob.close();
      }
    } finally {
      await app.close();
      // Re-open for any subsequent tests in the same file — but since this is
      // the last test in the describe block there's no need.
    }
  }, 15_000);
});
