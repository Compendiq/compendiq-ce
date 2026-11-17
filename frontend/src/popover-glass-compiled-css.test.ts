import { describe, it, expect, beforeAll } from 'vitest';
import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

/**
 * #2042 — floating popovers rendered with no blur in Chrome and Firefox.
 *
 * The source CSS declared `backdrop-filter` and `-webkit-backdrop-filter`
 * together, and Lightning CSS (Tailwind's minifier) collapsed that pair to the
 * prefixed declaration alone. Safari reads the prefix, so it looked right;
 * Chrome and Firefox only read the unprefixed property, so the popover was a
 * bare translucent fill over unblurred content. Source-text tests cannot see
 * this, so compile the real stylesheet exactly as production does and inspect
 * what the browser would receive.
 */
const ROOT = resolve(__dirname, '..');

async function compileIndexCss(): Promise<string> {
  const result = await build({
    root: ROOT,
    configFile: false,
    logLevel: 'silent',
    plugins: [tailwindcss()],
    build: {
      write: false,
      minify: true,
      cssMinify: 'lightningcss',
      rollupOptions: { input: resolve(ROOT, 'src/index.css') },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((r) => r.output) : 'output' in result ? result.output : [];
  const css = outputs.find((o) => o.type === 'asset' && o.fileName.endsWith('.css'));
  if (!css || css.type !== 'asset') throw new Error('index.css produced no CSS asset');
  return String(css.source);
}

/** Every rule body whose selector list contains `selector` as a class. */
function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(',').some((s) => s.trim().endsWith(selector))) bodies.push(m[2]!);
  }
  return bodies;
}

describe('compiled popover glass (#2042)', () => {
  let css = '';
  beforeAll(async () => {
    css = await compileIndexCss();
  }, 60_000);

  it('nm-popover-glass ships the standard backdrop-filter Chrome and Firefox read', () => {
    const decls = ruleBodies(css, '.nm-popover-glass').join(';');
    expect(decls).toMatch(/(^|;)backdrop-filter:blur\(12px\)/);
  });

  it('nm-popover-glass keeps the -webkit- twin for Safari', () => {
    const decls = ruleBodies(css, '.nm-popover-glass').join(';');
    expect(decls).toMatch(/-webkit-backdrop-filter:blur\(12px\)/);
  });

  it('every rule that blurs behind a surface ships the standard property', () => {
    const missing: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*-webkit-backdrop-filter:[^{}]*)\}/g)) {
      if (!/(^|;)backdrop-filter:/.test(m[2]!)) missing.push(m[1]!.trim());
    }
    // `.transition` only lists the property names in `transition-property`.
    expect(missing.filter((s) => s !== '.transition')).toEqual([]);
  });

  it('prefers-reduced-transparency drops the blur for the standard property too', () => {
    const reduced = css.match(/@media \(prefers-reduced-transparency:\s*reduce\)\{(.*?\})\}/)?.[1] ?? '';
    expect(reduced).toMatch(/(^|[;{])backdrop-filter:none/);
  });
});
