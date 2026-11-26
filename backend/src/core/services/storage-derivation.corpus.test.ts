import { describe, expect, it } from 'vitest';
import { hasOnlyUncarriedTasks, htmlToConfluence } from './content-converter.js';
import { NO_STORAGE_DERIVATION_FEATURES, type StorageDerivationFeatures } from './storage-derivation.js';
import { STORAGE_DERIVATION_BASE_CORPUS } from './__fixtures__/storage-derivation-base-corpus.js';

const STORED_TASKS = '<ac:task-list><ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status>'
  + '<ac:task-body>Stored task</ac:task-body></ac:task></ac:task-list>';
const IDLESS_TASK = '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Stored task</p></li></ul>';

/** A feature set that counts how often the converter reads its members. */
class ObservedFeatures extends Set<never> {
  reads = 0;

  override [Symbol.iterator](): SetIterator<never> {
    this.reads += 1;
    return super[Symbol.iterator]();
  }
}

describe('storage derivation without features: the write-back of bff6d4ec (#1953)', () => {
  // The restore derivation of an intent reserved before the epic. A feature
  // whose step is not gated, in the reverse pass or in the forward conversion
  // of `previousStorage`, changes one of these literals.
  it.each(STORAGE_DERIVATION_BASE_CORPUS.map((entry) => [entry.name, entry] as const))(
    'derives the base bytes of %s',
    (_name, entry) => {
      expect(htmlToConfluence(entry.targetHtml, {
        previousStorage: entry.previousStorage,
        legacyTasks: hasOnlyUncarriedTasks(entry.storedBodyHtml),
        derivationFeatures: NO_STORAGE_DERIVATION_FEATURES,
      })).toBe(entry.storage);
    },
  );

  it('gives every corpus entry a distinct name', () => {
    const names = STORAGE_DERIVATION_BASE_CORPUS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('converts the stored storage with the set the write-back was given, not with every feature', () => {
    // The write-back reads its set once; the forward conversion of the stored
    // tasks reads the same set again. A conversion that fell back to the full
    // set would leave the second read out.
    const withStoredTasks = new ObservedFeatures();
    expect(htmlToConfluence(IDLESS_TASK, {
      previousStorage: STORED_TASKS,
      derivationFeatures: withStoredTasks as StorageDerivationFeatures,
    })).toContain('<ac:task-id>7</ac:task-id>');
    expect(withStoredTasks.reads).toBe(2);

    const withoutStoredStorage = new ObservedFeatures();
    htmlToConfluence(IDLESS_TASK, { derivationFeatures: withoutStoredStorage as StorageDerivationFeatures });
    expect(withoutStoredStorage.reads).toBe(1);
  });

  it('refuses a write-back whose set names a feature this release does not register', () => {
    const unregistered = new Set(['never-registered-feature']) as unknown as StorageDerivationFeatures;
    expect(() => htmlToConfluence('<p>x</p>', { derivationFeatures: unregistered })).toThrow(/unregistered feature/);
    expect(() => htmlToConfluence(IDLESS_TASK, {
      previousStorage: STORED_TASKS,
      derivationFeatures: unregistered,
    })).toThrow(/unregistered feature/);
  });
});
