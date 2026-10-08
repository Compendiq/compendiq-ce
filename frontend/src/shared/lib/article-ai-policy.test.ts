import { describe, it, expect } from 'vitest';
import {
  canShowPolicySelector,
  requiresConfirmation,
  selectorReducer,
  isEditorAiAllowed,
  reconcileGhostText,
  handleChatRefusal,
  initialLocalityDeclaration,
  declareLocality,
  needsLocalityConfirmation,
  onEndpointChange,
  workerStatusTone,
  pagesQueryKey,
  pagesSearchParams,
  AI_POLICY_CHIP_LABEL,
  LOCALITY_CHIP_LABEL,
} from './article-ai-policy';

describe('article AI policy UI logic', () => {
  it('shows selector only with server mutation capability', () => {
    expect(canShowPolicySelector(undefined)).toBe(false);
    expect(canShowPolicySelector([])).toBe(false);
    expect(canShowPolicySelector(['page.ai_policy.update'])).toBe(true);
  });

  it('requires confirmation only when moving to none', () => {
    expect(requiresConfirmation('all', 'none')).toBe(true);
    expect(requiresConfirmation('none', 'none')).toBe(false);
    expect(requiresConfirmation('none', 'all')).toBe(false);
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

  it('gates every editor trigger and fails closed', () => {
    for (const t of ['mouse', 'keyboard', 'programmatic'] as const) {
      expect(isEditorAiAllowed('none', t)).toBe(false);
      expect(isEditorAiAllowed(undefined, t)).toBe(false);
      expect(isEditorAiAllowed('all', t)).toBe(true);
    }
  });

  it('clears ghost text on invalidation', () => {
    const g = { text: 'x', policy: 'all' as const, revision: 1 };
    expect(reconcileGhostText(g, { policy: 'all', revision: 1 })).toBe(g);
    expect(reconcileGhostText(g, { policy: 'all', revision: 2 })).toBeNull();
    expect(reconcileGhostText(g, { policy: 'none', revision: 1 })).toBeNull();
    expect(reconcileGhostText(g, { policy: 'local_only', revision: 1 })).toBeNull();
  });

  it('history refusal keeps draft and offers New chat', () => {
    const r = handleChatRefusal('my draft', 'ai_history_not_replayable');
    expect(r.draft).toBe('my draft');
    expect(r.offerNewChat).toBe(true);
    expect(handleChatRefusal('d', 'ai_policy_unavailable').offerNewChat).toBe(false);
  });

  it('never auto-selects locality and endpoint change requires reconfirmation', () => {
    const init = initialLocalityDeclaration();
    expect(init.locality).toBeNull();
    expect(needsLocalityConfirmation(init, 'http://a')).toBe(true);
    const d = declareLocality(init, 'local', 'http://a');
    expect(needsLocalityConfirmation(d, 'http://a')).toBe(false);
    const changed = onEndpointChange(d, 'http://b');
    expect(changed.locality).toBeNull();
    expect(needsLocalityConfirmation(changed, 'http://b')).toBe(true);
  });

  it('renders policy_blocked and recovering distinctly', () => {
    const tones = ['completed', 'failed', 'policy_blocked', 'recovering'].map(workerStatusTone);
    expect(new Set(tones).size).toBe(4);
  });

  it('library filter uses aiPolicy API param and query key', () => {
    expect(pagesSearchParams('any')).toEqual({});
    expect(pagesSearchParams('none')).toEqual({ aiPolicy: 'none' });
    expect(pagesQueryKey({ page: 1 }, 'local_only')).toEqual(['pages', { page: 1, aiPolicy: 'local_only' }]);
  });

  it('labels make no verified or protection claims', () => {
    const all = [...Object.values(AI_POLICY_CHIP_LABEL), ...Object.values(LOCALITY_CHIP_LABEL)].join(' ');
    expect(all).not.toMatch(/verified|secure|protected|guarantee/i);
  });
});
