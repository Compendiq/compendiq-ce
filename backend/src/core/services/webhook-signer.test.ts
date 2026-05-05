/**
 * Unit tests for the webhook-signer wrapper (Compendiq/compendiq-ee#114,
 * Phase B).
 *
 * These exercise the surface we expose around the `standardwebhooks`
 * package: header shape, round-trip sign→verify, tampering rejections,
 * timestamp-skew enforcement, and the multi-secret rotation-overlap
 * acceptance path.
 *
 * No DB, no Fastify, no crypto key infrastructure — the signer is pure.
 */
import { describe, it, expect } from 'vitest';

import { signWebhook, verifyWebhook } from './webhook-signer.js';

// A stable test fixture: the caller guarantees `payload` is byte-
// identical across sign + verify, so all tests use a single canonical
// stringified body.
const fixture = () => ({
  secret: 'super-secret-plaintext-admin-chose-this-1234',
  webhookId: '01HXYZABC0000000000000WEBH',
  payload: JSON.stringify({ type: 'page.updated', data: { id: 42 } }),
});

describe('webhook-signer', () => {
  describe('signWebhook', () => {
    it('returns headers with the correct shape', () => {
      const { secret, webhookId, payload } = fixture();
      const headers = signWebhook({ secret, webhookId, payload });

      expect(headers['webhook-id']).toBe(webhookId);
      expect(headers['webhook-timestamp']).toMatch(/^\d+$/);
      expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/=]+$/);
    });

    it('emits a deterministic unix-seconds timestamp when one is supplied', () => {
      const { secret, webhookId, payload } = fixture();
      // 2024-06-15T12:00:00.500Z — include a non-zero millisecond field
      // to make sure we floor rather than round.
      const ts = new Date(1_718_452_800_500);
      const headers = signWebhook({ secret, webhookId, timestamp: ts, payload });

      expect(headers['webhook-timestamp']).toBe(
        Math.floor(ts.getTime() / 1000).toString(),
      );
      expect(headers['webhook-timestamp']).toBe('1718452800');
    });

    it('defaults the timestamp to "now" (±2s) when omitted', () => {
      const { secret, webhookId, payload } = fixture();
      const before = Math.floor(Date.now() / 1000);
      const headers = signWebhook({ secret, webhookId, payload });
      const after = Math.floor(Date.now() / 1000);

      const ts = Number.parseInt(headers['webhook-timestamp'], 10);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after + 1);
    });

    it('produces different signatures for different payloads', () => {
      const { secret, webhookId } = fixture();
      const ts = new Date();
      const a = signWebhook({
        secret,
        webhookId,
        timestamp: ts,
        payload: '{"x":1}',
      });
      const b = signWebhook({
        secret,
        webhookId,
        timestamp: ts,
        payload: '{"x":2}',
      });

      expect(a['webhook-signature']).not.toBe(b['webhook-signature']);
    });
  });

  describe('verifyWebhook — round-trip', () => {
    it('accepts a freshly-signed payload', () => {
      const { secret, webhookId, payload } = fixture();
      const headers = signWebhook({ secret, webhookId, payload });

      expect(() =>
        verifyWebhook({
          secrets: secret,
          webhookId,
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload,
        }),
      ).not.toThrow();
    });
  });

  describe('verifyWebhook — tampering rejections', () => {
    it('rejects a signature produced with a different secret', () => {
      const { webhookId, payload } = fixture();
      const headers = signWebhook({
        secret: 'first-secret',
        webhookId,
        payload,
      });

      expect(() =>
        verifyWebhook({
          secrets: 'different-secret',
          webhookId,
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload,
        }),
      ).toThrow(/no matching signature/i);
    });

    it('rejects a tampered payload', () => {
      const { secret, webhookId, payload } = fixture();
      const headers = signWebhook({ secret, webhookId, payload });
      const tamperedPayload = payload.replace('42', '43');

      expect(() =>
        verifyWebhook({
          secrets: secret,
          webhookId,
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload: tamperedPayload,
        }),
      ).toThrow(/no matching signature/i);
    });

    it('rejects a tampered webhookId', () => {
      const { secret, webhookId, payload } = fixture();
      const headers = signWebhook({ secret, webhookId, payload });

      expect(() =>
        verifyWebhook({
          secrets: secret,
          webhookId: '01HXYZABC0000000000000EVIL',
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload,
        }),
      ).toThrow(/no matching signature/i);
    });
  });

  describe('verifyWebhook — timestamp skew', () => {
    it('rejects a 10-minute-old signature with the default 300s tolerance', () => {
      const { secret, webhookId, payload } = fixture();
      const staleTs = new Date(Date.now() - 10 * 60 * 1000);
      const headers = signWebhook({
        secret,
        webhookId,
        timestamp: staleTs,
        payload,
      });

      expect(() =>
        verifyWebhook({
          secrets: secret,
          webhookId,
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload,
        }),
      ).toThrow(/too old/i);
    });

    it('accepts a 10-minute-old signature when toleranceSeconds=1200', () => {
      const { secret, webhookId, payload } = fixture();
      const staleTs = new Date(Date.now() - 10 * 60 * 1000);
      const headers = signWebhook({
        secret,
        webhookId,
        timestamp: staleTs,
        payload,
      });

      expect(() =>
        verifyWebhook({
          secrets: secret,
          webhookId,
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload,
          toleranceSeconds: 1200,
        }),
      ).not.toThrow();
    });

    it('rejects a signature whose timestamp is 10 minutes in the future', () => {
      const { secret, webhookId, payload } = fixture();
      const futureTs = new Date(Date.now() + 10 * 60 * 1000);
      const headers = signWebhook({
        secret,
        webhookId,
        timestamp: futureTs,
        payload,
      });

      expect(() =>
        verifyWebhook({
          secrets: secret,
          webhookId,
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload,
        }),
      ).toThrow(/too new/i);
    });
  });

  describe('verifyWebhook — rotation overlap', () => {
    it('accepts a signature made with the primary secret', () => {
      const { webhookId, payload } = fixture();
      const headers = signWebhook({
        secret: 'primary-secret',
        webhookId,
        payload,
      });

      expect(() =>
        verifyWebhook({
          secrets: ['primary-secret', 'secondary-secret'],
          webhookId,
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload,
        }),
      ).not.toThrow();
    });

    it('accepts a signature made with the secondary secret', () => {
      const { webhookId, payload } = fixture();
      const headers = signWebhook({
        secret: 'secondary-secret',
        webhookId,
        payload,
      });

      expect(() =>
        verifyWebhook({
          secrets: ['primary-secret', 'secondary-secret'],
          webhookId,
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload,
        }),
      ).not.toThrow();
    });

    it('rejects a signature made with a third secret not in the set', () => {
      const { webhookId, payload } = fixture();
      const headers = signWebhook({
        secret: 'evil-third-secret',
        webhookId,
        payload,
      });

      expect(() =>
        verifyWebhook({
          secrets: ['primary-secret', 'secondary-secret'],
          webhookId,
          timestamp: headers['webhook-timestamp'],
          signature: headers['webhook-signature'],
          payload,
        }),
      ).toThrow(/no matching signature/i);
    });
  });
});
