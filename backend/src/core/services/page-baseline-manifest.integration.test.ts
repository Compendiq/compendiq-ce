import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { renameSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import {
  completePageWriteIntent,
  reservePageWriteIntent,
  type PageWriteIntent,
} from './page-write-admission.js';
import { cleanupStandalonePageAttachmentDirs } from './standalone-attachment-cleanup.js';
import {
  BASELINE_STORE_DIRNAME,
  assertBaselineRetentionCapacity,
  baselineManifestSourcePageIds,
  type BaselineAttachment,
  type PreparedBaselineManifest,
  inspectBaselineManifest,
  isBaselinePreparationAbsent,
  readBaselineAttachment,
  removeBaselinePreparation,
  retainBaselineManifest,
  verifyBaselineAttachments,
} from './page-baseline-manifest.js';

const dbAvailable = await isDbAvailable();
const originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
const TEST_ACTOR_ID = '00000000-0000-4000-8000-000000000001';
let attachmentsDir = '';

async function writeStoredFile(...segmentsAndBytes: [...string[], Buffer]): Promise<string> {
  const bytes = segmentsAndBytes.at(-1) as Buffer;
  const segments = segmentsAndBytes.slice(0, -1) as string[];
  const file = path.join(attachmentsDir, ...segments);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return file;
}
async function inspect(
  pageId: number,
  baselineId = randomUUID(),
  actorId = TEST_ACTOR_ID,
): Promise<PreparedBaselineManifest> {
  const client = await getPool().connect();
  try {
    return await inspectBaselineManifest(client, pageId, baselineId, actorId);
  } finally {
    client.release();
  }
}

async function authorizeRetention(preflight: PreparedBaselineManifest): Promise<PageWriteIntent> {
  const intent = await reservePageWriteIntent({
    pageIds: [...baselineManifestSourcePageIds(preflight)],
    kind: 'baseline.prepare',
    effect: { effectClass: 'local', baselineId: preflight.baselineId },
  });
  const revision = await query<{ lifecycle_revision: string }>(
    'SELECT lifecycle_revision::text FROM pages WHERE id = $1',
    [preflight.pageId],
  );
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT reserved_bytes FROM page_baseline_capacity WHERE singleton = TRUE FOR UPDATE');
    await assertBaselineRetentionCapacity(client, preflight.totalBytes);
    await client.query(
      `UPDATE page_baseline_capacity
          SET reserved_bytes = reserved_bytes + $1, updated_at = NOW()
        WHERE singleton = TRUE`,
      [preflight.totalBytes],
    );
    await client.query(
      `INSERT INTO page_baselines (
         id, page_id, original_page_id, page_identity, version,
         content_revision, lifecycle_revision, manifest_digest, manifest,
         manifest_bytes, title, body_html, body_storage, body_text, labels,
         parent_identity, icon, attachments, total_bytes, reserved_bytes,
         prepared_by_name, preparation_intent_id
       ) VALUES (
         $1, $2, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb,
         $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb,
         $17::jsonb, $18, $18, 'Manifest test', $19
       )`,
      [
        preflight.baselineId,
        preflight.pageId,
        JSON.stringify(preflight.manifest[3]),
        preflight.version,
        preflight.contentRevision,
        revision.rows[0]!.lifecycle_revision,
        preflight.manifestDigest,
        JSON.stringify(preflight.manifest),
        preflight.manifestBytes,
        preflight.manifest[6],
        preflight.manifest[7],
        preflight.manifest[8],
        preflight.manifest[9],
        preflight.manifest[10],
        preflight.manifest[11] === null ? null : JSON.stringify(preflight.manifest[11]),
        preflight.manifest[12] === null ? null : JSON.stringify(preflight.manifest[12]),
        JSON.stringify(preflight.attachments),
        preflight.totalBytes,
        intent.id,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return intent;
}

async function retain(preflight: PreparedBaselineManifest): Promise<void> {
  const intent = await authorizeRetention(preflight);
  await retainBaselineManifest(preflight, intent);
  await completePageWriteIntent(intent, async (client) => {
    await client.query(
      `UPDATE page_baselines
          SET status = 'prepared'
        WHERE id = $1 AND status = 'preparing'`,
      [preflight.baselineId],
    );
  });
}

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as Readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function insertPage(input: {
  title?: string;
  source?: 'standalone' | 'confluence';
  confluenceId?: string | null;
  parentId?: string | null;
  bodyHtml?: string;
  bodyStorage?: string;
  bodyText?: string | null;
  labels?: string[];
} = {}): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO pages (
       title, source, confluence_id, parent_id, body_html, body_storage, body_text,
       labels, version, visibility, embedding_dirty, embedding_status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 7, 'shared', FALSE, 'not_embedded')
     RETURNING id`,
    [
      input.title ?? 'Baseline page',
      input.source ?? 'standalone',
      input.confluenceId ?? null,
      input.parentId ?? null,
      input.bodyHtml ?? '<p>body</p>',
      input.bodyStorage ?? '',
      input.bodyText === undefined ? 'body' : input.bodyText,
      input.labels ?? [],
    ],
  );
  return result.rows[0]!.id;
}

async function insertUser(name: string, role: 'user' | 'admin' = 'user'): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'test-password-hash', $3)
     RETURNING id`,
    [name, `${name}@example.test`, role],
  );
  return result.rows[0]!.id;
}

function byFilename(prepared: PreparedBaselineManifest, filename: string): BaselineAttachment {
  const attachment = prepared.attachments.find((candidate) => candidate.filename === filename);
  if (!attachment) throw new Error(`Missing prepared attachment ${filename}`);
  return attachment;
}

describe.skipIf(!dbAvailable)('page baseline manifest retained bytes', () => {
  beforeAll(async () => {
    await setupTestDb();
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-page-baselines-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
  });

  beforeEach(async () => {
    await truncateAllTables();
    const entries = await fs.readdir(attachmentsDir);
    await Promise.all(entries.map((entry) => fs.rm(path.join(attachmentsDir, entry), { recursive: true, force: true })));
    delete process.env.PAGE_BASELINE_MAX_ATTACHMENTS;
    delete process.env.PAGE_BASELINE_MAX_BYTES;
    delete process.env.PAGE_BASELINE_MIN_FREE_BYTES;
  });

  afterAll(async () => {
    if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    delete process.env.PAGE_BASELINE_MAX_ATTACHMENTS;
    delete process.env.PAGE_BASELINE_MAX_BYTES;
    delete process.env.PAGE_BASELINE_MIN_FREE_BYTES;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    await teardownTestDb();
  });

  it('copies every URL-selected store, Draw.io XML and icon; preserves exact tuples, Unicode and byte ordering', async () => {
    const parentId = await insertPage({ title: 'Parent' });
    const pageId = await insertPage({
      title: 'Überblick',
      source: 'confluence',
      confluenceId: '90001',
      parentId: String(parentId),
      bodyHtml: '<p>placeholder</p>',
      bodyStorage: '<p>漢字🙂</p>',
      bodyText: '',
      labels: ['é', 'z', 'ä'],
    });
    const diagram = Buffer.from('rendered-diagram-v1');
    const xml = Buffer.from('<mxfile><diagram>α</diagram></mxfile>');
    const manual = Buffer.from('%PDF-1.7\nmanual');
    const icon = Buffer.from('icon-png-bytes');
    const iconSha = createHash('sha256').update(icon).digest('hex');
    await Promise.all([
      writeStoredFile('90001', 'diagram.png', diagram),
      writeStoredFile('90001', 'diagram.drawio', xml),
      writeStoredFile('90001', 'manual.pdf', manual),
      writeStoredFile('page-icons', String(pageId), `${iconSha}.png`, icon),
    ]);
    const bodyHtml =
      `<div class="confluence-drawio" data-diagram-name="diagram">` +
      `<img src="/api/attachments/90001/diagram.png"></div>` +
      `<p><a href="/api/attachments/90001/manual.pdf">Manual</a></p>`;
    await query(
      `UPDATE pages
          SET body_html = $2, icon_kind = 'image', icon_value = $3,
              icon_color = NULL, icon_filled = NULL
        WHERE id = $1`,
      [pageId, bodyHtml, iconSha],
    );

    const baselineId = randomUUID();
    const prepared = await inspect(pageId, baselineId);
    await expect(
      fs.stat(path.join(attachmentsDir, BASELINE_STORE_DIRNAME, baselineId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await retain(prepared);

    expect(prepared.manifest[0]).toBe('compendiq.article-baseline');
    expect(prepared.manifest[1]).toBe(1);
    expect(prepared.manifest[2]).toBe(baselineId);
    expect(prepared.manifest[3]).toEqual(['page', 'confluence', String(pageId), '90001']);
    expect(prepared.manifest[6]).toBe('Überblick');
    expect(prepared.manifest[7]).toBe(bodyHtml);
    expect(prepared.manifest[8]).toBe('<p>漢字🙂</p>');
    expect(prepared.manifest[9]).toBe('');
    expect(prepared.manifest[10]).toEqual(['z', 'ä', 'é']);
    expect(prepared.manifest[11]).toEqual(['parent', 'standalone', String(parentId), null, String(parentId)]);
    expect(prepared.manifest[12]).toEqual(['icon', 'image', iconSha, null, null]);
    expect(prepared.attachments.map((entry) => entry.filename).sort()).toEqual(
      [`${iconSha}.png`, 'diagram.drawio', 'diagram.png', 'manual.pdf'].sort(),
    );
    expect(prepared.totalBytes).toBe(diagram.length + xml.length + manual.length + icon.length);
    expect(prepared.attachments.map((entry) => entry.identity)).toEqual(
      [...prepared.attachments.map((entry) => entry.identity)].sort((a, b) =>
        Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))),
    );

    for (const attachment of prepared.attachments) {
      expect(attachment.retainedPath.startsWith(`${BASELINE_STORE_DIRNAME}/${baselineId}/`)).toBe(true);
      expect(await streamBytes(await readBaselineAttachment(baselineId, attachment))).toEqual(
        attachment.filename === 'diagram.png'
          ? diagram
          : attachment.filename === 'diagram.drawio'
            ? xml
            : attachment.filename === 'manual.pdf'
              ? manual
              : icon,
      );
      const source = attachment.store === 'local'
        ? path.join(attachmentsDir, 'local', attachment.pageKey, attachment.filename)
        : attachment.store === 'confluence'
          ? path.join(attachmentsDir, attachment.pageKey, attachment.filename)
          : path.join(attachmentsDir, 'page-icons', attachment.pageKey, attachment.filename);
      const [sourceStat, retainedStat] = await Promise.all([
        fs.stat(source, { bigint: true }),
        fs.stat(path.join(attachmentsDir, ...attachment.retainedPath.split('/')), { bigint: true }),
      ]);
      expect(retainedStat.nlink).toBe(1n);
      expect(retainedStat.dev === sourceStat.dev && retainedStat.ino === sourceStat.ino).toBe(false);
    }
    expect(await verifyBaselineAttachments(baselineId, prepared.attachments)).toEqual({ valid: true, failures: [] });
  });

  it('retains storage-only dependencies and preserves the four raw icon fields', async () => {
    const pageId = await insertPage({
      bodyHtml:
        `<p><img src="/api/local-attachments/PAGE/local.png">` +
        `<img src="/api/attachments/PAGE/shared.png"></p>`,
      bodyStorage:
        '<ac:image><ri:attachment ri:filename="storage-only.png"></ri:attachment></ac:image>',
    });
    const bytes = Buffer.from('storage-only dependency');
    const localBytes = Buffer.from('local current-page bytes');
    const sharedBytes = Buffer.from('shared current-page bytes');
    await query(
      `UPDATE pages
          SET body_html = REPLACE(body_html, 'PAGE', id::text)
        WHERE id = $1`,
      [pageId],
    );
    await Promise.all([
      writeStoredFile(String(pageId), 'storage-only.png', bytes),
      writeStoredFile(String(pageId), 'shared.png', sharedBytes),
      writeStoredFile('local', String(pageId), 'local.png', localBytes),
    ]);
    await query(
      `UPDATE pages
          SET icon_kind = NULL, icon_value = NULL, icon_color = NULL, icon_filled = NULL
        WHERE id = $1`,
      [pageId],
    );

    const allNull = await inspect(pageId);
    await retain(allNull);
    expect(allNull.manifest[12]).toBeNull();
    expect(allNull.attachments.map((attachment) => attachment.filename).sort()).toEqual(
      ['local.png', 'shared.png', 'storage-only.png'],
    );
    expect(
      await streamBytes(
        await readBaselineAttachment(allNull.baselineId, byFilename(allNull, 'storage-only.png')),
      ),
    ).toEqual(bytes);

    const falseFilledPage = await insertPage();
    const falseFilled = await inspect(falseFilledPage);
    expect(falseFilled.manifest[12]).toEqual(['icon', null, null, null, false]);
  });

  it('keeps same-named foreign HTML media separate from current-page storage and Draw.io siblings', async () => {
    const foreign = await insertPage();
    const target = await insertPage({
      bodyHtml: `<img src="/api/attachments/${foreign}/diagram.png">`,
      bodyStorage:
        '<ac:image><ri:attachment ri:filename="diagram.png"></ri:attachment></ac:image>'
        + '<ac:structured-macro ac:name="drawio">'
        + '<ac:parameter ac:name="diagramName">diagram</ac:parameter>'
        + '</ac:structured-macro>',
    });
    const foreignPng = Buffer.from('foreign rendered bytes');
    const ownPng = Buffer.from('current-page rendered bytes');
    const ownXml = Buffer.from('<mxfile>current-page source</mxfile>');
    await Promise.all([
      writeStoredFile(String(foreign), 'diagram.png', foreignPng),
      writeStoredFile(String(target), 'diagram.png', ownPng),
      writeStoredFile(String(target), 'diagram.drawio', ownXml),
    ]);

    const prepared = await inspect(target);
    const attachmentsByTuple = new Map(
      prepared.attachments.map((item) => [
        `${item.store}\0${item.pageKey}\0${item.filename}`,
        item,
      ] as const),
    );
    const foreignRendered = attachmentsByTuple.get(`confluence\0${foreign}\0diagram.png`);
    const ownRendered = attachmentsByTuple.get(`confluence\0${target}\0diagram.png`);
    const ownSource = attachmentsByTuple.get(`confluence\0${target}\0diagram.drawio`);
    expect(foreignRendered).toBeDefined();
    expect(ownRendered).toBeDefined();
    expect(ownSource).toBeDefined();
    expect(prepared.attachments).toHaveLength(3);
    await retain(prepared);
    expect(
      await streamBytes(await readBaselineAttachment(prepared.baselineId, ownRendered!)),
    ).toEqual(ownPng);
    expect(
      await streamBytes(await readBaselineAttachment(prepared.baselineId, ownSource!)),
    ).toEqual(ownXml);
  });

  it('treats a comma-bearing inline srcset URL as one pinned candidate and preserves authored HTML bytes', async () => {
    const pageId = await insertPage();
    const bodyHtml =
      `<source srcset="data:image/png;base64,AA,BB 1x,  `
      + `/api/attachments/${pageId}/retained.png 2x">`;
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [pageId, bodyHtml]);
    await writeStoredFile(String(pageId), 'retained.png', Buffer.from('retained candidate'));

    const prepared = await inspect(pageId);
    expect(prepared.manifest[7]).toBe(bodyHtml);
    expect(prepared.attachments).toHaveLength(1);
    expect(prepared.attachments[0]).toMatchObject({
      store: 'confluence',
      pageKey: String(pageId),
      filename: 'retained.png',
    });
  });

  it('retains original bytes after live replacement and detects retained-byte tampering', async () => {
    const pageId = await insertPage();
    const original = Buffer.from('original immutable bytes');
    await writeStoredFile(String(pageId), 'evidence.bin', original);
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      pageId,
      `<a href="/api/attachments/${pageId}/evidence.bin">Evidence</a>`,
    ]);
    const baselineId = randomUUID();
    const prepared = await inspect(pageId, baselineId);
    await retain(prepared);
    const attachment = byFilename(prepared, 'evidence.bin');
    await fs.writeFile(path.join(attachmentsDir, String(pageId), 'evidence.bin'), Buffer.from('replacement'));

    const retainedPath = path.join(attachmentsDir, ...attachment.retainedPath.split('/'));
    const verifiedStream = await readBaselineAttachment(baselineId, attachment);
    const streamClosed = once(verifiedStream, 'close');
    renameSync(retainedPath, `${retainedPath}.verified`);
    writeFileSync(retainedPath, Buffer.from('different inode after verification'));
    expect(await streamBytes(verifiedStream)).toEqual(original);
    await streamClosed;
    expect((verifiedStream as Readable).closed).toBe(true);

    await fs.writeFile(
      retainedPath,
      Buffer.from('tampered retained bytes'),
    );
    const verification = await verifyBaselineAttachments(baselineId, prepared.attachments);
    expect(verification.valid).toBe(false);
    expect(verification.failures).toEqual([expect.stringMatching(/(length|SHA-256) mismatch/)]);
    await expect(readBaselineAttachment(baselineId, attachment)).rejects.toMatchObject({
      reason: 'baseline_storage_unavailable',
      statusCode: 503,
    });
  });

  it('refuses a mutable source changed after inspection before copying retained evidence', async () => {
    const pageId = await insertPage();
    const source = await writeStoredFile(String(pageId), 'raced.bin', Buffer.from('before'));
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      pageId,
      `<a href="/api/attachments/${pageId}/raced.bin">Raced</a>`,
    ]);
    const prepared = await inspect(pageId);
    const intent = await authorizeRetention(prepared);
    await fs.writeFile(source, Buffer.from('after'));

    await expect(retainBaselineManifest(prepared, intent)).rejects.toMatchObject({
      reason: 'baseline_media_unreadable',
      statusCode: 409,
    });
  });

  it('refuses missing rendered media, missing Draw.io XML, and external unpinned media distinctly', async () => {
    const missing = await insertPage();
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      missing,
      `<img src="/api/attachments/${missing}/missing.png">`,
    ]);
    await expect(inspect(missing)).rejects.toMatchObject({ reason: 'baseline_media_missing', statusCode: 409 });

    const drawio = await insertPage();
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      drawio,
      `<div class="confluence-drawio"><img src="/api/attachments/${drawio}/d.png"></div>`,
    ]);
    await writeStoredFile(String(drawio), 'd.png', Buffer.from('png'));
    await expect(inspect(drawio)).rejects.toMatchObject({ reason: 'baseline_media_missing', statusCode: 409 });

    const external = await insertPage({ bodyHtml: '<img src="https://untrusted.example/evidence.png">' });
    await expect(inspect(external)).rejects.toMatchObject({
      reason: 'baseline_media_external_unpinned',
      statusCode: 409,
    });
  });

  it.each([
    'https://external.example/api/attachments/PAGE/evidence.png',
    '//external.example/api/local-attachments/PAGE/evidence.png',
    'https://external.example/image?next=/api/attachments/PAGE/evidence.png',
    'https://external.example/image#/api/local-attachments/PAGE/evidence.png',
  ])('does not substitute local evidence for the unpinned URL %s', async (template) => {
    const pageId = await insertPage();
    const url = template.replace('PAGE', String(pageId));
    await writeStoredFile(String(pageId), 'evidence.png', Buffer.from('unrelated shared-store bytes'));
    await writeStoredFile('local', String(pageId), 'evidence.png', Buffer.from('unrelated local-store bytes'));
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [pageId, `<img src="${url}">`]);
    await expect(inspect(pageId)).rejects.toMatchObject({
      reason: 'baseline_media_external_unpinned',
      statusCode: 409,
    });
  });


  it('authorizes URL-prefix owners before reading foreign bytes and denies ambiguous scope without an oracle', async () => {
    const actorId = await insertUser('baseline-scope-actor');
    const ownerId = await insertUser('baseline-scope-owner');
    const foreignLocal = await insertPage();
    await query(
      `UPDATE pages
          SET visibility = 'private', created_by_user_id = $2
        WHERE id = $1`,
      [foreignLocal, ownerId],
    );
    const target = await insertPage();
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      target,
      `<img src="/api/local-attachments/${foreignLocal}/secret.png">`,
    ]);
    const secretPath = await writeStoredFile(
      'local',
      String(foreignLocal),
      'secret.png',
      Buffer.from('private bytes'),
    );

    const existingId = randomUUID();
    let existingDenial: unknown;
    try {
      await inspect(target, existingId, actorId);
    } catch (error) {
      existingDenial = error;
    }
    await fs.rm(secretPath);
    const missingId = randomUUID();
    let missingDenial: unknown;
    try {
      await inspect(target, missingId, actorId);
    } catch (error) {
      missingDenial = error;
    }
    expect(existingDenial).toMatchObject({
      reason: 'baseline_media_scope_denied',
      statusCode: 403,
      message: 'Referenced media owner could not be authorized',
    });
    expect(missingDenial).toMatchObject({
      reason: 'baseline_media_scope_denied',
      statusCode: 403,
      message: 'Referenced media owner could not be authorized',
    });
    await expect(
      fs.stat(path.join(attachmentsDir, BASELINE_STORE_DIRNAME, existingId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(attachmentsDir, BASELINE_STORE_DIRNAME, missingId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await writeStoredFile('local', String(foreignLocal), 'secret.png', Buffer.from('private bytes'));
    const authorized = await inspect(target, randomUUID(), ownerId);
    expect(baselineManifestSourcePageIds(authorized)).toEqual(
      [target, foreignLocal].sort((left, right) => left - right),
    );
    expect(byFilename(authorized, 'secret.png').store).toBe('local');

    await insertPage({
      source: 'confluence',
      confluenceId: 'foreign-confidential',
    });
    await writeStoredFile('foreign-confidential', 'secret.png', Buffer.from('confluence secret'));
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      target,
      '<img src="/api/attachments/foreign-confidential/secret.png">',
    ]);
    await expect(inspect(target, randomUUID(), actorId)).rejects.toMatchObject({
      reason: 'baseline_media_scope_denied',
      statusCode: 403,
    });

    const collisionOwner = await insertPage();
    await query(
      `UPDATE pages
          SET visibility = 'private', created_by_user_id = $2,
              body_html = $3
        WHERE id = $1`,
      [
        collisionOwner,
        actorId,
        `<img src="/api/attachments/${collisionOwner}/collision.png">`,
      ],
    );
    await insertPage({
      source: 'confluence',
      confluenceId: String(collisionOwner),
    });
    await writeStoredFile(String(collisionOwner), 'collision.png', Buffer.from('ambiguous key bytes'));
    await expect(inspect(collisionOwner, randomUUID(), actorId)).rejects.toMatchObject({
      reason: 'baseline_media_scope_denied',
      statusCode: 403,
    });
  });

  it('binds accessible frozen foreign references to published retained bytes without intent-locking that owner', async () => {
    const foreign = await insertPage();
    const original = Buffer.from('foreign baseline bytes');
    await writeStoredFile(String(foreign), 'shared.png', original);
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      foreign,
      `<img src="/api/attachments/${foreign}/shared.png">`,
    ]);
    const foreignBaseline = await inspect(foreign);
    await retain(foreignBaseline);
    await query(
      `UPDATE page_baselines
          SET status = 'published', published_at = NOW(),
              published_by_name = 'Publisher', provenance = 'manual_assertion',
              freeze_reason = 'Foreign immutable evidence'
        WHERE id = $1`,
      [foreignBaseline.baselineId],
    );
    await query(
      `UPDATE pages
          SET baseline_id = $2, frozen_version = version, frozen_at = NOW(),
              frozen_by_name = 'Publisher', freeze_reason = 'Foreign immutable evidence',
              freeze_provenance = 'manual_assertion', freeze_reported_signatories = '[]'::jsonb
        WHERE id = $1`,
      [foreign, foreignBaseline.baselineId],
    );
    await fs.writeFile(
      path.join(attachmentsDir, String(foreign), 'shared.png'),
      Buffer.from('changed live bytes'),
    );

    const target = await insertPage({
      bodyHtml: `<img src="/api/attachments/${foreign}/shared.png">`,
    });
    const prepared = await inspect(target);
    expect(baselineManifestSourcePageIds(prepared)).toEqual([target]);
    await fs.rm(path.join(attachmentsDir, String(foreign), 'shared.png'));
    await retain(prepared);

    expect(
      await streamBytes(
        await readBaselineAttachment(prepared.baselineId, byFilename(prepared, 'shared.png')),
      ),
    ).toEqual(original);
  });

  it('rejects malformed traversal references before owner ACL without disclosing owner existence', async () => {
    const actorId = await insertUser('traversal-actor');
    const ownerId = await insertUser('traversal-owner');
    const privateOwner = await insertPage();
    await query(
      `UPDATE pages
          SET visibility = 'private', created_by_user_id = $2
        WHERE id = $1`,
      [privateOwner, ownerId],
    );
    const privateReference = await insertPage({
      bodyHtml: `<img src="/api/attachments/${privateOwner}/..%2Foutside.png">`,
    });
    const missingReference = await insertPage({
      bodyHtml: '<img src="/api/attachments/definitely-missing-owner/..%2Foutside.png">',
    });

    await expect(inspect(privateReference, randomUUID(), actorId)).rejects.toMatchObject({
      reason: 'baseline_media_unreadable',
      statusCode: 409,
    });
    await expect(inspect(missingReference, randomUUID(), actorId)).rejects.toMatchObject({
      reason: 'baseline_media_unreadable',
      statusCode: 409,
    });
  });

  it('refuses symlinked sources instead of following them', async () => {

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-baseline-outside-'));
    try {
      const outside = path.join(outsideDir, 'outside.png');
      await fs.writeFile(outside, Buffer.from('outside'));
      const pageId = await insertPage();
      await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
        pageId,
        `<img src="/api/attachments/${pageId}/link.png">`,
      ]);
      await fs.mkdir(path.join(attachmentsDir, String(pageId)), { recursive: true });
      await fs.symlink(outside, path.join(attachmentsDir, String(pageId), 'link.png'));
      await expect(inspect(pageId)).rejects.toMatchObject({ reason: 'baseline_media_unreadable', statusCode: 409 });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses an ambiguous stored parent key rather than guessing a namespace', async () => {
    const standaloneParent = await insertPage({ title: 'Standalone parent' });
    await insertPage({ title: 'Confluence collision', source: 'confluence', confluenceId: String(standaloneParent) });
    const child = await insertPage({ parentId: String(standaloneParent) });

    await expect(inspect(child)).rejects.toMatchObject({ reason: 'baseline_parent_ambiguous', statusCode: 409 });
  });

  it('enforces media count, byte and free-space bounds before retained bytes exist', async () => {
    const pageId = await insertPage();
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      pageId,
      `<img src="/api/attachments/${pageId}/a.png"><img src="/api/attachments/${pageId}/b.png">`,
    ]);
    await Promise.all([
      writeStoredFile(String(pageId), 'a.png', Buffer.alloc(8, 1)),
      writeStoredFile(String(pageId), 'b.png', Buffer.alloc(8, 2)),
    ]);

    process.env.PAGE_BASELINE_MAX_ATTACHMENTS = '1';
    await expect(inspect(pageId)).rejects.toMatchObject({ reason: 'baseline_media_limit_exceeded', statusCode: 413 });
    delete process.env.PAGE_BASELINE_MAX_ATTACHMENTS;

    process.env.PAGE_BASELINE_MAX_BYTES = '10';
    await expect(inspect(pageId)).rejects.toMatchObject({ reason: 'baseline_media_limit_exceeded', statusCode: 413 });
    delete process.env.PAGE_BASELINE_MAX_BYTES;

    const preflight = await inspect(pageId);
    process.env.PAGE_BASELINE_MIN_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT reserved_bytes FROM page_baseline_capacity WHERE singleton = TRUE FOR UPDATE');
      await expect(assertBaselineRetentionCapacity(client, preflight.totalBytes)).rejects.toMatchObject({
        reason: 'baseline_capacity_exceeded',
        statusCode: 507,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await expect(
      fs.stat(path.join(attachmentsDir, BASELINE_STORE_DIRNAME, preflight.baselineId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports exact deterministic namespace absence and nothing else as absent', async () => {
    const baselineId = randomUUID();
    expect(await isBaselinePreparationAbsent(baselineId)).toBe(true);
    await fs.mkdir(path.join(attachmentsDir, BASELINE_STORE_DIRNAME, baselineId), { recursive: true });
    expect(await isBaselinePreparationAbsent(baselineId)).toBe(false);
    await expect(isBaselinePreparationAbsent('../escape')).rejects.toMatchObject({
      reason: 'invalid_baseline_id',
      statusCode: 400,
    });
  });

  it('refuses same-transaction abandonment before unlinking retained bytes', async () => {
    const pageId = await insertPage();
    const preflight = await inspect(pageId);
    await retain(preflight);
    const retainedDirectory = path.join(attachmentsDir, BASELINE_STORE_DIRNAME, preflight.baselineId);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE page_baselines
            SET status = 'abandoned', abandoned_at = NOW()
          WHERE id = $1`,
        [preflight.baselineId],
      );
      await expect(removeBaselinePreparation(client, preflight.baselineId)).rejects.toMatchObject({
        reason: 'baseline_cleanup_forbidden',
        statusCode: 409,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await isBaselinePreparationAbsent(preflight.baselineId)).toBe(false);
    await expect(fs.stat(retainedDirectory)).resolves.toBeDefined();
  });

  it('accepts only the exact transferred active repair token after abandonment commits', async () => {
    const pageId = await insertPage();
    const preflight = await inspect(pageId);
    const intent = await authorizeRetention(preflight);
    await retainBaselineManifest(preflight, intent);
    await query(
      `UPDATE page_baselines
          SET status = 'abandoned', abandoned_at = NOW()
        WHERE id = $1`,
      [preflight.baselineId],
    );
    await query(
      `UPDATE page_write_intents
          SET effect_started_at = COALESCE(effect_started_at, NOW()),
              recovery_history = recovery_history || jsonb_build_array(
                jsonb_build_object('toRuntimeId', runtime_id, 'transferredAt', NOW())
              )
        WHERE id = $1`,
      [intent.id],
    );

    const wrongIntent = { ...intent, id: randomUUID() };
    const refused = await getPool().connect();
    try {
      await refused.query('BEGIN');
      await expect(
        removeBaselinePreparation(refused, preflight.baselineId, wrongIntent),
      ).rejects.toMatchObject({ reason: 'baseline_cleanup_forbidden', statusCode: 409 });
      await refused.query('ROLLBACK');
    } finally {
      refused.release();
    }

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await removeBaselinePreparation(client, preflight.baselineId, intent);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const retry = await getPool().connect();
    try {
      await retry.query('BEGIN');
      await removeBaselinePreparation(retry, preflight.baselineId, intent);
      await retry.query('COMMIT');
    } catch (error) {
      await retry.query('ROLLBACK');
      throw error;
    } finally {
      retry.release();
    }
    expect(await isBaselinePreparationAbsent(preflight.baselineId)).toBe(true);
  });

  it('refuses abandonment cleanup while the local copy intent is still live', async () => {
    const pageId = await insertPage();
    const preflight = await inspect(pageId);
    const intent = await authorizeRetention(preflight);
    await retainBaselineManifest(preflight, intent);
    await query(
      `UPDATE page_baselines
          SET status = 'abandoned', abandoned_at = NOW()
        WHERE id = $1`,
      [preflight.baselineId],
    );
    const retainedDirectory = path.join(attachmentsDir, BASELINE_STORE_DIRNAME, preflight.baselineId);

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await expect(removeBaselinePreparation(client, preflight.baselineId)).rejects.toMatchObject({
        reason: 'baseline_cleanup_forbidden',
        statusCode: 409,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await expect(fs.stat(retainedDirectory)).resolves.toBeDefined();
  });

  it('removes only a DB-proven abandoned deterministic directory, including an empty attempt', async () => {
    const pageId = await insertPage();
    const preflight = await inspect(pageId);
    await retain(preflight);
    const retainedDirectory = path.join(attachmentsDir, BASELINE_STORE_DIRNAME, preflight.baselineId);
    await expect(fs.stat(retainedDirectory)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await query(
      `UPDATE page_baselines
          SET status = 'abandoned', abandoned_at = NOW()
        WHERE id = $1`,
      [preflight.baselineId],
    );

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await removeBaselinePreparation(client, preflight.baselineId);
      await client.query('DELETE FROM page_baselines WHERE id = $1', [preflight.baselineId]);
      await client.query(
        `UPDATE page_baseline_capacity
            SET reserved_bytes = reserved_bytes - $1, updated_at = NOW()
          WHERE singleton = TRUE`,
        [preflight.totalBytes],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await expect(fs.stat(retainedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses cleanup for a published UUID and leaves its retained evidence untouched', async () => {
    const pageId = await insertPage();
    const bytes = Buffer.from('published evidence');
    await writeStoredFile(String(pageId), 'published.bin', bytes);
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      pageId,
      `<a href="/api/attachments/${pageId}/published.bin">Published</a>`,
    ]);
    const preflight = await inspect(pageId);
    await retain(preflight);
    await query(
      `UPDATE page_baselines
          SET status = 'published',
              published_at = NOW(),
              published_by_name = 'Publisher',
              provenance = 'manual_assertion',
              freeze_reason = 'Publication cleanup guard'
        WHERE id = $1`,
      [preflight.baselineId],
    );
    const retained = path.join(attachmentsDir, ...preflight.attachments[0]!.retainedPath.split('/'));

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await expect(removeBaselinePreparation(client, preflight.baselineId)).rejects.toMatchObject({
        reason: 'baseline_cleanup_forbidden',
        statusCode: 409,
      });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await expect(fs.readFile(retained)).resolves.toEqual(bytes);
  });

  it('keeps retained bytes when hard-delete cleanup removes every mutable namespace for the page', async () => {
    const pageId = await insertPage();
    const bytes = Buffer.from('survives page purge');
    const sourceDir = path.join(attachmentsDir, String(pageId));
    await writeStoredFile(String(pageId), 'kept.bin', bytes);
    await query('UPDATE pages SET body_html = $2 WHERE id = $1', [
      pageId,
      `<a href="/api/attachments/${pageId}/kept.bin">Kept</a>`,
    ]);
    const baselineId = randomUUID();
    const prepared = await inspect(pageId, baselineId);
    await retain(prepared);
    const retained = path.join(attachmentsDir, ...prepared.attachments[0]!.retainedPath.split('/'));

    await query('DELETE FROM pages WHERE id = $1', [pageId]);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(sourceDir, old, old);
    await cleanupStandalonePageAttachmentDirs({ id: pageId });

    await expect(fs.readFile(retained)).resolves.toEqual(bytes);
    expect(await verifyBaselineAttachments(baselineId, prepared.attachments)).toEqual({ valid: true, failures: [] });
  });
});
