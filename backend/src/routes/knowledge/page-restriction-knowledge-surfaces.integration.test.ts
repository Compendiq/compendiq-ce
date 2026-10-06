/**
 * Page restrictions (`inherit_perms = FALSE` + page ACEs) on the single-page
 * and id-list knowledge surfaces: version history, PDF export, the Confluence
 * attachment cache and bulk ids-mode selection.
 *
 * Real PostgreSQL, Redis, RBAC and filesystem. Only the external boundaries
 * are replaced: the headless-browser PDF renderer and the LLM chat client.
 *
 * R holds a DOCS role and no ACE, G reads the restricted pages through a
 * group ACE, and the administrator keeps today's reach (restricted pages yes,
 * other users' private standalone pages no). For R a restricted page must
 * answer exactly like a page that does not exist.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { resolveBulkSelection } from '../../core/services/bulk-page-selection.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  restrictedLeaks,
  seedRestrictionFixture,
  type RestrictionFixture,
} from './page-restriction.test-helpers.js';
import { attachmentRoutes } from '../confluence/attachments.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { pagesExportRoutes } from './pages-export.js';
import { pagesVersionRoutes } from './pages-versions.js';
import { buildKnowledgeTestApp } from './pages.test-helpers.js';
import type * as LlmProviderResolver from '../../domains/llm/services/llm-provider-resolver.js';
import type * as OpenAiCompatibleClient from '../../domains/llm/services/openai-compatible-client.js';
import type * as PdfService from '../../core/services/pdf-service.js';

// The attachment cache root is resolved at module load, so it must point at
// this suite's directory before any route module is imported. Hoisted code
// runs ahead of the static imports, hence the dynamic ones here.
const { attachmentsRoot, exportedTitles } = await vi.hoisted(async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const root = path.join(os.tmpdir(), `compendiq-restriction-surfaces-${crypto.randomUUID()}`);
  process.env.ATTACHMENTS_DIR = root;
  return { attachmentsRoot: root, exportedTitles: [] as string[] };
});

// External boundary: the headless-browser renderer. Returns a real one-page
// PDF so the batch route's pdf-lib merge runs for real.
vi.mock('../../core/services/pdf-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PdfService>()),
  generatePdf: async (_html: string, opts: { title: string }) => {
    exportedTitles.push(opts.title);
    // The mock factory is hoisted above the static imports.
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage();
    return Buffer.from(await doc.save());
  },
}));

// External boundary: the LLM behind the semantic diff.
vi.mock('../../domains/llm/services/llm-provider-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof LlmProviderResolver>()),
  resolveUsecase: async () => ({ config: {}, model: 'diff-model' }),
}));
vi.mock('../../domains/llm/services/openai-compatible-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof OpenAiCompatibleClient>()),
  chat: async () => 'semantic diff summary',
}));

const available = await isDbAvailable() && await isRedisAvailable();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_DATA_URI = `data:image/png;base64,${PNG.toString('base64')}`;
const MISSING_PAGE_ID = 987_654_321;
const MISSING_CONFLUENCE_ID = 'c-never-existed';

/** `allowed`, `denied`, or a description of an unexpected answer. */
type Verdict = string;

