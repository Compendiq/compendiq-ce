import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SpanKind } from '@opentelemetry/api';
import { isDbAvailable } from './test-db-helper.js';
import { buildAutoInstrumentationConfig } from './telemetry.js';

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
  kind: number;
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

/**
 * Inbound query-string credentials must not reach exported spans
 * (GHSA-3v2p-hm54-8qcq: `@opentelemetry/instrumentation-http` < 0.222.0 put the
 * raw query into `url.query` on server spans; `url.full` exists on client spans only).
 * `GET /api/internal/health?token=<secret>` is the CE route that takes a
 * persistent credential this way (health-api.ts). 0.222.0 alone only redacts
 * the semantic-convention defaults (`sig`, `X-Amz-Signature`, …), not `token`,
 * so the proof runs the real HTTP instrumentation with the config production
 * uses (`buildAutoInstrumentationConfig()`), a loopback server and an in-memory
 * exporter. No database involved.
 *
 * Child process, same reason as above. The instrumentation patches `http` when
 * CommonJS code first `require`s it after the SDK started — which is what
 * Fastify does in production — so the probe loads it through `createRequire`
 * after `sdk.start()`; an ESM `import('node:http')` there produces no spans at
 * all. The probe request is a raw `node:net` socket so the test's own client
 * does not create a CLIENT span that would legitimately carry the URL.
 */
const HTTP_PROBE = `
import { createRequire } from 'node:module';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const exporter = new tracing.InMemorySpanExporter();
const processor = new tracing.SimpleSpanProcessor(exporter);
const sdk = new NodeSDK({
  serviceName: 'http-span-probe',
  spanProcessors: [processor],
  instrumentations: [getNodeAutoInstrumentations(JSON.parse(process.env.PROBE_INSTRUMENTATION_CONFIG))],
});
sdk.start();

// Like Fastify, load http through CommonJS require after sdk.start(): that is
// the load the instrumentation hooks (an ESM import of node:http is not).
const { createServer } = createRequire(import.meta.url)('http');
const net = createRequire(import.meta.url)('net');

const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{"ok":true}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const responseText = await new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write(
      'GET /api/internal/health?token=' + process.env.PROBE_SECRET + '&view=full HTTP/1.1\\r\\n'
      + 'Host: 127.0.0.1:' + port + '\\r\\nConnection: close\\r\\n\\r\\n',
    );
  });
  let received = '';
  socket.on('data', (chunk) => { received += chunk; });
  socket.on('end', () => resolve(received));
  socket.on('error', reject);
});
await new Promise((resolve) => server.close(resolve));

await processor.forceFlush();
const spans = exporter.getFinishedSpans().map((span) => ({
  name: span.name,
  kind: span.kind,
  attributes: span.attributes,
  events: span.events,
  links: span.links,
  status: span.status,
}));
await sdk.shutdown();
process.stdout.write(JSON.stringify({ responded: responseText.startsWith('HTTP/1.1 200'), spans }));
`;

describe('OpenTelemetry HTTP server instrumentation', () => {
  it('exports the health token in no span attribute or span name', async () => {
    const secret = `leak-marker-${randomUUID()}`;
    // The probe receives the config as JSON, so it must be pure data: a
    // function-valued option (requestHook, …) would be dropped silently and
    // the test would stop exercising what production runs.
    const config = buildAutoInstrumentationConfig();
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', HTTP_PROBE],
      {
        cwd: backendDir,
        env: {
          PATH: process.env.PATH,
          PROBE_SECRET: secret,
          PROBE_INSTRUMENTATION_CONFIG: JSON.stringify(config),
        },
      },
    );
    const { responded, spans }: { responded: boolean; spans: ExportedSpan[] } = JSON.parse(stdout);
    expect(responded).toBe(true);

    const serverSpan = spans.find(
      (span) => span.kind === SpanKind.SERVER && span.attributes['url.path'] === '/api/internal/health',
    );
    expect(serverSpan, `no server span for /api/internal/health among ${spans.map((span) => span.name).join(', ')}`)
      .toBeDefined();
    // Redaction ran (not a vacuous pass): the param is kept, its value replaced.
    expect(serverSpan!.attributes['url.query']).toContain('token=REDACTED');
    expect(serverSpan!.attributes['url.query']).toContain('view=full');

    expect(spans.some((span) => span.kind === SpanKind.CLIENT)).toBe(false);
    expect(stdout).not.toContain(secret);
  }, 60_000);
});
