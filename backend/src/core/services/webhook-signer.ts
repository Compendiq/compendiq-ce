/**
 * Webhook signer — thin wrapper around the `standardwebhooks` npm package
 * (Compendiq/compendiq-ee#114, Phase B).
 *
 * The package ships a reference implementation of the Standard Webhooks
 * signing scheme (https://github.com/standard-webhooks/standard-webhooks):
 *   webhook-id        stable-across-retries UUID / message id
 *   webhook-timestamp unix-seconds string
 *   webhook-signature "v1,<base64(HMAC-SHA256(secret, \"${id}.${ts}.${body}\"))>"
 *                     (may contain multiple space-separated "v1,..." values
 *                      when the sender dual-signs during a rotation window)
 *
 * Why wrap at all:
 *   - The package's `Webhook` constructor defaults to treating the
 *     `secret` argument as **base64-encoded** and decoding it before use.
 *     Our subscriptions table stores decrypted secrets as arbitrary
 *     plaintext strings (admin-chosen, not necessarily base64-valid), so
 *     every constructor call must pass `{ format: 'raw' }` to keep the
 *     string bytes intact. That is the single most common footgun when
 *     adopting this package — centralising it here keeps callers honest.
 *   - The package's built-in `verify()` has a hard-coded ±5-minute
 *     timestamp tolerance with no override. Our admin-test-panel route
 *     (Phase E) and integration tests need to replay signatures against
 *     larger or smaller windows, so we reimplement verification on top of
 *     the package's `sign()` primitive (the actual HMAC) and do the
 *     timestamp check ourselves.
 *   - The package's `verify()` accepts **multiple signatures in one
 *     header** (rotation overlap for the *receiver*) but assumes a
 *     single secret. Our rotation-overlap story is on the *sender* side
 *     — one signature header, but the sender may have rotated and wants
 *     either the old or the new secret to verify. `verifyWebhook`
 *     therefore accepts an array of candidate secrets and passes iff any
 *     one of them produces a matching signature.
 *
 * Out of scope here:
 *   - No DB access, no HTTP, no crypto key decryption. Callers pass the
 *     already-decrypted secret string (derived from `webhook_subscriptions
 *     .secret_enc` via `crypto.decryptSecret()`).
 *   - No header parsing from incoming Fastify requests — callers extract
 *     the three header strings themselves. Keeping the signer pure makes
 *     it trivial to unit-test.
 */

import { Webhook } from 'standardwebhooks';
import { timingSafeEqual } from 'node:crypto';

/** Default skew tolerance matches the Standard Webhooks spec (§5). */
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignWebhookOptions {
  /** Decrypted plaintext subscription secret. NOT the encrypted BYTEA. */
  secret: string;
  /** `webhook_outbox.webhook_id` — stable across retries, receiver dedup key. */
  webhookId: string;
  /** Defaults to `new Date()`. Parametrised so tests can pin the timestamp. */
  timestamp?: Date;
  /** Stringified JSON body. Caller controls key ordering if dedup matters. */
  payload: string;
}

export interface SignedWebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

export interface VerifyWebhookOptions {
  /**
   * Single secret or an array. Arrays let verifiers accept a signature
   * produced under *either* the primary or the secondary secret during
   * the 30-day rotation-overlap window (see plan §1.2).
   */
  secrets: string | string[];
  webhookId: string;
  /** Raw `webhook-timestamp` header — unix seconds as a decimal string. */
  timestamp: string;
  /**
   * Raw `webhook-signature` header — may contain one or more space-
   * separated "v1,<base64>" (or "v1a,...") values. Verification succeeds
   * if any one of them matches for any candidate secret.
   */
  signature: string;
  /** Raw request body string. MUST be byte-identical to the signed body. */
  payload: string;
  /** Skew tolerance in seconds. Defaults to 300 (Standard Webhooks default). */
  toleranceSeconds?: number;
}

/**
 * Sign a webhook payload using the Standard Webhooks v1 algorithm.
 *
 * Returns the three canonical headers the caller must attach to the
 * outbound request verbatim.
 */
export function signWebhook(opts: SignWebhookOptions): SignedWebhookHeaders {
  const { secret, webhookId, payload } = opts;
  const timestamp = opts.timestamp ?? new Date();

  // `format: 'raw'` — treat the secret as a plaintext byte sequence
  // rather than base64-decoding it. See file header.
  const wh = new Webhook(secret, { format: 'raw' });
  const signature = wh.sign(webhookId, timestamp, payload);

  return {
    'webhook-id': webhookId,
    'webhook-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
    'webhook-signature': signature,
  };
}

/**
 * Verify a signed webhook payload. Throws on any failure; returns `void`
 * on success.
 *
 * Failure modes (all raise `Error`):
 *   - missing / malformed headers
 *   - timestamp outside the ± `toleranceSeconds` skew window
 *   - no candidate secret produces a signature matching any of the
 *     signatures in the header
 *
 * This implementation deliberately does NOT call `Webhook#verify()` from
 * the package because that method hard-codes the 300s tolerance. We use
 * the package's `sign()` (the actual HMAC) as the trusted primitive and
 * do the timestamp + constant-time equality checks ourselves, mirroring
 * the package's own internal logic.
 */
export function verifyWebhook(opts: VerifyWebhookOptions): void {
  const {
    webhookId,
    timestamp: timestampHeader,
    signature: signatureHeader,
    payload,
  } = opts;
  const toleranceSeconds = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const secrets = Array.isArray(opts.secrets) ? opts.secrets : [opts.secrets];

  if (!webhookId || !timestampHeader || !signatureHeader) {
    throw new Error('webhook-signer: missing required fields');
  }
  if (secrets.length === 0) {
    throw new Error('webhook-signer: no secrets provided');
  }

  // --- Timestamp skew check -------------------------------------------------
  const timestampSeconds = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error('webhook-signer: invalid timestamp header');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - timestampSeconds > toleranceSeconds) {
    throw new Error('webhook-signer: message timestamp too old');
  }
  if (timestampSeconds - nowSeconds > toleranceSeconds) {
    throw new Error('webhook-signer: message timestamp too new');
  }

  // --- Signature check ------------------------------------------------------
  // The header may contain multiple signatures separated by a single
  // space — e.g. "v1,abc v1,def" when the *sender* dual-signs during
  // rotation. Accept the message if ANY candidate secret produces a
  // signature that matches ANY signature in the header.
  const presentedSignatures = signatureHeader.split(' ').filter(Boolean);
  const asDate = new Date(timestampSeconds * 1000);

  for (const candidateSecret of secrets) {
    const wh = new Webhook(candidateSecret, { format: 'raw' });
    // `sign()` returns "v1,<base64>"; extract the base64 payload for
    // byte-level comparison.
    const expectedFull = wh.sign(webhookId, asDate, payload);
    const expectedTag = expectedFull.split(',', 2)[1];
    if (!expectedTag) {
      continue; // defensive — sign() always returns the "v1," prefix
    }
    const expectedBytes = Buffer.from(expectedTag, 'utf8');

    for (const presented of presentedSignatures) {
      const [version, value] = presented.split(',', 2);
      if (version !== 'v1' || !value) {
        // Unknown version (e.g. future "v1a,...") — skip rather than
        // fail; another signature in the header may still match.
        continue;
      }
      const presentedBytes = Buffer.from(value, 'utf8');
      if (presentedBytes.length !== expectedBytes.length) {
        continue;
      }
      if (timingSafeEqual(presentedBytes, expectedBytes)) {
        return; // success
      }
    }
  }

  throw new Error('webhook-signer: no matching signature found');
}
