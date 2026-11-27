/**
 * #1955, review r1 R9 (W7): a restore that recorded a partial profile.
 *
 * Until a sibling feature exists, this file registers one beside `link-kinds`
 * (`test-other`), whose write-back appends a marker paragraph. A restore that
 * recorded `test-other` alone is derived with that feature and without
 * `link-kinds`: the same bodies `link-kinds` refuses are derived as the base
 * commit derived them, with the other feature's effect, and never meet the
 * judgement of #1955.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as Converter from '../../../core/services/content-converter.js';
import { ConfluenceStorageRefusedError } from '../../../core/services/confluence-storage-reader.js';
import type * as Derivation from '../../../core/services/storage-derivation.js';
import { STORAGE_DERIVATION_BASE_CORPUS } from '../../../core/services/__fixtures__/storage-derivation-base-corpus.js';
import {
  expectRestoreFenced,
  expectRestoreRecoveredOnce,
  restoreDerivationStackAvailable,
  useRestoreDerivationHarness,
} from './__fixtures__/test-restore-derivation-contract.js';
import { deriveVersionRestoreStorage } from './page-put-intent-reconciler.js';

const TEST_FEATURES = vi.hoisted(() => ['link-kinds', 'test-other'] as const);

vi.mock('../../../core/services/storage-derivation.js', async (importOriginal) => {
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

vi.mock('../../../core/services/content-converter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Converter>();
  return {
    ...actual,
    // The real write-back, gated by the real `link-kinds` checks, then the stand-in feature's own step.
    htmlToConfluence: (html: string, options: Converter.HtmlToConfluenceOptions = {}) => {
      const features: ReadonlySet<string> | undefined = options.derivationFeatures;
      const other = features === undefined || features.has('test-other');
      return actual.htmlToConfluence(html, options) + (other ? '<p>test-other</p>' : '');
    },
  };
});

const OTHER = '<p>test-other</p>';
// The three bodies `link-kinds` refuses: a link in raw text, link markup in a body XML cannot read, and a
// link without a body that is not the exact shape.
const REFUSED = ['link-kinds-raw-text-link-markup', 'link-kinds-unreadable-with-link-markup', 'link-kinds-raw-link-markup'] as const;

function corpusEntry(name: string) {
  const entry = STORAGE_DERIVATION_BASE_CORPUS.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`No base-corpus entry ${name}`);
  return entry;
}

function derive(name: string, features: readonly string[]): string {
  const entry = corpusEntry(name);
  return deriveVersionRestoreStorage(
    entry.targetHtml,
    { body_storage: entry.previousStorage, body_html: entry.storedBodyHtml },
    new Set(features) as never,
  );
}

describe('the storage a restore derives under a partial profile without link-kinds (#1955, W7)', () => {
  it.each(REFUSED)('derives %s with the base link bytes and the other feature, and refuses it only with link-kinds', (name) => {
    const entry = corpusEntry(name);
    expect(derive(name, [])).toBe(entry.storage);
    // The other feature alone: its effect, on the bytes of the base commit, with nothing read or refused.
    expect(derive(name, ['test-other'])).toBe(entry.storage + OTHER);
    for (const withLinkKinds of [['link-kinds'], ['link-kinds', 'test-other']]) {
      expect(() => derive(name, withLinkKinds)).toThrow(ConfluenceStorageRefusedError);
    }
  });

  it('keeps the two features independent on a body link-kinds changes', () => {
    const name = 'link-carriers-hand-written';
    const entry = corpusEntry(name);
    expect(derive(name, ['test-other'])).toBe(entry.storage + OTHER);
    const linkKinds = derive(name, ['link-kinds']);
    expect(linkKinds).not.toBe(entry.storage);
    expect(derive(name, ['link-kinds', 'test-other'])).toBe(linkKinds + OTHER);
  });
});

describe.skipIf(!restoreDerivationStackAvailable)('recovery of a restore that recorded a partial profile without link-kinds (#1955, W7)', () => {
  const harness = useRestoreDerivationHarness();

  it.each(REFUSED)('recovers %s recorded with the other feature alone: base link bytes, its effect, no refusal, no PUT', async (name) => {
    const entry = corpusEntry(name);
    const reservedStorage = entry.storage + OTHER;
    const seeded = await harness.seedRestore({ ...entry, reservedStorage, recordedFeatures: ['test-other'] });
    // Settled applied with exactly these bytes, and `expectRestoreRecoveredOnce` asserts no PUT was issued.
    await expectRestoreRecoveredOnce(harness, seeded, reservedStorage);
    expect(harness.confluence.sent('update')).toHaveLength(0);
  });

  it.each(REFUSED)('does not accept the base bytes of %s for that profile: the other feature is in force', async (name) => {
    const entry = corpusEntry(name);
    const seeded = await harness.seedRestore({ ...entry, reservedStorage: entry.storage, recordedFeatures: ['test-other'] });
    await expectRestoreFenced(harness, seeded, 'intent_restore_target_changed');
  });

  it.each(REFUSED)('fences %s recorded with both features: the typed refusal, no retry under the partial profile', async (name) => {
    const entry = corpusEntry(name);
    // What the partial profile derives is what Confluence holds; a retry without link-kinds would settle this.
    const seeded = await harness.seedRestore({
      ...entry,
      reservedStorage: entry.storage + OTHER,
      recordedFeatures: ['link-kinds', 'test-other'],
    });
    await expectRestoreFenced(harness, seeded, 'intent_restore_target_changed');
    expect(harness.confluence.sent('update')).toHaveLength(0);
  });
});
