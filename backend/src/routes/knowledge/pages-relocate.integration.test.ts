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
 * PostgreSQL, Redis, RBAC, audit persistence, transactions, advisory locks,
 * attachment stores and converters are real. Only authentication and the
 * outbound Confluence HTTP transport are controlled.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { createClient, type RedisClientType } from 'redis';
import type * as Undici from 'undici';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query, getPool } from '../../core/db/postgres.js';
import {
  ATTACHMENT_SNAPSHOT_LOCK_ID,
  PAGE_MOVE_ADVISORY_LOCK_ID,
} from '../../core/db/advisory-locks.js';
import {
  fencePageWriterRuntime,
  lockPageLifecycle,
  reconcilePageWriteIntent,
} from '../../core/services/page-write-admission.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { userHasGlobalPermission } from '../../core/services/rbac-service.js';
import { ConfluenceError } from '../../domains/confluence/services/confluence-client.js';
import { registerPageRelocateReconciler } from '../../domains/knowledge/services/page-relocate-service.js';


// The attachment stores resolve their root from ATTACHMENTS_DIR at call time,
// so pointing it at a temp dir before the route is imported keeps every file
// this suite writes inside the sandbox.
const attachmentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-relocate-'));
process.env.ATTACHMENTS_DIR = attachmentsRoot;

// --- Boundary mocks (everything else is real) ---

const h = vi.hoisted(() => {
  process.env.CONFLUENCE_RATE_LIMIT_RPM = '100000';
  return {
    createAuthorization: vi.fn(),
    getAuthorization: vi.fn(),
    client: {
      createPage: vi.fn(),
      updatePage: vi.fn(),
      updateAttachment: vi.fn(),
      deletePage: vi.fn(),
      getPage: vi.fn(),
      getPageAttachments: vi.fn(),
      downloadAttachment: vi.fn(),
    },
  };
});

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof Undici>();
  return {
    ...actual,
    request: vi.fn(async (url: string | URL, options: Record<string, unknown> = {}) => {
      const parsed = new URL(String(url));
      const method = String(options.method ?? 'GET');
      const match = parsed.pathname.match(/^\/rest\/api\/content\/([^/]+)$/);
      const attachmentMatch = parsed.pathname.match(/^\/rest\/api\/content\/([^/]+)\/child\/attachment$/);
      try {
        let value: unknown;
        let statusCode = 200;
        if (method === 'POST' && parsed.pathname === '/rest/api/content') {
          const body = JSON.parse(String(options.body)) as {
            space: { key: string };
            title: string;
            body: { storage: { value: string } };
            ancestors?: Array<{ id: string }>;
          };
          h.createAuthorization(
            (options.headers as Record<string, string> | undefined)?.Authorization,
          );
          value = await h.client.createPage(
            body.space.key,
            body.title,
            body.body.storage.value,
            body.ancestors?.[0]?.id,
          );
        } else if (method === 'POST' && attachmentMatch) {
          const pageId = decodeURIComponent(attachmentMatch[1]!);
          const multipart = Buffer.from(options.body as Uint8Array).toString('binary');
          const filename = /filename="([^"]+)"/.exec(multipart)?.[1] ?? '';
          const attachment = await h.client.updateAttachment(pageId, filename);
          value = { results: [attachment] };
        } else if (method === 'DELETE' && match) {
          await h.client.deletePage(decodeURIComponent(match[1]!));
          value = undefined;
          statusCode = 204;
        } else if (method === 'GET' && attachmentMatch) {
          const inventory = await h.client.getPageAttachments(
            decodeURIComponent(attachmentMatch[1]!),
          ) as { results: unknown[] };
          const start = Number(parsed.searchParams.get('start') ?? 0);
          const limit = Number(parsed.searchParams.get('limit') ?? 100);
          const results = inventory.results.slice(start, start + limit);
          value = { ...inventory, results, start, limit, size: results.length };
        } else if (method === 'GET' && match) {
          h.getAuthorization(
            (options.headers as Record<string, string> | undefined)?.Authorization,
          );
          value = await h.client.getPage(decodeURIComponent(match[1]!));
        } else if (method === 'GET' && parsed.pathname.startsWith('/download/attachments/')) {
          const bytes = await h.client.downloadAttachment(parsed.pathname);
          return {
            statusCode: 200,
            headers: {},
            body: {
              text: async () => bytes.toString(),
              async *[Symbol.asyncIterator]() {
                yield bytes;
              },
            },
          };
        } else {
          throw new Error(`Unexpected Confluence request: ${method} ${parsed.pathname}`);
        }
        const text = value === undefined ? '' : JSON.stringify(value);
        return {
          statusCode,
          headers: {},
          body: { text: async () => text },
        };
      } catch (error) {
        let errorStatusCode: number | undefined;
        if (
          error !== null &&
          typeof error === 'object' &&
          'statusCode' in error &&
          typeof error.statusCode === 'number'
        ) {
          errorStatusCode = error.statusCode;
        }
        if (errorStatusCode === undefined) throw error;
        return {
          statusCode: errorStatusCode,
          headers: {},
          body: { text: async () => JSON.stringify({ message: error instanceof Error ? error.message : String(error) }) },
        };
      }
    }),
  };
});

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);


// --- Fixtures ---

let userId: string;
let recoveryAdminId: string;
let userRole: string;
let redis: RedisClientType;

async function createUser(username: string, role: string): Promise<string> {
  const res = await query<{ id: string }>(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [username, 'x', role],
  );
  const id = res.rows[0]!.id;
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, 'https://confluence.test', $2, TRUE)`,
    [id, encryptPat('relocate-test-pat')],
  );
  return id;
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

async function baselineFixtureIds(
  pageId: number,
  actorId: string | null,
): Promise<{ baselineId: string; intentId: string }> {
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
     VALUES ('baseline-fixture', '{"kind":"test"}'::jsonb)
     ON CONFLICT (runtime_id) DO NOTHING`,
  );
  const result = await query<{ id: string; baseline_id: string }>(
    `WITH ids AS (
       SELECT gen_random_uuid() AS id, gen_random_uuid() AS baseline_id
     )
     INSERT INTO page_write_intents (
       id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode,
       effect, status, settled_at, settlement_reason, settlement_proof
     )
     SELECT ids.id, 'baseline-fixture', 'baseline.prepare', $2,
            ARRAY[p.id], jsonb_build_object(
              p.id::text,
              jsonb_build_object(
                'contentRevision', p.content_revision::text,
                'lifecycleRevision', p.lifecycle_revision::text
              )
            ),
            'local_verified',
            jsonb_build_object('effectClass', 'local', 'baselineId', ids.baseline_id::text),
            'completed', NOW(), 'effect_committed', '{}'::jsonb
       FROM ids
       JOIN pages p ON p.id = $1
     RETURNING id, (effect->>'baselineId')::uuid::text AS baseline_id`,
    [pageId, actorId],
  );
  return {
    baselineId: result.rows[0]!.baseline_id,
    intentId: result.rows[0]!.id,
  };
}

async function protectVersionSnapshot(pageId: number, versionNumber: number): Promise<string> {
  const snapshot = await query<{
    id: string;
    title: string;
    body_html: string | null;
    body_text: string | null;
  }>(
    `SELECT id, title, body_html, body_text
       FROM page_versions
      WHERE page_id = $1 AND version_number = $2`,
    [pageId, versionNumber],
  );
  const page = await query<{ content_revision: string; lifecycle_revision: string }>(
    'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1',
    [pageId],
  );
  const row = snapshot.rows[0]!;
  const fixture = await baselineFixtureIds(pageId, null);
  await query(
    `INSERT INTO page_baselines (
       id, page_id, original_page_id, page_identity, version,
       content_revision, lifecycle_revision, manifest_digest, manifest,
       manifest_bytes, title, body_html, body_text, total_bytes, reserved_bytes,
       prepared_by_name, preparation_intent_id, version_snapshot_id
     ) VALUES (
       $10, $1, $1, '[]'::jsonb, $2,
       $3::bigint, $4::bigint, $5, '[]'::jsonb,
       convert_to('[]', 'UTF8'), $6, $7, $8, 0, 0,
       'Relocate retention test', $11, $9
     )`,
    [
      pageId,
      versionNumber,
      page.rows[0]!.content_revision,
      page.rows[0]!.lifecycle_revision,
      '0'.repeat(64),
      row.title,
      row.body_html,
      row.body_text,
      row.id,
      fixture.baselineId,
      fixture.intentId,
    ],
  );
  return row.id;
}

