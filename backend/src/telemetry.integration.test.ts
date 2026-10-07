import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isDbAvailable } from './test-db-helper.js';

/**
 * Database spans must not leak the DB username (GHSA-qqmp-wf37-98f9:
 * `@opentelemetry/instrumentation-pg` ≤ 0.72 stamped every span with
 * `db.user`). Exercised end to end: the real auto-instrumentations, as
 * `startTelemetry()` configures them, record a real query against the test
 * database into an in-memory exporter.
 *
 * Runs in a child process because instrumentation only attaches if it is
 * registered before `pg` is first loaded — production guarantees that with the
 * `--import ./dist/telemetry-register.js` preload, and this vitest worker has
 * already loaded `pg` through test-setup.
 */
const dbAvailable = await isDbAvailable();
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const PROBE = `
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const exporter = new tracing.InMemorySpanExporter();
const processor = new tracing.SimpleSpanProcessor(exporter);
const sdk = new NodeSDK({
  serviceName: 'pg-span-probe',
  spanProcessors: [processor],
  instrumentations: [
    getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } }),
  ],
});
sdk.start();

// Dynamic on purpose: a static import would load pg before sdk.start().
const { default: pg } = await import('pg');
const client = new pg.Client({ connectionString: process.env.PROBE_POSTGRES_URL });
await client.connect();
await client.query('SELECT 1');
await client.end();

// Spans wait for the async resource detectors before they reach the exporter;
// reading without a flush races them and intermittently sees no spans at all.
await processor.forceFlush();
const spans = exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes }));
await sdk.shutdown();
process.stdout.write(JSON.stringify(spans));
`;

interface ExportedSpan {
  name: string;
  attributes: Record<string, unknown>;
}

describe.skipIf(!dbAvailable)('OpenTelemetry pg instrumentation', () => {
  it('records pg query spans without the database username', async () => {
    const postgresUrl = process.env.POSTGRES_URL!;
    const username = decodeURIComponent(new URL(postgresUrl).username);
    expect(username).not.toBe('');

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', PROBE],
      { cwd: backendDir, env: { PATH: process.env.PATH, PROBE_POSTGRES_URL: postgresUrl } },
    );
    const spans: ExportedSpan[] = JSON.parse(stdout);

    const querySpan = spans.find((span) => span.name.startsWith('pg.query:'));
    expect(querySpan, `no pg.query span among ${spans.map((span) => span.name).join(', ')}`)
      .toBeDefined();

    const leaks = spans.flatMap((span) =>
      Object.entries(span.attributes)
        .filter(([key, value]) => key === 'db.user' || value === username)
        .map(([key]) => `${span.name} ${key}`),
    );
    expect(leaks).toEqual([]);
    expect(querySpan!.attributes['db.system.name']).toBe('postgresql');
  }, 60_000);
});
