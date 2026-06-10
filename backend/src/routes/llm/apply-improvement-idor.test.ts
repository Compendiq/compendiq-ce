import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';

// Regression tests for #734: IDOR on POST /api/llm/improvements/apply.
// Any authenticated user could overwrite another user's *private* standalone
// page because the handler resolved the page without checking
// created_by_user_id / visibility. These tests run against real Postgres
// (test-db-helper) with the full app (real auth, real route), mirroring the
// llm-providers.test.ts pattern. Confluence-sourced pages are out of scope:
// that branch pushes through the caller's own Confluence client, so
// Confluence ACLs apply.

const dbAvailable = await isDbAvailable();

const ORIGINAL_TITLE = 'Owner private notes';
const ORIGINAL_HTML = '<p>Original secret content</p>';
const ORIGINAL_TEXT = 'Original secret content';
const ORIGINAL_VERSION = 3;

async function createUser(username: string): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'fakehash') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: 'user' });
  return { token, userId };
}

async function createStandalonePage(opts: {
  ownerId: string;
  visibility: 'private' | 'shared';
  title?: string;
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (
       title, body_html, body_text, version, source,
       created_by_user_id, visibility, embedding_dirty, embedding_status
     ) VALUES ($1, $2, $3, $4, 'standalone', $5, $6, FALSE, 'not_embedded')
     RETURNING id`,
    [opts.title ?? ORIGINAL_TITLE, ORIGINAL_HTML, ORIGINAL_TEXT, ORIGINAL_VERSION, opts.ownerId, opts.visibility],
  );
  return res.rows[0]!.id;
}

async function fetchPage(id: number) {
  const res = await query<{ title: string; body_html: string; body_text: string; version: number }>(
    'SELECT title, body_html, body_text, version FROM pages WHERE id = $1',
    [id],
  );
  return res.rows[0]!;
}

function applyPayload(pageId: number, extra: Record<string, unknown> = {}) {
  return {
    method: 'POST' as const,
    url: '/api/llm/improvements/apply',
    payload: JSON.stringify({
      pageId: String(pageId),
      improvedMarkdown: '# Overwritten\n\nAttacker controlled content.',
      ...extra,
    }),
  };
}

let app: FastifyInstance;
let owner: { token: string; userId: string };
let attacker: { token: string; userId: string };

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  owner = await createUser('idor_owner');
  attacker = await createUser('idor_attacker');
});

describe.skipIf(!dbAvailable)('POST /api/llm/improvements/apply — standalone page IDOR (#734)', () => {
  it('returns 404 for a cross-user apply on a private standalone page and leaves content unchanged', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'private' });

    // No `version` in the payload — the exact lock-bypass vector from the issue.
    const response = await app.inject({
      ...applyPayload(pageId, { title: 'pwned' }),
      headers: { authorization: `Bearer ${attacker.token}`, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(404);
    // The response must not leak the page's real title or version.
    expect(response.body).not.toContain(ORIGINAL_TITLE);
    expect(response.body).not.toContain(`"version":${ORIGINAL_VERSION}`);

    const page = await fetchPage(pageId);
    expect(page.title).toBe(ORIGINAL_TITLE);
    expect(page.body_html).toBe(ORIGINAL_HTML);
    expect(page.body_text).toBe(ORIGINAL_TEXT);
    expect(page.version).toBe(ORIGINAL_VERSION);
  });

  it('returns 404 (not 409) for a stale-version cross-user apply — no existence oracle', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'private' });

    // A 409 here would confirm the page exists and that its version is > 1.
    const response = await app.inject({
      ...applyPayload(pageId, { version: 1 }),
      headers: { authorization: `Bearer ${attacker.token}`, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(404);

    const page = await fetchPage(pageId);
    expect(page.body_html).toBe(ORIGINAL_HTML);
    expect(page.version).toBe(ORIGINAL_VERSION);
  });

  it('still lets the owner apply an improvement to their own private standalone page', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'private' });

    const response = await app.inject({
      ...applyPayload(pageId, { version: ORIGINAL_VERSION, title: 'Improved title' }),
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: pageId, title: 'Improved title', version: ORIGINAL_VERSION + 1 });

    const page = await fetchPage(pageId);
    expect(page.title).toBe('Improved title');
    expect(page.body_html).toContain('Overwritten');
    expect(page.version).toBe(ORIGINAL_VERSION + 1);
  });

  it('still lets any authenticated user apply an improvement to a shared standalone page', async () => {
    const pageId = await createStandalonePage({ ownerId: owner.userId, visibility: 'shared', title: 'Team page' });

    const response = await app.inject({
      ...applyPayload(pageId, { version: ORIGINAL_VERSION }),
      headers: { authorization: `Bearer ${attacker.token}`, 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: pageId, title: 'Team page', version: ORIGINAL_VERSION + 1 });

    const page = await fetchPage(pageId);
    expect(page.body_html).toContain('Overwritten');
    expect(page.version).toBe(ORIGINAL_VERSION + 1);
  });
});
