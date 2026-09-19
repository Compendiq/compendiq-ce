import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import type * as Undici from 'undici';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { reconcilePageWriteIntent } from '../../core/services/page-write-admission.js';
import { encryptPat } from '../../core/utils/crypto.js';

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  request: vi.fn(),
}));

const mockRequest = vi.mocked(request);
const dbAvailable = await isDbAvailable();
let attachmentRoot = '';
let registerAttachmentReconciler: () => void;
const ownedActors = new Set<string>();
const ownedPages = new Set<number>();
const ownedIntents = new Set<string>();
const ownedRoles = new Set<number>();
const ownedRuntimes = new Set<string>();

type RemoteAttachment = {
  id: string;
  title: string;
  version?: { number: number; when: string };
};

let remoteAttachments: RemoteAttachment[] = [];

function jsonResponse(data: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {},
    body: { text: async () => JSON.stringify(data) },
  };
}

async function seedActorAndPage(input: { admin?: boolean } = {}): Promise<{
  actorId: string;
  pageId: number;
  contentRevision: string;
  lifecycleRevision: string;
}> {
  const suffix = randomUUID();
  const actor = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`attachment-recovery-${suffix}`, `${suffix}@test.invalid`, input.admin === false ? 'user' : 'admin'],
  );
  const actorId = actor.rows[0]!.id;
  ownedActors.add(actorId);
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ('REC', 'Recovery')
     ON CONFLICT (space_key) DO NOTHING`,
  );
  if (input.admin === false) {
    const roleName = `attachment-recovery-${suffix}`;
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions)
       VALUES ($1, 'Attachment recovery', ARRAY['read', 'write']) RETURNING id`,
      [roleName],
    );
    ownedRoles.add(role.rows[0]!.id);
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ('REC', 'user', $1, $2)`,
      [actorId, role.rows[0]!.id],
    );
  }
  await query(
    `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
     VALUES ($1, 'https://confluence.example.com', $2, TRUE)`,
    [actorId, encryptPat('attachment-recovery-pat')],
  );
  const page = await query<{
    id: number;
    content_revision: string;
    lifecycle_revision: string;
  }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, source, visibility, created_by_user_id)
     VALUES ('remote-attachment-page', 'REC', 'Attachment recovery', 'confluence', 'private', $1)
     RETURNING id, content_revision::text, lifecycle_revision::text`,
    [actorId],
  );
  const row = page.rows[0]!;
  ownedPages.add(row.id);
  return {
    actorId,
    pageId: row.id,
    contentRevision: row.content_revision,
    lifecycleRevision: row.lifecycle_revision,
  };
}

async function seedFencedIntent(input: {
  actorId: string;
  pageId: number;
  contentRevision: string;
  lifecycleRevision: string;
  files: Array<{
    filename: string;
    bytes: Buffer;
    serverId?: string;
    versionNumber?: number;
    versionWhen?: string;
  }>;
  remoteStarted: boolean;
  remoteCompleted: boolean;
  terminalReceipts?: number;
}): Promise<{ id: string; stagePaths: string[] }> {
  const runtimeId = `dead-${randomUUID()}`;
  ownedRuntimes.add(runtimeId);
  await query(
    `INSERT INTO page_writer_runtimes
       (runtime_id, deployment_identity, fenced_at, fenced_by, fence_reason, fence_proof)
     VALUES ($1, $2::jsonb, NOW(), $3, 'Verified dead writer for attachment recovery', $4::jsonb)`,
    [
      runtimeId,
      JSON.stringify({ host: 'test-host', pid: 999999, startedAt: new Date().toISOString() }),
      input.actorId,
      JSON.stringify({ kind: 'verified_local_termination', deploymentIdentity: { host: 'test-host' } }),
    ],
  );
  const intentId = randomUUID();
  ownedIntents.add(intentId);
  const files = input.files.map((file) => ({
    filename: file.filename,
    size: file.bytes.length,
    sha256: createHash('sha256').update(file.bytes).digest('hex'),
  }));
  const receipts = input.files
    .slice(0, input.terminalReceipts ?? input.files.length)
    .map((file, index) => ({
      filename: file.filename,
      serverId: file.serverId ?? `attachment-${index}`,
      versionNumber: file.versionNumber ?? 1,
      versionWhen: file.versionWhen ?? `2026-09-19T00:00:0${index}.000Z`,
    }));
  await query(
    `INSERT INTO page_write_intents
       (id, runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect,
        effect_started_at, remote_effect_started_at, remote_effects_completed_at,
        remote_terminal_result)
     VALUES ($1, $2, 'attachment.confluence.put', $3, ARRAY[$4]::int[], $5::jsonb,
             'remote_terminal_only', $6::jsonb, NOW(),
             CASE WHEN $7 THEN NOW() ELSE NULL END,
             CASE WHEN $8 THEN NOW() ELSE NULL END,
             CASE WHEN $8 THEN $9::jsonb ELSE NULL END)`,
    [
      intentId,
      runtimeId,
      input.actorId,
      input.pageId,
      JSON.stringify({
        [input.pageId]: {
          contentRevision: input.contentRevision,
          lifecycleRevision: input.lifecycleRevision,
        },
      }),
      JSON.stringify({
        effectClass: 'remote',
        pageId: input.pageId,
        remotePageId: 'remote-attachment-page',
        spaceKey: 'REC',
        files,
        receipts,
      }),
      input.remoteStarted,
      input.remoteCompleted,
      JSON.stringify({
        remotePageId: 'remote-attachment-page',
        publicationContentRevision: input.contentRevision,
        receipts,
      }),
    ],
  );
  const stagePaths = input.files.map((file, index) => join(
    attachmentRoot,
    'remote-attachment-page',
    `.page-write-${intentId}-${index}.stage`,
  ));
  await mkdir(dirname(stagePaths[0]!), { recursive: true });
  await Promise.all(stagePaths.map((stagePath, index) => writeFile(stagePath, input.files[index]!.bytes)));
  return { id: intentId, stagePaths };
}

