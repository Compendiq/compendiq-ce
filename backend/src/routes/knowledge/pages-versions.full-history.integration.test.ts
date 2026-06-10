import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

// #780: mock undici at the HTTP boundary ONLY — `request` is what the
// ConfluenceClient uses for every REST call. Everything else (Agent for
// tls-config, etc.) stays real, as does the entire DB path.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, request: vi.fn() };
});

import { request } from 'undici';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { pagesVersionRoutes } from './pages-versions.js';

const mockRequest = vi.mocked(request);

/**
 * #780 reproduction: GET /api/pages/:id/versions on a Confluence DC page with a
 * long edit history must return EVERY version (current + all historical),
 * newest-first — not just the synthetic current row.
 *
 * Only the Confluence HTTP boundary (undici `request`) is mocked, simulating a
 * real Confluence DATA CENTER instance:
 *   - `GET /rest/experimental/content/{id}/version` → the full paginated list
 *     (this is the only place DC serves the version list);
 *   - `GET /rest/api/content/{id}/version`          → 404 (on DC that path has
 *     no GET collection — only DELETE of a single version exists).
 *
 * Credentials, PAT decryption, RBAC, page resolution, the backfill upserts and
 * the history read all run against the real test Postgres.
 */

const dbAvailable = await isDbAvailable();

function jsonResponse(data: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {},
    body: { text: async () => JSON.stringify(data) },
  } as never;
}

/** Build `count` Confluence version entries, newest-first starting at `from`. */
function versionEntries(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    number: from - i,
    when: `2026-01-01T00:00:${String((from - i) % 60).padStart(2, '0')}Z`,
    by: { displayName: `author-${from - i}` },
    message: `edit ${from - i}`,
    minorEdit: false,
  }));
}

describe.skipIf(!dbAvailable)('GET /api/pages/:id/versions — full history from Confluence DC (#780, real DB)', () => {
  let app: FastifyInstance;
  let userId = '';

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
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
    const u = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('versions_780_admin', 'fakehash', 'admin') RETURNING id`,
    );
    userId = u.rows[0]!.id;
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('DEV', 'Dev space')`);
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat)
       VALUES ($1, 'https://confluence.example.com', $2)`,
      [userId, encryptPat('test-pat-780')],
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedConfluencePage(confluenceId: string, version: number): Promise<number> {
    const res = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_html, body_text, version, source, last_modified_at, embedding_dirty, embedding_status)
       VALUES ($1, 'DEV', 'Page 780', '<p>live</p>', 'live', $2, 'confluence', NOW(), FALSE, 'not_embedded')
       RETURNING id`,
      [confluenceId, version],
    );
    return res.rows[0]!.id;
  }

  /**
   * Simulate a Confluence DATA CENTER instance for one page id:
   * version list only at the experimental path (paginated), 404 on the
   * Cloud-style stable path.
   */
  function mockDataCenter(confluenceId: string, totalVersions: number, pageSize = 100) {
    mockRequest.mockImplementation(async (rawUrl) => {
      const url = new URL(String(rawUrl));
      if (url.pathname === `/rest/experimental/content/${confluenceId}/version`) {
        const start = Number(url.searchParams.get('start') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? String(pageSize));
        const remaining = Math.max(0, totalVersions - start);
        const count = Math.min(limit, remaining, pageSize);
        const results = versionEntries(totalVersions - start, count);
        const hasMore = start + count < totalVersions;
        return jsonResponse({
          results,
          start,
          limit,
          size: results.length,
          _links: hasMore ? { next: `/rest/experimental/content/${confluenceId}/version?start=${start + count}` } : {},
        });
      }
      if (url.pathname === `/rest/api/content/${confluenceId}/version`) {
        // DC: no GET on the stable path — only DELETE of a single version.
        return jsonResponse({ message: 'No resource and method matched' }, 404);
      }
      throw new Error(`Unexpected Confluence request in test: ${String(rawUrl)}`);
    });
  }

  it('returns ALL versions of a multi-version DC page, newest-first, with backfillStatus ok', async () => {
    // 120 versions → exercises pagination (100 + 20) at the HTTP boundary.
    const total = 120;
    const pageId = await seedConfluencePage('780123', total);
    mockDataCenter('780123', total);

    const r = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/versions` });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('ok');
    expect(body.backfillDetail).toBeUndefined();

    // Complete history: the synthetic current row + every historical version.
    expect(body.versions).toHaveLength(total);
    const numbers = body.versions.map((v: { versionNumber: number }) => v.versionNumber);
    expect(numbers).toEqual(Array.from({ length: total }, (_, i) => total - i)); // 120..1, newest-first

    // The live version appears exactly once (the backfilled duplicate of the
    // current version number is dropped in favour of the synthetic row).
    expect(numbers.filter((n: number) => n === total)).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionNumber: total, isCurrent: true });
    expect(body.versions[1]).toMatchObject({
      versionNumber: total - 1,
      isCurrent: false,
      author: `author-${total - 1}`,
      message: `edit ${total - 1}`,
    });

    // The import persisted to the real DB (all 120 metadata rows).
    const db = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM page_versions WHERE page_id = $1',
      [pageId],
    );
    expect(Number(db.rows[0]!.count)).toBe(total);
  });

  it('surfaces a "failed" status with the underlying reason when no version endpoint exists at all', async () => {
    const pageId = await seedConfluencePage('780404', 3);
    // Neither path is served (e.g. a proxy stripping /rest) — both 404.
    mockRequest.mockImplementation(async () => jsonResponse({ message: 'nope' }, 404));

    const r = await app.inject({ method: 'GET', url: `/api/pages/${pageId}/versions` });

    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.backfillStatus).toBe('failed');
    // #780: the dialog must show WHY the import failed (the underlying
    // Confluence error), not only a bare generic hint.
    expect(body.backfillDetail).toMatch(/incomplete/i);
    expect(body.backfillDetail).toMatch(/404/);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ versionNumber: 3, isCurrent: true });
  });
});
