import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Lockfile floors for Dependabot advisories on transitive packages. Their
 * parents' ranges still admit (or pin) vulnerable versions, so only the
 * lockfile or a root override keeps the fix. A reintroduced vulnerable version
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

function versionAtLeast(version: string, floor: string): boolean {
  const [a, b] = [version, floor].map((v) => v.split('-')[0]!.split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

function belowFloor(name: string, floor: string): string[] {
  const versions = installed(lockPackages(), name);
  expect(versions.length).toBeGreaterThan(0);
  return versions.filter((version) => !versionAtLeast(version, floor));
}

describe('npm advisory floors', () => {
  it('resolves smol-toml past the quadratic parseKey scan (GHSA-r4xh-jqrq-34v2)', () => {
    expect(belowFloor('smol-toml', '1.9.0')).toEqual([]);
  });

  it('resolves sharp to a build bundling librsvg 2.63.2 (GHSA-wq5f-xc86-pv6w)', () => {
    expect(belowFloor('sharp', '0.35.5')).toEqual([]);
  });

  it('resolves shell-quote past the quote() comment injection (GHSA-pqg4-j6r4-53mv)', () => {
    expect(belowFloor('shell-quote', '1.11.0')).toEqual([]);
  });

  it('resolves postcss-selector-parser past the quadratic flat-selector parse (GHSA-rj75-hqrm-r3gf)', () => {
    expect(belowFloor('postcss-selector-parser', '7.1.6')).toEqual([]);
  });

  it('resolves katex past the inherited-trust prototype gadget (GHSA-238p-pmpm-9mq7)', () => {
    expect(belowFloor('katex', '0.18.2')).toEqual([]);
  });

  it('does not install extract-zip (GHSA-7pqw-9j4j-h8q3, GHSA-jmr9-qjv8-65gv)', () => {
    expect(installed(lockPackages(), 'extract-zip')).toEqual([]);
  });
});
