import { describe, it, expect } from 'vitest';
import { lowlight } from './lowlight';

describe('lowlight singleton', () => {
  it('exports a lowlight instance', () => {
    expect(lowlight).toBeDefined();
  });

  it('has common languages registered', () => {
    // common bundle includes javascript, typescript, css, etc.
    expect(lowlight.registered('javascript')).toBe(true);
    expect(lowlight.registered('typescript')).toBe(true);
    expect(lowlight.registered('css')).toBe(true);
  });

  it('returns the same instance on repeated imports', async () => {
    const { lowlight: secondImport } = await import('./lowlight');
    expect(secondImport).toBe(lowlight);
  });

  it('can highlight code', () => {
    const result = lowlight.highlight('javascript', 'const x = 1;');
    expect(result).toBeDefined();
    expect(result.children.length).toBeGreaterThan(0);
  });
});
