import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pins the Playwright project graph for #1449. `workers: 1` only serializes
 * collab against itself; without `dependencies: ['chromium']` a full
 * `npx playwright test` still runs collab in the same phase as chromium and
 * the flag can turn on under other specs.
 */
const config = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../playwright.config.ts'),
  'utf8',
);

function projectBlock(name: string): string {
  const marker = `name: '${name}'`;
  const start = config.indexOf(marker);
  expect(start, `missing project ${name}`).toBeGreaterThan(-1);
  const brace = config.lastIndexOf('{', start);
  expect(brace).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = brace; i < config.length; i++) {
    if (config[i] === '{') depth += 1;
    else if (config[i] === '}') {
      depth -= 1;
      if (depth === 0) return config.slice(brace, i + 1);
    }
  }
  throw new Error(`unclosed project block for ${name}`);
}

describe('collab Playwright project (#1449)', () => {
  it("depends on chromium so a full run waits until the default suite finishes", () => {
    const collab = projectBlock('collab');
    expect(collab).toMatch(/dependencies:\s*\[\s*'chromium'\s*\]/);
    expect(projectBlock('chromium')).not.toMatch(/dependencies:/);
  });
});
