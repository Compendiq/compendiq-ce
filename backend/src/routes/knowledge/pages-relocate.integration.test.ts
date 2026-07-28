/**
 * Integration tests for `POST /api/pages/:id/relocate` (#1123) against a REAL
 * PostgreSQL.
 *
 * Relocate is the only code path that mutates `pages.source` after insert, so
 * it is the only one that changes which identifier flavour a page's children
 * must store in `parent_id`. Every assertion about the tree here runs the same
 * dual-arm join production uses (`p.parent_id = COALESCE(t.confluence_id,
 * t.id::text)`) — a mocked DB would not execute it at all.
 *
 * Only the two real boundaries are stubbed: the Confluence HTTP client (via
 * `getClientForUser`) and the infrastructure side-channels (Redis cache
 * wrapper, audit log). RBAC, the transaction, the advisory lock, the attachment
 * stores and the content converters are all real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query, getPool } from '../../core/db/postgres.js';
import { PAGE_MOVE_ADVISORY_LOCK_ID } from '../../core/db/advisory-locks.js';
import { userHasGlobalPermission } from '../../core/services/rbac-service.js';
import { ConfluenceError } from '../../domains/confluence/services/confluence-client.js';

// The attachment stores resolve their root from ATTACHMENTS_DIR at call time,
// so pointing it at a temp dir before the route is imported keeps every file
// this suite writes inside the sandbox.
const attachmentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-relocate-'));
process.env.ATTACHMENTS_DIR = attachmentsRoot;

// --- Boundary mocks (everything else is real) ---

const h = vi.hoisted(() => ({
  client: {
    createPage: vi.fn(),
    updatePage: vi.fn(),
    updateAttachment: vi.fn(),
    deletePage: vi.fn(),
    getPage: vi.fn(),
  },
  syncRunning: { value: false },
}));

vi.mock('../../core/services/redis-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/services/redis-cache.js')>()),
  RedisCache: class MockRedisCache {
    get = vi.fn().mockResolvedValue(null);
    set = vi.fn().mockResolvedValue(undefined);
    invalidate = vi.fn().mockResolvedValue(undefined);
    invalidateAcrossUsers = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../domains/confluence/services/sync-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../domains/confluence/services/sync-service.js')>()),
  getClientForUser: vi.fn(async () => h.client),
  isSyncRunning: vi.fn(async () => h.syncRunning.value),
}));

const dbAvailable = await isDbAvailable();

// --- Fixtures ---

let userId: string;
let userRole: string;

async function createUser(username: string, role: string): Promise<string> {
  const res = await query<{ id: string }>(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [username, 'x', role],
  );
  return res.rows[0]!.id;
}

async function createSpace(key: string, source: 'confluence' | 'local'): Promise<void> {
  await query(
    'INSERT INTO spaces (space_key, space_name, source) VALUES ($1, $1, $2) ON CONFLICT (space_key) DO NOTHING',
    [key, source],
  );
}

/** Give a user a role holding `permissions` on `spaceKey`. */
async function grantRole(uid: string, spaceKey: string, roleName: string, permissions: string[]): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions) VALUES ($1, $1, FALSE, $2)
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions RETURNING id`,
    [roleName, permissions],
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT (space_key, principal_type, principal_id) DO UPDATE SET role_id = EXCLUDED.role_id`,
    [spaceKey, uid, role.rows[0]!.id],
  );
}

