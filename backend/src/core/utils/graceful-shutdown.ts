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
  /** Hard deadline before the process force-exits (default 30s). */
  timeoutMs?: number;
  /** Exit function, injectable for tests. Defaults to process.exit. */
  exit?: (code: number) => void;
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
 *   and a hard-deadline timer (unref'ed so it never keeps the process alive)
 *   force-exits with 1 if a step hangs, instead of waiting for SIGKILL.
 */
export function createShutdownHandler(
  options: ShutdownHandlerOptions,
): (signal: string) => Promise<void> {
  const { steps, timeoutMs = 30_000 } = options;
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
