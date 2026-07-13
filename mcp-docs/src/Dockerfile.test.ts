import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Production Dockerfile hardening invariants for the mcp-docs sidecar
 * (issues #966, #967, #968).
 *
 * The mcp-docs image is a long-running service reached via HTTP by the backend.
 * These assertions mirror the hardening already applied to backend/Dockerfile:
 *
 *  #966 dumb-init as PID 1 — a bare `node` PID 1 does not reap zombies and
 *       ignores SIGTERM without an explicit handler, so `docker stop` waits the
 *       full grace period and then SIGKILLs. `ENTRYPOINT ["dumb-init", "--"]`
 *       forwards signals for a clean shutdown.
 *  #967 prune dev dependencies — the runtime stage must not ship typescript,
 *       tsx, vitest, etc. Install a dedicated prod-deps stage with
 *       `npm ci --omit=dev` and copy node_modules from it, not from the builder.
 *  #968 NODE_ENV=production — logger.ts loads the `pino-pretty` transport unless
 *       NODE_ENV === 'production'. With dev deps pruned (#967) that module is
 *       gone, so the runtime stage MUST set NODE_ENV=production or the process
 *       crashes on boot.
 */

const mcpDocsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(mcpDocsRoot, '..');

const dockerfile = readFileSync(join(mcpDocsRoot, 'Dockerfile'), 'utf8');
const composeProd = readFileSync(join(repoRoot, 'docker', 'docker-compose.yml'), 'utf8');
const installSh = readFileSync(join(repoRoot, 'scripts', 'install.sh'), 'utf8');

/** Extract the mcp-docs service block from a compose document (2-space indent). */
function mcpDocsServiceBlock(composeText: string): string {
  const lines = composeText.split('\n');
  const start = lines.findIndex((line) => line === '  mcp-docs:');
  expect(start, 'mcp-docs service not found').toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,2}\S/.test(lines[i])) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

describe('mcp-docs Dockerfile — #966 dumb-init PID 1', () => {
  it('installs dumb-init in the runtime image', () => {
    expect(dockerfile).toMatch(/apk add [^\n]*dumb-init/);
  });

  it('uses dumb-init as the entrypoint so SIGTERM is forwarded to node', () => {
    expect(dockerfile).toMatch(/ENTRYPOINT \["dumb-init", "--"\]/);
  });
});

describe('mcp-docs Dockerfile — #967 prune dev dependencies', () => {
  it('has a production-only dependency install (npm ci --omit=dev)', () => {
    expect(dockerfile).toMatch(/npm ci[^\n]*--omit=dev/);
  });

  it('copies node_modules from the prod-deps stage, not the builder', () => {
    expect(dockerfile).toMatch(/COPY --from=prod-deps [^\n]*node_modules/);
    expect(dockerfile).not.toMatch(/COPY --from=builder [^\n]*node_modules/);
  });
});

describe('mcp-docs Dockerfile — #968 NODE_ENV=production', () => {
  it('sets NODE_ENV=production in the runtime stage', () => {
    expect(dockerfile).toMatch(/ENV NODE_ENV=production/);
  });
});

describe('mcp-docs compose defense-in-depth — #968 NODE_ENV=production', () => {
  it('sets NODE_ENV: production in docker/docker-compose.yml', () => {
    expect(mcpDocsServiceBlock(composeProd)).toMatch(/NODE_ENV:\s*production/);
  });

  it('sets NODE_ENV: production in scripts/install.sh', () => {
    expect(mcpDocsServiceBlock(installSh)).toMatch(/NODE_ENV:\s*production/);
  });
});
