import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initTelemetry,
  getTracer,
  getMeter,
  withSpan,
  recordHistogram,
  shutdownTelemetry,
} from './telemetry.js';

describe('Telemetry', () => {
  beforeEach(() => {
    // Clean up any previous tracer/meter
    delete (globalThis as Record<string, unknown>).__otelTracer;
    delete (globalThis as Record<string, unknown>).__otelMeter;
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).__otelTracer;
    delete (globalThis as Record<string, unknown>).__otelMeter;
    await shutdownTelemetry();
  });

  describe('initTelemetry', () => {
    it('should be a no-op when OTEL_ENABLED is not set', async () => {
      // OTEL_ENABLED is not set in test-setup.ts
      await initTelemetry();
      expect(getTracer()).toBeUndefined();
    });

    it('should be a no-op when OTEL_ENABLED is false', async () => {
      process.env.OTEL_ENABLED = 'false';
      await initTelemetry();
      expect(getTracer()).toBeUndefined();
      delete process.env.OTEL_ENABLED;
    });

    it('should initialize when OTEL_ENABLED is true', async () => {
      process.env.OTEL_ENABLED = 'true';
      await initTelemetry();

      const tracer = getTracer();
      expect(tracer).toBeDefined();

      // Clean up
      delete process.env.OTEL_ENABLED;
      await shutdownTelemetry();
    });
  });

  describe('getTracer', () => {
    it('should return undefined when OTel is not initialized', () => {
      expect(getTracer()).toBeUndefined();
    });
  });

  describe('withSpan', () => {
    it('should execute function directly when OTel is disabled', async () => {
      const result = await withSpan('test-span', async () => {
        return 42;
      });
      expect(result).toBe(42);
    });

    it('should propagate errors when OTel is disabled', async () => {
      await expect(
        withSpan('test-span', async () => {
          throw new Error('test error');
        }),
      ).rejects.toThrow('test error');
    });

    it('should execute function with tracing when OTel is enabled', async () => {
      process.env.OTEL_ENABLED = 'true';
      await initTelemetry();

      const result = await withSpan(
        'test-operation',
        async () => 'traced-result',
        { 'test.attribute': 'value' },
      );
      expect(result).toBe('traced-result');

      delete process.env.OTEL_ENABLED;
      await shutdownTelemetry();
    });

    it('passes the live span into the callback so attributes can be set post-hoc', async () => {
      // Results-derived attributes (hit counts, degraded verdicts) only exist
      // AFTER the work ran — the upfront `attributes` param cannot carry them.
      const recorded: Record<string, unknown> = {};
      (globalThis as Record<string, unknown>).__otelTracer = {
        startActiveSpan<T>(_name: string, fn: (span: unknown) => T): T {
          return fn({
            setAttribute(key: string, value: unknown) {
              recorded[key] = value;
            },
            setStatus() {},
            recordException() {},
            end() {},
          });
        },
      };

      await withSpan('op', async (span) => {
        span?.setAttribute('rag.hits', 3);
        return 1;
      });

      expect(recorded['rag.hits']).toBe(3);
    });

    it('should handle errors properly when tracing', async () => {
      process.env.OTEL_ENABLED = 'true';
      await initTelemetry();

      await expect(
        withSpan('failing-operation', async () => {
          throw new Error('traced error');
        }),
      ).rejects.toThrow('traced error');

      delete process.env.OTEL_ENABLED;
      await shutdownTelemetry();
    });
  });

  describe('shutdownTelemetry', () => {
    it('should be safe to call when not initialized', async () => {
      // Should not throw
      await shutdownTelemetry();
    });
  });

  // ── Metrics (#1117 stage 2) ────────────────────────────────────────────
  //
  // Tracing existed since #922; the metrics half is new. `getMeter` mirrors
  // `getTracer` (globalThis seam, undefined when disabled) and
  // `recordHistogram` mirrors `withSpan` (transparent no-op when disabled).

  describe('getMeter', () => {
    it('returns undefined when OTel is not initialized', () => {
      expect(getMeter()).toBeUndefined();
    });

    it('returns a meter when OTEL_ENABLED is true', async () => {
      process.env.OTEL_ENABLED = 'true';
      await initTelemetry();

      expect(getMeter()).toBeDefined();

      delete process.env.OTEL_ENABLED;
      await shutdownTelemetry();
    });

    it('is cleared by shutdownTelemetry', async () => {
      process.env.OTEL_ENABLED = 'true';
      await initTelemetry();
      await shutdownTelemetry();

      expect(getMeter()).toBeUndefined();

      delete process.env.OTEL_ENABLED;
    });
  });

  describe('metrics export wiring (review r1)', () => {
    function captureConsole(): { calls: string[]; restore: () => void } {
      const calls: string[] = [];
      const dirSpy = vi.spyOn(console, 'dir').mockImplementation((...args: unknown[]) => {
        calls.push(JSON.stringify(args));
      });
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        calls.push(JSON.stringify(args));
      });
      return {
        calls,
        restore: () => {
          dirSpy.mockRestore();
          logSpy.mockRestore();
        },
      };
    }

    it('recorded histograms actually reach the console exporter in the dev default', async () => {
      // The regression this pins: delete the metricReader wiring from
      // startTelemetry and every suite stays green while histograms record
      // into the void (the SDK registers no MeterProvider without a reader).
      process.env.OTEL_ENABLED = 'true';
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      delete process.env.OTEL_METRICS_EXPORTER;
      const cap = captureConsole();
      try {
        await initTelemetry();
        recordHistogram('compendiq.retrieval.stage.duration', 5, { stage: 'total' }, { unit: 'ms' });
        await shutdownTelemetry(); // flushes the periodic reader
        const hit = cap.calls.some((c) => c.includes('compendiq.retrieval.stage.duration'));
        expect(hit).toBe(true);
      } finally {
        cap.restore();
        delete process.env.OTEL_ENABLED;
        await shutdownTelemetry();
      }
    });

    it('respects a signal-specific OTLP metrics endpoint instead of forcing the console reader (review r2)', async () => {
      // OTEL_EXPORTER_OTLP_METRICS_ENDPOINT alone is a standard setup (metrics
      // to a collector, traces elsewhere or nowhere). Forcing the console
      // reader would silently discard the operator's named destination.
      process.env.OTEL_ENABLED = 'true';
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      delete process.env.OTEL_METRICS_EXPORTER;
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'http://127.0.0.1:9/v1/metrics';
      const cap = captureConsole();
      try {
        await initTelemetry();
        recordHistogram('compendiq.retrieval.stage.duration', 5, { stage: 'total' }, { unit: 'ms' });
        await shutdownTelemetry();
        const hit = cap.calls.some((c) => c.includes('compendiq.retrieval.stage.duration'));
        expect(hit).toBe(false);
      } finally {
        cap.restore();
        delete process.env.OTEL_ENABLED;
        delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
        await shutdownTelemetry();
      }
    }, 20_000);

    it('respects OTEL_METRICS_EXPORTER=none instead of forcing the console reader', async () => {
      // Standard OTel env config must win: an operator disabling metrics gets
      // no console dumps, not our hardcoded reader.
      process.env.OTEL_ENABLED = 'true';
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      process.env.OTEL_METRICS_EXPORTER = 'none';
      const cap = captureConsole();
      try {
        await initTelemetry();
        recordHistogram('compendiq.retrieval.stage.duration', 5, { stage: 'total' }, { unit: 'ms' });
        await shutdownTelemetry();
        const hit = cap.calls.some((c) => c.includes('compendiq.retrieval.stage.duration'));
        expect(hit).toBe(false);
      } finally {
        cap.restore();
        delete process.env.OTEL_ENABLED;
        delete process.env.OTEL_METRICS_EXPORTER;
        await shutdownTelemetry();
      }
    });
  });

  describe('recordHistogram', () => {
    interface FakeHistogram {
      record: ReturnType<typeof vi.fn>;
    }

    function installFakeMeter(): { createHistogram: ReturnType<typeof vi.fn>; histogram: FakeHistogram } {
      const histogram: FakeHistogram = { record: vi.fn() };
      const createHistogram = vi.fn().mockReturnValue(histogram);
      (globalThis as Record<string, unknown>).__otelMeter = { createHistogram };
      return { createHistogram, histogram };
    }

    it('is a safe no-op when OTel is disabled', () => {
      expect(() =>
        recordHistogram('compendiq.retrieval.stage.duration', 12.5, { stage: 'vector_search' }),
      ).not.toThrow();
    });

    it('records the value with attributes on the named instrument', () => {
      const { histogram } = installFakeMeter();

      recordHistogram(
        'compendiq.retrieval.stage.duration',
        12.5,
        { stage: 'vector_search' },
        { unit: 'ms', description: 'Retrieval stage latency' },
      );

      expect(histogram.record).toHaveBeenCalledWith(12.5, { stage: 'vector_search' });
    });

    it('creates each instrument once, not per record', () => {
      const { createHistogram, histogram } = installFakeMeter();

      recordHistogram('compendiq.retrieval.stage.duration', 1, { stage: 'vector_search' });
      recordHistogram('compendiq.retrieval.stage.duration', 2, { stage: 'keyword_search' });

      expect(createHistogram).toHaveBeenCalledTimes(1);
      expect(histogram.record).toHaveBeenCalledTimes(2);
    });
  });
});
