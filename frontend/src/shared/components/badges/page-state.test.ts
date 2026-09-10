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

  // Named per pipeline (not a bare "Failed") so a reader can tell this badge
  // apart from QualityScoreBadge's own "Analysis Failed" state when both
  // render on the same row (a page scored once, then failing re-analysis,
  // keeps its last score — see the severity-ladder tests below for the case
  // where both pipelines fail at once).
  it('surfaces a failure from either pipeline, naming which one', () => {
    expect(resolvePageState({ summaryStatus: 'failed' })?.label).toBe('Summary failed');
    expect(resolvePageState({ qualityStatus: 'failed' })?.label).toBe('Quality failed');
  });

  it('names both pipelines when summary and quality fail together', () => {
    const state = resolvePageState({ summaryStatus: 'failed', qualityStatus: 'failed' });
    expect(state?.label).toBe('Summary & quality failed');
    expect(state?.tone).toBe('failed');
  });

  it('reports an unindexed page', () => {
    const state = resolvePageState({ embeddingDirty: true });
    expect(state?.label).toBe('Not indexed');
    expect(state?.tone).toBe('idle');
  });

  it('can silence idle Not indexed without hiding failures or in-flight work', () => {
    expect(resolvePageState({ embeddingDirty: true, showIdleEmbedding: false })).toBeNull();
    expect(
      resolvePageState({
        embeddingDirty: true,
        qualityStatus: 'failed',
        showIdleEmbedding: false,
      })?.label,
    ).toBe('Quality failed');
    expect(
      resolvePageState({
        embeddingDirty: true,
        summaryStatus: 'summarizing',
        showIdleEmbedding: false,
      })?.label,
    ).toBe('Processing');
  });

  it('reports in-flight work from either pipeline', () => {
    expect(resolvePageState({ summaryStatus: 'summarizing' })?.label).toBe('Processing');
    expect(resolvePageState({ qualityStatus: 'analyzing' })?.label).toBe('Processing');
  });

  describe('severity ladder — most severe wins', () => {
    it('failure outranks an unindexed page', () => {
      expect(
        resolvePageState({ embeddingDirty: true, summaryStatus: 'failed' })?.label,
      ).toBe('Summary failed');
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
      ).toBe('Quality failed');
    });
  });

  it('says nothing when it knows nothing', () => {
    expect(resolvePageState({})).toBeNull();
  });
});
