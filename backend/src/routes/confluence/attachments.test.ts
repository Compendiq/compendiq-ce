import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import type * as Undici from 'undici';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { invalidateRbacCache } from '../../core/services/rbac-service.js';
import { reconcilePageWriteIntent } from '../../core/services/page-write-admission.js';
import { encryptPat } from '../../core/utils/crypto.js';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  request: vi.fn(),
}));

const mockRequest = vi.mocked(request);
const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
const available = dbAvailable && redisAvailable;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_DATA_URI = `data:image/png;base64,${PNG.toString('base64')}`;

let app: FastifyInstance;
let redis: RedisClientType;
let attachmentRoot = '';
let currentUserId = '';
const ownedUsers = new Set<string>();
const ownedPages = new Set<number>();
const ownedRoles = new Set<number>();
const ownedRuntimes = new Set<string>();
const ownedRedisKeys = new Set<string>();

type HttpResponder = (
  url: URL,
  options: { method?: string; body?: unknown },
) => Promise<unknown>;
let respondHttp: HttpResponder;

function jsonResponse(data: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {},
    body: { text: async () => JSON.stringify(data) },
  };
}

function bufferResponse(bytes: Buffer) {
  return {
    statusCode: 200,
    headers: { 'content-length': String(bytes.length) },
    body: {
      text: async () => bytes.toString('utf8'),
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

async function seedUser(input: { withSpace?: boolean; admin?: boolean } = {}): Promise<string> {
  const suffix = randomUUID();
  const user = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`attachment-route-${suffix}`, `${suffix}@test.invalid`, input.admin ? 'admin' : 'user'],
  );
  const userId = user.rows[0]!.id;
  ownedUsers.add(userId);
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, 'https://confluence.example.com', $2, TRUE)`,
    [userId, encryptPat('attachment-route-pat')],
  );
  if (input.withSpace !== false && !input.admin) {
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ($1, 'Attachment writer', ARRAY['read', 'write']) RETURNING id`,
      [`attachment-route-${suffix}`],
    );
    ownedRoles.add(role.rows[0]!.id);
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ('ATT', 'user', $1, $2)`,
      [userId, role.rows[0]!.id],
    );
  }
  return userId;
}

async function seedPage(input: {
  ownerId?: string;
  remoteId?: string;
  source?: 'confluence' | 'standalone';
  visibility?: 'private' | 'shared';
  bodyStorage?: string | null;
} = {}): Promise<{ id: number; remoteId: string }> {
  const source = input.source ?? 'confluence';
  const remoteId = input.remoteId ?? `attachment-${randomUUID()}`;
  const ownerId = input.ownerId ?? currentUserId;
  const page = await query<{ id: number }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, body_storage, source, visibility, created_by_user_id)
     VALUES ($1, $2, 'Attachment route', $3, $4, $5, $6)
     RETURNING id`,
    [
      source === 'confluence' ? remoteId : null,
      source === 'confluence' ? 'ATT' : '_standalone',
      input.bodyStorage ?? null,
      source,
      input.visibility ?? 'private',
      ownerId,
    ],
  );
  ownedPages.add(page.rows[0]!.id);
  return { id: page.rows[0]!.id, remoteId: source === 'confluence' ? remoteId : String(page.rows[0]!.id) };
}

