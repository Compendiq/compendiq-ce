import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { getSearxngMaxResults } from './_helpers.js';

const dbAvailable = await isDbAvailable();

async function store(value: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('searxng_max_results', $1, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
    [value],
  );
}

describe.skipIf(!dbAvailable)('getSearxngMaxResults — stored value normalized into the sidecar range (#1768)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await query(`DELETE FROM admin_settings WHERE setting_key = 'searxng_max_results'`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Rows written under the pre-#1768 admin range (1–20) must not disable web
  // search: the sidecar's search_web schema rejects anything above 10.
  it.each([
    ['15', 10],
    ['21', 10],
    ['0', 1],
    ['-3', 1],
    ['abc', 5],
    ['7', 7],
    ['10', 10],
  ])('reads stored %j as %i', async (stored, expected) => {
    await store(stored);
    expect(await getSearxngMaxResults()).toBe(expected);
  });

  it('reads the default 5 when nothing is stored', async () => {
    expect(await getSearxngMaxResults()).toBe(5);
  });

  it('warns with the stored and effective values when clamping', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await store('15');

    await getSearxngMaxResults();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stored: '15', effective: 10 }),
      expect.stringContaining('searxng_max_results'),
    );
  });

  it('warns and falls back to the default for a non-numeric stored value', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await store('abc');

    expect(await getSearxngMaxResults()).toBe(5);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stored: 'abc' }),
      expect.stringMatching(/searxng_max_results is not a number/),
    );
    expect(warn.mock.calls[0]?.[0]).not.toHaveProperty('effective');
  });

  it('does not warn for an in-range stored value', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await store('7');

    await getSearxngMaxResults();

    expect(warn).not.toHaveBeenCalled();
  });
});
