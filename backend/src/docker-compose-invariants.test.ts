import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const dockerfileEnterprise = readFileSync(
  join(repoRoot, 'docker', 'Dockerfile.enterprise'),
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

/** The compose YAML the installer writes (the write_compose heredoc body). */
function extractInstallerCompose(script: string): string {
  const match = script.match(/<<'COMPOSEEOF'\n([\s\S]*?)\nCOMPOSEEOF/);
  expect(match, 'write_compose heredoc not found in install.sh').not.toBeNull();
  return match![1];
}

/** Map of top-level network name -> whether it is declared `internal: true`. */
function parseNetworkInternalFlags(composeText: string): Record<string, boolean> {
  const lines = composeText.split('\n');
  const start = lines.findIndex((line) => line === 'networks:');
  expect(start, 'top-level networks: block not found').toBeGreaterThanOrEqual(0);

  const flags: Record<string, boolean> = {};
  let current: string | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== '') break; // next top-level key
    const nameMatch = line.match(/^ {2}([\w-]+):\s*$/);
    if (nameMatch) {
      current = nameMatch[1];
      flags[current] = false;
      continue;
    }
    if (current && /^\s+internal:\s*true\b/.test(line)) {
      flags[current] = true;
    }
  }
  return flags;
}

/** The list of networks a service block attaches to (list form only). */
function serviceNetworks(serviceBlock: string): string[] {
  const lines = serviceBlock.split('\n');
  const start = lines.findIndex((line) => /^\s+networks:\s*$/.test(line));
  if (start < 0) return [];
  const nets: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue; // skip blank/comment lines
    const item = line.match(/^\s+-\s+([\w-]+)\s*$/);
    if (!item) break;
    nets.push(item[1]);
  }
  return nets;
}

/**
 * The list of networks a service block attaches to, INLINE flow form
 * (`networks: [a, b, c]`). docker/docker-compose.yml uses this form, which the
 * block-form `serviceNetworks()` above cannot parse.
 */
function serviceNetworksInline(serviceBlock: string): string[] {
  const match = serviceBlock.match(/^\s+networks:\s*\[([^\]]*)\]\s*$/m);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True when a service block drops ALL capabilities, in either inline
 * (`cap_drop: [ALL]`) or block (`cap_drop:\n  - ALL`) form.
 */
function hasCapDropAll(serviceBlock: string): boolean {
  return (
    /^\s+cap_drop:\s*\[[^\]]*\bALL\b[^\]]*\]\s*$/m.test(serviceBlock) ||
    /^\s+cap_drop:\s*$\n(?:\s+-\s+\w+\s*$\n?)*\s+-\s+ALL\b/m.test(serviceBlock)
  );
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

  it('gives the backend a stop_grace_period long enough for graceful shutdown (issue #931)', () => {
    // Docker defaults stop_grace_period to 10s and SIGKILLs the container after
    // it, which aborts the in-process graceful-shutdown timer
    // (DEFAULT_SHUTDOWN_TIMEOUT_MS = 50s in core/utils/graceful-shutdown.ts).
    // The grace period must exceed that timeout so the handler force-exits
    // itself before Docker resorts to SIGKILL. ADR-024 mandates 60s.
    const backend = extractServiceBlock(composeProd, 'backend');
    const match = backend.match(/^\s+stop_grace_period:\s*(\d+)s\b/m);
    expect(match, 'backend service must declare stop_grace_period').not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(60);
  });
});

describe('docker/docker-compose.yml network isolation (#1050)', () => {
  // The internet-facing frontend must share a network ONLY with the backend so
  // it can proxy /api, and can NOT reach redis/searxng/mcp-docs/postgres.
  it('puts the frontend on frontend-net only (not backend-net)', () => {
    const frontend = extractServiceBlock(composeProd, 'frontend');
    const nets = serviceNetworksInline(frontend);
    expect(nets).toEqual(['frontend-net']);
    expect(nets).not.toContain('backend-net');
  });

  it('puts the backend on frontend-net so the frontend can reach it', () => {
    const backend = extractServiceBlock(composeProd, 'backend');
    const nets = serviceNetworksInline(backend);
    expect(nets).toContain('frontend-net');
    expect(nets).toContain('backend-net');
    expect(nets).toContain('data-net');
  });

  it.each(['redis', 'searxng', 'mcp-docs', 'postgres'])(
    'keeps %s off frontend-net so the browser-facing container cannot reach it',
    (service) => {
      const nets = serviceNetworksInline(extractServiceBlock(composeProd, service));
      expect(nets).not.toContain('frontend-net');
    },
  );
});

