import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RedisClientType } from 'redis';
import { getRedisClient, setRedisClient } from './redis-cache.js';
import {
  consumeBackupExportTicket,
  createBackupExportTicket,
} from './backup-export-ticket.js';

const TICKET_PREFIX = 'backup:export-ticket:';
const PASSPHRASE = 'correct horse battery staple';

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly setCalls: Array<{
    key: string;
    value: string;
    options: { EX?: number; NX?: boolean };
  }> = [];

  async set(
    key: string,
    value: string,
    options: { EX?: number; NX?: boolean } = {},
  ): Promise<'OK' | null> {
    this.setCalls.push({ key, value, options });
    if (options.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<string | null> {
    const key = options.keys[0];
    if (!key) return null;
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

describe('backup export tickets', () => {
  const originalRedis = getRedisClient();
  const originalPatKey = process.env.PAT_ENCRYPTION_KEY;
  const originalBackupKey = process.env.BACKUP_ENCRYPTION_KEY;
  let redis: FakeRedis;

  beforeEach(() => {
    process.env.PAT_ENCRYPTION_KEY = 'ticket-test-encryption-key-at-least-32-bytes';
    process.env.BACKUP_ENCRYPTION_KEY = 'backup-master-key-at-least-32-bytes';
    redis = new FakeRedis();
    setRedisClient(redis as unknown as RedisClientType);
  });

  afterEach(() => {
    setRedisClient(originalRedis as RedisClientType);
    if (originalPatKey === undefined) delete process.env.PAT_ENCRYPTION_KEY;
    else process.env.PAT_ENCRYPTION_KEY = originalPatKey;
    if (originalBackupKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
    else process.env.BACKUP_ENCRYPTION_KEY = originalBackupKey;
  });

  it('creates a 256-bit ticket with an exact 30-second Redis TTL', async () => {
    const id = await createBackupExportTicket({
      userId: 'admin-1',
      secret: { kind: 'passphrase', passphrase: PASSPHRASE },
    });

    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0]).toMatchObject({
      key: `${TICKET_PREFIX}${id}`,
      options: { EX: 30, NX: true },
    });
  });

  it('never stores a plaintext passphrase', async () => {
    await createBackupExportTicket({
      userId: 'admin-1',
      secret: { kind: 'passphrase', passphrase: PASSPHRASE },
    });

    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0]?.value).not.toContain(PASSPHRASE);
  });

  it('atomically consumes a ticket once and preserves audit attribution', async () => {
    const input = {
      userId: 'admin-1',
      secret: { kind: 'passphrase' as const, passphrase: PASSPHRASE },
    };
    const id = await createBackupExportTicket(input);

    await expect(consumeBackupExportTicket(id)).resolves.toEqual(input);
    await expect(consumeBackupExportTicket(id)).resolves.toBeNull();
  });

  it('stores only the mode marker for master-key tickets', async () => {
    const id = await createBackupExportTicket({
      userId: 'admin-2',
      secret: { kind: 'master', keyMaterial: process.env.BACKUP_ENCRYPTION_KEY! },
    });

    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0]?.value).not.toContain(process.env.BACKUP_ENCRYPTION_KEY!);
    await expect(consumeBackupExportTicket(id)).resolves.toEqual({
      userId: 'admin-2',
      secret: { kind: 'master', keyMaterial: process.env.BACKUP_ENCRYPTION_KEY },
    });
  });

  it('fails closed when Redis is unavailable', async () => {
    setRedisClient(null as unknown as RedisClientType);

    await expect(
      createBackupExportTicket({
        userId: 'admin-1',
        secret: { kind: 'passphrase', passphrase: PASSPHRASE },
      }),
    ).rejects.toThrow(/Redis/i);
    await expect(consumeBackupExportTicket('a'.repeat(64))).resolves.toBeNull();
  });

  it.each([
    ['malformed JSON', '{'],
    ['malformed ticket shape', JSON.stringify({ userId: 'admin-1' })],
    [
      'undecryptable passphrase',
      JSON.stringify({
        userId: 'admin-1',
        secret: { kind: 'passphrase', encryptedPassphrase: 'not-a-ciphertext' },
      }),
    ],
  ])('returns null and deletes %s values', async (_case, storedValue) => {
    const id = 'b'.repeat(64);
    const key = `${TICKET_PREFIX}${id}`;
    redis.values.set(key, storedValue);

    await expect(consumeBackupExportTicket(id)).resolves.toBeNull();
    expect(redis.values.has(key)).toBe(false);
  });
});