describe.skipIf(!available)('page restrictions on version, export, attachment and bulk surfaces', () => {
  let app: FastifyInstance;
  let redis: RedisClientType;
  let currentUserId = '';
  let fx: RestrictionFixture;
  let leafVersion = 0;

  async function request(
    userId: string,
    url: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    payload?: unknown,
  ): Promise<LightMyRequestResponse> {
    currentUserId = userId;
    return app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  }

  function verdict(response: LightMyRequestResponse, allowedStatus: number): Verdict {
    if (response.statusCode === allowedStatus) return 'allowed';
    if (response.statusCode !== 404) return `unexpected ${response.statusCode} ${response.body}`;
    const leaks = restrictedLeaks(response.body);
    return leaks.length > 0 ? `leaked ${leaks.join(',')}` : 'denied';
  }

  /**
   * One probe per surface against the restricted `Hushed Leaf`. Denials must
   * be 404 (or the missing-page body) without restricted content.
   */
  function surfaceProbes(): Array<[string, (userId: string) => Promise<Verdict>]> {
    const leaf = fx.pages.hushedLeaf;
    return [
      ['version list', async (userId) => {
        const response = await request(userId, `/api/pages/${leaf}/versions`);
        if (response.statusCode !== 200) return `unexpected ${response.statusCode}`;
        const titles = response.json<{ versions: Array<{ title: string }> }>().versions.map((v) => v.title);
        if (titles.includes('Hushed Leaf')) return 'allowed';
        const denied = JSON.stringify(response.json()) === JSON.stringify({ versions: [], pageId: String(leaf) });
        return denied ? 'denied' : `unexpected ${response.body}`;
      }],
      ['version detail', async (userId) =>
        verdict(await request(userId, `/api/pages/${leaf}/versions/${leafVersion}`), 200)],
      ['semantic diff', async (userId) =>
        verdict(await request(userId, `/api/pages/${leaf}/versions/semantic-diff`, 'POST', {
          v1: leafVersion,
          v2: leafVersion,
        }), 200)],
      // Restoring the live version is refused after authorization (400);
      // an unauthorized caller must never get that far.
      ['version restore', async (userId) =>
        verdict(await request(userId, `/api/pages/${leaf}/versions/${leafVersion}/restore`, 'POST', {}), 400)],
      ['single PDF export', async (userId) =>
        verdict(await request(userId, `/api/pages/${leaf}/export/pdf`, 'POST'), 200)],
      ['batch PDF export', async (userId) => {
        exportedTitles.length = 0;
        const response = await request(userId, '/api/pages/export/pdf', 'POST', {
          pageIds: [leaf, fx.pages.openRoot],
        });
        if (response.statusCode !== 200) return `unexpected ${response.statusCode}`;
        return exportedTitles.includes('Hushed Leaf') ? 'allowed' : 'denied';
      }],
      ['attachment list', async (userId) =>
        verdict(await request(userId, '/api/attachments/c-hushed-leaf/list'), 200)],
      ['attachment read', async (userId) =>
        verdict(await request(userId, '/api/attachments/c-hushed-leaf/diagram.png'), 200)],
      // With no Confluence credentials an authorized caller is refused with
      // 400 after admission; an unauthorized one must stop at the lookup.
      ['attachment update admission', async (userId) =>
        verdict(await request(userId, '/api/attachments/c-hushed-leaf/diagram.png', 'PUT', {
          dataUri: PNG_DATA_URI,
        }), 400)],
      ['bulk ids-mode selection', async (userId) => {
        const resolved = await resolveBulkSelection(
          userId,
          { ids: [String(leaf), 'c-hushed-parent'] },
          await getUserAccessibleSpaces(userId),
        );
        const ids = resolved.rows.map((row) => row.id).sort((a, b) => a - b);
        if (ids.length === 2) return 'allowed';
        const denied = ids.length === 0
          && JSON.stringify(resolved.notFoundIds) === JSON.stringify([String(leaf), 'c-hushed-parent']);
        return denied ? 'denied' : `unexpected ${JSON.stringify(resolved)}`;
      }],
    ];
  }

  async function verdicts(userId: string): Promise<Record<string, Verdict>> {
    const out: Record<string, Verdict> = {};
    for (const [surface, probe] of surfaceProbes()) out[surface] = await probe(userId);
    return out;
  }

  function all(value: Verdict): Record<string, Verdict> {
    return Object.fromEntries(surfaceProbes().map(([surface]) => [surface, value]));
  }

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    redis.on('error', () => undefined);
    await redis.connect();
    setRedisClient(redis);

    app = await buildKnowledgeTestApp(() => currentUserId, async (instance) => {
      instance.redis = redis;
      await instance.register(pagesVersionRoutes, { prefix: '/api' });
      await instance.register(pagesExportRoutes, { prefix: '/api' });
      await instance.register(attachmentRoutes, { prefix: '/api' });
      await instance.register(pagesCrudRoutes, { prefix: '/api' });
    });
  });

  afterAll(async () => {
    await app?.close();
    if (redis?.isOpen) await redis.quit();
    setRedisClient(null);
    await truncateAllTables();
    await teardownTestDb();
    await rm(attachmentsRoot, { recursive: true, force: true });
    delete process.env.ATTACHMENTS_DIR;
  });

  beforeEach(async () => {
    await truncateAllTables();
    fx = await seedRestrictionFixture();
    const version = await query<{ version: number }>('SELECT version FROM pages WHERE id = $1', [
      fx.pages.hushedLeaf,
    ]);
    leafVersion = version.rows[0]!.version;
    await rm(attachmentsRoot, { recursive: true, force: true });
    for (const key of ['c-hushed-leaf', String(fx.pages.readerPrivate)]) {
      await mkdir(join(attachmentsRoot, key), { recursive: true });
      await writeFile(join(attachmentsRoot, key, 'diagram.png'), PNG);
    }
    exportedTitles.length = 0;
  });

  it('denies every surface to R, and keeps it for the group ACE holder and the administrator', async () => {
    expect(await verdicts(fx.readerId)).toEqual(all('denied'));
    expect(await verdicts(fx.groupReaderId)).toEqual(all('allowed'));
    expect(await verdicts(fx.adminId)).toEqual(all('allowed'));
  });

  it('revoking the group ACE denies G on the very next request', async () => {
    expect(await verdicts(fx.groupReaderId)).toEqual(all('allowed'));
    await query('DELETE FROM access_control_entries WHERE id = ANY($1::int[])', [fx.groupAceIds]);
    expect(await verdicts(fx.groupReaderId)).toEqual(all('denied'));
  });

  it('answers R for a restricted page exactly as for a page that does not exist', async () => {
    const leaf = fx.pages.hushedLeaf;
    const same = async (
      method: 'GET' | 'POST' | 'PUT',
      restrictedUrl: string,
      missingUrl: string,
      payload?: unknown,
    ) => {
      const restricted = await request(fx.readerId, restrictedUrl, method, payload);
      const missing = await request(fx.readerId, missingUrl, method, payload);
      expect({ url: restrictedUrl, status: restricted.statusCode, body: restricted.body })
        .toEqual({ url: restrictedUrl, status: missing.statusCode, body: missing.body });
    };

    await same('GET', `/api/pages/${leaf}/versions/${leafVersion}`, `/api/pages/${MISSING_PAGE_ID}/versions/${leafVersion}`);
    await same(
      'POST',
      `/api/pages/${leaf}/versions/semantic-diff`,
      `/api/pages/${MISSING_PAGE_ID}/versions/semantic-diff`,
      { v1: 1, v2: 1 },
    );
    await same(
      'POST',
      `/api/pages/${leaf}/versions/${leafVersion}/restore`,
      `/api/pages/${MISSING_PAGE_ID}/versions/${leafVersion}/restore`,
      {},
    );
    await same('POST', `/api/pages/${leaf}/export/pdf`, `/api/pages/${MISSING_PAGE_ID}/export/pdf`);
    await same('GET', '/api/attachments/c-hushed-leaf/list', `/api/attachments/${MISSING_CONFLUENCE_ID}/list`);
    await same(
      'GET',
      '/api/attachments/c-hushed-leaf/diagram.png',
      `/api/attachments/${MISSING_CONFLUENCE_ID}/diagram.png`,
    );
    await same(
      'PUT',
      '/api/attachments/c-hushed-leaf/diagram.png',
      `/api/attachments/${MISSING_CONFLUENCE_ID}/diagram.png`,
      { dataUri: PNG_DATA_URI },
    );

    const batchRestricted = await request(fx.readerId, '/api/pages/export/pdf', 'POST', {
      pageIds: [leaf, fx.pages.hushedParent],
    });
    const batchMissing = await request(fx.readerId, '/api/pages/export/pdf', 'POST', {
      pageIds: [MISSING_PAGE_ID, MISSING_PAGE_ID - 1],
    });
    expect({ status: batchRestricted.statusCode, body: batchRestricted.body })
      .toEqual({ status: batchMissing.statusCode, body: batchMissing.body });

    // No restore intent or snapshot was written on R's behalf.
    const sideEffects = await query<{ intents: string; versions: string }>(
      `SELECT (SELECT COUNT(*) FROM page_write_intents)::text AS intents,
              (SELECT COUNT(*) FROM page_versions WHERE page_id = $1)::text AS versions`,
      [leaf],
    );
    expect(sideEffects.rows[0]).toEqual({ intents: '0', versions: '0' });
  });

  it('bulk routes report a restricted id to R exactly like an unknown id and leave the page untouched', async () => {
    await query(`UPDATE pages SET quality_status = 'analyzed', quality_score = 80 WHERE id = $1`, [
      fx.pages.hushedLeaf,
    ]);
    const response = await request(fx.readerId, '/api/pages/bulk/quality', 'POST', {
      ids: [String(fx.pages.hushedLeaf), String(MISSING_PAGE_ID)],
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ succeeded: number; failed: number; errors: string[] }>();
    expect(body).toMatchObject({ succeeded: 0, failed: 2 });
    expect(body.errors).toEqual([
      body.errors[1]!.replace(String(MISSING_PAGE_ID), String(fx.pages.hushedLeaf)),
      body.errors[1],
    ]);
    const leaf = await query<{ quality_status: string; quality_score: number }>(
      'SELECT quality_status, quality_score FROM pages WHERE id = $1',
      [fx.pages.hushedLeaf],
    );
    expect(leaf.rows[0]).toEqual({ quality_status: 'analyzed', quality_score: 80 });
  });

  it("keeps the administrator out of another user's private standalone page, as before", async () => {
    const note = fx.pages.readerPrivate;
    for (const [userId, expected] of [[fx.readerId, 200], [fx.adminId, 404]] as const) {
      expect((await request(userId, `/api/pages/${note}/versions/1`)).statusCode).toBe(expected);
      expect((await request(userId, `/api/pages/${note}/export/pdf`, 'POST')).statusCode).toBe(expected);
      expect((await request(userId, `/api/attachments/${note}/diagram.png`)).statusCode).toBe(expected);
    }
    const adminBulk = await resolveBulkSelection(
      fx.adminId,
      { ids: [String(note)] },
      await getUserAccessibleSpaces(fx.adminId),
    );
    expect(adminBulk.notFoundIds).toEqual([String(note)]);
  });
});
