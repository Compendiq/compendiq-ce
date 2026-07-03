import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Deployment-config security invariants (issue #740).
 *
 * These tests parse the committed compose files and the installer script and
 * assert the hardening rules they must uphold:
 *
 * 1. The backend container is never published on the host — all API traffic
 *    must go through the frontend nginx proxy, which is where the CSP and
 *    security headers live (`frontend/nginx-security-headers.conf`).
 * 2. `POSTGRES_PASSWORD` / `REDIS_PASSWORD` are required (`${VAR:?...}`)
 *    with no `changeme-*` defaults baked into the compose file.
 * 3. Redis runs with `maxmemory-policy noeviction` everywhere — BullMQ keeps
 *    queue/job state in Redis and its docs state noeviction is the only
 *    policy that guarantees correct queue behaviour. `allkeys-lru` silently
 *    evicts jobs under memory pressure.
 * 4. The dev compose override only ever publishes data-tier ports on
 *    loopback (127.0.0.1), never 0.0.0.0.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const composeProd = readFileSync(join(repoRoot, 'docker', 'docker-compose.yml'), 'utf8');
const composeDev = readFileSync(join(repoRoot, 'docker', 'docker-compose.dev.yml'), 'utf8');
const composeTest = readFileSync(join(repoRoot, 'docker', 'docker-compose.test.yml'), 'utf8');
const installSh = readFileSync(join(repoRoot, 'scripts', 'install.sh'), 'utf8');
const dockerignore = readFileSync(join(repoRoot, '.dockerignore'), 'utf8');
const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8');
const prCheckWorkflow = readFileSync(
  join(repoRoot, '.github', 'workflows', 'pr-check.yml'),
  'utf8',
);

/**
 * Extract a top-level service block (2-space indented key under `services:`)
 * from a compose file. Returns the lines belonging to that service only.
 */
function extractServiceBlock(composeText: string, serviceName: string): string {
  const lines = composeText.split('\n');
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  expect(start, `service "${serviceName}" not found in compose file`).toBeGreaterThanOrEqual(0);

  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop at the next key indented by 0 or 2 spaces (next service or top-level key)
    if (/^ {0,2}\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

/** All `${VAR...}` interpolations of a given variable name. */
function interpolationsOf(text: string, varName: string): string[] {
  return [...text.matchAll(new RegExp(`\\$\\{${varName}([^}]*)\\}`, 'g'))].map((m) => m[1]);
}

describe('docker/docker-compose.yml security invariants', () => {
  it('does not publish the backend on the host (must be reached via the frontend proxy)', () => {
    const backend = extractServiceBlock(composeProd, 'backend');
    expect(backend).not.toMatch(/^\s+ports:/m);
    expect(composeProd).not.toContain('BACKEND_HOST_PORT');
  });

  it('ships no changeme-* default credentials', () => {
    expect(composeProd).not.toContain('changeme-postgres');
    expect(composeProd).not.toContain('changeme-redis');
  });

  it.each(['POSTGRES_PASSWORD', 'REDIS_PASSWORD'])(
    'requires %s via :? interpolation with no default',
    (varName) => {
      const usages = interpolationsOf(composeProd, varName);
      expect(usages.length).toBeGreaterThan(0);
      for (const modifier of usages) {
        // No `:-`/`-` default values — only required (`:?`) or bare usage
        expect(modifier).not.toMatch(/^:?-/);
      }
      // At least one usage must hard-require the variable with a helpful message
      expect(usages.some((modifier) => modifier.startsWith(':?'))).toBe(true);
    },
  );

  it.each(['POSTGRES_PASSWORD', 'REDIS_PASSWORD'])(
    'recommends a URL-safe generator (rand -hex) in %s error messages',
    (varName) => {
      // The passwords are interpolated raw into POSTGRES_URL/REDIS_URL, so the
      // suggested generator must never emit URL-breaking chars: base64 output
      // contains '/' ~40% of the time (plus '+'/'='), which makes
      // pg-connection-string / new URL() throw and the backend crash-loop.
      const messages = interpolationsOf(composeProd, varName).filter((modifier) =>
        modifier.startsWith(':?'),
      );
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        expect(message).toMatch(/rand -hex/);
        expect(message).not.toMatch(/rand -base64/);
      }
    },
  );

  it('runs Redis with noeviction so BullMQ jobs are never evicted', () => {
    const redis = extractServiceBlock(composeProd, 'redis');
    expect(redis).toContain('--maxmemory-policy noeviction');
    expect(composeProd).not.toContain('allkeys-lru');
  });
});

describe('docker/docker-compose.dev.yml security invariants', () => {
  it('publishes data-tier ports on loopback only', () => {
    const hostIps = [...composeDev.matchAll(/host_ip:\s*(\S+)/g)].map((m) => m[1]);
    // postgres + redis overrides must both pin an explicit host_ip
    expect(hostIps.length).toBeGreaterThanOrEqual(2);
    for (const ip of hostIps) {
      expect(ip).toBe('127.0.0.1');
    }
    // No wildcard binds anywhere in the effective config (comments excluded)
    const configLines = composeDev
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(configLines).not.toContain('0.0.0.0');
  });
});

describe('scripts/install.sh invariants', () => {
  it('generates a Redis config with noeviction (BullMQ requirement), not allkeys-lru', () => {
    expect(installSh).toContain('--maxmemory-policy noeviction');
    expect(installSh).not.toContain('allkeys-lru');
  });

  it('generates the mcp-docs and searxng sidecars so MCP web-docs works out of the box', () => {
    // The canonical docker/docker-compose.yml ships both sidecars; the
    // installer compose must not drift or MCP_DOCS_URL points at a host that
    // does not exist in the generated deployment.
    expect(installSh).toContain('ghcr.io/compendiq/compendiq-ce-mcp-docs:');
    expect(installSh).toContain('ghcr.io/compendiq/compendiq-ce-searxng:');
  });

  it('points the backend at the mcp-docs sidecar', () => {
    expect(installSh).toContain('MCP_DOCS_URL:');
  });
});

describe('docker/docker-compose.test.yml security invariants', () => {
  it('publishes the test Postgres on loopback only (127.0.0.1), never 0.0.0.0', () => {
    const pg = extractServiceBlock(composeTest, 'postgres-test');
    const hostIps = [...pg.matchAll(/host_ip:\s*(\S+)/g)].map((m) => m[1]);
    expect(hostIps.length).toBeGreaterThanOrEqual(1);
    for (const ip of hostIps) {
      expect(ip).toBe('127.0.0.1');
    }
    // No short-form "<hostPort>:5432" publish, which binds all interfaces.
    expect(pg).not.toMatch(/["']?\d+:5432["']?/);
  });
});

describe('.dockerignore excludes nested env secrets from build contexts', () => {
  it('ignores .env at any depth (e.g. docker/.env) via recursive patterns', () => {
    const patterns = dockerignore.split('\n').map((line) => line.trim());
    expect(patterns).toContain('**/.env');
    expect(patterns).toContain('**/.env.*');
  });
});

describe('.env.example stays authoritative for env vars the backend reads', () => {
  it.each([
    'SEARXNG_URL',
    'REEMBED_WAIT_LOCKS_MS',
    'RETENTION_ADMIN_ACCESS_DENIED_DAYS',
    'RETENTION_PENDING_SYNC_VERSIONS_DAYS',
  ])('documents %s', (varName) => {
    expect(envExample).toContain(varName);
  });

  it('does not document EMBEDDING_CONCURRENCY, which no code reads', () => {
    expect(envExample).not.toContain('EMBEDDING_CONCURRENCY');
  });
});

describe('.github/workflows/pr-check.yml runs validation for every author', () => {
  it('does not skip typecheck/lint/test/hoist checks for Dependabot PRs', () => {
    expect(prCheckWorkflow).not.toContain('dependabot[bot]');
  });
});
