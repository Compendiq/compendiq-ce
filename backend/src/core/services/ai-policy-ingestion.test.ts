import { describe, it, expect, vi, beforeEach } from 'vitest';

const plugin: { resolveAiPolicyCreationDefault?: (i: unknown) => Promise<string> } = {};
vi.mock('../enterprise/loader.js', () => ({
  getEnterprisePlugin: () => plugin,
  isFeatureEnabled: () => false,
}));

import {
  boundConfluenceId,
  FRESH_PUBLICATION_FENCE_ACTIVE_SQL,
  resolveIngestionAiPolicy,
  tightenExistingAiPolicy,
  TIGHTEN_ONLY_POLICY_SQL,
} from './ai-policy-ingestion.js';

describe('ingestion AI policy (SPEC-WORK-002)', () => {
  beforeEach(() => {
    delete plugin.resolveAiPolicyCreationDefault;
  });

  it('calls the creation-default hook for a new row', async () => {
    const hook = vi.fn().mockResolvedValue('local_only');
    plugin.resolveAiPolicyCreationDefault = hook;
    const p = await resolveIngestionAiPolicy({ userId: 'u', spaceKey: 'S', labels: [] });
    expect(hook).toHaveBeenCalledWith({ userId: 'u', spaceKey: 'S' });
    expect(p).toBe('local_only');
  });

  it('takes the stricter of default and incoming labels', async () => {
    plugin.resolveAiPolicyCreationDefault = vi.fn().mockResolvedValue('local_only');
    expect(await resolveIngestionAiPolicy({ userId: 'u', spaceKey: null, labels: ['no-ai'] })).toBe('none');
    plugin.resolveAiPolicyCreationDefault = vi.fn().mockResolvedValue('none');
    expect(await resolveIngestionAiPolicy({ userId: 'u', spaceKey: null, labels: ['ai-local'] })).toBe('none');
  });

  it('fails closed on an unrecognised hook answer', async () => {
    plugin.resolveAiPolicyCreationDefault = vi.fn().mockResolvedValue('bogus');
    expect(await resolveIngestionAiPolicy({ userId: 'u', spaceKey: null, labels: null })).toBe('none');
  });

  it('existing rows only tighten', () => {
    expect(tightenExistingAiPolicy('none', [])).toBe('none');
    expect(tightenExistingAiPolicy('local_only', ['other'])).toBe('local_only');
    expect(tightenExistingAiPolicy('all', ['local-ai-only'])).toBe('local_only');
    // Spellings outside the frozen table are ordinary labels.
    expect(tightenExistingAiPolicy('all', ['ai-local-only'])).toBe('all');
    expect(tightenExistingAiPolicy('local_only', ['no-ai'])).toBe('none');
  });

  it('a binding is a VALIDATED receipt with a durable completion, never a bare id (#281)', () => {
    const now = new Date();
    expect(boundConfluenceId({ confluenceId: 'cf', accepted: true, expectedVersion: 1 }, now)).toBe('cf');
    expect(boundConfluenceId({ confluenceId: 'cf', accepted: true, expectedVersion: 1 }, null)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf' }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf', accepted: false, expectedVersion: 0 }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf', accepted: true, expectedVersion: 1, observedConfluenceId: 'other' }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: 'cf', accepted: true, expectedVersion: 1, version: 2 }, now)).toBeNull();
  });

  it('the cursor fence decodes labels with the frozen synonym table, not a looser SQL normalizer', () => {
    expect(FRESH_PUBLICATION_FENCE_ACTIVE_SQL).toContain(`'local-ai-only'`);
    expect(FRESH_PUBLICATION_FENCE_ACTIVE_SQL).toContain(`'no-ai'`);
    expect(FRESH_PUBLICATION_FENCE_ACTIVE_SQL).not.toContain(`'all-ai'`);
    expect(FRESH_PUBLICATION_FENCE_ACTIVE_SQL).not.toContain('ai_policy_from_labels');
    expect(FRESH_PUBLICATION_FENCE_ACTIVE_SQL).toContain(`'expectedVersion'`);
    expect(FRESH_PUBLICATION_FENCE_ACTIVE_SQL).toContain('remote_effects_completed_at IS NOT NULL');
  });

  it('SQL fragment never relaxes (uses rank comparison)', () => {
    const sql = TIGHTEN_ONLY_POLICY_SQL('pages.ai_policy', 'EXCLUDED.labels');
    expect(sql).toContain('ai_policy_rank(ai_policy_from_labels(EXCLUDED.labels)) > ai_policy_rank(pages.ai_policy)');
    expect(sql).toContain('ELSE pages.ai_policy');
  });
});
