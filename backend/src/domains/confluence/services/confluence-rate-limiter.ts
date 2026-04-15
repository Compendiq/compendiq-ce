/**
 * Token bucket rate limiter for Confluence API calls.
 *
 * Protects the customer's Confluence Data Center instance from being overwhelmed
 * during sync. Admin-configurable rate (requests/minute) via admin_settings table.
 *
 * Default: 60 requests/minute (1 per second).
 */

import { logger } from '../../../core/utils/logger.js';

const DEFAULT_RATE_RPM = 60;
const SETTING_KEY = 'confluence_rate_limit_rpm';

let _ratePerMinute = DEFAULT_RATE_RPM;
let _tokens: number = DEFAULT_RATE_RPM;
let _lastRefill: number = Date.now();
let _waitQueue: Array<{ resolve: () => void }> = [];
let _drainTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Set the rate limit (requests per minute). Called from admin settings.
 */
export function setRateLimit(rpm: number): void {
  const clamped = Math.max(1, Math.min(rpm, 600));
  if (clamped !== _ratePerMinute) {
    _ratePerMinute = clamped;
    _tokens = Math.min(_tokens, clamped);
    logger.info({ rpm: clamped }, 'Confluence rate limit updated');
  }
}

/**
 * Get the current rate limit configuration.
 */
export function getRateLimit(): { rpm: number; availableTokens: number; queueDepth: number } {
  refillTokens();
  return {
    rpm: _ratePerMinute,
    availableTokens: Math.floor(_tokens),
    queueDepth: _waitQueue.length,
  };
}

/**
 * Refill tokens based on elapsed time since last refill.
 */
function refillTokens(): void {
  const now = Date.now();
  const elapsed = now - _lastRefill;
  const tokensToAdd = (elapsed / 60_000) * _ratePerMinute;
  _tokens = Math.min(_ratePerMinute, _tokens + tokensToAdd);
  _lastRefill = now;
}

/**
 * Drain the wait queue by resolving waiters as tokens become available.
 */
function scheduleDrain(): void {
  if (_drainTimer || _waitQueue.length === 0) return;

  const msPerToken = 60_000 / _ratePerMinute;
  _drainTimer = setTimeout(() => {
    _drainTimer = null;
    refillTokens();
    while (_waitQueue.length > 0 && _tokens >= 1) {
      _tokens -= 1;
      _waitQueue.shift()!.resolve();
    }
    if (_waitQueue.length > 0) {
      scheduleDrain();
    }
  }, msPerToken);
}

/**
 * Acquire a rate limit token. Resolves immediately if tokens are available,
 * otherwise queues the request until a token is available.
 *
 * This should be called before every Confluence API request.
 */
export async function acquireToken(): Promise<void> {
  refillTokens();

  if (_tokens >= 1) {
    _tokens -= 1;
    return;
  }

  // Queue the request
  return new Promise<void>((resolve) => {
    _waitQueue.push({ resolve });
    scheduleDrain();
  });
}

/**
 * Initialize the rate limiter from admin_settings.
 * Falls back to default if the setting doesn't exist.
 */
export async function initRateLimiter(): Promise<void> {
  try {
    const { query } = await import('../../../core/db/postgres.js');
    const result = await query<{ setting_value: string }>(
      'SELECT setting_value FROM admin_settings WHERE setting_key = $1',
      [SETTING_KEY],
    );
    if (result.rows.length > 0) {
      const rpm = parseInt(result.rows[0]!.setting_value, 10);
      if (!isNaN(rpm) && rpm > 0) {
        setRateLimit(rpm);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load Confluence rate limit from admin_settings, using default');
  }
}

/**
 * Reset the rate limiter (for testing).
 */
export function resetRateLimiter(): void {
  _tokens = _ratePerMinute;
  _lastRefill = Date.now();
  for (const waiter of _waitQueue) {
    waiter.resolve();
  }
  _waitQueue = [];
  if (_drainTimer) {
    clearTimeout(_drainTimer);
    _drainTimer = null;
  }
}
