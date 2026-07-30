import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const mockProbeVision = vi.fn();
vi.mock('./vision-probe.js', () => ({
  probeVision: (...args: unknown[]) => mockProbeVision(...args),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  getVisionCapability,
  refreshVisionCapability,
  invalidateProviderCapabilities,
} from './model-capabilities.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('model capabilities', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    mockProbeVision.mockReset();
  });

  async function seedProvider(): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
       VALUES ('P','http://x/v1','none',true,true) RETURNING id`,
    );
    return rows[0]!.id;
  }

  it('probes and persists on a cache miss', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: true });

    expect(await getVisionCapability(id, 'qwen2.5vl')).toBe(true);
    expect(mockProbeVision).toHaveBeenCalledTimes(1);

    const { rows } = await query<{ vision: boolean }>(
      `SELECT vision FROM llm_model_capabilities WHERE provider_id=$1 AND model='qwen2.5vl'`,
      [id],
    );
    expect(rows[0]!.vision).toBe(true);
  });

  it('reads a fresh row without probing again', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: false });

    await getVisionCapability(id, 'llama3.1');
    await getVisionCapability(id, 'llama3.1');

    expect(mockProbeVision).toHaveBeenCalledTimes(1);
  });

  it('caches a false verdict rather than re-probing it', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: false });

    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
    mockProbeVision.mockResolvedValue({ vision: true });
    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
  });

  it('schedules (but does not await) a background refresh when verdict is NULL', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: null, error: 'ECONNREFUSED' });

    // First call: returns NULL immediately, schedules refresh in background
    expect(await getVisionCapability(id, 'm')).toBeNull();
    expect(mockProbeVision).toHaveBeenCalledTimes(1);

    // A second immediate call should NOT call probeVision again (deduplication of in-flight refreshes)
    expect(await getVisionCapability(id, 'm')).toBeNull();
    expect(mockProbeVision).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it('persists the probe error alongside a NULL verdict', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: null, error: 'connect ECONNREFUSED' });
    await getVisionCapability(id, 'm');

    const { rows } = await query<{ probe_error: string }>(
      `SELECT probe_error FROM llm_model_capabilities WHERE provider_id=$1`,
      [id],
    );
    expect(rows[0]!.probe_error).toBe('connect ECONNREFUSED');
  });

  it('returns the stale row immediately and schedules a background refresh', async () => {
    const id = await seedProvider();
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
       VALUES ($1,'m',true, NOW() - INTERVAL '31 days')`,
      [id],
    );
    mockProbeVision.mockResolvedValue({ vision: false });

    // Returns the stale row (true) immediately without blocking
    expect(await getVisionCapability(id, 'm')).toBe(true);

    // A refresh was scheduled (probeVision was called), but we got the old value
    // A second call should not schedule another refresh due to deduplication
    expect(await getVisionCapability(id, 'm')).toBe(true);
    expect(mockProbeVision).toHaveBeenCalledTimes(1);
  });

  it('applies a cooldown to prevent repeatedly scheduling refreshes for NULL verdicts', async () => {
    const id = await seedProvider();
    // Insert a NULL row with a recent timestamp (within cooldown)
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
       VALUES ($1,'m',NULL, NOW())`,
      [id],
    );
    mockProbeVision.mockResolvedValue({ vision: null, error: 'still unknown' });

    // First call should not schedule a refresh because we're inside the cooldown window
    expect(await getVisionCapability(id, 'm')).toBeNull();
    expect(mockProbeVision).toHaveBeenCalledTimes(0);

    // Verify that a second call also respects the cooldown
    expect(await getVisionCapability(id, 'm')).toBeNull();
    expect(mockProbeVision).toHaveBeenCalledTimes(0);
  });

  it('keeps verdicts independent per model on one provider', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValueOnce({ vision: true });
    mockProbeVision.mockResolvedValueOnce({ vision: false });

    expect(await getVisionCapability(id, 'qwen2.5vl')).toBe(true);
    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
  });

  it('refreshVisionCapability probes even when a fresh row exists', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: false });
    await getVisionCapability(id, 'm');

    mockProbeVision.mockResolvedValue({ vision: true });
    expect(await refreshVisionCapability(id, 'm')).toBe(true);
  });

  it('invalidateProviderCapabilities drops every row for that provider', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: true });
    await getVisionCapability(id, 'a');
    await getVisionCapability(id, 'b');

    await invalidateProviderCapabilities(id);

    const { rows } = await query(
      `SELECT 1 FROM llm_model_capabilities WHERE provider_id=$1`, [id],
    );
    expect(rows).toHaveLength(0);
  });
});
