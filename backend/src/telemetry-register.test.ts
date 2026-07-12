import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OpenTelemetry preload invariants (issue #922).
 *
 * Auto-instrumentation can only monkey-patch http/fastify/pg/redis if the SDK
 * starts BEFORE those modules are first imported. Starting it from inside
 * index.ts (after the app module graph has already been evaluated) is too late
 * and the instrumentations silently never attach. The fix runs the SDK from a
 * dedicated preload module launched via Node's `--import` hook.
 *
 * Real span emission needs a live process + collector, so these are config
 * assertions over the committed Dockerfile / package.json / register module
 * rather than a running trace pipeline.
 */

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(join(backendDir, 'Dockerfile'), 'utf8');
const packageJson = readFileSync(join(backendDir, 'package.json'), 'utf8');
const registerPath = join(backendDir, 'src', 'telemetry-register.ts');

/** The `CMD [...]` JSON array of node args from the runtime stage. */
function dockerfileCmdArgs(text: string): string[] {
  const match = text.match(/^CMD\s+(\[[^\]]*\])/m);
  expect(match, 'CMD instruction not found in Dockerfile').not.toBeNull();
  return JSON.parse(match![1]) as string[];
}

describe('OpenTelemetry preload (issue #922)', () => {
  it('ships a telemetry-register preload module that starts the SDK at top level', () => {
    expect(existsSync(registerPath), 'backend/src/telemetry-register.ts must exist').toBe(true);
    const source = readFileSync(registerPath, 'utf8');
    // The SDK must be started at module top level (via the exported start
    // helper), not deferred inside an exported function that the app calls late.
    expect(source).toMatch(/^\s*await\s+startTelemetry\(\)/m);
  });

  it('Dockerfile CMD preloads the register module before dist/index.js', () => {
    const args = dockerfileCmdArgs(dockerfile);
    const importIdx = args.indexOf('--import');
    expect(importIdx, 'CMD must pass --import').toBeGreaterThanOrEqual(0);
    expect(args[importIdx + 1]).toBe('./dist/telemetry-register.js');

    const entryIdx = args.indexOf('dist/index.js');
    expect(entryIdx, 'CMD must launch dist/index.js').toBeGreaterThanOrEqual(0);
    // The preload must be registered strictly before the app entrypoint.
    expect(importIdx).toBeLessThan(entryIdx);
  });

  it('npm start preloads the register module before dist/index.js', () => {
    const { scripts } = JSON.parse(packageJson) as { scripts: Record<string, string> };
    const start = scripts.start ?? '';
    expect(start).toContain('--import ./dist/telemetry-register.js');
    expect(start.indexOf('--import')).toBeLessThan(start.indexOf('dist/index.js'));
  });
});
