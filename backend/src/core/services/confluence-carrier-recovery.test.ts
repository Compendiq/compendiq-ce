/**
 * #1953-2: the writer side of carrier recovery, without a database (design/1953.md §3.7, §3.8, §7, Z5, Z6). The
 * writers themselves are covered with real PostgreSQL in page-update, pages-draft, apply-improvement,
 * collab-persistence and pages-collab tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  carrierKindsStorageMayCarry,
  legacyCodeApplicationHolds,
  lockstepStoredBody,
  logCollabCarriersUnproven,
  logStoredCarriers,
  reconcileStoredCarriers,
  seededCarrierKinds,
  type CarrierRow,
} from './confluence-carrier-recovery.js';
import { applyHtmlToYDoc, collabSeededCarrierKinds } from './collab-schema.js';
import { LEGACY_CARRIER_FIXTURES as F } from './__fixtures__/confluence-carrier-legacy.js';
import { CARRIER_RECONCILE_MAX_UNITS } from './confluence-carrier-reconcile.js';
import { logger } from '../utils/logger.js';

const LOG = 'Confluence carriers reconciled (#1953)';
const ALL_KINDS = ['macro.code', 'macro.status', 'macro.toc', 'link', 'emoticon'];

function row(overrides: Partial<CarrierRow> = {}): CarrierRow {
  return {
    source: 'confluence',
    body_html: F.ac1.legacyHtml,
    body_storage: F.ac1.storage,
    local_modified_at: null,
    confluence_id: 'page-1',
    space_key: 'OPS',
    has_collab_doc: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lockstepStoredBody', () => {
  it('applies only to a Confluence row with storage and a stored body', () => {
    expect(lockstepStoredBody(row({ source: 'standalone' }))).toEqual({ applicable: false });
    expect(lockstepStoredBody(row({ body_storage: null }))).toEqual({ applicable: false });
    expect(lockstepStoredBody(row({ body_html: null }))).toEqual({ applicable: false });
    expect(lockstepStoredBody(row())).toEqual({ applicable: true, excluded: null });
  });

  it('names the first failing condition as the excluded reason', () => {
    expect(lockstepStoredBody(row({ local_modified_at: new Date(), has_collab_doc: true }))).toEqual({ applicable: true, excluded: 'local_modified' });
    expect(lockstepStoredBody(row({ has_collab_doc: true }))).toEqual({ applicable: true, excluded: 'collab_document' });
    expect(lockstepStoredBody(row({ body_html: `${F.ac1.legacyHtml}<div class="confluence-drawio"></div>` })))
      .toEqual({ applicable: true, excluded: 'drawio' });
  });
});

describe('reconcileStoredCarriers', () => {
  it('recovers on a lockstep row and reports the change', () => {
    const result = reconcileStoredCarriers({ row: row(), targetHtml: F.ac1.legacyHtml });
    expect(result).toMatchObject({ changed: true, applicable: true, excluded: null, report: { outcome: 'recovered' } });
    expect(result.html).not.toContain('data-cq-');
  });

  it('returns the target itself for an excluded row, with the kinds its storage may carry', () => {
    const target = F.ac1.legacyHtml;
    const result = reconcileStoredCarriers({ row: row({ has_collab_doc: true }), targetHtml: target });
    expect(result.html).toBe(target);
    expect(result).toMatchObject({ changed: false, excluded: 'collab_document', kinds: ALL_KINDS, report: { outcome: 'none' } });
  });

  it('returns the target itself for a row it does not apply to', () => {
    const target = '<p>x</p>';
    expect(reconcileStoredCarriers({ row: row({ source: 'standalone' }), targetHtml: target })).toMatchObject({
      html: target, changed: false, applicable: false, excluded: null, kinds: [],
    });
  });

  it('draws a fresh marker per call and stays deterministic in what it returns', () => {
    const first = reconcileStoredCarriers({ row: row(), targetHtml: F.ac1.legacyHtml });
    const second = reconcileStoredCarriers({ row: row(), targetHtml: F.ac1.legacyHtml });
    expect(second.html).toBe(first.html);
    expect(second.report).toEqual(first.report);
  });
});

describe('carrierKindsStorageMayCarry', () => {
  it('names nothing past the length bound and nothing for missing storage', () => {
    expect(carrierKindsStorageMayCarry(null)).toEqual([]);
    expect(carrierKindsStorageMayCarry(`<ac:emoticon ac:name="x" />${' '.repeat(CARRIER_RECONCILE_MAX_UNITS)}`)).toEqual([]);
    expect(carrierKindsStorageMayCarry('<p><ac:emoticon ac:name="x" /></p>')).toEqual(['emoticon']);
  });
});

describe('seededCarrierKinds (Z6, R7-6)', () => {
  it('names the kinds evaluated with no skipped record, and writes no key on a bound, a failure or an exclusion', () => {
    expect(seededCarrierKinds(reconcileStoredCarriers({ row: row(), targetHtml: F.ac1.legacyHtml })))
      .toEqual(['emoticon', 'link', 'macro.code', 'macro.status', 'macro.toc']);
    const skipped = reconcileStoredCarriers({
      row: row({ body_html: F.twoLookalikeLinks.legacyHtml, body_storage: F.twoLookalikeLinks.storage }),
      targetHtml: F.twoLookalikeLinks.legacyHtml,
    });
    expect(skipped.report.outcome).toBe('evaluated');
    expect(seededCarrierKinds(skipped)).toEqual(['emoticon', 'macro.code', 'macro.status', 'macro.toc']);
    const bound = reconcileStoredCarriers({
      row: row({ body_html: F.taskInTask.legacyHtml, body_storage: F.taskInTask.storage }),
      targetHtml: F.taskInTask.legacyHtml,
    });
    expect(bound.report.outcome).toBe('bound');
    expect(seededCarrierKinds(bound)).toBeNull();
    expect(seededCarrierKinds(reconcileStoredCarriers({ row: row({ local_modified_at: new Date() }), targetHtml: '' }))).toBeNull();
    expect(seededCarrierKinds(reconcileStoredCarriers({ row: row({ source: 'standalone' }), targetHtml: '' }))).toBeNull();
  });

  it('round-trips through the room key the seed writes', () => {
    const doc = new Y.Doc();
    applyHtmlToYDoc(doc, '<p>x</p>', { carrierKinds: ['macro.toc', 'emoticon'] });
    expect([...collabSeededCarrierKinds(doc)]).toEqual(['emoticon', 'macro.toc']);
    const bare = new Y.Doc();
    applyHtmlToYDoc(bare, '<p>x</p>');
    expect(collabSeededCarrierKinds(bare).size).toBe(0);
    expect(bare.getMap('compendiq.meta').has('confluenceCarriers')).toBe(false);
    doc.destroy();
    bare.destroy();
  });
});

describe('logStoredCarriers (§7: names and numbers only)', () => {
  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((call) => call[1] === LOG).map((call) => call[0]);

  it('writes counts for a reserved recovery, the outcome only for stale and refused, nothing for none', () => {
    const info = vi.spyOn(logger, 'info');
    const recovered = reconcileStoredCarriers({ row: row(), targetHtml: F.ac1.legacyHtml });
    logStoredCarriers({ pageId: 1, writer: 'put', result: recovered, final: 'reserved' });
    logStoredCarriers({ pageId: 1, writer: 'put', result: recovered, final: 'stale' });
    logStoredCarriers({ pageId: 1, writer: 'ai_apply', result: recovered, final: 'refused' });
    const none = reconcileStoredCarriers({ row: row({ body_storage: '<p>nothing</p>' }), targetHtml: '<p>x</p>' });
    logStoredCarriers({ pageId: 1, writer: 'put', result: none, final: 'reserved' });
    logStoredCarriers({ pageId: 1, writer: 'put', result: reconcileStoredCarriers({ row: row({ source: 'standalone' }), targetHtml: '' }), final: 'reserved' });
    expect(lines(info)).toEqual([
      { pageId: 1, writer: 'put', outcome: 'recovered', recovered: { emoticon: 2, 'macro.code': 1, 'macro.toc': 1, 'macro.status': 1, link: 3 }, skipped: {} },
      { pageId: 1, writer: 'put', outcome: 'stale' },
      { pageId: 1, writer: 'ai_apply', outcome: 'refused' },
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/Main|ENG|a\.pdf|tick|My Page|data-cq-|linenumbers/);
  });

  it('discloses an excluded row only when its storage may carry something', () => {
    const info = vi.spyOn(logger, 'info');
    logStoredCarriers({ pageId: 2, writer: 'draft_publish', result: reconcileStoredCarriers({ row: row({ local_modified_at: new Date() }), targetHtml: '' }), final: 'reserved' });
    logStoredCarriers({
      pageId: 3, writer: 'draft_publish',
      result: reconcileStoredCarriers({ row: row({ local_modified_at: new Date(), body_storage: '<p>plain</p>' }), targetHtml: '' }),
      final: 'reserved',
    });
    expect(lines(info)).toEqual([{ pageId: 2, writer: 'draft_publish', excluded: 'local_modified', kinds: ALL_KINDS }]);
  });
});

describe('logCollabCarriersUnproven (D9 R2)', () => {
  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((call) => call[1] === 'collab.commit_carriers_unproven').map((call) => call[0]);

  it('names the kinds the storage may carry that the room key lacks; a forged key only silences the line', () => {
    const info = vi.spyOn(logger, 'info');
    logCollabCarriersUnproven(7, F.ac1.storage, new Set());
    logCollabCarriersUnproven(8, F.ac1.storage, new Set(['emoticon', 'macro.code', 'macro.status', 'macro.toc']));
    logCollabCarriersUnproven(9, F.ac1.storage, new Set(ALL_KINDS));
    logCollabCarriersUnproven(10, '<p>plain</p>', new Set());
    expect(lines(info)).toEqual([{ pageId: 7, kinds: ALL_KINDS }, { pageId: 8, kinds: ['link'] }]);
  });
});

describe('legacyCodeApplicationHolds (§3.7 step 3)', () => {
  const before = '<pre><code class="language-java">x</code></pre><p>m</p><pre><code class="language-java">x</code></pre>';
  /** `before` with `data-title="T"` on the `index`-th of its two code blocks. */
  const titled = (index: number): string => [
    index === 0 ? '<pre data-title="T">' : '<pre>', '<code class="language-java">x</code></pre><p>m</p>',
    index === 1 ? '<pre data-title="T">' : '<pre>', '<code class="language-java">x</code></pre>',
  ].join('');

  it('accepts exactly the reported operation', () => {
    expect(legacyCodeApplicationHolds(before, titled(0), [{ ordinal: 0, title: 'T', macroParams: null }])).toBe(true);
    expect(legacyCodeApplicationHolds(before, before, [])).toBe(true);
  });

  it('refuses an operation reported for one of two equal blocks while the other one was written (wrong-ordinal swap)', () => {
    expect(legacyCodeApplicationHolds(before, titled(1), [{ ordinal: 0, title: 'T', macroParams: null }])).toBe(false);
  });

  it('refuses an out-of-range, fractional, repeated, undefined-valued or empty operation', () => {
    const after = titled(0);
    for (const ops of [
      [{ ordinal: 2, title: 'T', macroParams: null }],
      [{ ordinal: 0.5, title: 'T', macroParams: null }],
      [{ ordinal: 0, title: 'T', macroParams: null }, { ordinal: 0, title: 'T', macroParams: null }],
      [{ ordinal: 0, title: 'T', macroParams: undefined as unknown as null }],
      [{ ordinal: 0, title: null, macroParams: null }],
    ]) {
      expect(legacyCodeApplicationHolds(before, after, ops)).toBe(false);
    }
  });

  it('refuses a change to a block or a pre no operation names', () => {
    expect(legacyCodeApplicationHolds(before, titled(0), [])).toBe(false);
    expect(legacyCodeApplicationHolds(before, before.replace('>x<', '>y<'), [])).toBe(false);
    const nested = '<pre><span><code>z</code></span></pre>';
    expect(legacyCodeApplicationHolds(nested, '<pre data-title="T"><span><code>z</code></span></pre>', [])).toBe(false);
  });
});
