import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  enqueueAiReview,
  checkPendingAiReview,
  setAiReviewHook,
  setPendingAiReviewCheckHook,
  _resetAiReviewHooksForTests,
  type EnqueueParams,
} from './ai-review-hook.js';

const baseParams: EnqueueParams = {
  pageId: 42,
  actionType: 'improve',
  proposedContent: 'improved text',
  authoredBy: '00000000-0000-0000-0000-000000000001',
  llmAuditId: 1001,
};

afterEach(() => {
  _resetAiReviewHooksForTests();
});

describe('ai-review-hook (CE noop + EE extension point)', () => {
  it('enqueueAiReview returns auto-publish when no hook is installed', async () => {
    const result = await enqueueAiReview(baseParams);
    expect(result).toEqual({ mode: 'auto-publish' });
  });

  it('enqueueAiReview delegates to the installed hook', async () => {
    const hook = vi.fn().mockResolvedValue({ mode: 'pending', reviewId: 'abc' });
    setAiReviewHook(hook);

    const result = await enqueueAiReview(baseParams);
    expect(result).toEqual({ mode: 'pending', reviewId: 'abc' });
    expect(hook).toHaveBeenCalledWith(baseParams);
  });

  it('enqueueAiReview fails open to auto-publish when hook throws', async () => {
    setAiReviewHook(vi.fn().mockRejectedValue(new Error('queue down')));
    const result = await enqueueAiReview(baseParams);
    expect(result).toEqual({ mode: 'auto-publish' });
  });

  it('checkPendingAiReview returns null when no hook installed', async () => {
    expect(await checkPendingAiReview(42)).toBeNull();
  });

  it('checkPendingAiReview delegates when hook installed', async () => {
    const hook = vi.fn().mockResolvedValue({ id: 'review-99' });
    setPendingAiReviewCheckHook(hook);
    expect(await checkPendingAiReview(42)).toEqual({ id: 'review-99' });
    expect(hook).toHaveBeenCalledWith(42);
  });

  it('checkPendingAiReview fails open to null when hook throws', async () => {
    setPendingAiReviewCheckHook(vi.fn().mockRejectedValue(new Error('db down')));
    expect(await checkPendingAiReview(42)).toBeNull();
  });
});
