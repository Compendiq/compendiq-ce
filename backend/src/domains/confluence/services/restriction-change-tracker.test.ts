import { describe, it, expect, vi } from 'vitest';
import { getRestrictionChangeSet, RETENTION_SAFETY_MARGIN_MS } from './restriction-change-tracker.js';
import { AuditUnavailableError } from './confluence-client.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function makeClient(over?: Partial<{ getAuditRetention: ReturnType<typeof vi.fn>; getAuditRecords: ReturnType<typeof vi.fn> }>) {
  return {
    getAuditRetention: vi.fn().mockResolvedValue({ number: 3, units: 'YEARS' }),
    getAuditRecords: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

describe('getRestrictionChangeSet', () => {
  it('returns incremental with only Permissions/page event ids', async () => {
    const client = makeClient({
      getAuditRecords: vi.fn().mockResolvedValue([
        { creationDate: NOW - 1000, category: 'Permissions', affectedObject: { id: '111', type: 'page', name: 'A' } },
        { creationDate: NOW - 2000, category: 'Permissions', affectedObject: { id: '222', type: 'page', name: 'B' } },
        { creationDate: NOW - 3000, category: 'Audit', affectedObject: { id: '999', type: 'page', name: 'X' } },
        { creationDate: NOW - 4000, category: 'Permissions', affectedObject: { id: '333', type: 'space', name: 'S' } },
      ]),
    });

    const result = await getRestrictionChangeSet(client, NOW, { confirmWindowHours: 168 });

    expect(result.mode).toBe('incremental');
    if (result.mode === 'incremental') {
      expect([...result.changedPageIds].sort()).toEqual(['111', '222']);
      expect(result.auditQueryAt).toBe(NOW);
      expect(result.windowStartMs).toBe(NOW - 168 * HOUR);
    }
  });

  it('falls back to full when the audit API is unavailable (403)', async () => {
    const client = makeClient({ getAuditRecords: vi.fn().mockRejectedValue(new AuditUnavailableError('no admin', 403)) });
    expect(await getRestrictionChangeSet(client, NOW, { confirmWindowHours: 168 })).toEqual({ mode: 'full' });
  });

  it('falls back to full on any audit query error', async () => {
    const client = makeClient({ getAuditRecords: vi.fn().mockRejectedValue(new Error('5xx / timeout')) });
    expect(await getRestrictionChangeSet(client, NOW)).toEqual({ mode: 'full' });
  });

  it('falls back to full when the retention probe fails (cannot establish a safe window)', async () => {
    const client = makeClient({ getAuditRetention: vi.fn().mockRejectedValue(new Error('retention probe failed')) });
    expect(await getRestrictionChangeSet(client, NOW)).toEqual({ mode: 'full' });
  });

  it('falls back to full when retention units are not understood', async () => {
    const client = makeClient({ getAuditRetention: vi.fn().mockResolvedValue({ number: 5, units: 'FORTNIGHTS' }) });
    expect(await getRestrictionChangeSet(client, NOW)).toEqual({ mode: 'full' });
  });

  it('falls back to full when a Permissions/page event has no parseable id', async () => {
    const client = makeClient({
      getAuditRecords: vi.fn().mockResolvedValue([
        { creationDate: NOW, category: 'Permissions', affectedObject: { id: '', type: 'page' } },
      ]),
    });
    expect(await getRestrictionChangeSet(client, NOW)).toEqual({ mode: 'full' });
  });

  it('narrows the window to the retention horizon (plus safety margin) when retention < confirm window', async () => {
    const client = makeClient({ getAuditRetention: vi.fn().mockResolvedValue({ number: 1, units: 'DAYS' }) });

    const result = await getRestrictionChangeSet(client, NOW, { confirmWindowHours: 168 });

    expect(result.mode).toBe('incremental');
    if (result.mode === 'incremental') {
      const expectedStart = NOW - 24 * HOUR + RETENTION_SAFETY_MARGIN_MS;
      expect(result.windowStartMs).toBe(expectedStart);
      expect(client.getAuditRecords).toHaveBeenCalledWith({ startDate: expectedStart });
    }
  });

  it('uses the confirm window when retention is much longer', async () => {
    const client = makeClient({ getAuditRetention: vi.fn().mockResolvedValue({ number: 3, units: 'YEARS' }) });

    const result = await getRestrictionChangeSet(client, NOW, { confirmWindowHours: 168 });

    if (result.mode === 'incremental') {
      expect(result.windowStartMs).toBe(NOW - 168 * HOUR);
    }
  });
});
