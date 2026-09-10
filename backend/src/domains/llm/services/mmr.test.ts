import { describe, it, expect } from 'vitest';
import { selectDiverse, trigrams, jaccard, MMR_LAMBDA_DEFAULT } from './mmr.js';
import type { SearchResult } from './rag-service.js';

// #1109 — the pure selection half. The stage's job is CONTEXT efficiency, not
// recall: measured on a deliberately duplicative corpus, retrieval still ranks
// the right page first, but 53% of the remaining slots are near-duplicates of
// a higher-ranked result. These tests pin that the narrow removes those copies
// without ever moving the head.

function r(id: number, title: string, text: string): SearchResult {
  return {
    pageId: id,
    confluenceId: `c${id}`,
    chunkText: text,
    pageTitle: title,
    sectionTitle: title,
    spaceKey: 'DEV',
    score: 0,
    vectorScore: null,
    keywordRank: null,
  } as SearchResult;
}

const RUNBOOK = (team: string) =>
  `${team} Service Deployment Runbook. Check the freeze calendar. Tag the release and push. ` +
  `Watch the canary for ten minutes; error rate must stay under 0.5%. Promote to the full fleet. ` +
  `Post release notes. If something looks wrong, follow the platform rollback procedure.`;

describe('trigram similarity', () => {
  it('scores near-identical copies high and unrelated text low', () => {
    const a = trigrams(RUNBOOK('Payments'));
    const b = trigrams(RUNBOOK('Identity'));
    const c = trigrams('Quarterly board demonstration schedule and attendee list for the sales org');
    expect(jaccard(a, b)).toBeGreaterThan(0.8);
    expect(jaccard(a, c)).toBeLessThan(0.2);
  });

  it('is symmetric, and identity is 1', () => {
    const a = trigrams('deployment runbook');
    const b = trigrams('rollback procedure');
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, b)).toBeCloseTo(jaccard(b, a), 12);
  });

  it('treats two empty texts as identical, not as an error', () => {
    // A page whose body_text is empty is a real state in this product; the
    // pairwise loop must not produce NaN and silently poison every score.
    expect(jaccard(trigrams(''), trigrams(''))).toBe(1);
    expect(jaccard(trigrams(''), trigrams('anything'))).toBe(0);
  });
});

describe('selectDiverse (#1109)', () => {
  it('NEVER moves the head — the ranking stages decided that, not this one', () => {
    const results = [
      r(1, 'Payments Runbook', RUNBOOK('Payments')),
      r(2, 'Identity Runbook', RUNBOOK('Identity')),
      r(3, 'Rollback Procedure', 'Halt the promotion, select the previous known-good digest, run rollback.'),
    ];
    // Even at maximum diversity pressure the leader is untouchable.
    for (const lambda of [1, 0.7, 0.3, 0]) {
      expect(selectDiverse(results, { lambda, k: 3 })[0]!.pageId).toBe(1);
    }
  });

  it('drops near-duplicate copies in favour of a distinct page, once diversity outweighs rank', () => {
    // Five copied runbooks and one genuinely different page — the shape the
    // synthetic corpus reproduces, and the reason this stage exists.
    const results = [
      r(1, 'Payments Runbook', RUNBOOK('Payments')),
      r(2, 'Identity Runbook', RUNBOOK('Identity')),
      r(3, 'Search Runbook', RUNBOOK('Search')),
      r(4, 'Billing Runbook', RUNBOOK('Billing')),
      r(5, 'Rollback Procedure', 'Halt the promotion, select the previous known-good image digest, run the rollback action, watch replicas cycle back.'),
    ];
    const picked = selectDiverse(results, { lambda: 0.5, k: 3 }).map((x) => x.pageId);
    expect(picked[0]).toBe(1);
    expect(picked).toContain(5);
    expect(picked.filter((id) => id >= 2 && id <= 4).length).toBeLessThanOrEqual(1);
  });

  it('is SENSITIVE to lambda, and the issue\'s suggested 0.7 is conservative here', () => {
    // Recorded because it is easy to assume a lambda is a lambda. Relevance
    // in this implementation is RANK-derived, not a normalised score, so the
    // relevance gap between rank 1 and rank 5 of a 5-candidate pool is 0.8 —
    // larger than the ~0.26 penalty a near-duplicate incurs at lambda 0.7.
    // At 0.7 a well-ranked copy therefore beats a poorly-ranked distinct
    // page, which is defensible (it IS more relevant) but does little for
    // context redundancy. The shipped default is tuned against the
    // duplicative corpus rather than inherited from the issue's prose.
    const results = [
      r(1, 'Payments Runbook', RUNBOOK('Payments')),
      r(2, 'Identity Runbook', RUNBOOK('Identity')),
      r(3, 'Search Runbook', RUNBOOK('Search')),
      r(4, 'Billing Runbook', RUNBOOK('Billing')),
      r(5, 'Rollback Procedure', 'Halt the promotion, select the previous known-good image digest, run the rollback action.'),
    ];
    const at07 = selectDiverse(results, { lambda: 0.7, k: 3 }).map((x) => x.pageId);
    const at03 = selectDiverse(results, { lambda: 0.3, k: 3 }).map((x) => x.pageId);
    expect(at07).not.toContain(5);
    expect(at03).toContain(5);
  });

  it('lambda = 1 is exactly the identity ranking — the knob really turns off', () => {
    const results = [1, 2, 3, 4, 5].map((i) => r(i, `Runbook ${i}`, RUNBOOK(`Team${i}`)));
    expect(selectDiverse(results, { lambda: 1, k: 4 }).map((x) => x.pageId)).toEqual([1, 2, 3, 4]);
  });

  it('keeps a duplicate when there is nothing else — diversity never shrinks the set', () => {
    // All six near-identical: the caller asked for 4 results and must get 4,
    // because returning less context than requested is a worse failure than
    // returning a redundant slot.
    const results = [1, 2, 3, 4, 5, 6].map((i) => r(i, `Runbook ${i}`, RUNBOOK(`Team${i}`)));
    expect(selectDiverse(results, { lambda: 0.2, k: 4 })).toHaveLength(4);
  });

  it('passes through when the candidate pool is not larger than k', () => {
    const results = [1, 2].map((i) => r(i, `P${i}`, `text ${i}`));
    expect(selectDiverse(results, { k: 5 }).map((x) => x.pageId)).toEqual([1, 2]);
    expect(selectDiverse([], { k: 5 })).toEqual([]);
    expect(selectDiverse(results, { k: 0 })).toEqual([]);
  });

  it('compares the ASSEMBLED text when there is one, since that is what the model sees', () => {
    // #1106 gives a surviving page a contextText window; comparing raw chunks
    // would judge similarity on text the model is never shown.
    const a = { ...r(1, 'A', 'short chunk'), contextText: RUNBOOK('Payments') } as SearchResult;
    const b = { ...r(2, 'B', 'totally different chunk'), contextText: RUNBOOK('Identity') } as SearchResult;
    const c = r(3, 'C', 'Halt the promotion and select the previous known-good image digest to restore.');
    const picked = selectDiverse([a, b, c], { lambda: MMR_LAMBDA_DEFAULT, k: 2 }).map((x) => x.pageId);
    // b is a near-copy of a *in the text that matters*, so c wins the slot.
    expect(picked).toEqual([1, 3]);
  });
});
