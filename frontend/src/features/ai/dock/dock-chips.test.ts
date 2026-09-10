import { describe, expect, it } from 'vitest';
import { chipUserMessage } from './dock-chips';

const base = { improvementType: 'grammar' as const, diagramType: 'flowchart' };

describe('docked action user turns', () => {
  it('uses typed text verbatim for rewrite and Diagram instructions', () => {
    expect(chipUserMessage('improve', { ...base, instruction: 'Tighten the intro.' }))
      .toBe('Tighten the intro.');
    expect(chipUserMessage('diagram', { ...base, instruction: 'Show the approval loop.' }))
      .toBe('Show the approval loop.');
  });

  it('writes honest fallback turns when no instruction is needed', () => {
    expect(chipUserMessage('improve', base)).toBe('Improve this page (grammar).');
    expect(chipUserMessage('diagram', base)).toBe('Draw a flowchart diagram of this page.');
  });
});
