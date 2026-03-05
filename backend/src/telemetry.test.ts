import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTelemetry, getTracer, withSpan, shutdownTelemetry } from './telemetry.js';

describe('Telemetry', () => {
  beforeEach(() => {
    // Clean up any previous tracer
    delete (globalThis as Record<string, unknown>).__otelTracer;
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).__otelTracer;
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
});
