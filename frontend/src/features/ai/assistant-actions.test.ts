import { describe, it, expect } from 'vitest';
import { AI_HOME_ACTIONS, CREATE_SKILL_ACTIONS, DOCK_ACTIONS, isAiHomeAction } from './assistant-actions';
import { IMPROVEMENT_TYPES } from './improvement-types';
import { CREATE_SKILLS } from './create-skills';

describe('assistant action allow-lists (#1361)', () => {
  it('offers Q&A, Generate and the create skills on /ai, in that order', () => {
    // Owner ruling 3 (2026-08-22): decision 13 dropped the rewrite skills and
    // Diagram from /ai — they act ON a document and /ai has no page scope left
    // — but the #1401 create skills BELONG here: they create a new page, which
    // is exactly what the no-document home is for.
    expect(AI_HOME_ACTIONS).toEqual(['ask', 'generate', ...CREATE_SKILL_ACTIONS]);
    for (const type of IMPROVEMENT_TYPES) expect(AI_HOME_ACTIONS).not.toContain(type);
    expect(AI_HOME_ACTIONS).not.toContain('diagram');
  });

  it('offers everything in the dock', () => {
    // Ruling 2: #1401's create skills on the dock are intended, and the dock
    // already routes plain `generate` to runCreateSkill('custom'), so the item
    // was hidden rather than unsupported.
    expect(DOCK_ACTIONS).toEqual(['ask', ...IMPROVEMENT_TYPES, 'diagram', 'generate', ...CREATE_SKILL_ACTIONS]);
  });

  it('derives both lists from the contracts rather than restating them', () => {
    // A sixth improvement pass added to the contract enum, or a sixth create
    // skill added to create-skills.ts, has to reach both surfaces without this
    // file being edited — the `improvement-types.ts` argument, twice.
    for (const type of IMPROVEMENT_TYPES) expect(DOCK_ACTIONS).toContain(type);
    expect(CREATE_SKILL_ACTIONS).toEqual(CREATE_SKILLS.map((skill) => `create-${skill.id}`));
    expect(CREATE_SKILL_ACTIONS).toHaveLength(5);
  });

  it('narrows a raw URL mode to the two modes /ai can be deep-linked into', () => {
    // Deliberately NOT the menu list: `create-*` is never a URL `mode` value —
    // the URL carries `mode=generate` and the skill is picked in-app — so a
    // create id reaching this predicate is a malformed link, not a mode.
    expect(isAiHomeAction('ask')).toBe(true);
    expect(isAiHomeAction('generate')).toBe(true);
    for (const rejected of ['improve', 'diagram', 'grammar', 'summarize', 'quality', 'create-spec', '', 'ASK']) {
      expect(isAiHomeAction(rejected)).toBe(false);
    }
  });
});
