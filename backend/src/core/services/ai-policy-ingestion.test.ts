import { describe, it, expect, vi, beforeEach } from 'vitest';

const plugin: { resolveAiPolicyCreationDefault?: (i: unknown) => Promise<string> } = {};
vi.mock('../enterprise/loader.js', () => ({
  getEnterprisePlugin: () => plugin,
  isFeatureEnabled: () => false,
}));

import {
  boundConfluenceId,
  createIntentHoldsFence,
  FRESH_PUBLICATION_FENCE_ACTIVE_SQL,
  JS_TRIM_CODE_POINTS,
  JS_TRIM_SQL,
  resolveIngestionAiPolicy,
  tightenExistingAiPolicy,
  admitAutomaticIngestionPolicy,
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

  it('observedConfluenceId / version must be the right JSON TYPE, not merely the same text', () => {
    const now = new Date();
    // A JSON number spelling the same digits as the command id is NOT a match.
    expect(boundConfluenceId({ confluenceId: '880001', accepted: true, expectedVersion: 1, observedConfluenceId: 880001 }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: '880001', accepted: true, expectedVersion: 1, observedConfluenceId: null }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: '880001', accepted: true, expectedVersion: 1, version: '1' }, now)).toBeNull();
    expect(boundConfluenceId({ confluenceId: '880001', accepted: true, expectedVersion: '1' }, now)).toBeNull();
    // Positive control.
    expect(boundConfluenceId({ confluenceId: '880001', accepted: true, expectedVersion: 1, observedConfluenceId: '880001', version: 1 }, now)).toBe('880001');
  });

  it('the TS fence twin treats whitespace exactly as the shared normalizer (JS trim)', () => {
    const base = { remote_terminal_result: null, remote_effects_completed_at: null };
    expect(createIntentHoldsFence({ ...base, effect: { initialPolicy: 'all', initialLabels: ['no-ai\t'] } })).toBe(true);
    expect(createIntentHoldsFence({ ...base, effect: { initialPolicy: 'all', initialLabels: ['\u00a0No-AI\u3000'] } })).toBe(true);
    expect(createIntentHoldsFence({ ...base, effect: { initialPolicy: 'all', initialLabels: ['ops'] } })).toBe(false);
    expect(createIntentHoldsFence({ ...base, effect: {} })).toBe(true);
    // The SQL trim class is exactly what JS `trim` strips.
    for (const cp of JS_TRIM_CODE_POINTS) expect(`${String.fromCodePoint(cp)}x${String.fromCodePoint(cp)}`.trim()).toBe('x');
    expect(JS_TRIM_SQL('x')).toContain('\\u0009');
    expect(JS_TRIM_SQL('x')).toContain('\\ufeff');
    expect(FRESH_PUBLICATION_FENCE_ACTIVE_SQL).not.toContain('btrim');
    expect(FRESH_PUBLICATION_FENCE_ACTIVE_SQL).toContain(`jsonb_typeof(i.remote_terminal_result -> 'observedConfluenceId') = 'string'`);
  });

  it('planning never grants publication authority while rollout is closed', () => {
    expect(() => admitAutomaticIngestionPolicy({ identity: 'p', currentPolicy: 'all', candidate: 'none' }))
      .toThrow('ai_policy_enforcement_unavailable');
    expect(() => admitAutomaticIngestionPolicy({ identity: 'p', currentPolicy: 'local_only', candidate: 'none' }))
      .toThrow('ai_policy_enforcement_unavailable');
    expect(admitAutomaticIngestionPolicy({ identity: 'p', currentPolicy: 'none', candidate: 'all' })).toBe('none');
    expect(admitAutomaticIngestionPolicy({ identity: 'p', currentPolicy: 'all', candidate: 'all' })).toBe('all');
  });
});
