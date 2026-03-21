import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Issue #497: Verify that StrictMode is present and documented.
 *
 * React StrictMode double-renders in dev mode, which causes duplicate DOM nodes
 * visible in Playwright accessibility snapshots. This is expected behavior and
 * does NOT affect production builds. A comment in main.tsx explains this.
 */
describe('main.tsx StrictMode documentation (#497)', () => {
  const source = readFileSync(resolve(__dirname, 'main.tsx'), 'utf-8');

  it('imports StrictMode from react', () => {
    expect(source).toContain("import { StrictMode } from 'react'");
  });

  it('wraps the app in <StrictMode>', () => {
    expect(source).toContain('<StrictMode>');
    expect(source).toContain('</StrictMode>');
  });

  it('contains a comment explaining dev-mode double-rendering', () => {
    expect(source).toContain('StrictMode intentionally double-renders');
    expect(source).toContain('does NOT affect');
    expect(source).toContain('production');
  });
});
