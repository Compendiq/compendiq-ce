import { describe, expect, it } from 'vitest';
import {
  canonicalAiPolicyLabel,
  isAiPolicyEnforcementAvailable,
  normalizeAiPolicyLabel,
  planLabelPolicyChange,
  policyFromLabels,
  reservedAiPolicyLabel,
  resolveCreationAiPolicy,
  stricterPolicy,
} from './ai-policy-service.js';
import { PageWriteError } from './page-write-admission.js';
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

describe('reservedAiPolicyLabel (#281 label writers)', () => {
  it('recognises the ingestion spellings plus the explicit relaxation label', () => {
    expect(reservedAiPolicyLabel('no-ai')).toBe('none');
    expect(reservedAiPolicyLabel('AI_None')).toBe('none');
    expect(reservedAiPolicyLabel('ai-local')).toBe('local_only');
    expect(reservedAiPolicyLabel('all-ai')).toBe('all');
    expect(reservedAiPolicyLabel('AI:ALL')).toBe('all');
    expect(reservedAiPolicyLabel('release-notes')).toBeNull();
  });

  it('ingestion normalization never reads `all-ai` as a policy (it only tightens)', () => {
    expect(policyFromLabels(['all-ai', 'no-ai'])).toBe('none');
    expect(policyFromLabels(['all-ai'])).toBe('all');
  });

  it('canonical labels round-trip through the reserved parser', () => {
    for (const policy of ['all', 'local_only', 'none'] as const) {
      expect(reservedAiPolicyLabel(canonicalAiPolicyLabel(policy))).toBe(policy);
    }
  });
});

describe('planLabelPolicyChange (#281)', () => {
  it('a newly added restrictive label tightens and is stored canonically', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: ['a'], targetLabels: ['a', 'AI_None'] });
    expect(plan).toEqual({ labels: ['a', 'no-ai'], policy: 'none', kind: 'tighten', restoredLabel: null });
  });

  it('two different reserved policies in one target set are a 422', () => {
    expect(() => planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: ['no-ai', 'ai-local-only'] }))
      .toThrowError(PageWriteError);
    try {
      planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['no-ai'], targetLabels: ['no-ai', 'all-ai'] });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 422, reason: 'ai_policy_label_conflict' });
    }
  });

  it('synonyms of the same policy collapse without conflict', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: ['no-ai', 'ai-none', 'x'] });
    expect(plan.labels).toEqual(['no-ai', 'x']);
    expect(plan.policy).toBe('none');
  });

  it('a carried-over reserved label is inert: it does not re-tighten a relaxed page', () => {
    // The policy was explicitly relaxed to `all` while the label stayed behind.
    const plan = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: ['no-ai'], targetLabels: ['no-ai', 'x'] });
    expect(plan).toEqual({ labels: ['no-ai', 'x'], policy: 'all', kind: 'unchanged', restoredLabel: null });
  });

  it('a carried-over label keeps its spelling and the policy unchanged', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['ai-none', 'a'], targetLabels: ['ai-none', 'a', 'b'] });
    expect(plan).toEqual({ labels: ['ai-none', 'a', 'b'], policy: 'none', kind: 'unchanged', restoredLabel: null });
  });

  it('dropping the label that names the current restrictive policy restores it, no policy move', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'local_only', currentLabels: ['ai-local', 'a'], targetLabels: ['a'] });
    expect(plan).toEqual({ labels: ['a', 'ai-local-only'], policy: 'local_only', kind: 'unchanged', restoredLabel: 'ai-local-only' });
  });

  it('dropping a label when the policy was set without one leaves nothing to restore', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['a'], targetLabels: [] });
    expect(plan).toEqual({ labels: [], policy: 'none', kind: 'unchanged', restoredLabel: null });
  });

  it('a newly added looser label is an explicit relaxation', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['no-ai'], targetLabels: ['all-ai'] });
    expect(plan).toEqual({ labels: ['all-ai'], policy: 'all', kind: 'relax', restoredLabel: null });
    const partial = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['no-ai'], targetLabels: ['ai-local-only'] });
    expect(partial).toMatchObject({ labels: ['ai-local-only'], policy: 'local_only', kind: 'relax' });
  });

  it('a newly added label naming the current policy is a no-op stored canonically', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: [], targetLabels: ['ai-none'] });
    expect(plan).toEqual({ labels: ['no-ai'], policy: 'none', kind: 'unchanged', restoredLabel: null });
  });

  it('dropping the current-policy label while carrying a looser one restores the current one', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['no-ai', 'ai-local-only'], targetLabels: ['ai-local-only'] });
    expect(plan).toEqual({ labels: ['no-ai'], policy: 'none', kind: 'unchanged', restoredLabel: 'no-ai' });
  });

  it('carried-over contradictory labels never block an ordinary tag (only NEW policies may contradict)', () => {
    // The row was relaxed to `all` by the policy endpoint; both reserved
    // labels stayed behind. Adding an ordinary tag must not be a 422.
    const plan = planLabelPolicyChange({
      currentPolicy: 'all', currentLabels: ['no-ai', 'ai-local-only'], targetLabels: ['no-ai', 'ai-local-only', 'x'],
    });
    expect(plan).toEqual({ labels: ['no-ai', 'x'], policy: 'all', kind: 'unchanged', restoredLabel: null });

    // Current policy `none` with both labels carried: the one naming the
    // current policy keeps its spelling and wins the single slot.
    const kept = planLabelPolicyChange({
      currentPolicy: 'none', currentLabels: ['ai-local-only', 'AI_None'], targetLabels: ['ai-local-only', 'AI_None', 'y'],
    });
    expect(kept).toEqual({ labels: ['AI_None', 'y'], policy: 'none', kind: 'unchanged', restoredLabel: null });

    // A NEW policy next to a carried one is still contradictory.
    expect(() => planLabelPolicyChange({
      currentPolicy: 'all', currentLabels: ['no-ai'], targetLabels: ['no-ai', 'ai-local-only'],
    })).toThrowError(PageWriteError);
  });

  it('deduplicates ordinary labels and keeps order', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: ['b', 'a', 'b'] });
    expect(plan.labels).toEqual(['b', 'a']);
  });
});
