import { describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { STORAGE_DERIVATION_BASE_CORPUS } from '../../../core/services/__fixtures__/storage-derivation-base-corpus.js';
import { reconcilePageWriteIntent } from '../../../core/services/page-write-admission.js';
import {
  ALL_STORAGE_DERIVATION_FEATURES,
  NO_STORAGE_DERIVATION_FEATURES,
} from '../../../core/services/storage-derivation.js';
import {
  confluencePagePutDigest,
  deriveVersionRestoreStorage,
  describeConfluencePagePut,
} from './page-put-intent-reconciler.js';
import {
  expectRestoreFenced,
  expectRestoreRecoveredOnce,
  restoreDerivationStackAvailable,
  useRestoreDerivationHarness,
} from './__fixtures__/test-restore-derivation-contract.js';

function corpusEntry(name: string) {
  const entry = STORAGE_DERIVATION_BASE_CORPUS.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`No base-corpus entry ${name}`);
  return entry;
}

describe('the storage a version restore derives (#1953)', () => {
  it.each(STORAGE_DERIVATION_BASE_CORPUS.map((entry) => [entry.name, entry] as const))(
    'is the base bytes of %s when the intent recorded no feature',
    (_name, entry) => {
      expect(deriveVersionRestoreStorage(
        entry.targetHtml,
        { body_storage: entry.previousStorage, body_html: entry.storedBodyHtml },
        NO_STORAGE_DERIVATION_FEATURES,
      )).toBe(entry.storage);
    },
  );

  it('records the feature names of a restore in its effect only when a feature is in force', () => {
    const restore = {
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
    } as const;
    const base = describeConfluencePagePut({ ...restore, derivationFeatures: NO_STORAGE_DERIVATION_FEATURES });
    expect(Object.keys(base.effect).sort()).toEqual([
      'confluenceId', 'effectClass', 'expectedLocalVersion', 'expectedRemoteVersion',
      'intendedStateDigest', 'pageId', 'targetSource', 'targetVersion',
    ]);
    const current = describeConfluencePagePut({ ...restore, derivationFeatures: ALL_STORAGE_DERIVATION_FEATURES });
    expect(current.effect.derivationFeatures).toEqual(
      ALL_STORAGE_DERIVATION_FEATURES.size === 0 ? undefined : [...ALL_STORAGE_DERIVATION_FEATURES].sort(),
    );
    expect(current.derivationFeatures).toBe(ALL_STORAGE_DERIVATION_FEATURES);
  });
});