beforeAll(async () => {
  if (!dbAvailable) return;
  process.env.PAT_ENCRYPTION_KEY = 'attachment-recovery-test-key-at-least-32-characters';
  attachmentRoot = await mkdtemp(join(tmpdir(), 'compendiq-attachment-recovery-'));
  process.env.ATTACHMENTS_DIR = attachmentRoot;
  await setupTestDb();
  // ATTACHMENTS_DIR is read at module initialization, so this dynamic import
  // intentionally exercises the test-owned storage boundary.
  ({ registerAttachmentReconciler } = await import('./attachments.js'));
  registerAttachmentReconciler();
});

beforeEach(() => {
  if (!dbAvailable) return;
  remoteAttachments = [];
  mockRequest.mockReset();
  mockRequest.mockImplementation(async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/child/attachment')) {
      return jsonResponse({
        results: remoteAttachments,
        start: 0,
        limit: 100,
        size: remoteAttachments.length,
      }) as never;
    }
    throw new Error(`Unexpected Confluence request: ${parsed.pathname}`);
  });
});

afterEach(async () => {
  if (!dbAvailable) return;
  if (ownedIntents.size > 0) {
    await query('DELETE FROM page_write_intents WHERE id = ANY($1::uuid[])', [[...ownedIntents]]);
  }
  if (ownedRuntimes.size > 0) {
    await query(
      'DELETE FROM page_writer_runtimes WHERE runtime_id = ANY($1::text[])',
      [[...ownedRuntimes]],
    );
  }
  if (ownedPages.size > 0) {
    await query('DELETE FROM pages WHERE id = ANY($1::int[])', [[...ownedPages]]);
  }
  if (ownedActors.size > 0) {
    await query(
      `DELETE FROM space_role_assignments
        WHERE principal_type = 'user'
          AND principal_id = ANY($1::text[])`,
      [[...ownedActors]],
    );
  }
  if (ownedActors.size > 0) {
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[...ownedActors]]);
  }
  if (ownedRoles.size > 0) {
    await query('DELETE FROM roles WHERE id = ANY($1::int[])', [[...ownedRoles]]);
  }
  ownedIntents.clear();
  ownedPages.clear();
  ownedActors.clear();
  ownedRoles.clear();
  ownedRuntimes.clear();
  await rm(join(attachmentRoot, 'remote-attachment-page'), { recursive: true, force: true });
});

afterAll(async () => {
  if (!dbAvailable) return;
  await teardownTestDb();
  await rm(attachmentRoot, { recursive: true, force: true });
  delete process.env.ATTACHMENTS_DIR;
  delete process.env.PAT_ENCRYPTION_KEY;
});

const describeDb = dbAvailable ? describe : describe.skip;

