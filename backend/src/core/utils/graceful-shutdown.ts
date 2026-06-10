import { logger } from './logger.js';

export interface ShutdownStep {
  /** Step name, used in logs when a step fails. */
  name: string;
  /** Cleanup action. May be sync or async; failures are logged and skipped. */
  run: () => void | Promise<void>;
}

export interface ShutdownHandlerOptions {
  /** Cleanup steps, executed sequentially in array order. */
  steps: ShutdownStep[];
  /** Hard deadline before the process force-exits (default 50s, see ADR-024). */
  timeoutMs?: number;
  /** Exit function, injectable for tests. Defaults to process.exit. */
  exit?: (code: number) => void;
}

/**
 * Default hard deadline for the in-process shutdown timer. ADR-024 budgets the
 * drain (LLM summary/quality/sync jobs awaited by `stopQueueWorkers()` can
 * legitimately run for tens of seconds) against the EE compose
 * `stop_grace_period: 60s`; 50s keeps Docker's SIGKILL backstop a 10s margin.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 50_000;

/**
 * Resolves the shutdown hard deadline from `SHUTDOWN_TIMEOUT_MS` (positive
 * integer of milliseconds). Invalid or absent values fall back to the 50s
 * default. Operators tuning this should keep it below their container
 * runtime's stop grace period so the in-process timer fires first.
 */
export function resolveShutdownTimeoutMs(
  raw: string | undefined = process.env.SHUTDOWN_TIMEOUT_MS,
): number {
  if (raw === undefined || raw === '') return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    logger.warn(
      { SHUTDOWN_TIMEOUT_MS: raw },
      'Invalid SHUTDOWN_TIMEOUT_MS (expected a positive integer of milliseconds), using default',
    );
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * Builds a guarded graceful-shutdown handler (issue #745).
 *
 * - Re-entrancy guard: a second SIGTERM/SIGINT while a shutdown is in flight
 *   is ignored instead of starting a parallel teardown of already-closing
 *   resources.
 * - Each step is isolated in try/catch: one failing step (e.g. a Redis
 *   `quit()` against a server that is already gone) no longer aborts the
 *   chain and leaves pools open.
 * - The process always exits: code 0 on a clean run, 1 if any step failed,
 *   and a hard-deadline timer (unref'ed so it never keeps the process alive,
 *   default 50s / `SHUTDOWN_TIMEOUT_MS`) force-exits with 1 if a step hangs,
 *   instead of waiting for SIGKILL.
 */
export function createShutdownHandler(
  options: ShutdownHandlerOptions,
): (signal: string) => Promise<void> {
  const { steps, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let shuttingDown = false;
  let exited = false;
  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  return async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress, ignoring signal');
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down...');

    const deadline = setTimeout(() => {
      logger.error({ timeoutMs }, 'Graceful shutdown timed out, forcing exit');
      exitOnce(1);
    }, timeoutMs);
    deadline.unref();

    let exitCode = 0;
    try {
      for (const step of steps) {
        try {
          await step.run();
        } catch (err) {
          exitCode = 1;
          logger.error({ err, step: step.name }, 'Shutdown step failed, continuing');
        }
      }
    } finally {
      clearTimeout(deadline);
      exitOnce(exitCode);
    }
  };
}