describe.skipIf(!restoreDerivationStackAvailable)('recovery of a version restore by its recorded storage derivation (#1953)', () => {
  const harness = useRestoreDerivationHarness();

  // The combined shape of a pre-epic restore: a raw `align` cell, tasks that
  // take their ids from the stored storage, carrier links and an annotated
  // code block, and the single constructs the sibling features change.
  it.each([
    'combined-restore-target',
    'cell-align-raw',
    'link-carriers-hand-written',
    'tasks-nested-idless-target',
    'tasks-nested-list-before-own-text',
    'task-text-from-bodyless-links',
  ])('recovers an accepted restore of %s reserved before the epic once, without another PUT', async (name) => {
    const entry = corpusEntry(name);
    const seeded = await harness.seedRestore({ ...entry, reservedStorage: entry.storage });
    await expectRestoreRecoveredOnce(harness, seeded, entry.storage);
  });

  it('accepts a historical row rewritten to HTML that derives the same storage and title', async () => {
    // The digest proves the derived storage and the effective title, not the
    // row: a generated index is dropped by the write-back, so adding one after
    // the reservation derives the reserved bytes again. The row itself is
    // compared by the route before the provider PUT.
    const plain = corpusEntry('generated-index-plain');
    const indexed = corpusEntry('generated-index-with-figure-index');
    expect(indexed.targetHtml).not.toBe(plain.targetHtml);
    expect(indexed.storage).toBe(plain.storage);
    const seeded = await harness.seedRestore({ ...plain, reservedStorage: plain.storage });
    await query(
      'UPDATE page_versions SET body_html = $2 WHERE page_id = $1 AND version_number = 2',
      [seeded.pageId, indexed.targetHtml],
    );
    await expectRestoreRecoveredOnce(harness, seeded, plain.storage);
  });

  it.each([
    ['other body text', `body_html = '<h2>Figures</h2><p>Other body text</p>'`],
    ['one more paragraph', `body_html = body_html || '<p>appended</p>'`],
    ['another effective title', `title = 'Another title'`],
  ])('keeps a historical row rewritten to %s fenced', async (_label, assignment) => {
    const plain = corpusEntry('generated-index-plain');
    const seeded = await harness.seedRestore({ ...plain, reservedStorage: plain.storage });
    await query(
      `UPDATE page_versions SET ${assignment} WHERE page_id = $1 AND version_number = 2`,
      [seeded.pageId],
    );
    await expectRestoreFenced(harness, seeded, 'intent_restore_target_changed');
  });

  it('settles a restore not applied when Confluence accepted a different body', async () => {
    const entry = corpusEntry('combined-restore-target');
    const seeded = await harness.seedRestore({
      ...entry,
      reservedStorage: entry.storage,
      remoteStorage: `${entry.storage}<p>someone else</p>`,
    });
    await expect(harness.recover(seeded.intentId)).resolves.toEqual({
      intentId: seeded.intentId,
      status: 'reconciled_not_applied',
    });
    expect(await harness.page(seeded.pageId)).toMatchObject({ title: 'Live title', version: 5, remote_version: 5 });
    expect(harness.confluence.sent('update')).toHaveLength(0);
  });

  it('refuses a restore that records a feature this release does not register before taking ownership, without reading Confluence', async () => {
    const entry = corpusEntry('combined-restore-target');
    for (const recordedFeatures of [['never-registered-feature'], ['a-first', 'never-registered-feature']]) {
      const seeded = await harness.seedRestore({ ...entry, reservedStorage: entry.storage, recordedFeatures });
      const reserved = await harness.intentOwnership(seeded.intentId);
      expect(reserved).toMatchObject({ ownerFenced: true, recoveryStarted: false, attempts: [] });
      await expectRestoreFenced(harness, seeded, 'intent_restore_derivation_unsupported');
      // Still the fenced runtime's, with no recovery attempt: a runtime that
      // registers the feature claims it as if this one had never been asked.
      expect(await harness.intentOwnership(seeded.intentId)).toEqual(reserved);
    }
    expect(harness.confluence.requests).toHaveLength(0);
  });

  it('checks the administrator and the owner\'s fence before it answers that the derivation is unsupported', async () => {
    const entry = corpusEntry('combined-restore-target');
    const seeded = await harness.seedRestore({
      ...entry,
      reservedStorage: entry.storage,
      recordedFeatures: ['never-registered-feature'],
    });
    const reserved = await harness.intentOwnership(seeded.intentId);
    await expect(reconcilePageWriteIntent(seeded.intentId, {
      actorId: harness.actorId,
      reason: 'A writer without the administrator role asks for the recovery',
    })).rejects.toMatchObject({ statusCode: 403, reason: 'recovery_admin_required' });

    await query(
      `UPDATE page_writer_runtimes
          SET fenced_at = NULL, fenced_by = NULL, fence_reason = NULL, fence_proof = NULL
        WHERE runtime_id = $1`,
      [reserved.runtimeId],
    );
    await expect(harness.recover(seeded.intentId)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'runtime_not_safely_fenced',
    });
    expect(await harness.intentOwnership(seeded.intentId)).toEqual({ ...reserved, ownerFenced: false });
    expect(await harness.intentStatus(seeded.intentId)).toBe('pending');
    expect(harness.confluence.requests).toHaveLength(0);
  });

  it.each([
    ['a string', 'cell-align'],
    ['null', null],
    ['an empty list', []],
    ['an unsorted list', ['b-feature', 'a-feature']],
    ['a repeated name', ['a-feature', 'a-feature']],
    ['a non-string member', ['a-feature', 1]],
    ['an invalid name', ['A_Feature']],
    ['17 names', Array.from({ length: 17 }, (_, index) => `f${String(index).padStart(2, '0')}`)],
  ])('refuses a restore whose recorded features are %s as invalid metadata', async (_label, recordedFeatures) => {
    const entry = corpusEntry('combined-restore-target');
    const seeded = await harness.seedRestore({ ...entry, reservedStorage: entry.storage, recordedFeatures });
    await expectRestoreFenced(harness, seeded, 'intent_recovery_metadata_invalid');
    expect(harness.confluence.requests).toHaveLength(0);
  });

  async function seedAiApply(recordedFeatures?: unknown): Promise<{ intentId: string; pageId: number }> {
    const { pageId, confluenceId } = await harness.seedPage({
      previousStorage: '<p>live</p>',
      storedBodyHtml: '<p>live</p>',
    });
    const improvement = await query<{ id: string }>(
      `INSERT INTO llm_improvements
         (user_id, page_id, improvement_type, model, original_content, improved_content, status)
       VALUES ($1, $2, 'clarity', 'test-model', 'old', 'intended', 'completed')
       RETURNING id`,
      [harness.actorId, pageId],
    );
    const storage = '<p>improved</p>';
    harness.confluence.addPage({ id: confluenceId, title: 'Live title', version: 6, storage });
    const intentId = await harness.insertPendingIntent({
      kind: 'page.ai_apply',
      pageId,
      effect: {
        effectClass: 'remote',
        pageId,
        confluenceId,
        expectedRemoteVersion: '5',
        expectedLocalVersion: 5,
        intendedStateDigest: confluencePagePutDigest({
          pageId, confluenceId, title: 'Live title', bodyStorage: storage, expectedRemoteVersion: 5,
        }),
        improvementId: improvement.rows[0]!.id,
        ...(recordedFeatures === undefined ? {} : { derivationFeatures: recordedFeatures }),
      },
    });
    return { intentId, pageId };
  }

  it.each([
    ['a well-formed list', ['never-registered-feature']],
    ['a malformed value', 'never-registered-feature'],
    ['an empty list', []],
  ])('refuses an AI apply effect that holds recorded features (%s)', async (_label, recordedFeatures) => {
    const refused = await seedAiApply(recordedFeatures);
    await expect(harness.recover(refused.intentId)).rejects.toMatchObject({
      statusCode: 409,
      reason: 'intent_recovery_metadata_invalid',
    });
    expect(await harness.intentStatus(refused.intentId)).toBe('pending');
    expect(harness.confluence.requests).toHaveLength(0);
    expect(await harness.page(refused.pageId)).toMatchObject({ body_storage: '<p>live</p>', version: 5 });

    // The same effect without the key is the valid AI apply intent.
    const valid = await seedAiApply();
    await expect(harness.recover(valid.intentId)).resolves.toEqual({
      intentId: valid.intentId,
      status: 'reconciled_applied',
    });
    expect(await harness.page(valid.pageId)).toMatchObject({ body_storage: '<p>improved</p>', version: 6 });
    expect(harness.confluence.sent('update')).toHaveLength(0);
  });
});