async function freezePageForAdmission(pageId: number, actorId: string, remoteId: string): Promise<void> {
  const state = await query<{ content_revision: string; lifecycle_revision: string }>(
    `SELECT content_revision::text, lifecycle_revision::text FROM pages WHERE id = $1`,
    [pageId],
  );
  const runtimeId = `frozen-fixture-${randomUUID()}`;
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
     VALUES ($1, $2::jsonb)`,
    [runtimeId, JSON.stringify({ host: 'attachment-test', pid: 1, startedAt: new Date().toISOString() })],
  );
  ownedRuntimes.add(runtimeId);
  const intentId = randomUUID();
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
     VALUES ($1, $2, 'baseline.prepare', $3, ARRAY[$4]::int[], $5::jsonb,
             'local_verified', $6::jsonb)`,
    [
      intentId,
      runtimeId,
      actorId,
      pageId,
      JSON.stringify({
        [pageId]: {
          contentRevision: state.rows[0]!.content_revision,
          lifecycleRevision: state.rows[0]!.lifecycle_revision,
        },
      }),
      JSON.stringify({ effectClass: 'local', pageId }),
    ],
  );
  const baselineId = randomUUID();
  await query(
    `INSERT INTO page_baselines
       (id, page_id, original_page_id, page_identity, version, content_revision,
        lifecycle_revision, manifest_digest, manifest, manifest_bytes, title,
        attachments, total_bytes, reserved_bytes, status, prepared_by_user_id,
        prepared_by_name, preparation_intent_id, published_by_user_id,
        published_by_name, published_at, provenance, freeze_reason)
     VALUES ($1, $2, $2, $3::jsonb, 1, $4, $5, $6, '[]'::jsonb, $7,
             'Attachment route', '[]'::jsonb, 0, 0, 'published', $8,
             'Attachment writer', $9, $8, 'Attachment writer', NOW(),
             'manual_assertion', 'Frozen route regression')`,
    [
      baselineId,
      pageId,
      JSON.stringify(['page', 'confluence', String(pageId), remoteId]),
      state.rows[0]!.content_revision,
      state.rows[0]!.lifecycle_revision,
      '0'.repeat(64),
      Buffer.from('[]'),
      actorId,
      intentId,
    ],
  );
  await query(
    `UPDATE pages
        SET baseline_id = $2,
            frozen_version = 1,
            frozen_at = NOW(),
            frozen_by_user_id = $3,
            frozen_by_name = 'Attachment writer',
            freeze_reason = 'Frozen route regression',
            freeze_provenance = 'manual_assertion',
            freeze_reported_signatories = '[]'::jsonb
      WHERE id = $1`,
    [pageId, baselineId, actorId],
  );
}

beforeAll(async () => {
  if (!available) return;
  process.env.PAT_ENCRYPTION_KEY = 'attachment-route-test-key-at-least-32-characters';
  attachmentRoot = await mkdtemp(join(tmpdir(), 'compendiq-attachment-route-'));
  process.env.ATTACHMENTS_DIR = attachmentRoot;
  await setupTestDb();
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ('ATT', 'Attachment tests')
     ON CONFLICT (space_key) DO NOTHING`,
  );
  redis = createClient({
    url: process.env.REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: 1_000 },
  }) as RedisClientType;
  await redis.connect();
  setRedisClient(redis);

  app = Fastify({ logger: false });
  await app.register(sensible);
  app.setErrorHandler((error: Error & { statusCode?: number; reason?: string }, _request, reply) =>
    reply.status(error.statusCode ?? 500).send({
      statusCode: error.statusCode ?? 500,
      error: error.message,
      reason: error.reason,
    }));
  app.decorate('authenticate', async (request: { userId: string }) => {
    request.userId = currentUserId;
  });
  app.decorateRequest('userId', '');
  // ATTACHMENTS_DIR is module-load configuration, so this import deliberately
  // exercises that boundary only after the suite's owned directory exists.
  const { attachmentRoutes } = await import('./attachments.js');
  await app.register(attachmentRoutes, { prefix: '/api' });
  await app.ready();
});

beforeEach(async () => {
  if (!available) return;
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ('ATT', 'Attachment tests')
     ON CONFLICT (space_key) DO NOTHING`,
  );
  mockRequest.mockReset();
  respondHttp = async (url, options) => {
    throw new Error(`Unexpected Confluence request: ${options.method ?? 'GET'} ${url.pathname}`);
  };
  mockRequest.mockImplementation((url, options) =>
    respondHttp(new URL(String(url)), (options ?? {}) as { method?: string; body?: unknown }) as never);
  currentUserId = await seedUser();
});

afterEach(async () => {
  if (!available) return;
  for (const userId of ownedUsers) await invalidateRbacCache(userId);
  // Published baselines deliberately refuse DELETE. Reset this isolated
  // worker's fixture database instead of weakening the retention guard.
  await truncateAllTables();
  if (ownedRedisKeys.size > 0) await redis.del([...ownedRedisKeys]);
  ownedRedisKeys.clear();
  ownedPages.clear();
  ownedUsers.clear();
  ownedRoles.clear();
  ownedRuntimes.clear();
  await rm(attachmentRoot, { recursive: true, force: true });
  await mkdir(attachmentRoot, { recursive: true });
});

afterAll(async () => {
  if (!available) return;
  await app.close();
  setRedisClient(null as unknown as RedisClientType);
  await redis.quit();
  await teardownTestDb();
  await rm(attachmentRoot, { recursive: true, force: true });
  delete process.env.ATTACHMENTS_DIR;
  delete process.env.PAT_ENCRYPTION_KEY;
});

