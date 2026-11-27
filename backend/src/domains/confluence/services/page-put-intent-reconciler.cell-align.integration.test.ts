import { describe, expect, it } from 'vitest';
import { STORAGE_DERIVATION_BASE_CORPUS } from '../../../core/services/__fixtures__/storage-derivation-base-corpus.js';
import {
  ALL_STORAGE_DERIVATION_FEATURES,
  NO_STORAGE_DERIVATION_FEATURES,
} from '../../../core/services/storage-derivation.js';
import { deriveVersionRestoreStorage } from './page-put-intent-reconciler.js';
import {
  expectRestoreFenced,
  expectRestoreRecoveredOnce,
  restoreDerivationStackAvailable,
  describeRestoreDerivationFeature,
  useRestoreDerivationHarness,
} from './__fixtures__/test-restore-derivation-contract.js';

// #1956: feature `cell-align`. A version restore derives the storage it sends from a historical body_html and
// derives it again when it publishes, so an intent reserved before the feature (a raw `align` on a historical
// cell, the shape pre-#1956 Improve apply and Markdown imports left in body_html) must still derive its base bytes.

function corpusEntry(name: string) {
  const entry = STORAGE_DERIVATION_BASE_CORPUS.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`No base-corpus entry ${name}`);
  return entry;
}

describeRestoreDerivationFeature({
  feature: 'cell-align',
  entry: corpusEntry('cell-align-raw'),
  featureStorage: '<table><tbody><tr><th style="text-align: center;">H</th><td style="text-align: right;">1</td></tr>'
    + '<tr><td style="text-align: center;">2</td><td style="color: red; text-align: left">3</td></tr></tbody></table>',
});

describeRestoreDerivationFeature({
  feature: 'cell-align',
  entry: corpusEntry('cell-align-editor-table'),
  featureStorage: '<table style="min-width: 50px;"><colgroup><col style="min-width: 25px;" /><col style="min-width: 25px;" /></colgroup><tbody>'
    + '<tr><th colspan="1" rowspan="1" style="text-align: center;"><p>a</p></th><th colspan="1" rowspan="1"><p>b</p></th></tr>'
    + '<tr><td colspan="1" rowspan="1" style="text-align: right;"><p>1</p></td>'
    + '<td colspan="2" rowspan="1" style="text-align: left;"><p>2</p></td></tr></tbody></table>',
});

describe('the cell-align derivation of a restore (#1956)', () => {
  const derive = (name: string, features: typeof NO_STORAGE_DERIVATION_FEATURES): string => {
    const entry = corpusEntry(name);
    return deriveVersionRestoreStorage(
      entry.targetHtml,
      { body_storage: entry.previousStorage, body_html: entry.storedBodyHtml },
      features,
    );
  };

  it.each([
    'cell-align-marked-gfm-table',
    'cell-align-style-forms',
    'cell-align-in-panel',
  ])('derives the base bytes of %s without the feature and a different storage with it', (name) => {
    expect(derive(name, NO_STORAGE_DERIVATION_FEATURES)).toBe(corpusEntry(name).storage);
    expect(derive(name, ALL_STORAGE_DERIVATION_FEATURES)).not.toBe(corpusEntry(name).storage);
  });

  it('keeps an ambiguous or deciding style byte for byte under the feature', () => {
    const storage = derive('cell-align-style-forms', ALL_STORAGE_DERIVATION_FEATURES);
    expect(storage).toContain('<th style="text-align: justify">a</th>');
    expect(storage).toContain('<th style="TEXT-ALIGN: right">b</th>');
    expect(storage).toContain('<td style="text-align: left; text-align: right">1</td>');
    expect(storage).toContain('<th style="color: red; text-align: right;">c</th>');
    expect(storage).not.toContain('align="');
  });

  it('derives the same storage as a confluence-stored aligned cell was read from', () => {
    expect(derive('cell-align-confluence-stored', ALL_STORAGE_DERIVATION_FEATURES)).toBe(corpusEntry('cell-align-confluence-stored').storage);
  });

  // The combined shape: one historical row that holds the raw-align cell and tasks and links, derived against the live
  // row's storage, recovered by an intent reserved before the feature.
  describe.skipIf(!restoreDerivationStackAvailable)('combined restore target', () => {
    const harness = useRestoreDerivationHarness();
    const combined = corpusEntry('combined-restore-target');

    it('recovers a pre-feature intent of the combined target once, without another PUT', async () => {
      const seeded = await harness.seedRestore({ ...combined, reservedStorage: combined.storage });
      await expectRestoreRecoveredOnce(harness, seeded, combined.storage);
    });

    it('keeps a changed cell in the combined target fenced under the pre-feature profile', async () => {
      const seeded = await harness.seedRestore({
        ...combined,
        reservedStorage: combined.storage,
        targetHtml: combined.targetHtml.replace('<th align="center">H</th>', '<th align="center">Changed</th>'),
      });
      await expectRestoreFenced(harness, seeded, 'intent_restore_target_changed');
    });
  });
});
