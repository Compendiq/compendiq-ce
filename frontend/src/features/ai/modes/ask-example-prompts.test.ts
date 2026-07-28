import { describe, it, expect } from 'vitest';
import { buildAskPrompts, ASK_FALLBACK_PROMPTS, type PromptSources } from './ask-example-prompts';

const empty: PromptSources = { recentPages: [], labels: [], spaceKeys: [] };

function sources(overrides: Partial<PromptSources>): PromptSources {
  return { ...empty, ...overrides };
}

describe('buildAskPrompts', () => {
  it('falls back to non-specific prompts when the instance is empty', () => {
    expect(buildAskPrompts(empty)).toEqual(ASK_FALLBACK_PROMPTS);
  });

  it('never invents a tag or space that does not exist', () => {
    // The pre-critique list hardcoded "onboarding" and "engineering"; a fresh
    // install had neither, so the AI surface opened by fabricating content.
    const prompts = buildAskPrompts(empty).join(' ');
    expect(prompts).not.toMatch(/tagged "/);
    expect(prompts).not.toMatch(/ space /);
  });

  it('names the most recently modified page', () => {
    const prompts = buildAskPrompts(
      sources({
        recentPages: [
          { title: 'On-call rotation and escalation policy', spaceKey: 'DEV', labels: [] },
          { title: 'Older page', spaceKey: 'DEV', labels: [] },
        ],
      }),
    );
    expect(prompts[0]).toBe('Summarize "On-call rotation and escalation policy"');
  });

  it('truncates a long title so the prompt stays one line', () => {
    const long = 'A'.repeat(120);
    const [first] = buildAskPrompts(
      sources({ recentPages: [{ title: long, spaceKey: null, labels: [] }] }),
    );
    expect(first!.length).toBeLessThan(80);
    expect(first).toMatch(/…"$/);
  });

  it('uses a real label attached to a recent page in preference to any other', () => {
    const prompts = buildAskPrompts(
      sources({
        recentPages: [{ title: 'Runbook', spaceKey: 'OPS', labels: ['incident-response'] }],
        labels: ['some-other-label'],
      }),
    );
    expect(prompts).toContain('Draft a how-to from pages tagged "incident-response"');
    expect(prompts.join(' ')).not.toContain('some-other-label');
  });

  it('falls back to the instance label list when no recent page carries one', () => {
    const prompts = buildAskPrompts(
      sources({
        recentPages: [{ title: 'Runbook', spaceKey: 'OPS', labels: [] }],
        labels: ['architecture'],
      }),
    );
    expect(prompts).toContain('Draft a how-to from pages tagged "architecture"');
  });

  it('names a real space key', () => {
    const prompts = buildAskPrompts(
      sources({
        recentPages: [{ title: 'Runbook', spaceKey: 'OPS', labels: [] }],
        spaceKeys: ['OPS'],
      }),
    );
    expect(prompts).toContain('What changed in the OPS space in the last 7 days?');
  });

  it('omits the space prompt entirely when no space exists', () => {
    const prompts = buildAskPrompts(
      sources({ recentPages: [{ title: 'Standalone note', spaceKey: null, labels: [] }] }),
    );
    expect(prompts.join(' ')).not.toMatch(/space in the last 7 days/);
  });

  it('only suggests duplicate-hunting once there are pages to compare', () => {
    const single = buildAskPrompts(
      sources({ recentPages: [{ title: 'Only page', spaceKey: null, labels: [] }] }),
    );
    expect(single).not.toContain('Find pages that look like duplicates of each other');

    const many = buildAskPrompts(
      sources({
        recentPages: [
          { title: 'One', spaceKey: null, labels: [] },
          { title: 'Two', spaceKey: null, labels: [] },
        ],
      }),
    );
    expect(many).toContain('Find pages that look like duplicates of each other');
  });

  it('returns exactly four prompts when the instance is fully populated', () => {
    const prompts = buildAskPrompts(
      sources({
        recentPages: [
          { title: 'One', spaceKey: 'DEV', labels: ['runbook'] },
          { title: 'Two', spaceKey: 'DEV', labels: [] },
        ],
        labels: ['runbook', 'architecture'],
        spaceKeys: ['DEV', 'OPS'],
      }),
    );
    expect(prompts).toHaveLength(4);
    expect(new Set(prompts).size).toBe(4);
  });

  it('tops up to four from the fallbacks without duplicating', () => {
    const prompts = buildAskPrompts(
      sources({ recentPages: [{ title: 'Only page', spaceKey: null, labels: [] }] }),
    );
    expect(prompts).toHaveLength(4);
    expect(new Set(prompts).size).toBe(4);
    expect(prompts[0]).toBe('Summarize "Only page"');
  });

  it('ignores blank titles, labels, and space keys rather than quoting emptiness', () => {
    const prompts = buildAskPrompts(
      sources({
        recentPages: [
          { title: '   ', spaceKey: null, labels: ['  '] },
          { title: 'Real page', spaceKey: 'DEV', labels: [] },
        ],
        labels: ['   '],
        spaceKeys: ['  '],
      }),
    );
    expect(prompts[0]).toBe('Summarize "Real page"');
    expect(prompts.join(' ')).not.toMatch(/""|"\s+"/);
    expect(prompts.join(' ')).not.toMatch(/tagged "\s*"/);
  });
});
