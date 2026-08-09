import { describe, it, expect } from 'vitest';
import { resolvePageState } from './page-state';

/**
 * These pin a PRODUCT decision, not a rendering detail: three pipeline badges
 * collapsed into one, with silence as the healthy state. If someone later wants
 * a row to show its state whatever happens, this file is the argument they have
 * to change deliberately rather than by accident.
 */
describe('resolvePageState', () => {
  it('renders nothing when the page is healthy', () => {
    expect(
      resolvePageState({
        embeddingDirty: false,
        summaryStatus: 'summarized',
        qualityStatus: 'analyzed',
      }),
    ).toBeNull();
  });

  // The single biggest source of the noise this replaced: a row that read
  // "Skipped / Skipped / Not Embedded" when nothing was actually wrong.
  it('treats skipped as configuration, not a condition', () => {
    expect(
      resolvePageState({
        embeddingDirty: false,
        summaryStatus: 'skipped',
        qualityStatus: 'skipped',
      }),
    ).toBeNull();
  });

  it('surfaces a failure from either pipeline', () => {
    expect(resolvePageState({ summaryStatus: 'failed' })?.label).toBe('Failed');
    expect(resolvePageState({ qualityStatus: 'failed' })?.label).toBe('Failed');
  });

  it('reports an unindexed page', () => {
    const state = resolvePageState({ embeddingDirty: true });
    expect(state?.label).toBe('Not indexed');
    expect(state?.tone).toBe('idle');
  });

  it('reports in-flight work from either pipeline', () => {
    expect(resolvePageState({ summaryStatus: 'summarizing' })?.label).toBe('Processing');
    expect(resolvePageState({ qualityStatus: 'analyzing' })?.label).toBe('Processing');
  });

  describe('severity ladder — most severe wins', () => {
    it('failure outranks an unindexed page', () => {
      expect(
        resolvePageState({ embeddingDirty: true, summaryStatus: 'failed' })?.label,
      ).toBe('Failed');
    });

    // `not indexed` beats `processing` because it is the only state that
    // changes what the product can DO with the page: an unembedded page is
    // invisible to semantic search, while a summary still being written is not
    // something the reader needs to act on.
    it('an unindexed page outranks in-flight work', () => {
      expect(
        resolvePageState({ embeddingDirty: true, summaryStatus: 'summarizing' })?.label,
      ).toBe('Not indexed');
    });

    it('failure outranks everything', () => {
      expect(
        resolvePageState({
          embeddingDirty: true,
          summaryStatus: 'summarizing',
          qualityStatus: 'failed',
        })?.label,
      ).toBe('Failed');
    });
  });

  it('says nothing when it knows nothing', () => {
    expect(resolvePageState({})).toBeNull();
  });
});
