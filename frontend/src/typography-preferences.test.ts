import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const frontendRoot = resolve(__dirname, '..');
const css = readFileSync(resolve(frontendRoot, 'src/index.css'), 'utf8');
const indexHtml = readFileSync(resolve(frontendRoot, 'index.html'), 'utf8');
const csp = readFileSync(resolve(frontendRoot, 'nginx-security-headers.conf'), 'utf8');

describe('typography preference wiring', () => {
  it('ships the selectable non-system fonts locally', () => {
    expect(css).toContain('@import "@fontsource/atkinson-hyperlegible/400.css";');
    expect(css).toContain('@import "@fontsource/source-serif-4/400.css";');
    expect(css).toContain("url('/fonts/opendyslexic/OpenDyslexicAlta-Regular.otf') format('opentype')");
    expect(css).not.toMatch(/url\(['"]https?:/);
  });

  it('keeps application and reading-pane font scopes explicit in CSS', () => {
    expect(css).toContain('html[data-font-scope="application"]');
    expect(css).toContain('html[data-font-scope="reading-pane"] .article-viewer');
    expect(css).toContain("--font-sans: 'Inter Variable'");
    expect(css).toContain('font-family: var(--font-sans);');
  });

  it('keeps enhanced spacing out of code metrics', () => {
    expect(css).toContain('line-height: 1.8;');
    expect(css).toContain('letter-spacing: 0.02em;');
    expect(css).toContain('word-spacing: 0.16em;');
    expect(css).toContain('html[data-dyslexia-spacing="true"] :where(.prose) :where(pre, code)');
    expect(css).toContain('font-family: var(--font-mono);');
  });

  it('bootstraps typography before React and authorizes the updated script hash', () => {
    expect(indexHtml).toContain('data-font="inter"');
    expect(indexHtml).toContain("localStorage.getItem('compendiq-theme')");
    expect(indexHtml).toContain("'data-dyslexia-spacing'");
    expect(csp).toContain("script-src 'self' 'sha256-");
  });
});
