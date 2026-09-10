import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Lockfile floors for open Dependabot advisories that we close with npm
 * overrides rather than parent upgrades. A reintroduced vulnerable version
 * is a consumer-visible install, not an implementation detail of package.json.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type LockPackages = Record<string, { version?: string } | undefined>;

function lockPackages(): LockPackages {
  return JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
    .packages as LockPackages;
}

function installed(packages: LockPackages, name: string): string[] {
  const suffix = `node_modules/${name}`;
  return Object.entries(packages)
    .filter(([key]) => key === suffix || key.endsWith(`/${suffix}`))
    .map(([, meta]) => meta?.version)
    .filter((version): version is string => typeof version === 'string');
}

describe('npm advisory floors', () => {
  it('resolves smol-toml past the infinite-loop parse (GHSA-7w5x-hrqm-74c2)', () => {
    expect(installed(lockPackages(), 'smol-toml')).toEqual(['1.8.0']);
  });

  it('resolves sharp past the libheif advisories (GHSA-rgj7-g3m4-5g8c)', () => {
    expect(installed(lockPackages(), 'sharp')).toEqual(['0.35.4']);
  });

  it('does not install extract-zip (GHSA-7pqw-9j4j-h8q3, GHSA-jmr9-qjv8-65gv)', () => {
    expect(installed(lockPackages(), 'extract-zip')).toEqual([]);
  });
});