describe('docker/docker-compose.yml container hardening (#1050)', () => {
  const services = ['frontend', 'backend', 'postgres', 'mcp-docs', 'searxng', 'redis'];

  it.each(services)('drops ALL Linux capabilities on %s', (service) => {
    expect(hasCapDropAll(extractServiceBlock(composeProd, service))).toBe(true);
  });

  it.each(services)('sets no-new-privileges on %s', (service) => {
    expect(extractServiceBlock(composeProd, service)).toContain('no-new-privileges:true');
  });

  it.each(services)('sets a memory limit on %s', (service) => {
    expect(extractServiceBlock(composeProd, service)).toMatch(/^\s+mem_limit:\s*\S+/m);
  });

  // The mem_limit must stay env-overridable (`${SERVICE_MEM_LIMIT:-default}`)
  // so operators can raise it without editing the compose file — a hardcoded
  // literal could OOM-kill memory-heavy work (large syncs, embeddings).
  it.each(services)('makes the %s memory limit env-overridable with a default', (service) => {
    expect(extractServiceBlock(composeProd, service)).toMatch(
      /^\s+mem_limit:\s*\$\{[A-Z0-9_]+_MEM_LIMIT:-\S+\}/m,
    );
  });

  it.each(services)('sets a pids limit on %s', (service) => {
    expect(extractServiceBlock(composeProd, service)).toMatch(/^\s+pids_limit:\s*\d+/m);
  });

  // read_only is safe only on the stateless services; postgres/redis/searxng
  // own complex writable paths and are intentionally excluded.
  it.each(['frontend', 'backend', 'mcp-docs'])(
    'runs %s with a read-only root filesystem',
    (service) => {
      expect(extractServiceBlock(composeProd, service)).toMatch(/^\s+read_only:\s*true\b/m);
    },
  );

  it.each(['postgres', 'redis'])(
    're-adds only the gosu step-down capabilities on %s (bare cap_drop:[ALL] would break startup)',
    (service) => {
      const block = extractServiceBlock(composeProd, service);
      expect(block).toMatch(/^\s+cap_add:\s*\[[^\]]*\bSETUID\b[^\]]*\]/m);
      expect(block).toMatch(/\bSETGID\b/);
      expect(block).toMatch(/\bCHOWN\b/);
    },
  );
});

describe('docker/docker-compose.yml CE image platform', () => {
  // `:dev` / `:latest` images are linux/amd64 only (arm64 ships on v* tags).
  // Without an explicit platform, `docker compose pull` on Apple Silicon
  // requests arm64 and 404s — searxng was the first to fail because its
  // local cache was already a different digest.
  it.each(['frontend', 'backend', 'mcp-docs', 'searxng'])(
    'pins %s to linux/amd64 so :dev pulls succeed on Apple Silicon',
    (service) => {
      expect(extractServiceBlock(composeProd, service)).toMatch(
        /^\s+platform:\s*linux\/amd64\s*$/m,
      );
    },
  );
});

describe('docker/docker-compose.yml is a GHCR pull file', () => {
  const imageServices = ['frontend', 'backend', 'mcp-docs', 'searxng'] as const;

  it.each(imageServices)(
    'does not declare build: on %s (source builds live in docker-compose.build.yml)',
    (service) => {
      expect(extractServiceBlock(composeProd, service)).not.toMatch(/^\s+build:/m);
    },
  );

  it.each(imageServices)(
    'pins %s to ghcr.io with COMPENDIQ_VERSION (default dev)',
    (service) => {
      expect(extractServiceBlock(composeProd, service)).toMatch(
        new RegExp(
          `^\\s+image:\\s*ghcr\\.io/compendiq/compendiq-ce-${service}:\\$\\{COMPENDIQ_VERSION:-dev\\}\\s*$`,
          'm',
        ),
      );
    },
  );
});

