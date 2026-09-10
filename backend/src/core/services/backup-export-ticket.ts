import { randomBytes } from 'node:crypto';
import { decryptPat, encryptPat } from '../utils/crypto.js';
import { requireMasterBackupKey } from './backup-settings.js';
import { getRedisClient } from './redis-cache.js';
import type { BackupSecret } from './backup-stream.js';

const TICKET_PREFIX = 'backup:export-ticket:';
const TICKET_TTL_SECONDS = 30;
const TICKET_ID_PATTERN = /^[0-9a-f]{64}$/;
const GET_AND_DELETE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`;

type StoredBackupExportTicket =
  | {
      userId: string;
      secret: { kind: 'master' };
    }
  | {
      userId: string;
      secret: { kind: 'passphrase'; encryptedPassphrase: string };
    };

export async function createBackupExportTicket(input: {
  userId: string;
  secret: BackupSecret;
}): Promise<string> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis is required to create a backup export ticket');
  }

  const id = randomBytes(32).toString('hex');
  const stored: StoredBackupExportTicket =
    input.secret.kind === 'passphrase'
      ? {
          userId: input.userId,
          secret: {
            kind: 'passphrase',
            encryptedPassphrase: encryptPat(input.secret.passphrase),
          },
        }
      : { userId: input.userId, secret: { kind: 'master' } };

  const result = await redis.set(`${TICKET_PREFIX}${id}`, JSON.stringify(stored), {
    EX: TICKET_TTL_SECONDS,
    NX: true,
  });
  if (result !== 'OK') {
    throw new Error('Failed to create a unique backup export ticket');
  }

  return id;
}

export async function consumeBackupExportTicket(
  id: string,
): Promise<{ userId: string; secret: BackupSecret } | null> {
  if (!TICKET_ID_PATTERN.test(id)) return null;

  const redis = getRedisClient();
  if (!redis) return null;

  const value = await redis.eval(GET_AND_DELETE_SCRIPT, {
    keys: [`${TICKET_PREFIX}${id}`],
    arguments: [],
  });
  if (typeof value !== 'string') return null;

  try {
    const stored: unknown = JSON.parse(value);
    if (!isStoredTicket(stored)) return null;

    if (stored.secret.kind === 'master') {
      return {
        userId: stored.userId,
        secret: { kind: 'master', keyMaterial: requireMasterBackupKey() },
      };
    }

    const passphrase = decryptPat(stored.secret.encryptedPassphrase);
    if (passphrase.length < 12 || passphrase.length > 1024) return null;
    return {
      userId: stored.userId,
      secret: { kind: 'passphrase', passphrase },
    };
  } catch {
    return null;
  }
}

function isStoredTicket(value: unknown): value is StoredBackupExportTicket {
  if (!value || typeof value !== 'object') return false;
  const ticket = value as Record<string, unknown>;
  if (typeof ticket.userId !== 'string' || ticket.userId.length === 0) return false;
  if (!ticket.secret || typeof ticket.secret !== 'object') return false;

  const secret = ticket.secret as Record<string, unknown>;
  if (secret.kind === 'master') return true;
  return secret.kind === 'passphrase' && typeof secret.encryptedPassphrase === 'string';
}
