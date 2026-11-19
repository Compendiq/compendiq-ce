import { describe, expect, it } from 'vitest';
import {
  AI_POLICY_CANONICAL_LABELS,
  AI_POLICY_LABEL_SYNONYMS,
  AI_POLICY_REFUSAL_CODES,
  AiPolicyConflictSchema,
  AiPolicyFilterSchema,
  AiPolicyRefusalSchema,
  PageAiPolicyWorkerFieldsSchema,
  deriveAiPolicyWorkerFields,
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
import { PageListQuerySchema, SearchHybridQuerySchema, UpdatePageSchema, isAiPolicyUpdatePaired } from './pages.js';

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
    expect(applyCanonicalAiPolicyLabel(['x', 'no-ai'], 'all')).toEqual(['x', 'all-ai']);
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

  it.each(['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf'])('treats inherited key %s as ordinary input', (label) => {
    expect(normalizeAiPolicyValue(label)).toBeNull();
    expect(normalizeAiPolicyLabel(label)).toBeNull();
    expect(aiPolicyLabelConflict([label])).toEqual([]);
    expect(applyCanonicalAiPolicyLabel([label], 'none')).toEqual([label, 'no-ai']);
  });

  it('never accepts an unknown locality', () => {
    expect(DeclareProviderLocalitySchema.safeParse({ locality: 'unknown', expectedConfigRevision: 1 }).success).toBe(false);
  });

  it('the Library filter accepts only stored policies — "all articles" is absence, not a value (#283)', () => {
    expect(AiPolicyFilterSchema.safeParse('all').success).toBe(true);
    expect(AiPolicyFilterSchema.safeParse('local_only').success).toBe(true);
    expect(AiPolicyFilterSchema.safeParse('none').success).toBe(true);
    expect(AiPolicyFilterSchema.safeParse('any').success).toBe(false);
    expect(AiPolicyFilterSchema.safeParse('').success).toBe(false);
    expect(AiPolicyFilterSchema.safeParse('no_ai').success).toBe(false);
    expect(PageListQuerySchema.parse({}).aiPolicy).toBeUndefined();
    expect(PageListQuerySchema.parse({ aiPolicy: 'none' }).aiPolicy).toBe('none');
    expect(PageListQuerySchema.safeParse({ aiPolicy: 'any' }).success).toBe(false);
    expect(SearchHybridQuerySchema.parse({ q: 'x' }).aiPolicy).toBeUndefined();
    expect(SearchHybridQuerySchema.parse({ q: 'x', aiPolicy: 'local_only' }).aiPolicy).toBe('local_only');
    expect(SearchHybridQuerySchema.safeParse({ q: 'x', aiPolicy: 'all articles' }).success).toBe(false);
  });

  it('derives blocked stages and the recovering verdict from the persisted statuses (#281/#283)', () => {
    // Blocked: the reason stands beside the stages that are refused now.
    expect(deriveAiPolicyWorkerFields({
      embeddingStatus: 'policy_blocked', summaryStatus: 'policy_blocked', qualityStatus: 'analyzed', blockReason: 'provider_not_local',
    })).toEqual({ aiPolicyBlockReason: 'provider_not_local', aiPolicyBlockedStages: ['embedding', 'summary'], aiPolicyRecovering: false });
    // Recovering: the reason is still recorded, nothing is blocked now, and work is queued again.
    expect(deriveAiPolicyWorkerFields({
      embeddingStatus: 'not_embedded', summaryStatus: 'pending', qualityStatus: 'pending', blockReason: 'policy_changed',
    })).toEqual({ aiPolicyBlockReason: 'policy_changed', aiPolicyBlockedStages: [], aiPolicyRecovering: true });
    // Completed after recovery: nothing queued, so not recovering — and not a false "blocked" either.
    expect(deriveAiPolicyWorkerFields({
      embeddingStatus: 'embedded', summaryStatus: 'summarized', qualityStatus: 'analyzed', blockReason: 'policy_changed',
    })).toEqual({ aiPolicyBlockReason: 'policy_changed', aiPolicyBlockedStages: [], aiPolicyRecovering: false });
    // Ordinary queued work with no reason ever recorded is pending, not recovering.
    expect(deriveAiPolicyWorkerFields({
      embeddingStatus: 'not_embedded', summaryStatus: 'pending', qualityStatus: null, blockReason: null,
    })).toEqual({ aiPolicyBlockReason: null, aiPolicyBlockedStages: [], aiPolicyRecovering: false });
    // A reason this build does not know is unknown, never invented.
    expect(deriveAiPolicyWorkerFields({
      embeddingStatus: 'policy_blocked', summaryStatus: null, qualityStatus: null, blockReason: 'future_reason',
    })).toEqual({ aiPolicyBlockReason: null, aiPolicyBlockedStages: ['embedding'], aiPolicyRecovering: false });
    expect(PageAiPolicyWorkerFieldsSchema.safeParse({ aiPolicyBlockedStages: ['vision'] }).success).toBe(false);
  });
});

