import { describe, it, expect } from 'vitest';
import { selectReplayableHistory, HISTORY_REPLAY_TOKEN_BUDGET } from './history-budget.js';

// estimateTokens is ~4 chars/token: a 400-char turn is ~100 tokens.
const chars = (n: number, ch = 'x') => ch.repeat(n);

describe('selectReplayableHistory', () => {
  it('replays everything oldest→newest as {role, content} when under budget', () => {
    const { replay, truncated } = selectReplayableHistory([
      { role: 'user', content: 'q1', sources: [] },
      { role: 'assistant', content: 'a1', sources: [{ pageTitle: 'P', pageId: 1 }] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]);
    expect(replay).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]);
    expect(replay.some((m) => 'sources' in m || 'refused' in m)).toBe(false);
    expect(truncated).toBe(false);
  });

  it('never replays a refused turn NOR the orphan question it leaves behind, and that is not truncation', () => {
    const { replay, truncated } = selectReplayableHistory([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'weak question' },
      { role: 'assistant', content: 'I am not answering', refused: true },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ]);
    expect(replay.map((m) => m.content)).toEqual(['q1', 'a1', 'q3', 'a3']);
    expect(truncated).toBe(false);
  });

  it('keeps pairing aligned across an orphan when the budget bites (drops oldest exchanges first)', () => {
    // Each exchange = 2 × 400 chars ≈ 200 tokens; budget 450 keeps two exchanges.
    const { replay, truncated } = selectReplayableHistory(
      [
        { role: 'user', content: chars(400, 'a') },
        { role: 'assistant', content: chars(400, 'b') },
        { role: 'user', content: chars(400, 'c') },        // refused exchange → orphan
        { role: 'assistant', content: 'refused', refused: true },
        { role: 'user', content: chars(400, 'd') },
        { role: 'assistant', content: chars(400, 'e') },
        { role: 'user', content: chars(400, 'f') },
        { role: 'assistant', content: chars(400, 'g') },
      ],
      450,
    );
    expect(replay.map((m) => m.content[0])).toEqual(['d', 'e', 'f', 'g']);
    expect(truncated).toBe(true);
  });

  it('drops a single exchange larger than the budget and reports truncation', () => {
    const { replay, truncated } = selectReplayableHistory(
      [{ role: 'user', content: chars(4_000) }, { role: 'assistant', content: chars(4_000) }],
      100,
    );
    expect(replay).toEqual([]);
    expect(truncated).toBe(true);
  });

  it('an assistant turn with no user before it is replayed alone (defensive)', () => {
    const { replay } = selectReplayableHistory([{ role: 'assistant', content: 'a0' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
    expect(replay.map((m) => m.content)).toEqual(['a0', 'q1', 'a1']);
  });

  it('exports the default budget as a plain constant', () => {
    expect(HISTORY_REPLAY_TOKEN_BUDGET).toBe(4_000);
  });
});