async function freezePage(pageId: number, actorId: string): Promise<void> {
  const page = await query<{
    version: number;
    title: string;
    body_html: string | null;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT version, title, body_html, content_revision::text, lifecycle_revision::text
       FROM pages WHERE id = $1`,
    [pageId],
  );
  const row = page.rows[0]!;
  const fixture = await baselineFixtureIds(pageId, actorId);
  const baseline = await query<{ id: string }>(
    `INSERT INTO page_baselines (
       id, page_id, original_page_id, page_identity, version,
       content_revision, lifecycle_revision, manifest_digest, manifest,
       manifest_bytes, title, body_html, total_bytes, reserved_bytes,
       status, prepared_by_user_id, prepared_by_name, preparation_intent_id,
       published_by_user_id, published_by_name, published_at, provenance, freeze_reason
     ) VALUES (
       $9, $1, $1, '[]'::jsonb, $2,
       $3::bigint, $4::bigint, $5, '[]'::jsonb,
       convert_to('[]', 'UTF8'), $6, $7, 0, 0,
       'published', $8, 'Relocator', $10,
       $8, 'Relocator', NOW(), 'manual_assertion', 'Regression freeze'
     ) RETURNING id`,
    [
      pageId,
      row.version,
      row.content_revision,
      row.lifecycle_revision,
      '1'.repeat(64),
      row.title,
      row.body_html,
      actorId,
      fixture.baselineId,
      fixture.intentId,
    ],
  );
  await query(
    `UPDATE pages SET baseline_id = $2, frozen_version = version, frozen_at = NOW(),
       frozen_by_user_id = $3, frozen_by_name = 'Relocator',
       freeze_reason = 'Regression freeze', freeze_provenance = 'manual_assertion',
       freeze_reported_signatories = '[]'::jsonb
     WHERE id = $1`,
    [pageId, baseline.rows[0]!.id, actorId],
  );
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

async function getPageRevisions(id: number): Promise<{
  content_revision: string;
  lifecycle_revision: string;
}> {
  const result = await query<{
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `SELECT content_revision::text, lifecycle_revision::text
       FROM pages
      WHERE id = $1`,
    [id],
  );
  return result.rows[0]!;
}

async function latestRelocateIntent(pageId: number) {
  const result = await query<{
    id: string;
    runtime_id: string;
    status: string;
    effect_started_at: string | null;
    effect_finished_at: string | null;
    remote_effect_started_at: string | null;
    remote_effects_completed_at: string | null;
    remote_terminal_result: Record<string, unknown> | null;
    settled_at: string | null;
  }>(
    `SELECT id, runtime_id, status, effect_started_at::text, effect_finished_at::text,
            remote_effect_started_at::text, remote_effects_completed_at::text,
            remote_terminal_result, settled_at::text
       FROM page_write_intents
      WHERE kind = 'page.relocate' AND page_ids && ARRAY[$1]::integer[]
      ORDER BY created_at DESC
      LIMIT 1`,
    [pageId],
  );
  return result.rows[0];
}
async function relocationProgress(intentId: string) {
  const result = await query<{
    created_confluence_id: string | null;
    created_page_receipt: Record<string, unknown> | null;
    attachment_receipts: Array<Record<string, unknown>>;
  }>(
    `SELECT created_confluence_id, created_page_receipt, attachment_receipts
       FROM page_relocation_preparations
      WHERE intent_id = $1`,
    [intentId],
  );
  return result.rows[0];
}


async function withFencedIntentRuntime<T>(
  intent: { id: string; runtime_id: string },
  operation: () => Promise<T>,
): Promise<T> {
  const retiredRuntime = `retired-relocation-${randomUUID()}`;
  await query(
    `INSERT INTO page_writer_runtimes
       (runtime_id, deployment_identity, fenced_at, fence_reason, fence_proof)
     SELECT $2, '{"fixture":"terminated relocation writer"}'::jsonb, NOW(),
            'Integration test simulates a terminated relocation writer',
            '{"kind":"verified_local_termination"}'::jsonb
       FROM page_write_intents
      WHERE id = $1 AND recovery_started_at IS NULL`,
    [intent.id, retiredRuntime],
  );
  await query(
    `UPDATE page_write_intents
        SET runtime_id = $2
      WHERE id = $1 AND recovery_started_at IS NULL`,
    [intent.id, retiredRuntime],
  );
  return operation();
}

async function seedInterruptedLocalCutover(
  pageId: number,
  confluenceId: string,
  actorId: string,
  options: { cutover?: boolean; includeAttachment?: boolean } = {},
): Promise<string> {
  const original = (await query<{
    title: string;
    source: string;
    confluence_id: string | null;
    space_key: string | null;
    body_html: string | null;
    body_storage: string | null;
    body_text: string | null;
    version: number;
    visibility: string;
    created_by_user_id: string | null;
    inherit_perms: boolean;
    local_modified_at: Date | null;
    local_modified_by: string | null;
    embedding_dirty: boolean;
    image_analysis_dirty: boolean;
    embedding_status: string | null;
    embedded_at: Date | null;
  }>(
    `SELECT title, source, confluence_id, space_key, body_html, body_storage, body_text,
            version, visibility, created_by_user_id, inherit_perms, local_modified_at,
            local_modified_by, embedding_dirty, image_analysis_dirty, embedding_status, embedded_at
       FROM pages WHERE id = $1`,
    [pageId],
  )).rows[0]!;
  const aces = (await query<{
    principal_type: string;
    principal_id: string;
    permission: string;
  }>(
    `SELECT principal_type, principal_id, permission
       FROM access_control_entries
      WHERE resource_type = 'page' AND resource_id = $1
      ORDER BY principal_type, principal_id, permission`,
    [pageId],
  )).rows;
  const cutover = options.cutover ?? true;
  const includeAttachment = options.includeAttachment ?? true;
  const attachmentBytes = Buffer.from('crash-bytes');
  if (includeAttachment) {
    await writeStoreB(pageId, 'crash.png', attachmentBytes.toString(), actorId);
  }
  if (cutover) {
    await query(
      `UPDATE pages SET
         source = 'standalone',
         confluence_id = NULL,
         space_key = 'LOCAL',
         visibility = 'shared',
         created_by_user_id = $2,
         body_html = REPLACE(body_html, $3, $4),
         inherit_perms = TRUE,
         embedding_dirty = TRUE,
         image_analysis_dirty = TRUE,
         embedding_status = 'not_embedded',
         embedded_at = NULL,
         local_modified_at = NOW(),
         local_modified_by = $2
       WHERE id = $1`,
      [
        pageId,
        actorId,
        `/api/attachments/${confluenceId}/`,
        `/api/local-attachments/${pageId}/`,
      ],
    );
    await query(
      "DELETE FROM access_control_entries WHERE resource_type = 'page' AND resource_id = $1",
      [pageId],
    );
  }
  const revisions = (await query<{ content_revision: string; lifecycle_revision: string }>(
    'SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1',
    [pageId],
  )).rows[0]!;
  const runtimeId = `relocate-crash-${pageId}`;
  await query(
    `INSERT INTO page_writer_runtimes (
       runtime_id, deployment_identity, fenced_at, fence_reason, fence_proof
     ) VALUES (
       $1, '{"kind":"test"}'::jsonb, NOW(),
       'Integration test simulates a terminated relocation writer',
       '{"kind":"verified_local_termination"}'::jsonb
     )`,
    [runtimeId],
  );
  const intent = await query<{ id: string }>(
    `INSERT INTO page_write_intents (
       runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
       effect_started_at, effect_finished_at
     ) VALUES (
       $1, 'page.relocate', $2, ARRAY[$3]::integer[], $4::jsonb,
       'remote_terminal_only', $5::jsonb, NOW(), NOW()
     ) RETURNING id`,
    [
      runtimeId,
      actorId,
      pageId,
      JSON.stringify({
        [pageId]: {
          contentRevision: revisions.content_revision,
          lifecycleRevision: revisions.lifecycle_revision,
        },
      }),
      JSON.stringify({
        effectClass: 'remote',
        pageId,
        target: 'local',
        fromSource: 'confluence',
        fromConfluenceId: confluenceId,
        fromSpaceKey: 'CONF',
        targetSpaceKey: 'LOCAL',
        affectedPageIds: [pageId],
      }),
    ],
  );
  await query(
    `INSERT INTO page_relocation_preparations (
       intent_id, page_id, direction, actor_id, target_space_key, target_visibility,
       original_source, original_confluence_id, original_space_key, original_title,
       original_body_html, original_body_storage, original_body_text, original_version,
       original_visibility, original_created_by_user_id, original_inherit_perms,
       original_local_modified_at, original_local_modified_by, original_embedding_dirty,
       original_image_analysis_dirty, original_embedding_status, original_embedded_at,
       original_key, child_ids, access_control_entries, attachments,
       expected_remote_title_sha256, expected_remote_body_storage_sha256, parent_confluence_id
     ) VALUES (
       $1, $2, 'to_local', $3, 'LOCAL', 'shared',
       $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13, $14,
       $15, $16, $17,
       $18, $19, $20,
       $5, '{}'::integer[], $21::jsonb, $22::jsonb,
       $23, $24, NULL
     )`,
    [
      intent.rows[0]!.id,
      pageId,
      actorId,
      original.source,
      original.confluence_id,
      original.space_key,
      original.title,
      original.body_html,
      original.body_storage,
      original.body_text,
      original.version,
      original.visibility,
      original.created_by_user_id,
      original.inherit_perms,
      original.local_modified_at,
      original.local_modified_by,
      original.embedding_dirty,
      original.image_analysis_dirty,
      original.embedding_status,
      original.embedded_at,
      JSON.stringify(aces),
      JSON.stringify(includeAttachment ? [{
        sourceName: 'crash.png',
        targetName: 'crash.png',
        contentType: 'image/png',
        size: attachmentBytes.length,
        sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
      }] : []),
      createHash('sha256').update(original.title).digest('hex'),
      createHash('sha256').update(original.body_storage ?? '').digest('hex'),
    ],
  );
  return intent.rows[0]!.id;
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

async function waitForDatabaseBlocker(blockerPid: number): Promise<boolean> {
  return waitForDatabaseCondition(async () => {
    const result = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE $1 = ANY(pg_blocking_pids(pid))
       ) AS waiting`,
      [blockerPid],
    );
    return result.rows[0]?.waiting ?? false;
  });
}

