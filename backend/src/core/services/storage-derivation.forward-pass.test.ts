/**
 * The forward pass a write-back runs on `previousStorage` derives with the
 * write-back's own features (#1953), before any registered feature gates a
 * forward step.
 *
 * Two features are registered here, and the forward-pass seam stands in the
 * gated step of `test-b`: it reads the stored task ids in the opposite order.
 * The stored tasks then pair with different ids when `test-b` is in force, so
 * the storage a write-back derives shows which set reached that pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setForwardDerivationStepForTest, confluenceToHtml, htmlToConfluence } from './content-converter.js';
import type * as Derivation from './storage-derivation.js';

const TEST_FEATURES = vi.hoisted(() => ['test-a', 'test-b'] as const);

vi.mock('./storage-derivation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Derivation>();
  const registry = actual.storageDerivationRegistry(TEST_FEATURES);
  return {
    ...actual,
    STORAGE_DERIVATION_FEATURES: TEST_FEATURES,
    ALL_STORAGE_DERIVATION_FEATURES: registry.all,
    NO_STORAGE_DERIVATION_FEATURES: registry.none,
    derivationHas: registry.has,
    encodeStorageDerivationFeatures: registry.encode,
    decodeStorageDerivationFeatures: registry.decode,
    assertStorageDerivationFeatures: registry.assert,
  };
});

const storedTask = (id: number, text: string): string =>
  `<ac:task><ac:task-id>${id}</ac:task-id><ac:task-status>incomplete</ac:task-status>`
  + `<ac:task-body>${text}</ac:task-body></ac:task>`;
const writtenTask = (id: number, text: string): string =>
  `<ac:task><ac:task-id>${id}</ac:task-id><ac:task-status>incomplete</ac:task-status>`
  + `<ac:task-body><p>${text}</p></ac:task-body></ac:task>`;

const STORED = `<ac:task-list>${storedTask(7, 'Alpha')}${storedTask(8, 'Beta')}</ac:task-list>`;
// The editor's tasks carry no id: each takes the id of the stored task with its text.
const TARGET = '<ul data-type="taskList">'
  + '<li data-type="taskItem" data-checked="false"><p>Alpha</p></li>'
  + '<li data-type="taskItem" data-checked="false"><p>Beta</p></li></ul>';

const WITHOUT_TEST_B = `<ac:task-list>${writtenTask(7, 'Alpha')}${writtenTask(8, 'Beta')}</ac:task-list>`;
const WITH_TEST_B = `<ac:task-list>${writtenTask(8, 'Alpha')}${writtenTask(7, 'Beta')}</ac:task-list>`;

describe('the forward pass of a write-back derives with the write-back\'s features (#1953)', () => {
  beforeEach(() => {
    _setForwardDerivationStepForTest((doc, inForce: ReadonlySet<string>) => {
      if (!inForce.has('test-b')) return;
      const ids = [...doc.getElementsByTagName('ac:task-id')];
      const values = ids.map((id) => id.textContent);
      ids.forEach((id, index) => { id.textContent = values[values.length - 1 - index]!; });
    });
  });

  afterEach(() => {
    _setForwardDerivationStepForTest(undefined);
  });

  it('runs the step of test-b in the forward pass of every reader', () => {
    const html = confluenceToHtml(STORED);
    expect(html.indexOf('data-task-id="8"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-task-id="8"')).toBeLessThan(html.indexOf('data-task-id="7"'));
  });

  it.each([
    [[], WITHOUT_TEST_B],
    [['test-a'], WITHOUT_TEST_B],
    [['test-b'], WITH_TEST_B],
    [['test-a', 'test-b'], WITH_TEST_B],
  ])('reads the stored tasks of a write-back that states %j with exactly that set', (names, storage) => {
    expect(htmlToConfluence(TARGET, {
      previousStorage: STORED,
      derivationFeatures: new Set(names) as unknown as Derivation.StorageDerivationFeatures,
    })).toBe(storage);
  });

  it('reads them with every registered feature for a writer that states no set', () => {
    expect(htmlToConfluence(TARGET, { previousStorage: STORED })).toBe(WITH_TEST_B);
  });
});
