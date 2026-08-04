import { describe, it, expect } from 'vitest';
import { DOCK_CHIPS, chipUserMessage, improveChipHint } from './dock-chips';
import { IMPROVEMENT_TYPES } from '../improvement-types';

describe('dock chips (#1126)', () => {
  it('offers exactly the four document actions — Generate is not one of them', () => {
    // Generate creates a NEW document rather than acting on the open one, so it
    // stays on /ai. If it ever appears here, the dock has quietly grown a mode
    // that has no document to act on.
    expect(DOCK_CHIPS.map((c) => c.id)).toEqual(['improve', 'summarize', 'diagram', 'quality']);
  });

  it('gives every chip a hint that names what it will do', () => {
    for (const chip of DOCK_CHIPS) {
      // Improve's is composed from the live selection rather than stored — see
      // the block below.
      const hint = chip.id === 'improve' ? improveChipHint('grammar') : chip.hint;
      expect(hint, `${chip.id} has no hint`).toBeTruthy();
      expect(hint!.endsWith('.')).toBe(true);
    }
  });

  // #1177: the one chip whose press means different things depending on a
  // setting. Its tooltip has to say which.
  describe('the Improve hint', () => {
    it('names the pass it is about to run', () => {
      for (const type of IMPROVEMENT_TYPES) {
        expect(improveChipHint(type)).toContain(`${type} pass`);
      }
    });

    it('still explains what the composer text is for', () => {
      expect(improveChipHint('clarity')).toContain('extra instructions');
    });

    it('is the chip’s only tooltip — the table stores none for it', () => {
      // A stored constant would be a second answer that no surface reads and
      // that no selection can keep current. `DockPanel` composes this one.
      expect(DOCK_CHIPS.find((c) => c.id === 'improve')?.hint).toBeUndefined();
      for (const chip of DOCK_CHIPS) {
        if (chip.id !== 'improve') expect(chip.hint).toBeTruthy();
      }
    });
  });

  describe('user turns', () => {
    const base = { improvementType: 'grammar', diagramType: 'flowchart' } as const;

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