describeDb('attachment.confluence.put recovery', () => {
  it('removes only the exact owned stages after a fenced pre-remote crash', async () => {
    const seeded = await seedActorAndPage();
    const staged = await seedFencedIntent({
      ...seeded,
      files: [{ filename: 'diagram.png', bytes: Buffer.from('staged attachment bytes') }],
      remoteStarted: false,
      remoteCompleted: false,
    });
    const unrelated = join(dirname(staged.stagePaths[0]!), 'keep-me.stage');
    await writeFile(unrelated, 'unrelated');

    await expect(reconcilePageWriteIntent(staged.id, {
      actorId: seeded.actorId,
      reason: 'The fenced writer crashed after exact local staging and before remote dispatch',
    })).resolves.toEqual({ intentId: staged.id, status: 'reconciled_not_applied' });

    await expect(stat(staged.stagePaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('unrelated');
  });

  it('keeps both stale stages inactive when either terminal attachment conflicts', async () => {
    const seeded = await seedActorAndPage();
    const png = Buffer.from('admitted png bytes');
    const xml = Buffer.from('<mxfile>admitted</mxfile>');
    const staged = await seedFencedIntent({
      ...seeded,
      files: [
        { filename: 'diagram.png', bytes: png, serverId: 'png-id', versionWhen: 'v1' },
        { filename: 'diagram.drawio', bytes: xml, serverId: 'xml-id', versionWhen: 'v1' },
      ],
      remoteStarted: true,
      remoteCompleted: true,
    });
    remoteAttachments = [
      { id: 'png-id', title: 'diagram.png', version: { number: 1, when: 'v1' } },
      {
        id: 'xml-id',
        title: 'diagram.drawio',
        version: { number: 2, when: 'v2' },
      },
    ];

    await expect(reconcilePageWriteIntent(staged.id, {
      actorId: seeded.actorId,
      reason: 'Verify every terminal provider identity before cache publication',
    })).rejects.toMatchObject({ reason: 'intent_remote_evidence_conflict' });

    await expect(readFile(staged.stagePaths[0]!)).resolves.toEqual(png);
    await expect(readFile(staged.stagePaths[1]!)).resolves.toEqual(xml);
    await expect(stat(join(attachmentRoot, 'remote-attachment-page', 'diagram.png')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const pending = await query<{ status: string }>(
      'SELECT status FROM page_write_intents WHERE id = $1',
      [staged.id],
    );
    expect(pending.rows[0]!.status).toBe('pending');
  });

  it('does not activate either file when the terminal receipt set is incomplete', async () => {
    const seeded = await seedActorAndPage();
    const staged = await seedFencedIntent({
      ...seeded,
      files: [
        { filename: 'diagram.png', bytes: Buffer.from('png') },
        { filename: 'diagram.drawio', bytes: Buffer.from('xml') },
      ],
      remoteStarted: true,
      remoteCompleted: true,
      terminalReceipts: 1,
    });

    await expect(reconcilePageWriteIntent(staged.id, {
      actorId: seeded.actorId,
      reason: 'Incomplete terminal evidence must remain pending',
    })).rejects.toMatchObject({ reason: 'intent_terminal_result_invalid' });
    await expect(stat(staged.stagePaths[0]!)).resolves.toBeDefined();
    await expect(stat(staged.stagePaths[1]!)).resolves.toBeDefined();
  });

  it('revalidates original authority before reading provider evidence or publishing files', async () => {
    const seeded = await seedActorAndPage({ admin: false });
    const bytes = Buffer.from('authorized only before recovery');
    const staged = await seedFencedIntent({
      ...seeded,
      files: [{ filename: 'diagram.png', bytes, serverId: 'png-id', versionWhen: 'v1' }],
      remoteStarted: true,
      remoteCompleted: true,
    });
    await query(
      `DELETE FROM space_role_assignments
        WHERE space_key = 'REC' AND principal_id = $1`,
      [seeded.actorId],
    );

    await expect(reconcilePageWriteIntent(staged.id, {
      actorId: seeded.actorId,
      reason: 'Authority was revoked after the remote response',
    })).rejects.toMatchObject({ reason: 'intent_access_changed' });
    expect(mockRequest).not.toHaveBeenCalled();
    await expect(readFile(staged.stagePaths[0]!)).resolves.toEqual(bytes);
  });

  it('leaves the intent pending when local evidence cannot be read', async () => {
    const seeded = await seedActorAndPage();
    const bytes = Buffer.from('remote bytes');
    const staged = await seedFencedIntent({
      ...seeded,
      files: [{ filename: 'diagram.png', bytes, serverId: 'png-id', versionWhen: 'v1' }],
      remoteStarted: true,
      remoteCompleted: true,
    });
    remoteAttachments = [{
      id: 'png-id',
      title: 'diagram.png',
      version: { number: 1, when: 'v1' },
    }];
    await rm(staged.stagePaths[0]!);
    await mkdir(staged.stagePaths[0]!);

    await expect(reconcilePageWriteIntent(staged.id, {
      actorId: seeded.actorId,
      reason: 'A filesystem fault must remain recoverable',
    })).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|EACCES|EPERM/) });
    const pending = await query<{ status: string }>(
      'SELECT status FROM page_write_intents WHERE id = $1',
      [staged.id],
    );
    expect(pending.rows[0]!.status).toBe('pending');
  });
});
