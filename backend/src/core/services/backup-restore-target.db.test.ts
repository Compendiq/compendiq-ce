import { execFile, type spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../test-db-helper.js';
import { encryptBackupStream, fingerprintPatEncryptionKey, packArchive } from './backup-stream.js';
import { readTargetSchemaMigration, restoreBackup } from './backup-restore.js';

/**
 * #1711: an archive older than the target database is refused before any live
 * mutation. The database suites read the level from the real worker database,
 * which `setupTestDb` migrates to the newest shipped migration.
 */

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown>;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const BACKEND_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url));
const PASSPHRASE = 'restore-target-passphrase';
const SECRET = { kind: 'passphrase' as const, passphrase: PASSPHRASE };
const DATABASE = Buffer.from('PGDUMP');
const ARCHIVE_110 = '110_connection_impression_dedupe.sql';
const ORIGINAL = 'original';
const POSTGRES_URL_REQUIRED = 'POSTGRES_URL is required (also for --dry-run)';

let workRoot: string;
let attachmentsRoot: string;
let existingAttachment: string;

function olderThanTarget(archive: string, target: string): string {
  return `Backup migration ${archive} is older than the target database (${target}). Restore into an empty database and let the application migrations run; see ADMIN-GUIDE "Restoring an older archive".`;
}

async function writeArchive(schemaMigration: string): Promise<string> {
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      createdAt: '2026-11-15T12:00:00.000Z',
      schemaMigration,
      patEncryptionKeyFingerprint: fingerprintPatEncryptionKey(process.env.PAT_ENCRYPTION_KEY ?? ''),
      databaseSizeBytes: DATABASE.length,
      checksums: { 'database.dump': createHash('sha256').update(DATABASE).digest('hex') },
      format: 'cpqarc1',
    }),
  );
  const file = path.join(workRoot, `backup-${schemaMigration}.enc`);
  await pipeline(
    encryptBackupStream(
      packArchive([
        { name: 'database.dump', size: DATABASE.length, stream: Readable.from([DATABASE]) },
        { name: 'manifest.json', size: manifest.length, stream: Readable.from([manifest]) },
      ]),
      SECRET,
    ),
    createWriteStream(file),
  );
  return file;
}

/** The live attachments tree is intact and no staging or rollback directory is left. */
async function expectLiveStateUntouched(): Promise<void> {
  expect(await readFile(existingAttachment, 'utf8')).toBe(ORIGINAL);
  const siblings = await readdir(workRoot);
  expect(siblings.filter((name) => name.startsWith('.compendiq-restore-'))).toEqual([]);
  expect(siblings.filter((name) => name.includes('.restore-backup-'))).toEqual([]);
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  const { promise, resolve } = Promise.withResolvers<CliResult>();
  execFile(
    process.execPath,
    ['--import', 'tsx', 'scripts/restore-backup.ts', ...args],
    { cwd: BACKEND_ROOT, env },
    (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    },
  );
  return promise;
}

function cliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BACKUP_PASSPHRASE: PASSPHRASE,
    ATTACHMENTS_DIR: attachmentsRoot,
    ...overrides,
  };
}

beforeEach(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'cq-restore-target-'));
  attachmentsRoot = path.join(workRoot, 'attachments-live');
  existingAttachment = path.join(attachmentsRoot, 'keep.txt');
  await mkdir(attachmentsRoot, { recursive: true });
  await writeFile(existingAttachment, ORIGINAL);
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe('restore-backup CLI POSTGRES_URL guard (#1711)', () => {
  it.each([[['--dry-run']], [[]]])('exits 2 without POSTGRES_URL (extra flags %j)', async (flags) => {
    const archive = await writeArchive(ARCHIVE_110);

    const result = await runCli(['--file', archive, ...flags], cliEnv({ POSTGRES_URL: undefined }));

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(POSTGRES_URL_REQUIRED);
    await expectLiveStateUntouched();
  });

  it('prints usage that states the POSTGRES_URL requirement', async () => {
    const result = await runCli([], cliEnv());

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage: restore-backup --file <path.enc>');
    expect(result.stderr).toContain(POSTGRES_URL_REQUIRED);
  });
});

const available = await isDbAvailable();

