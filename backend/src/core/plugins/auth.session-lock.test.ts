import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * How the session-lock transaction classifies a connection that PostgreSQL
 * terminated. A real server cannot deterministically deliver the FATAL while
 * a statement is in flight, so the pg client is replaced by one that reports
 * it the way pg does in that case: the in-flight query rejects with the
 * SQLSTATE, and the socket close then emits a code-less 'error'.
 */

const connect = vi.fn();
vi.mock('../db/postgres.js', () => ({
  getPool: () => ({ connect }),
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

process.env.JWT_SECRET = 'a-test-secret-that-is-at-least-32-chars-long!!';
const { generateRefreshToken, rotateRefreshToken, RefreshSessionBusyError } = await import('./auth.js');

class TerminatedClient extends EventEmitter {
  released: unknown = 'not released';

  constructor(private readonly code: string) {
    super();
  }

  async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql === 'BEGIN' || sql.includes('set_config')) return { rows: [], rowCount: 0 };
    if (sql === 'ROLLBACK') throw new Error('Client has encountered a connection error and is not queryable');
    const fatal = Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), {
      code: this.code,
    });
    const rejected = Promise.reject(fatal);
    // The socket closes right behind the FATAL.
    this.emit('error', new Error('Connection terminated unexpectedly'));
    return rejected;
  }

  release(error?: unknown) {
    this.released = error;
  }
}

describe('session-lock transaction on a terminated connection', () => {
  const payload = { sub: 'user-1', username: 'alice', role: 'user' as const };

  beforeEach(() => {
    connect.mockReset();
  });

  it('reports the idle deadline as a busy session, not as an invalid token', async () => {
    const { token } = await generateRefreshToken(payload);
    const client = new TerminatedClient('25P03');
    connect.mockResolvedValue(client);

    await expect(rotateRefreshToken(token)).rejects.toBeInstanceOf(RefreshSessionBusyError);
    // The broken connection is discarded, not returned to the pool.
    expect(client.released).toBeInstanceOf(Error);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('keeps a real failure a real failure', async () => {
    const { token } = await generateRefreshToken(payload);
    connect.mockResolvedValue(new TerminatedClient('57P01'));

    const outcome = await rotateRefreshToken(token).catch((error: unknown) => error);
    expect(outcome).not.toBeInstanceOf(RefreshSessionBusyError);
    expect(outcome).toBeInstanceOf(Error);
  });
});
