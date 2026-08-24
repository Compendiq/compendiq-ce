import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { decryptPat, isEncryptedSecretFormat } from '../../../core/utils/crypto.js';
import { startFakeNotionServer, type FakeNotionServer } from './__fixtures__/fake-notion-server.js';
import { setNotionApiBaseUrlForTests } from './notion-client.js';
import { NotionError } from './notion-client.js';
import {
  connectNotionToken,
  disconnectNotionToken,
  getDecryptedNotionToken,
  getNotionConnectionStatus,
} from './notion-token-service.js';

const dbAvailable = await isDbAvailable();
const TOKEN = 'secret_ntn_integration_never_echo';

describe.skipIf(!dbAvailable)('notion-token-service (Postgres 5433 + fake Notion)', () => {
  let server: FakeNotionServer;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
    server = await startFakeNotionServer({ validToken: TOKEN });
    setNotionApiBaseUrlForTests(server.baseUrl);
  });

  afterAll(async () => {
    setNotionApiBaseUrlForTests(null);
    await server.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const r = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('notion_user', 'h', 'user') RETURNING id`,
    );
    userId = r.rows[0]!.id;
  });

  afterEach(() => {
    expect(server.baseUrl).not.toContain('api.notion.com');
  });

  it('stores ciphertext only and round-trips decrypt on the server', async () => {
    await connectNotionToken(userId, TOKEN);

    const row = await query<{ notion_integration_token: string | null }>(
      'SELECT notion_integration_token FROM user_settings WHERE user_id = $1',
      [userId],
    );
    const stored = row.rows[0]!.notion_integration_token;
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(TOKEN);
    expect(isEncryptedSecretFormat(stored!)).toBe(true);
    expect(decryptPat(stored!)).toBe(TOKEN);
    expect(await getDecryptedNotionToken(userId)).toBe(TOKEN);
    expect(await getNotionConnectionStatus(userId)).toEqual({ hasToken: true });
  });

  it('disconnect clears the stored secret', async () => {
    await connectNotionToken(userId, TOKEN);
    await disconnectNotionToken(userId);
    expect(await getNotionConnectionStatus(userId)).toEqual({ hasToken: false });
    const row = await query<{ notion_integration_token: string | null }>(
      'SELECT notion_integration_token FROM user_settings WHERE user_id = $1',
      [userId],
    );
    expect(row.rows[0]!.notion_integration_token).toBeNull();
    expect(await getDecryptedNotionToken(userId)).toBeNull();
  });

  it('does not persist when the fake Notion probe returns 401', async () => {
    await expect(connectNotionToken(userId, 'wrong-token-secret')).rejects.toBeInstanceOf(NotionError);
    expect(await getNotionConnectionStatus(userId)).toEqual({ hasToken: false });
    const row = await query<{ notion_integration_token: string | null }>(
      'SELECT notion_integration_token FROM user_settings WHERE user_id = $1',
      [userId],
    );
    expect(row.rows[0]?.notion_integration_token ?? null).toBeNull();
  });
});
