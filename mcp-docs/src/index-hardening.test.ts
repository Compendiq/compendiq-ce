import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static-source hardening invariants for the mcp-docs entrypoint (issue #1050).
 *
 * These assertions read index.ts as text (mirroring Dockerfile.test.ts) rather
 * than booting the Express app, so they stay fast and dependency-free while
 * pinning two defence-in-depth guarantees:
 *
 *  1. `x-powered-by` is disabled so the sidecar never advertises its framework.
 *  2. The /mcp guard is wired to fail closed in production: makeMcpAuth is
 *     invoked with `process.env.NODE_ENV === 'production'` as the production
 *     flag, so a production sidecar with no MCP_DOCS_TOKEN returns 401.
 */

const srcDir = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(srcDir, 'index.ts'), 'utf8');

describe('mcp-docs index.ts — #1050 hardening', () => {
  it("disables the x-powered-by header", () => {
    expect(indexSource).toMatch(/app\.disable\(\s*['"]x-powered-by['"]\s*\)/);
  });

  it('wires the /mcp guard to fail closed in production', () => {
    // makeMcpAuth must receive a production flag derived from NODE_ENV so the
    // no-token case rejects with 401 in production instead of passing through.
    expect(indexSource).toMatch(
      /makeMcpAuth\(\s*MCP_DOCS_TOKEN\s*,\s*process\.env\.NODE_ENV\s*===\s*['"]production['"]\s*\)/,
    );
  });
});
