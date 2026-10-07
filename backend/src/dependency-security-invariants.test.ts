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

type LockPackages = Record<
  string,
  { version?: string; dependencies?: Record<string, string> } | undefined
>;

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

type Version = [number, number, number];
type UpperBound = { version: Version; inclusive: boolean };

function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/** `1.2.3` → given 3; `1.2` / `1.2.x` → given 2; `*` / `x` → given 0. */
function parsePartial(text: string): { version: Version; given: number } {
  const parts = text.split('-')[0]!.split('.');
  const numbers: number[] = [];
  for (const part of parts) {
    if (part === '' || /^[xX*]$/.test(part)) break;
    if (!/^\d+$/.test(part)) throw new Error(`unsupported version "${text}"`);
    numbers.push(Number(part));
  }
  const given = numbers.length;
  while (numbers.length < 3) numbers.push(0);
  return { version: numbers.slice(0, 3) as Version, given: Math.min(given, 3) };
}

function bump(version: Version, index: number): Version {
  return version.map((part, i) => (i < index ? part : i === index ? part + 1 : 0)) as Version;
}

/** Lower and upper bound of one comparator (`^1.2.3`, `~1.2`, `>=1`, `1.2.x`, …). */
function comparatorBounds(comparator: string): { lower?: Version; upper?: UpperBound } {
  const [, operator = '', operand = ''] = comparator.match(/^(\^|~|>=|<=|>|<|=)?v?(.*)$/)!;
  const { version, given } = parsePartial(operand);
  if (given === 0) {
    if (operator === '' || operator === '=' || operator === '>=') return {};
    throw new Error(`unsupported comparator "${comparator}"`);
  }
  switch (operator) {
    case '>=':
    case '>':
      return { lower: version };
    case '<':
      return { upper: { version, inclusive: false } };
    case '<=':
      return { upper: { version, inclusive: true } };
    case '^': {
      const firstNonZero = version.slice(0, given).findIndex((part) => part !== 0);
      const index = firstNonZero === -1 ? given - 1 : firstNonZero;
      return { lower: version, upper: { version: bump(version, index), inclusive: false } };
    }
    case '~':
      return { lower: version, upper: { version: bump(version, given >= 2 ? 1 : 0), inclusive: false } };
    default:
      return given === 3
        ? { lower: version, upper: { version, inclusive: true } }
        : { lower: version, upper: { version: bump(version, given - 1), inclusive: false } };
  }
}

/**
 * Whether `spec` admits any version at or above `floor`. Covers the range
 * forms parents publish (exact, `^`, `~`, x-ranges, comparator sets, `||`
 * unions); anything else throws, so an unparseable spec fails loudly instead
 * of silently disabling the override expiry check below. A `>X` lower bound
 * is treated as `>=X`, which only differs when the upper bound is also X.
 */
function rangeAdmitsAtLeast(spec: string, floor: string): boolean {
  const minimum = parsePartial(floor).version;
  return spec.split('||').some((alternative) => {
    if (/\s-\s/.test(alternative)) throw new Error(`unsupported hyphen range "${spec}"`);
    let lower: Version = minimum;
    let upper: UpperBound | undefined;
    for (const comparator of alternative.trim().split(/\s+/).filter(Boolean)) {
      const bounds = comparatorBounds(comparator);
      if (bounds.lower && compareVersions(bounds.lower, lower) > 0) lower = bounds.lower;
      if (bounds.upper && (!upper || compareVersions(bounds.upper.version, upper.version) < 0)) {
        upper = bounds.upper;
      }
    }
    if (!upper) return true;
    const gap = compareVersions(lower, upper.version);
    return gap < 0 || (gap === 0 && upper.inclusive);
  });
}

describe('npm advisory floors', () => {
  it('resolves smol-toml past the quadratic parseKey scan (GHSA-r4xh-jqrq-34v2)', () => {
    expect(belowFloor('smol-toml', '1.9.0')).toEqual([]);
  });

  it('resolves sharp past the bundled-librsvg advisory (GHSA-wq5f-xc86-pv6w)', () => {
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

/**
 * Root overrides that exist only because the parent's own range excludes every
 * patched release (see `//tooling-deps-note` in the root package.json). Once
 * the parent widens that range the override is dead weight — and can force a
 * downgrade below what the parent now asks for — so it has to be dropped.
 */
const parentBlockedOverrides = [
  { dep: 'katex', parent: 'mermaid', patched: '0.18.2' },
  { dep: 'postcss-selector-parser', parent: '@tailwindcss/typography', patched: '7.1.6' },
];

describe('root overrides waiting on a parent range', () => {
  const rootManifest: { overrides?: Record<string, string> } = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  );
  const overrides = rootManifest.overrides ?? {};

  it.each(parentBlockedOverrides)(
    '$dep is overridden only while $parent still excludes a patched release',
    ({ dep, parent, patched }) => {
      expect(overrides, `the ${dep} override is gone — remove its row here`).toHaveProperty(dep);
      const spec = lockPackages()[`node_modules/${parent}`]?.dependencies?.[dep];
      expect(spec, `${parent} no longer depends on ${dep} — drop the override in package.json`)
        .toBeTypeOf('string');
      expect(
        rangeAdmitsAtLeast(spec!, patched),
        `${parent} widened its ${dep} range to ${spec} — drop the override in package.json`,
      ).toBe(false);
    },
  );

  it.each([
    ['^0.16.47', '0.18.2', false],
    ['^0.18.0', '0.18.2', true],
    ['^0.19.0', '0.18.2', true],
    ['~0.18.1', '0.18.2', true],
    ['0.18.x', '0.18.2', true],
    ['^0.0.3', '0.0.4', false],
    ['6.0.10', '7.1.6', false],
    ['7.1.6', '7.1.6', true],
    ['^6.0.10', '7.1.6', false],
    ['^7.0.0', '7.1.6', true],
    ['>=6.0.0 <7.1.6', '7.1.6', false],
    ['>=6.0.0 <=7.1.6', '7.1.6', true],
    ['^6.0.10 || ^7.0.0', '7.1.6', true],
    ['*', '7.1.6', true],
  ] as const)('range %s admits a version >= %s: %s', (spec, floor, admits) => {
    expect(rangeAdmitsAtLeast(spec, floor)).toBe(admits);
  });

  it('refuses range forms it cannot evaluate', () => {
    expect(() => rangeAdmitsAtLeast('6.0.0 - 7.2.0', '7.1.6')).toThrow(/unsupported/);
    expect(() => rangeAdmitsAtLeast('github:user/repo', '7.1.6')).toThrow(/unsupported/);
  });
});
