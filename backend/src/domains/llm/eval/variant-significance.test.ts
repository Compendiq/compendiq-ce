import { describe, expect, it } from 'vitest';
import { significanceLines, type ModelCfg } from './variant-significance.js';
import { pairedSignificance, recallAtK, type QueryRun } from './metrics.js';

function run(id: string, retrieved: number[], expected: number[]): QueryRun {
  return { queryId: id, retrieved, expected };
}

describe('significanceLines', () => {
  const dummyModels: ModelCfg[] = [{ id: 'bge-m3', label: 'BGE M3', model: 'dummy', prefix: true }];

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

  it('emits nothing when V2 and V4 only (no canonical pair)', () => {
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V2': { runs: [run('q1', [1, 2], [1])] },
      'bge-m3/V4': { runs: [run('q1', [1, 4], [1])] },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    // V2→V4 is not a canonical pair, so no output
    expect(lines).toHaveLength(0);
  });

  it('handles a single variant without error', () => {
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V1': { runs: [run('q1', [1, 2], [1])] },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    expect(lines).toHaveLength(0);
  });

  it('preserves output format for full four-variant path', () => {
    const runs1 = [run('q1', [1], [1])];
    const runs2 = [run('q1', [1], [1])];
    const runs3 = [run('q1', [1], [1])];
    const runs4 = [run('q1', [1], [1])];

    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V1': { runs: runs1 },
      'bge-m3/V2': { runs: runs2 },
      'bge-m3/V3': { runs: runs3 },
      'bge-m3/V4': { runs: runs4 },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    // Should have 4 lines: V1→V2, V1→V3, V1→V4, V3→V4
    expect(lines).toHaveLength(4);
    // Check order
    expect(lines[0]).toContain('V1→V2');
    expect(lines[1]).toContain('V1→V3');
    expect(lines[2]).toContain('V1→V4');
    expect(lines[3]).toContain('V3→V4');
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
      { id: 'bge-m3', label: 'BGE M3', model: 'dummy', prefix: true },
      { id: 'qwen', label: 'Qwen', model: 'dummy', prefix: true },
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
