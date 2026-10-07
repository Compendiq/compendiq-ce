import { describe, expect, it } from 'vitest';
import {
  isAiPolicyEnforcementAvailable,
  normalizeAiPolicyLabel,
  policyFromLabels,
  resolveCreationAiPolicy,
  stricterPolicy,
} from './ai-policy-service.js';
import { noopPlugin } from '../enterprise/noop.js';

describe('ai-policy-service (pure)', () => {
  it('orders policies all < local_only < none', () => {
    expect(stricterPolicy('all', 'local_only')).toBe('local_only');
    expect(stricterPolicy('none', 'local_only')).toBe('none');
    expect(stricterPolicy('all', 'all')).toBe('all');
  });

  it('normalizes policy labels and ignores others', () => {
    expect(normalizeAiPolicyLabel(' AI_None ')).toBe('none');
    expect(normalizeAiPolicyLabel('ai:local-only')).toBe('local_only');
    expect(normalizeAiPolicyLabel('runbook')).toBeNull();
    expect(policyFromLabels(['ai-local', 'no-ai'])).toBe('none');
    expect(policyFromLabels([])).toBe('all');
  });

  it('inert CE creation-default hook returns all', async () => {
    await expect(noopPlugin.resolveAiPolicyCreationDefault!({ userId: 'u', spaceKey: null })).resolves.toBe('all');
  });

  it('foundation-only deployment cannot activate restrictive policies', () => {
    expect(isAiPolicyEnforcementAvailable()).toBe(false);
  });

  it('creation applies the stricter of hook default and labels', async () => {
    await expect(resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: ['ai-none'] })).resolves.toBe('none');
    await expect(resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: [] })).resolves.toBe('all');
  });

  it('an explicit choice never drops below the labels', async () => {
    await expect(
      resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: ['ai-local-only'], explicit: 'all' }),
    ).resolves.toBe('local_only');
  });
});