const describeIntegration = available ? describe : describe.skip;

describeIntegration('attachment routes with PostgreSQL, Redis and filesystem', () => {
  it('rejects malformed PNG, unsafe paths and inaccessible pages before provider mutation', async () => {
    const page = await seedPage();
    const malformed = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/diagram.png`,
      payload: { dataUri: `data:image/png;base64,${Buffer.from('not png').toString('base64')}` },
    });
    expect(malformed.statusCode).toBe(400);

    const unsafe = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/.hidden`,
      payload: { dataUri: PNG_DATA_URI },
    });
    expect(unsafe.statusCode).toBe(400);

    const outsider = await seedUser({ withSpace: false });
    currentUserId = outsider;
    const denied = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/diagram.png`,
      payload: { dataUri: PNG_DATA_URI },
    });
    expect(denied.statusCode).toBe(404);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('serves real cached bytes with SVG hardening and enforces standalone ownership', async () => {
    const confluence = await seedPage();
    const confluenceDir = join(attachmentRoot, confluence.remoteId);
    await mkdir(confluenceDir, { recursive: true });
    await writeFile(join(confluenceDir, 'diagram.svg'), '<svg><script>alert(1)</script></svg>');

    const served = await app.inject({
      method: 'GET',
      url: `/api/attachments/${confluence.remoteId}/diagram.svg`,
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-security-policy']).toBe('sandbox');
    expect(served.headers['content-disposition']).toBe('attachment');

    const standalone = await seedPage({ source: 'standalone' });
    const standaloneDir = join(attachmentRoot, standalone.remoteId);
    await mkdir(standaloneDir, { recursive: true });
    await writeFile(join(standaloneDir, 'owned.png'), PNG);
    const ownerRead = await app.inject({
      method: 'GET',
      url: `/api/attachments/${standalone.remoteId}/owned.png`,
    });
    expect(ownerRead.statusCode).toBe(200);
    const outsider = await seedUser({ withSpace: false });
    currentUserId = outsider;
    const denied = await app.inject({
      method: 'GET',
      url: `/api/attachments/${standalone.remoteId}/owned.png`,
    });
    expect(denied.statusCode).toBe(404);
  });

  it('lists real cache entries and reports filesystem failures instead of inventing emptiness', async () => {
    const page = await seedPage();
    const directory = join(attachmentRoot, page.remoteId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'diagram.png'), PNG);
    await writeFile(join(directory, 'diagram.drawio'), '<mxfile/>');

    const listed = await app.inject({ method: 'GET', url: `/api/attachments/${page.remoteId}/list` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ filename: 'diagram.png', size: PNG.length }),
      expect.objectContaining({ filename: 'diagram.drawio', size: 9 }),
    ]));

    await rm(directory, { recursive: true });
    await writeFile(directory, 'not a directory');
    const failed = await app.inject({ method: 'GET', url: `/api/attachments/${page.remoteId}/list` });
    expect(failed.statusCode).toBe(500);
  });

  it('fetches a missing referenced image through the external HTTP boundary and caches real bytes', async () => {
    const page = await seedPage({
      bodyStorage: '<ac:image><ri:attachment ri:filename="remote.png" /></ac:image>',
    });
    respondHttp = async (url) => {
      if (url.pathname.endsWith('/child/attachment')) {
        return jsonResponse({
          results: [{
            id: 'remote-image',
            title: 'remote.png',
            mediaType: 'image/png',
            extensions: { mediaType: 'image/png', fileSize: PNG.length },
            _links: { download: '/download/remote.png' },
          }],
          start: 0,
          limit: 100,
          size: 1,
        });
      }
      if (url.pathname === '/download/remote.png') return bufferResponse(PNG);
      throw new Error(`Unexpected request ${url.pathname}`);
    };

    const response = await app.inject({
      method: 'GET',
      url: `/api/attachments/${page.remoteId}/remote.png`,
    });
    expect(response.statusCode).toBe(200);
    await expect(readFile(join(attachmentRoot, page.remoteId, 'remote.png'))).resolves.toEqual(PNG);
  });

  it('returns provider failure honestly and uses the real Redis failure sentinel', async () => {
    const page = await seedPage({
      bodyStorage: '<ac:image><ri:attachment ri:filename="broken.png" /></ac:image>',
    });
    respondHttp = async () => jsonResponse({ message: 'provider failed' }, 500);
    const key = `attachment:failure:${currentUserId}:${page.remoteId}:broken.png`;
    ownedRedisKeys.add(key);

    const first = await app.inject({
      method: 'GET',
      url: `/api/attachments/${page.remoteId}/broken.png`,
    });
    expect(first.statusCode).toBe(502);
    expect(await redis.get(key)).toBe('1');
    mockRequest.mockClear();
    const second = await app.inject({
      method: 'GET',
      url: `/api/attachments/${page.remoteId}/broken.png`,
    });
    expect(second.statusCode).toBe(502);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('publishes PNG and XML only after both bounded remote receipts remain current', async () => {
    const page = await seedPage();
    const xml = '<mxfile><diagram>safe</diagram></mxfile>';
    const current = new Map<string, {
      id: string;
      title: string;
      version: { number: number; when: string };
    }>();
    respondHttp = async (url, options) => {
      if ((options.method ?? 'GET') === 'POST') {
        const body = Buffer.from(options.body as Uint8Array).toString('utf8');
        const filename = /filename="([^"]+)"/.exec(body)?.[1];
        if (!filename) throw new Error('Missing multipart filename');
        const attachment = {
          id: `${filename}-id`,
          title: filename,
          version: { number: 1, when: `${filename}-v1` },
        };
        current.set(filename, attachment);
        return jsonResponse({ results: [attachment] });
      }
      if (url.pathname.endsWith('/child/attachment')) {
        return jsonResponse({ results: [...current.values()], start: 0, limit: 100, size: current.size });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    };

    const response = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/diagram.png`,
      payload: { dataUri: PNG_DATA_URI, xml },
    });
    expect(response.statusCode, response.body).toBe(200);
    await expect(readFile(join(attachmentRoot, page.remoteId, 'diagram.png'))).resolves.toEqual(PNG);
    await expect(readFile(join(attachmentRoot, page.remoteId, 'diagram.drawio'), 'utf8')).resolves.toBe(xml);
    const intent = await query<{
      status: string;
      effect: { receipts: unknown[] };
      remote_terminal_result: { receipts: unknown[] };
    }>(
      `SELECT status, effect, remote_terminal_result
         FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::int[] AND kind = 'attachment.confluence.put'`,
      [page.id],
    );
    expect(intent.rows[0]!.status).toBe('completed');
    expect(intent.rows[0]!.effect.receipts).toEqual([
      {
        filename: 'diagram.png',
        serverId: 'diagram.png-id',
        versionNumber: 1,
        versionWhen: 'diagram.png-v1',
      },
      {
        filename: 'diagram.drawio',
        serverId: 'diagram.drawio-id',
        versionNumber: 1,
        versionWhen: 'diagram.drawio-v1',
      },
    ]);
    expect(intent.rows[0]!.remote_terminal_result.receipts)
      .toEqual(intent.rows[0]!.effect.receipts);
  });

  it('accepts a sparse upload response only after the current remote bytes match', async () => {
    const page = await seedPage();
    respondHttp = async (url, options) => {
      if ((options.method ?? 'GET') === 'POST') {
        return jsonResponse({
          results: [{ id: 'sparse-id', title: 'sparse.png' }],
        });
      }
      if (url.pathname.endsWith('/child/attachment')) {
        return jsonResponse({
          results: [{
            id: 'sparse-id',
            title: 'sparse.png',
            _links: { download: '/download/sparse-id' },
          }],
          start: 0,
          limit: 100,
          size: 1,
        });
      }
      if (url.pathname === '/download/sparse-id') return bufferResponse(PNG);
      throw new Error(`Unexpected request ${url.pathname}`);
    };

    const response = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/sparse.png`,
      payload: { dataUri: PNG_DATA_URI },
    });
    expect(response.statusCode, response.body).toBe(200);
    await expect(readFile(join(attachmentRoot, page.remoteId, 'sparse.png')))
      .resolves.toEqual(PNG);
    const intent = await query<{
      remote_terminal_result: {
        receipts: Array<{ versionNumber: number | null; versionWhen: string | null }>;
      };
    }>(
      `SELECT remote_terminal_result
         FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::int[] AND kind = 'attachment.confluence.put'`,
      [page.id],
    );
    expect(intent.rows[0]!.remote_terminal_result.receipts).toEqual([expect.objectContaining({
      versionNumber: null,
      versionWhen: null,
    })]);
  });

  it('recovers a sparse final receipt after wrapper completion fails without replaying the upload', async () => {
    const page = await seedPage();
    let posts = 0;
    let attachmentReads = 0;
    let downloads = 0;
    respondHttp = async (url, options) => {
      if ((options.method ?? 'GET') === 'POST') {
        posts += 1;
        return jsonResponse({
          results: [{ id: 'crash-window-id', title: 'crash-window.png' }],
        });
      }
      if (url.pathname.endsWith('/child/attachment')) {
        attachmentReads += 1;
        return jsonResponse({
          results: [{
            id: 'crash-window-id',
            title: 'crash-window.png',
            _links: { download: '/download/crash-window-id' },
          }],
          start: 0,
          limit: 100,
          size: 1,
        });
      }
      if (url.pathname === '/download/crash-window-id') {
        downloads += 1;
        return bufferResponse(PNG);
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    };

    // Fail the generic wrapper's effect_finished_at write after the route has
    // atomically committed the final receipt and remote terminal marker.
    const suffix = randomUUID().replaceAll('-', '_');
    const functionName = `att_wrap_fn_${suffix}`;
    const triggerName = `att_wrap_trg_${suffix}`;
    await query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.effect_finished_at IS NULL
            AND NEW.effect_finished_at IS NOT NULL
            AND OLD.remote_effects_completed_at IS NOT NULL
            AND OLD.effect->>'remotePageId' = TG_ARGV[0]
         THEN
           RAISE EXCEPTION 'injected wrapper completion fault';
         END IF;
         RETURN NEW;
       END
       $$`,
    );
    await query(
      `CREATE TRIGGER ${triggerName}
       BEFORE UPDATE ON page_write_intents
       FOR EACH ROW EXECUTE FUNCTION ${functionName}('${page.remoteId}')`,
    );
    const response = await (async () => {
      try {
        return await app.inject({
          method: 'PUT',
          url: `/api/attachments/${page.remoteId}/crash-window.png`,
          payload: { dataUri: PNG_DATA_URI },
        });
      } finally {
        await query(`DROP TRIGGER ${triggerName} ON page_write_intents`);
        await query(`DROP FUNCTION ${functionName}()`);
      }
    })();

    expect(response.statusCode).toBe(500);
    expect(posts).toBe(1);
    expect(attachmentReads).toBe(0);
    const intent = await query<{
      id: string;
      status: string;
      effect_finished_at: Date | null;
      remote_effects_completed_at: Date | null;
      effect: { receipts: unknown[] };
      remote_terminal_result: Record<string, unknown> & { receipts: unknown[] };
    }>(
      `SELECT id, status, effect_finished_at, remote_effects_completed_at,
              effect, remote_terminal_result
         FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::int[] AND kind = 'attachment.confluence.put'`,
      [page.id],
    );
    const crashed = intent.rows[0]!;
    expect(crashed).toMatchObject({
      status: 'pending',
      effect_finished_at: null,
      remote_effects_completed_at: expect.any(Date),
    });
    expect(crashed.remote_terminal_result).toEqual({
      remotePageId: page.remoteId,
      publicationContentRevision: '0',
      receipts: [{
        filename: 'crash-window.png',
        serverId: 'crash-window-id',
        versionNumber: null,
        versionWhen: null,
      }],
    });
    expect(crashed.remote_terminal_result.receipts).toEqual(crashed.effect.receipts);
    const encodedTerminal = JSON.stringify(crashed.remote_terminal_result);
    expect(Buffer.byteLength(encodedTerminal)).toBeLessThan(4 * 1024);
    expect(encodedTerminal).not.toContain(PNG.toString('base64'));
    await expect(stat(join(
      attachmentRoot,
      page.remoteId,
      `.page-write-${crashed.id}-0.stage`,
    ))).resolves.toBeDefined();

    const recoveryAdminId = await seedUser({ admin: true });
    const fencedRuntime = `fenced-attachment-${randomUUID()}`;
    ownedRuntimes.add(fencedRuntime);
    await query(
      `INSERT INTO page_writer_runtimes
         (runtime_id, deployment_identity, fenced_at, fenced_by, fence_reason, fence_proof)
       VALUES ($1, $2::jsonb, NOW(), $3, 'Injected post-receipt writer crash', $4::jsonb)`,
      [
        fencedRuntime,
        JSON.stringify({ host: 'attachment-crash-test', pid: 999999, startedAt: new Date().toISOString() }),
        recoveryAdminId,
        JSON.stringify({
          kind: 'verified_local_termination',
          deploymentIdentity: { host: 'attachment-crash-test', pid: 999999 },
        }),
      ],
    );
    // The HTTP request and its runtime have ended at this point. Rebind only
    // the test row to the fenced epoch because Vitest itself remains in the
    // same process and cannot actually restart around this crash-window case.
    await query(
      'UPDATE page_write_intents SET runtime_id = $2 WHERE id = $1',
      [crashed.id, fencedRuntime],
    );

    await expect(reconcilePageWriteIntent(crashed.id, {
      actorId: recoveryAdminId,
      reason: 'Recover the exact final attachment receipt after verified writer termination',
    })).resolves.toEqual({
      intentId: crashed.id,
      status: 'reconciled_applied',
    });
    expect(posts).toBe(1);
    expect(attachmentReads).toBe(1);
    expect(downloads).toBe(1);
    await expect(readFile(join(attachmentRoot, page.remoteId, 'crash-window.png')))
      .resolves.toEqual(PNG);
    const recovered = await query<{ status: string }>(
      'SELECT status FROM page_write_intents WHERE id = $1',
      [crashed.id],
    );
    expect(recovered.rows[0]!.status).toBe('reconciled_applied');
  });

  it('rechecks current connection authority after remote-start admission before the first upload', async () => {
    const page = await seedPage();
    const pageBefore = (await query<{
      content_revision: string;
      lifecycle_revision: string;
      image_analysis_dirty: boolean;
    }>(
      `SELECT content_revision::text, lifecycle_revision::text, image_analysis_dirty
         FROM pages
        WHERE id = $1`,
      [page.id],
    )).rows[0]!;
    const suffix = randomUUID().replaceAll('-', '_');
    const functionName = `att_remote_start_wait_fn_${suffix}`;
    const triggerName = `att_remote_start_wait_trg_${suffix}`;
    const barrier = await getPool().connect();
    let pending: Promise<LightMyRequestResponse> | undefined;
    let posts = 0;

    respondHttp = async (_url, options) => {
      if ((options.method ?? 'GET') !== 'POST') throw new Error('No provider evidence read expected');
      posts += 1;
      return jsonResponse({
        results: [{
          id: 'stale-first-upload-id',
          title: 'authority-race.png',
          version: { number: 1, when: 'stale-v1' },
        }],
      });
    };
    await query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.remote_effect_started_at IS NULL
            AND NEW.remote_effect_started_at IS NOT NULL
            AND NEW.kind = 'attachment.confluence.put'
            AND NEW.effect->>'remotePageId' = TG_ARGV[0]
         THEN
           PERFORM pg_advisory_xact_lock(275, NEW.page_ids[1]);
         END IF;
         RETURN NEW;
       END
       $$`,
    );
    await query(
      `CREATE TRIGGER ${triggerName}
       BEFORE UPDATE OF remote_effect_started_at ON page_write_intents
       FOR EACH ROW EXECUTE FUNCTION ${functionName}('${page.remoteId}')`,
    );

    try {
      await barrier.query('SELECT pg_advisory_lock($1, $2)', [275, page.id]);
      const barrierPid = (await barrier.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0]!.pid;
      pending = app.inject({
        method: 'PUT',
        url: `/api/attachments/${page.remoteId}/authority-race.png`,
        payload: { dataUri: PNG_DATA_URI },
      });
      await vi.waitFor(async () => {
        const blocked = await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND $1 = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [barrierPid],
        );
        expect(blocked.rows[0]!.waiting).toBe(true);
      });

      await query(
        `UPDATE user_settings
            SET confluence_enabled = FALSE,
                confluence_url = 'https://rotated.example.com',
                confluence_pat = $2
          WHERE user_id = $1`,
        [currentUserId, encryptPat('rotated-after-remote-start-admission')],
      );
      await barrier.query('SELECT pg_advisory_unlock($1, $2)', [275, page.id]);

      const response = await pending;
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().reason).toBe('intent_connection_changed');
    } finally {
      await barrier.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      await pending?.catch(() => undefined);
      barrier.release();
      await query(`DROP TRIGGER IF EXISTS ${triggerName} ON page_write_intents`);
      await query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    expect(posts).toBe(0);
    expect(mockRequest).not.toHaveBeenCalled();
    await expect(stat(join(attachmentRoot, page.remoteId, 'authority-race.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const pageAfter = (await query<{
      content_revision: string;
      lifecycle_revision: string;
      image_analysis_dirty: boolean;
    }>(
      `SELECT content_revision::text, lifecycle_revision::text, image_analysis_dirty
         FROM pages
        WHERE id = $1`,
      [page.id],
    )).rows[0]!;
    expect(pageAfter).toEqual(pageBefore);
    expect((await query(
      'SELECT 1 FROM local_attachments WHERE page_id = $1',
      [page.id],
    )).rowCount).toBe(0);

    const intent = (await query<{
      id: string;
      status: string;
      recovery_mode: string;
      effect_started_at: Date | null;
      effect_finished_at: Date | null;
      remote_effect_started_at: Date | null;
      remote_effects_completed_at: Date | null;
      remote_terminal_result: Record<string, unknown> | null;
      effect: {
        files: Array<{ filename: string; size: number; sha256: string }>;
        receipts: unknown[];
      };
    }>(
      `SELECT id, status, recovery_mode, effect_started_at, effect_finished_at,
              remote_effect_started_at, remote_effects_completed_at,
              remote_terminal_result, effect
         FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::int[]
          AND kind = 'attachment.confluence.put'`,
      [page.id],
    )).rows[0]!;
    expect(intent).toMatchObject({
      status: 'pending',
      recovery_mode: 'remote_terminal_only',
      effect_started_at: expect.any(Date),
      effect_finished_at: null,
      remote_effect_started_at: expect.any(Date),
      remote_effects_completed_at: null,
      remote_terminal_result: null,
      effect: {
        files: [{
          filename: 'authority-race.png',
          size: PNG.length,
          sha256: createHash('sha256').update(PNG).digest('hex'),
        }],
        receipts: [],
      },
    });
    await expect(readFile(join(
      attachmentRoot,
      page.remoteId,
      `.page-write-${intent.id}-0.stage`,
    ))).resolves.toEqual(PNG);
  });

  it('stops before the second remote upload when original authority is revoked', async () => {
    const page = await seedPage();
    let posts = 0;
    respondHttp = async (_url, options) => {
      if ((options.method ?? 'GET') !== 'POST') throw new Error('No evidence read expected');
      posts += 1;
      if (posts === 1) {
        await query(
          `DELETE FROM space_role_assignments
            WHERE space_key = 'ATT' AND principal_id = $1`,
          [currentUserId],
        );
      }
      const filename = posts === 1 ? 'diagram.png' : 'diagram.drawio';
      return jsonResponse({
        results: [{ id: `${filename}-id`, title: filename, version: { number: 1, when: 'v1' } }],
      });
    };

    const response = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/diagram.png`,
      payload: { dataUri: PNG_DATA_URI, xml: '<mxfile/>' },
    });
    expect(response.statusCode).toBe(403);
    expect(posts).toBe(1);
    await expect(stat(join(attachmentRoot, page.remoteId, 'diagram.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const intent = await query<{
      status: string;
      effect: { receipts: unknown[] };
      remote_effects_completed_at: Date | null;
      remote_terminal_result: Record<string, unknown> | null;
    }>(
      `SELECT status, effect, remote_effects_completed_at, remote_terminal_result
         FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::int[] AND kind = 'attachment.confluence.put'`,
      [page.id],
    );
    expect(intent.rows[0]).toMatchObject({
      status: 'pending',
      remote_effects_completed_at: null,
      remote_terminal_result: null,
    });
    expect(intent.rows[0]!.effect.receipts).toHaveLength(1);
  });

  it('keeps both staged files pending when one upload fails', async () => {
    const page = await seedPage();
    let posts = 0;
    respondHttp = async (_url, options) => {
      if ((options.method ?? 'GET') !== 'POST') throw new Error('Unexpected evidence read');
      posts += 1;
      if (posts === 2) return jsonResponse({ message: 'XML rejected' }, 500);
      return jsonResponse({
        results: [{
          id: 'png-id',
          title: 'diagram.png',
          version: { number: 1, when: 'v1' },
        }],
      });
    };

    const response = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/diagram.png`,
      payload: { dataUri: PNG_DATA_URI, xml: '<mxfile/>' },
    });
    expect(response.statusCode).toBe(500);
    await expect(stat(join(attachmentRoot, page.remoteId, 'diagram.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const pending = await query<{
      id: string;
      status: string;
      remote_effects_completed_at: Date | null;
      remote_terminal_result: Record<string, unknown> | null;
    }>(
      `SELECT id, status, remote_effects_completed_at, remote_terminal_result
         FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::int[] AND kind = 'attachment.confluence.put'`,
      [page.id],
    );
    expect(pending.rows[0]).toMatchObject({
      status: 'pending',
      remote_effects_completed_at: null,
      remote_terminal_result: null,
    });
    await expect(stat(join(
      attachmentRoot,
      page.remoteId,
      `.page-write-${pending.rows[0]!.id}-0.stage`,
    ))).resolves.toBeDefined();
    await expect(stat(join(
      attachmentRoot,
      page.remoteId,

      `.page-write-${pending.rows[0]!.id}-1.stage`,
    ))).resolves.toBeDefined();
  });

  it('keeps an acknowledged remote mutation pending when its receipt is malformed', async () => {
    const page = await seedPage();
    respondHttp = async (_url, options) => {
      if ((options.method ?? 'GET') !== 'POST') throw new Error('Unexpected evidence read');
      return jsonResponse({
        results: [{ id: '', title: 'malformed.png' }],
      });
    };

    const response = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/malformed.png`,
      payload: { dataUri: PNG_DATA_URI },
    });
    expect(response.statusCode).toBe(502);
    const pending = await query<{
      id: string;
      status: string;
      effect: { receipts: unknown[] };
      remote_effects_completed_at: Date | null;
      remote_terminal_result: Record<string, unknown> | null;
    }>(
      `SELECT id, status, effect, remote_effects_completed_at, remote_terminal_result
         FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::int[] AND kind = 'attachment.confluence.put'`,
      [page.id],
    );
    expect(pending.rows[0]).toMatchObject({
      status: 'pending',
      effect: { receipts: [] },
      remote_effects_completed_at: null,
      remote_terminal_result: null,
    });
    await expect(stat(join(
      attachmentRoot,
      page.remoteId,
      `.page-write-${pending.rows[0]!.id}-0.stage`,
    ))).resolves.toBeDefined();
    await expect(stat(join(attachmentRoot, page.remoteId, 'malformed.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the existing 400 contract when the actor has no Confluence credentials', async () => {
    const page = await seedPage();
    await query(
      `UPDATE user_settings
          SET confluence_url = NULL, confluence_pat = NULL
        WHERE user_id = $1`,
      [currentUserId],
    );
    const response = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/diagram.png`,
      payload: { dataUri: PNG_DATA_URI },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('No Confluence connection configured');
    expect(mockRequest).not.toHaveBeenCalled();
    const intents = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM page_write_intents
        WHERE page_ids = ARRAY[$1]::int[]`,
      [page.id],
    );
    expect(intents.rows[0]!.count).toBe('0');
  });

  it('rejects an attachment above the 10 MB binary limit before provider I/O', async () => {
    const page = await seedPage();
    const oversized = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(10 * 1024 * 1024, 0),
    ]);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/oversized.png`,
      payload: { dataUri: `data:image/png;base64,${oversized.toString('base64')}` },
    });
    expect(response.statusCode).toBe(413);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('refuses attachment mutation for a genuinely frozen page before provider I/O', async () => {
    const page = await seedPage();
    await freezePageForAdmission(page.id, currentUserId, page.remoteId);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/diagram.png`,
      payload: { dataUri: PNG_DATA_URI },
    });
    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({ reason: 'page_is_frozen' });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('accepts a valid PNG above Fastify default while enforcing the route size contract', async () => {
    const page = await seedPage();
    const largePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(1024 * 1024, 0),
    ]);
    let attachment: {
      id: string;
      title: string;
      version: { number: number; when: string };
    } | null = null;
    respondHttp = async (url, options) => {
      if ((options.method ?? 'GET') === 'POST') {
        attachment = {
          id: 'large-id',
          title: 'large.png',
          version: { number: 1, when: 'v1' },
        };
        return jsonResponse({ results: [attachment] });
      }
      if (url.pathname.endsWith('/child/attachment')) {
        return jsonResponse({ results: attachment ? [attachment] : [], start: 0, limit: 100, size: attachment ? 1 : 0 });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    };
    const accepted = await app.inject({
      method: 'PUT',
      url: `/api/attachments/${page.remoteId}/large.png`,
      payload: { dataUri: `data:image/png;base64,${largePng.toString('base64')}` },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });
});
