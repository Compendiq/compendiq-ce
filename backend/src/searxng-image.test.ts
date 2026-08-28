import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const searxngDir = join(repoRoot, 'docker', 'searxng');
const limiterSource = join(searxngDir, 'limiter.toml');
const limiterRenderer = join(searxngDir, 'render-limiter.py');
const trackerPatcher = join(searxngDir, 'patch-tracker-patterns.py');
const trackerBaseline = join(searxngDir, 'tracker-patterns-baseline.json');

function renderLimiter(trustedProxies?: string) {
  const tempDir = mkdtempSync(join(tmpdir(), 'compendiq-searxng-limiter-'));
  const output = join(tempDir, 'limiter.toml');
  const env = { ...process.env };
  if (trustedProxies === undefined) delete env.SEARXNG_TRUSTED_PROXIES;
  else env.SEARXNG_TRUSTED_PROXIES = trustedProxies;

  const result = spawnSync(
    'python3',
    [limiterRenderer, '--source', limiterSource, '--output', output],
    { encoding: 'utf8', env },
  );
  return { tempDir, output, result };
}

function parseToml(path: string): Record<string, unknown> {
  const parsed = spawnSync(
    'python3',
    [
      '-c',
      'import json, pathlib, sys, tomllib; print(json.dumps(tomllib.loads(pathlib.Path(sys.argv[1]).read_text())))',
      path,
    ],
    { encoding: 'utf8' },
  );
  expect(parsed.status, parsed.stderr).toBe(0);
  return JSON.parse(parsed.stdout) as Record<string, unknown>;
}

const upstreamTrackerFixture = `import re

class HTTPError(Exception):
    pass

class Log:
    def debug(self, *args):
        pass
    def warning(self, *args):
        pass
    def error(self, *args):
        pass

log = Log()

def http_get(url, timeout):
    raise HTTPError(url)

RuleType = tuple[str, list[str], list[str]]

class TrackerPatternsDB:
    CLEAR_LIST_URL = ["https://rules.invalid/one", "https://rules.invalid/two"]

    class Fields:
        url_regexp = 0
        url_ignore = 1
        del_args = 2

    def iter_clear_list(self):
        resp = None
        for url in self.CLEAR_LIST_URL:
            log.debug("TRACKER_PATTERNS: Trying to fetch %s...", url)
            try:
                resp = http_get(url, timeout=3)

            except HTTPError as exc:
                log.warning("TRACKER_PATTERNS: HTTPError (%s) occured while fetching %s", url, exc)
                continue

            if resp.status_code != 200:
                log.warning(f"TRACKER_PATTERNS: ClearURL ignore HTTP {resp.status_code} {url}")
                continue

            break

        if resp is None:
            log.error("TRACKER_PATTERNS: failed fetching ClearURL rule lists")
            return

        for rule in resp.json()["providers"].values():
            yield (
                rule["urlPattern"].replace("\\\\\\\\", "\\\\"),  # fix javascript regex syntax
                [exc.replace("\\\\\\\\", "\\\\") for exc in rule.get("exceptions", [])],
                rule.get("rules", []),
            )
`;

