import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { getMcpDocsSettings } from './mcp-docs-settings.js';

const dbAvailable = await isDbAvailable();

async function store(key: 'mcp_docs_cache_ttl' | 'mcp_docs_max_content_length', value: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
    [key, value],
  );
}

/**
 * Both values are forwarded to the sidecar as tool arguments since #1769
 * (`cache_ttl` 60–86400, `max_length` ≤ 100 000). A stored row outside those
 * ranges would make every fetch fail with -32602, so it is clamped on read.
 */
describe.skipIf(!dbAvailable)('getMcpDocsSettings — stored cacheTtl / maxContentLength normalized into the sidecar ranges (#1769)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await query(`DELETE FROM admin_settings WHERE setting_key LIKE 'mcp_docs_%'`);
  });

  afterAll(async () => {
    // Leave nothing behind for later files in this worker's database.
    await query(`DELETE FROM admin_settings WHERE setting_key LIKE 'mcp_docs_%'`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the defaults when nothing is stored', async () => {
    const settings = await getMcpDocsSettings();
    expect(settings.cacheTtl).toBe(3600);
    expect(settings.maxContentLength).toBe(50_000);
  });

  it('reads a pre-#1769 stored maxContentLength of 500000 as 100000 and warns', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await store('mcp_docs_max_content_length', '500000');

    expect((await getMcpDocsSettings()).maxContentLength).toBe(100_000);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'mcp_docs_max_content_length', stored: '500000', effective: 100_000 }),
      expect.stringContaining('clamped'),
    );
  });

  it.each([
    ['30', 60],
    ['90000', 86_400],
    ['7200', 7200],
  ])('reads stored mcp_docs_cache_ttl %j as %i', async (stored, expected) => {
    await store('mcp_docs_cache_ttl', stored);
    expect((await getMcpDocsSettings()).cacheTtl).toBe(expected);
  });

  it('warns and falls back to the default for a non-numeric stored value', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await store('mcp_docs_cache_ttl', 'abc');

    expect((await getMcpDocsSettings()).cacheTtl).toBe(3600);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'mcp_docs_cache_ttl', stored: 'abc' }),
      expect.stringMatching(/not a number/),
    );
  });

  it('does not warn for in-range stored values', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await store('mcp_docs_cache_ttl', '60');
    await store('mcp_docs_max_content_length', '1000');

    const settings = await getMcpDocsSettings();

    expect(settings).toMatchObject({ cacheTtl: 60, maxContentLength: 1000 });
    expect(warn).not.toHaveBeenCalled();
  });
});
