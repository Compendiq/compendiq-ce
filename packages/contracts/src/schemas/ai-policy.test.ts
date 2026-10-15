import { describe, expect, it } from 'vitest';
import {
  AI_POLICY_CANONICAL_LABELS,
  AI_POLICY_LABEL_SYNONYMS,
  AI_POLICY_REFUSAL_CODES,
  AiPolicyConflictSchema,
  AiPolicyRefusalSchema,
  ConversationTurnAiProvenancePageSchema,
  AiPolicySchema,
  AiPolicyInputSchema,
  BulkUpdatePageAiPolicySchema,
  DeclareProviderLocalitySchema,
  PageAiPolicyResponseSchema,
  UpdatePageAiPolicySchema,
  aiPolicyLabelConflict,
  applyCanonicalAiPolicyLabel,
  normalizeAiPolicyLabel,
  normalizeAiPolicyValue,
} from './ai-policy.js';
import { UpdatePageSchema, isAiPolicyUpdatePaired } from './pages.js';

describe('ai-policy contracts', () => {
  it('accepts only the closed label set', () => {
    expect(AiPolicySchema.parse('local_only')).toBe('local_only');
    expect(AiPolicySchema.safeParse('LOCAL').success).toBe(false);
    expect(AiPolicySchema.safeParse('no_ai').success).toBe(false);
  });

  it('accepts no_ai on input only, normalised to the canonical none', () => {
    expect(AiPolicyInputSchema.parse('no_ai')).toBe('none');
    expect(normalizeAiPolicyValue(' NO_AI ')).toBe('none');
    expect(normalizeAiPolicyValue('ai_none')).toBeNull();
    expect(PageAiPolicyResponseSchema.safeParse({ pageId: 1, aiPolicy: 'no_ai', aiPolicyRevision: 0 }).success).toBe(false);
  });

  it('uses the frozen wire keys and refuses the obsolete `policy` key', () => {
    expect(UpdatePageAiPolicySchema.safeParse({ policy: 'none', expectedRevision: 3 }).success).toBe(false);
    expect(UpdatePageAiPolicySchema.safeParse({ aiPolicy: 'none' }).success).toBe(false);
    expect(UpdatePageAiPolicySchema.parse({ aiPolicy: 'no_ai', expectedRevision: 3 }))
      .toEqual({ aiPolicy: 'none', expectedRevision: 3 });
    expect(PageAiPolicyResponseSchema.parse({ pageId: 1, aiPolicy: 'all', aiPolicyRevision: 2 }))
      .toEqual({ pageId: 1, aiPolicy: 'all', aiPolicyRevision: 2 });
  });

  it('refuses duplicate pages in a bulk request', () => {
    const r = BulkUpdatePageAiPolicySchema.safeParse({
      aiPolicy: 'all',
      items: [{ pageId: 1, expectedRevision: 0 }, { pageId: 1, expectedRevision: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it('conflict bodies carry only stale_revision', () => {
    expect(AiPolicyConflictSchema.safeParse({ error: 'ai_policy_conflict', reason: 'not_authorized', pageIds: [1] }).success).toBe(false);
    expect(AiPolicyConflictSchema.safeParse({ error: 'ai_policy_conflict', reason: 'stale_revision', pageIds: [1] }).success).toBe(true);
  });

  it('matches labels by the exact frozen table only (lowercase + trim)', () => {
    expect(Object.keys(AI_POLICY_LABEL_SYNONYMS).sort()).toEqual(
      ['ai:all', 'ai:local', 'ai:none', 'all-ai', 'local-ai-only', 'local_only', 'no-ai', 'no_ai'],
    );
    expect(normalizeAiPolicyLabel(' No-AI ')).toBe('none');
    expect(normalizeAiPolicyLabel('AI:LOCAL')).toBe('local_only');
    expect(normalizeAiPolicyLabel('ai-none')).toBeNull();
    expect(normalizeAiPolicyLabel('ai local')).toBeNull();
    expect(normalizeAiPolicyLabel('ai-local-only')).toBeNull();
    // Trim is JS `String.prototype.trim()`: TAB, NBSP, BOM, ideographic space.
    // Migration 136's `ai_policy_label_key` mirrors exactly this set.
    expect(normalizeAiPolicyLabel('\tno-ai\t')).toBe('none');
    expect(normalizeAiPolicyLabel('\u00a0ai:local\u00a0')).toBe('local_only');
    expect(normalizeAiPolicyLabel('\ufeffall-ai')).toBe('all');
    expect(normalizeAiPolicyLabel('\u3000no_ai\u3000')).toBe('none');
    expect(normalizeAiPolicyLabel('\u200bno-ai')).toBeNull();
  });

  it('PUT /pages/:id uses the frozen expectedRevision key; the pairing rule is the route\'s 422, not a schema 400', () => {
    const base = { title: 't', bodyHtml: '<p/>' };
    expect(UpdatePageSchema.safeParse(base).success).toBe(true);
    // Shape-valid: the route answers 422 `ai_policy_revision_required`.
    expect(UpdatePageSchema.safeParse({ ...base, aiPolicy: 'none' }).success).toBe(true);
    expect(isAiPolicyUpdatePaired(UpdatePageSchema.parse({ ...base, aiPolicy: 'none' }))).toBe(false);
    expect(isAiPolicyUpdatePaired(UpdatePageSchema.parse({ ...base, expectedRevision: 1 }))).toBe(false);
    expect(isAiPolicyUpdatePaired(UpdatePageSchema.parse(base))).toBe(true);
    expect(isAiPolicyUpdatePaired(UpdatePageSchema.parse({ ...base, aiPolicy: 'none', expectedRevision: 1 }))).toBe(true);
    // The obsolete key is not the pair.
    expect(isAiPolicyUpdatePaired(UpdatePageSchema.parse({ ...base, aiPolicy: 'none', expectedAiPolicyRevision: 1 }))).toBe(false);
    expect(UpdatePageSchema.parse({ ...base, aiPolicy: 'no_ai', expectedRevision: 1 }))
      .toMatchObject({ aiPolicy: 'none', expectedRevision: 1 });
  });

  it('writes back exactly one canonical label', () => {
    expect(AI_POLICY_CANONICAL_LABELS).toEqual({ all: 'all-ai', local_only: 'local-ai-only', none: 'no-ai' });
    expect(applyCanonicalAiPolicyLabel(['x', 'no_ai', 'ai:none'], 'none')).toEqual(['x', 'no-ai']);
    expect(applyCanonicalAiPolicyLabel(['x', 'no-ai'], 'all')).toEqual(['x']);
    expect(aiPolicyLabelConflict(['no-ai', 'ai:local', 'x']).sort()).toEqual(['local_only', 'none']);
  });

  it('refusal codes distinguish fresh grounding from history and provider failures', () => {
    expect(AiPolicyRefusalSchema.parse({ error: 'ai_grounding_not_admissible', stage: 'chat' }))
      .toEqual({ error: 'ai_grounding_not_admissible', stage: 'chat' });
    expect([...AI_POLICY_REFUSAL_CODES].sort()).toEqual([
      'ai_grounding_not_admissible',
      'ai_history_not_replayable',
      'ai_policy_provider_locality_mismatch',
      'ai_policy_provider_revision_mismatch',
      'ai_policy_unavailable',
    ]);
    expect(AiPolicyRefusalSchema.safeParse({ error: 'ai_policy_provider_mismatch' }).success).toBe(false);
    expect(AiPolicyRefusalSchema.safeParse({ error: 'ai_policy_provider_revision_mismatch' }).success).toBe(true);
  });

  it('turn provenance pages carry the content revision the model saw', () => {
    const page = { pageId: 1, policy: 'all', policyRevision: 0 };
    expect(ConversationTurnAiProvenancePageSchema.safeParse(page).success).toBe(false);
    expect(ConversationTurnAiProvenancePageSchema.safeParse({ ...page, contentRevision: 4 }).success).toBe(true);
    expect(ConversationTurnAiProvenancePageSchema.safeParse({ ...page, contentRevision: -1 }).success).toBe(false);
  });

  it('never accepts an unknown locality', () => {
    expect(DeclareProviderLocalitySchema.safeParse({ locality: 'unknown', expectedConfigRevision: 1 }).success).toBe(false);
  });
});
