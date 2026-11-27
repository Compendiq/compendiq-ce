/**
 * Restore derivation feature `nested-tasks` (#1957, epic #2027 decision D7).
 *
 * Write-back reads the stored tasks of `previousStorage` through the forward
 * pass (storedTasks), and #1957 changed how that pass converts task lists. For
 * storage Confluence writes the stored ids and texts stay the same (every
 * nested corpus entry derives its base bytes with the feature too); for a list
 * placed before its task's own body they do not, so the derivation of a
 * restore reserved before #1957 keeps the old loop: real PostgreSQL and Redis
 * and a loopback Confluence (test-restore-derivation-contract.ts).
 */
import { describe, expect, it } from 'vitest';
import { STORAGE_DERIVATION_BASE_CORPUS } from '../../../core/services/__fixtures__/storage-derivation-base-corpus.js';
import { ALL_STORAGE_DERIVATION_FEATURES, NO_STORAGE_DERIVATION_FEATURES } from '../../../core/services/storage-derivation.js';
import {
  describeRestoreDerivationFeature,
  expectRestoreRecoveredOnce,
  restoreDerivationStackAvailable,
  useRestoreDerivationHarness,
} from './__fixtures__/test-restore-derivation-contract.js';
import { deriveVersionRestoreStorage } from './page-put-intent-reconciler.js';

const corpus = (name: string) => STORAGE_DERIVATION_BASE_CORPUS.find((entry) => entry.name === name)!;

// bff6d4ec read task 1's text from the nested task's body (`n`), so the
// id-less `n` took id 1; with nested-tasks task 1 reads its own body (`own`).
describeRestoreDerivationFeature({
  feature: 'nested-tasks',
  entry: corpus('tasks-list-before-own-body'),
  featureStorage: '<ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>n</p></ac:task-body></ac:task><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><p>own</p></ac:task-body></ac:task></ac:task-list>',
});

describe.skipIf(!restoreDerivationStackAvailable)('restore of nested tasks Confluence writes (#1957)', () => {
  const harness = useRestoreDerivationHarness();
  const nested = ['tasks-nested-1957-macros-idless', 'tasks-nested-12-levels-idless', 'tasks-three-levels-with-macro'];

  it('derives the same storage with and without nested-tasks', () => {
    for (const name of nested) {
      const entry = corpus(name);
      const derive = (features: typeof ALL_STORAGE_DERIVATION_FEATURES) => deriveVersionRestoreStorage(
        entry.targetHtml,
        { body_storage: entry.previousStorage, body_html: entry.storedBodyHtml },
        features,
      );
      expect(derive(NO_STORAGE_DERIVATION_FEATURES), name).toBe(entry.storage);
      expect(derive(ALL_STORAGE_DERIVATION_FEATURES), name).toBe(entry.storage);
    }
  });

  it('recovers a restore of a nested page with block and inline macros reserved before #1957, once, without another PUT', async () => {
    const entry = corpus('tasks-nested-1957-macros-idless');
    const seeded = await harness.seedRestore({ ...entry, reservedStorage: entry.storage });
    await expectRestoreRecoveredOnce(harness, seeded, entry.storage);
  });

  it('recovers the same restore reserved with every feature', async () => {
    const entry = corpus('tasks-nested-1957-macros-idless');
    const seeded = await harness.seedRestore({
      ...entry,
      reservedStorage: entry.storage,
      recordedFeatures: [...ALL_STORAGE_DERIVATION_FEATURES].sort(),
    });
    await expectRestoreRecoveredOnce(harness, seeded, entry.storage);
  });
});