describe.skipIf(!available)('target schema check (real PostgreSQL, #1711)', () => {
  let newestShipped: string;

  beforeAll(async () => {
    await setupTestDb();
    newestShipped = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .at(-1)!;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  /** Runs `fn` against a connection whose changes are rolled back afterwards. */
  async function inRolledBackTransaction(
    setup: string,
    fn: (queryFn: QueryFn) => Promise<void>,
  ): Promise<void> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(setup);
      await fn((sql, params) => client.query(sql, params));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  function restoreFile(file: string, overrides: Record<string, unknown> = {}) {
    return restoreBackup({
      encrypted: createReadStream(file),
      secret: SECRET,
      attachmentsRoot,
      postgresUrl: process.env.POSTGRES_URL!,
      ...overrides,
    });
  }

  describe('readTargetSchemaMigration', () => {
    it('returns the newest applied migration name', async () => {
      expect(await readTargetSchemaMigration()).toBe(newestShipped);
    });

    it('returns null when _migrations has no rows', async () => {
      await inRolledBackTransaction('DELETE FROM _migrations', async (queryFn) => {
        expect(await readTargetSchemaMigration(queryFn)).toBeNull();
      });
    });

    it('returns null when the _migrations relation does not exist', async () => {
      await inRolledBackTransaction(
        'ALTER TABLE _migrations RENAME TO _migrations_1711_hidden',
        async (queryFn) => {
          expect(await readTargetSchemaMigration(queryFn)).toBeNull();
        },
      );
    });

    it('propagates any other database error instead of reporting an empty target', async () => {
      await inRolledBackTransaction('SELECT 1', async (queryFn) => {
        await expect(queryFn('SELECT 1 / 0')).rejects.toThrow();
        await expect(readTargetSchemaMigration(queryFn)).rejects.toMatchObject({ code: '25P02' });
      });
    });
  });

  describe('restoreBackup', () => {
    it('refuses an older archive at dry-run and removes staging', async () => {
      const archive = await writeArchive(ARCHIVE_110);

      await expect(restoreFile(archive, { dryRun: true })).rejects.toThrow(
        olderThanTarget(ARCHIVE_110, newestShipped),
      );
      await expectLiveStateUntouched();
    });

    it('refuses an older archive on a real restore before pg_restore is spawned', async () => {
      const archive = await writeArchive(ARCHIVE_110);
      const spawnFn = vi.fn();
      const runMigrationsFn = vi.fn();

      await expect(
        restoreFile(archive, { spawnFn: spawnFn as unknown as typeof spawn, runMigrationsFn }),
      ).rejects.toThrow(olderThanTarget(ARCHIVE_110, newestShipped));
      expect(spawnFn).not.toHaveBeenCalled();
      expect(runMigrationsFn).not.toHaveBeenCalled();
      await expectLiveStateUntouched();
    });

    it('allows an archive at the target level at dry-run', async () => {
      const archive = await writeArchive(newestShipped);

      const manifest = await restoreFile(archive, { dryRun: true });

      expect(manifest.schemaMigration).toBe(newestShipped);
      await expectLiveStateUntouched();
    });

    it('allows an older archive into an empty target at dry-run', async () => {
      const archive = await writeArchive(ARCHIVE_110);

      await inRolledBackTransaction(
        'ALTER TABLE _migrations RENAME TO _migrations_1711_hidden',
        async (queryFn) => {
          const manifest = await restoreFile(archive, { dryRun: true, queryFn });
          expect(manifest.schemaMigration).toBe(ARCHIVE_110);
        },
      );
      await expectLiveStateUntouched();
    });
  });

  describe('restore-backup CLI', () => {
    it('dry-run refuses an archive older than the target database with exit 1', async () => {
      const archive = await writeArchive(ARCHIVE_110);

      const result = await runCli(['--file', archive, '--dry-run'], cliEnv());

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(olderThanTarget(ARCHIVE_110, newestShipped));
      await expectLiveStateUntouched();
    });

    it('restore refuses the same archive before renaming attachments or spawning pg_restore', async () => {
      const archive = await writeArchive(ARCHIVE_110);
      const fakeBin = path.join(workRoot, 'bin');
      const marker = path.join(workRoot, 'pg_restore-spawned');
      await mkdir(fakeBin);
      await writeFile(
        path.join(fakeBin, 'pg_restore'),
        '#!/bin/sh\necho spawned > "$PG_RESTORE_MARKER"\ncat > /dev/null\nexit 1\n',
      );
      await chmod(path.join(fakeBin, 'pg_restore'), 0o755);

      const result = await runCli(
        ['--file', archive],
        cliEnv({
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          PG_RESTORE_MARKER: marker,
        }),
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(olderThanTarget(ARCHIVE_110, newestShipped));
      expect((await readdir(workRoot)).sort()).toEqual(
        ['attachments-live', 'bin', `backup-${ARCHIVE_110}.enc`].sort(),
      );
      await expectLiveStateUntouched();
    });

    it('dry-run reports ok for an archive at the target level', async () => {
      const archive = await writeArchive(newestShipped);

      const result = await runCli(['--file', archive, '--dry-run'], cliEnv());

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        dryRun: true,
        schemaMigration: newestShipped,
      });
    });
  });
});
