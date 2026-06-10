import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { ConfluenceClient } from '../../domains/confluence/services/confluence-client.js';
import { pagesVersionRoutes } from './pages-versions.js';

/**
 * Real-DB integration tests for the #763 `backfillStatus` contract on
 * GET /api/pages/:id/versions.
 *
 * Only the Confluence HTTP boundary is mocked (vi.spyOn on the client
 * method); credentials, RBAC, page resolution, and the version-snapshot
 * writes all run against the real test Postgres. This proves end-to-end:
 *   - `ok`   → backfill ran and page_versions rows were actually written;
 *   - `skipped_no_credentials` → no user_settings row → import never ran,
 *     but the synthetic current row is still returned (the list is never
 *     empty for a resolvable page);
 *   - `failed` → Confluence error is surfaced, current row still returned;
 *   - standalone pages → no backfillStatus at all.
 */

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('GET /api/pages/:id/versions — backfillStatus (#763, real DB)', () => {
  let app: FastifyInstance;
  let userId = '';

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    // Stub auth at the decorator boundary (per repo test rules); userId is a
    // real seeded row so FKs and RBAC lookups resolve against the real DB.
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = userId;
    });
    app.decorate('redis', {} as never);
    app.decorateRequest('userId', '');
    await app.register(pagesVersionRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    // Admin role → getUserAccessibleSpaces grants every known space, so the
    // seeded page's space is accessible without wiring role assignments.
    const u = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('versions_763_admin', 'fakehash', 'admin') RETURNING id`,
    );
    userId = u.rows[0]!.id;
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('DEV', 'Dev space')`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedConfluencePage(confluenceId: string, version: number): Promise<number> {
    const res = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_html, body_text, version, source, last_modified_at, embedding_dirty, embedding_status)
       VALUES ($1, 'DEV', 'Page 763', '<p>live</p>', 'live', $2, 'confluence', NOW(), FALSE, 'not_embedded')
       RETURNING id`,
      [confluenceId, version],
    );
    return res.rows[0]!.id;
  }

  async function seedCredentials(): Promise<void> {
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat)
       VALUES ($1, 'https://confluence.example.com', $2)`,
      [userId, encryptPat('test-pat-763')],
    );
  }

  it('"ok": backfill runs against the (mocked) Confluence boundary and persists rows', async () => {
    const pageId = await seedConfluencePage('c-763-ok', 2);
    await seedCredentials();
    vi.spyOn(ConfluenceClient.prototype, 'getPageVersions').mockResolvedValue([
      { number: 1, when: '2026-01-01T00:00:00Z', author: 'alice', message: 'first draft', minorEdit: false },
    ]);

    const r = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/versions` });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('ok');
    expect(body.backfillDetail).toBeUndefined();
    // Current live row (v2) + the backfilled historical row (v1).
    expect(body.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    expect(body.versions[1]).toMatchObject({ author: 'alice', message: 'first draft', isCurrent: false });
    // The import actually wrote to the real DB.
    const db = await query(
      'SELECT version_number FROM page_versions WHERE page_id = $1',
      [pageId],
    );
    expect(db.rows).toHaveLength(1);
  });

  it('"skipped_no_credentials": no user_settings row → import never runs, current row still returned', async () => {
    const pageId = await seedConfluencePage('c-763-skip', 3);
    const spy = vi
      .spyOn(ConfluenceClient.prototype, 'getPageVersions')
      .mockRejectedValue(new Error('must not be called'));

    const r = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/versions` });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('skipped_no_credentials');
    expect(body.backfillDetail).toMatch(/Settings/);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionNumber: 3, isCurrent: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('"failed": Confluence error during backfill → status surfaced, current row still returned', async () => {
    const pageId = await seedConfluencePage('c-763-fail', 4);
    await seedCredentials();
    vi.spyOn(ConfluenceClient.prototype, 'getPageVersions').mockRejectedValue(
      new Error('Confluence unreachable'),
    );

    const r = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/versions` });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('failed');
    expect(body.backfillDetail).toMatch(/incomplete/i);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionNumber: 4, isCurrent: true });
  });

  it('"failed" with a credentials-specific detail: corrupt stored PAT → decryption throws, Confluence never contacted (#763 follow-up)', async () => {
    const pageId = await seedConfluencePage('c-763-badpat', 2);
    // A stored PAT that is not a valid ciphertext (e.g. written before a
    // PAT_ENCRYPTION_KEY rotation) makes decryptPat() throw inside
    // getClientForUser — client construction fails before any HTTP call.
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat)
       VALUES ($1, 'https://confluence.example.com', 'not-a-valid-ciphertext')`,
      [userId],
    );
    const spy = vi
      .spyOn(ConfluenceClient.prototype, 'getPageVersions')
      .mockRejectedValue(new Error('must not be called'));

    const r = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/versions` });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('failed');
    expect(body.backfillDetail).toMatch(/credentials could not be used/i);
    expect(body.backfillDetail).not.toMatch(/Importing historical versions from Confluence failed/);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionNumber: 2, isCurrent: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('standalone page: backfillStatus is omitted entirely', async () => {
    const res = await query<{ id: number }>(
      `INSERT INTO pages (space_key, title, body_html, body_text, version, source, visibility, created_by_user_id, embedding_dirty, embedding_status)
       VALUES (NULL, 'Local page', '<p>x</p>', 'x', 1, 'standalone', 'shared', $1, FALSE, 'not_embedded')
       RETURNING id`,
      [userId],
    );
    const pageId = res.rows[0]!.id;

    const r = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/versions` });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBeUndefined();
    expect(body.backfillDetail).toBeUndefined();
    expect(body.versions[0]).toMatchObject({ versionNumber: 1, isCurrent: true });
  });
});
