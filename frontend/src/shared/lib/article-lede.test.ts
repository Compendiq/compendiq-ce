import { describe, it, expect } from 'vitest';
import { hasSubstantialLede, isSummaryStale, countWords, LEDE_MIN_WORDS } from './article-lede';

/** A paragraph of exactly `n` words. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('countWords', () => {
  it('counts runs of non-whitespace', () => {
    expect(countWords('one two three')).toBe(3);
  });

  it('is not fooled by newlines, tabs or runs of spaces', () => {
    expect(countWords('  one\n\ttwo   three \n ')).toBe(3);
  });

  it('counts nothing for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n ')).toBe(0);
  });
});

describe('hasSubstantialLede', () => {
  it('is true when the first block is a long paragraph', () => {
    expect(hasSubstantialLede(`<p>${words(LEDE_MIN_WORDS)}</p><h2>Next</h2>`)).toBe(true);
  });

  it('is false when the opening paragraph is a stub', () => {
    expect(hasSubstantialLede(`<p>${words(LEDE_MIN_WORDS - 1)}</p>`)).toBe(false);
  });

  it('counts text inside inline markup as part of the lede', () => {
    // A lede full of <strong>/<code>/<a> is still a lede.
    const inline = `<p><strong>${words(20)}</strong> <code>x</code> <a href="/y">${words(20)}</a></p>`;
    expect(hasSubstantialLede(inline)).toBe(true);
  });

  it('is false when the document opens with a heading', () => {
    expect(hasSubstantialLede(`<h2>Overview</h2><p>${words(80)}</p>`)).toBe(false);
  });

  it('is false when the document opens with a macro or callout', () => {
    // A warning panel is not a lede, even though it contains a paragraph.
    const panel = `<div class="confluence-information-macro"><p>${words(80)}</p></div><p>${words(80)}</p>`;
    expect(hasSubstantialLede(panel)).toBe(false);
  });

  it('is false when the document opens with a table', () => {
    expect(hasSubstantialLede(`<table><tbody><tr><td>${words(80)}</td></tr></tbody></table>`)).toBe(false);
  });

  // Without this, `firstElementChild` is a <div> on nearly every real
  // Confluence page and the answer would be "no lede" for the whole corpus.
  it('descends through Confluence layout scaffolding to the first real block', () => {
    const wrapped =
      '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="single">' +
      `<div class="confluence-layout-cell"><p>${words(60)}</p></div></div></div>`;
    expect(hasSubstantialLede(wrapped)).toBe(true);
  });

  it('still says no when the layout scaffolding opens on a heading', () => {
    const wrapped =
      '<div class="confluence-layout"><div class="confluence-layout-cell"><h2>Tasks</h2></div></div>';
    expect(hasSubstantialLede(wrapped)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   \n '],
    ['an empty paragraph', '<p></p>'],
    ['a ProseMirror trailing break', '<p><br></p>'],
  ])('is false for %s body content', (_label, html) => {
    expect(hasSubstantialLede(html)).toBe(false);
  });

  // The threshold is calibrated against real prose, not a round number: this
  // is a genuine 37-word incident-runbook opening, and it must read as a lede.
  it('treats a real two-sentence runbook opening as a lede', () => {
    const lede =
      '<p>When a full Confluence space sync overlaps with the nightly re-embedding job, the shared ' +
      'Postgres pool saturates and API requests begin timing out. This runbook covers detection, ' +
      'mitigation and the follow-up work needed to stop it recurring.</p><h2>Symptoms</h2>';
    expect(countWords(lede.replace(/<[^>]+>/g, ' '))).toBeLessThan(40);
    expect(hasSubstantialLede(lede)).toBe(true);
  });

  it('still rejects a one-line intro', () => {
    expect(hasSubstantialLede('<p>This page explains the sync pipeline.</p>')).toBe(false);
  });

  it('honours a caller-supplied threshold', () => {
    expect(hasSubstantialLede(`<p>${words(10)}</p>`, 5)).toBe(true);
    expect(hasSubstantialLede(`<p>${words(10)}</p>`, 25)).toBe(false);
  });
});

describe('isSummaryStale', () => {
  it('is true when the page was modified after the summary was generated', () => {
    expect(isSummaryStale('2026-08-09T12:00:00Z', '2026-08-01T12:00:00Z')).toBe(true);
  });

  it('is false when the summary is newer than the last edit', () => {
    expect(isSummaryStale('2026-08-01T12:00:00Z', '2026-08-09T12:00:00Z')).toBe(false);
  });

  // The worker's Phase 1 uses a strict `>`. Disagreeing here would make a page
  // flag itself stale the moment it was summarized.
  it('is false when the timestamps are equal', () => {
    expect(isSummaryStale('2026-08-09T12:00:00Z', '2026-08-09T12:00:00Z')).toBe(false);
  });

  it('compares instants, not strings, across timezone offsets', () => {
    // 13:00+02:00 is 11:00Z — BEFORE 12:00Z, despite sorting after it as text.
    expect(isSummaryStale('2026-08-09T13:00:00+02:00', '2026-08-09T12:00:00Z')).toBe(false);
    expect(isSummaryStale('2026-08-09T15:00:00+02:00', '2026-08-09T12:00:00Z')).toBe(true);
  });

  it.each([
    ['no last-modified', null, '2026-08-01T12:00:00Z'],
    ['no generated-at', '2026-08-01T12:00:00Z', null],
    ['neither', null, null],
    ['an unparseable date', 'not-a-date', '2026-08-01T12:00:00Z'],
  ])('is false with %s rather than guessing', (_label, modified, generated) => {
    expect(isSummaryStale(modified, generated)).toBe(false);
  });
});
