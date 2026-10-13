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

  it('normalizes policy labels by the frozen table only (lowercase + trim, no regex)', () => {
    expect(normalizeAiPolicyLabel(' NO_AI ')).toBe('none');
    expect(normalizeAiPolicyLabel('ai:none')).toBe('none');
    expect(normalizeAiPolicyLabel('AI:LOCAL')).toBe('local_only');
    expect(normalizeAiPolicyLabel('local_only')).toBe('local_only');
    expect(normalizeAiPolicyLabel('Local-AI-Only')).toBe('local_only');
    expect(normalizeAiPolicyLabel('runbook')).toBeNull();
    // Pre-freeze fuzzy spellings are NOT recognised.
    expect(normalizeAiPolicyLabel('ai-none')).toBeNull();
    expect(normalizeAiPolicyLabel('ai-local-only')).toBeNull();
    expect(normalizeAiPolicyLabel('ai local')).toBeNull();
    expect(policyFromLabels(['ai:local', 'no-ai'])).toBe('none');
    expect(policyFromLabels([])).toBe('all');
  });

  it('inert CE creation-default hook returns all', async () => {
    await expect(noopPlugin.resolveAiPolicyCreationDefault!({ userId: 'u', spaceKey: null })).resolves.toBe('all');
  });

  it('foundation-only deployment cannot activate restrictive policies', () => {
    expect(isAiPolicyEnforcementAvailable()).toBe(false);
  });

  it('creation applies the stricter of hook default and labels', async () => {
    await expect(resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: ['ai:none'] })).resolves.toBe('none');
    await expect(resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: [] })).resolves.toBe('all');
  });

  it('an explicit choice never drops below the labels', async () => {
    await expect(
      resolveCreationAiPolicy({ userId: 'u', spaceKey: null, labels: ['local-ai-only'], explicit: 'all' }),
    ).resolves.toBe('local_only');
  });
});

describe('reservedAiPolicyLabel (#281 label writers)', () => {
  it('recognises the ingestion spellings plus the explicit relaxation label', () => {
    expect(reservedAiPolicyLabel('no-ai')).toBe('none');
    expect(reservedAiPolicyLabel('NO_AI')).toBe('none');
    expect(reservedAiPolicyLabel('ai:local')).toBe('local_only');
    expect(reservedAiPolicyLabel('all-ai')).toBe('all');
    expect(reservedAiPolicyLabel('AI:ALL')).toBe('all');
    expect(reservedAiPolicyLabel('release-notes')).toBeNull();
  });

  it('ingestion normalization never reads `all-ai` as a policy (it only tightens)', () => {
    expect(policyFromLabels(['all-ai', 'no-ai'])).toBe('none');
    expect(policyFromLabels(['all-ai'])).toBe('all');
  });

  it('canonical labels round-trip through the reserved parser', () => {
    expect(canonicalAiPolicyLabel('all')).toBe('all-ai');
    expect(canonicalAiPolicyLabel('local_only')).toBe('local-ai-only');
    expect(canonicalAiPolicyLabel('none')).toBe('no-ai');
    for (const policy of ['all', 'local_only', 'none'] as const) {
      expect(reservedAiPolicyLabel(canonicalAiPolicyLabel(policy))).toBe(policy);
    }
  });
});