async function waitForBlockedDatabasePid(blockerPid: number): Promise<number | null> {
  let blockedPid: number | null = null;
  await waitForDatabaseCondition(async () => {
    const result = await query<{ pid: number }>(
      `SELECT pid
         FROM pg_stat_activity
        WHERE $1 = ANY(pg_blocking_pids(pid))
        ORDER BY pid
        LIMIT 1`,
      [blockerPid],
    );
    blockedPid = result.rows[0]?.pid ?? null;
    return blockedPid !== null;
  });
  return blockedPid;
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

describe.skipIf(!dbAvailable || !redisAvailable)('POST /api/pages/:id/relocate (#1123)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    });
    await redis.connect();
    registerPageRelocateReconciler();
    setRedisClient(redis);

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
    app.decorate('redis', redis);
    const { pagesRelocateRoutes } = await import('./pages-relocate.js');
    await app.register(pagesRelocateRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
    await fs.rm(attachmentsRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    await redis.flushDb();
    await fs.rm(attachmentsRoot, { recursive: true, force: true });
    await fs.mkdir(attachmentsRoot, { recursive: true });
    await redis.del('sync:worker:lock');
    h.client.createPage.mockReset();
    h.client.updatePage.mockReset();
    h.client.updateAttachment.mockReset().mockImplementation(
      async (_pageId: string, filename: string) => ({
        id: `att-${filename}`,
        title: filename,
        mediaType: 'image/png',
        extensions: { fileSize: 0 },
        version: { number: 1 },
      }),
    );
    h.client.deletePage.mockReset().mockResolvedValue(undefined);
    h.client.getPage.mockReset();
    h.client.getPageAttachments.mockReset().mockResolvedValue({
      results: [],
      start: 0,
      limit: 100,
      size: 0,
    });
    h.client.downloadAttachment.mockReset();

    userRole = 'admin';
    userId = await createUser('relocator', 'admin');
    recoveryAdminId = await createUser(`relocation-recovery-admin-${randomUUID()}`, 'admin');
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

  function createdPage(id: string, storage = '<p>body</p>', title = 'A') {
    return { id, title, status: 'current', type: 'page', version: { number: 1, when: '' }, body: { storage: { value: storage } } };
  }

  function resolveCreatedPage(id: string): void {
    h.client.createPage.mockImplementation(
      async (_space: string, title: string, storage: string) =>
        createdPage(id, storage, title),
    );
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
      h.client.createPage.mockResolvedValue(createdPage('900001', '<p>body</p>', 'Article'));

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
      expect(await latestRelocateIntent(id)).toMatchObject({
        status: 'completed',
        effect_started_at: expect.any(String),
        effect_finished_at: expect.any(String),
        settled_at: expect.any(String),
      });
    });

    it('retains a baseline-protected version while discarding ordinary local history', async () => {
      const id = await createPage({
        title: 'Protected history',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: userId,
      });
      await addVersions(id, 3);
      const protectedId = await protectVersionSnapshot(id, 1);
      h.client.createPage.mockResolvedValue(createdPage('900011', '<p>body</p>', 'Protected history'));

      const res = await toConfluence(id, { acknowledgeDiscardedVersions: 3 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ versionsDiscarded: 2 });

      const versions = await query<{ id: string; version_number: number }>(
        'SELECT id, version_number FROM page_versions WHERE page_id = $1',
        [id],
      );
      expect(versions.rows).toEqual([{ id: protectedId, version_number: 1 }]);
      const link = await query<{ version_snapshot_id: string | null }>(
        'SELECT version_snapshot_id FROM page_baselines WHERE original_page_id = $1',
        [id],
      );
      expect(link.rows[0]!.version_snapshot_id).toBe(protectedId);
    });

    it('refuses relocating a frozen page before any remote create or attachment write', async () => {
      const id = await createPage({
        title: 'Frozen',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: userId,
      });
      await freezePage(id, userId);

      const res = await toConfluence(id);
      expect(res.statusCode).toBe(423);
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect(h.client.updateAttachment).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
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
      h.client.createPage.mockResolvedValue(createdPage('900002', '<p>body</p>', 'Parent'));

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
      h.client.createPage.mockImplementation(async (_s: string, title: string, storage: string) =>
        createdPage('900003', storage, title),
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


    it('never deletes the committed upstream page when protected filesystem cleanup fails', async () => {
      const id = await createPage({
        title: 'Committed cleanup failure',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: userId,
        bodyHtml: '<p><img src="/api/attachments/PLACEHOLDER/pic.png" /></p>',
      });
      await query('UPDATE pages SET body_html = REPLACE(body_html, $2, $3) WHERE id = $1', [
        id, 'PLACEHOLDER', String(id),
      ]);
      await writeStoreA(String(id), 'pic.png', 'bytes');
      h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) =>
        createdPage('900100', storage, title),
      );

      const oldCacheDir = path.resolve(attachmentsRoot, String(id));
      await fs.chmod(oldCacheDir, 0o500);

      let response: { statusCode: number } | undefined;
      try {
        response = await toConfluence(id);
      } finally {
        await fs.chmod(oldCacheDir, 0o700);
      }

      expect(response?.statusCode).toBe(500);
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect(await getRow(id)).toMatchObject({
        source: 'standalone',
        confluence_id: null,
      });
      const intent = await latestRelocateIntent(id);
      expect(intent).toMatchObject({
        status: 'pending',
        effect_started_at: expect.any(String),
        remote_effect_started_at: expect.any(String),
        remote_effects_completed_at: expect.any(String),
        settled_at: null,
      });

      const acceptedStorage = h.client.createPage.mock.calls[0]![2] as string;
      const terminalAttachments = (
        (await relocationProgress(intent!.id))!.attachment_receipts as Array<{
          id: string;
          title: string;
          version: number;
          mediaType: string | null;
          fileSize: number | null;
        }>
      );
      h.client.getPageAttachments.mockResolvedValue({
        results: terminalAttachments.map((attachment) => ({
          id: attachment.id,
          title: attachment.title,
          mediaType: attachment.mediaType,
          extensions: { fileSize: attachment.fileSize },
          version: { number: attachment.version },
        })),
        start: 0,
        limit: 100,
        size: terminalAttachments.length,
      });
      h.client.getPage.mockResolvedValue({
        ...createdPage('900100', `${acceptedStorage}<p>changed</p>`, 'Committed cleanup failure'),
        version: { number: 2, when: '' },
      });
      await withFencedIntentRuntime(intent!, () =>
        expect(reconcilePageWriteIntent(intent!.id, { actorId: recoveryAdminId, reason: 'Changed provider page content must retain the interrupted relocation', })).rejects.toMatchObject({ reason: 'intent_terminal_evidence_mismatch' }),
      );

      h.client.getPage.mockResolvedValue(
        createdPage('900100', acceptedStorage, 'Committed cleanup failure'),
      );
      h.client.getPageAttachments.mockResolvedValue({
        results: [],
        start: 0,
        limit: 100,
        size: 0,
      });
      await withFencedIntentRuntime(intent!, () =>
        expect(reconcilePageWriteIntent(intent!.id, { actorId: recoveryAdminId, reason: 'Missing provider attachment receipt must retain the interrupted relocation', })).rejects.toMatchObject({ reason: 'intent_terminal_evidence_mismatch' }),
      );
      expect(await latestRelocateIntent(id)).toMatchObject({ status: 'pending', settled_at: null });
      expect((await query(
        'SELECT 1 FROM page_relocation_preparations WHERE intent_id = $1',
        [intent!.id],
      )).rowCount).toBe(1);

      h.client.getPageAttachments.mockResolvedValue({
        results: terminalAttachments.map((attachment) => ({
          id: attachment.id,
          title: attachment.title,
          mediaType: attachment.mediaType,
          extensions: { fileSize: attachment.fileSize },
          version: { number: attachment.version },
        })),
        start: 0,
        limit: 100,
        size: terminalAttachments.length,
      });
      await withFencedIntentRuntime(intent!, () =>
        expect(reconcilePageWriteIntent(intent!.id, { actorId: recoveryAdminId, reason: 'Exact provider receipts permit the interrupted local publication', })).resolves.toEqual({ intentId: intent!.id, status: 'reconciled_applied' }),
      );
      expect(await getRow(id)).toMatchObject({
        source: 'confluence',
        confluence_id: '900100',
        space_key: 'CONF',
      });
      expect(await storeAFiles(String(id))).toEqual([]);
      expect(await storeAFiles('900100')).toEqual(['pic.png']);
      expect((await query(
        'SELECT 1 FROM page_relocation_preparations WHERE intent_id = $1',
        [intent!.id],
      )).rowCount).toBe(0);
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

    it('names the attachment in a 400 when a local row holds an unstorable filename (#1169)', async () => {
      // The cache lister screens hidden names out, but `local_attachments`
      // filenames come from the DB, so a row written outside `localFilePath`
      // still reaches the read. A 500 would be masked to "Internal Server
      // Error" by app.ts — only a 4xx can tell the user which file to fix.
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      await writeStoreB(id, '.hidden.png', 'bytes', userId);

      // The preview counts the same filenames, so it must survive the row too —
      // it 500'd before the dialog could even open.
      const preview = await app.inject({ method: 'GET', url: `/api/pages/${id}/relocate/preview` });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().attachmentCount).toBe(1);

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('.hidden.png');
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
    });

    it('refuses the move with a named 400 when a LOCAL-store attachment is there but cannot be read', async () => {
      // The cached reader already aborted the move on a read failure; the
      // local-store fallback swallowed it and answered `null`, so a
      // standalone page's `EACCES`-locked file was quietly left behind under
      // the "missing on disk; it was not published" warning on a 200. And a
      // propagated read failure reached the route as a bare `Error`, which
      // app.ts masks to "Internal Server Error" (#1626 review r3).
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      await writeStoreB(id, 'locked.png', 'locked-bytes', userId);
      resolveCreatedPage('900200');

      const lockedPath = path.resolve(attachmentsRoot, 'local', String(id), 'locked.png');
      await fs.chmod(lockedPath, 0o000);

      let res;
      try {
        res = await toConfluence(id);
      } finally {
        await fs.chmod(lockedPath, 0o600);
      }

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Attachment "locked.png" cannot be moved');
      expect(res.json().error).toContain('permissions');
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
    });

    it('refuses an over-long local filename by name too, not just a hidden one (#1169)', async () => {
      // The two stores enforce different rules — the local one caps at 255
      // characters, the Confluence one does not — so the guard has to ask both.
      // The *file* cannot exist at this length on any real filesystem, but the
      // *row* can, and the row is what the guard reasons about: gating on the
      // Confluence rule alone let this warn past as "missing on disk".

      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      const longName = `${'a'.repeat(300)}.png`;
      await query(
        `INSERT INTO local_attachments (page_id, filename, content_type, size_bytes, sha256, created_by)
         VALUES ($1, $2, 'image/png', 1, 'deadbeef', $3)`,
        [id, longName, userId],
      );
      // Let the upstream create succeed, so a failure here is the guard's doing
      // and not a half-configured mock.
      resolveCreatedPage('900030');

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain(longName);
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
    });
    it('preserves the standalone source cache when Confluence reuses its numeric key', async () => {
      const id = await createPage({
        title: 'Same numeric key',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: userId,
        bodyHtml: '<p><img src="/api/attachments/PLACEHOLDER/pic.png" /></p>',
      });
      await query('UPDATE pages SET body_html = REPLACE(body_html, $2, $3) WHERE id = $1', [
        id,
        'PLACEHOLDER',
        String(id),
      ]);
      await writeStoreA(String(id), 'pic.png', 'source-bytes');
      h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) =>
        createdPage(String(id), storage, title),
      );
      h.client.updateAttachment.mockRejectedValue(new ConfluenceError('upload failed', 500));

      const response = await toConfluence(id);

      expect(response.statusCode).toBe(500);
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect(await getRow(id)).toMatchObject({ source: 'standalone', confluence_id: null });
      expect(await storeAFiles(String(id))).toEqual(['pic.png']);
      expect(await fs.readFile(path.join(attachmentsRoot, String(id), 'pic.png'), 'utf8'))
        .toBe('source-bytes');
      const intent = await latestRelocateIntent(id);
      expect(intent).toMatchObject({
        status: 'pending',
        remote_effect_started_at: expect.any(String),
        remote_effects_completed_at: null,
      });
      expect(await relocationProgress(intent!.id)).toMatchObject({
        created_confluence_id: String(id),
        created_page_receipt: {
          id: String(id),
          version: 1,
        },
        attachment_receipts: [],
      });
      await withFencedIntentRuntime(intent!, () =>
        expect(reconcilePageWriteIntent(intent!.id, { actorId: recoveryAdminId, reason: 'An unknown attachment upload cannot be inferred from current provider state', })).rejects.toMatchObject({ reason: 'intent_outcome_unrecoverable' }),
      );
      expect(h.client.updateAttachment).toHaveBeenCalledTimes(1);
      expect(h.client.deletePage).not.toHaveBeenCalled();
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
    it.each([false, true])(
      'does not read back a compact create after integration is disabled (attachments remaining: %s)',
      async (withAttachment) => {
        const id = await createPage({
          title: 'Disabled compact create', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId,
        });
        if (withAttachment) await writeStoreB(id, 'proof.png', 'proof-bytes', userId);
        h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) => {
          h.client.getPage.mockResolvedValue(createdPage('900006', storage, title));
          await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [userId]);
          return { id: '900006' };
        });

        const response = await toConfluence(id);
        expect(response.statusCode).toBe(409);
        expect(h.client.getPage).not.toHaveBeenCalled();
        expect(h.client.updateAttachment).not.toHaveBeenCalled();
        expect(h.client.deletePage).not.toHaveBeenCalled();
        expect(await getRow(id)).toMatchObject({ source: 'standalone', confluence_id: null });
        const intent = await latestRelocateIntent(id);
        expect(intent?.status).toBe('pending');
        expect(await relocationProgress(intent!.id)).toMatchObject({ created_confluence_id: '900006' });
      },
    );

    it.each([false, true])(
      'uses a rotated PAT for compact-create readback (attachments remaining: %s)',
      async (withAttachment) => {
        const id = await createPage({
          title: 'Rotated compact create', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId,
        });
        if (withAttachment) await writeStoreB(id, 'proof.png', 'proof-bytes', userId);
        h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) => {
          h.client.getPage.mockResolvedValue(createdPage('900007', storage, title));
          await query('UPDATE user_settings SET confluence_pat = $2 WHERE user_id = $1', [
            userId, encryptPat('rotated-compact-pat'),
          ]);
          return { id: '900007' };
        });

        const response = await toConfluence(id);
        expect(response.statusCode).toBe(200);
        expect(h.createAuthorization).toHaveBeenCalledWith('Bearer relocate-test-pat');
        expect(h.getAuthorization).toHaveBeenCalledTimes(1);
        expect(h.getAuthorization).toHaveBeenCalledWith('Bearer rotated-compact-pat');
        expect(await getRow(id)).toMatchObject({ source: 'confluence', confluence_id: '900007' });
      },
    );

    it('retains and recovers a receipt inventory larger than generic intent metadata', async () => {
      const id = await createPage({
        title: 'Large receipt inventory', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId,
      });
      const filenames = Array.from({ length: 128 }, (_, index) =>
        `attachment-${String(index).padStart(3, '0')}-${'x'.repeat(210)}.png`);
      for (const filename of filenames) {
        await writeStoreB(id, filename, 'image-bytes', userId);
      }
      const uploadedReceipts: Array<{
        id: string; title: string; mediaType: string;
        extensions: { fileSize: number }; version: { number: number };
      }> = [];
      h.client.updateAttachment.mockImplementation(async (_pageId: string, filename: string) => {
        const receipt = {
          id: String(9000000 + uploadedReceipts.length),
          title: filename,
          mediaType: 'image/png',
          extensions: { fileSize: 11 },
          version: { number: 1 },
        };
        uploadedReceipts.push(receipt);
        return receipt;
      });
      let acceptedStorage = '';
      h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) => {
        acceptedStorage = storage;
        return createdPage('900008', storage, title);
      });
      await query(`ALTER TABLE pages ADD CONSTRAINT fail_large_receipt_publication
        CHECK (id <> ${id} OR source <> 'confluence')`);
      try {
        const response = await toConfluence(id);
        expect(response.statusCode).toBe(500);
      } finally {
        await query('ALTER TABLE pages DROP CONSTRAINT fail_large_receipt_publication');
      }
      expect(h.client.updateAttachment).toHaveBeenCalledTimes(filenames.length);
      expect(h.client.deletePage).not.toHaveBeenCalled();
      const intent = await latestRelocateIntent(id);
      expect(intent).toMatchObject({
        status: 'pending', remote_effects_completed_at: expect.any(String),
      });
      const inventory = await relocationProgress(intent!.id);
      expect(inventory!.attachment_receipts).toHaveLength(filenames.length);
      expect(Buffer.byteLength(JSON.stringify(inventory!.attachment_receipts))).toBeGreaterThan(32768);
      expect(Buffer.byteLength(JSON.stringify(intent!.remote_terminal_result))).toBeLessThan(32768);
      h.client.getPage.mockResolvedValue(createdPage('900008', acceptedStorage, 'Large receipt inventory'));
      h.client.getPageAttachments.mockResolvedValue({
        results: uploadedReceipts,
        start: 0,
        limit: filenames.length,
        size: filenames.length,
      });

      // Matching current provider state cannot rewrite the acknowledged receipt.
      uploadedReceipts[0]!.version.number = 2;
      await query(
        `UPDATE page_relocation_preparations
            SET attachment_receipts = jsonb_set(attachment_receipts, '{0,version}', '2'::jsonb)
          WHERE intent_id = $1`,
        [intent!.id],
      );
      await withFencedIntentRuntime(intent!, () =>
        expect(reconcilePageWriteIntent(intent!.id, { actorId: recoveryAdminId, reason: 'A changed durable receipt cannot be adopted from matching current provider state', })).rejects.toMatchObject({ reason: 'intent_terminal_result_invalid' }),
      );
      expect((await getRow(id)).source).toBe('standalone');
      uploadedReceipts[0]!.version.number = 1;
      await query(
        `UPDATE page_relocation_preparations
            SET attachment_receipts = jsonb_set(attachment_receipts, '{0,version}', '1'::jsonb)
          WHERE intent_id = $1`,
        [intent!.id],
      );

      await withFencedIntentRuntime(intent!, () =>
        expect(reconcilePageWriteIntent(intent!.id, { actorId: recoveryAdminId, reason: 'Recover all acknowledged attachments without the generic metadata size limit', })).resolves.toEqual({ intentId: intent!.id, status: 'reconciled_applied' }),
      );
      expect(h.client.createPage).toHaveBeenCalledTimes(1);
      expect(h.client.updateAttachment).toHaveBeenCalledTimes(filenames.length);
      expect(await getRow(id)).toMatchObject({ source: 'confluence', confluence_id: '900008' });
      expect(await relocationProgress(intent!.id)).toBeUndefined();
    });

    it('recovers a compact create readback failure when no provider mutation remains', async () => {
      const id = await createPage({
        title: 'Compact create',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: userId,
      });
      let acceptedStorage = '';
      h.client.createPage.mockImplementation(async (_space: string, _title: string, storage: string) => {
        acceptedStorage = storage;
        return { id: '900004' };
      });
      h.client.getPage.mockRejectedValue(new ConfluenceError('readback unavailable', 503));

      const response = await toConfluence(id);

      expect(response.statusCode).toBe(503);
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect(h.client.updateAttachment).not.toHaveBeenCalled();
      expect(await getRow(id)).toMatchObject({
        source: 'standalone',
        confluence_id: null,
        space_key: 'LOCAL',
      });
      const intent = await latestRelocateIntent(id);
      expect(intent).toMatchObject({
        status: 'pending',
        remote_effect_started_at: expect.any(String),
        remote_effects_completed_at: expect.any(String),
        remote_terminal_result: {
          outcome: 'committed',
          createdConfluenceId: '900004',
          page: null,
        },
      });
      expect(await relocationProgress(intent!.id)).toEqual({
        created_confluence_id: '900004',
        created_page_receipt: null,
        attachment_receipts: [],
      });

      h.client.getPage.mockResolvedValue(
        createdPage('900004', acceptedStorage, 'Compact create'),
      );
      await withFencedIntentRuntime(intent!, () =>
        expect(reconcilePageWriteIntent(intent!.id, { actorId: recoveryAdminId, reason: 'Read-only verification can publish an acknowledged compact create', })).resolves.toEqual({ intentId: intent!.id, status: 'reconciled_applied' }),
      );

      expect(h.client.createPage).toHaveBeenCalledTimes(1);
      expect(h.client.updateAttachment).not.toHaveBeenCalled();
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect(await getRow(id)).toMatchObject({
        source: 'confluence',
        confluence_id: '900004',
        space_key: 'CONF',
      });
      expect(await relocationProgress(intent!.id)).toBeUndefined();
    });


    it('retains each acknowledged attachment receipt and blocks after a later unknown upload', async () => {
      const id = await createPage({
        title: 'Partial attachments', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId,
        bodyHtml:
          '<p><img src="/api/attachments/PLACEHOLDER/a.png" />' +
          '<img src="/api/attachments/PLACEHOLDER/b.png" /></p>',
      });
      await query('UPDATE pages SET body_html = REPLACE(body_html, $2, $3) WHERE id = $1', [
        id, 'PLACEHOLDER', String(id),
      ]);
      await writeStoreA(String(id), 'a.png', 'a-bytes');
      await writeStoreA(String(id), 'b.png', 'b-bytes');
      h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) =>
        createdPage('900005', storage, title),
      );
      h.client.updateAttachment
        .mockImplementationOnce(async (_pageId: string, filename: string) => ({
          id: `att-${filename}`,
          title: filename,
          mediaType: 'image/png',
          extensions: { fileSize: 7 },
          version: { number: 1 },
        }))
        .mockRejectedValueOnce(new ConfluenceError('upload outcome unavailable', 504));

      const response = await toConfluence(id);

      expect(response.statusCode).toBe(504);
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect(h.client.updateAttachment).toHaveBeenCalledTimes(2);
      const row = await getRow(id);
      expect(row.source).toBe('standalone');
      expect(row.confluence_id).toBeNull();
      expect(row.body_html).toContain(`/api/attachments/${id}/a.png`);
      expect(row.body_html).toContain(`/api/attachments/${id}/b.png`);
      expect(await storeAFiles(String(id))).toEqual(['a.png', 'b.png']);

      const intent = await latestRelocateIntent(id);
      expect(intent).toMatchObject({
        status: 'pending',
        remote_effect_started_at: expect.any(String),
        remote_effects_completed_at: null,
      });
      const firstUploadedName = h.client.updateAttachment.mock.calls[0]![1] as string;
      expect(await relocationProgress(intent!.id)).toMatchObject({
        created_confluence_id: '900005',
        created_page_receipt: {
          id: '900005',
          version: 1,
        },
        attachment_receipts: [{
          id: `att-${firstUploadedName}`,
          title: firstUploadedName,
          version: 1,
        }],
      });
      await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);


      await withFencedIntentRuntime(intent!, () =>
        expect(reconcilePageWriteIntent(intent!.id, { actorId: recoveryAdminId, reason: 'Partial receipts cannot authorize replay or infer the later upload outcome', })).rejects.toMatchObject({ reason: 'intent_outcome_unrecoverable' }),
      );
      expect(h.client.updateAttachment).toHaveBeenCalledTimes(2);
      expect(h.client.getPage).not.toHaveBeenCalled();
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect(await getRow(id)).toMatchObject({ source: 'standalone', confluence_id: null });
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

    it.each(['deactivated', 'deleted'] as const)('lets an active recovery admin settle marker-only preparation after the original actor is %s', async (actorState) => {
      const contentOwnerId = await createUser(`marker-owner-${randomUUID()}`, 'user');
      const id = await createPage({
        title: 'Preparation marker only',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: contentOwnerId,
        bodyHtml: '<p>exact marker-only body</p>',
        bodyStorage: '<p>exact marker-only storage</p>',
        visibility: 'private',
      });
      const child = await createPage({
        title: 'Marker-only child survives cleanup',
        source: 'standalone',
        spaceKey: 'LOCAL',
        parentRef: String(id),
        ownerId: contentOwnerId,
      });
      await query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [id, contentOwnerId],
      );
      const unrelated = await createPage({
        title: 'Unrelated survivor',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: contentOwnerId,
      });
      const originalRevisions = await getPageRevisions(id);
      resolveCreatedPage('900015');
      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
        const holderPid = (await holder.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;

        const pending = toConfluence(id);
        const preparationPid = await waitForBlockedDatabasePid(holderPid);
        expect(preparationPid).not.toBeNull();

        const intent = await latestRelocateIntent(id);
        expect(intent).toMatchObject({
          status: 'pending',
          effect_started_at: expect.any(String),
          effect_finished_at: null,
          remote_effect_started_at: null,
          settled_at: null,
        });
        expect(await relocationProgress(intent!.id)).toBeUndefined();
        expect(h.client.createPage).not.toHaveBeenCalled();

        await query('SELECT pg_cancel_backend($1)', [preparationPid]);
        await holder.query('COMMIT');
        expect((await pending).statusCode).toBe(500);
        await query(
          actorState === 'deleted' ? 'DELETE FROM users WHERE id = $1' : 'UPDATE users SET deactivated_at = NOW() WHERE id = $1',
          [userId],
        );
        if (actorState === 'deactivated') {
          await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [userId]);
        }
        expect((await query<{ actor_id: string | null }>(
          'SELECT actor_id FROM page_write_intents WHERE id = $1',
          [intent!.id],
        )).rows[0]?.actor_id).toBe(actorState === 'deleted' ? null : userId);


        await withFencedIntentRuntime(intent!, () =>
          expect(reconcilePageWriteIntent(intent!.id, {
            actorId: recoveryAdminId,
            reason: 'The preparation transaction was interrupted before its durable snapshot row committed',
          })).resolves.toEqual({
            intentId: intent!.id,
            status: 'reconciled_not_applied',
          }),
        );

        expect(h.client.createPage).not.toHaveBeenCalled();
        expect(h.client.updateAttachment).not.toHaveBeenCalled();
        expect(h.client.getPage).not.toHaveBeenCalled();
        expect(h.client.deletePage).not.toHaveBeenCalled();
        expect(await relocationProgress(intent!.id)).toBeUndefined();
        expect(await getRow(id)).toMatchObject({
          source: 'standalone',
          confluence_id: null,
          space_key: 'LOCAL',
          visibility: 'private',
          body_html: '<p>exact marker-only body</p>',
          body_storage: '<p>exact marker-only storage</p>',
        });
        expect(await getPageRevisions(id)).toEqual(originalRevisions);
        expect(await childrenViaTreeJoin(id)).toEqual([child]);
        expect((await query(
          `SELECT 1 FROM access_control_entries
            WHERE resource_type = 'page' AND resource_id = $1
              AND principal_type = 'user' AND principal_id = $2 AND permission = 'edit'`,
          [id, contentOwnerId],
        )).rowCount).toBe(1);
        await expect(query('DELETE FROM pages WHERE id = $1', [id])).resolves.toMatchObject({
          rowCount: 1,
        });
        expect((await query('SELECT 1 FROM pages WHERE id = $1', [unrelated])).rowCount).toBe(1);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it.each(['deactivated', 'deleted'] as const)('lets an active recovery admin remove committed preparation after the original actor is %s', async (actorState) => {
      const contentOwnerId = await createUser(`committed-owner-${randomUUID()}`, 'user');
      const id = await createPage({
        title: 'Committed preparation',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: contentOwnerId,
        bodyHtml: '<p>exact original body</p>',
        bodyStorage: '<p>exact original storage</p>',
        visibility: 'private',
      });
      const child = await createPage({
        title: 'Child survives preparation cleanup',
        source: 'standalone',
        spaceKey: 'LOCAL',
        parentRef: String(id),
        ownerId: contentOwnerId,
      });
      await query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [id, contentOwnerId],
      );
      const originalRevisions = await getPageRevisions(id);
      resolveCreatedPage('900016');
      const moveHolder = await getPool().connect();
      const lifecycleHolder = await getPool().connect();
      try {
        await moveHolder.query('BEGIN');
        await moveHolder.query(
          'SELECT pg_advisory_xact_lock($1)',
          [PAGE_MOVE_ADVISORY_LOCK_ID],
        );
        const moveHolderPid = (await moveHolder.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;

        const pending = toConfluence(id);
        expect(await waitForDatabaseBlocker(moveHolderPid)).toBe(true);

        await lifecycleHolder.query('BEGIN');
        const lifecycleLock = lockPageLifecycle(lifecycleHolder, [id]);
        await moveHolder.query('COMMIT');
        await lifecycleLock;
        const lifecycleHolderPid = (await lifecycleHolder.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;
        const authorityPid = await waitForBlockedDatabasePid(lifecycleHolderPid);
        expect(authorityPid).not.toBeNull();

        const intent = await latestRelocateIntent(id);
        expect(intent).toMatchObject({
          status: 'pending',
          effect_started_at: expect.any(String),
          effect_finished_at: null,
          remote_effect_started_at: null,
          settled_at: null,
        });
        expect(await relocationProgress(intent!.id)).toMatchObject({
          created_confluence_id: null,
          created_page_receipt: null,
          attachment_receipts: [],
        });
        expect(h.client.createPage).not.toHaveBeenCalled();

        await expect(query('DELETE FROM pages WHERE id = $1', [id]))
          .rejects.toMatchObject({ code: '23503' });
        await query('SELECT pg_cancel_backend($1)', [authorityPid]);
        await lifecycleHolder.query('COMMIT');
        expect((await pending).statusCode).toBe(500);

        await expect(fencePageWriterRuntime({
          runtimeId: intent!.runtime_id,
          actorId: recoveryAdminId,
          mode: 'durable_no_started_effects',
          reason: 'A retained relocation preparation is durable local progress',
        })).rejects.toMatchObject({ reason: 'runtime_effects_started' });
        expect(await latestRelocateIntent(id)).toMatchObject({
          status: 'pending',
          remote_effect_started_at: null,
          settled_at: null,
        });
        expect(await relocationProgress(intent!.id)).toBeDefined();
        await query(
          actorState === 'deleted' ? 'DELETE FROM users WHERE id = $1' : 'UPDATE users SET deactivated_at = NOW() WHERE id = $1',
          [userId],
        );
        if (actorState === 'deactivated') {
          await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [userId]);
        }
        expect((await query<{ actor_id: string | null }>(
          'SELECT actor_id FROM page_write_intents WHERE id = $1',
          [intent!.id],
        )).rows[0]?.actor_id).toBe(actorState === 'deleted' ? null : userId);


        await withFencedIntentRuntime(intent!, () =>
          expect(reconcilePageWriteIntent(intent!.id, {
            actorId: recoveryAdminId,
            reason: 'Remove the retained preparation using durable no-remote-start evidence',
          })).resolves.toEqual({
            intentId: intent!.id,
            status: 'reconciled_not_applied',
          }),
        );

        expect(h.client.createPage).not.toHaveBeenCalled();
        expect(h.client.updateAttachment).not.toHaveBeenCalled();
        expect(h.client.getPage).not.toHaveBeenCalled();
        expect(h.client.deletePage).not.toHaveBeenCalled();
        expect(await relocationProgress(intent!.id)).toBeUndefined();
        expect(await getRow(id)).toMatchObject({
          source: 'standalone',
          confluence_id: null,
          space_key: 'LOCAL',
          visibility: 'private',
          body_html: '<p>exact original body</p>',
          body_storage: '<p>exact original storage</p>',
        });
        expect(await getPageRevisions(id)).toEqual(originalRevisions);
        expect(await childrenViaTreeJoin(id)).toEqual([child]);
        expect((await query(
          `SELECT 1 FROM access_control_entries
            WHERE resource_type = 'page' AND resource_id = $1
              AND principal_type = 'user' AND principal_id = $2 AND permission = 'edit'`,
          [id, contentOwnerId],
        )).rowCount).toBe(1);

        await expect(query('DELETE FROM pages WHERE id = $1', [id])).resolves.toMatchObject({
          rowCount: 1,
        });
        expect((await query('SELECT 1 FROM pages WHERE id = $1', [child])).rowCount).toBe(1);
      } finally {
        await lifecycleHolder.query('ROLLBACK').catch(() => undefined);
        lifecycleHolder.release();
        await moveHolder.query('ROLLBACK').catch(() => undefined);
        moveHolder.release();
      }
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
      expect(await latestRelocateIntent(id)).toMatchObject({
        status: 'completed',
        effect_started_at: expect.any(String),
        effect_finished_at: expect.any(String),
        settled_at: expect.any(String),
      });
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

    it('keeps a committed local move pending when protected cache cleanup fails', async () => {
      const id = await createPage({
        title: 'Committed local cleanup failure',
        source: 'confluence',
        confluenceId: '700501',
        spaceKey: 'CONF',
        bodyHtml: '<p><img src="/api/attachments/700501/chart.png" /></p>',
      });
      await writeStoreA('700501', 'chart.png', 'chart-bytes');
      const oldCacheDir = path.resolve(attachmentsRoot, '700501');
      await fs.chmod(oldCacheDir, 0o500);

      let response: { statusCode: number } | undefined;
      try {
        response = await toLocal(id, '700501');
      } finally {
        await fs.chmod(oldCacheDir, 0o700);
      }

      expect(response?.statusCode).toBe(500);
      expect(h.client.deletePage).toHaveBeenCalledWith('700501');
      expect(await getRow(id)).toMatchObject({
        source: 'standalone',
        confluence_id: null,
      });
      expect(await storeBFiles(id)).toEqual(['chart.png']);
      expect(await storeAFiles('700501')).toEqual(['chart.png']);
      expect(await latestRelocateIntent(id)).toMatchObject({
        status: 'pending',
        effect_started_at: expect.any(String),
        settled_at: null,
      });
    });

    it('refuses the move with a named 400 when a cached attachment cannot be read, staging nothing', async () => {
      const id = await createPage({
        title: 'Locked cache',
        source: 'confluence',
        confluenceId: '700500',
        spaceKey: 'CONF',
        bodyHtml: '<p><img src="/api/attachments/700500/locked.png" /></p>',
      });
      await writeStoreA('700500', 'locked.png', 'locked-bytes');

      const lockedPath = path.resolve(attachmentsRoot, '700500', 'locked.png');
      await fs.chmod(lockedPath, 0o000);

      let res;
      try {
        res = await toLocal(id, '700500');
      } finally {
        await fs.chmod(lockedPath, 0o600);
      }

      // The staging loop's own cleanup still runs, so the abort leaves no
      // half-migrated page: no local bytes, no rows, the page untouched —
      // and the refusal names the file instead of 500ing (#1626 review r3).
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Attachment "locked.png" cannot be moved');
      expect(await storeBFiles(id)).toEqual([]);
      expect((await query('SELECT 1 FROM local_attachments WHERE page_id = $1', [id])).rowCount).toBe(0);
      expect(await getRow(id)).toMatchObject({ source: 'confluence', confluence_id: '700500' });
      expect(h.client.deletePage).not.toHaveBeenCalled();
    });


    it('finishes relocation with only one pool connection available', async () => {
      const id = await createPage({
        title: 'Saturated pool',
        source: 'confluence',
        confluenceId: '700100',
        spaceKey: 'CONF',
        bodyHtml: '<p><img src="/api/attachments/700100/chart.png" /></p>',
      });
      await writeStoreA('700100', 'chart.png', 'chart-bytes');

      const pool = getPool();
      const holders: PoolClient[] = [];
      while (holders.length < pool.options.max - 1) {
        holders.push(await pool.connect());
      }

      let settled = false;
      let outcome: 'completed' | 'second-checkout';
      let response: { statusCode: number } | undefined;
      const pending = toLocal(id, '700100');
      try {
        const completion = pending.then((result) => {
          settled = true;
          response = result;
          return 'completed' as const;
        });
        const secondCheckout = (async () => {
          while (!settled && pool.waitingCount === 0) await nextEventLoopTurn();
          return pool.waitingCount > 0 ? ('second-checkout' as const) : completion;
        })();
        outcome = await Promise.race([completion, secondCheckout]);
      } finally {
        settled = true;
        for (const holder of holders) holder.release();
        response ??= await pending;
      }

      expect(outcome).toBe('completed');
      expect(response?.statusCode).toBe(200);
      expect((await getRow(id)).source).toBe('standalone');
    });

    it('re-keys an attachment anchor, not just an image (#1169)', async () => {
      // The Markdown import (#1133) is a live producer of these: a link whose
      // target is an internal attachment URL survives `markdownToHtml` and
      // DOMPurify verbatim, and `htmlToConfluence` preserves it rather than
      // dropping it. The move stages the bytes into the local store and then
      // removes the Confluence cache directory, so an anchor left on the old
      // key is a dead link pointing at a directory this move just deleted.
      const id = await createPage({
        title: 'Linked',
        source: 'confluence',
        confluenceId: '700040',
        spaceKey: 'CONF',
        bodyHtml: '<p><a href="/api/attachments/700040/spec.pdf">Spec</a></p>',
      });
      await writeStoreA('700040', 'spec.pdf', 'pdf-bytes');

      const res = await toLocal(id, '700040');
      expect(res.statusCode).toBe(200);

      const row = await getRow(id);
      expect(row.body_html).toContain(`/api/local-attachments/${id}/spec.pdf`);
      expect(row.body_html).not.toContain('/api/attachments/700040/');
      expect(await storeBFiles(id)).toEqual(['spec.pdf']);
      expect(await storeAFiles('700040')).toEqual([]);
    });

    it('ignores a stray hidden file in the attachment cache (#1169)', async () => {
      // Neither store can create a dot-named file, so one in the cache dir is
      // always foreign debris — `.DS_Store`, an AppleDouble sidecar, an rsync
      // temp file. Reading it threw `Invalid filename` and 500'd the whole
      // move, which `app.ts` then masked to "Internal Server Error".
      const id = await createPage({
        title: 'Imaged',
        source: 'confluence',
        confluenceId: '700030',
        spaceKey: 'CONF',
        bodyHtml: '<p><img src="/api/attachments/700030/chart.png" /></p>',
      });
      await writeStoreA('700030', 'chart.png', 'chart-bytes');
      await writeStoreA('700030', '.DS_Store', 'finder-junk');

      const res = await toLocal(id, '700030');
      expect(res.statusCode).toBe(200);
      expect(res.json().attachmentsMigrated).toBe(1);

      expect(await storeBFiles(id)).toEqual(['chart.png']);
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

    it('relocates a Confluence page whose space_key is NULL (#1169)', async () => {
      // `pages.space_key` has been nullable since migration 029. The preview
      // hands the client `page.space_key ?? ''`, so the confirmation it echoes
      // back carries an empty string — which the schema must accept, or such a
      // row can never be relocated at all.
      const id = await createPage({
        title: 'Spaceless', source: 'confluence', confluenceId: '700020', spaceKey: null,
      });

      const preview = await app.inject({ method: 'GET', url: `/api/pages/${id}/relocate/preview` });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().upstreamDeletion).toMatchObject({ confluenceId: '700020', spaceKey: '' });

      const res = await toLocal(id, '700020', {
        confirmDeleteConfluencePage: { confluenceId: '700020', spaceKey: '' },
      });
      expect(res.statusCode).toBe(200);

      const row = await getRow(id);
      expect(row.source).toBe('standalone');
      expect(row.confluence_id).toBeNull();
      expect(h.client.deletePage).toHaveBeenCalledWith('700020');
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
      // …and so are the BYTES (#1169 review). Dropping the row while leaving
      // the file behind is what made "nothing mutated" a claim about the
      // database only; every failed attempt used to add another orphan.
      expect(await storeBFiles(parent)).toEqual([]);
      // The originals are untouched — this path must never cost the user data.
      expect(await storeAFiles('700007')).toEqual(['pic.png']);
      expect(await latestRelocateIntent(parent)).toMatchObject({
        status: 'completed',
        effect_started_at: expect.any(String),
        effect_finished_at: expect.any(String),
        settled_at: expect.any(String),
      });
    });

    it('keeps the local safe outcome and a pending intent when remote deletion cannot be reconciled', async () => {
      const id = await createPage({
        title: 'Unknown remote outcome',
        source: 'confluence',
        confluenceId: '700060',
        spaceKey: 'CONF',
        bodyHtml: '<p><img src="/api/attachments/700060/pic.png" /></p>',
      });
      await writeStoreA('700060', 'pic.png', 'bytes');
      h.client.deletePage.mockRejectedValue(new ConfluenceError('gateway timeout', 504));
      h.client.getPage.mockRejectedValue(new ConfluenceError('service unavailable', 503));

      const res = await toLocal(id, '700060');
      expect(res.statusCode).toBe(504);

      const row = await getRow(id);
      expect(row.source).toBe('standalone');
      expect(row.confluence_id).toBeNull();
      expect(row.space_key).toBe('LOCAL');
      expect(row.body_html).toContain(`/api/local-attachments/${id}/pic.png`);
      expect(await storeBFiles(id)).toEqual(['pic.png']);
      expect(await storeAFiles('700060')).toEqual(['pic.png']);

      expect(await latestRelocateIntent(id)).toMatchObject({
        status: 'pending',
        effect_started_at: expect.any(String),
        effect_finished_at: null,
        settled_at: null,
      });
    });

    it('keeps the current ACL untouched when recovery finds no local cutover after an intervening revoke and grant', async () => {
      const revokedPrincipal = await createUser(`revoked-before-recovery-${randomUUID()}`, 'user');
      const grantedPrincipal = await createUser(`granted-before-recovery-${randomUUID()}`, 'user');
      const id = await createPage({
        title: 'No local cutover',
        source: 'confluence',
        confluenceId: '700064',
        spaceKey: 'CONF',
        bodyStorage: '<p>no-cutover provider body</p>',
      });
      await query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [id, revokedPrincipal],
      );
      const intentId = await seedInterruptedLocalCutover(id, '700064', userId, {
        cutover: false,
        includeAttachment: false,
      });
      await query(
        `DELETE FROM access_control_entries
          WHERE resource_type = 'page' AND resource_id = $1
            AND principal_type = 'user' AND principal_id = $2 AND permission = 'edit'`,
        [id, revokedPrincipal],
      );
      await query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'read')`,
        [id, grantedPrincipal],
      );
      h.client.getPage.mockResolvedValue(
        createdPage('700064', '<p>no-cutover provider body</p>', 'No local cutover'),
      );

      await expect(reconcilePageWriteIntent(intentId, {
        actorId: recoveryAdminId,
        reason: 'Preserve ACL changes because the local relocation cutover never occurred',
      })).resolves.toEqual({ intentId, status: 'reconciled_not_applied' });

      expect(await getRow(id)).toMatchObject({
        source: 'confluence',
        confluence_id: '700064',
        space_key: 'CONF',
      });
      expect((await query<{
        principal_id: string;
        permission: string;
      }>(
        `SELECT principal_id, permission
           FROM access_control_entries
          WHERE resource_type = 'page' AND resource_id = $1
          ORDER BY principal_id, permission`,
        [id],
      )).rows).toEqual([{ principal_id: grantedPrincipal, permission: 'read' }]);
    });

    it('refuses cutover restoration after a concurrent ACE grant and leaves page and ACL unchanged', async () => {
      const originalPrincipal = await createUser(`original-cutover-ace-${randomUUID()}`, 'user');
      const grantedPrincipal = await createUser(`concurrent-cutover-ace-${randomUUID()}`, 'user');
      const id = await createPage({
        title: 'Changed cutover ACL',
        source: 'confluence',
        confluenceId: '700065',
        spaceKey: 'CONF',
        bodyStorage: '<p>changed cutover provider body</p>',
      });
      await query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [id, originalPrincipal],
      );
      const intentId = await seedInterruptedLocalCutover(id, '700065', userId, {
        includeAttachment: false,
      });
      h.client.getPage.mockResolvedValue(
        createdPage('700065', '<p>changed cutover provider body</p>', 'Changed cutover ACL'),
      );

      const aceWriter = await getPool().connect();
      try {
        await aceWriter.query('BEGIN');
        await aceWriter.query(
          `INSERT INTO access_control_entries
             (resource_type, resource_id, principal_type, principal_id, permission)
           VALUES ('page', $1, 'user', $2, 'read')`,
          [id, grantedPrincipal],
        );
        const writerPid = (await aceWriter.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;
        const recovery = expect(reconcilePageWriteIntent(intentId, {
          actorId: recoveryAdminId,
          reason: 'Refuse to overwrite an ACL grant committed after local cutover',
        })).rejects.toMatchObject({
          reason: 'intent_local_evidence_mismatch',
        });
        expect(await waitForBlockedDatabasePid(writerPid)).not.toBeNull();
        await aceWriter.query('COMMIT');

        await recovery;
      } finally {
        await aceWriter.query('ROLLBACK').catch(() => undefined);
        aceWriter.release();
      }

      expect(await getRow(id)).toMatchObject({
        source: 'standalone',
        confluence_id: null,
        space_key: 'LOCAL',
      });
      expect((await query<{
        principal_id: string;
        permission: string;
      }>(
        `SELECT principal_id, permission
           FROM access_control_entries
          WHERE resource_type = 'page' AND resource_id = $1
          ORDER BY principal_id, permission`,
        [id],
      )).rows).toEqual([{ principal_id: grantedPrincipal, permission: 'read' }]);
      expect((await query(
        'SELECT 1 FROM page_relocation_preparations WHERE intent_id = $1',
        [intentId],
      )).rowCount).toBe(1);
    });

    it('recovers a crash after local cutover but before delete without inventing remote dispatch', async () => {
      const id = await createPage({
        title: 'Crash before delete',
        source: 'confluence',
        confluenceId: '700061',
        spaceKey: 'CONF',
        bodyHtml: '<p><img src="/api/attachments/700061/crash.png" /></p>',
        bodyStorage: '<p>remote crash body</p>',
      });
      const originalPrincipal = await createUser(`restored-cutover-ace-${randomUUID()}`, 'user');
      await query(
        `INSERT INTO access_control_entries
           (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'user', $2, 'edit')`,
        [id, originalPrincipal],
      );
      await writeStoreA('700061', 'crash.png', 'crash-bytes');
      const intentId = await seedInterruptedLocalCutover(id, '700061', userId);
      expect(await getRow(id)).toMatchObject({
        source: 'standalone',
        confluence_id: null,
        space_key: 'LOCAL',
      });
      expect((await query(
        `SELECT 1 FROM access_control_entries
          WHERE resource_type = 'page' AND resource_id = $1`,
        [id],
      )).rowCount).toBe(0);
      expect(await latestRelocateIntent(id)).toMatchObject({
        id: intentId,
        remote_effect_started_at: null,
        remote_effects_completed_at: null,
      });

      h.client.getPage.mockResolvedValue({
        id: '700061',
        title: 'Crash before delete',
        status: 'current',
        type: 'page',
        version: { number: 1, when: '' },
        body: { storage: { value: '<p>remote crash body</p>' } },
      });
      h.client.getPageAttachments.mockResolvedValue({
        results: [{
          id: 'remote-crash-attachment',
          title: 'crash.png',
          mediaType: 'image/png',
          extensions: { fileSize: 11 },
          version: { number: 1 },
          _links: { download: '/download/attachments/700061/crash.png' },
        }],
        start: 0,
        limit: 100,
        size: 1,
      });
      h.client.downloadAttachment.mockResolvedValue(Buffer.from('crash-bytes'));

      await expect(reconcilePageWriteIntent(intentId, { actorId: recoveryAdminId, reason: 'Restore exact admitted state after crash before remote deletion dispatch', })).resolves.toEqual({ intentId, status: 'reconciled_not_applied' });

      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect(await getRow(id)).toMatchObject({
        source: 'confluence',
        confluence_id: '700061',
        space_key: 'CONF',
        body_html: '<p><img src="/api/attachments/700061/crash.png" /></p>',
        body_storage: '<p>remote crash body</p>',
      });
      expect(await storeBFiles(id)).toEqual([]);
      expect(await storeAFiles('700061')).toEqual(['crash.png']);
      expect((await query<{
        principal_id: string;
        permission: string;
      }>(
        `SELECT principal_id, permission
           FROM access_control_entries
          WHERE resource_type = 'page' AND resource_id = $1`,
        [id],
      )).rows).toEqual([{ principal_id: originalPrincipal, permission: 'edit' }]);
      expect((await query(
        'SELECT 1 FROM page_relocation_preparations WHERE intent_id = $1',
        [intentId],
      )).rowCount).toBe(0);
      expect(await latestRelocateIntent(id)).toMatchObject({
        status: 'reconciled_not_applied',
        remote_effect_started_at: null,
        settled_at: expect.any(String),
      });
    });

    it('retains a terminal delete intent when the provider page is live again', async () => {
      const id = await createPage({
        title: 'Restored upstream',
        source: 'confluence',
        confluenceId: '700062',
        spaceKey: 'CONF',
        bodyStorage: '<p>restored upstream body</p>',
      });
      const intentId = await seedInterruptedLocalCutover(id, '700062', userId);
      await query(
        `UPDATE page_write_intents
            SET remote_effect_started_at = NOW(),
                remote_effects_completed_at = NOW(),
                remote_terminal_result = '{"outcome":"gone","confluenceId":"700062"}'::jsonb
          WHERE id = $1`,
        [intentId],
      );
      h.client.getPage.mockResolvedValue({
        id: '700062',
        title: 'Restored upstream',
        status: 'current',
        type: 'page',
        version: { number: 1, when: '' },
        body: { storage: { value: '<p>restored upstream body</p>' } },
      });

      await expect(reconcilePageWriteIntent(intentId, { actorId: recoveryAdminId, reason: 'A restored provider page must keep the relocation pending', })).rejects.toMatchObject({ reason: 'intent_terminal_evidence_mismatch' });

      expect(await getRow(id)).toMatchObject({
        source: 'standalone',
        confluence_id: null,
        space_key: 'LOCAL',
      });
      expect(await latestRelocateIntent(id)).toMatchObject({
        status: 'pending',
        remote_effects_completed_at: expect.any(String),
        settled_at: null,
      });
      expect((await query(
        'SELECT 1 FROM page_relocation_preparations WHERE intent_id = $1',
        [intentId],
      )).rowCount).toBe(1);
    });

    // An ambiguous identifier does NOT reach the staging cleanup, and it is
    // worth saying so: the obvious way to write that test passes for the wrong
    // reason. `assertIdentifierUnambiguous` runs once pre-flight — before a
    // single byte is staged — and again under the lock, so a decoy seeded up
    // front is refused by the first check and the rollback path never runs.
    // (Measured: the cleanup can be deleted outright and such a test stays
    // green.) Only a decoy that appears BETWEEN the two checks reaches the
    // transaction's catch, which is a race no test can stage deterministically.
    // The upstream-failure case above covers the same cleanup on a path that is
    // genuinely reachable; `local-attachment-service.test.ts` covers the helper.
    it('refuses an ambiguous new local key before staging anything', async () => {
      const id = await createPage({
        title: 'Ambiguous', source: 'confluence', confluenceId: '700050', spaceKey: 'CONF',
        bodyHtml: '<p><img src="/api/attachments/700050/pic.png" /></p>',
      });
      await writeStoreA('700050', 'pic.png', 'bytes');
      // A different page whose confluence_id equals this page's numeric id, so
      // the key its children would store is ambiguous.
      await createPage({
        title: 'Decoy', source: 'confluence', confluenceId: String(id), spaceKey: 'CONF',
      });

      const res = await toLocal(id, '700050');

      expect(res.statusCode).toBe(409);
      const rows = await query('SELECT 1 FROM local_attachments WHERE page_id = $1', [id]);
      expect(rows.rowCount).toBe(0);
      // Empty because staging never started, not because it was cleaned up.
      expect(await storeBFiles(id)).toEqual([]);
      // The source bytes survive, so a retry after fixing the collision works.
      expect(await storeAFiles('700050')).toEqual(['pic.png']);
      expect((await getRow(id)).source).toBe('confluence');
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
      resolveCreatedPage('900010');

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(200);
      expect((await getRow(id)).confluence_id).toBe('900010');
    });

    it('rechecks actor authority after reservation waits and starts no upstream effect', async () => {
      const id = await createPage({
        title: 'Revoked while waiting',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: userId,
      });
      resolveCreatedPage('900011');
      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await lockPageLifecycle(holder, [id]);
        const backendPid = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

        const pending = toConfluence(id);
        expect(await waitForDatabaseBlocker(backendPid.rows[0]!.pid)).toBe(true);
        await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [userId]);
        await holder.query('COMMIT');

        const response = await pending;
        expect(response.statusCode).toBe(403);
        expect(h.client.createPage).not.toHaveBeenCalled();
        expect(await latestRelocateIntent(id)).toMatchObject({
          status: 'cancelled',
          effect_started_at: null,
          effect_finished_at: null,
          settled_at: expect.any(String),
        });
        expect((await getRow(id)).source).toBe('standalone');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('rechecks integration mode after preparation waits and creates nothing upstream', async () => {
      const id = await createPage({
        title: 'Disabled during preparation',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: userId,
      });
      resolveCreatedPage('900013');
      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
        const backendPid = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

        const pending = toConfluence(id);
        expect(await waitForDatabaseBlocker(backendPid.rows[0]!.pid)).toBe(true);
        await query(
          'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
          [userId],
        );
        await holder.query('COMMIT');

        const response = await pending;
        expect(response.statusCode).toBe(409);
        expect(h.client.createPage).not.toHaveBeenCalled();
        expect(h.client.updateAttachment).not.toHaveBeenCalled();
        expect(await getRow(id)).toMatchObject({
          source: 'standalone',
          confluence_id: null,
          space_key: 'LOCAL',
        });
        const intent = await latestRelocateIntent(id);
        expect(intent).toMatchObject({
          status: 'pending',
          effect_started_at: expect.any(String),
          effect_finished_at: null,
          remote_effect_started_at: null,
          settled_at: null,
        });
        expect(await relocationProgress(intent!.id)).toMatchObject({
          created_confluence_id: null,
          created_page_receipt: null,
          attachment_receipts: [],
        });
        await withFencedIntentRuntime(intent!, () =>
          expect(reconcilePageWriteIntent(intent!.id, {
            actorId: recoveryAdminId,
            reason: 'Remove the committed preparation after current authority refused remote dispatch',
          })).resolves.toEqual({
            intentId: intent!.id,
            status: 'reconciled_not_applied',
          }),
        );
        expect(await latestRelocateIntent(id)).toMatchObject({
          status: 'reconciled_not_applied',
          remote_effect_started_at: null,
          settled_at: expect.any(String),
        });
        expect(await relocationProgress(intent!.id)).toBeUndefined();
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('uses credentials re-resolved after preparation instead of the route snapshot', async () => {
      const id = await createPage({
        title: 'Rotated during preparation',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: userId,
      });
      resolveCreatedPage('900014');
      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1)', [PAGE_MOVE_ADVISORY_LOCK_ID]);
        const backendPid = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

        const pending = toConfluence(id);
        expect(await waitForDatabaseBlocker(backendPid.rows[0]!.pid)).toBe(true);
        await query(
          'UPDATE user_settings SET confluence_pat = $2 WHERE user_id = $1',
          [userId, encryptPat('rotated-relocate-pat')],
        );
        await holder.query('COMMIT');

        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(h.createAuthorization).toHaveBeenCalledWith('Bearer rotated-relocate-pat');
        expect(await getRow(id)).toMatchObject({
          source: 'confluence',
          confluence_id: '900014',
        });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('keeps a local publication recoverable when integration mode changes before delete', async () => {
      const id = await createPage({
        title: 'Disabled before delete',
        source: 'confluence',
        confluenceId: '700063',
        spaceKey: 'CONF',
        bodyStorage: '<p>provider body</p>',
      });
      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
        const backendPid = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

        const pending = toLocal(id, '700063');
        expect(await waitForDatabaseBlocker(backendPid.rows[0]!.pid)).toBe(true);
        await query(
          'UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1',
          [userId],
        );
        await holder.query('COMMIT');

        const response = await pending;
        expect(response.statusCode).toBe(409);
        expect(h.client.deletePage).not.toHaveBeenCalled();
        expect(await getRow(id)).toMatchObject({
          source: 'standalone',
          confluence_id: null,
          space_key: 'LOCAL',
        });
        const intent = await latestRelocateIntent(id);
        expect(intent).toMatchObject({
          status: 'pending',
          effect_started_at: expect.any(String),
          effect_finished_at: null,
          remote_effect_started_at: null,
          remote_effects_completed_at: null,
          settled_at: null,
        });
        expect((await query(
          'SELECT 1 FROM page_relocation_preparations WHERE intent_id = $1',
          [intent!.id],
        )).rowCount).toBe(1);

        await query(
          'UPDATE user_settings SET confluence_enabled = TRUE WHERE user_id = $1',
          [userId],
        );
        h.client.getPage.mockResolvedValue(
          createdPage('700063', '<p>provider body</p>', 'Disabled before delete'),
        );
        await withFencedIntentRuntime(intent!, () =>
          expect(reconcilePageWriteIntent(intent!.id, { actorId: recoveryAdminId, reason: 'Restore the admitted provider state without replaying an undispatched delete', })).resolves.toEqual({ intentId: intent!.id, status: 'reconciled_not_applied' }),
        );

        expect(h.client.deletePage).not.toHaveBeenCalled();
        expect(await getRow(id)).toMatchObject({
          source: 'confluence',
          confluence_id: '700063',
          space_key: 'CONF',
        });
        expect((await query(
          'SELECT 1 FROM page_relocation_preparations WHERE intent_id = $1',
          [intent!.id],
        )).rowCount).toBe(0);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it.each(['deactivated', 'deleted'] as const)('retains terminal remote creation and refuses recovery when the original actor is %s', async (actorState) => {
      const contentOwnerId = await createUser(`remote-start-owner-${randomUUID()}`, 'user');
      const id = await createPage({
        title: 'Revoked during upstream create',
        source: 'standalone',
        spaceKey: 'LOCAL',
        ownerId: contentOwnerId,
      });
      let notifyCreateStarted!: () => void;
      let releaseCreate!: () => void;
      const createStarted = new Promise<void>((resolve) => {
        notifyCreateStarted = resolve;
      });
      const createRelease = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) => {
        notifyCreateStarted();
        await createRelease;
        return createdPage('900012', storage, title);
      });

      const pending = toConfluence(id);
      await createStarted;
      await query(
        actorState === 'deleted' ? 'DELETE FROM users WHERE id = $1' : 'UPDATE users SET deactivated_at = NOW() WHERE id = $1',
        [userId],
      );
      releaseCreate();

      const response = await pending;
      expect(response.statusCode).toBe(403);
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
      const intent = await latestRelocateIntent(id);
      expect(intent).toMatchObject({
        status: 'pending',
        remote_effect_started_at: expect.any(String),
        remote_effects_completed_at: expect.any(String),
        settled_at: null,
      });
      expect((await query<{ actor_id: string | null }>(
        'SELECT actor_id FROM page_write_intents WHERE id = $1',
        [intent!.id],
      )).rows[0]?.actor_id).toBe(actorState === 'deleted' ? null : userId);
      await withFencedIntentRuntime(intent!, () =>
        expect(reconcilePageWriteIntent(intent!.id, {
          actorId: recoveryAdminId,
          reason: 'Remote-started relocation cannot be settled without its original actor',
        })).rejects.toMatchObject({
          reason: actorState === 'deleted' ? 'intent_recovery_metadata_invalid' : 'intent_access_changed',
        }),
      );
    });

    it('409s while a Confluence sync is in flight', async () => {
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      await redis.set('sync:worker:lock', 'relocate-test-lock');

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
      resolveCreatedPage(String(other));

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(409);
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
      const intent = await latestRelocateIntent(id);
      expect(intent?.status).toBe('pending');
      expect(await relocationProgress(intent!.id)).toMatchObject({ created_confluence_id: String(other) });
      expect(await getRow(other)).toMatchObject({ source: 'standalone', confluence_id: null });
    });

    it('serializes on the same advisory lock as PUT /pages/:id/move', async () => {
      // A tree re-parent and a relocate must not interleave: /move writes a
      // parent_id in the flavour the parent has *now*, and relocate changes
      // exactly that flavour. Both take PAGE_MOVE_ADVISORY_LOCK_ID.
      const id = await createPage({ title: 'A', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      resolveCreatedPage('900020');

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
      h.client.createPage.mockImplementation(async (_space: string, title: string, storage: string) =>
        createdPage('900030', storage, title),
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

    it('refuses when two references would publish under the same filename', async () => {
      // Two images borrowed from different pages, both really called
      // "chart.png", cached under distinct synthetic xref names. A Confluence
      // page holds one attachment per name, so publishing both would upload
      // "chart.png" twice and BOTH images would then render the same picture —
      // one of them silently wrong, on a move that cannot be undone. Refuse,
      // matching what this flow already does for an ambiguous identifier.
      const a = 'chart.xref-aaaaaaaaaaaa.png';
      const b = 'chart.xref-bbbbbbbbbbbb.png';
      const id = await createPage({
        title: 'Two borrowed charts', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId,
        bodyHtml:
          `<p><img src="/api/local-attachments/PLACEHOLDER/${a}" ` +
          `data-confluence-image-source="attachment" data-confluence-filename="chart.png"></p>` +
          `<p><img src="/api/local-attachments/PLACEHOLDER/${b}" ` +
          `data-confluence-image-source="attachment" data-confluence-filename="chart.png"></p>`,
      });
      await query('UPDATE pages SET body_html = REPLACE(body_html, $2, $3) WHERE id = $1', [
        id, 'PLACEHOLDER', String(id),
      ]);
      await writeStoreB(id, a, 'first-chart', userId);
      await writeStoreB(id, b, 'second-chart', userId);

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('chart.png');
      // Detected before the upstream create, so neither side changed at all.
      expect(h.client.createPage).not.toHaveBeenCalled();
      expect(h.client.updateAttachment).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
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
      resolveCreatedPage('900040');

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(409);
      expect(h.client.deletePage).not.toHaveBeenCalled();
      expect((await getRow(id)).source).toBe('standalone');
      const intent = await latestRelocateIntent(id);
      expect(intent?.status).toBe('pending');
      expect(await relocationProgress(intent!.id)).toMatchObject({ created_confluence_id: '900040' });
      expect((await query(
        'SELECT confluence_id, deleted_at IS NOT NULL AS trashed FROM pages WHERE id = $1',
        [trashed],
      )).rows).toEqual([{ confluence_id: '900040', trashed: true }]);
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

  /**
   * #1115 P2 (review r1) — a relocate REKEYS every image.
   *
   * The persisted body has its `img src` attributes rewritten onto the other
   * store's prefix, so every `(source, attachment_key)` in
   * `page_image_analyses` now names a row this page no longer references —
   * and `extractImageReferencesFromHtml` reads exactly that prefix. Only a
   * re-scan reconciles it, and the flag is what schedules one. Both directions
   * were deletable with every suite green. (#1618 retired the legacy
   * `image_embedding_dirty` half; ADR-027 D4's analysis flag is what is left.)
   */
  describe('image_analysis_dirty across a relocate (#1115 P2, ADR-027 D4)', () => {
    async function imageDirty(id: number): Promise<{ analysis: boolean }> {
      const r = await query<{ image_analysis_dirty: boolean }>(
        'SELECT image_analysis_dirty FROM pages WHERE id = $1', [id],
      );
      return { analysis: r.rows[0]!.image_analysis_dirty };
    }

    it('raises it on local → Confluence', async () => {
      const id = await createPage({ title: 'Moving up', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });
      await query('UPDATE pages SET image_analysis_dirty = FALSE WHERE id = $1', [id]);
      h.client.createPage.mockResolvedValue(createdPage('900910', '<p>body</p>', 'Moving up'));

      expect((await toConfluence(id)).statusCode).toBe(200);

      expect(await imageDirty(id)).toEqual({ analysis: true });
    });

    it('raises it on Confluence → local', async () => {
      const id = await createPage({
        title: 'Moving down', source: 'confluence', confluenceId: '700910', spaceKey: 'CONF',
      });
      await query('UPDATE pages SET image_analysis_dirty = FALSE WHERE id = $1', [id]);
      h.client.deletePage.mockResolvedValue(undefined);

      expect((await toLocal(id, '700910')).statusCode).toBe(200);

      expect(await imageDirty(id)).toEqual({ analysis: true });
    });

    it('restores it when the move is compensated', async () => {
      // The snapshot's own rule: every column the move WRITES must be
      // captured, or a rollback leaves the moved value behind. This one is
      // cheap to get wrong — a page left dirty by a move that never happened
      // just re-scans — and the rule is the thing that keeps the next, less
      // cheap column from being forgotten.
      const id = await createPage({
        title: 'Reverted', source: 'confluence', confluenceId: '700911', spaceKey: 'CONF',
      });
      await query('UPDATE pages SET image_analysis_dirty = FALSE WHERE id = $1', [id]);
      h.client.deletePage.mockRejectedValue(new ConfluenceError('server error', 500));
      h.client.getPage.mockResolvedValue({ id: '700911', status: 'current' });

      expect((await toLocal(id, '700911')).statusCode).toBe(500);

      expect(await imageDirty(id)).toEqual({ analysis: false });
    });
  });

  // #1623 — a relocate is two-sided by definition (create upstream / delete
  // upstream), so it is the one page operation that refuses while the
  // integration is off instead of falling back to a local write. Committing
  // only the local half would leave a live Confluence page for the next sync to
  // re-import as a duplicate. `isConfluenceEnabled` and user settings are
  // real; the request is refused before the outbound HTTP boundary.
  describe('Confluence integration off (#1623)', () => {
    beforeEach(async () => {
      await query('UPDATE user_settings SET confluence_enabled = FALSE WHERE user_id = $1', [
        userId,
      ]);
    });

    it('refuses a local → Confluence move by naming the integration, changing nothing', async () => {
      const id = await createPage({ title: 'Stay local', source: 'standalone', spaceKey: 'LOCAL', ownerId: userId });

      const res = await toConfluence(id);

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Confluence integration is disabled');
      expect(res.json().error).not.toContain('not configured');
      expect(h.client.createPage).not.toHaveBeenCalled();
      const row = await getRow(id);
      expect(row.source).toBe('standalone');
      expect(row.confluence_id).toBeNull();
    });

    it('refuses a Confluence → local move as well, leaving the upstream page alone', async () => {
      const id = await createPage({
        title: 'Stay synced', source: 'confluence', confluenceId: '700923', spaceKey: 'CONF',
      });

      const res = await toLocal(id, '700923');

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Confluence integration is disabled');
      expect(h.client.deletePage).not.toHaveBeenCalled();
      const row = await getRow(id);
      expect(row.source).toBe('confluence');
      expect(row.confluence_id).toBe('700923');
    });
  });
});