describe('#1739 existing bulk AI-policy page-ID consumer', () => {
  const accepted = [
    { name: 'one-number', input: 1, value: 1 },
    { name: 'max-number', input: 2_147_483_647, value: 2_147_483_647 },
    { name: 'one-string', input: '1', value: 1 },
    { name: 'max-string', input: '2147483647', value: 2_147_483_647 },
    { name: 'padded-one', input: '0001', value: 1 },
    { name: 'padded-max', input: '0002147483647', value: 2_147_483_647 },
    { name: 'long-padded-one', input: `${'0'.repeat(256)}1`, value: 1 },
    { name: 'long-padded-max', input: `${'0'.repeat(256)}2147483647`, value: 2_147_483_647 },
  ];
  const rejected: Array<{ name: string; input: unknown; red?: boolean }> = [
    { name: 'zero-number', input: 0 },
    { name: 'zero-string', input: '0' },
    { name: 'negative-number', input: -1 },
    { name: 'negative-string', input: '-1' },
    { name: 'overbound-number', input: 2_147_483_648, red: true },
    { name: 'overbound-string', input: '2147483648', red: true },
    { name: 'unsafe-number', input: 9_007_199_254_740_992 },
    { name: 'unsafe-string', input: '9007199254740993' },
    { name: 'fraction-number', input: 1.5 },
    { name: 'nan', input: NaN },
    { name: 'positive-infinity', input: Infinity },
    { name: 'negative-infinity', input: -Infinity },
    { name: 'rounded-fraction-string', input: '2147483647.00000001', red: true },
    { name: 'decimal-string', input: '1.0', red: true },
    { name: 'exponent-string', input: '1e3', red: true },
    { name: 'hex-string', input: '0x10', red: true },
    { name: 'plus-sign', input: '+1', red: true },
    { name: 'surrounding-space', input: ' 1 ', red: true },
    { name: 'trailing-newline', input: '1\n', red: true },
    { name: 'alphabetic', input: 'abc' },
    { name: 'empty', input: '' },
    { name: 'unicode-digit', input: '١' },
    { name: 'true', input: true, red: true },
    { name: 'false', input: false },
    { name: 'null', input: null },
    { name: 'object', input: {} },
    { name: 'empty-array', input: [] },
    { name: 'singleton-array', input: [1], red: true },
    { name: 'undefined', input: undefined },
    { name: 'overbound-decimal', input: '2147483648.0', red: true },
    { name: 'negative-zero-string', input: '-0' },
    { name: 'leading-tab', input: '\t1', red: true },
    { name: 'padded-zero', input: '000' },
    { name: 'infinity-string', input: 'Infinity' },
  ];
  for (const entry of accepted) {
    it(`#1739 CONTROL bulk-policy ${entry.name} keeps numeric output and revision`, () => {
      const parsed = BulkUpdatePageAiPolicySchema.safeParse({
        aiPolicy: 'all', items: [{ pageId: entry.input, expectedRevision: 0 }],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toEqual({
          aiPolicy: 'all', items: [{ pageId: entry.value, expectedRevision: 0 }],
        });
      }
    });
  }
  for (const entry of rejected) {
    it(`#1739 ${entry.red ? 'RED' : 'CONTROL'} bulk-policy rejects ${entry.name}`, () => {
      expect(BulkUpdatePageAiPolicySchema.safeParse({
        aiPolicy: 'all', items: [{ pageId: entry.input, expectedRevision: 0 }],
      }).success).toBe(false);
    });
  }
  for (const invalid of [2_147_483_648, '2147483648']) {
    it(`#1739 RED bulk-policy rejects the entire mixed list (${typeof invalid})`, () => {
      expect(BulkUpdatePageAiPolicySchema.safeParse({
        aiPolicy: 'all',
        items: [{ pageId: 1, expectedRevision: 0 }, { pageId: invalid, expectedRevision: 0 }],
      }).success).toBe(false);
    });
  }
});