describe('planLabelPolicyChange (#281)', () => {
  it('a newly added restrictive label tightens and is stored canonically', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: ['a'], targetLabels: ['a', 'NO_AI'] });
    expect(plan).toEqual({ labels: ['a', 'no-ai'], policy: 'none', kind: 'tighten', restoredLabel: null });
  });

  it('two different reserved policies in one target set are a 422', () => {
    expect(() => planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: ['no-ai', 'local-ai-only'] }))
      .toThrowError(PageWriteError);
    try {
      planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['x'], targetLabels: ['x', 'no-ai', 'all-ai'] });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 422, reason: 'ai_policy_label_conflict' });
    }
  });

  it('synonyms of the same policy collapse without conflict', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: ['no-ai', 'ai:none', 'x'] });
    expect(plan.labels).toEqual(['no-ai', 'x']);
    expect(plan.policy).toBe('none');
  });

  it('a carried-over reserved label is inert: it does not re-tighten a relaxed page', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: ['no-ai'], targetLabels: ['no-ai', 'x'] });
    expect(plan).toEqual({ labels: ['no-ai', 'x'], policy: 'all', kind: 'unchanged', restoredLabel: null });
  });

  it('a carried-over label keeps its spelling and the policy unchanged', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['ai:none', 'a'], targetLabels: ['ai:none', 'a', 'b'] });
    expect(plan).toEqual({ labels: ['ai:none', 'a', 'b'], policy: 'none', kind: 'unchanged', restoredLabel: null });
  });

  it('dropping the label that names the current restrictive policy restores it, no policy move', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'local_only', currentLabels: ['ai:local', 'a'], targetLabels: ['a'] });
    expect(plan).toEqual({ labels: ['a', 'local-ai-only'], policy: 'local_only', kind: 'unchanged', restoredLabel: 'local-ai-only' });
  });

  it('dropping a label when the policy was set without one leaves nothing to restore', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['a'], targetLabels: [] });
    expect(plan).toEqual({ labels: [], policy: 'none', kind: 'unchanged', restoredLabel: null });
  });

  it('a newly added looser label is an explicit relaxation', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['no-ai'], targetLabels: ['all-ai'] });
    expect(plan).toEqual({ labels: ['all-ai'], policy: 'all', kind: 'relax', restoredLabel: null });
    const partial = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['no-ai'], targetLabels: ['local-ai-only'] });
    expect(partial).toMatchObject({ labels: ['local-ai-only'], policy: 'local_only', kind: 'relax' });
  });

  it('a newly added label naming the current policy is a no-op stored canonically', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: [], targetLabels: ['ai:none'] });
    expect(plan).toEqual({ labels: ['no-ai'], policy: 'none', kind: 'unchanged', restoredLabel: null });
  });

  it('dropping the current-policy label while carrying a looser one restores the current one', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'none', currentLabels: ['no-ai', 'local-ai-only'], targetLabels: ['local-ai-only'] });
    expect(plan).toEqual({ labels: ['no-ai'], policy: 'none', kind: 'unchanged', restoredLabel: 'no-ai' });
  });

  it('carried-over contradictory labels never block an ordinary tag (only NEW policies may contradict)', () => {
    const plan = planLabelPolicyChange({
      currentPolicy: 'all', currentLabels: ['no-ai', 'local-ai-only'], targetLabels: ['no-ai', 'local-ai-only', 'x'],
    });
    expect(plan).toEqual({ labels: ['no-ai', 'x'], policy: 'all', kind: 'unchanged', restoredLabel: null });

    const kept = planLabelPolicyChange({
      currentPolicy: 'none', currentLabels: ['local-ai-only', 'NO_AI'], targetLabels: ['local-ai-only', 'NO_AI', 'y'],
    });
    expect(kept).toEqual({ labels: ['NO_AI', 'y'], policy: 'none', kind: 'unchanged', restoredLabel: null });

    expect(planLabelPolicyChange({
      currentPolicy: 'all', currentLabels: ['no-ai'], targetLabels: ['no-ai', 'local-ai-only', 'ordinary'],
    })).toEqual({ labels: ['local-ai-only', 'ordinary'], policy: 'local_only', kind: 'tighten', restoredLabel: null });
    expect(planLabelPolicyChange({
      currentPolicy: 'local_only', currentLabels: ['local-ai-only'], targetLabels: ['local-ai-only', 'no-ai'],
    })).toEqual({ labels: ['no-ai'], policy: 'none', kind: 'tighten', restoredLabel: null });
    expect(planLabelPolicyChange({
      currentPolicy: 'none', currentLabels: ['no-ai'], targetLabels: ['no-ai', 'all-ai'],
    })).toMatchObject({ labels: ['all-ai'], policy: 'all', kind: 'relax' });
    expect(() => planLabelPolicyChange({
      currentPolicy: 'all', currentLabels: ['x'], targetLabels: ['x', 'no-ai', 'local-ai-only'],
    })).toThrowError(PageWriteError);
  });

  it('deduplicates ordinary labels and keeps order', () => {
    const plan = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: ['b', 'a', 'b'] });
    expect(plan.labels).toEqual(['b', 'a']);
  });
});
