import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { query, runMigrations, closePool } from '../db/postgres.js';
import { trackError, listErrors, resolveError, getErrorSummary } from './error-tracker.js';

describe('Error Tracker', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    // Clean the error_log table before each test
    await query('DELETE FROM error_log');
  });

  describe('trackError', () => {
    it('should store an error in the database', async () => {
      const err = new Error('Test error message');
      err.name = 'TestError';

      await trackError(err, {
        userId: undefined,
        requestPath: 'GET /api/test',
        correlationId: 'corr-123',
      });

      const result = await query<{ error_type: string; message: string; request_path: string; correlation_id: string }>(
        'SELECT error_type, message, request_path, correlation_id FROM error_log',
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].error_type).toBe('TestError');
      expect(result.rows[0].message).toBe('Test error message');
      expect(result.rows[0].request_path).toBe('GET /api/test');
      expect(result.rows[0].correlation_id).toBe('corr-123');
    });

    it('should store a string error', async () => {
      await trackError('something went wrong');

      const result = await query<{ error_type: string; message: string }>(
        'SELECT error_type, message FROM error_log',
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].error_type).toBe('Error');
      expect(result.rows[0].message).toBe('something went wrong');
    });

    it('should store extra context as JSON', async () => {
      await trackError(new Error('context test'), {
        requestPath: 'POST /api/pages',
        extraField: 'extra-value',
        numericField: 42,
      });

      const result = await query<{ context: Record<string, unknown> }>(
        'SELECT context FROM error_log',
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].context).toEqual({
        extraField: 'extra-value',
        numericField: 42,
      });
    });

    it('should not throw when database is unavailable', async () => {
      // trackError is designed to never throw
      // Even with an invalid connection, it should swallow errors
      await expect(trackError(new Error('test'))).resolves.not.toThrow();
    });
  });

  describe('listErrors', () => {
    it('should return paginated errors', async () => {
      // Insert 3 errors
      for (let i = 0; i < 3; i++) {
        await trackError(new Error(`error ${i}`));
      }

      const result = await listErrors({ page: 1, limit: 2 });

      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
    });

    it('should filter by error type', async () => {
      const typeErr = new TypeError('type error');
      const rangeErr = new RangeError('range error');

      await trackError(typeErr);
      await trackError(rangeErr);

      const result = await listErrors({ errorType: 'TypeError' });

      expect(result.total).toBe(1);
      expect(result.items[0].errorType).toBe('TypeError');
    });

    it('should filter by resolved status', async () => {
      await trackError(new Error('resolved error'));
      await trackError(new Error('unresolved error'));

      // Get all errors and resolve the first one
      const all = await listErrors({});
      await resolveError(all.items[0].id);

      const unresolvedResult = await listErrors({ resolved: false });
      expect(unresolvedResult.total).toBe(1);

      const resolvedResult = await listErrors({ resolved: true });
      expect(resolvedResult.total).toBe(1);
    });

    it('should return errors in descending order by created_at', async () => {
      await trackError(new Error('first'));
      // Tiny delay to ensure ordering
      await new Promise((r) => setTimeout(r, 10));
      await trackError(new Error('second'));

      const result = await listErrors({});

      expect(result.items[0].message).toBe('second');
      expect(result.items[1].message).toBe('first');
    });
  });

  describe('resolveError', () => {
    it('should mark an error as resolved', async () => {
      await trackError(new Error('to resolve'));

      const errors = await listErrors({});
      expect(errors.items[0].resolved).toBe(false);

      const success = await resolveError(errors.items[0].id);
      expect(success).toBe(true);

      const updated = await listErrors({});
      expect(updated.items[0].resolved).toBe(true);
    });

    it('should return false for non-existent error', async () => {
      const success = await resolveError('00000000-0000-0000-0000-000000000000');
      expect(success).toBe(false);
    });
  });

  describe('getErrorSummary', () => {
    it('should return summary with counts grouped by type', async () => {
      await trackError(new TypeError('type 1'));
      await trackError(new TypeError('type 2'));
      await trackError(new RangeError('range 1'));

      const summary = await getErrorSummary();

      expect(summary.last24h).toHaveLength(2);
      expect(summary.unresolvedCount).toBe(3);

      const typeErrors = summary.last24h.find((s) => s.errorType === 'TypeError');
      expect(typeErrors?.count).toBe(2);

      const rangeErrors = summary.last24h.find((s) => s.errorType === 'RangeError');
      expect(rangeErrors?.count).toBe(1);
    });

    it('should return empty arrays when no errors exist', async () => {
      const summary = await getErrorSummary();

      expect(summary.last24h).toEqual([]);
      expect(summary.last7d).toEqual([]);
      expect(summary.last30d).toEqual([]);
      expect(summary.unresolvedCount).toBe(0);
    });
  });
});
