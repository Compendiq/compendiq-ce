import { describe, it, expect, vi, beforeEach } from 'vitest';

const plugin: { resolveAiPolicyCreationDefault?: (i: unknown) => Promise<string> } = {};
vi.mock('../enterprise/loader.js', () => ({
  getEnterprisePlugin: () => plugin,
  isFeatureEnabled: () => false,
}));

import {
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
    expect(tightenExistingAiPolicy('all', ['ai-local-only'])).toBe('local_only');
    expect(tightenExistingAiPolicy('local_only', ['no-ai'])).toBe('none');
  });

  it('SQL fragment never relaxes (uses rank comparison)', () => {
    const sql = TIGHTEN_ONLY_POLICY_SQL('pages.ai_policy', 'EXCLUDED.labels');
    expect(sql).toContain('ai_policy_rank(ai_policy_from_labels(EXCLUDED.labels)) > ai_policy_rank(pages.ai_policy)');
    expect(sql).toContain('ELSE pages.ai_policy');
  });
});
