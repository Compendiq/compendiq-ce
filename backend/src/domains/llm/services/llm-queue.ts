/**
 * LLM request queue with configurable concurrency and backpressure.
 *
 * Configuration precedence (first non-empty value wins):
 *   1. `admin_settings` row (`llm_concurrency`, `llm_max_queue_depth`,
 *      `llm_timeout_ms`) — loaded at boot by `initLlmQueue()` and by
 *      the admin UI on save.
 *   2. Environment variables:
 *      - `LLM_CONCURRENCY`       (default: 4)       — max concurrent LLM requests
 *      - `LLM_MAX_QUEUE_DEPTH`   (default: 50)      — reject when pending exceeds this
 *      - `LLM_STREAM_TIMEOUT_MS` (default: 300000)  — per-request timeout in ms
 *   3. Hardcoded defaults (listed above).
 */

import pLimit, { type LimitFunction } from 'p-limit';
import { logger } from '../../../core/utils/logger.js';

export interface LlmQueueMetrics {
  concurrency: number;
  activeCount: number;
  pendingCount: number;
  maxQueueDepth: number;
  totalProcessed: number;
  totalRejected: number;
  totalTimedOut: number;
}

const HARDCODED_CONCURRENCY = 4;
const HARDCODED_MAX_QUEUE_DEPTH = 50;
const HARDCODED_TIMEOUT_MS = 300_000;

/**
 * Parse a positive integer from an env var, returning `undefined` when the var
 * is absent, empty, non-numeric, or ≤ 0.
 */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const DEFAULT_CONCURRENCY = envInt('LLM_CONCURRENCY') ?? HARDCODED_CONCURRENCY;
const DEFAULT_MAX_QUEUE_DEPTH = envInt('LLM_MAX_QUEUE_DEPTH') ?? HARDCODED_MAX_QUEUE_DEPTH;
const DEFAULT_TIMEOUT_MS = envInt('LLM_STREAM_TIMEOUT_MS') ?? HARDCODED_TIMEOUT_MS;

let _limiter: LimitFunction = pLimit(DEFAULT_CONCURRENCY);
let _concurrency = DEFAULT_CONCURRENCY;
let _maxQueueDepth = DEFAULT_MAX_QUEUE_DEPTH;
let _timeoutMs = DEFAULT_TIMEOUT_MS;
let _totalProcessed = 0;
let _totalRejected = 0;
let _totalTimedOut = 0;

export function setConcurrency(n: number): void {
  const val = Math.max(1, Math.min(n, 100));
  if (val !== _concurrency) {
    _concurrency = val;
    _limiter = pLimit(val);
    logger.info({ concurrency: val }, 'LLM queue concurrency updated');
  }
}

export function setMaxQueueDepth(n: number): void {
  _maxQueueDepth = Math.max(1, n);
}

export function setTimeoutMs(ms: number): void {
  _timeoutMs = Math.max(1000, ms);
}

export function getMetrics(): LlmQueueMetrics {
  return {
    concurrency: _concurrency,
    activeCount: _limiter.activeCount,
    pendingCount: _limiter.pendingCount,
    maxQueueDepth: _maxQueueDepth,
    totalProcessed: _totalProcessed,
    totalRejected: _totalRejected,
    totalTimedOut: _totalTimedOut,
  };
}

export class QueueFullError extends Error {
  constructor(depth: number, max: number) {
    super(`LLM queue full: ${depth} pending (max: ${max})`);
    this.name = 'QueueFullError';
  }
}

export class LlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = 'LlmTimeoutError';
  }
}

export async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  if (_limiter.pendingCount >= _maxQueueDepth) {
    _totalRejected++;
    throw new QueueFullError(_limiter.pendingCount, _maxQueueDepth);
  }

  return _limiter(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        _totalTimedOut++;
        reject(new LlmTimeoutError(_timeoutMs));
      }, _timeoutMs);
    });

    try {
      const result = await Promise.race([fn(), timeoutPromise]);
      _totalProcessed++;
      return result;
    } catch (err) {
      if (!(err instanceof LlmTimeoutError)) {
        _totalProcessed++;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}

export async function initLlmQueue(): Promise<void> {
  try {
    const { query } = await import('../../../core/db/postgres.js');
    const result = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings
       WHERE setting_key IN ('llm_concurrency', 'llm_max_queue_depth', 'llm_timeout_ms')`,
      [],
    );
    for (const row of result.rows) {
      const val = parseInt(row.setting_value, 10);
      if (isNaN(val)) continue;
      switch (row.setting_key) {
        case 'llm_concurrency': setConcurrency(val); break;
        case 'llm_max_queue_depth': setMaxQueueDepth(val); break;
        case 'llm_timeout_ms': setTimeoutMs(val); break;
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load LLM queue settings, using defaults');
  }
}
