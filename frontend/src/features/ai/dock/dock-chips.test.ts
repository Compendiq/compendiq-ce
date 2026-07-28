import { describe, it, expect } from 'vitest';
import { DOCK_CHIPS, chipUserMessage } from './dock-chips';

describe('dock chips (#1126)', () => {
  it('offers exactly the four document actions — Generate is not one of them', () => {
    // Generate creates a NEW document rather than acting on the open one, so it
    // stays on /ai. If it ever appears here, the dock has quietly grown a mode
    // that has no document to act on.
    expect(DOCK_CHIPS.map((c) => c.id)).toEqual(['improve', 'summarize', 'diagram', 'quality']);
  });

  it('gives every chip a hint that names what it will do', () => {
    for (const chip of DOCK_CHIPS) {
      expect(chip.hint.length).toBeGreaterThan(0);
      expect(chip.hint.endsWith('.')).toBe(true);
    }
  });

  describe('user turns', () => {
    const base = { improvementType: 'grammar', diagramType: 'flowchart' };

    it('uses the typed instruction verbatim as the Improve turn', () => {
      expect(chipUserMessage('improve', { ...base, instruction: 'tighten the intro' }))
        .toBe('tighten the intro');
    });

    it('falls back to naming the improvement type when nothing was typed', () => {
      expect(chipUserMessage('improve', { ...base, improvementType: 'clarity' }))
        .toBe('Improve this page (clarity).');
      expect(chipUserMessage('improve', { ...base, instruction: '   ' }))
        .toBe('Improve this page (grammar).');
    });

    it('names the diagram type it is about to draw', () => {
      expect(chipUserMessage('diagram', { ...base, diagramType: 'sequence' }))
        .toBe('Draw a sequence diagram of this page.');
    });

    it('does not restate the page title — the document is on screen', () => {
      // /ai's equivalents say "Summarize: <title>" because there the document is
      // not visible. In the dock that is noise in a 420px column.
      expect(chipUserMessage('summarize', base)).toBe('Summarize this page.');
      expect(chipUserMessage('quality', base)).toBe('Analyze this page’s quality.');
    });
  });
});
