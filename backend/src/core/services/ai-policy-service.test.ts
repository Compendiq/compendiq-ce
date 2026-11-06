import { describe, expect, it } from 'vitest';
import {
  AiPolicyLabelConflictError, applyCanonicalAiPolicyLabel, canonicalAiPolicyLabel,
  isAiPolicyEnforcementAvailable, normalizeAiPolicyLabel, planLabelPolicyChange,
  policyFromLabels, reservedAiPolicyLabel, resolveCreationAiPolicy, stricterPolicy,
} from './ai-policy-service.js';
import { applyCanonicalAiPolicyLabel as contractLabels } from '@compendiq/contracts';
import { noopPlugin } from '../enterprise/noop.js';

describe('AI policy normalization and creation', () => {
  it('orders policies and decodes only frozen synonyms', () => {
    expect(stricterPolicy('all', 'local_only')).toBe('local_only');
    expect(stricterPolicy('none', 'local_only')).toBe('none');
    for (const label of ['no-ai', ' NO_AI ', 'ai:none']) expect(normalizeAiPolicyLabel(label)).toBe('none');
    for (const label of ['local_only', 'AI:LOCAL', 'local-ai-only']) expect(normalizeAiPolicyLabel(label)).toBe('local_only');
    for (const label of ['ai-none', 'ai-local-only', 'ai local']) expect(normalizeAiPolicyLabel(label)).toBeNull();
    expect(policyFromLabels(['all-ai', 'ai:local', 'no-ai'])).toBe('none');
    expect(policyFromLabels([])).toBe('all');
  });

  it.each(['constructor', '__proto__', 'toString'])('preserves ordinary object key %s', async (label) => {
    expect(reservedAiPolicyLabel(label)).toBeNull();
    expect(policyFromLabels([label, 'no-ai'])).toBe('none');
    expect(policyFromLabels(['no-ai', label])).toBe('none');
    await expect(resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: [label] })).resolves.toBe('all');
    expect(planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: [label] }).labels).toEqual([label, 'all-ai']);
  });

  it('CE is inert and restrictive interactive creation stays closed', async () => {
    expect(isAiPolicyEnforcementAvailable()).toBe(false);
    await expect(noopPlugin.resolveAiPolicyCreationDefault!({ userId: 'u', spaceKey: null })).resolves.toBe('all');
    await expect(resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: ['ai:none'] }))
      .rejects.toMatchObject({ statusCode: 409, body: { error: 'ai_policy_enforcement_unavailable' } });
    await expect(resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: ['local-ai-only'], explicit: 'all' }))
      .rejects.toBeInstanceOf(AiPolicyLabelConflictError);
    await expect(resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: ['all-ai', 'no-ai'], mode: 'ingestion' })).resolves.toBe('none');
  });

  it.each(['all', 'local_only', 'none'] as const)('core and contract canonical helper agree for %s', (policy) => {
    for (const labels of [[], ['ordinary'], ['ai:none', 'ordinary', 'ai:all', 'local_only']]) {
      expect(contractLabels(labels, policy)).toEqual(applyCanonicalAiPolicyLabel(labels, policy));
      expect(contractLabels(labels, policy)).toContain(canonicalAiPolicyLabel(policy));
    }
  });

  it.each(['all', 'local_only', 'none'] as const)('repairs missing and stale slots without changing %s', (policy) => {
    for (const carried of [[], ['ai:all'], ['local_only'], ['no_ai']]) {
      expect(planLabelPolicyChange({ currentPolicy: policy, currentLabels: carried, targetLabels: [...carried, 'ordinary'] }))
        .toMatchObject({ policy, kind: 'unchanged', labels: ['ordinary', canonicalAiPolicyLabel(policy)] });
      expect(planLabelPolicyChange({ currentPolicy: policy, currentLabels: carried, targetLabels: ['ordinary'] }))
        .toMatchObject({ policy, kind: 'unchanged', labels: ['ordinary', canonicalAiPolicyLabel(policy)] });
    }
  });

  it('rejects contradictions in the complete target, even if every identity was carried', () => {
    for (const currentLabels of [[], ['no-ai'], ['no-ai', 'ai:all']]) {
      expect(() => planLabelPolicyChange({ currentPolicy: 'all', currentLabels, targetLabels: ['no-ai', 'ai:all', 'ordinary'] }))
        .toThrow(AiPolicyLabelConflictError);
    }
  });

  it('removal never relaxes and an explicit nonconflicting replacement does', () => {
    expect(planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['no-ai'], targetLabels: ['ordinary'] }))
      .toMatchObject({ policy: 'none', kind: 'unchanged', labels: ['ordinary', 'no-ai'] });
    expect(planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['no-ai'], targetLabels: ['all-ai'] }))
      .toMatchObject({ policy: 'all', kind: 'relax', labels: ['all-ai'] });
    expect(planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: ['no-ai', 'ai:none', 'x'] }))
      .toMatchObject({ policy: 'none', kind: 'tighten', labels: ['x', 'no-ai'] });
    expect(() => planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: ['no-ai', 'ai:local'] }))
      .toThrow(AiPolicyLabelConflictError);
  });
});
