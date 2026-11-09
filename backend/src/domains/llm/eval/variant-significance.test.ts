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

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('V1→V3');
  });

  it('emits one pair for V3,V4 only', () => {
    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V3': { runs: [run('q1', [1, 3], [1])] },
      'bge-m3/V4': { runs: [run('q1', [1, 4], [1])] },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('V3→V4');
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
    // Create varied fixture: 30 queries with different win ratios per variant
    // to ensure the output format is correct (W/L counts and p-values)
    const queries = Array.from({ length: 30 }, (_, i) => `q${i + 1}`);
    const v1Runs = queries.map((q, i) => run(q, i < 20 ? [1] : [], [1])); // 20W / 10L
    const v2Runs = queries.map((q, i) => run(q, i < 18 ? [1] : [], [1])); // 18W / 12L
    const v3Runs = queries.map((q, i) => run(q, i < 22 ? [1] : [], [1])); // 22W / 8L
    const v4Runs = queries.map((q, i) => run(q, i < 17 ? [1] : [], [1])); // 17W / 13L

    const results: Record<string, { runs: QueryRun[] }> = {
      'bge-m3/V1': { runs: v1Runs },
      'bge-m3/V2': { runs: v2Runs },
      'bge-m3/V3': { runs: v3Runs },
      'bge-m3/V4': { runs: v4Runs },
    };

    const score = (r: QueryRun) => recallAtK([r], 5);
    const lines = significanceLines(dummyModels, results, { pairedSignificance, score });

    // Should have 4 lines: V1→V2, V1→V3, V1→V4, V3→V4
    expect(lines).toHaveLength(4);
    
    // Check order and format
    expect(lines[0]).toMatch(/^bge-m3\s+V1→V2.*:\s+\d+W\/\d+L · p=[\d.]+/);
    expect(lines[1]).toMatch(/^bge-m3\s+V1→V3.*:\s+\d+W\/\d+L · p=[\d.]+/);
    expect(lines[2]).toMatch(/^bge-m3\s+V1→V4.*:\s+\d+W\/\d+L · p=[\d.]+/);
    expect(lines[3]).toMatch(/^bge-m3\s+V3→V4.*:\s+\d+W\/\d+L · p=[\d.]+/);

    // Verify exact order of pairs
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
