/**
 * OpenTelemetry preload entrypoint (issue #922).
 *
 * Launched via Node's `--import` hook BEFORE the application module graph
 * (`dist/index.js`) is evaluated — see the runtime `CMD` in backend/Dockerfile
 * and the `start` script in backend/package.json. This is what lets
 * auto-instrumentation monkey-patch http/fastify/pg/redis before those modules
 * are first imported. Starting the SDK from inside index.ts (as the old code
 * did) ran too late: the module graph had already been loaded, so the
 * instrumentations never attached.
 *
 * Top-level `await` is legal in an ESM module loaded via `--import`, and Node
 * finishes evaluating this module before it begins loading the main entry.
 */
import { startTelemetry } from './telemetry.js';

await startTelemetry();
