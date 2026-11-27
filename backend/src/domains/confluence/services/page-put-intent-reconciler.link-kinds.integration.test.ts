/**
 * #1955 registers the storage-derivation feature `link-kinds` (#1953): the
 * five link kinds, the class carrier of a navigable ri:url, and the judgement
 * of ri:url links on the written storage. A restore reserved without the
 * feature derives the bytes of the base commit and never meets that
 * judgement: no read, no repair, no refusal.
 */
import { describe, expect, it } from 'vitest';
import { ConfluenceStorageRefusedError } from '../../../core/services/confluence-storage-reader.js';
import { STORAGE_DERIVATION_BASE_CORPUS } from '../../../core/services/__fixtures__/storage-derivation-base-corpus.js';
import {
  NO_STORAGE_DERIVATION_FEATURES,
  type StorageDerivationFeatures,
} from '../../../core/services/storage-derivation.js';
import { deriveVersionRestoreStorage } from './page-put-intent-reconciler.js';
import {
  describeRestoreDerivationFeature,
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

const LINK_KINDS: StorageDerivationFeatures = new Set(['link-kinds']);

function derive(name: string, features: StorageDerivationFeatures): string {
  const entry = corpusEntry(name);
  return deriveVersionRestoreStorage(entry.targetHtml, { body_storage: entry.previousStorage, body_html: entry.storedBodyHtml }, features);
}

// Carriers of the five kinds in a historical body: with the feature they are links, the two unsafe
// URL carriers (no stored origin) are their text, the navigable one is a ri:url, and a class that is
// not the carrier of its own href stays what it was.
describeRestoreDerivationFeature({
  feature: 'link-kinds',
  entry: corpusEntry('link-carriers-hand-written'),
  featureStorage:
    '<p><ac:link><ri:space ri:space-key="ENG"></ri:space><ac:plain-text-link-body><![CDATA[s]]></ac:plain-text-link-body></ac:link> '
    + '<ac:link><ri:blog-post ri:content-title="News" ri:posting-day="2026/01/02"></ri:blog-post>'
    + '<ac:plain-text-link-body><![CDATA[b]]></ac:plain-text-link-body></ac:link> '
    + '<ac:link><ri:shortcut ri:key="jira" ri:parameter="ABC-1"></ri:shortcut><ac:plain-text-link-body><![CDATA[j]]></ac:plain-text-link-body></ac:link> '
    + '<ac:link><ri:content-entity ri:content-id="123"></ri:content-entity><ac:plain-text-link-body><![CDATA[c]]></ac:plain-text-link-body></ac:link> '
    + 'u empty '
    + '<ac:link><ri:url ri:value="https://example.com/x"></ri:url><ac:plain-text-link-body><![CDATA[n]]></ac:plain-text-link-body></ac:link> '
    + '<a href="https://example.com/y" class="#confluence-url:https%3A%2F%2Fexample.com%2Fother">mismatch</a></p>',
});

describe('the storage a version restore derives with and without link-kinds (#1955)', () => {
  it('reads the stored tasks with the #1955 link labels only with the feature', () => {
    // A stored task ends in a shortcut link without a body: its text is `Ticket ` without the feature and
    // `Ticket jira` with it, so a historical id-less task takes the stored id by one text or by the other.
    const ids = (storage: string): string[] => [...storage.matchAll(/<ac:task-id>(\d+)<\/ac:task-id>/g)].map((match) => match[1]!);
    expect(derive('link-kinds-task-text-with-labels', NO_STORAGE_DERIVATION_FEATURES)).toBe(corpusEntry('link-kinds-task-text-with-labels').storage);
    expect(ids(derive('link-kinds-task-text-with-labels', NO_STORAGE_DERIVATION_FEATURES))).toEqual(['3', '5', '4', '6']);
    expect(ids(derive('link-kinds-task-text-with-labels', LINK_KINDS))).toEqual(['5', '3', '6', '4']);
  });

  it('judges ri:url links with the feature: the stored link is kept, anything else is its text', () => {
    const entry = corpusEntry('link-kinds-carriers-with-stored-origin');
    const target = '<p>News <a href="#confluence-blog-post:Q3%20Update?ri:posting-day=2024%2F05%2F01&amp;body=plain">read the update</a>,'
      + ' old <a href="#confluence-url:%2Frelative%2Fa?body=plain">docs</a>.</p><p>New <a href="#confluence-url:%2Fother">/other</a>.</p>';
    expect(deriveVersionRestoreStorage(target, { body_storage: entry.previousStorage, body_html: entry.storedBodyHtml }, LINK_KINDS)).toBe(
      '<p>News <ac:link><ri:blog-post ri:content-title="Q3 Update" ri:posting-day="2024/05/01"></ri:blog-post>'
      + '<ac:plain-text-link-body><![CDATA[read the update]]></ac:plain-text-link-body></ac:link>,'
      + ' old <ac:link><ri:url ri:value="/relative/a"></ri:url><ac:plain-text-link-body><![CDATA[docs]]></ac:plain-text-link-body></ac:link>.</p>'
      + '<p>New /other.</p>',
    );
    // Raw link markup with no stored origin: a link whose body or display text is known leaves that text.
    const raw = '<p>Raw <ac:link><ri:url ri:value="javascript:alert(1)"></ri:url><ac:plain-text-link-body>x</ac:plain-text-link-body></ac:link>.</p>'
      + '<template><p><ac:link><ri:url ri:value="/relative/t"></ri:url></ac:link></p></template>';
    expect(deriveVersionRestoreStorage(raw, { body_storage: null, body_html: null }, LINK_KINDS))
      .toBe('<p>Raw x.</p><template><p>/relative/t</p></template>');
  });

  it('refuses, with the feature only, a body that would carry a link past the judgement', () => {
    for (const [name, reason] of [
      ['link-kinds-raw-text-link-markup', 'unapproved-link'],
      ['link-kinds-unreadable-with-link-markup', 'not-well-formed'],
      // A link with two resources and no body: what it shows is not known, so it is not taken away.
      ['link-kinds-raw-link-markup', 'unapproved-link'],
    ] as const) {
      expect(derive(name, NO_STORAGE_DERIVATION_FEATURES)).toBe(corpusEntry(name).storage);
      let refused: unknown;
      try {
        derive(name, LINK_KINDS);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(ConfluenceStorageRefusedError);
      expect((refused as ConfluenceStorageRefusedError).reason).toBe(reason);
    }
  });
});

describe.skipIf(!restoreDerivationStackAvailable)('recovery of a version restore around link-kinds (#1955)', () => {
  const harness = useRestoreDerivationHarness();

  it.each([
    'link-kinds-stored-links',
    'link-kinds-carriers-with-stored-origin',
    'link-kinds-raw-link-markup',
    'link-kinds-task-text-with-labels',
    // The feature would refuse these, and the raw link markup above. A restore reserved before it never reads them.
    'link-kinds-raw-text-link-markup',
    'link-kinds-unreadable-with-link-markup',
  ])('recovers an accepted restore of %s reserved before the feature once, with the base bytes and no PUT', async (name) => {
    const entry = corpusEntry(name);
    const seeded = await harness.seedRestore({ ...entry, reservedStorage: entry.storage });
    await expectRestoreRecoveredOnce(harness, seeded, entry.storage);
  });

  it('recovers a restore that recorded link-kinds with the judged storage, once, without another PUT', async () => {
    const entry = corpusEntry('link-kinds-carriers-with-stored-origin');
    const reservedStorage = derive(entry.name, LINK_KINDS);
    expect(reservedStorage).not.toBe(entry.storage);
    const seeded = await harness.seedRestore({ ...entry, reservedStorage, recordedFeatures: ['link-kinds'] });
    await expectRestoreRecoveredOnce(harness, seeded, reservedStorage);
  });

  it.each(['link-kinds-raw-text-link-markup', 'link-kinds-unreadable-with-link-markup', 'link-kinds-raw-link-markup'])(
    'fences a restore that recorded link-kinds when its derivation of %s is refused: no retry PUT, nothing derived another way',
    async (name) => {
      const entry = corpusEntry(name);
      // Whatever the intent reserved, the recorded derivation is refused now: the typed refusal reads as
      // a changed target. It is never recovered with the base bytes the same row derives without the feature.
      const seeded = await harness.seedRestore({ ...entry, reservedStorage: entry.storage, recordedFeatures: ['link-kinds'] });
      await expectRestoreFenced(harness, seeded, 'intent_restore_target_changed');
    },
  );
});
