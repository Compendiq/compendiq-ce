import { setImmediate } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
} from '../../../test-db-helper.js';
import { notionImportLockId, withNotionImportLock } from './notion-import-lock.js';

const dbAvailable = await isDbAvailable();

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  const result = Promise.withResolvers<void>();
  return { promise: result.promise, resolve: () => result.resolve() };
}

describe('notion import lock IDs', () => {
  it('maps dashed, undashed, and differently-cased forms of one Notion page ID to the same key', () => {
    const dashed = 'A1B2C3D4-E5F6-47A8-90BC-DEF123456789';
    const undashed = 'a1b2c3d4e5f647a890bcdef123456789';

    expect(notionImportLockId(dashed)).toBe(notionImportLockId(undashed));
  });
});

describe.skipIf(!dbAvailable)('withNotionImportLock', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('allows different page IDs to proceed independently', async () => {
    const releaseFirst = deferred();
    const firstEntered = deferred();
    const secondEntered = deferred();

    const first = withNotionImportLock('11111111-1111-4111-8111-111111111111', async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const second = withNotionImportLock('22222222-2222-4222-8222-222222222222', async () => {
      secondEntered.resolve();
    });

    await secondEntered.promise;
    releaseFirst.resolve();
    await Promise.all([first, second]);
  });

  it('serializes operations for normalized forms of the same page ID', async () => {
    const releaseFirst = deferred();
    const firstEntered = deferred();
    let secondEntered = false;

    const first = withNotionImportLock('A1B2C3D4-E5F6-47A8-90BC-DEF123456789', async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const second = withNotionImportLock('a1b2c3d4e5f647a890bcdef123456789', async () => {
      secondEntered = true;
    });
    await setImmediate();

    expect(secondEntered).toBe(false);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });
});
