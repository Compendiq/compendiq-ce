import { describe, expect, it } from 'vitest';
import { significanceLines, type ModelCfg } from './variant-significance.js';
import { pairedSignificance, recallAtK, type QueryRun } from './metrics.js';

function run(id: string, retrieved: number[], expected: number[]): QueryRun {
  return { queryId: id, retrieved, expected };
}

describe('significanceLines', () => {
  const dummyModels: ModelCfg[] = [{ id: 'bge-m3' }];

  it('emits exactly one comparison when only V1 and V2 results exist', () => {
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V1': { runs: [run('q1', [1, 2], [1])] },
      'bge-m3/V2': { runs: [run('q1', [1, 3], [1])] },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bge-m3');
    expect(lines[0]).toContain('V1→V2');
  });

  it('emits only pairs where both variants exist', () => {
    // V1, V3, V4 present, but V2 is missing
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V1': { runs: [run('q1', [1, 2], [1])] },
      'bge-m3/V3': { runs: [run('q1', [1, 3], [1])] },
      'bge-m3/V4': { runs: [run('q1', [1, 4], [1])] },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    // Should emit V1→V3, V1→V4, V3→V4 (not V1→V2 since V2 is missing)
    expect(lines).toHaveLength(3);
    expect(lines).toContainEqual(expect.stringContaining('V1→V3'));
    expect(lines).toContainEqual(expect.stringContaining('V1→V4'));
    expect(lines).toContainEqual(expect.stringContaining('V3→V4'));
    expect(lines).not.toContainEqual(expect.stringContaining('V1→V2'));
  });

  it('emits one pair for V1,V3 only', () => {
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V1': { runs: [run('q1', [1, 2], [1])] },
      'bge-m3/V3': { runs: [run('q1', [1, 3], [1])] },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    expect(lines).toEqual(['bge-m3 V1→V3 (bigger chunk, no prefix): 0W/0L · p=1.0000 · no credible change']);
  });

  it('emits one pair for V3,V4 only', () => {
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V3': { runs: [run('q1', [1, 3], [1])] },
      'bge-m3/V4': { runs: [run('q1', [1, 4], [1])] },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    expect(lines).toEqual(['bge-m3 V3→V4 (title prefix @667): 0W/0L · p=1.0000 · no credible change']);
  });

  it('emits explanatory line when V2 and V4 only (no canonical pair)', () => {
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V2': { runs: [run('q1', [1, 2], [1])] },
      'bge-m3/V4': { runs: [run('q1', [1, 4], [1])] },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    // V2→V4 is not a canonical pair, so emit explanatory line
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('(no comparable variant pair executed)');
  });

  it('emits explanatory line when only single variant present', () => {
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V1': { runs: [run('q1', [1, 2], [1])] },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('(no comparable variant pair executed)');
  });

  it('preserves output format for full four-variant path with varied fixture', () => {
    // Fixture with two models (a, b) and 30 queries, varied wins/losses per variant
    // to exercise padding, IMPROVEMENT/REGRESSION branches, and p-value formatting
    const queries = Array.from({ length: 30 }, (_, i) => `q${i + 1}`);
    
    // Model a: V1 i<10, V2 i<11&&i!==3, V3 i<22, V4 i<10||i>=27
    const aV1 = queries.map((q, i) => run(q, i < 10 ? [1] : [], [1]));
    const aV2 = queries.map((q, i) => run(q, i < 11 && i !== 3 ? [1] : [], [1]));
    const aV3 = queries.map((q, i) => run(q, i < 22 ? [1] : [], [1]));
    const aV4 = queries.map((q, i) => run(q, i < 10 || i >= 27 ? [1] : [], [1]));
    
    // Model b: V1 i%2===0, V2 i%3===0, V3 always, V4 never
    const bV1 = queries.map((q, i) => run(q, i % 2 === 0 ? [1] : [], [1]));
    const bV2 = queries.map((q, i) => run(q, i % 3 === 0 ? [1] : [], [1]));
    const bV3 = queries.map((q) => run(q, [1], [1]));
    const bV4 = queries.map((q) => run(q, [], [1]));

    const results: Record<string, { runs: QueryRun[] }> = {
      'a/V1': { runs: aV1 },
      'a/V2': { runs: aV2 },
      'a/V3': { runs: aV3 },
      'a/V4': { runs: aV4 },
      'b/V1': { runs: bV1 },
      'b/V2': { runs: bV2 },
      'b/V3': { runs: bV3 },
      'b/V4': { runs: bV4 },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const models = [{ id: 'a' }, { id: 'b' }];
    const lines = significanceLines(models, results, { pairedSignificance, score });

    // Assert exact output lines from dev's loop
    expect(lines).toEqual([
      'a     V1→V2 (title prefix @500): 1W/1L · p=1.0000 · no credible change',
      'a     V1→V3 (bigger chunk, no prefix): 12W/0L · p=0.0005 · IMPROVEMENT',
      'a     V1→V4 (both): 3W/0L · p=0.2500 · no credible change',
      'a     V3→V4 (title prefix @667): 3W/12L · p=0.0352 · REGRESSION',
      'b     V1→V2 (title prefix @500): 5W/10L · p=0.3018 · no credible change',
      'b     V1→V3 (bigger chunk, no prefix): 15W/0L · p=0.0001 · IMPROVEMENT',
      'b     V1→V4 (both): 0W/15L · p=0.0001 · REGRESSION',
      'b     V3→V4 (title prefix @667): 0W/30L · p=0.0000 · REGRESSION',
    ]);
  });

  it('handles multiple models where one is missing a variant', () => {
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V1': { runs: [run('q1', [1], [1])] },
      'bge-m3/V2': { runs: [run('q1', [1], [1])] },
      'bge-m3/V3': { runs: [run('q1', [1], [1])] },
      // bge-m3/V4 missing
      'qwen/V1': { runs: [run('q1', [1], [1])] },
      'qwen/V2': { runs: [run('q1', [1], [1])] },
      'qwen/V3': { runs: [run('q1', [1], [1])] },
      'qwen/V4': { runs: [run('q1', [1], [1])] },
    };

    const models: ModelCfg[] = [
      { id: 'bge-m3' },
      { id: 'qwen' },
    ];

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(models, results, { pairedSignificance, score });

    // bge-m3 should have 2 lines (V1→V2, V1→V3; no V1→V4 or V3→V4 since V4 missing)
    // qwen should have 4 lines (V1→V2, V1→V3, V1→V4, V3→V4)
    const bgeLines = lines.filter((l) => l.startsWith('bge-m3'));
    const qwenLines = lines.filter((l) => l.startsWith('qwen'));

    expect(bgeLines).toHaveLength(2);
    expect(qwenLines).toHaveLength(4);
  });
});
