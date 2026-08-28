import { createHash, randomBytes } from 'node:crypto';
import { execFile, type ChildProcess, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { encryptBackupStream, packArchive, type ArchiveEntry } from './backup-stream.js';
import { restoreBackup } from './backup-restore.js';

const MASTER = { kind: 'master' as const, keyMaterial: 'master-key-at-least-32-characters!!' };
const PAT_KEY = 'pat-key-at-least-32-characters!!!!';
const NEWEST_MIGRATION = '107_backup_settings.sql';
const DATABASE = Buffer.from('PGDUMP');
const ATTACHMENT = Buffer.from('replacement');
const ORIGINAL = 'original';

interface ManifestFixture {
  version: number;
  createdAt: string;
  schemaMigration: string;
  patEncryptionKeyFingerprint: string;
  databaseSizeBytes: number;
  checksums: Record<string, string>;
  format: string;
  [key: string]: unknown;
}

interface FixtureOptions {
  attachmentEntries?: Array<{ name: string; data: Buffer }>;
  databaseEntries?: Buffer[];
  manifestEntries?: Array<ManifestFixture | string>;
  extraEntries?: Array<{ name: string; data: Buffer }>;
  mutateManifest?: (manifest: ManifestFixture) => void;
  trailingPlaintext?: Buffer;
}

interface RestoreHarness {
  workRoot: string;
  attachmentsRoot: string;
  existingAttachment: string;
  spawnFn: Mock;
  runMigrationsFn: Mock;
}

const workRoots = new Set<string>();

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function patFingerprint(key = PAT_KEY): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32)}`;
}

function defaultManifest(
  attachments: Array<{ name: string; data: Buffer }>,
  database = DATABASE,
): ManifestFixture {
  return {
    version: 1,
    createdAt: '2026-08-28T12:00:00.000Z',
    schemaMigration: NEWEST_MIGRATION,
    patEncryptionKeyFingerprint: patFingerprint(),
    databaseSizeBytes: database.length,
    checksums: Object.fromEntries([
      ['database.dump', sha256(database)],
      ...attachments.map(({ name, data }) => [name, sha256(data)]),
    ]),
    format: 'cpqarc1',
  };
}

function archiveEntries(options: FixtureOptions = {}): ArchiveEntry[] {
  const attachments = options.attachmentEntries ?? [
    { name: 'attachments/local/1/file.txt', data: ATTACHMENT },
  ];
  const databases = options.databaseEntries ?? [DATABASE];
  const manifest = defaultManifest(attachments, databases[0] ?? DATABASE);
  options.mutateManifest?.(manifest);
  const manifests = options.manifestEntries ?? [manifest];

  return [
    ...attachments.map(({ name, data }) => ({ name, size: data.length, stream: Readable.from([data]) })),
    ...databases.map((data) => ({ name: 'database.dump', stream: Readable.from([data]) })),
    ...(options.extraEntries ?? []).map(({ name, data }) => ({
      name,
      size: data.length,
      stream: Readable.from([data]),
    })),
    ...manifests.map((value) => {
      const data = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
      return { name: 'manifest.json', size: data.length, stream: Readable.from([data]) };
    }),
  ];
}

function encryptedFixture(options: FixtureOptions = {}): Readable {
  const packed = packArchive(archiveEntries(options));
  if (!options.trailingPlaintext) return encryptBackupStream(packed, MASTER);

  const plaintext = Readable.from(
    (async function* () {
      for await (const chunk of packed) yield chunk;
      yield options.trailingPlaintext;
    })(),
  );
  return encryptBackupStream(plaintext, MASTER);
}

function fakePgRestore(exitCode = 0): ChildProcess {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stderr }) as unknown as ChildProcess;
  stdin.once('finish', () => {
    if (exitCode !== 0) stderr.end('restore failed');
    setImmediate(() => child.emit('close', exitCode));
  });
  return child;
}

async function createHarness(exitCode = 0): Promise<RestoreHarness> {
  const workRoot = await mkdtemp(path.join(os.tmpdir(), 'cq-restore-test-'));
  workRoots.add(workRoot);
  const attachmentsRoot = path.join(workRoot, 'attachments-live');
  const existingAttachment = path.join(attachmentsRoot, 'keep.txt');
  await mkdir(attachmentsRoot, { recursive: true });
  await writeFile(existingAttachment, ORIGINAL);
  const spawnFn = vi.fn(() => fakePgRestore(exitCode));
  const runMigrationsFn = vi.fn(async () => undefined);
  return { workRoot, attachmentsRoot, existingAttachment, spawnFn, runMigrationsFn };
}

async function restore(
  harness: RestoreHarness,
  encrypted: Readable,
  overrides: Record<string, unknown> = {},
) {
  return restoreBackup({
    encrypted,
    secret: MASTER,
    attachmentsRoot: harness.attachmentsRoot,
    postgresUrl: 'postgres://restore-test',
    spawnFn: harness.spawnFn as unknown as typeof spawn,
    runMigrationsFn: harness.runMigrationsFn,
    newestMigration: NEWEST_MIGRATION,
    ...overrides,
  });
}

async function expectValidationFailure(
  encrypted: Readable,
  expected: RegExp,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const harness = await createHarness();
  await expect(restore(harness, encrypted, overrides)).rejects.toThrow(expected);
  expect(harness.spawnFn).not.toHaveBeenCalled();
  expect(harness.runMigrationsFn).not.toHaveBeenCalled();
  expect(await readFile(harness.existingAttachment, 'utf8')).toBe(ORIGINAL);
}

beforeEach(() => {
  process.env.PAT_ENCRYPTION_KEY = PAT_KEY;
});

afterEach(async () => {
  await Promise.all([...workRoots].map((root) => rm(root, { recursive: true, force: true })));
  workRoots.clear();
  vi.restoreAllMocks();
});

describe('restoreBackup validation', () => {
  it('rejects a PAT fingerprint mismatch before mutating live state', async () => {
    const fixture = encryptedFixture({
      mutateManifest: (manifest) => {
        manifest.patEncryptionKeyFingerprint = patFingerprint('wrong-key');
      },
    });
    await expectValidationFailure(fixture, /fingerprint/i);
  });

  it('allows force to override only the PAT fingerprint mismatch', async () => {
    const harness = await createHarness();
    const manifest = await restore(
      harness,
      encryptedFixture({
        mutateManifest: (value) => {
          value.patEncryptionKeyFingerprint = patFingerprint('wrong-key');
        },
      }),
      { dryRun: true, force: true },
    );

    expect(manifest.patEncryptionKeyFingerprint).toBe(patFingerprint('wrong-key'));
    expect(harness.spawnFn).not.toHaveBeenCalled();
    expect(await readFile(harness.existingAttachment, 'utf8')).toBe(ORIGINAL);
  });

  it('rejects a checksum mismatch before mutating live state', async () => {
    await expectValidationFailure(
      encryptedFixture({
        mutateManifest: (manifest) => {
          manifest.checksums['database.dump'] = '0'.repeat(64);
        },
      }),
      /checksum/i,
    );
  });

  it('rejects a missing checksum before mutating live state', async () => {
    await expectValidationFailure(
      encryptedFixture({
        mutateManifest: (manifest) => {
          delete manifest.checksums['attachments/local/1/file.txt'];
        },
      }),
      /checksum/i,
    );
  });

  it('rejects an extra checksum before mutating live state', async () => {
    await expectValidationFailure(
      encryptedFixture({
        mutateManifest: (manifest) => {
          manifest.checksums['attachments/not-in-archive.txt'] = '0'.repeat(64);
        },
      }),
      /checksum/i,
    );
  });

  it('rejects a database size mismatch before mutating live state', async () => {
    await expectValidationFailure(
      encryptedFixture({
        mutateManifest: (manifest) => {
          manifest.databaseSizeBytes += 1;
        },
      }),
      /database.*size/i,
    );
  });

  it('rejects duplicate database members before mutating live state', async () => {
    await expectValidationFailure(
      encryptedFixture({ databaseEntries: [DATABASE, Buffer.from('SECOND')] }),
      /duplicate.*database\.dump/i,
    );
  });

  it('rejects duplicate attachment names before mutating live state', async () => {
    await expectValidationFailure(
      encryptedFixture({
        attachmentEntries: [
          { name: 'attachments/local/1/file.txt', data: ATTACHMENT },
          { name: 'attachments/local/1/file.txt', data: Buffer.from('duplicate') },
        ],
      }),
      /duplicate.*attachment/i,
    );
  });

  it('rejects duplicate manifest members before mutating live state', async () => {
    const manifest = defaultManifest([
      { name: 'attachments/local/1/file.txt', data: ATTACHMENT },
    ]);
    await expectValidationFailure(
      encryptedFixture({ manifestEntries: [manifest, manifest] }),
      /duplicate.*manifest/i,
    );
  });

  it('rejects unknown archive members before mutating live state', async () => {
    await expectValidationFailure(
      encryptedFixture({ extraEntries: [{ name: 'notes.txt', data: Buffer.from('unknown') }] }),
      /unknown.*member/i,
    );
  });

  it('rejects a manifest with unknown fields before mutating live state', async () => {
    await expectValidationFailure(
      encryptedFixture({
        mutateManifest: (manifest) => {
          manifest.unexpected = true;
        },
      }),
      /manifest/i,
    );
  });

  it('rejects an archive migration newer than this binary before mutating live state', async () => {
    await expectValidationFailure(
      encryptedFixture({
        mutateManifest: (manifest) => {
          manifest.schemaMigration = '999_future.sql';
        },
      }),
      /migration.*newer/i,
    );
  });

  it('discovers the newest shipped migration under ESM when none is injected', async () => {
    const harness = await createHarness();
    const backupPath = path.join(harness.workRoot, 'backup.cpq');
    const chunks: Buffer[] = [];
    for await (const chunk of encryptedFixture()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await writeFile(backupPath, Buffer.concat(chunks));

    const script = `
      import { createReadStream } from 'node:fs';
      import { restoreBackup } from './src/core/services/backup-restore.ts';

      const manifest = await restoreBackup({
        encrypted: createReadStream(process.env.BACKUP_FIXTURE),
        secret: { kind: 'master', keyMaterial: process.env.BACKUP_MASTER_KEY },
        attachmentsRoot: process.env.ATTACHMENTS_ROOT,
        postgresUrl: 'postgres://restore-test',
        dryRun: true,
      });
      if (manifest.schemaMigration !== '${NEWEST_MIGRATION}') {
        throw new Error('Unexpected schema migration: ' + manifest.schemaMigration);
      }
    `;
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ATTACHMENTS_ROOT: harness.attachmentsRoot,
          BACKUP_FIXTURE: backupPath,
          BACKUP_MASTER_KEY: MASTER.keyMaterial,
          PAT_ENCRYPTION_KEY: PAT_KEY,
        },
      },
    );

    expect(await readFile(harness.existingAttachment, 'utf8')).toBe(ORIGINAL);
  });

  it('rejects a missing database dump before mutating live state', async () => {
    await expectValidationFailure(encryptedFixture({ databaseEntries: [] }), /database\.dump/i);
  });

  it('rejects a manifest larger than 1 MiB before mutating live state', async () => {
    const oversized = JSON.stringify({ padding: 'x'.repeat(1024 * 1024) });
    await expectValidationFailure(encryptedFixture({ manifestEntries: [oversized] }), /manifest.*large/i);
  });

  it('consumes the authenticated EOF before exposing staged data', async () => {
    const attachment = randomBytes(3 * 1024 * 1024);
    const encrypted = await (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of encryptBackupStream(
        packArchive(
          archiveEntries({
            attachmentEntries: [{ name: 'attachments/large.bin', data: attachment }],
          }),
        ),
        MASTER,
      )) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    })();
    encrypted[encrypted.length - 1] ^= 1;
    const harness = await createHarness();

    await expect(restore(harness, Readable.from([encrypted]))).rejects.toThrow();
    expect(harness.spawnFn).not.toHaveBeenCalled();
    expect(await readFile(harness.existingAttachment, 'utf8')).toBe(ORIGINAL);
    await expect(readFile(path.join(harness.attachmentsRoot, 'large.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects trailing plaintext after the inner archive terminator', async () => {
    await expectValidationFailure(
      encryptedFixture({ trailingPlaintext: Buffer.from([0x01]) }),
      /trailing/i,
    );
  });
});

describe('restoreBackup commit', () => {
  it('swaps attachments, restores PostgreSQL transactionally, and runs migrations', async () => {
    const harness = await createHarness();
    const manifest = await restore(harness, encryptedFixture());

    expect(manifest.schemaMigration).toBe(NEWEST_MIGRATION);
    expect(harness.spawnFn).toHaveBeenCalledWith(
      'pg_restore',
      expect.arrayContaining(['--single-transaction']),
      expect.anything(),
    );
    expect(harness.runMigrationsFn).toHaveBeenCalledOnce();
    expect(await readFile(path.join(harness.attachmentsRoot, 'local/1/file.txt'), 'utf8')).toBe(
      'replacement',
    );
    await expect(readFile(harness.existingAttachment)).rejects.toMatchObject({ code: 'ENOENT' });
    const siblings = await readdir(harness.workRoot);
    expect(siblings.some((name) => name.startsWith('.compendiq-restore-'))).toBe(false);
    expect(siblings.some((name) => name.startsWith('attachments-live.restore-backup-'))).toBe(false);
  });

  it('restores the previous attachments directory when pg_restore fails', async () => {
    const harness = await createHarness(2);

    await expect(restore(harness, encryptedFixture())).rejects.toThrow(/pg_restore exited 2/i);
    expect(await readFile(harness.existingAttachment, 'utf8')).toBe(ORIGINAL);
    await expect(
      readFile(path.join(harness.attachmentsRoot, 'local/1/file.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(harness.runMigrationsFn).not.toHaveBeenCalled();
  });

  it('retains the restored state and rollback path when migrations fail', async () => {
    const harness = await createHarness();
    harness.runMigrationsFn.mockRejectedValueOnce(new Error('migration exploded'));

    await expect(restore(harness, encryptedFixture())).rejects.toThrow(
      /migration exploded.*rollback.*attachments-live\.restore-backup-/i,
    );
    expect(await readFile(path.join(harness.attachmentsRoot, 'local/1/file.txt'), 'utf8')).toBe(
      'replacement',
    );
    const siblings = await readdir(harness.workRoot);
    const rollback = siblings.find((name) => name.startsWith('attachments-live.restore-backup-'));
    expect(rollback).toBeDefined();
    expect(await readFile(path.join(harness.workRoot, rollback!, 'keep.txt'), 'utf8')).toBe(ORIGINAL);
  });

  it('dry-run validates a large generated stream without database or attachment mutation', async () => {
    const harness = await createHarness();
    const chunk = Buffer.alloc(64 * 1024, 0xa5);
    const count = 64;
    const hash = createHash('sha256');
    for (let i = 0; i < count; i += 1) hash.update(chunk);
    const largeSize = chunk.length * count;
    const manifest = defaultManifest([]);
    manifest.databaseSizeBytes = largeSize;
    manifest.checksums = { 'database.dump': hash.digest('hex') };
    const manifestData = Buffer.from(JSON.stringify(manifest));
    const databaseStream = Readable.from(
      (async function* () {
        for (let i = 0; i < count; i += 1) yield chunk;
      })(),
    );
    const encrypted = encryptBackupStream(
      packArchive([
        { name: 'database.dump', stream: databaseStream },
        { name: 'manifest.json', size: manifestData.length, stream: Readable.from([manifestData]) },
      ]),
      MASTER,
    );

    const restoredManifest = await restore(harness, encrypted, { dryRun: true });

    expect(restoredManifest.databaseSizeBytes).toBe(largeSize);
    expect(harness.spawnFn).not.toHaveBeenCalled();
    expect(harness.runMigrationsFn).not.toHaveBeenCalled();
    expect(await readFile(harness.existingAttachment, 'utf8')).toBe(ORIGINAL);
  });
});
