/**
 * The improvement passes shared by `/ai?mode=improve` and the dock (#1177).
 *
 * The list used to be a hand-written array private to `ImproveMode.tsx`. These
 * assert the property that replaced it: the frontend offers exactly what the
 * contract validates, so a sixth pass added to the enum cannot reach one picker
 * and not the other, and cannot reach either without an explanation.
 */
import { describe, it, expect } from 'vitest';
import { ImprovementTypeSchema } from '@compendiq/contracts';
import {
  IMPROVEMENT_TYPES, IMPROVEMENT_DESCRIPTIONS, DEFAULT_IMPROVEMENT_TYPE,
} from './improvement-types';

describe('improvement types (#1177)', () => {
  it('offers exactly what /llm/improve accepts, in the contract’s own order', () => {
    expect(IMPROVEMENT_TYPES).toEqual(ImprovementTypeSchema.options);
    // The five the issue enumerates. Pinned as literals as well as by identity
    // so that a well-meaning edit to the enum has to come past a test that
    // names what it is changing.
    expect([...IMPROVEMENT_TYPES]).toEqual([
      'grammar', 'structure', 'clarity', 'technical', 'completeness',
    ]);
  });

  it('describes every pass it offers', () => {
    for (const type of IMPROVEMENT_TYPES) {
      const description = IMPROVEMENT_DESCRIPTIONS[type];
      expect(description, `${type} has no description`).toBeTruthy();
      // The copy is the whole reason the map is not derived: "technical" and
      // "completeness" say nothing on their own.
      expect(description.length).toBeGreaterThan(20);
    }
    expect(Object.keys(IMPROVEMENT_DESCRIPTIONS).sort()).toEqual([...IMPROVEMENT_TYPES].sort());
  });

  it('defaults to grammar — the least destructive pass', () => {
    // Both surfaces start here, the dock names the type in its chip only when it
    // is *not* this one, and `AiDock.test.tsx` pins `type: 'grammar'` on a run
    // nobody configured. Changing this changes what an unconfigured Improve does
    // to somebody's document.
    expect(DEFAULT_IMPROVEMENT_TYPE).toBe('grammar');
    expect(IMPROVEMENT_TYPES).toContain(DEFAULT_IMPROVEMENT_TYPE);
  });
});
