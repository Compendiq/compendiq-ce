import { describe, it, expect } from 'vitest';
import { computeImageAnalysisReadiness, type ReadinessRow } from './image-analysis-readiness.js';
import { IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION } from './image-analysis-provider.js';

const RETAINED = 'hash-a';
function row(status: string, opts: { hash?: string; prompt?: number; schema?: number; reason?: string } = {}): ReadinessRow {
  return {
    status,
    skip_reason: opts.reason ?? (status === 'skipped' ? 'unsupported' : null),
    identity_hash: opts.hash ?? RETAINED,
    prompt_version: opts.prompt ?? IMAGE_ANALYSIS_PROMPT_VERSION,
    schema_version: opts.schema ?? IMAGE_ANALYSIS_SCHEMA_VERSION,
  };
}
const under = (rows: ReadinessRow[], hash: string | null = RETAINED) =>
  computeImageAnalysisReadiness(rows, { identityHash: hash });

describe('computeImageAnalysisReadiness (ADR-027, pure)', () => {
  it('is none with no rows', () => {
    expect(under([])).toBe('none');
  });

  it('is complete when every row is valid or skipped by policy or format, with at least one valid', () => {
    expect(under([row('analyzed'), row('skipped')])).toBe('complete');
    expect(under([row('analyzed'), row('skipped', { reason: 'capped' }), row('skipped', { reason: 'external' })])).toBe('complete');
  });

  it('is partial when a valid row sits beside pending or failed work', () => {
    expect(under([row('analyzed'), row('pending')])).toBe('partial');
    expect(under([row('analyzed'), row('failed_terminal')])).toBe('partial');
  });

  it('is partial, not complete, when a valid row sits beside an image whose bytes are missing', () => {
    // "keep failed/missing analyses pending and report partial" (#1616): the
    // page references evidence the index does not hold. A page that is
    // ONLY missing rows still reads skipped — nothing is in the window.
    expect(under([row('analyzed'), row('skipped', { reason: 'missing' })])).toBe('partial');
    expect(under([row('skipped', { reason: 'missing' })])).toBe('skipped');
  });

  it('is pending before failed: any pending row wins over failures when nothing is valid', () => {
    expect(under([row('failed'), row('pending')])).toBe('pending');
    expect(under([row('failed_terminal'), row('failed')])).toBe('failed');
  });

  it('is skipped only when every row is skipped', () => {
    expect(under([row('skipped'), row('skipped')])).toBe('skipped');
  });

  it('reads a stale analyzed row as pending — the sweep makes it literal later', () => {
    expect(under([row('analyzed', { hash: 'hash-b' })])).toBe('pending');
    expect(under([row('analyzed', { prompt: IMAGE_ANALYSIS_PROMPT_VERSION + 1 })])).toBe('pending');
    expect(under([row('analyzed', { schema: IMAGE_ANALYSIS_SCHEMA_VERSION + 1 })])).toBe('pending');
    // Nothing retained: no row can be valid, so an analyzed row is pending here too.
    expect(under([row('analyzed')], null)).toBe('pending');
  });
});