describe('SearXNG limiter configuration (#1440)', () => {
  it('renders valid TOML with loopback-only trusted proxies by default', () => {
    const rendered = renderLimiter();
    try {
      expect(rendered.result.status, rendered.result.stderr).toBe(0);
      const toml = parseToml(rendered.output);
      expect(toml).toMatchObject({
        botdetection: {
          trusted_proxies: ['127.0.0.0/8', '::1'],
        },
      });
      expect(readFileSync(rendered.output, 'utf8')).not.toContain('172.18.0.0/16');
      expect(readFileSync(limiterSource, 'utf8')).not.toContain('172.18.0.0/16');
    } finally {
      rmSync(rendered.tempDir, { recursive: true, force: true });
    }
  });

  it('safely parses and normalizes an explicit comma-separated proxy list', () => {
    const rendered = renderLimiter('10.20.30.40, 192.0.2.64/26, 2001:db8::/64');
    try {
      expect(rendered.result.status, rendered.result.stderr).toBe(0);
      const toml = parseToml(rendered.output) as {
        botdetection: { trusted_proxies: string[] };
      };
      expect(toml.botdetection.trusted_proxies).toEqual([
        '10.20.30.40/32',
        '192.0.2.64/26',
        '2001:db8::/64',
      ]);
    } finally {
      rmSync(rendered.tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed trusted-proxy configuration', () => {
    const rendered = renderLimiter('10.0.0.0/8, definitely-not-an-address');
    try {
      expect(rendered.result.status).not.toBe(0);
      expect(rendered.result.stderr).toContain('invalid trusted proxy');
      expect(readFileSync(limiterSource, 'utf8')).not.toContain('definitely-not-an-address');
    } finally {
      rmSync(rendered.tempDir, { recursive: true, force: true });
    }
  });

  it('passes the trusted-proxy setting through canonical and installer compose', () => {
    const compose = readFileSync(join(repoRoot, 'docker', 'docker-compose.yml'), 'utf8');
    const installer = readFileSync(join(repoRoot, 'scripts', 'install.sh'), 'utf8');
    const interpolation = 'SEARXNG_TRUSTED_PROXIES: ${SEARXNG_TRUSTED_PROXIES:-}';
    expect(compose).toContain(interpolation);
    expect(installer).toContain(interpolation);
  });
});

describe('SearXNG tracker-pattern fallback (#1440)', () => {
  it('bundles a pinned, licensed baseline with useful tracker rules', () => {
    const baseline = JSON.parse(readFileSync(trackerBaseline, 'utf8')) as {
      _provenance: { source_commit: string; license: string };
      providers: Record<string, { rules: string[] }>;
    };
    expect(baseline._provenance).toEqual(expect.objectContaining({
      source_commit: '11086f40512774dcadef54079f1ba023bfacf940',
      license: 'LGPL-3.0-or-later',
    }));
    expect(baseline.providers.globalRules.rules).toEqual(expect.arrayContaining([
      '(?:%3F)?utm(?:_[a-z_]*)?',
      '(?:%3F)?fbclid',
      '(?:%3F)?gclid',
    ]));
  });

  it('loads the bundled baseline when every remote ClearURLs request fails', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'compendiq-searxng-tracker-'));
    const modulePath = join(tempDir, 'tracker_patterns.py');
    writeFileSync(modulePath, upstreamTrackerFixture);
    try {
      const patched = spawnSync('python3', [trackerPatcher, modulePath], { encoding: 'utf8' });
      expect(patched.status, patched.stderr).toBe(0);

      const exercised = spawnSync(
        'python3',
        [
          '-c',
          `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("tracker_patterns", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.TRACKER_PATTERNS_FALLBACK = sys.argv[2]
rules = list(module.TrackerPatternsDB().iter_clear_list())
print(json.dumps(rules))`,
          modulePath,
          trackerBaseline,
        ],
        { encoding: 'utf8' },
      );
      expect(exercised.status, exercised.stderr).toBe(0);
      const rules = JSON.parse(exercised.stdout) as [string, string[], string[]][];
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.some((rule) => rule[2].includes('(?:%3F)?utm(?:_[a-z_]*)?'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('removes stale compiled bytecode after patching the upstream module', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'compendiq-searxng-pyc-'));
    const modulePath = join(tempDir, 'tracker_patterns.py');
    const pycache = join(tempDir, '__pycache__');
    const staleBytecode = join(pycache, 'tracker_patterns.cpython-314.pyc');
    writeFileSync(modulePath, upstreamTrackerFixture);
    mkdirSync(pycache);
    writeFileSync(staleBytecode, 'stale upstream bytecode');
    try {
      const patched = spawnSync('python3', [trackerPatcher, modulePath], { encoding: 'utf8' });
      expect(patched.status, patched.stderr).toBe(0);
      expect(existsSync(staleBytecode)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails loudly when the expected upstream patch point drifts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'compendiq-searxng-drift-'));
    const modulePath = join(tempDir, 'tracker_patterns.py');
    writeFileSync(modulePath, upstreamTrackerFixture.replace('if resp is None:', 'if not resp:'));
    try {
      const patched = spawnSync('python3', [trackerPatcher, modulePath], { encoding: 'utf8' });
      expect(patched.status).not.toBe(0);
      expect(patched.stderr).toContain('upstream tracker_patterns.py changed');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