async function createPage(opts: {
  title: string;
  source: 'standalone' | 'confluence';
  confluenceId?: string | null;
  spaceKey?: string | null;
  /** Raw parent_id text: the parent's numeric id as text, or its confluence_id. */
  parentRef?: string | null;
  bodyHtml?: string;
  bodyStorage?: string | null;
  visibility?: 'private' | 'shared';
  ownerId?: string | null;
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage,
                        body_html, inherit_perms, parent_id, visibility, created_by_user_id, version)
     VALUES ($1, $2, $3, $4, 'text', $5, $6, TRUE, $7, $8, $9, 1)
     RETURNING id`,
    [
      opts.confluenceId ?? null,
      opts.source,
      opts.spaceKey ?? null,
      opts.title,
      opts.bodyStorage ?? null,
      opts.bodyHtml ?? '<p>body</p>',
      opts.parentRef ?? null,
      opts.visibility ?? 'shared',
      opts.ownerId ?? null,
    ],
  );
  return res.rows[0]!.id;
}

async function addVersions(pageId: number, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await query(
      'INSERT INTO page_versions (page_id, version_number, title, body_html) VALUES ($1, $2, $3, $4)',
      [pageId, i, `v${i}`, `<p>v${i}</p>`],
    );
  }
}

async function getRow(id: number) {
  const res = await query<{
    id: number;
    source: string;
    space_key: string | null;
    confluence_id: string | null;
    parent_id: string | null;
    visibility: string;
    created_by_user_id: string | null;
    body_html: string | null;
    body_storage: string | null;
  }>(
    `SELECT id, source, space_key, confluence_id, parent_id, visibility,
            created_by_user_id, body_html, body_storage
       FROM pages WHERE id = $1`,
    [id],
  );
  return res.rows[0]!;
}

/**
 * Resolve a page's direct children through the SAME dual-arm join the page
 * tree uses (`pages-crud.ts`: `p.parent_id = COALESCE(t.confluence_id,
 * t.id::text)`). If relocate fails to rewrite `parent_id`, this returns an
 * empty set — which is precisely the silent detach the issue warns about.
 */
async function childrenViaTreeJoin(parentId: number): Promise<number[]> {
  const res = await query<{ id: number }>(
    `SELECT child.id
       FROM pages parent
       JOIN pages child ON child.parent_id = COALESCE(parent.confluence_id, parent.id::text)
      WHERE parent.id = $1 AND child.deleted_at IS NULL
      ORDER BY child.id`,
    [parentId],
  );
  return res.rows.map((r) => r.id);
}

// --- Attachment store helpers ---

/** Store A: the Confluence cache, `<root>/<key>/<file>`. */
async function writeStoreA(key: string, filename: string, content: string): Promise<void> {
  const dir = path.join(attachmentsRoot, key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content);
}

/** Store B: the local store, `<root>/local/<pageId>/<file>` + a DB row. */
async function writeStoreB(pageId: number, filename: string, content: string, uid: string): Promise<void> {
  const dir = path.join(attachmentsRoot, 'local', String(pageId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content);
  await query(
    `INSERT INTO local_attachments (page_id, filename, content_type, size_bytes, sha256, created_by)
     VALUES ($1, $2, 'image/png', $3, 'deadbeef', $4)
     ON CONFLICT (page_id, filename) DO NOTHING`,
    [pageId, filename, content.length, uid],
  );
}

async function storeAFiles(key: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(attachmentsRoot, key))).sort();
  } catch {
    return [];
  }
}

async function storeBFiles(pageId: number): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(attachmentsRoot, 'local', String(pageId)))).sort();
  } catch {
    return [];
  }
}

// --- Suite ---

describe.skipIf(!dbAvailable)('POST /api/pages/:id/relocate (#1123)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: Record<string, unknown>) => {
      request.userId = userId;
      request.userRole = userRole;
      // Mirrors the real auth plugin: admins bypass, everyone else resolves
      // the permission against their actual role assignments.
      request.userCan = async (permission: string, resourceType?: string) => {
        if (userRole === 'admin') return true;
        if (resourceType === 'global') return userHasGlobalPermission(userId, permission);
        return false;
      };
    });
    app.decorate('redis', {});
    const { pagesRelocateRoutes } = await import('./pages-relocate.js');
    await app.register(pagesRelocateRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
    await fs.rm(attachmentsRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    await fs.rm(attachmentsRoot, { recursive: true, force: true });
    await fs.mkdir(attachmentsRoot, { recursive: true });
    h.syncRunning.value = false;
    h.client.createPage.mockReset();
    h.client.updatePage.mockReset();
    h.client.updateAttachment.mockReset().mockResolvedValue({ id: 'att-1' });
    h.client.deletePage.mockReset().mockResolvedValue(undefined);
    h.client.getPage.mockReset();

    userRole = 'admin';
    userId = await createUser('relocator', 'admin');
    await createSpace('CONF', 'confluence');
    await createSpace('LOCAL', 'local');
  });

  function toConfluence(id: number, body: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/pages/${id}/relocate`,
      payload: {
        target: 'confluence',
        spaceKey: 'CONF',
        acknowledgeAccessChange: true,
        acknowledgeDiscardedVersions: 0,
        ...body,
      },
    });
  }

  function toLocal(id: number, confluenceId: string, body: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/pages/${id}/relocate`,
      payload: {
        target: 'local',
        spaceKey: 'LOCAL',
        visibility: 'shared',
        acknowledgeAccessChange: true,
        confirmDeleteConfluencePage: { confluenceId, spaceKey: 'CONF' },
        ...body,
      },
    });
  }

  function createdPage(id: string, storage = '<p>body</p>') {
    return { id, title: 'T', status: 'current', type: 'page', version: { number: 1, when: '' }, body: { storage: { value: storage } } };
  }

  // ── local → Confluence ────────────────────────────────────────────────────

  describe('local → Confluence', () => {
    it('flips the same row in place and keeps dependent rows on the universal page_id', async () => {
      const id = await createPage({ title: 'Article', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      await addVersions(id, 3);
      await query(
        `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding)
         VALUES ($1, 0, 'chunk', $2)`,
        [id, `[${Array(1024).fill(0).join(',')}]`],
      );
      h.client.createPage.mockResolvedValue(createdPage('900001'));

      const res = await toConfluence(id, { acknowledgeDiscardedVersions: 3 });
      expect(res.statusCode).toBe(200);

      const row = await getRow(id);
      expect(row.id).toBe(id); // same row — never delete+recreate
      expect(row.source).toBe('confluence');
      expect(row.confluence_id).toBe('900001');
      expect(row.space_key).toBe('CONF');

      // page_embeddings is keyed on the integer page_id (migration 030) and
      // must survive untouched; page_versions is discarded by decision 3.
      const embeddings = await query('SELECT 1 FROM page_embeddings WHERE page_id = $1', [id]);
      expect(embeddings.rowCount).toBe(1);
      const versions = await query('SELECT 1 FROM page_versions WHERE page_id = $1', [id]);
      expect(versions.rowCount).toBe(0);
      expect(res.json()).toMatchObject({ versionsDiscarded: 3, confluenceId: '900001' });
    });

    it('rewrites every child parent_id to the new confluence_id so the tree still resolves', async () => {
      const parent = await createPage({ title: 'Parent', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      const childA = await createPage({
        title: 'Child A', source: 'standalone', spaceKey: 'LOCAL', parentRef: String(parent), ownerId: userId,
      });
      const childB = await createPage({
        title: 'Child B', source: 'standalone', spaceKey: 'LOCAL', parentRef: String(parent), ownerId: userId,
      });
      const grandchild = await createPage({
        title: 'Grandchild', source: 'standalone', spaceKey: 'LOCAL', parentRef: String(childA), ownerId: userId,
      });
      h.client.createPage.mockResolvedValue(createdPage('900002'));

      expect(await childrenViaTreeJoin(parent)).toEqual([childA, childB]);

      const res = await toConfluence(parent);
      expect(res.statusCode).toBe(200);
      expect(res.json().childrenRepointed).toBe(2);

      expect((await getRow(childA)).parent_id).toBe('900002');
      expect((await getRow(childB)).parent_id).toBe('900002');
      // Children keep their own source and space; only the link is rewritten.
      expect((await getRow(childA)).source).toBe('standalone');
      // The tree still resolves through the dual-arm join.
      expect(await childrenViaTreeJoin(parent)).toEqual([childA, childB]);
      // Edges *inside* the subtree are between rows whose identity did not
      // change, so they must be left alone.
      expect((await getRow(grandchild)).parent_id).toBe(String(childA));
      expect(await childrenViaTreeJoin(childA)).toEqual([grandchild]);
    });

    it('migrates attachments from both stores, uploads them, and re-keys the body references', async () => {
      const id = await createPage({
        title: 'With images',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: userId,
        bodyHtml:
          `<p><img src="/api/attachments/PLACEHOLDER/pasted.png" /></p>` +
          `<p><img src="/api/local-attachments/PLACEHOLDER/diagram.png" /></p>`,
      });
      // Body references are keyed by the page's own id — patch them now that it exists.
      await query('UPDATE pages SET body_html = REPLACE(body_html, $2, $3) WHERE id = $1', [
        id, 'PLACEHOLDER', String(id),
      ]);
      await writeStoreA(String(id), 'pasted.png', 'pasted-bytes');
      await writeStoreB(id, 'diagram.png', 'diagram-bytes', userId);
      h.client.createPage.mockImplementation(async (_s: string, _t: string, storage: string) =>
        createdPage('900003', storage),
      );

      const res = await toConfluence(id);
      expect(res.statusCode).toBe(200);
      expect(res.json().attachmentsMigrated).toBe(2);

      // Both files were uploaded to the NEW page — otherwise the ri:attachment
      // references below would point at files Confluence has never seen.
      const uploaded = h.client.updateAttachment.mock.calls.map((c) => [c[0], c[1]]).sort();
      expect(uploaded).toEqual([['900003', 'diagram.png'], ['900003', 'pasted.png']]);

      const row = await getRow(id);
      // body_html is re-keyed onto the confluence id...
      expect(row.body_html).toContain('/api/attachments/900003/pasted.png');
      expect(row.body_html).toContain('/api/attachments/900003/diagram.png');
      expect(row.body_html).not.toContain('/api/local-attachments/');
      expect(row.body_html).not.toContain(`/api/attachments/${id}/`);
      // ...and body_storage is generated with ri:attachment refs for BOTH
      // images, including the one that came from the local store (which
      // htmlToConfluence's /api/attachments/ selector would otherwise miss).
      expect(row.body_storage).toContain('ri:filename="pasted.png"');
      expect(row.body_storage).toContain('ri:filename="diagram.png"');

      // Files live under the new key; the old keys are cleaned up.
      expect(await storeAFiles('900003')).toEqual(['diagram.png', 'pasted.png']);
      expect(await storeAFiles(String(id))).toEqual([]);
      expect(await storeBFiles(id)).toEqual([]);
      // The local_attachments rows would be permanently unreachable (the local
      // store rejects non-standalone pages), so they are removed.
      const localRows = await query('SELECT 1 FROM local_attachments WHERE page_id = $1', [id]);
      expect(localRows.rowCount).toBe(0);
    });

    it('rejects a confirmation whose version count is stale, changing nothing', async () => {
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      await addVersions(id, 4);

      const res = await toConfluence(id, { acknowledgeDiscardedVersions: 2 });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('4 local version(s)');
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
      const versions = await query('SELECT 1 FROM page_versions WHERE page_id = $1', [id]);
      expect(versions.rowCount).toBe(4);
    });

    it('leaves nothing changed when the upstream create fails', async () => {
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      const child = await createPage({
        title: 'C', source: 'standalone', spaceKey: 'LOCAL', parentRef: String(id), ownerId: userId,
      });
      await addVersions(id, 2);
      h.client.createPage.mockRejectedValue(new ConfluenceError('boom', 500));

      const res = await toConfluence(id, { acknowledgeDiscardedVersions: 2 });

      expect(res.statusCode).toBe(500);
      const row = await getRow(id);
      expect(row.source).toBe('standalone');
      expect(row.confluence_id).toBeNull();
      expect(row.space_key).toBe('LOCAL');
      expect((await getRow(child)).parent_id).toBe(String(id));
      const versions = await query('SELECT 1 FROM page_versions WHERE page_id = $1', [id]);
      expect(versions.rowCount).toBe(2);
    });

    it('deletes the page it just created upstream when a later step fails', async () => {
      const id = await createPage({
        title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId,
        bodyHtml: '<p><img src="/api/attachments/PLACEHOLDER/x.png" /></p>',
      });
      await query('UPDATE pages SET body_html = REPLACE(body_html, $2, $3) WHERE id = $1', [
        id, 'PLACEHOLDER', String(id),
      ]);
      await writeStoreA(String(id), 'x.png', 'bytes');
      h.client.createPage.mockResolvedValue(createdPage('900004'));
      h.client.updateAttachment.mockRejectedValue(new ConfluenceError('upload failed', 500));

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(500);
      // Publishing an article whose ri:attachment refs point at files that were
      // never uploaded is the corruption we refuse to commit.
      expect(h.client.deletePage).toHaveBeenCalledWith('900004');
      const row = await getRow(id);
      expect(row.source).toBe('standalone');
      expect(row.confluence_id).toBeNull();
      expect(row.body_html).toContain(`/api/attachments/${id}/x.png`);
      // The originals are untouched — the copy was staged, never moved.
      expect(await storeAFiles(String(id))).toEqual(['x.png']);
    });

    it('never commits a confluence_id the upstream create did not produce', async () => {
      // detectDeletedPages soft-deletes any row whose confluence_id 404s. A row
      // written before the create is confirmed would lose the user's article.
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      h.client.createPage.mockRejectedValue(new ConfluenceError('nope', 502));

      await toConfluence(id);

      const row = await getRow(id);
      expect(row.confluence_id).toBeNull();
      expect(row.source).toBe('standalone');
    });
  });

  // ── Confluence → local ────────────────────────────────────────────────────

  describe('Confluence → local', () => {
    it('flips the row, clears confluence_id, and deletes the page upstream', async () => {
      const id = await createPage({
        title: 'Synced', source: 'confluence', confluenceId: '700001', spaceKey: 'CONF',
      });

      const res = await toLocal(id, '700001', { visibility: 'private' });
      expect(res.statusCode).toBe(200);

      const row = await getRow(id);
      expect(row.source).toBe('standalone');
      expect(row.confluence_id).toBeNull();
      expect(row.space_key).toBe('LOCAL');
      expect(row.visibility).toBe('private');
      // A private page with a NULL owner would be invisible to everyone,
      // including the mover — the relocating user takes ownership.
      expect(row.created_by_user_id).toBe(userId);
      expect(h.client.deletePage).toHaveBeenCalledWith('700001');
      expect(res.json().upstreamDeleted).toBe(true);
    });

    it('rewrites every child parent_id to the numeric id so the tree still resolves', async () => {
      const parent = await createPage({
        title: 'Parent', source: 'confluence', confluenceId: '700002', spaceKey: 'CONF',
      });
      const childA = await createPage({
        title: 'A', source: 'confluence', confluenceId: '700003', spaceKey: 'CONF', parentRef: '700002',
      });
      const childB = await createPage({
        title: 'B', source: 'confluence', confluenceId: '700004', spaceKey: 'CONF', parentRef: '700002',
      });
      expect(await childrenViaTreeJoin(parent)).toEqual([childA, childB]);

      const res = await toLocal(parent, '700002');
      expect(res.statusCode).toBe(200);
      expect(res.json().childrenRepointed).toBe(2);

      expect((await getRow(childA)).parent_id).toBe(String(parent));
      expect((await getRow(childB)).parent_id).toBe(String(parent));
      expect((await getRow(childA)).source).toBe('confluence');
      expect(await childrenViaTreeJoin(parent)).toEqual([childA, childB]);
    });

    it('moves cached attachments into the local store and re-keys body_html only', async () => {
      const storage = '<p><ac:image><ri:attachment ri:filename="chart.png" /></ac:image></p>';
      const id = await createPage({
        title: 'Imaged',
        source: 'confluence',
        confluenceId: '700005',
        spaceKey: 'CONF',
        bodyHtml: '<p><img src="/api/attachments/700005/chart.png" /></p>',
        bodyStorage: storage,
      });
      await writeStoreA('700005', 'chart.png', 'chart-bytes');

      const res = await toLocal(id, '700005');
      expect(res.statusCode).toBe(200);
      expect(res.json().attachmentsMigrated).toBe(1);

      const row = await getRow(id);
      expect(row.body_html).toContain(`/api/local-attachments/${id}/chart.png`);
      expect(row.body_html).not.toContain('/api/attachments/700005/');
      // body_storage carries `ri:filename` only — no page key — so there is
      // nothing to re-key, and it is preserved verbatim for macro fidelity.
      expect(row.body_storage).toBe(storage);

      expect(await storeBFiles(id)).toEqual(['chart.png']);
      expect(await storeAFiles('700005')).toEqual([]);
      const rows = await query<{ filename: string }>(
        'SELECT filename FROM local_attachments WHERE page_id = $1',
        [id],
      );
      expect(rows.rows.map((r) => r.filename)).toEqual(['chart.png']);
    });

    it('rejects a confirmation that does not name this page and space', async () => {
      const id = await createPage({
        title: 'Synced', source: 'confluence', confluenceId: '700006', spaceKey: 'CONF',
      });

      const wrongId = await toLocal(id, '700006', {
        confirmDeleteConfluencePage: { confluenceId: '999999', spaceKey: 'CONF' },
      });
      expect(wrongId.statusCode).toBe(409);

      const wrongSpace = await toLocal(id, '700006', {
        confirmDeleteConfluencePage: { confluenceId: '700006', spaceKey: 'OTHER' },
      });
      expect(wrongSpace.statusCode).toBe(409);

      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('confluence');
    });

    it('restores the pre-move state when the upstream page is provably still live', async () => {
      const parent = await createPage({
        title: 'Parent', source: 'confluence', confluenceId: '700007', spaceKey: 'CONF',
        bodyHtml: '<p><img src="/api/attachments/700007/pic.png" /></p>',
      });
      const child = await createPage({
        title: 'Child', source: 'confluence', confluenceId: '700008', spaceKey: 'CONF', parentRef: '700007',
      });
      await writeStoreA('700007', 'pic.png', 'bytes');
      h.client.deletePage.mockRejectedValue(new ConfluenceError('server error', 500));
      // The confirmation probe finds the page alive and current.
      h.client.getPage.mockResolvedValue({ id: '700007', status: 'current' });

      const res = await toLocal(parent, '700007');
      expect(res.statusCode).toBe(500);

      const row = await getRow(parent);
      expect(row.source).toBe('confluence');
      expect(row.confluence_id).toBe('700007');
      expect(row.space_key).toBe('CONF');
      expect(row.body_html).toContain('/api/attachments/700007/pic.png');
      expect((await getRow(child)).parent_id).toBe('700007');
      expect(await childrenViaTreeJoin(parent)).toEqual([child]);
      // The staged local rows are rolled back too, so the local store does not
      // start shadowing a page that is still Confluence-backed.
      const rows = await query('SELECT 1 FROM local_attachments WHERE page_id = $1', [parent]);
      expect(rows.rowCount).toBe(0);
    });

    it('treats a 404 from the upstream delete as success', async () => {
      const id = await createPage({
        title: 'Gone', source: 'confluence', confluenceId: '700009', spaceKey: 'CONF',
      });
      h.client.deletePage.mockRejectedValue(new ConfluenceError('not found', 404));

      const res = await toLocal(id, '700009');

      expect(res.statusCode).toBe(200);
      expect(res.json().upstreamDeleted).toBe(true);
      expect((await getRow(id)).source).toBe('standalone');
    });

    it('treats a trashed page as deleted when DELETE reports an error', async () => {
      const id = await createPage({
        title: 'Trashed', source: 'confluence', confluenceId: '700010', spaceKey: 'CONF',
      });
      h.client.deletePage.mockRejectedValue(new ConfluenceError('timeout', 504));
      // DC trashes rather than purges; a trashed page is already gone from the
      // live listing, which is what deletion reconciliation treats as deleted.
      h.client.getPage.mockResolvedValue({ id: '700010', status: 'trashed' });

      const res = await toLocal(id, '700010');

      expect(res.statusCode).toBe(200);
      expect((await getRow(id)).source).toBe('standalone');
    });
  });

  // ── Gates ─────────────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('403s a user without the pages:relocate permission', async () => {
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      userId = await createUser('plain_editor', 'user');
      userRole = 'user';
      await grantRole(userId, 'CONF', 'no_relocate', ['read', 'edit']);

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('pages:relocate');
      expect(h.client.createPage).not.toHaveBeenCalled();
    });

    it('403s a user who holds pages:relocate but cannot write the target space', async () => {
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      await createSpace('OTHER', 'confluence');
      userId = await createUser('relocator_elsewhere', 'user');
      userRole = 'user';
      // The permission is global — held via an assignment on a DIFFERENT space.
      // It must not substitute for write access to the target space.
      await grantRole(userId, 'OTHER', 'relocator', ['read', 'pages:relocate']);

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('Access denied');
      expect(h.client.createPage).not.toHaveBeenCalled();
    });

    it('allows a non-admin holding both the permission and space access', async () => {
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      userId = await createUser('proper_editor', 'user');
      userRole = 'user';
      await grantRole(userId, 'CONF', 'relocator', ['read', 'pages:relocate']);
      h.client.createPage.mockResolvedValue(createdPage('900010'));

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(200);
      expect((await getRow(id)).confluence_id).toBe('900010');
    });

    it('409s while a Confluence sync is in flight', async () => {
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      h.syncRunning.value = true;

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('sync');
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
    });

    it('refuses a move whose new identifier collides with another page', async () => {
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      // Confluence hands back an id that is already some other page's numeric
      // id — children stored under it would resolve to two different parents.
      const other = await createPage({ title: 'Other', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      h.client.createPage.mockResolvedValue(createdPage(String(other)));

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('ambiguous');
      expect(h.client.deletePage).toHaveBeenCalledWith(String(other));
      expect((await getRow(id)).source).toBe('standalone');
    });

    it('serializes on the same advisory lock as PUT /pages/:id/move', async () => {
      // A tree re-parent and a relocate must not interleave: /move writes a
      // parent_id in the flavour the parent has *now*, and relocate changes
      // exactly that flavour. Both take PAGE_MOVE_ADVISORY_LOCK_ID.
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      h.client.createPage.mockResolvedValue(createdPage('900020'));

      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);

        const pending = toConfluence(id);
        const raced = await Promise.race([
          pending.then(() => 'completed' as const),
          new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 300)),
        ]);
        expect(raced).toBe('blocked');
        // The upstream page exists by now, but nothing local has committed.
        expect((await getRow(id)).confluence_id).toBeNull();

        await holder.query('COMMIT');

        expect((await pending).statusCode).toBe(200);
        expect((await getRow(id)).confluence_id).toBe('900020');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('rejects a target that does not match the page source', async () => {
      const local = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      const res = await toLocal(local, 'x');
      expect(res.statusCode).toBe(400);
    });

    it('rejects a body without the explicit acknowledgements', async () => {
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      const res = await app.inject({
        method: 'POST',
        url: `/api/pages/${id}/relocate`,
        payload: { target: 'confluence', spaceKey: 'CONF', acknowledgeDiscardedVersions: 0 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Preview ───────────────────────────────────────────────────────────────

  describe('GET /pages/:id/relocate/preview', () => {
    it('reports the exact counts the confirmation dialog must state', async () => {
      const id = await createPage({
        title: 'Article', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId, visibility: 'private',
        bodyHtml: '<p>x</p>',
      });
      await createPage({ title: 'K1', source: 'standalone', spaceKey: 'LOCAL', parentRef: String(id), ownerId: userId });
      await createPage({ title: 'K2', source: 'standalone', spaceKey: 'LOCAL', parentRef: String(id), ownerId: userId });
      await addVersions(id, 7);
      await writeStoreA(String(id), 'a.png', 'x');
      await writeStoreB(id, 'b.png', 'y', userId);

      const res = await app.inject({ method: 'GET', url: `/api/pages/${id}/relocate/preview` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        pageId: id,
        target: 'confluence',
        childCount: 2,
        attachmentCount: 2,
        localVersionCount: 7,
        upstreamDeletion: null,
      });
    });

    it('names the Confluence page and space a move to local would delete', async () => {
      const id = await createPage({
        title: 'Synced', source: 'confluence', confluenceId: '700100', spaceKey: 'CONF',
      });

      const res = await app.inject({ method: 'GET', url: `/api/pages/${id}/relocate/preview` });

      expect(res.json()).toMatchObject({
        target: 'local',
        localVersionCount: 0,
        upstreamDeletion: { confluenceId: '700100', spaceKey: 'CONF', title: 'Synced' },
      });
    });

    it('names who gains access when a private article is published to a space', async () => {
      const owner = await createUser('owner_alice', 'user');
      const reader = await createUser('reader_bob', 'user');
      await grantRole(reader, 'CONF', 'conf_reader', ['read']);
      const id = await createPage({
        title: 'Secret', source: 'standalone', spaceKey: 'LOCAL', ownerId: owner, visibility: 'private',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/pages/${id}/relocate/preview?spaceKey=CONF`,
      });

      const { accessChange } = res.json();
      expect(accessChange.from).toContain('owner_alice');
      expect(accessChange.to).toContain('CONF');
      expect(accessChange.gains).toContainEqual({ kind: 'user', label: 'reader_bob' });
      // The owner is not assigned to CONF, so publishing costs them access.
      expect(accessChange.loses).toContainEqual({ kind: 'owner', label: 'owner_alice' });
      void reader;
    });

    it('names who loses access when a space page becomes a private local article', async () => {
      const reader = await createUser('reader_carol', 'user');
      await grantRole(reader, 'CONF', 'conf_reader', ['read']);
      const id = await createPage({
        title: 'Synced', source: 'confluence', confluenceId: '700101', spaceKey: 'CONF',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/pages/${id}/relocate/preview?visibility=private`,
      });

      const { accessChange } = res.json();
      expect(accessChange.loses).toContainEqual({ kind: 'user', label: 'reader_carol' });
      expect(accessChange.gains).toEqual([]);
    });

    // ── Review finding B2 ───────────────────────────────────────────────────
    it('403s a preview for a space the caller cannot access, rather than listing its members', async () => {
      await createSpace('SECRET', 'confluence');
      const insider = await createUser('secret_insider', 'user');
      await grantRole(insider, 'SECRET', 'secret_reader', ['read']);

      const id = await createPage({ title: 'Mine', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      // A user with an assignment on CONF only — the page itself is theirs.
      userId = await createUser('nosy', 'user');
      userRole = 'user';
      await grantRole(userId, 'CONF', 'relocator', ['read', 'pages:relocate']);

      const res = await app.inject({
        method: 'GET',
        url: `/api/pages/${id}/relocate/preview?spaceKey=SECRET`,
      });

      // Without the gate this returned 200 with `secret_insider` in `gains`,
      // making the preview a membership-roster oracle for every space.
      expect(res.statusCode).toBe(403);
      expect(res.payload).not.toContain('secret_insider');
      void insider;
    });

    // ── Review finding R6 ───────────────────────────────────────────────────
    it('states that the children detach from the origin tree, not just how many there are', async () => {
      const id = await createPage({ title: 'Parent', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      await createPage({
        title: 'Kid', source: 'standalone', spaceKey: 'LOCAL', parentRef: String(id), ownerId: userId,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/pages/${id}/relocate/preview?spaceKey=CONF`,
      });

      expect(res.json().subtreeEffect).toEqual({
        childrenRemainInSpaceKey: 'LOCAL',
        pageMovesToSpaceKey: 'CONF',
        childrenDetachFromOriginTree: true,
      });
    });

    it('reports no subtree effect for a childless page', async () => {
      const id = await createPage({ title: 'Lonely', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });

      const res = await app.inject({
        method: 'GET',
        url: `/api/pages/${id}/relocate/preview?spaceKey=CONF`,
      });

      expect(res.json().subtreeEffect).toBeNull();
    });
  });

  // ── Regressions from the independent review ───────────────────────────────

  describe('review regressions', () => {
    it('publishes the TRUE attachment filename, not the synthetic cache key (B1)', async () => {
      // The state a Confluence → local move creates: the cache key is the
      // synthetic xref name while `data-confluence-filename` holds the real one.
      const synthetic = 'chart.xref-7726434ef328.png';
      const id = await createPage({
        title: 'Borrowed image', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId,
        bodyHtml:
          `<p><img src="/api/local-attachments/PLACEHOLDER/${synthetic}" ` +
          `data-confluence-image-source="attachment" data-confluence-filename="chart.png" ` +
          `data-confluence-owner-page-title="Other Page" data-confluence-owner-space-key="OTHER"></p>`,
      });
      await query('UPDATE pages SET body_html = REPLACE(body_html, $2, $3) WHERE id = $1', [
        id, 'PLACEHOLDER', String(id),
      ]);
      await writeStoreB(id, synthetic, 'chart-bytes', userId);
      h.client.createPage.mockImplementation(async (_s: string, _t: string, storage: string) =>
        createdPage('900030', storage),
      );

      const res = await toConfluence(id);
      expect(res.statusCode).toBe(200);

      // Uploaded under the real name — uploading the xref name would put a junk
      // file on the page and leave the reference dangling.
      expect(h.client.updateAttachment).toHaveBeenCalledTimes(1);
      expect(h.client.updateAttachment.mock.calls[0]![1]).toBe('chart.png');
      // Cached under the same name, so the regenerated body_html resolves.
      expect(await storeAFiles('900030')).toEqual(['chart.png']);

      const row = await getRow(id);
      expect(row.body_storage).toContain('ri:filename="chart.png"');
      expect(row.body_storage).not.toContain('xref-');
      // The owner element would steer the reference at the page the image was
      // borrowed from, where relocate never uploaded anything.
      expect(row.body_storage).not.toContain('ri:page');
      expect(row.body_html).toContain('/api/attachments/900030/chart.png');
    });

    it('repoints soft-deleted children so restoring one from trash does not orphan it (R1)', async () => {
      const parent = await createPage({
        title: 'Parent', source: 'confluence', confluenceId: '700200', spaceKey: 'CONF',
      });
      const live = await createPage({
        title: 'Live', source: 'confluence', confluenceId: '700201', spaceKey: 'CONF', parentRef: '700200',
      });
      const trashed = await createPage({
        title: 'Trashed', source: 'confluence', confluenceId: '700202', spaceKey: 'CONF', parentRef: '700200',
      });
      await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [trashed]);

      const res = await toLocal(parent, '700200');
      expect(res.statusCode).toBe(200);

      expect((await getRow(live)).parent_id).toBe(String(parent));
      // Skipping this row left it holding a confluence_id no page owns — the
      // link would be unrecoverable the moment it came back from the trash.
      expect((await getRow(trashed)).parent_id).toBe(String(parent));

      await query('UPDATE pages SET deleted_at = NULL WHERE id = $1', [trashed]);
      expect(await childrenViaTreeJoin(parent)).toEqual([live, trashed].sort((a, b) => a - b));
    });

    it('refuses when a soft-deleted row already owns the identifier (R2)', async () => {
      // pages_confluence_id_unique is partial on `confluence_id IS NOT NULL`
      // and does NOT exclude soft-deleted rows, so this would otherwise fail as
      // a constraint violation surfacing as a 500.
      const trashed = await createPage({
        title: 'Trashed', source: 'confluence', confluenceId: '900040', spaceKey: 'CONF',
      });
      await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [trashed]);

      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      h.client.createPage.mockResolvedValue(createdPage('900040'));

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('ambiguous');
      expect(h.client.deletePage).toHaveBeenCalledWith('900040');
      expect((await getRow(id)).source).toBe('standalone');
    });

    it('clears mirrored Confluence restrictions on a move to local (R4)', async () => {
      const id = await createPage({
        title: 'Restricted', source: 'confluence', confluenceId: '700210', spaceKey: 'CONF',
      });
      await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [id]);
      await query(
        `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [id, userId],
      );

      const res = await toLocal(id, '700210');
      expect(res.statusCode).toBe(200);

      // userHasPermission consults ACEs for ANY page with a space_key, and this
      // row keeps one — stale entries would still gate edit rights.
      const aces = await query('SELECT 1 FROM access_control_entries WHERE resource_id = $1', [id]);
      expect(aces.rowCount).toBe(0);
      const row = await query<{ inherit_perms: boolean }>(
        'SELECT inherit_perms FROM pages WHERE id = $1', [id],
      );
      expect(row.rows[0]!.inherit_perms).toBe(true);
    });

    it('restores every column and ACE it touched when the move is compensated (R3, R4)', async () => {
      const id = await createPage({
        title: 'Restricted', source: 'confluence', confluenceId: '700220', spaceKey: 'CONF',
      });
      await query(
        `UPDATE pages SET inherit_perms = FALSE, embedding_dirty = FALSE,
                          embedding_status = 'embedded', last_synced = NOW()
          WHERE id = $1`,
        [id],
      );
      await query(
        `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [id, userId],
      );
      h.client.deletePage.mockRejectedValue(new ConfluenceError('server error', 500));
      h.client.getPage.mockResolvedValue({ id: '700220', status: 'current' });

      const res = await toLocal(id, '700220');
      expect(res.statusCode).toBe(500);

      const row = await query<{
        inherit_perms: boolean;
        local_modified_at: Date | null;
        local_modified_by: string | null;
        embedding_dirty: boolean;
        embedding_status: string | null;
      }>(
        `SELECT inherit_perms, local_modified_at, local_modified_by,
                embedding_dirty, embedding_status FROM pages WHERE id = $1`,
        [id],
      );
      // sync-service treats local_modified_at > last_synced as an unsynced
      // local edit — leaving the move's NOW() behind makes a fully reverted
      // page report a conflict against content identical to upstream.
      expect(row.rows[0]!.local_modified_at).toBeNull();
      expect(row.rows[0]!.local_modified_by).toBeNull();
      expect(row.rows[0]!.inherit_perms).toBe(false);
      expect(row.rows[0]!.embedding_dirty).toBe(false);
      expect(row.rows[0]!.embedding_status).toBe('embedded');

      const aces = await query('SELECT 1 FROM access_control_entries WHERE resource_id = $1', [id]);
      expect(aces.rowCount).toBe(1);
    });
  });
});
