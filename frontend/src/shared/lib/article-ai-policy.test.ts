import { describe, it, expect } from 'vitest';
import {
  inlineArticlePolicy,
  canShowPolicySelector,
  requiresConfirmation,
  selectorReducer,
  isEditorAiAllowed,
  editorAiUnavailableReason,
  reconcileGhostText,
  handleChatRefusal,
  initialLocalityDeclaration,
  declareLocality,
  needsLocalityConfirmation,
  onEndpointChange,
  localityToSubmit,
  workerStatusTone,
  pagesQueryKey,
  pagesSearchParams,
  AI_POLICY_CHIP_LABEL,
  AI_POLICY_EXPLANATION,
  LOCALITY_CHIP_LABEL,
  LOCALITY_HELP_TEXT,
  NO_AI_CONFIRMATION,
  BLOCK_REASON_LABEL,
  bulkPolicyFailureMessage,
} from './article-ai-policy';
import { resolvePageState } from '../components/badges/page-state';

describe('article AI policy UI logic', () => {
  it('decodes live inline policy without granting permission for missing detail', () => {
    expect(inlineArticlePolicy({ aiPolicy: 'local_only', aiPolicyRevision: 4 })).toEqual({
      articlePolicy: 'local_only', articlePolicyRevision: 4,
    });
    expect(inlineArticlePolicy(undefined)).toEqual({});
    expect(inlineArticlePolicy({ aiPolicy: 'unknown', aiPolicyRevision: 4 })).toEqual({});
    expect(inlineArticlePolicy({})).toEqual({ articlePolicy: undefined, articlePolicyRevision: undefined });
  });
  it('shows selector only with the active server page-detail capability and revision', () => {
    const detail = {
      canChangeAiPolicy: true, aiPolicyActivation: 'active',
      aiPolicy: 'all', aiPolicyRevision: 0,
    };
    expect(canShowPolicySelector(detail)).toBe(true);
    for (const unavailable of [
      undefined, null, {}, [], ['page.ai_policy.update'],
      { ...detail, canChangeAiPolicy: false },
      { ...detail, canChangeAiPolicy: undefined },
      { ...detail, aiPolicyActivation: 'foundation_only' },
      { ...detail, aiPolicyActivation: undefined },
      { ...detail, aiPolicy: undefined },
      { ...detail, aiPolicy: 'unsupported' },
      { ...detail, aiPolicyRevision: undefined },
      { ...detail, aiPolicyRevision: -1 },
    ]) expect(canShowPolicySelector(unavailable)).toBe(false);
  });

  it('requires confirmation only when moving to none', () => {
    expect(requiresConfirmation('all', 'none')).toBe(true);
    expect(requiresConfirmation('none', 'none')).toBe(false);
    expect(requiresConfirmation('none', 'all')).toBe(false);
  });

  it('no_ai confirmation names real removals and limits without global-erasure claims', () => {
    const text = [
      ...NO_AI_CONFIRMATION.removes, ...NO_AI_CONFIRMATION.remains, ...NO_AI_CONFIRMATION.limits,
    ].join(' ');
    expect(text).toMatch(/vectors/);
    expect(text).toMatch(/image analyses/);
    expect(text).toMatch(/summaries/);
    expect(text).toMatch(/quality/);
    expect(text).toMatch(/authored content/);
    expect(text).toMatch(/original attachments/);
    expect(text).toMatch(/not erased/);
    expect(text).toMatch(/cannot be recalled/);
    expect(text).not.toMatch(/all data|everywhere|instantly cancel/i);
  });

  it('keeps the draft on 409 and never updates saved optimistically', () => {
    let s = { saved: 'all' as const, draft: 'all' as const, revision: 3, conflict: false, pending: false };
    let next = selectorReducer(s, { type: 'choose', policy: 'none' });
    next = selectorReducer(next, { type: 'submit' });
    expect(next.saved).toBe('all');
    next = selectorReducer(next, { type: 'conflict' });
    expect(next.draft).toBe('none');
    expect(next.saved).toBe('all');
    expect(next.conflict).toBe(true);
    next = selectorReducer(next, { type: 'success', policy: 'none', revision: 4 });
    expect(next.saved).toBe('none');
    s = { ...s };
    expect(s.saved).toBe('all');
  });

  it('reload after a conflict adopts the server revision, keeps the draft and clears the conflict', () => {
    let s = { saved: 'all' as const, draft: 'none' as const, revision: 3, conflict: true, pending: false };
    s = selectorReducer(s, { type: 'reload', policy: 'local_only', revision: 5 });
    expect(s.saved).toBe('local_only');
    expect(s.revision).toBe(5);
    expect(s.draft).toBe('none');
    expect(s.conflict).toBe(false);
  });

  it('gates every editor trigger and fails closed', () => {
    for (const t of ['mouse', 'keyboard', 'programmatic'] as const) {
      expect(isEditorAiAllowed('none', t)).toBe(false);
      expect(isEditorAiAllowed(undefined, t)).toBe(false);
      expect(isEditorAiAllowed('all', t)).toBe(true);
    }
    expect(editorAiUnavailableReason('none')).toMatch(/no ai allowed/i);
    expect(editorAiUnavailableReason(undefined)).toMatch(/could not be read/i);
    expect(editorAiUnavailableReason('all')).toBeNull();
  });

  it('clears ghost text on invalidation', () => {
    const g = { text: 'x', policy: 'all' as const, revision: 1 };
    expect(reconcileGhostText(g, { policy: 'all', revision: 1 })).toBe(g);
    expect(reconcileGhostText(g, { policy: 'all', revision: 2 })).toBeNull();
    expect(reconcileGhostText(g, { policy: 'none', revision: 1 })).toBeNull();
    expect(reconcileGhostText(g, { policy: 'local_only', revision: 1 })).toBeNull();
  });

  it('history refusal keeps draft and offers New chat; unavailable policy offers retry only', () => {
    const r = handleChatRefusal('my draft', 'ai_history_not_replayable');
    expect(r.draft).toBe('my draft');
    expect(r.offerNewChat).toBe(true);
    expect(r.offerRetry).toBe(false);
    expect(r.message).toMatch(/nothing was sent/i);
    const u = handleChatRefusal('d', 'ai_policy_unavailable');
    expect(u.draft).toBe('d');
    expect(u.offerNewChat).toBe(false);
    expect(u.offerRetry).toBe(true);
    expect(u.message).toMatch(/nothing was sent/i);
    expect(u.message).not.toMatch(/safe/i);
    expect(handleChatRefusal('d', undefined)).toEqual({ draft: 'd', offerNewChat: false, offerRetry: false, message: null });
  });

  it('never auto-selects locality and endpoint change requires reconfirmation', () => {
    const init = initialLocalityDeclaration();
    expect(init.locality).toBeNull();
    expect(needsLocalityConfirmation(init, 'http://a')).toBe(true);
    expect(localityToSubmit(init, 'http://a')).toBe('external');
    const d = declareLocality(init, 'local', 'http://a');
    expect(needsLocalityConfirmation(d, 'http://a')).toBe(false);
    expect(localityToSubmit(d, 'http://a')).toBe('local');
    const changed = onEndpointChange(d, 'http://b');
    expect(changed.locality).toBeNull();
    expect(needsLocalityConfirmation(changed, 'http://b')).toBe(true);
    expect(localityToSubmit(changed, 'http://b')).toBe('external');
    // A stale declaration for the old endpoint never submits local for the new one.
    expect(localityToSubmit(d, 'http://b')).toBe('external');
    // A name-only edit does not clear the declaration.
    expect(onEndpointChange(d, 'http://a')).toBe(d);
  });

  it('locality help states declaration semantics and no residency verification', () => {
    expect(LOCALITY_HELP_TEXT).toMatch(/administrator declaration/);
    expect(LOCALITY_HELP_TEXT).toMatch(/does not independently verify residency/);
    expect(LOCALITY_HELP_TEXT).toMatch(/Local AI only/);
  });

  it('renders policy_blocked and recovering distinctly', () => {
    const tones = ['completed', 'failed', 'policy_blocked', 'recovering'].map(workerStatusTone);
    expect(new Set(tones).size).toBe(4);
    expect(Object.values(BLOCK_REASON_LABEL).join(' ')).not.toMatch(/failed|error/i);
  });

  it('library filter uses aiPolicy API param and query key', () => {
    expect(pagesSearchParams('any')).toEqual({});
    expect(pagesSearchParams('none')).toEqual({ aiPolicy: 'none' });
    expect(pagesQueryKey({ page: 1 }, 'local_only')).toEqual(['pages', { page: 1, aiPolicy: 'local_only' }]);
    expect(pagesQueryKey({ page: 1 }, 'any')).toEqual(['pages', { page: 1 }]);
  });

  it('All articles removes an existing policy from the key without changing other filters', () => {
    const base = Object.freeze({ page: 2, search: 'readable text', aiPolicy: 'none' });
    expect(pagesQueryKey(base, 'any')).toEqual(['pages', { page: 2, search: 'readable text' }]);
    expect(pagesQueryKey(base, 'all')).toEqual(['pages', { page: 2, search: 'readable text', aiPolicy: 'all' }]);
    expect(pagesQueryKey(base, 'local_only')).toEqual(['pages', { page: 2, search: 'readable text', aiPolicy: 'local_only' }]);
    expect(base.aiPolicy).toBe('none');
  });

  it('labels make no verified or protection claims', () => {
    const all = [
      ...Object.values(AI_POLICY_CHIP_LABEL),
      ...Object.values(AI_POLICY_EXPLANATION),
      ...Object.values(LOCALITY_CHIP_LABEL),
    ].join(' ');
    expect(all).not.toMatch(/verified|secure|protected|guarantee/i);
  });

  it('bulk policy failure copy says nothing changed and names counts, never titles (#283)', () => {
    const denied = bulkPolicyFailureMessage({ kind: 'denied', pageIds: [4, 9] }, 5);
    expect(denied).toMatch(/^No policy was changed\./);
    expect(denied).toContain('2 of the 5 selected pages');
    expect(denied).not.toMatch(/\b4\b|\b9\b/);
    expect(bulkPolicyFailureMessage({ kind: 'conflict', pageIds: [1] }, 1)).toContain('1 of the 1 selected page changed');
    expect(bulkPolicyFailureMessage(null, 3)).toMatch(/^No policy was changed\./);
    for (const kind of ['label_conflict', 'enforcement_unavailable', 'unavailable'] as const) {
      const message = bulkPolicyFailureMessage(kind === 'label_conflict' ? { kind, policies: ['none'] } : { kind }, 2);
      expect(message).toMatch(/^No policy was changed\./);
      expect(message).not.toMatch(/applied|succeeded|partially/i);
    }
  });
});