describe('docker/docker-compose.build.yml source-build override', () => {
  const buildComposePath = join(repoRoot, 'docker', 'docker-compose.build.yml');

  it('exists next to docker-compose.yml', () => {
    expect(existsSync(buildComposePath)).toBe(true);
  });

  it.each([
    ['frontend', '..', 'frontend/Dockerfile'],
    ['backend', '..', 'backend/Dockerfile'],
    ['mcp-docs', '..', 'mcp-docs/Dockerfile'],
    ['searxng', './searxng', 'Dockerfile'],
  ] as const)('builds %s from context %s dockerfile %s', (service, context, dockerfile) => {
    const composeBuild = readFileSync(buildComposePath, 'utf8');
    const block = extractServiceBlock(composeBuild, service);
    expect(block).toMatch(/^\s+build:/m);
    expect(block).toContain(`context: ${context}`);
    expect(block).toContain(`dockerfile: ${dockerfile}`);
  });

  it('passes login-page build args to the frontend image', () => {
    const frontend = extractServiceBlock(readFileSync(buildComposePath, 'utf8'), 'frontend');
    expect(frontend).toContain('VITE_LOGIN_VARIANT');
    expect(frontend).toContain('VITE_LOGIN_VARIANT_PICKER');
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

  it('gives the installed backend a stop_grace_period for graceful shutdown (issue #931)', () => {
    // The installer-generated compose must match docker/docker-compose.yml so
    // installed deployments also survive the 50s graceful-shutdown drain
    // instead of being SIGKILLed at Docker's 10s default.
    const compose = extractInstallerCompose(installSh);
    const backend = extractServiceBlock(compose, 'backend');
    const match = backend.match(/^\s+stop_grace_period:\s*(\d+)s\b/m);
    expect(match, 'installer backend service must declare stop_grace_period').not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(60);
  });

  it('attaches mcp-docs and searxng to a non-internal network so they can reach the internet', () => {
    // mcp-docs' fetch_url tool and searxng's metasearch both require outbound
    // internet egress. An `internal: true` Docker network denies egress, so if
    // these sidecars are only on internal networks the MCP web-docs feature
    // silently fails end-to-end even though the services start. Canonical
    // docker/docker-compose.yml puts them on the non-internal backend-net.
    const compose = extractInstallerCompose(installSh);
    const internalFlags = parseNetworkInternalFlags(compose);

    for (const service of ['mcp-docs', 'searxng']) {
      const nets = serviceNetworks(extractServiceBlock(compose, service));
      expect(nets.length, `${service} must declare at least one network`).toBeGreaterThan(0);
      const hasEgress = nets.some((net) => internalFlags[net] === false);
      expect(
        hasEgress,
        `${service} is only on internal-only networks (${nets.join(', ')}); it needs egress`,
      ).toBe(true);
    }
  });

  it('does not revive the removed LLM_PROVIDER two-slot toggle (issue #970)', () => {
    // ADR-021 replaced the legacy `LLM_PROVIDER` switch wholesale with the
    // llm_providers table. Seeding it from the installer resurrects dead config.
    expect(installSh).not.toMatch(/LLM_PROVIDER:/);
  });

  it('does not default OPENAI_BASE_URL to a real endpoint (issue #970)', () => {
    // A non-empty OPENAI_BASE_URL default makes the fresh-install bootstrap OR
    // condition true, seeding a phantom keyless OpenAI provider even when the
    // operator only wants Ollama. Only a pure pass-through (empty default) is
    // acceptable so the row is seeded solely when the user opts in.
    const compose = extractInstallerCompose(installSh);
    const backend = extractServiceBlock(compose, 'backend');
    const usages = interpolationsOf(backend, 'OPENAI_BASE_URL');
    expect(usages.length).toBeGreaterThan(0);
    for (const modifier of usages) {
      // Empty pass-through only: `:-` (or bare) — never a baked-in URL default.
      expect(modifier).toMatch(/^:?-?$/);
    }
    expect(backend).not.toContain('api.openai.com');
  });

  it('does not seed the deprecated EMBEDDING_MODEL env default (issue #970)', () => {
    // EMBEDDING_MODEL is a deprecated bootstrap fallback; baking bge-m3 into the
    // installer keeps env-driven LLM config alive instead of the providers table.
    const compose = extractInstallerCompose(installSh);
    const backend = extractServiceBlock(compose, 'backend');
    expect(backend).not.toMatch(/EMBEDDING_MODEL:/);
  });

  it('keeps postgres and redis on an internal network (no host egress for the data tier)', () => {
    // The egress fix must not accidentally expose the data tier: postgres/redis
    // must still sit on an `internal: true` network per CLAUDE.md infra rules.
    const compose = extractInstallerCompose(installSh);
    const internalFlags = parseNetworkInternalFlags(compose);
    expect(Object.values(internalFlags).some((isInternal) => isInternal)).toBe(true);

    for (const service of ['postgres', 'redis']) {
      const nets = serviceNetworks(extractServiceBlock(compose, service));
      const onInternal = nets.some((net) => internalFlags[net] === true);
      expect(onInternal, `${service} must be on an internal network`).toBe(true);
    }
  });

  it('isolates the installed frontend to the frontend network only (#1050)', () => {
    // The internet-facing frontend must not sit on the backend network, so it
    // cannot reach redis/searxng/mcp-docs — only the backend (via frontend net).
    const compose = extractInstallerCompose(installSh);
    const nets = serviceNetworks(extractServiceBlock(compose, 'frontend'));
    expect(nets).toEqual(['frontend']);
  });

  it('puts the installed backend on the frontend network so the proxy can reach it (#1050)', () => {
    const compose = extractInstallerCompose(installSh);
    const nets = serviceNetworks(extractServiceBlock(compose, 'backend'));
    expect(nets).toContain('frontend');
    expect(nets).toContain('backend');
    expect(nets).toContain('data');
  });

  it.each(['frontend', 'backend', 'postgres', 'redis', 'mcp-docs', 'searxng'])(
    'hardens the installed %s service (cap_drop ALL, no-new-privileges, mem + pids limits) (#1050)',
    (service) => {
      const compose = extractInstallerCompose(installSh);
      const block = extractServiceBlock(compose, service);
      expect(hasCapDropAll(block), `${service} must cap_drop ALL`).toBe(true);
      expect(block, `${service} must set no-new-privileges`).toContain('no-new-privileges:true');
      expect(block, `${service} must set mem_limit`).toMatch(/^\s+mem_limit:\s*\S+/m);
      expect(block, `${service} mem_limit must be env-overridable`).toMatch(
        /^\s+mem_limit:\s*\$\{[A-Z0-9_]+_MEM_LIMIT:-\S+\}/m,
      );
      expect(block, `${service} must set pids_limit`).toMatch(/^\s+pids_limit:\s*\d+/m);
    },
  );

  it.each(['frontend', 'backend', 'mcp-docs'])(
    'runs the installed stateless %s with a read-only root filesystem (#1050)',
    (service) => {
      const compose = extractInstallerCompose(installSh);
      expect(extractServiceBlock(compose, service)).toMatch(/^\s+read_only:\s*true\b/m);
    },
  );

  it('generates a shared MCP_DOCS_TOKEN so /mcp stays authenticated on a default install (#1050)', () => {
    // The installer must emit MCP_DOCS_TOKEN into .env — the sidecar runs
    // NODE_ENV=production and fails closed (401) without it.
    expect(installSh).toContain('MCP_DOCS_TOKEN=');
    // And both services must read it from the environment.
    const compose = extractInstallerCompose(installSh);
    expect(compose).toMatch(/MCP_DOCS_TOKEN:\s*\$\{MCP_DOCS_TOKEN/);
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

  it('ignores the Python tool venv and bytecode .gitignore also excludes (#1115)', () => {
    // `tools/eval-corpus-images/` is a Python tool, so its README has every
    // developer create a venv holding Pillow and friends INSIDE the checkout.
    // docker-compose.build.yml builds with `context: ..`,
    // so without these the wheels are tarred up and streamed to the daemon on
    // every local source build. .gitignore carries the same block, and a repo
    // can easily carry one half and not the other — this is the other half.
    const patterns = dockerignore.split('\n').map((line) => line.trim());
    for (const pattern of ['**/.venv', '**/__pycache__', '**/.pytest_cache', '**/*.egg-info']) {
      expect(patterns).toContain(pattern);
    }
  });
});

describe('.env.example stays authoritative for env vars the backend reads', () => {
  it.each([
    'SEARXNG_URL',
    'REEMBED_WAIT_LOCKS_MS',
    'RETENTION_ADMIN_ACCESS_DENIED_DAYS',
    'RETENTION_PENDING_SYNC_VERSIONS_DAYS',
    'RETENTION_WEBHOOK_DELIVERIES_DAYS',
  ])('documents %s', (varName) => {
    expect(envExample).toContain(varName);
  });

  it('does not document EMBEDDING_CONCURRENCY, which no code reads', () => {
    expect(envExample).not.toContain('EMBEDDING_CONCURRENCY');
  });
});

describe('FTS_LANGUAGE is retired, not merely undocumented (#1114)', () => {
  // The keyword-index language lives in `admin_settings.fts_language` and is
  // edited in Settings → AI Models → Retrieval. The env var was inert on every
  // migrated instance — migration 049 seeds that row before the first request,
  // so the `?? process.env.FTS_LANGUAGE` fallback could never be reached —
  // which is precisely how a German corpus stays indexed with `simple` while
  // its operator believes the deployment honoured their setting.
  it('is not passed into the backend container', () => {
    expect(extractServiceBlock(composeProd, 'backend')).not.toContain('FTS_LANGUAGE');
  });

  it('is not seeded by the installer either', () => {
    expect(installSh).not.toContain('FTS_LANGUAGE');
  });

  it('is marked removed in .env.example and points at the panel that replaced it', () => {
    // Not merely deleted: an operator upgrading with FTS_LANGUAGE already in
    // their .env needs to be told where the setting went, not left to wonder
    // why the line vanished.
    expect(envExample, 'FTS_LANGUAGE must not read as a live tunable').not.toMatch(
      /^#?\s*FTS_LANGUAGE=/m,
    );
    expect(envExample).toMatch(/\(Removed\)\s*FTS_LANGUAGE/);
    expect(envExample).toContain('Settings → AI Models → Retrieval');
  });
});

describe('.github/workflows/pr-check.yml runs validation for every author', () => {
  it('does not skip typecheck/lint/test/hoist checks for Dependabot PRs', () => {
    expect(prCheckWorkflow).not.toContain('dependabot[bot]');
  });
});

/**
 * Extract a top-level GitHub Actions job block (`  <id>:` under `jobs:`).
 * Same indent rule as extractServiceBlock: stop at the next 0- or 2-space key.
 */
function extractWorkflowJob(workflowText: string, jobId: string): string {
  const lines = workflowText.split('\n');
  const jobsAt = lines.findIndex((line) => line === 'jobs:');
  expect(jobsAt, 'jobs: block not found').toBeGreaterThanOrEqual(0);
  const start = lines.findIndex((line, i) => i > jobsAt && line === `  ${jobId}:`);
  expect(start, `job "${jobId}" not found`).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^ {0,2}\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

describe('.github/workflows/pr-check.yml keeps the Tests job off the frontend and off coverage', () => {
  const testsJob = extractWorkflowJob(prCheckWorkflow, 'test');
  const frontendJob = extractWorkflowJob(prCheckWorkflow, 'frontend-test');

  it('runs frontend tests as their own job so they do not wait on backend coverage', () => {
    expect(frontendJob).toMatch(/name:\s*Frontend Tests/);
    expect(frontendJob).toMatch(/npm test -w frontend/);
    expect(frontendJob).toMatch(/npm run build -w @compendiq\/contracts/);
    expect(frontendJob).not.toMatch(/postgres:/);
    expect(testsJob).not.toMatch(/npm test -w frontend/);
  });

  it('runs backend tests on the PR path without coverage instrumentation', () => {
    expect(testsJob).toMatch(/npm test -w backend/);
    expect(testsJob).not.toMatch(/^\s*run:\s+npm run test:coverage\b/m);
    expect(prCheckWorkflow).not.toMatch(/^\s*run:\s+npm run test:coverage\b/m);
  });

  it('still builds contracts and runs the contracts suite on the backend Tests job', () => {
    expect(testsJob).toMatch(/npm run build -w @compendiq\/contracts/);
    expect(testsJob).toMatch(/npm test -w @compendiq\/contracts/);
  });
});

describe('.github/workflows keeps hosted CI off backend coverage instrumentation', () => {
  const workflowsDir = join(repoRoot, '.github', 'workflows');
  const workflowFiles = readdirSync(workflowsDir).filter(
    (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
  );

  it.each(workflowFiles)('does not run test:coverage in %s', (file) => {
    const workflow = readFileSync(join(workflowsDir, file), 'utf8');
    expect(workflow).not.toMatch(/^\s*run:\s+npm run test:coverage\b/m);
  });
});

describe('docker/Dockerfile.enterprise keeps the GitHub token out of image layers (issue #930)', () => {
  it('never writes the token into a persisted .npmrc via a build-arg', () => {
    // A build-arg written to .npmrc in its own RUN bakes the token into that
    // layer forever — a later `rm -f .npmrc` cannot purge earlier layer history
    // or the exported build cache. Assert no layer interpolates the token into
    // .npmrc from an ARG.
    expect(dockerfileEnterprise).not.toMatch(/_authToken=\$\{GITHUB_TOKEN\}/);
    expect(dockerfileEnterprise).not.toMatch(/^\s*ARG GITHUB_TOKEN\s*$/m);
  });

  it('injects the token via a BuildKit secret mount when it needs one', () => {
    // BuildKit secret mounts (`--mount=type=secret`) expose the value only for
    // the duration of that RUN and are never committed to a layer or the cache.
    //
    // Conditional on the Dockerfile actually consuming a registry credential.
    // The invariant #930 protects is "the token never lands in a layer" — a
    // Dockerfile that authenticates to no private registry satisfies that by
    // construction, and demanding the mount anyway asserts a mechanism rather
    // than the property.
    //
    // This is not hypothetical: the EE overlay ships its own
    // docker/Dockerfile.enterprise, which installs nothing from GitHub
    // Packages and references no token at all. In a merged EE tree `repoRoot`
    // resolves to that file, and the unconditional assertion failed the whole
    // enterprise build for a Dockerfile that was never at risk.
    const usesRegistryCredential =
      /GITHUB_TOKEN|_authToken|\.npmrc/.test(dockerfileEnterprise);

    if (!usesRegistryCredential) {
      // Nothing to protect — but prove that, so this branch cannot silently
      // become a way to skip the check if a token is reintroduced later.
      expect(dockerfileEnterprise).not.toMatch(/--mount=type=secret,id=github_token/);
      return;
    }

    expect(dockerfileEnterprise).toMatch(/--mount=type=secret,id=github_token/);
  });
});

describe('.github/workflows/sync-ee-submodule.yml dispatches CE dev updates to EE', () => {
  const workflowPath = join(repoRoot, '.github', 'workflows', 'sync-ee-submodule.yml');

  it('sends the CE commit SHA through the authenticated repository dispatch contract', () => {
    expect(existsSync(workflowPath), 'CE-to-EE dispatch workflow is missing').toBe(true);

    const workflow = readFileSync(workflowPath, 'utf8');
    const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));

    expect(onBlock).toMatch(/^\s*push:\s*\n\s+branches:\s*\[dev\]$/m);
    expect(onBlock).not.toMatch(/\bmain\b/);
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.EE_REPOSITORY_DISPATCH_TOKEN }}');
    expect(workflow).toContain('repos/Compendiq/compendiq-ee/dispatches');
    expect(workflow).toContain('event_type=ce-dev-updated');
    expect(workflow).toContain('client_payload[sha]=$GITHUB_SHA');
  });
});

describe('.github/workflows supply-chain hardening', () => {
  const workflowsDir = join(repoRoot, '.github', 'workflows');
  const workflowFiles = readdirSync(workflowsDir).filter(
    (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
  );

  it('has workflow files to check', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it.each(workflowFiles)(
    'pins every third-party action in %s to a full 40-char commit SHA (mutable tags can be repointed)',
    (file) => {
      const text = readFileSync(join(workflowsDir, file), 'utf8');
      const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
      for (const ref of uses) {
        // Local composite actions (./path) are not pinnable; skip them.
        if (ref.startsWith('./')) continue;
        const [, version] = ref.split('@');
        expect(version, `${ref} in ${file} must be pinned with @<sha>`).toBeDefined();
        expect(version, `${ref} in ${file} must pin a full 40-char commit SHA, not a mutable tag`).toMatch(
          /^[0-9a-f]{40}$/,
        );
      }
    },
  );
});

describe('pr-check.yml retrieval classifier (#1820)', () => {
  /**
   * Every module the default `run-retrieval-eval.ts` run executes and whose
   * change can move what it measures (#1820). Derived by walking the code each
   * default-on `stageFlags()` stage runs, plus the always-on base pipeline
   * (`runner.ts` → `hybridSearch` → both legs; seeding → `embedPage`). The
   * comment names the stage that reaches the module. Optional stages (--rerank,
   * --deep-search, --mmr) and generic infra are excluded on purpose; the
   * exclusions and their reasons are listed in
   * docs/claude/testing-and-retrieval-eval.md.
   */
  const DERIVED_RETRIEVAL_DEPENDENCIES = [
    // base: the harness and the runner it drives
    'backend/scripts/run-retrieval-eval.ts',
    'backend/src/domains/llm/eval/runner.ts',
    // base: hybridSearch, both legs, getEmbeddingCoverage
    'backend/src/domains/llm/services/rag-service.ts',
    // base seeding: embedPage chunking (chunkText)
    'backend/src/domains/llm/services/embedding-service.ts',
    // base seeding: htmlToEmbeddingText is the embedded text
    'backend/src/core/services/content-converter.ts',
    // base seeding: HNSW_PARAMS / columnTypeFor build the ANN index the vector leg reads
    'backend/src/core/db/vector-column-tier.ts',
    // base vector leg: resolveUsecase('embedding') picks the query embedder
    'backend/src/domains/llm/services/llm-provider-resolver.ts',
    // base vector leg + seeding: generateEmbedding
    'backend/src/domains/llm/services/openai-compatible-client.ts',
    // base vector leg: formatQueryForEmbedding (query prefix)
    'backend/src/domains/llm/services/query-instruction.ts',
    // base vector leg: queryArticleTransport carries the query to the embedder
    'backend/src/domains/llm/services/query-article-transport.ts',
    // base vector leg: efSearchFor sets hnsw.ef_search (ANN recall)
    'backend/src/domains/llm/services/hnsw-ef-search.ts',
    // base legs + pinIdentifiers: aiPolicyPredicate / derivedArmPredicate filter candidates
    'backend/src/domains/llm/services/ai-policy-retrieval.ts',
    // base legs: readDerivedProvenance on every vector/keyword row
    'backend/src/domains/llm/services/derived-provenance.ts',
    // base legs + coverage + pinIdentifiers: ragRetrievalPagesPredicate
    'backend/src/core/services/page-visibility.ts',
    // base + both default stages: rag_* defaults (fetch width, context budget, pin switch, MMR/prior off)
    'backend/src/core/services/admin-settings-service.ts',
    // base: computeRetrievalConfidence runs on every hybridSearch
    'backend/src/domains/llm/services/retrieval-confidence.ts',
    // base runner: trigrams/jaccard compute the reported redundancy figures
    'backend/src/domains/llm/services/mmr.ts',
    // pinIdentifiers: detectIdentifiers
    'backend/src/domains/llm/services/identifier-shortcircuit.ts',
    // pinIdentifiers: lookupIdentifier → lexicalTsQuery / bestChunkLateralSql / resolveLexicalChunk (also the keyword leg)
    'backend/src/domains/llm/services/lexical-chunk-resolution.ts',
    // pinIdentifiers: chooseLexicalParser (also the keyword leg)
    'backend/src/core/utils/lexical-query.ts',
    // pinIdentifiers: getFtsLanguage (also the keyword leg)
    'backend/src/core/services/fts-language.ts',
    // assembleContext: assembleSiblingWindow
    'backend/src/domains/llm/services/sibling-assembly.ts',
  ] as const;

  /**
   * The "Classify changed paths" step's own bash, cut out of pr-check.yml.
   * Running it (rather than re-implementing its pattern as a JS RegExp)
   * evaluates the pattern with `flag()`'s real `grep -qE`, and exercises the
   * fail-open branches with the code that ships.
   */
  const classifyScript = (() => {
    const lines = prCheckWorkflow.split('\n');
    const nameAt = lines.findIndex((l) => /^\s*- name: Classify changed paths\s*$/.test(l));
    if (nameAt < 0) throw new Error('pr-check.yml has no "Classify changed paths" step');
    const runAt = lines.findIndex((l, i) => i > nameAt && /^\s*run: \|\s*$/.test(l));
    if (runAt < 0) throw new Error('the "Classify changed paths" step has no `run: |` block');
    const indent = /^\s*/.exec(lines[runAt + 1] ?? '')![0];
    const body: string[] = [];
    for (const line of lines.slice(runAt + 1)) {
      if (line.trim() !== '' && !line.startsWith(indent)) break;
      body.push(line.slice(indent.length));
    }
    return body.join('\n');
  })();

  let stubDir = '';
  beforeAll(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'pr-check-classify-'));
    // Stands in for `git diff --name-only "$BASE"...HEAD`: prints the changed
    // paths, or dies the way a missing merge base does.
    const git = join(stubDir, 'git');
    writeFileSync(
      git,
      '#!/bin/sh\nif [ -n "$STUB_GIT_FAIL" ]; then echo "fatal: no merge base" >&2; exit 128; fi\nprintf \'%s\\n\' "$STUB_GIT_CHANGED"\n',
    );
    chmodSync(git, 0o755);
  });
  afterAll(() => {
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  });

  /**
   * Run the step the way Actions does: the `${{ }}` expressions are
   * substituted before bash starts, then bash runs the script with
   * $GITHUB_OUTPUT pointing at a file. Returns what the step wrote there.
   */
  function classify(opts: { changed?: string[]; event?: string; diffFails?: boolean }): Record<string, string> {
    const script = classifyScript
      .replaceAll('${{ github.event_name }}', opts.event ?? 'pull_request')
      .replaceAll("${{ github.base_ref || 'dev' }}", 'dev');
    expect(script, 'the classify step gained an Actions expression this test does not substitute').not.toContain('${{');
    const outFile = join(stubDir, 'github-output');
    writeFileSync(outFile, '');
    execFileSync('bash', ['-c', script], {
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outFile,
        STUB_GIT_CHANGED: (opts.changed ?? []).join('\n'),
        ...(opts.diffFails ? { STUB_GIT_FAIL: '1' } : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return Object.fromEntries(
      readFileSync(outFile, 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => l.split('=', 2) as [string, string]),
    );
  }

  const retrievalFor = (path: string): string | undefined => classify({ changed: [path] }).retrieval;

  it.each(DERIVED_RETRIEVAL_DEPENDENCIES)('%s exists (rename guard)', (path) => {
    expect(existsSync(join(repoRoot, path)), `${path} was renamed or removed — re-derive the set and the pr-check.yml pattern`).toBe(true);
  });

  it.each(DERIVED_RETRIEVAL_DEPENDENCIES)('%s schedules the retrieval eval', (path) => {
    expect(retrievalFor(path)).toBe('true');
  });

  it.each(['docs/claude/ui-ux.md', 'README.md'])('unrelated doc %s does not schedule the retrieval eval', (path) => {
    expect(retrievalFor(path)).toBe('false');
  });

  it.each([
    'backend/src/domains/confluence/services/sync-service.ts',
    // Same directory as the derived set but off the eval path: guards against a blanket `services/` pattern.
    'backend/src/domains/llm/services/image-analysis-worker.ts',
  ])('unrelated backend module %s does not schedule the retrieval eval', (path) => {
    expect(existsSync(join(repoRoot, path)), `${path} no longer exists — pick another unrelated module`).toBe(true);
    expect(retrievalFor(path)).toBe('false');
  });

  it('manual dispatch fails open: every optional job runs', () => {
    expect(classify({ event: 'workflow_dispatch', changed: ['README.md'] })).toEqual({
      frontend: 'true',
      mcp: 'true',
      retrieval: 'true',
      e2e: 'true',
    });
  });

  it('a failing git diff fails open: every optional job runs', () => {
    expect(classify({ diffFails: true })).toEqual({
      frontend: 'true',
      mcp: 'true',
      retrieval: 'true',
      e2e: 'true',
    });
  });
});
