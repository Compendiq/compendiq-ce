import { describe, it, expect } from 'vitest';
import { MAX_DERIVED_PARTS, serializeImageAnalysis, substantiveChars } from './image-analysis-serialize.js';
import type { ImageAnalysisPayload } from './image-analysis-provider.js';

const LIMIT = 6_000;

function payload(overrides: Partial<ImageAnalysisPayload> = {}): ImageAnalysisPayload {
  return {
    schemaVersion: 1,
    kind: 'screenshot',
    language: 'en',
    description: 'A settings dialog with the Retry button highlighted.',
    visibleText: 'Error 0x8007045D\nRetry',
    limitations: [],
    ...overrides,
  };
}

describe('serializeImageAnalysis (ADR-027 D8)', () => {
  it('emits the fixed labels in the fixed order, context lines labelled as author-supplied', () => {
    const [text] = serializeImageAnalysis(
      payload({ limitations: ['bottom-right corner cut off'] }),
      { attachmentKey: 'dialog.png', pageTitle: 'Install guide', caption: 'The retry dialog', heading: 'Step 3' },
      LIMIT,
    );
    expect(text).toBe(
      [
        '[Image: dialog.png — screenshot]',
        'Page: Install guide',
        'Caption (author-supplied): The retry dialog',
        'Section: Step 3',
        'Description: A settings dialog with the Retry button highlighted.',
        'Visible text:',
        'Error 0x8007045D',
        'Retry',
        'Limitations: bottom-right corner cut off',
      ].join('\n'),
    );
  });

  it('omits the caption and section lines when the page carries none, and bounds the ones it has', () => {
    const [text] = serializeImageAnalysis(
      payload({ visibleText: '' }),
      { attachmentKey: 'a.png', pageTitle: 'T'.repeat(500), caption: '', heading: null },
      LIMIT,
    );
    const lines = text!.split('\n');
    expect(lines[1]).toHaveLength('Page: '.length + 200);
    expect(lines[1]!.endsWith('…')).toBe(true);
    expect(text).not.toContain('Caption');
    expect(text).not.toContain('Section:');
    expect(text).not.toContain('Visible text');
  });

  it('renders only the structured block the payload carries', () => {
    const [table] = serializeImageAnalysis(
      payload({ kind: 'table', structured: { tableRows: ['Name | Qty', 'Bolt | 12'] } }),
      { attachmentKey: 'bom.png', pageTitle: 'BOM' },
      LIMIT,
    );
    expect(table).toContain('Table:\nName | Qty\nBolt | 12');
    expect(table).not.toContain('Chart:');

    const [chart] = serializeImageAnalysis(
      payload({ kind: 'chart', structured: { chart: { xAxis: 'Month', yAxis: 'Tickets', series: ['P1', 'P2'], trend: 'falling' } } }),
      { attachmentKey: 'c.png', pageTitle: 'Ops' },
      LIMIT,
    );
    expect(chart).toContain('Chart: x: Month; y: Tickets; series: P1, P2; trend: falling');

    const [diagram] = serializeImageAnalysis(
      payload({ kind: 'diagram', structured: { diagram: { nodes: ['Web', 'DB'], edges: ['Web -> DB: SQL'] } } }),
      { attachmentKey: 'd.png', pageTitle: 'Arch' },
      LIMIT,
    );
    expect(diagram).toContain('Diagram: Web, DB / Web -> DB: SQL');
  });

  it('is deterministic: the same payload and context serialize identically', () => {
    const p = payload({ limitations: ['b', 'a'] });
    const ctx = { attachmentKey: 'x.png', pageTitle: 'P', caption: 'c', heading: 'h' };
    expect(serializeImageAnalysis(p, ctx, LIMIT)).toEqual(serializeImageAnalysis(p, ctx, LIMIT));
  });

  it('splits an oversized serialization on block boundaries into at most three parts, each carrying the header', () => {
    const big = payload({
      description: 'd'.repeat(1_200),
      visibleText: 'v'.repeat(2_500),
      kind: 'table',
      structured: { tableRows: Array.from({ length: 30 }, (_, i) => `${i} | ${'x'.repeat(95)}`) },
      limitations: Array.from({ length: 6 }, () => 'l'.repeat(120)),
    });
    const parts = serializeImageAnalysis(big, { attachmentKey: 'big.png', pageTitle: 'Big' }, LIMIT);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(MAX_DERIVED_PARTS);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
      expect(part.startsWith('[Image: big.png — table]\nPage: Big\n')).toBe(true);
    }
    // Every block survives, whole, in exactly one part.
    const joined = parts.join('\n');
    expect(joined).toContain(`Description: ${'d'.repeat(1_200)}`);
    expect(joined).toContain(`Visible text:\n${'v'.repeat(2_500)}`);
    expect(joined.match(/^Table:$/gm)).toHaveLength(1);
  });
});

describe('substantiveChars (ADR-027 D8 floor)', () => {
  it('counts description and visible text, trimmed, and never URLs or context', () => {
    expect(substantiveChars(payload({ description: '  abc  ', visibleText: 'de\n' }))).toBe(5);
    expect(substantiveChars(payload({ description: 'https://example.com/a/b.png', visibleText: 'www.x.io' }))).toBe(0);
    expect(substantiveChars(payload({ description: 'see https://example.com now', visibleText: '' }))).toBe('see now'.length);
  });
});
