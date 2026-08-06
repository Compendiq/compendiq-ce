/**
 * OpenTelemetry initialization module.
 *
 * The SDK is started from `telemetry-register.ts`, which is loaded via Node's
 * `--import` preload hook BEFORE the application module graph — that ordering
 * is what lets auto-instrumentation monkey-patch http/fastify/pg/redis before
 * those modules are first imported (issue #922). The started SDK and tracer are
 * stashed on `globalThis` so `getTracer`/`shutdownTelemetry` can reach them
 * regardless of which entrypoint started the SDK.
 *
 * Controlled by environment variables:
 *   OTEL_ENABLED=true          - Enable OpenTelemetry (default: false)
 *   OTEL_SERVICE_NAME          - Service name (default: 'compendiq-backend')
 *   OTEL_EXPORTER_OTLP_ENDPOINT - OTLP endpoint (if set, uses OTLP exporter; otherwise console)
 */

import { logger } from './core/utils/logger.js';

const SDK_KEY = '__otelSdk';
const TRACER_KEY = '__otelTracer';
const METER_KEY = '__otelMeter';

type OtelSdk = { shutdown: () => Promise<void> };

// Instrument cache for recordHistogram: OTel meters return a NEW histogram on
// every createHistogram call, so instruments must be created once and reused.
// Keyed by the meter itself, not module state — an instrument belongs to the
// meter that created it, and a restart of the SDK (or a test swapping the
// globalThis seam) must not serve instruments bound to a dead meter.
const histogramCaches = new WeakMap<object, Map<string, import('@opentelemetry/api').Histogram>>();

/**
 * Construct and start the OpenTelemetry NodeSDK.
 *
 * Called at top level from the `--import` preload (`telemetry-register.ts`) so
 * that instrumentations attach before the app graph loads. Idempotent: a second
 * call (e.g. the best-effort `initTelemetry()` from index.ts on the dev/tsx
 * path) is a no-op once the SDK is already running.
 */
export async function startTelemetry(): Promise<void> {
  const enabled = process.env.OTEL_ENABLED === 'true';

  if (!enabled) {
    logger.debug('OpenTelemetry disabled (set OTEL_ENABLED=true to enable)');
    return;
  }

  // Idempotent — never start the SDK twice.
  if ((globalThis as Record<string, unknown>)[SDK_KEY]) {
    return;
  }

  try {
    // Dynamic imports so OTel deps are not loaded when disabled
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = await import(
      '@opentelemetry/auto-instrumentations-node'
    );
    const otelApi = await import('@opentelemetry/api');

    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'compendiq-backend';

    // Build the SDK configuration
    const sdkConfig: ConstructorParameters<typeof NodeSDK>[0] = {
      serviceName,
      instrumentations: [
        getNodeAutoInstrumentations({
          // Instrument HTTP, Fastify, pg, Redis automatically
          '@opentelemetry/instrumentation-fs': { enabled: false }, // too noisy
        }),
      ],
    };

    // If OTLP endpoint is configured, the SDK auto-picks it up from env vars
    // (OTEL_EXPORTER_OTLP_ENDPOINT). Otherwise, it defaults to console exporter.
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      const { ConsoleSpanExporter } = await import('@opentelemetry/sdk-trace-node' as string);
      sdkConfig.traceExporter = new ConsoleSpanExporter();
    }

    // Metrics (#1117): the NodeSDK only registers a global MeterProvider when
    // given a metric reader — without this block getMeter() would hand out
    // no-op meters and every histogram would silently record into the void.
    // Mirrors the trace-exporter policy above: OTLP when the endpoint is set,
    // console otherwise.
    const { PeriodicExportingMetricReader, ConsoleMetricExporter } = await import(
      '@opentelemetry/sdk-metrics'
    );
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http');
      sdkConfig.metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
      });
    } else {
      sdkConfig.metricReader = new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
      });
    }

    const sdk = new NodeSDK(sdkConfig);
    sdk.start();
    (globalThis as Record<string, unknown>)[SDK_KEY] = sdk;

    // Register a custom tracer for application-level spans
    const tracer = otelApi.trace.getTracer(serviceName);

    // Make the tracer available globally for custom spans
    (globalThis as Record<string, unknown>)[TRACER_KEY] = tracer;

    // Same seam for application-level metrics. metrics.getMeter delegates to
    // the MeterProvider the SDK just registered.
    (globalThis as Record<string, unknown>)[METER_KEY] = otelApi.metrics.getMeter(serviceName);

    logger.info(
      {
        serviceName,
        otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'console',
      },
      'OpenTelemetry initialized',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize OpenTelemetry - continuing without tracing');
  }
}

/**
 * Best-effort SDK startup for entrypoints not launched via the `--import`
 * preload (dev `tsx` and tests). In production the preload has already started
 * the SDK, so this call is a no-op. Kept as `initTelemetry` for backwards
 * compatibility with index.ts's startup sequence.
 */
export async function initTelemetry(): Promise<void> {
  await startTelemetry();
}

/**
 * Get the application tracer for creating custom spans.
 * Returns undefined if OTel is not initialized.
 */
export function getTracer(): import('@opentelemetry/api').Tracer | undefined {
  return (globalThis as Record<string, unknown>)[TRACER_KEY] as
    | import('@opentelemetry/api').Tracer
    | undefined;
}

/**
 * Get the application meter for creating custom metrics.
 * Returns undefined if OTel is not initialized.
 */
export function getMeter(): import('@opentelemetry/api').Meter | undefined {
  return (globalThis as Record<string, unknown>)[METER_KEY] as
    | import('@opentelemetry/api').Meter
    | undefined;
}

/**
 * Record a value on a named histogram. Transparent no-op when OTel is
 * disabled, mirroring {@link withSpan}. The instrument is created on first
 * use and cached — `options` (unit/description) therefore only take effect
 * on that first call for a given name.
 */
export function recordHistogram(
  name: string,
  value: number,
  attributes?: Record<string, string | number | boolean>,
  options?: { unit?: string; description?: string },
): void {
  const meter = getMeter();
  if (!meter) {
    return;
  }
  let cache = histogramCaches.get(meter);
  if (!cache) {
    cache = new Map();
    histogramCaches.set(meter, cache);
  }
  let histogram = cache.get(name);
  if (!histogram) {
    histogram = meter.createHistogram(name, options);
    cache.set(name, histogram);
  }
  histogram.record(value, attributes);
}

/**
 * Create a custom span for a named operation.
 * If OTel is not enabled, the function is called directly without tracing.
 *
 * The live span is passed to `fn` (undefined when tracing is off) so callers
 * can set attributes that only exist AFTER the work ran — hit counts, degraded
 * verdicts — which the upfront `attributes` parameter cannot carry.
 */
export async function withSpan<T>(
  name: string,
  fn: (span?: import('@opentelemetry/api').Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) {
    return fn();
  }

  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          span.setAttribute(key, value);
        }
      }
      const result = await fn(span);
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err) {
      span.setStatus({ code: 2, message: (err as Error).message }); // ERROR
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Gracefully shut down the OTel SDK (flushes pending spans).
 */
export async function shutdownTelemetry(): Promise<void> {
  const store = globalThis as Record<string, unknown>;
  const sdk = store[SDK_KEY] as OtelSdk | undefined;
  if (sdk) {
    try {
      await sdk.shutdown();
      logger.info('OpenTelemetry shut down');
    } catch (err) {
      logger.warn({ err }, 'Error shutting down OpenTelemetry');
    } finally {
      delete store[SDK_KEY];
      delete store[TRACER_KEY];
      delete store[METER_KEY];
    }
  }
}
