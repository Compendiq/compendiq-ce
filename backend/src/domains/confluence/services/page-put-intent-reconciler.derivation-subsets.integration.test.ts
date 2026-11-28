/**
 * Partial feature subsets (#1953), before any sibling feature exists.
 *
 * This file stands in three registered features: the registry is replaced by
 * one over `test-a`, `test-b` and `test-c`, and the write-back appends one
 * marker paragraph per feature in force, so every subset derives different
 * storage from the same row. Recovery must derive with exactly the subset an
 * intent recorded: not with the release's full set, and not with none.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Converter from '../../../core/services/content-converter.js';
import type * as Derivation from '../../../core/services/storage-derivation.js';
import { STORAGE_DERIVATION_BASE_CORPUS } from '../../../core/services/__fixtures__/storage-derivation-base-corpus.js';
import {
  describeRestoreDerivationFeature,
  expectRestoreFenced,
  expectRestoreRecoveredOnce,
  restoreDerivationStackAvailable,
  useRestoreDerivationHarness,
} from './__fixtures__/test-restore-derivation-contract.js';
import { describeConfluencePagePut } from './page-put-intent-reconciler.js';

const TEST_FEATURES = vi.hoisted(() => ['test-c', 'test-a', 'test-b'] as const);
/** A feature this runtime does not register: a pod of an older release in a rolling deployment. */
const RUNTIME = vi.hoisted(() => ({ lacks: undefined as string | undefined }));

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
    decodeStorageDerivationFeatures: (value: unknown) => (RUNTIME.lacks === undefined
      ? registry
      : actual.storageDerivationRegistry(TEST_FEATURES.filter((name) => name !== RUNTIME.lacks))
    ).decode(value),
    assertStorageDerivationFeatures: registry.assert,
  };
});

vi.mock('../../../core/services/content-converter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Converter>();
  return {
    ...actual,
    htmlToConfluence: (html: string, options: Converter.HtmlToConfluenceOptions = {}) => {
      const features: ReadonlySet<string> | undefined = options.derivationFeatures;
      const inForce = [...TEST_FEATURES].sort().filter((name) => features === undefined || features.has(name));
      return actual.htmlToConfluence(html, options) + inForce.map((name) => `<p>${name}</p>`).join('');
    },
  };
});

const entry = STORAGE_DERIVATION_BASE_CORPUS.find((candidate) => candidate.name === 'combined-restore-target')!;
const marked = (...names: string[]): string => entry.storage + names.map((name) => `<p>${name}</p>`).join('');

// The contract every registering pull request runs, for the middle feature.
describeRestoreDerivationFeature({
  feature: 'test-b' as never,
  entry,
  featureStorage: marked('test-b'),
});

describe.skipIf(!restoreDerivationStackAvailable)('recovery with a partial subset of three registered features (#1953)', () => {
  const harness = useRestoreDerivationHarness();

  afterEach(() => {
    RUNTIME.lacks = undefined;
  });

  it('records the names in force in ascending order, whatever the registration order', () => {
    const publication = describeConfluencePagePut({
      kind: 'page.version_restore',
      actorId: '00000000-0000-4000-8000-000000000001',
      pageId: 7,
      confluenceId: 'c-7',
      title: 'Title',
      bodyStorage: '<p>x</p>',
      expectedRemoteVersion: 5,
      expectedLocalVersion: 5,
      targetVersion: 2,
      targetSource: 'confluence',
      derivationFeatures: new Set(TEST_FEATURES) as never,
    });
    expect(publication.effect.derivationFeatures).toEqual(['test-a', 'test-b', 'test-c']);
  });

  it.each([
    [['test-a']],
    [['test-c']],
    [['test-a', 'test-c']],
    [['test-b', 'test-c']],
    [['test-a', 'test-b', 'test-c']],
  ])('recovers a restore that recorded %j with exactly those features', async (recordedFeatures) => {
    const seeded = await harness.seedRestore({
      ...entry,
      reservedStorage: marked(...recordedFeatures),
      recordedFeatures,
    });
    await expectRestoreRecoveredOnce(harness, seeded, marked(...recordedFeatures));
  });

  it('recovers a restore reserved before any feature with none, although three are registered', async () => {
    const seeded = await harness.seedRestore({ ...entry, reservedStorage: entry.storage });
    await expectRestoreRecoveredOnce(harness, seeded, entry.storage);
  });

  it('never derives a recorded subset with the full set of the release, nor a missing record with it', async () => {
    const full = marked('test-a', 'test-b', 'test-c');
    // Confluence holds the bytes of the full set and the digest names them,
    // so only a derivation that ignored the record could publish this.
    const subset = await harness.seedRestore({ ...entry, reservedStorage: full, recordedFeatures: ['test-b'] });
    await expectRestoreFenced(harness, subset, 'intent_restore_target_changed');
    const unrecorded = await harness.seedRestore({ ...entry, reservedStorage: full });
    await expectRestoreFenced(harness, unrecorded, 'intent_restore_target_changed');
  });

  it('does not fall back to another subset when the recorded one does not reproduce the digest', async () => {
    const seeded = await harness.seedRestore({
      ...entry,
      reservedStorage: marked('test-a'),
      recordedFeatures: ['test-a', 'test-c'],
    });
    await expectRestoreFenced(harness, seeded, 'intent_restore_target_changed');
  });

  it('refuses a subset that names a fourth, unregistered feature', async () => {
    const seeded = await harness.seedRestore({
      ...entry,
      reservedStorage: marked('test-a'),
      recordedFeatures: ['test-a', 'test-d'],
    });
    await expectRestoreFenced(harness, seeded, 'intent_restore_derivation_unsupported');
    expect(harness.confluence.requests).toHaveLength(0);
  });

  it('refuses a restore of a newer release before taking ownership, so a runtime that registers the feature settles it', async () => {
    const recordedFeatures = ['test-a', 'test-b'];
    const seeded = await harness.seedRestore({
      ...entry,
      reservedStorage: marked(...recordedFeatures),
      recordedFeatures,
    });
    const reserved = await harness.intentOwnership(seeded.intentId);
    expect(reserved).toMatchObject({ ownerFenced: true, recoveryStarted: false, attempts: [] });

    RUNTIME.lacks = 'test-b';
    await expectRestoreFenced(harness, seeded, 'intent_restore_derivation_unsupported');
    // The fenced runtime of the request still owns the intent and no attempt
    // is recorded: nothing stands between it and a runtime that can derive it.
    expect(await harness.intentOwnership(seeded.intentId)).toEqual(reserved);
    expect(harness.confluence.requests).toHaveLength(0);

    RUNTIME.lacks = undefined;
    await expectRestoreRecoveredOnce(harness, seeded, marked(...recordedFeatures));
    // Settled by one claim, a transfer from that fenced runtime: not a retry
    // of a claim the refusing runtime had taken.
    const settled = await harness.intentOwnership(seeded.intentId);
    expect(settled.attempts).toEqual([
      expect.objectContaining({ attemptKind: 'runtime_transfer', fromRuntimeId: reserved.runtimeId }),
    ]);
    expect(settled.runtimeId).not.toBe(reserved.runtimeId);
  });
});
