import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getImageEmbeddingTargetDimensions,
  IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY,
} from './image-embedding-target-dimensions.js';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';

/**
 * #1115 — the MRL truncation width the image leg requests.
 *
 * Real Postgres, never mocked: the whole module is one `admin_settings` read,
 * and the interesting half is what it does with a row that did NOT come
 * through `UpdateAdminSettingsSchema` — psql, a restored dump, a future
 * migration. The safe reading of a nonsense truncation width is "no truncation
 * at all", because the alternative is asking a model for a width it cannot
 * serve on every image-side call.
 */
const dbAvailable = await isDbAvailable();

async function write(value: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY, value],
  );
}

describe.skipIf(!dbAvailable)('getImageEmbeddingTargetDimensions (#1115)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('answers null when no width is configured — the model’s native width', async () => {
    expect(await getImageEmbeddingTargetDimensions()).toBeNull();
  });

  it('reads a configured width back as a number', async () => {
    await write('2048');
    expect(await getImageEmbeddingTargetDimensions()).toBe(2048);
  });

  it.each(['0', '-1', '16001', 'wide', '2048.5', ''])(
    'discards the unusable stored value %s rather than passing it on',
    async (raw) => {
      await write(raw);
      expect(await getImageEmbeddingTargetDimensions()).toBeNull();
    },
  );

  /**
   * 4001..16000 is storable and unindexable — a tier the settings row states
   * rather than a value to refuse. Discarding it here would silently drop a
   * deliberate choice and send the leg back to the native width.
   */
  it('keeps a storable-but-unindexable width', async () => {
    await write('4096');
    expect(await getImageEmbeddingTargetDimensions()).toBe(4096);
  });
});