describe('Library page-state ladder with worker policy fields (#281/#283)', () => {
  it('a policy-blocked stage outranks everything and carries the server reason', () => {
    const state = resolvePageState({
      embeddingStatus: 'policy_blocked', embeddingDirty: true, summaryStatus: 'failed', qualityStatus: 'failed',
      aiPolicyBlockReason: 'provider_not_local',
    });
    expect(state).toMatchObject({ tone: 'policy', label: 'Indexing: policy blocked' });
    expect(state!.title).toContain(BLOCK_REASON_LABEL.provider_not_local);
    expect(state!.title).toContain('keyword search remain available');
  });
  it('a blocked stage without a server reason never invents one', () => {
    const state = resolvePageState({ summaryStatus: 'policy_blocked', qualityStatus: 'policy_blocked' });
    expect(state).toMatchObject({ tone: 'policy', label: 'Summary & Quality: policy blocked' });
    expect(state!.title).toContain('article AI policy or provider locality');
    for (const reason of Object.values(BLOCK_REASON_LABEL)) expect(state!.title).not.toContain(reason);
  });
  it('recovering is its own tone, distinct from pending, success and failure', () => {
    const recovering = resolvePageState({ embeddingDirty: true, summaryStatus: 'pending', aiPolicyRecovering: true });
    expect(recovering).toMatchObject({ tone: 'recovering', label: 'AI work recovering' });
    expect(recovering!.title).toContain('not completed');
    const pending = resolvePageState({ embeddingDirty: true, summaryStatus: 'pending', aiPolicyRecovering: false });
    expect(pending).toMatchObject({ tone: 'working', label: 'AI work pending' });
    expect(resolvePageState({ summaryStatus: 'summarized', qualityStatus: 'analyzed', aiPolicyRecovering: false })).toBeNull();
    expect(resolvePageState({ summaryStatus: 'failed' })).toMatchObject({ tone: 'failed' });
  });
});
