import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `Missing ${selector} rule`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Library search control styling', () => {
  it('uses a real flat boundary and translucent workspace card background around the compound search surface', () => {
    const surface = rule('.library-search-surface');
    const modes = rule('.library-search-modes');
    expect(surface).toContain('background: var(--workspace-card-bg)');
    expect(surface).toContain('border: 1px solid var(--color-border-interactive)');
    expect(surface).not.toContain('box-shadow');
    expect(modes).toContain('background: var(--workspace-well-bg)');
  });

  it('gives the selected search mode a high-contrast filled state', () => {
    const activeMode = rule('.library-search-mode-active');
    expect(activeMode).toContain('background: var(--color-action)');
    expect(activeMode).toContain('color: var(--color-action-foreground)');
    expect(activeMode).toContain('border-color: var(--color-action)');
  });
});
