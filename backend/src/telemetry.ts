/**
 * OpenTelemetry initialization module.
 *
 * MUST be imported at the very top of index.ts before any other imports,
 * so auto-instrumentation can monkey-patch modules before they are loaded.
 *
 * Controlled by environment variables:
 *   OTEL_ENABLED=true          - Enable OpenTelemetry (default: false)
 *   OTEL_SERVICE_NAME          - Service name (default: 'kb-creator-backend')
 *   OTEL_EXPORTER_OTLP_ENDPOINT - OTLP endpoint (if set, uses OTLP exporter; otherwise console)
 */

import { logger } from './core/utils/logger.js';

let sdkInstance: { shutdown: () => Promise<void> } | null = null;

export async function initTelemetry(): Promise<void> {
  const enabled = process.env.OTEL_ENABLED === 'true';

  if (!enabled) {
    logger.debug('OpenTelemetry disabled (set OTEL_ENABLED=true to enable)');
    return;
  }

  try {
    // Dynamic imports so OTel deps are not loaded when disabled
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = await import(
      '@opentelemetry/auto-instrumentations-node'
    );
    const otelApi = await import('@opentelemetry/api');

    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'kb-creator-backend';

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

    const sdk = new NodeSDK(sdkConfig);
    sdk.start();
    sdkInstance = sdk;

    // Register a custom tracer for application-level spans
    const tracer = otelApi.trace.getTracer(serviceName);

    // Make the tracer available globally for custom spans
    (globalThis as Record<string, unknown>).__otelTracer = tracer;

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
 * Get the application tracer for creating custom spans.
 * Returns undefined if OTel is not initialized.
 */
export function getTracer(): import('@opentelemetry/api').Tracer | undefined {
  return (globalThis as Record<string, unknown>).__otelTracer as
    | import('@opentelemetry/api').Tracer
    | undefined;
}

/**
 * Create a custom span for a named operation.
 * If OTel is not enabled, the function is called directly without tracing.
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
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
      const result = await fn();
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
  if (sdkInstance) {
    try {
      await sdkInstance.shutdown();
      logger.info('OpenTelemetry shut down');
    } catch (err) {
      logger.warn({ err }, 'Error shutting down OpenTelemetry');
    }
  }
}
