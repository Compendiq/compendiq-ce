import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetPool } = vi.hoisted(() => ({
  mockGetPool: vi.fn(),
}));

vi.mock('../db/postgres.js', () => ({
  getPool: () => mockGetPool(),
}));

import { withLocalAttachmentMutationLock } from './attachment-snapshot-lock.js';

const falsyRejections = [undefined, null, false, 0, ''] as const;

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await promise.then(
    () => ({ rejected: false as const, value: undefined }),
    (value: unknown) => ({ rejected: true as const, value }),
  );
  expect(outcome.rejected).toBe(true);
  return outcome.value;
}

function fakeClient(query: (sql: string) => Promise<unknown>) {
  const client = {
    query: vi.fn(query),
    release: vi.fn(),
  } as unknown as PoolClient;
  mockGetPool.mockReturnValue({ connect: vi.fn(async () => client) });
  return client;
}

beforeEach(() => {
  mockGetPool.mockReset();
});

describe('local attachment mutation lock error preservation', () => {
  it.each(falsyRejections)('preserves falsy operation rejection %#', async (failure) => {
    fakeClient(async () => ({ rows: [] }));

    const actual = await rejectedValue(
      withLocalAttachmentMutationLock(() => Promise.reject(failure)),
    );

    expect(Object.is(actual, failure)).toBe(true);
  });

  it.each(falsyRejections)('surfaces falsy unlock rejection %#', async (failure) => {
    fakeClient(async (sql) => {
      if (sql.includes('pg_advisory_unlock_shared')) throw failure;
      return { rows: [] };
    });

    const actual = await rejectedValue(
      withLocalAttachmentMutationLock(async () => 'completed'),
    );

    expect(Object.is(actual, failure)).toBe(true);
  });

  it('preserves a falsy operation rejection when cleanup also fails', async () => {
    const cleanupFailure = new Error('unlock failed');
    fakeClient(async (sql) => {
      if (sql.includes('pg_advisory_unlock_shared')) throw cleanupFailure;
      return { rows: [] };
    });

    const actual = await rejectedValue(
      withLocalAttachmentMutationLock(() => Promise.reject(false)),
    );

    expect(actual).toBe(false);
  });
});
