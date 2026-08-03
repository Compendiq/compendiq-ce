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
  readVisionCapabilityDetail,
  invalidateProviderCapabilities,
  PROBE_ERROR_MAX_CHARS,
  __flushRefreshesForTests,
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

  it('schedules a probe on cache miss and persists the result', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: true });

    // On cache miss, getVisionCapability returns null immediately (no cached value)
    // but schedules a background probe
    expect(await getVisionCapability(id, 'qwen2.5vl')).toBeNull();

    // Deterministic: await the scheduled refresh itself rather than racing
    // two Postgres round-trips against a fixed sleep.
    await __flushRefreshesForTests();

    expect(mockProbeVision).toHaveBeenCalledTimes(1);

    // The probe result should now be persisted
    const { rows } = await query<{ vision: boolean }>(
      `SELECT vision FROM llm_model_capabilities WHERE provider_id=$1 AND model='qwen2.5vl'`,
      [id],
    );
    expect(rows[0]!.vision).toBe(true);
  });

  it('reads a fresh cached row without probing again', async () => {
    const id = await seedProvider();
    // Pre-seed a fresh row with a definite verdict
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
       VALUES ($1,'llama3.1',false, NOW())`,
      [id],
    );
    mockProbeVision.mockResolvedValue({ vision: true }); // Different value to verify cache

    // Reading a fresh cached row should not probe
    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);

    expect(mockProbeVision).toHaveBeenCalledTimes(0);
  });

  it('caches a false verdict rather than re-probing it', async () => {
    const id = await seedProvider();
    // Pre-seed a fresh row with vision=false
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
       VALUES ($1,'llama3.1',false, NOW())`,
      [id],
    );
    mockProbeVision.mockResolvedValue({ vision: true }); // Try to return different value

    // Should return cached false, not call probeVision
    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
    mockProbeVision.mockResolvedValue({ vision: true });
    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
    expect(mockProbeVision).toHaveBeenCalledTimes(0);
  });

  it('schedules (but does not await) a background refresh when verdict is NULL', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: null, error: 'ECONNREFUSED' });

    // First call: returns NULL immediately, schedules refresh in background
    expect(await getVisionCapability(id, 'm')).toBeNull();

    await __flushRefreshesForTests();
    expect(mockProbeVision).toHaveBeenCalledTimes(1);

    // A second immediate call must not probe again. By now the refresh has
    // flushed, so it is the cooldown on the freshly-written NULL row doing the
    // work here — not in-flight de-duplication, which only covers the window
    // before the first probe resolves.
    expect(await getVisionCapability(id, 'm')).toBeNull();
    expect(mockProbeVision).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it('persists the probe error alongside a NULL verdict', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: null, error: 'connect ECONNREFUSED' });

    // Cache miss schedules background probe
    expect(await getVisionCapability(id, 'm')).toBeNull();

    await __flushRefreshesForTests();

    expect(mockProbeVision).toHaveBeenCalledTimes(1);

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

    await __flushRefreshesForTests();
    expect(mockProbeVision).toHaveBeenCalledTimes(1);

    // After the refresh completes, the cache is updated to the new value
    expect(await getVisionCapability(id, 'm')).toBe(false);
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
    // Pre-seed two different models with different verdicts
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
       VALUES ($1,'qwen2.5vl',true, NOW()), ($1,'llama3.1',false, NOW())`,
      [id],
    );

    // Both should return their cached verdicts
    expect(await getVisionCapability(id, 'qwen2.5vl')).toBe(true);
    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
    expect(mockProbeVision).toHaveBeenCalledTimes(0);
  });

  it('refreshVisionCapability probes even when a fresh row exists', async () => {
    const id = await seedProvider();
    // Pre-seed a fresh row
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
       VALUES ($1,'m',false, NOW())`,
      [id],
    );

    mockProbeVision.mockResolvedValue({ vision: true });
    // refreshVisionCapability should probe and return new value, overwriting the cache
    expect((await refreshVisionCapability(id, 'm')).vision).toBe(true);
    expect(mockProbeVision).toHaveBeenCalledTimes(1);
  });

  /**
   * #1184: the manual re-probe route answers with the verdict *and* the
   * evidence, so the probe error can no longer be written-and-dropped. The
   * value is returned from the probe the caller just ran rather than re-read,
   * so a concurrent background refresh of the same key cannot hand the caller
   * a different verdict than the one their click produced.
   */
  it('refreshVisionCapability returns the probe error and the stored timestamp', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: false, error: 'chat HTTP 415: image_url' });

    const result = await refreshVisionCapability(id, 'm');

    expect(result.vision).toBe(false);
    expect(result.probeError).toBe('chat HTTP 415: image_url');
    // `probed_at` comes from Postgres's NOW(), the same clock that wrote it.
    const { rows } = await query<{ probed_at: Date }>(
      `SELECT probed_at FROM llm_model_capabilities WHERE provider_id=$1 AND model='m'`,
      [id],
    );
    expect(new Date(result.probedAt).getTime()).toBe(rows[0]!.probed_at.getTime());
  });

  it('refreshVisionCapability reports a clean probe as a null error, not undefined', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: true });

    expect(await refreshVisionCapability(id, 'm')).toMatchObject({
      vision: true,
      probeError: null,
    });
  });

  describe('readVisionCapabilityDetail (#1184)', () => {
    it('returns the stored verdict, timestamp and probe error', async () => {
      const id = await seedProvider();
      await query(
        `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at, probe_error)
         VALUES ($1,'m',false, NOW(), 'chat HTTP 415: image_url unsupported')`,
        [id],
      );

      const detail = await readVisionCapabilityDetail(id, 'm');

      expect(detail).toEqual({
        vision: false,
        probedAt: expect.any(String),
        probeError: 'chat HTTP 415: image_url unsupported',
      });
      expect(Date.parse(detail!.probedAt)).not.toBeNaN();
    });

    /**
     * Reading must never probe: the badge fetches this on every Settings → LLM
     * paint, and a probe costs a chat completion.
     */
    it('never probes', async () => {
      const id = await seedProvider();
      mockProbeVision.mockResolvedValue({ vision: true });

      await readVisionCapabilityDetail(id, 'never-seen');

      expect(mockProbeVision).toHaveBeenCalledTimes(0);
    });

    it('returns null for a pair that has never been probed', async () => {
      const id = await seedProvider();
      expect(await readVisionCapabilityDetail(id, 'never-seen')).toBeNull();
    });

    it('keeps the tri-state distinct: a null verdict is not a false one', async () => {
      const id = await seedProvider();
      await query(
        `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at, probe_error)
         VALUES ($1,'m',NULL, NOW(), 'connect ECONNREFUSED')`,
        [id],
      );

      expect((await readVisionCapabilityDetail(id, 'm'))!.vision).toBeNull();
    });

    /**
     * An HTTP-derived probe error is already capped at ERROR_BODY_MAX_CHARS,
     * but a non-HTTP failure stores `err.message` verbatim into an untyped
     * TEXT column. Truncate at the read boundary so no caller has to remember.
     */
    it('truncates an oversized probe error', async () => {
      const id = await seedProvider();
      const huge = 'x'.repeat(PROBE_ERROR_MAX_CHARS * 3);
      await query(
        `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at, probe_error)
         VALUES ($1,'m',NULL, NOW(), $2)`,
        [id, huge],
      );

      const detail = await readVisionCapabilityDetail(id, 'm');

      expect(detail!.probeError!.length).toBeLessThanOrEqual(PROBE_ERROR_MAX_CHARS);
      expect(detail!.probeError).toMatch(/…$/);
    });

    it('truncates the probe error returned by refreshVisionCapability too', async () => {
      const id = await seedProvider();
      mockProbeVision.mockResolvedValue({
        vision: null,
        error: 'y'.repeat(PROBE_ERROR_MAX_CHARS * 3),
      });

      const result = await refreshVisionCapability(id, 'm');

      expect(result.probeError!.length).toBeLessThanOrEqual(PROBE_ERROR_MAX_CHARS);
    });

    it('leaves a short probe error untouched', async () => {
      const id = await seedProvider();
      await query(
        `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at, probe_error)
         VALUES ($1,'m',false, NOW(), 'short')`,
        [id],
      );

      expect((await readVisionCapabilityDetail(id, 'm'))!.probeError).toBe('short');
    });
  });

  it('invalidateProviderCapabilities drops every row for that provider', async () => {
    const id = await seedProvider();
    // Pre-seed some rows
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
       VALUES ($1,'a',true, NOW()), ($1,'b',false, NOW())`,
      [id],
    );

    await invalidateProviderCapabilities(id);

    const { rows } = await query(
      `SELECT 1 FROM llm_model_capabilities WHERE provider_id=$1`, [id],
    );
    expect(rows).toHaveLength(0);
  });
});
