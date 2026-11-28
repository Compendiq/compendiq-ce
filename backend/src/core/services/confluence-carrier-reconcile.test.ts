/**
 * #1953 PR 1: the carrier recovery matcher (design/1953.md revision 7 §9.2, review r7 AA1–AA3). No database: the
 * function is pure. Legacy bodies are literal output of the v0.9.2 converter (`__fixtures__/confluence-carrier-legacy.ts`);
 * today's converter appears only as the oracle side, and the written storage is read with #1955's independent oracle.
 */
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  CARRIER_KINDS,
  reconcileConfluenceCarriers,
  type CarrierKind,
  type CarrierReport,
  type ReconcileCarrierOptions,
} from './confluence-carrier-reconcile.js';
import {
  _setForwardDerivationStepForTest,
  beginCodeMetaAccept,
  codeBlockElements,
  confluenceToHtml,
  confluenceToHtmlWithCarrierMarks,
  finalizeCodeMetadata,
  htmlToConfluence,
  htmlToMarkdown,
  markdownToHtml,
  protectMedia,
  replayProtectedMedia,
  type LexerCodeText,
} from './content-converter.js';
import { htmlToYDoc, yDocToHtml } from './collab-schema.js';
import { confluenceLinkCarrierOf, parseConfluenceLinkHref } from './confluence-link.js';
import { readConfluenceStorage } from './confluence-storage-reader.js';
import { LEGACY_CARRIER_FIXTURES as F, type LegacyCarrierFixture } from './__fixtures__/confluence-carrier-legacy.js';
import { oracleElements } from './__fixtures__/storage-oracle.js';
import { STORAGE_DERIVATION_BASE_CORPUS } from './__fixtures__/storage-derivation-base-corpus.js';
import * as XHTML from './__fixtures__/confluence-xhtml.js';
import { logger } from '../utils/logger.js';

const MARKER = 'data-cq-0123456789abcdef0123456789abcdef';

function reconcile(
  fixture: LegacyCarrierFixture,
  target: string = fixture.legacyHtml,
  options: Partial<ReconcileCarrierOptions> = {},
): { html: string; report: CarrierReport } {
  return reconcileConfluenceCarriers(fixture.legacyHtml, fixture.storage, target, { marker: MARKER, ...options });
}

/** The backend editor schema's projection: what a non-collaborative editor save sends, before TrailingNode. */
function editorProjection(html: string): string {
  return yDocToHtml(htmlToYDoc(html));
}

function writeBack(html: string, fixture: LegacyCarrierFixture): string {
  return htmlToConfluence(html, { previousStorage: fixture.storage });
}

function parameters(storage: string, macro: string): Record<string, string> {
  const found = oracleElements(storage, 'ac', 'structured-macro')
    .find((el) => el.getAttributeNS('http://atlassian.com/content', 'name') === macro);
  if (!found) return {};
  return Object.fromEntries([...found.children]
    .filter((child) => child.localName === 'parameter')
    .map((child) => [child.getAttributeNS('http://atlassian.com/content', 'name') ?? '', child.textContent ?? '']));
}

const EMOTICON = (name: string, label: string) =>
  `<span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;${name}&quot;}" data-emoticon-label="${label}" role="img" aria-label="${name}"></span>`;
const TICK = EMOTICON('tick', '✅');
const CROSS = EMOTICON('cross', '❌');

afterEach(() => {
  _setForwardDerivationStepForTest(undefined);
  vi.restoreAllMocks();
});

describe('reconcileConfluenceCarriers: general', () => {
  it('returns the carried body byte for byte for an unedited legacy body (AC1-only portion of the historical composite)', () => {
    const { html, report } = reconcile(F.ac1);
    expect(html).toBe(confluenceToHtml(F.ac1.storage));
    expect(report.outcome).toBe('recovered');
    expect(report.recovered).toEqual({ emoticon: 2, 'macro.code': 1, 'macro.toc': 1, 'macro.status': 1, link: 3 });
    expect(report.skipped).toEqual({});
  });

  it('writes back the stored storage for an API write of the unedited AC1-only body', () => {
    const storage = writeBack(reconcile(F.ac1).html, F.ac1);
    expect(storage).toBe(writeBack(confluenceToHtml(F.ac1.storage), F.ac1));
    expect(parameters(storage, 'code')).toEqual({ language: 'java', title: 'Main', linenumbers: 'true' });
    expect(parameters(storage, 'toc')).toEqual({ maxLevel: '3', exclude: 'Intro' });
    expect(parameters(storage, 'status')).toEqual({ colour: 'Green', title: 'OK', subtle: 'true' });
    expect(oracleElements(storage, 'ac', 'emoticon').map((el) => el.getAttributeNS('http://atlassian.com/content', 'name'))).toEqual(['tick', 'cross']);
  });

  it('writes back the code, toc, status and link carriers of the AC1-only fixture through the editor schema, and loses what AA2 records', () => {
    // The backend editor schema collapses the doubled space beside the paragraph emoticon and gives the table a
    // colgroup and cell paragraphs: neither emoticon is recovered (design.md §8, "AC2 is not met in full"). It also
    // drops the attribute-less text-only link: with its anchor gone from T it is not republished (review r4 ruling).
    const target = editorProjection(F.ac1.legacyHtml);
    const { html, report } = reconcile(F.ac1, target);
    expect(report.recovered).toEqual({ 'macro.code': 1, 'macro.toc': 1, 'macro.status': 1, link: 2 });
    expect(report.skipped).toEqual({ emoticon: { boundary: 1, container: 1 }, link: { no_element: 1 } });
    expect(writeBack(html, F.ac1)).toBe(
      '<p>Done now</p><table style="min-width: 50px;"><colgroup><col style="min-width: 25px;" /><col style="min-width: 25px;" /></colgroup>'
      + '<tbody><tr><td colspan="1" rowspan="1"><p></p></td><td colspan="1" rowspan="1"><p>x</p></td></tr></tbody></table>'
      + '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter>'
      + '<ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body><![CDATA[class A {}]]></ac:plain-text-body></ac:structured-macro>'
      + '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter><ac:parameter ac:name="exclude">Intro</ac:parameter></ac:structured-macro>'
      + '<p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter>'
      + '<ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro></p>'
      + '<p>See <ac:link ac:anchor="sec"><ri:page ri:content-title="My Page" ri:space-key="ENG"></ri:page><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link>.</p>'
      + '<p><ac:link><ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other"></ri:page></ri:attachment></ac:link></p>'
      + '<p>Jump to top now</p>',
    );
  });

  it('keeps the whole historical composite as an AC8 negative: its self-closing blog-post link makes the page abstain (AA2)', () => {
    for (const target of [F.composite.legacyHtml, editorProjection(F.composite.legacyHtml)]) {
      const { html, report } = reconcile(F.composite, target);
      expect(report.outcome).toBe('storage_reading_differs');
      expect(html).toBe(target);
      const storage = writeBack(html, F.composite);
      expect(parameters(storage, 'code')).toEqual({ language: 'java' });
      expect(oracleElements(storage, 'ac', 'emoticon')).toHaveLength(0);
      expect(oracleElements(storage, 'ri', 'page').some((page) => page.hasAttribute('ri:space-key'))).toBe(false);
    }
  });

  it('is the identity on a carried page', () => {
    const carried = confluenceToHtml(F.ac1.storage);
    const result = reconcileConfluenceCarriers(carried, F.ac1.storage, carried, { marker: MARKER });
    expect(result.report.outcome).toBe('none');
    expect(result.html).toBe(carried);
  });

  it('a second reconcile is the identity', () => {
    const first = reconcile(F.ac1).html;
    const second = reconcile(F.ac1, first);
    expect(second.html).toBe(first);
    expect(second.report.recovered).toEqual({});
    const afterSave = reconcileConfluenceCarriers(first, F.ac1.storage, first, { marker: MARKER });
    expect(afterSave.report.outcome).toBe('none');
    expect(afterSave.html).toBe(first);
  });

  it('returns the target unchanged without body_storage or body_html', () => {
    const target = F.emoticonRun.legacyHtml;
    for (const [stored, storage] of [[target, null], [target, ''], [null, F.emoticonRun.storage], [undefined, F.emoticonRun.storage]] as const) {
      const result = reconcileConfluenceCarriers(stored, storage, target, { marker: MARKER });
      expect(result.report.outcome).toBe('none');
      expect(result.html).toBe(target);
    }
  });

  it('is deterministic: equal arguments give equal results without a clock or random source', () => {
    const random = vi.spyOn(Math, 'random');
    const now = vi.spyOn(Date, 'now');
    const a = reconcile(F.ac1);
    const b = reconcile(F.ac1);
    expect(b).toEqual(a);
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it('a v0.10.0 body with carried page links recovers no link and leaves a legacy blog-post link as it is', () => {
    const storage = '<p>See <ac:link><ri:page ri:content-title="P" ri:space-key="S" /></ac:link> and <ac:link><ri:blog-post ri:content-title="News" ri:posting-day="2026/01/02" /></ac:link></p>';
    const stored = '<p>See <a href="#confluence-page:P?ri:space-key=S" data-confluence-link="page">P</a> and <a></a></p>';
    const result = reconcileConfluenceCarriers(stored, storage, stored, { marker: MARKER });
    expect(result.report.outcome).toBe('none');
    expect(result.html).toBe(stored);
  });

  it('recovers each kind only where the stored body is legacy for it', () => {
    const stored = F.statusToc.legacyHtml.replace('data-maxlevel="3"', 'data-maxlevel="3" data-macro-params="{&quot;exclude&quot;:&quot;Old&quot;}"');
    const result = reconcileConfluenceCarriers(stored, F.statusToc.storage, F.statusToc.legacyHtml, { marker: MARKER });
    expect(result.report.recovered).toEqual({ 'macro.status': 1 });
    expect(result.report.skipped).toEqual({});
    expect(result.html).toContain('<div class="confluence-toc" data-maxlevel="3">');
  });
});

describe('B5: never resurrect, never override', () => {
  it('gives nothing to text retyped in another block after its paragraph was deleted', () => {
    const target = '<p>Other text</p><p>Done  now</p>';
    expect(reconcile(F.emoticonRun, target)).toMatchObject({ html: target, report: { outcome: 'evaluated', skipped: { emoticon: { changed: 1 } } } });
  });

  it('gives nothing to a heading with a deleted paragraph\'s text', () => {
    const target = '<h2>Done  now</h2><p>Other text</p>';
    expect(reconcile(F.emoticonRun, target)).toMatchObject({ html: target, report: { skipped: { emoticon: { container: 1 } } } });
  });

  it('skips a block the user reformatted', () => {
    const target = '<p><strong>Done  now</strong></p><p>Other text</p>';
    expect(reconcile(F.emoticonRun, target)).toMatchObject({ html: target, report: { skipped: { emoticon: { changed: 1 } } } });
  });

  it('skips a link whose image was replaced', () => {
    const target = F.imageLink.legacyHtml.replace('i.png', 'other.png');
    expect(reconcile(F.imageLink).report.recovered).toEqual({ link: 1 });
    expect(reconcile(F.imageLink, target)).toMatchObject({ html: target, report: { skipped: { link: { changed: 1 } } } });
  });

  it('skips a block moved across an unchanged neighbour', () => {
    const [toc, paragraph] = F.statusToc.legacyHtml.split('</div>');
    const target = `${paragraph}${toc}</div>`;
    expect(reconcile(F.statusToc, target)).toMatchObject({ html: target, report: { skipped: { 'macro.status': { container: 1 }, 'macro.toc': { container: 1 } } } });
  });

  it('needs the stored body to hold the legacy shape', () => {
    const stored = '<p>Done  later</p><p>Other text</p>';
    const result = reconcileConfluenceCarriers(stored, F.emoticonRun.storage, stored, { marker: MARKER });
    expect(result).toMatchObject({ html: stored, report: { skipped: { emoticon: { changed: 1 } } } });
  });

  it('skips repeated blocks instead of counting them', () => {
    expect(reconcile(F.repeatedBlocks)).toMatchObject({ html: F.repeatedBlocks.legacyHtml, report: { skipped: { emoticon: { not_unique: 2 } } } });
  });
});

describe('C3: explicit no-overwrite guards and byte preservation', () => {
  it('leaves a code block the user titled untouched although the stored block is legacy and the code is equal', () => {
    const target = F.code.legacyHtml.replace('<pre>', '<pre data-title="Mine">');
    expect(reconcile(F.code, target)).toMatchObject({ html: target, report: { skipped: { 'macro.code': { changed: 1 } } } });
  });

  it('leaves a status whose colour changed and a toc that gained an attribute untouched', () => {
    const target = F.statusToc.legacyHtml.replace('data-color="green"', 'data-color="red"').replace('data-maxlevel="3"', 'data-maxlevel="3" data-minlevel="2"');
    expect(reconcile(F.statusToc, target)).toMatchObject({
      html: target,
      report: { skipped: { 'macro.status': { changed: 1 }, 'macro.toc': { changed: 1 } } },
    });
  });

  it('leaves a run that moved under another task id untouched', () => {
    const target = F.sourcesInContainers.legacyHtml.replace('<li data-type="taskItem"', '<li data-task-id="7" data-type="taskItem"');
    const { report } = reconcile(F.sourcesInContainers, target);
    expect(report.recovered).toEqual({ emoticon: 3 });
    expect(report.skipped).toEqual({ emoticon: { container: 1 } });
  });

  it('leaves a link that gained a title untouched', () => {
    const target = F.pageLink.legacyHtml.replace('<a ', '<a title="t" ');
    expect(reconcile(F.pageLink, target)).toMatchObject({ html: target, report: { skipped: { link: { changed: 1 } } } });
  });

  it('does not insert an emoticon where the target\'s whitespace differs from the stored whitespace, in either direction', () => {
    for (const target of ['<p>Done now</p><p>Other text</p>', '<p>Done   now</p><p>Other text</p>']) {
      expect(reconcile(F.emoticonRun, target)).toMatchObject({ html: target, report: { skipped: { emoticon: { boundary: 1 } } } });
    }
  });

  it('returns every byte outside the spliced ranges unchanged', () => {
    // Entity spelling, an unquoted attribute and a table whose tbody the parser implies stay as written.
    const target = '<p>Done  now</p><p class=x>Other &#116;ext</p><table><tr><td>t</td></tr></table>';
    expect(reconcile(F.emoticonBesideTable, target).html).toBe(
      `<p>Done ${TICK} now</p><p class=x>Other &#116;ext</p><table><tr><td>t</td></tr></table>`,
    );
  });

  it('rewrites only the start tag of a pre, a toc and a retargeted link', () => {
    const code = F.codeEntities.legacyHtml.replace('&lt;', '&#60;');
    expect(code).toContain('<pre><code class="language-js">\nif (a &#60; b &amp;&amp; c &gt; d) {}\n</code></pre>');
    expect(reconcile(F.codeEntities, code).html).toBe(code.replace('<pre>', '<pre data-title="Lf">'));

    const toc = F.statusToc.legacyHtml.replace('[Table of Contents]', 'Table of Contents is displayed in the sidebar');
    expect(reconcile(F.statusToc, toc).html).toBe(
      '<div class="confluence-toc" data-maxlevel="3" data-macro-params="{&quot;exclude&quot;:&quot;Intro&quot;}">Table of Contents is displayed in the sidebar</div>'
      + '<p>State <span class="confluence-status" data-color="green" data-macro-params="{&quot;subtle&quot;:&quot;true&quot;}">OK</span> today</p>',
    );

    const link = '<p>See <a target="_blank" rel="noopener noreferrer nofollow" href="#confluence-page:My Page">the&#32;page</a>.</p>';
    expect(reconcile(F.pageLink, link).html).toBe(
      '<p>See <a target="_blank" rel="noopener noreferrer nofollow" href="#confluence-page:My%20Page?ac:anchor=sec&amp;ri:space-key=ENG" data-confluence-link="page">the&#32;page</a>.</p>',
    );
  });

  it('never re-serializes a pre, list or table next to a changed run', () => {
    const target = F.listUnits.legacyHtml.replace('<li>second</li>', '<li>sec&#111;nd</li>');
    expect(reconcile(F.listUnits, target).html).toBe(`<ul><li>first ${TICK} 1</li><li>sec&#111;nd</li><li>third ${CROSS} 3</li></ul>`);
  });

  it('skips an operation whose range is missing', () => {
    // The parser closes the strong: the run's last node has no source end tag.
    const target = '<p><strong>Done  now</p><p>tail</p>';
    expect(reconcile(F.emoticonInBold, target)).toMatchObject({ html: target, report: { outcome: 'evaluated', skipped: { emoticon: { unlocatable: 1 } } } });
  });

  it('vetoes a target element that already carries a value even when the keys are equal', () => {
    const status = CARRIER_KINDS.find((kind) => kind.id === 'macro.status')!;
    const registry: CarrierKind[] = CARRIER_KINDS.map((kind) => (kind === status ? { ...status, targetHoldsCarrier: () => true } : kind));
    expect(reconcile(F.statusToc, F.statusToc.legacyHtml, { registry }).report).toMatchObject({
      recovered: { 'macro.toc': 1 },
      skipped: { 'macro.status': { carried: 1 } },
    });
  });
});

describe('B6: values only from a marked, closed projection', () => {
  it('copies nothing from a raw emoticon-shaped span beside a real emoticon', () => {
    expect(reconcile(F.rawEmoticonSpan)).toMatchObject({ html: F.rawEmoticonSpan.legacyHtml, report: { outcome: 'none' } });
  });

  it('ignores a raw pre[data-title] and a raw carrier-shaped anchor in storage', () => {
    expect(reconcile(F.rawCarrierMarkup)).toMatchObject({ html: F.rawCarrierMarkup.legacyHtml, report: { outcome: 'none' } });
  });

  it('treats a source index the passes repeated as unsupported', () => {
    // A nested column is a fresh clone after its outer column's pass and takes a second pass. A step that clones
    // marked markup in that pass (as a pass that re-serializes a body can) repeats a source index.
    let pass = 0;
    _setForwardDerivationStepForTest((doc) => {
      pass += 1;
      if (pass !== 2) return;
      const marked = doc.querySelector(`[${MARKER}]`)!;
      marked.after(marked.cloneNode(true));
    });
    const { report } = reconcile(F.nestedColumns);
    expect(report.recovered).toEqual({ emoticon: 1 });
    expect(report.skipped).toEqual({ emoticon: { unsupported: 2 } });
  });

  it('refuses a marked link whose href and class disagree', () => {
    const link = CARRIER_KINDS.find((kind) => kind.id === 'link')!;
    const doc = new JSDOM('<a href="#confluence-page:P?ri:space-key=S" class="other">P</a>').window.document;
    expect(link.record(doc.querySelector('a')!, { k: 'link', n: 0, h: '#confluence-page:P', x: 'P', b: 'none' })).toBe('unsupported');
  });

  it('treats a parameter object with a non-string value, more than 64 entries or more than 16,384 units as unsupported', () => {
    const status = CARRIER_KINDS.find((kind) => kind.id === 'macro.status')!;
    const span = (params: string) => {
      const el = new JSDOM('<span class="confluence-status"></span>').window.document.querySelector('span')!;
      el.setAttribute('data-macro-params', params);
      return el;
    };
    expect(status.record(span('{"a":1}'), { k: 'macro.status', n: 0 })).toBe('unsupported');
    expect(status.record(span('["a"]'), { k: 'macro.status', n: 0 })).toBe('unsupported');
    expect(status.record(span('{"a":"b"}'), { k: 'macro.status', n: 0 })).toEqual({ kind: 'macro.status', attributes: [['data-macro-params', '{"a":"b"}']], label: null });
    expect(reconcile(F.codeManyParams).report.skipped).toEqual({ 'macro.code': { unsupported: 1 } });
    expect(reconcile(F.codeLongParams).report.skipped).toEqual({ 'macro.code': { unsupported: 1 } });
  });
});

describe('Y5 / Z1: sources are elements both readings agree on, over the whole body', () => {
  it('recovers from a genuinely bound macro, emoticon and link (control)', () => {
    const storage = writeBack(reconcile(F.ac1).html, F.ac1);
    expect(parameters(storage, 'code').title).toBe('Main');
    expect(oracleElements(storage, 'ri', 'page')[0]!.getAttribute('ri:space-key')).toBe('ENG');
  });

  it('recovers nothing on a page that rebinds the ac prefix, and nothing on one that redeclares it identically', () => {
    for (const fixture of [F.reboundPrefix, F.redeclaredPrefix]) {
      expect(reconcile(fixture)).toMatchObject({ html: fixture.legacyHtml, report: { outcome: 'storage_reading_differs' } });
    }
  });

  it('copies nothing from a macro named only by data-macro-name and still recovers its genuine sibling', () => {
    const { html, report } = reconcile(F.presentationNameBesideGenuine);
    expect(report.recovered).toEqual({ 'macro.code': 1 });
    expect(html).toBe('<pre data-title="G"><code class="language-java">x</code></pre><pre><code>y</code></pre>');
  });

  it('copies nothing from an upper-case, aliased or legacy ac:macro element', () => {
    expect(reconcile(F.upperCaseMacro)).toMatchObject({ html: F.upperCaseMacro.legacyHtml, report: { recovered: {} } });
    // An aliased prefix is not `ac:`: no source can exist, so the element-name gate answers before any reading.
    expect(reconcile(F.aliasedMacro)).toMatchObject({ html: F.aliasedMacro.legacyHtml, report: { outcome: 'none', recovered: {} } });
    expect(reconcile(F.legacyMacroElement)).toMatchObject({ html: F.legacyMacroElement.legacyHtml, report: { recovered: {} } });
  });

  it('recovers nothing when a comment, a processing instruction or a raw-text element shows a start tag to one reader only', () => {
    for (const fixture of [F.commentHidesEmoticon, F.piHidesEmoticon, F.textareaHidesEmoticon, F.oneHiddenFromEach]) {
      expect(reconcile(fixture)).toMatchObject({ html: fixture.legacyHtml, report: { outcome: 'storage_reading_differs', recovered: {}, skipped: {} } });
    }
  });

  it('returns storage_unreadable for storage the reader refuses', () => {
    expect(reconcile(F.notWellFormed)).toMatchObject({ html: F.notWellFormed.legacyHtml, report: { outcome: 'storage_unreadable' } });
  });

  it('a marker spelled in storage text never makes a record and never reaches the result', () => {
    const result = reconcile(F.markerSpelled);
    expect(result).toMatchObject({ html: F.markerSpelled.legacyHtml, report: { outcome: 'bound' } });
  });

  // One test per storage (CI time limit): the same comparison as one loop over the corpus. Each case records
  // whether it compared; the count test reads those records and computes any a filtered run skipped.
  const MARKED_STORAGES: ReadonlyArray<readonly [string, string]> = [
    ...STORAGE_DERIVATION_BASE_CORPUS.flatMap((entry) => [
      [`base ${entry.name} storage`, entry.storage] as const,
      [`base ${entry.name} previousStorage`, entry.previousStorage ?? ''] as const,
    ]),
    ...Object.entries(XHTML).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, value]) => [`xhtml ${name}`, value] as const),
    ...Object.entries(F).map(([name, fixture]) => [`fixture ${name}`, fixture.storage] as const),
  ].filter(([, storage]) => storage !== '');
  const markedCompared = new Map<number, boolean>();
  /** Compares the marked conversion of one storage with confluenceToHtml; false when either does not apply. */
  function compareMarked(index: number): boolean {
    const known = markedCompared.get(index);
    if (known !== undefined) return known;
    const storage = MARKED_STORAGES[index]![1];
    const compared = ((): boolean => {
      const read = readConfluenceStorage(storage);
      if (!read.ok) return false;
      let ordinary: string;
      try {
        ordinary = confluenceToHtml(storage);
      } catch {
        return false;
      }
      const marked = confluenceToHtmlWithCarrierMarks(storage, undefined, undefined, {
        tree: read.tree,
        marker: MARKER,
        limits: { marks: 10_000, passes: 34, html: 4_194_304, work: 4 * storage.length + 1_000 },
      });
      if (!marked.ok) return false;
      expect(marked.html.replace(new RegExp(` ${MARKER}="[^"]*"`, 'g'), '')).toBe(ordinary);
      return true;
    })();
    markedCompared.set(index, compared);
    return compared;
  }

  it.each(MARKED_STORAGES.map(([name], index) => [name, index] as const))(
    'the marked conversion differs from confluenceToHtml only by its marks: %s',
    (_name, index) => {
      compareMarked(index);
    },
  );

  it('the marked conversion is compared with confluenceToHtml on more than 80 storages of the corpus', () => {
    expect(MARKED_STORAGES.filter((_, index) => compareMarked(index)).length).toBeGreaterThan(80);
  });

  it('recovers nothing on a page whose self-closing title parameter swallowed the code body in the HTML reading', () => {
    const { html, report } = reconcile(F.z1SelfClosingTitle);
    expect(report.outcome).toBe('storage_reading_differs');
    expect(html).toBe(F.z1SelfClosingTitle.legacyHtml);
    expect(html).not.toContain('data-title');
    expect(writeBack(html, F.z1SelfClosingTitle)).not.toContain('ac:name="title"');
  });

  it('recovers the language-only code block when the same parameter is closed explicitly', () => {
    const { html, report } = reconcile(F.z1ClosedTitle);
    expect(report.recovered).toEqual({ 'macro.code': 1 });
    expect(html).not.toContain('data-title');
    // No invented title: the XML reading has an empty title, and that is what is written back.
    expect(oracleElements(F.z1ClosedTitle.storage, 'ac', 'parameter').find((p) => p.getAttribute('ac:name') === 'title')!.textContent).toBe('');
    expect(parameters(writeBack(html, F.z1ClosedTitle), 'code')).toEqual({ language: 'js', title: '' });
  });

  it('recovers nothing on a page that holds a self-closing toc, a self-closing paragraph, or a link to a blog post, a space or an https ri:url with a body', () => {
    const cases: Array<[LegacyCarrierFixture, LegacyCarrierFixture]> = [
      [F.selfClosingToc, F.selfClosingTocControl],
      [F.selfClosingParagraph, F.selfClosingParagraphControl],
      [F.blogLinkBody, F.resourceLinkControl],
      [F.spaceLinkBody, F.resourceLinkControl],
      [F.urlLinkBody, F.resourceLinkControl],
    ];
    for (const [page, control] of cases) {
      expect(reconcile(page)).toMatchObject({ html: page.legacyHtml, report: { outcome: 'storage_reading_differs' } });
      expect(reconcile(control).report.outcome).toBe('recovered');
    }
  });

  it('compares end events and text ownership, not only starts', () => {
    // The emoticon's tag holds `/` in a value: the HTML reading leaves it open over the following text.
    expect(reconcile(F.endEventDiffers)).toMatchObject({ html: F.endEventDiffers.legacyHtml, report: { outcome: 'storage_reading_differs' } });
  });

  it('gives no record when an earlier step changed the source subtree before its builder (AA3: the rejection is counted)', () => {
    // The code builder converts the link body's code macro before the link builder reads the link.
    const { report } = reconcile(F.linkCodeBody);
    expect(report.outcome).toBe('recovered');
    expect(report.recovered).toEqual({ 'macro.code': 1 });
    expect(report.skipped).toEqual({ link: { unsupported: 1 }, 'macro.code': { container: 1 } });
  });

  it('keeps a source inside a task body, a panel, an expand and a layout cell', () => {
    const { html, report } = reconcile(F.sourcesInContainers);
    expect(report.recovered).toEqual({ emoticon: 4 });
    expect(html).toContain(`<p>panel ${TICK} body</p>`);
    expect(html).toContain(`<p>expand ${CROSS} body</p>`);
    expect(html).toContain(`<p>layout ${EMOTICON('smile', '🙂')} cell</p>`);
    expect(html).toContain(`>task ${EMOTICON('wink', '😉')} body</li>`);
  });
});

describe('Z3: stamps never reach a value', () => {
  it('writes a genuine emoticon\'s exact attribute map and no stamp', () => {
    const { html } = reconcile(F.emoticonRun);
    const span = new JSDOM(html).window.document.querySelector('span')!;
    const today = new JSDOM(confluenceToHtml(F.emoticonRun.storage)).window.document.querySelector('span')!;
    expect(span.getAttribute('data-emoticon-attrs')).toBe(today.getAttribute('data-emoticon-attrs'));
    const written = oracleElements(writeBack(html, F.emoticonRun), 'ac', 'emoticon');
    expect(written.map((el) => [...el.attributes].map((attr) => [attr.name, attr.value]))).toEqual([[['ac:name', 'tick']]]);
  });

  it('no data-cq- substring reaches the result or the storage written back', () => {
    for (const fixture of [F.ac1, F.linkDroppedAttribute, F.statusToc, F.code, F.emoticonsInOneGap]) {
      const { html, report } = reconcile(fixture);
      expect(report.outcome).toBe('recovered');
      expect(html).not.toContain('data-cq-');
      expect(writeBack(html, fixture)).not.toContain('data-cq-');
    }
  });

  it('counts the dropped link attributes without the stamp and logs nothing', () => {
    const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) => vi.spyOn(logger, level));
    const { report } = reconcile(F.linkDroppedAttribute);
    expect(report.recovered).toEqual({ link: 1 });
    expect(report.droppedLinkAttributes).toBe(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('returns failed for a malformed marker name', () => {
    for (const marker of ['data-cq-short', `data-x-${'0'.repeat(32)}`, `data-cq-${'A'.repeat(32)}`]) {
      expect(reconcile(F.emoticonRun, F.emoticonRun.legacyHtml, { marker })).toMatchObject({ html: F.emoticonRun.legacyHtml, report: { outcome: 'failed' } });
    }
  });
});

describe('Y4 / Z2: positional identity under unchanged child sequences', () => {
  it('gives nothing to a paragraph that moved from one list item to the next although its key is unique', () => {
    const target = '<ul><li><p>A  a</p></li><li><p>X  x</p><p>B  b</p></li></ul><p>P  p</p>';
    const { html, report } = reconcile(F.listItems, target);
    expect(report.recovered).toEqual({ emoticon: 1 });
    expect(report.skipped).toEqual({ emoticon: { container: 3 } });
    expect(html).toBe(`<ul><li><p>A  a</p></li><li><p>X  x</p><p>B  b</p></li></ul><p>P ${EMOTICON('wink', '😉')} p</p>`);
  });

  it('gives nothing to a paragraph that changed place among empty siblings, at body level, in a list item and in a cell', () => {
    const swap = (html: string) => html.replace('<p>X  x</p><p></p>', '<p></p><p>X  x</p>');
    for (const fixture of [F.emptySiblingsBody, F.emptySiblingsItem, F.emptySiblingsCell]) {
      const target = swap(fixture.legacyHtml);
      expect(target).not.toBe(fixture.legacyHtml);
      const { html, report } = reconcile(fixture, target);
      expect(report.recovered).toEqual({ emoticon: 2 });
      expect(report.skipped).toEqual({ emoticon: { container: 1 } });
      expect(html).toContain(`<p>A ${TICK} a</p><p></p><p>X  x</p><p>B ${EMOTICON('smile', '🙂')} b</p>`);
    }
  });

  it('gives nothing to a run that moved to the sibling cell', () => {
    const target = F.cells.legacyHtml.replace('<td>one  1</td><td>two</td>', '<td>two</td><td>one  1</td>');
    const { report } = reconcile(F.cells, target);
    expect(report.recovered).toEqual({ emoticon: 2 });
    expect(report.skipped).toEqual({ emoticon: { changed: 1 } });
  });

  it('recovers nothing in a cell whose table changed its grid, or in a relocated cell, and still recovers in the parent', () => {
    const grown = F.cells.legacyHtml.replace('</tbody>', '<tr><td>five</td><td>six</td></tr></tbody>');
    const moved = F.cells.legacyHtml.replace('<td>two</td>', '').replace('<td>three</td>', '<td>three</td><td>two</td>');
    for (const target of [grown, moved]) {
      const { report } = reconcile(F.cells, target);
      expect(report.recovered).toEqual({ emoticon: 1 });
      expect(report.skipped).toEqual({ emoticon: { container: 2 } });
    }
  });

  it('recovers nothing inside a container that gained or lost an empty paragraph, and still recovers in its unchanged parent', () => {
    const gained = F.listItems.legacyHtml.replace('<p>X  x</p>', '<p>X  x</p><p></p>');
    const { report } = reconcile(F.listItems, gained);
    expect(report.recovered).toEqual({ emoticon: 2 });
    expect(report.skipped).toEqual({ emoticon: { container: 2 } });
    const lost = F.emptySiblingsItem.legacyHtml.replace('<p></p>', '');
    expect(reconcile(F.emptySiblingsItem, lost).report.skipped).toEqual({ emoticon: { container: 3 } });
  });

  it('recovers nothing inside a table that gained a row or a list that gained an item', () => {
    const list = F.listUnits.legacyHtml.replace('</ul>', '<li>fourth</li></ul>');
    expect(reconcile(F.listUnits, list)).toMatchObject({ html: list, report: { skipped: { emoticon: { container: 2 } } } });
  });

  it('recovers in the unchanged items of a list after another item\'s text was edited', () => {
    const target = F.listUnits.legacyHtml.replace('second', 'second, edited');
    expect(reconcile(F.listUnits, target).report.recovered).toEqual({ emoticon: 2 });
  });

  it('skips a run whose parent is a div, a blockquote or the body', () => {
    expect(reconcile(F.unsupportedParents).report.skipped).toEqual({ emoticon: { container: 2 } });
    expect(reconcile(F.bodyText).report.skipped).toEqual({ emoticon: { container: 1 } });
  });

  it('leaves a href-less anchor that gained a title or a class untouched, and never sets a class where one is present', () => {
    for (const target of [
      '<p>Jump <a title="t">to top</a> now</p>',
      '<p>Jump <a class="c">to top</a> now</p>',
    ]) {
      expect(reconcile(F.anchorLink, target)).toMatchObject({ html: target, report: { skipped: { link: { changed: 1 } } } });
    }
    const classed = F.pageLink.legacyHtml.replace('<a ', '<a class="c" ');
    expect(reconcile(F.pageLink, classed)).toMatchObject({ html: classed, report: { skipped: { link: { changed: 1 } } } });
  });

  it('does not republish a text-only link whose anchor the editor dropped (review r4 ruling)', () => {
    const target = '<p>Jump to top now</p>';
    expect(reconcile(F.anchorLink, target)).toMatchObject({ html: target, report: { outcome: 'evaluated', skipped: { link: { no_element: 1 } } } });
  });

  it('does not insert an emoticon when whitespace changed elsewhere in its run', () => {
    const target = '<p>Done  now </p><p>Other text</p>';
    expect(reconcile(F.emoticonRun, target)).toMatchObject({ html: target, report: { skipped: { emoticon: { boundary: 1 } } } });
  });

  it('does not insert an emoticon when the projected run and the stored run differ only in whitespace', () => {
    const stored = '<p>Done   now</p><p>Other text</p>';
    const result = reconcileConfluenceCarriers(stored, F.emoticonRun.storage, stored, { marker: MARKER });
    expect(result).toMatchObject({ html: stored, report: { skipped: { emoticon: { boundary: 1 } } } });
  });

  it('controls: an unchanged list, table and layout recover everything', () => {
    expect(reconcile(F.listUnits).report).toMatchObject({ recovered: { emoticon: 2 }, skipped: {} });
    expect(reconcile(F.cells).report).toMatchObject({ recovered: { emoticon: 3 }, skipped: {} });
    expect(reconcile(F.sourcesInContainers).report).toMatchObject({ recovered: { emoticon: 4 }, skipped: {} });
  });
});

describe('AA1 / Q-R7-1: only the editor\'s one trailing paragraph after a body that ends in another block', () => {
  it('a non-collaborative save of a page ending in a table recovers before the table; the normalized table\'s carrier is skipped', () => {
    // The real backend schema projects the table (colgroup, cell paragraphs); StarterKit's TrailingNode appends
    // one empty paragraph after a body that ends in a table.
    const target = `${editorProjection(F.tableEnding.legacyHtml)}<p></p>`;
    expect(target).toContain('<colgroup>');
    const { html, report } = reconcile(F.tableEnding, target);
    expect(report.recovered).toEqual({ 'macro.status': 1 });
    expect(report.skipped).toEqual({ emoticon: { container: 1 } });
    expect(html).toBe(target.replace('data-color="green">', 'data-color="green" data-macro-params="{&quot;subtle&quot;:&quot;true&quot;}">'));
    expect(oracleElements(writeBack(html, F.tableEnding), 'ac', 'emoticon')).toHaveLength(0);
  });

  it('recovers the cell too when the grid itself is unchanged and only the trailing paragraph was added', () => {
    const { html, report } = reconcile(F.tableEnding, `${F.tableEnding.legacyHtml}<p></p>`);
    expect(report.recovered).toEqual({ 'macro.status': 1, emoticon: 1 });
    expect(html.endsWith(`<td>${CROSS}</td><td>x</td></tr></tbody></table><p></p>`)).toBe(true);
  });

  it('[A, B, empty] → [A, empty, B, empty]: an internal empty paragraph stops recovery although the labels would allow it', () => {
    const target = '<p>A  a</p><p></p><p>B b</p><p></p>';
    expect(reconcile(F.aa1TrailingEmpty, target)).toMatchObject({ html: target, report: { outcome: 'evaluated', skipped: { emoticon: { container: 1 } } } });
    const appended = `${F.aa1TrailingEmpty.legacyHtml}<p></p>`;
    expect(reconcile(F.aa1TrailingEmpty, appended)).toMatchObject({ html: appended, report: { skipped: { emoticon: { container: 1 } } } });
    expect(reconcile(F.aa1TrailingEmpty).report.recovered).toEqual({ emoticon: 1 });
  });

  it('an empty paragraph added anywhere else in the body stops recovery in the body', () => {
    const before = F.tableEnding.legacyHtml.replace('<table>', '<p></p><table>');
    expect(reconcile(F.tableEnding, before).report.skipped).toEqual({ 'macro.status': { container: 1 }, emoticon: { container: 1 } });
    const leading = `<p></p>${F.tableEnding.legacyHtml}`;
    expect(reconcile(F.tableEnding, leading).report.recovered).toEqual({});
  });

  it('two trailing empty paragraphs stop recovery in the body', () => {
    expect(reconcile(F.tableEnding, `${F.tableEnding.legacyHtml}<p></p><p></p>`).report.recovered).toEqual({});
  });

  it('a trailing empty paragraph added inside a list item or a cell stops recovery there', () => {
    const item = F.listUnits.legacyHtml.replace('first  1</li>', 'first  1<p></p></li>');
    expect(reconcile(F.listUnits, item).report).toMatchObject({ recovered: { emoticon: 1 }, skipped: { emoticon: { container: 1 } } });
    const cell = F.cells.legacyHtml.replace('one  1</td>', 'one  1<p></p></td>');
    expect(reconcile(F.cells, cell).report).toMatchObject({ recovered: { emoticon: 2 }, skipped: { emoticon: { container: 1 } } });
  });
});

describe('macros', () => {
  it('attaches title and parameters to an unedited code block', () => {
    const { html, report } = reconcile(F.code);
    expect(html).toBe('<p>Intro</p><pre data-title="Main" data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;}"><code class="language-java">class A {}</code></pre>');
    expect(report.codeOps).toEqual([{ ordinal: 0, title: 'Main', macroParams: '{"linenumbers":"true"}' }]);
  });

  it('skips a block whose code or language changed', () => {
    for (const target of [F.code.legacyHtml.replace('class A {}', 'class B {}'), F.code.legacyHtml.replace('language-java', 'language-kotlin')]) {
      expect(reconcile(F.code, target)).toMatchObject({ html: target, report: { skipped: { 'macro.code': { changed: 1 } }, codeOps: [] } });
    }
  });

  it('skips identical blocks', () => {
    expect(reconcile(F.codeTwins).report.skipped).toEqual({ 'macro.code': { not_unique: 2 } });
  });

  it('skips a language the legacy converter wrote differently', () => {
    expect(reconcile(F.codeLanguageSpace).report.skipped).toEqual({ 'macro.code': { unsupported: 1 } });
  });

  it('attaches parameters to an unedited status and toc', () => {
    expect(reconcile(F.statusToc).html).toBe(
      '<div class="confluence-toc" data-maxlevel="3" data-macro-params="{&quot;exclude&quot;:&quot;Intro&quot;}">[Table of Contents]</div>'
      + '<p>State <span class="confluence-status" data-color="green" data-macro-params="{&quot;subtle&quot;:&quot;true&quot;}">OK</span> today</p>',
    );
  });

  it('treats an oversize title as unsupported', () => {
    expect(reconcile(F.codeLongTitle).report.skipped).toEqual({ 'macro.code': { unsupported: 1 } });
  });

  it('enumerates code units with codeBlockElements and gives a key only in the single pre > code shape', () => {
    // A pre whose code is not a direct child is no unit and shifts no ordinal.
    expect(reconcile(F.codeAfterNestedPre).report.codeOps).toEqual([{ ordinal: 0, title: 'Main', macroParams: null }]);
    const wrapped = F.code.legacyHtml.replace('</code></pre>', '</code> </pre>');
    expect(reconcile(F.code, wrapped)).toMatchObject({ html: wrapped, report: { skipped: { 'macro.code': { unsupported: 1 } } } });
  });

  it('reports one LegacyCodeMetadataOp per applied code operation: integer ordinal in range, no ordinal twice, values string or null', () => {
    const { html, report } = reconcile(F.twoCodes);
    expect(report.codeOps).toEqual([
      { ordinal: 0, title: 'Main', macroParams: null },
      { ordinal: 1, title: 'Other', macroParams: null },
    ]);
    const blocks = codeBlockElements(new JSDOM(html).window.document.body);
    expect(blocks.map((pre) => pre.getAttribute('data-title'))).toEqual(['Main', 'Other']);
  });

  it('reports nothing recovered and no code operation when the splice fails', () => {
    const code = CARRIER_KINDS.find((kind) => kind.id === 'macro.code')!;
    const broken: CarrierKind = {
      ...code,
      record: (marked, payload) => {
        const record = code.record(marked, payload);
        return record && record !== 'unsupported' ? { ...record, attributes: [...record.attributes, ['not a name', 'x']] } : record;
      },
    };
    const registry = CARRIER_KINDS.map((kind) => (kind === code ? broken : kind));
    expect(reconcile(F.code, F.code.legacyHtml, { registry })).toMatchObject({
      html: F.code.legacyHtml,
      report: { outcome: 'failed', recovered: {}, skipped: {}, codeOps: [] },
    });
  });

  it('takes carried values from the marked projection only', () => {
    const otherStored = F.statusToc.legacyHtml.replace('data-color="green">', 'data-color="green" title="x">');
    const target = F.statusToc.legacyHtml.replace('data-color="green">', 'data-color="green" data-macro-params="{&quot;subtle&quot;:&quot;false&quot;}">');
    const result = reconcileConfluenceCarriers(otherStored, F.statusToc.storage, target, { marker: MARKER });
    expect(result.html).not.toContain('{&quot;subtle&quot;:&quot;true&quot;}');
    expect(result.report.skipped['macro.status']).toEqual({ changed: 1 });
  });

  // One test per fixture (CI time limit): the same assertions as one loop over the corpus.
  it.each(Object.entries(F))('preserves the count, order, position, class, text and structure of every pre: %s', (_name, fixture) => {
    const otherAttributes = (pre: Element) => [...pre.attributes]
      .filter((attr) => attr.name !== 'data-title' && attr.name !== 'data-macro-params')
      .map((attr) => [attr.name, attr.value]);
    const before = codeBlockElements(new JSDOM(fixture.legacyHtml).window.document.body);
    const after = codeBlockElements(new JSDOM(reconcile(fixture).html).window.document.body);
    expect(after.map((pre) => pre.innerHTML)).toEqual(before.map((pre) => pre.innerHTML));
    expect(after.map(otherAttributes)).toEqual(before.map(otherAttributes));
  });
});

describe('macros with #1958 witnesses (Improve)', () => {
  async function improve(fixture: LegacyCarrierFixture): Promise<{ html: string; witnesses: ReadonlyArray<LexerCodeText | null> }> {
    const body = protectMedia(fixture.legacyHtml);
    const accept = beginCodeMetaAccept(body, { witnesses: true });
    const markdown = htmlToMarkdown(body.html);
    const html = replayProtectedMedia(await markdownToHtml(markdown, { protectedMedia: body.media, codeMeta: accept }), accept).html;
    const finalized = finalizeCodeMetadata(html, accept);
    return { html: finalized.html, witnesses: finalized.witnesses };
  }

  it('pairs a legacy block with the fence whose witness is its projected text', async () => {
    const { html, witnesses } = await improve(F.code);
    expect(witnesses).toEqual(['class A {}']);
    const result = reconcile(F.code, html, { codeWitnesses: witnesses });
    expect(result.report.codeOps).toEqual([{ ordinal: 0, title: 'Main', macroParams: '{"linenumbers":"true"}' }]);
    expect(result.html).toBe(html.replace('<pre>', '<pre data-title="Main" data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;}">'));
  });

  it('does not pair a block without a witness, a witness that differs by one LF, or a witness list of another length', async () => {
    const { html } = await improve(F.code);
    const cases: Array<[ReadonlyArray<LexerCodeText | null>, string]> = [
      [[null], 'no_witness'],
      [['class A {}\n' as LexerCodeText], 'changed'],
      [['class A {}' as LexerCodeText, null], 'no_witness'],
    ];
    for (const [codeWitnesses, reason] of cases) {
      expect(reconcile(F.code, html, { codeWitnesses })).toMatchObject({ html, report: { skipped: { 'macro.code': { [reason]: 1 } }, codeOps: [] } });
    }
  });

  it('treats an undefined or non-string witness as no witness', async () => {
    const { html } = await improve(F.code);
    for (const codeWitnesses of [[undefined], [42]] as unknown as Array<ReadonlyArray<LexerCodeText | null>>) {
      expect(reconcile(F.code, html, { codeWitnesses }).report.skipped).toEqual({ 'macro.code': { no_witness: 1 } });
    }
  });

  it('compares no code text raw when witnesses are passed, also when the list is empty', () => {
    expect(reconcile(F.code, F.code.legacyHtml, { codeWitnesses: [] }).report.skipped).toEqual({ 'macro.code': { no_witness: 1 } });
  });

  it('recovers nothing for a block that has a twin in the target', () => {
    const target = '<p>Intro</p><pre><code class="language-java">class A {}\n</code></pre><blockquote><pre><code class="language-java">class A {}\n</code></pre></blockquote>';
    const result = reconcile(F.codeBesideRawPre, target, { codeWitnesses: ['class A {}' as LexerCodeText, null] });
    expect(result).toMatchObject({ html: target, report: { skipped: { 'macro.code': { ambiguous: 1 } }, codeOps: [] } });
  });
});

describe('links', () => {
  it('recovers space key and anchor of a legacy page link', () => {
    const { html } = reconcile(F.pageLink);
    expect(html).toBe('<p>See <a href="#confluence-page:My%20Page?ac:anchor=sec&amp;ri:space-key=ENG" data-confluence-link="page">the page</a>.</p>');
  });

  it('recovers space key and anchor of an href Improve re-encoded', () => {
    expect(reconcile(F.pageLink, '<p>See <a href="#confluence-page:My%20Page">the page</a>.</p>').html)
      .toBe('<p>See <a href="#confluence-page:My%20Page?ac:anchor=sec&amp;ri:space-key=ENG" data-confluence-link="page">the page</a>.</p>');
  });

  it('M4: restores the filename label and the container of a body-less page-owned attachment', () => {
    const { html } = reconcile(F.attachmentOwned);
    expect(html).toBe('<p>File <a href="#confluence-attachment:a.pdf?page.ri:content-title=Other" data-confluence-link="attachment">a.pdf</a> here</p>');
    const [link] = oracleElements(writeBack(html, F.attachmentOwned), 'ac', 'link');
    expect(link!.outerHTML).toBe(oracleElements(F.attachmentOwned.storage, 'ac', 'link')[0]!.outerHTML);
  });

  it('keeps an authored body equal to the container title, and an authored different body', () => {
    expect(reconcile(F.attachmentOwnedBodyTitle).html).toContain('data-confluence-link="attachment">Other</a>');
    expect(reconcile(F.attachmentOwnedBodyOther).html).toContain('data-confluence-link="attachment">the file</a>');
  });

  it('skips an edited label', () => {
    const target = F.attachmentOwned.legacyHtml.replace('>Other<', '>Others<');
    expect(reconcile(F.attachmentOwned, target)).toMatchObject({ html: target, report: { skipped: { link: { changed: 1 } } } });
  });

  it('skips two identical-looking links with different targets', () => {
    expect(reconcile(F.twoLookalikeLinks)).toMatchObject({ html: F.twoLookalikeLinks.legacyHtml, report: { skipped: { link: { ambiguous: 2 } } } });
  });

  it('sets the target on a href-less <a> the stored body and the target both hold', () => {
    expect(reconcile(F.anchorLink).html).toBe('<p>Jump <a href="#confluence-anchor:top" data-confluence-link="anchor">to top</a> now</p>');
  });

  it('does not wrap text the user linked', () => {
    const target = '<p>Jump <a href="https://example.com">to top</a> now</p>';
    expect(reconcile(F.anchorLink, target)).toMatchObject({ html: target, report: { skipped: { link: { changed: 1 } } } });
  });

  it('gives a body-less text-only link back only where its empty <a> survived', () => {
    expect(reconcile(F.anchorBodylessEnd).html).toBe('<p>Jump <a href="#confluence-anchor:top" data-confluence-link="anchor">top</a></p>');
    expect(reconcile(F.anchorBodylessEnd, '<p>Jump </p>').report.skipped).toEqual({ link: { no_element: 1 } });
    // The converter of v0.9.2 let the self-closing link swallow the text after it: that page differs and abstains.
    expect(reconcile(F.anchorBodyless).report.skipped).toEqual({ link: { changed: 1 } });
  });

  it('recovers no link of a #1955 kind (R7-3)', () => {
    const { html, report } = reconcile(F.blogLinkBodyless);
    expect(report.recovered).toEqual({ emoticon: 1 });
    expect(report.skipped).toEqual({});
    expect(html.startsWith('<p>a <a></a> b</p>')).toBe(true);
  });

  it('a recovered page link is written back as the stored resource; a copy of it in the target is not', () => {
    // The copy goes elsewhere and shows another label: a copy to the same destination or with the same label makes
    // the link abstain (review r3/r4 rulings).
    const copy = '<a href="#confluence-page:Elsewhere" data-confluence-link="page">a copy</a>';
    const target = F.pageLinkWithNeighbour.legacyHtml.replace('<p>Other text</p>', `<p>Other text ${copy}</p>`);
    const { html, report } = reconcile(F.pageLinkWithNeighbour, target);
    expect(report.recovered).toEqual({ link: 1 });
    const pages = oracleElements(writeBack(html, F.pageLinkWithNeighbour), 'ri', 'page');
    expect(pages.map((page) => page.getAttribute('ri:space-key'))).toEqual(['ENG', null]);
    expect(oracleElements(writeBack(html, F.pageLinkWithNeighbour), 'ac', 'link').map((link) => link.getAttribute('ac:anchor'))).toEqual(['sec', null]);
    expect(pages.map((page) => page.getAttribute('ri:content-title'))).toEqual(['My Page', 'Elsewhere']);
  });
});

describe('emoticons', () => {
  it('reinserts at the exact raw offset when the target holds the stored whitespace', () => {
    expect(reconcile(F.emoticonRun).html).toBe(`<p>Done ${TICK} now</p><p>Other text</p>`);
  });

  it('two emoticons in one gap', () => {
    expect(reconcile(F.emoticonsInOneGap).html).toBe(`<p>a ${TICK}${CROSS} b</p>`);
  });

  it('skips a gap that crosses a mark boundary', () => {
    expect(reconcile(F.emoticonAfterMark).report.skipped).toEqual({ emoticon: { boundary: 1 } });
  });

  it('skips an emoticon at the edge of a recovered link', () => {
    const { html, report } = reconcile(F.emoticonAtLinkEdge);
    expect(report.recovered).toEqual({ link: 1 });
    expect(report.skipped).toEqual({ emoticon: { boundary: 1 } });
    expect(html).toBe('<p>See <a href="#confluence-page:P?ri:space-key=S" data-confluence-link="page">the page</a> after</p>');
  });

  it('fills emoticon-only cells of an unchanged table grid', () => {
    expect(reconcile(F.emoticonGrid).html).toBe(
      `<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>alpha</td><td>${TICK}</td></tr><tr><td>beta</td><td>${CROSS}</td></tr></tbody></table>`,
    );
  });

  it('skips a table whose rows were swapped, repeated or spanned', () => {
    const swapped = F.emoticonGrid.legacyHtml.replace('<tr><td>alpha</td><td></td></tr><tr><td>beta</td><td></td></tr>', '<tr><td>beta</td><td></td></tr><tr><td>alpha</td><td></td></tr>');
    expect(swapped).not.toBe(F.emoticonGrid.legacyHtml);
    expect(reconcile(F.emoticonGrid, swapped).report.recovered).toEqual({});
    expect(reconcile(F.emoticonGridRepeated).report.skipped).toEqual({ emoticon: { ambiguous: 2 } });
    expect(reconcile(F.emoticonGridSpanned).report.skipped).toEqual({ emoticon: { ambiguous: 1 } });
  });

  it('counts an emoticon-only paragraph as empty_block', () => {
    expect(reconcile(F.emoticonOnlyParagraph).report.skipped).toEqual({ emoticon: { empty_block: 1 } });
  });

  it('keeps surrogate pairs whole', () => {
    expect(reconcile(F.emoticonSurrogates).html).toBe(`<p>\u{1D11E} ${TICK} \u{1F600} tail</p>`);
  });
});

describe('C7 / M7 / Y6 / Z4: bounds before the work they bound', () => {
  it('rejects oversize input before any scan', () => {
    const probe = vi.fn(() => {
      throw new Error('scanned');
    });
    const registry: CarrierKind[] = CARRIER_KINDS.map((kind) => ({ ...kind, storageMayCarry: probe }));
    for (const budget of [{ length: F.emoticonRun.storage.length - 1 }, { length: F.emoticonRun.legacyHtml.length - 1 }]) {
      expect(reconcile(F.emoticonRun, F.emoticonRun.legacyHtml, { registry, budget }).report.outcome).toBe('bound');
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it('returns bound for a task list inside a task list, and for a task inside a task\'s body without a nested list, before any pass', () => {
    for (const fixture of [F.taskNestedList, F.taskInTask]) {
      expect(reconcile(fixture)).toMatchObject({ html: fixture.legacyHtml, report: { outcome: 'bound', work: { passes: 0 } } });
    }
  });

  it('still recovers an emoticon in a flat task list', () => {
    expect(reconcile(F.sourcesInContainers).html).toContain(`task ${EMOTICON('wink', '😉')} body`);
  });

  it('returns bound for storage over the macro caps, with zero passes', () => {
    expect(reconcile(F.macroCap, F.macroCap.legacyHtml, { budget: { macros: 5 } }).report).toMatchObject({ outcome: 'bound', work: { passes: 0 } });
    expect(reconcile(F.nestedColumns, F.nestedColumns.legacyHtml, { budget: { macroDepth: 1 } }).report).toMatchObject({ outcome: 'bound', work: { passes: 0 } });
  });

  it('charges the mark cap before the first stamp', () => {
    expect(reconcile(F.ac1, F.ac1.legacyHtml, { budget: { marks: 8 } }).report).toMatchObject({ outcome: 'recovered' });
    expect(reconcile(F.ac1, F.ac1.legacyHtml, { budget: { marks: 7 } }).report).toMatchObject({ outcome: 'bound', recovered: {} });
  });

  it('stops the reader at its node limit', () => {
    expect(reconcile(F.ac1, F.ac1.legacyHtml, { budget: { readerNodes: 10 } }).report).toMatchObject({ outcome: 'bound', work: { nodes: 0, passes: 0 } });
  });

  it('stops between passes when the conversion needs more passes than its budget', () => {
    expect(reconcile(F.nestedColumns).report).toMatchObject({ outcome: 'recovered', work: { passes: 2 } });
    expect(reconcile(F.nestedColumns, F.nestedColumns.legacyHtml, { budget: { passes: 1 } }).report).toMatchObject({ outcome: 'bound', work: { passes: 1 } });
  });

  it('charges frame chains, mark sets, keys and splices before building them', () => {
    const { html, report } = reconcile(F.ac1, F.ac1.legacyHtml, { budget: { workFactor: 0.05 } });
    expect(report.outcome).toBe('bound');
    expect(html).toBe(F.ac1.legacyHtml);
    expect(report.work.spliceUnits).toBe(0);
  });

  it('charges a long attribute once, not per character of every run that carries it', () => {
    // Twenty runs share one 1,000-character mark signature on three sides: charged per run, the signature alone
    // (60,000 units) exceeds this budget (0.8 × the summed lengths, about 53,000 units).
    expect(reconcile(F.longMarkAttribute, F.longMarkAttribute.legacyHtml, { budget: { workFactor: 0.8 } }).report.recovered).toEqual({ emoticon: 20 });
  });

  it('uses the one marker it was given and returns bound when the storage spells it', () => {
    expect(reconcile(F.markerSpelled).report.outcome).toBe('bound');
    const other = 'data-cq-ffffffffffffffffffffffffffffffff';
    expect(reconcile(F.markerSpelled, F.markerSpelled.legacyHtml, { marker: other }).report.recovered).toEqual({ emoticon: 1 });
  });

  it('reports no kind counts and no content for none, bound, unreadable, differing, unconvertible and failed outcomes', () => {
    _setForwardDerivationStepForTest(() => {
      throw new Error('conversion failed');
    });
    const unconvertible = reconcile(F.code);
    _setForwardDerivationStepForTest(undefined);
    const reports = [
      reconcile(F.rawEmoticonSpan).report,
      reconcile(F.taskInTask).report,
      reconcile(F.notWellFormed).report,
      reconcile(F.composite).report,
      unconvertible.report,
      reconcile(F.code, F.code.legacyHtml, { marker: 'x' }).report,
    ];
    expect(reports.map((report) => report.outcome)).toEqual(['none', 'bound', 'storage_unreadable', 'storage_reading_differs', 'storage_unconvertible', 'failed']);
    for (const report of reports) {
      expect(report).toMatchObject({ recovered: {}, skipped: {}, codeOps: [] });
      expect(JSON.stringify(report)).not.toMatch(/Main|tick|java|My Page/);
    }
  });

  it('Z6: reports evaluated with the skip reason by kind when every record was skipped', () => {
    const target = F.evaluatedMix.legacyHtml.replace('Done  now', 'Done  later');
    const result = reconcile(F.evaluatedMix, target);
    expect(result.html).toBe(target);
    expect(result.report).toMatchObject({ outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 2 }, emoticon: { changed: 1 } }, codeOps: [] });
  });

  it('AA3: a page whose only candidate of a kind was rejected before marking is evaluated, not none', () => {
    const { html, report } = reconcile(F.linkRejectedOnly);
    expect(html).toBe(F.linkRejectedOnly.legacyHtml);
    expect(report).toMatchObject({ outcome: 'evaluated', recovered: {}, skipped: { link: { unsupported: 1 } } });
    expect(JSON.stringify(report)).not.toMatch(/confluence-page|tail/);
    // The kind gate still applies: a stored body that already carries a link leaves the kind out entirely.
    const carried = `${F.linkRejectedOnly.legacyHtml}<p><a href="#confluence-anchor:x" data-confluence-link="anchor">x</a></p>`;
    expect(reconcileConfluenceCarriers(carried, F.linkRejectedOnly.storage, carried, { marker: MARKER }).report.outcome).toBe('none');
  });

  it('AA3: one kind recovered and another rejected reports both, with the exact skip count', () => {
    const { report } = reconcile(F.linkCodeBody);
    expect(report).toMatchObject({ outcome: 'recovered', recovered: { 'macro.code': 1 }, skipped: { link: { unsupported: 1 } } });
  });

  it('a throwing kind is counted and the others still apply', () => {
    const status = CARRIER_KINDS.find((kind) => kind.id === 'macro.status')!;
    const registry = CARRIER_KINDS.map((kind) => (kind === status ? { ...status, record: () => { throw new Error('kind failed'); } } : kind));
    expect(reconcile(F.statusToc, F.statusToc.legacyHtml, { registry }).report).toMatchObject({
      outcome: 'recovered',
      recovered: { 'macro.toc': 1 },
      skipped: { 'macro.status': { error: 1 } },
    });
  });
});

/**
 * Review r1/r2 invariant: a recovery is reported only when it is in the returned HTML and was absent before. Per
 * kind, counts the carriers the result holds that the target did not (a multiset difference); the count must equal
 * the reported one. A link is identified by the target the reverse pass writes for it (kind, value and every
 * parameter, an href's spelling and its legacy form ignored), so an equivalent respelling adds nothing.
 */
function carriersByKind(html: string): Record<string, string[]> {
  const body = new JSDOM(`<body>${html}</body>`).window.document.body;
  const links = [...body.querySelectorAll('a')].flatMap((a) => {
    const carrier = confluenceLinkCarrierOf(a);
    const link = carrier === null ? null : parseConfluenceLinkHref(carrier);
    if (!link) return [];
    const target = [link.kind, link.value, link.link, link.resource, link.container, link.body];
    return [JSON.stringify([target, a.getAttribute('data-confluence-link'), a.textContent])];
  });
  const outer = (selector: string) => [...body.querySelectorAll(selector)].map((el) => el.outerHTML);
  return {
    'macro.code': outer('pre[data-title], pre[data-macro-params]'),
    'macro.status': outer('span.confluence-status[data-macro-params]'),
    'macro.toc': outer('div.confluence-toc[data-macro-params]'),
    link: links,
    emoticon: [...body.querySelectorAll('span.confluence-emoticon')].map((_span, index) => `${index}`),
  };
}

function expectRecoveriesPresent(target: string, result: { html: string; report: CarrierReport }): void {
  const before = carriersByKind(target);
  const after = carriersByKind(result.html);
  for (const kind of Object.keys(before)) {
    const remaining = [...before[kind]!];
    let added = 0;
    for (const item of after[kind]!) {
      const at = remaining.indexOf(item);
      if (at >= 0) remaining.splice(at, 1);
      else added += 1;
    }
    expect({ kind, added }).toEqual({ kind, added: result.report.recovered[kind as keyof CarrierReport['recovered']] ?? 0 });
  }
}

/** TipTap's task item: the checkbox chrome, then the content div that holds the stored task body. */
function tiptapTasks(html: string): string {
  return html.replace(/(<li data-type="taskItem"[^>]*>)([\s\S]*?)(<\/li>)/g, '$1<label><input type="checkbox"></label><div>$2</div>$3');
}

describe('review r1', () => {
  it('CAR-1: a recovered status or link that starts a run and an emoticon later in the run are both in the returned HTML, in either plan order', () => {
    for (const registry of [CARRIER_KINDS, [...CARRIER_KINDS].reverse()]) {
      for (const [fixture, kind] of [[F.statusThenEmoticon, 'macro.status'], [F.linkThenEmoticon, 'link']] as const) {
        const result = reconcile(fixture, fixture.legacyHtml, { registry });
        expect(result.html).toBe(confluenceToHtml(fixture.storage));
        expect(result.report.recovered).toEqual({ [kind]: 1, emoticon: 1 });
        expect(result.report.skipped).toEqual({});
        expect(oracleElements(writeBack(result.html, fixture), 'ac', 'emoticon')).toHaveLength(1);
      }
    }
    expect(reconcile(F.statusThenEmoticon).html).toBe(
      `<p><span class="confluence-status" data-color="green" data-macro-params="{&quot;subtle&quot;:&quot;true&quot;}">OK</span> a ${TICK} b</p>`,
    );
    expect(reconcile(F.linkThenEmoticon).html).toBe(
      `<p><a href="#confluence-page:My%20Page?ac:anchor=sec&amp;ri:space-key=ENG" data-confluence-link="page">the page</a> a ${TICK} b</p>`,
    );
  });

  it('CAR-2: recovering a task-body emoticon in TipTap\'s task item changes only that run, never copying the checkbox into the body', () => {
    const target = tiptapTasks(F.sourcesInContainers.legacyHtml);
    expect(target).toContain('<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div>task  body</div></li>');
    const { html, report } = reconcile(F.sourcesInContainers, target);
    expect(report.recovered).toEqual({ emoticon: 4 });
    expect(html).toContain(`<li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div>task ${EMOTICON('wink', '😉')} body</div></li></ul>`);
    const [taskBody] = oracleElements(writeBack(html, F.sourcesInContainers), 'ac', 'task-body');
    expect([...taskBody!.childNodes].map((node) => node.nodeName)).toEqual(['#text', 'ac:emoticon', '#text']);

    const leading = tiptapTasks(F.taskLeadingRun.legacyHtml);
    const result = reconcile(F.taskLeadingRun, leading);
    expect(result.report.recovered).toEqual({ emoticon: 1 });
    expect(result.html).toBe(`<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div>lead ${TICK} x<p>after</p></div></li></ul>`);
  });

  it('CAR-3: adjacent emoticons keep their stored order in an empty cell and in a text gap', () => {
    const { html, report } = reconcile(F.emoticonGridAdjacent);
    expect(report.recovered).toEqual({ emoticon: 3 });
    expect(html).toContain(`<td>alpha</td><td>${TICK}${EMOTICON('wink', '😉')}</td>`);
    const order = (storage: string) => oracleElements(storage, 'ac', 'emoticon').map((el) => el.getAttribute('ac:name'));
    expect(order(writeBack(html, F.emoticonGridAdjacent))).toEqual(order(F.emoticonGridAdjacent.storage));
    expect(order(writeBack(reconcile(F.emoticonsInOneGap).html, F.emoticonsInOneGap))).toEqual(['tick', 'cross']);
  });

  it('CAR-4: planning serializes each record a bounded number of times, linear in the records of a run', () => {
    const require = createRequire(import.meta.url);
    const { implementation: ElementImpl } = require('jsdom/lib/jsdom/living/nodes/Element-impl.js') as { implementation: { prototype: object } };
    const serializations = vi.spyOn(ElementImpl.prototype as { outerHTML: string }, 'outerHTML', 'get');
    const { report } = reconcile(F.statusRun32);
    expect(report.recovered).toEqual({ 'macro.status': 32 });
    expect(serializations.mock.calls.length).toBeLessThanOrEqual(32);
  });

  it('CAR-5: an entity-spelled macro name is a source like the literal one, whatever else the page holds', () => {
    for (const fixture of [F.encodedStatus, F.encodedStatusNeutral]) {
      expect(reconcile(fixture).report).toMatchObject({ outcome: 'recovered', recovered: { 'macro.status': 1 } });
    }
    expect(reconcile(F.encodedCode).report.recovered).toEqual({ 'macro.code': 1 });
    expect(reconcile(F.encodedToc).report.recovered).toEqual({ 'macro.toc': 1 });
    for (const fixture of [F.encodedStatus, F.encodedCode, F.encodedToc]) {
      expect(CARRIER_KINDS.filter((kind) => kind.storageMayCarry(fixture.storage)).map((kind) => kind.id)).toEqual(expect.arrayContaining(
        [fixture === F.encodedStatus ? 'macro.status' : fixture === F.encodedCode ? 'macro.code' : 'macro.toc'],
      ));
    }
  });

  it('CAR-6: an edited data-confluence-link is never overwritten; an unchanged legacy or absent one is', () => {
    const edited = F.pageLink.legacyHtml.replace('data-confluence-link="page"', 'data-confluence-link="attachment"');
    expect(reconcile(F.pageLink, edited)).toMatchObject({ html: edited, report: { outcome: 'evaluated', skipped: { link: { changed: 1 } } } });
    expect(reconcile(F.pageLink).html).toContain('data-confluence-link="page"');
    expect(reconcile(F.attachmentOwned).html).toContain('data-confluence-link="attachment">a.pdf</a>');
    expect(reconcile(F.pageLink, '<p>See <a href="#confluence-page:My Page">the page</a>.</p>').html)
      .toBe('<p>See <a href="#confluence-page:My%20Page?ac:anchor=sec&amp;ri:space-key=ENG" data-confluence-link="page">the page</a>.</p>');
  });

  // One test per fixture (CI time limit): the same three targets and assertions as one loop over the corpus.
  const INVARIANT_FIXTURES = Object.entries(F);
  const INVARIANT_TARGETS = [
    ['stored', (html: string) => html],
    ['editor', editorProjection],
    ['TipTap', tiptapTasks],
  ] as const;

  it('invariant: the corpus check below covers every fixture with its three targets', () => {
    expect(INVARIANT_FIXTURES.map(([name]) => name)).toEqual(Object.keys(F));
    expect(INVARIANT_FIXTURES.length * INVARIANT_TARGETS.length).toBe(3 * Object.keys(F).length);
  });

  it.each(INVARIANT_FIXTURES)('invariant: every reported recovery is in the returned HTML for %s and its editor and TipTap targets', (_name, fixture) => {
    let checked = 0;
    for (const [, project] of INVARIANT_TARGETS) {
      const target = project(fixture.legacyHtml);
      const result = reconcile(fixture, target);
      expectRecoveriesPresent(target, result);
      if (result.report.outcome !== 'recovered') expect(result.html).toBe(target);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

describe('review r2', () => {
  /** T with the two links of a two-link paragraph swapped. */
  function swapLinks(html: string): string {
    const doc = new JSDOM(`<body>${html}</body>`).window.document;
    const [first, second] = [...doc.querySelectorAll('a')];
    const marker = doc.createElement('i');
    first!.replaceWith(marker);
    second!.replaceWith(first!);
    marker.replaceWith(second!);
    return doc.body.innerHTML;
  }

  const spaces = (storage: string) => oracleElements(storage, 'ri', 'page').map((page) => page.getAttribute('ri:space-key'));

  it('CAR-8: links that differ only in a spelling the keys fold abstain, swapped or not, and no space is published', () => {
    for (const fixture of [F.linksEquivalentBold, F.linksEquivalentSpan, F.linksIdenticalBold]) {
      for (const target of [fixture.legacyHtml, swapLinks(fixture.legacyHtml)]) {
        const result = reconcile(fixture, target);
        expect(result).toMatchObject({ html: target, report: { outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 2 } } } });
        expect(spaces(writeBack(result.html, fixture))).toEqual([null, null]);
      }
    }
  });

  it('CAR-8: links to one page with labels the keys tell apart abstain too (review r4 destination rule), swapped or not', () => {
    for (const target of [F.linksDistinct.legacyHtml, swapLinks(F.linksDistinct.legacyHtml)]) {
      const result = reconcile(F.linksDistinct, target);
      expect(result).toMatchObject({ html: target, report: { outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 2 } } } });
      expect(spaces(writeBack(result.html, F.linksDistinct))).toEqual([null, null]);
    }
  });

  it('CAR-9: a parameterless link whose legacy href only spells its value differently recovers nothing', () => {
    for (const fixture of [F.pageLinkSpaced, F.pageLinkSpacedBody, F.attachmentSpaced]) {
      expect(reconcile(fixture)).toMatchObject({ html: fixture.legacyHtml, report: { outcome: 'none', recovered: {}, skipped: {} } });
      const current = confluenceToHtml(fixture.storage);
      const next = writeBack(current, fixture);
      expect(reconcileConfluenceCarriers(current, next, current, { marker: MARKER })).toMatchObject({ html: current, report: { outcome: 'none', recovered: {} } });
    }
  });

  it('CAR-9: a legacy href that decodes to another value is still recovered', () => {
    const { html, report } = reconcile(F.pageLinkPercentTitle);
    expect(report.recovered).toEqual({ link: 1 });
    const title = (storage: string) => oracleElements(storage, 'ri', 'page')[0]!.getAttribute('ri:content-title');
    expect(title(writeBack(F.pageLinkPercentTitle.legacyHtml, F.pageLinkPercentTitle))).toBe('a b');
    expect(title(writeBack(html, F.pageLinkPercentTitle))).toBe('a%20b');
  });

  // One test per fixture (CI time limit): the same assertions as one loop over the corpus.
  it.each(Object.entries(F))('CAR-9: the next stored row of %s recovers nothing (review r3 CAR-14: every fixture writes)', (name, fixture) => {
    const first = reconcile(fixture);
    const storage = writeBack(first.html, fixture);
    for (const stored of [first.html, confluenceToHtml(storage)]) {
      const next = reconcileConfluenceCarriers(stored, storage, stored, { marker: MARKER });
      expect({ name, recovered: next.report.recovered }).toEqual({ name, recovered: {} });
      expect(next.html).toBe(stored);
    }
  });

  it('CAR-10: start tags with no rewritten run cost no containment work; a mixed run costs one search', () => {
    expect(reconcile(F.statusRun32).report).toMatchObject({ recovered: { 'macro.status': 32 }, work: { containment: 0 } });
    // One run region and one start tag: ⌈log2(1 + 1)⌉ = 1 step each.
    expect(reconcile(F.statusThenEmoticon).report).toMatchObject({ recovered: { 'macro.status': 1, emoticon: 1 }, work: { containment: 2 } });
  });
});

/** T with the first two elements matching `selector` swapped. */
function swapFirstTwo(html: string, selector: string): string {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const [first, second] = [...doc.querySelectorAll(selector)];
  const marker = doc.createElement('i');
  first!.replaceWith(marker);
  second!.replaceWith(first!);
  marker.replaceWith(second!);
  return doc.body.innerHTML;
}

describe('review r3', () => {
  const spaces = (storage: string) => oracleElements(storage, 'ri', 'page').map((page) => page.getAttribute('ri:space-key'));

  it('CAR-12: links with one visible label abstain when an outer mark tells their positions apart, swapped or not', () => {
    for (const fixture of [F.linksEquivalentUnderEm, F.linksIdenticalUnderEm]) {
      for (const target of [fixture.legacyHtml, swapFirstTwo(fixture.legacyHtml, 'a')]) {
        const result = reconcile(fixture, target);
        expect(result).toMatchObject({ html: target, report: { outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 2 } } } });
        expect(spaces(writeBack(result.html, fixture))).toEqual([null, null]);
      }
    }
  });

  it('CAR-12: statuses are told apart by what they are, not by the marks around their positions', () => {
    for (const target of [F.statusesUnderEm.legacyHtml, swapFirstTwo(F.statusesUnderEm.legacyHtml, 'span.confluence-status')]) {
      const result = reconcile(F.statusesUnderEm, target);
      expect(result).toMatchObject({ html: target, report: { outcome: 'evaluated', recovered: {}, skipped: { 'macro.status': { ambiguous: 2 } } } });
      expect(parameters(writeBack(result.html, F.statusesUnderEm), 'status')).not.toHaveProperty('subtle');
    }
  });

  it('CAR-13: a link that needs no change is still a rival: the edit abstains and nothing is published', () => {
    for (const fixture of [F.linksNoopRival, F.linksNoopRivalIdentical]) {
      for (const target of [fixture.legacyHtml, swapFirstTwo(fixture.legacyHtml, 'a')]) {
        const result = reconcile(fixture, target);
        expect(result).toMatchObject({ html: target, report: { outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 1 } } } });
        expect(spaces(writeBack(result.html, fixture))).toEqual([null, null]);
      }
    }
  });

  it('CAR-13: an unopposed cross-space link still recovers its space', () => {
    const { html, report } = reconcile(F.linkUnopposedCrossSpace);
    expect(report).toMatchObject({ outcome: 'recovered', recovered: { link: 1 }, skipped: {} });
    expect(spaces(writeBack(html, F.linkUnopposedCrossSpace))).toEqual(['A']);
  });

  it('ruling: a link abstains page-wide when any link of any kind in L, S or T shows its label', () => {
    // In storage and in the stored body: a page link and an anchor link elsewhere, both shown as `X`.
    const { html, report } = reconcile(F.linkLabelElsewhere);
    expect(report).toMatchObject({ outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 2 } } });
    expect(spaces(writeBack(html, F.linkLabelElsewhere))).toEqual([null]);
    // Only in the target: an external link the user added with the same label.
    const target = `${F.pageLink.legacyHtml}<p><a href="https://example.com/"><em>the page</em></a></p>`;
    expect(reconcile(F.pageLink, target)).toMatchObject({ html: target, report: { skipped: { link: { ambiguous: 1 } } } });
    // Different labels and destinations keep recovering.
    expect(reconcile(F.ac1).report).toMatchObject({ recovered: { link: 3 }, skipped: {} });
  });
});

describe('review r4', () => {
  const links = (storage: string) => oracleElements(storage, 'ac', 'link');
  const skippedTotal = (report: CarrierReport) => Object.values(report.skipped.link ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);

  it('CAR-15: a link whose storage label another link shows abstains, though the stored body shows another label', () => {
    const result = reconcile(F.attachmentOwnedLabelRival);
    expect(result).toMatchObject({ html: F.attachmentOwnedLabelRival.legacyHtml, report: { outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 1 } } } });
    expect(oracleElements(writeBack(result.html, F.attachmentOwnedLabelRival), 'ri', 'attachment')).toHaveLength(0);
  });

  it('CAR-15: the unopposed page-owned attachment still recovers its filename and container', () => {
    const { html, report } = reconcile(F.attachmentOwnedLabelInText);
    expect(report).toMatchObject({ outcome: 'recovered', recovered: { link: 1 }, skipped: {} });
    expect(html).toBe('<p>File <a href="#confluence-attachment:a.pdf?page.ri:content-title=Other" data-confluence-link="attachment">a.pdf</a> here</p><p>See a.pdf.</p>');
  });

  it('CAR-16: a link whose own anchor is gone from the target is not republished, whatever else links there', () => {
    const external = '<p>Jump to top now</p><p>Next <a href="https://example.org/">to top</a>.</p>';
    const anchored = '<p>Jump to top now</p><p>Next <a href="#confluence-anchor:top" data-confluence-link="anchor">to top</a>.</p>';
    const bare = '<p>Jump to top now</p><p>Next to top.</p>';
    for (const target of [external, anchored, bare]) {
      const result = reconcile(F.anchorLinkBesideText, target);
      expect(result.html).toBe(target);
      expect(result.report.recovered).toEqual({});
      expect(skippedTotal(result.report)).toBe(1);
      const written = links(writeBack(result.html, F.anchorLinkBesideText)).map((link) => link.getAttribute('ac:anchor'));
      expect(written).toEqual(links(writeBack(target, F.anchorLinkBesideText)).map((link) => link.getAttribute('ac:anchor')));
    }
    expect(links(writeBack(anchored, F.anchorLinkBesideText)).map((link) => link.getAttribute('ac:anchor'))).toEqual(['top']);
  });

  it('CAR-16: two links to one destination abstain page-wide, whatever their labels', () => {
    const result = reconcile(F.samePageTwoLabels);
    expect(result).toMatchObject({ html: F.samePageTwoLabels.legacyHtml, report: { outcome: 'evaluated', recovered: {}, skipped: { link: { ambiguous: 2 } } } });
    expect(oracleElements(writeBack(result.html, F.samePageTwoLabels), 'ri', 'page').map((page) => page.getAttribute('ri:space-key'))).toEqual([null, null]);
  });

  it('unopposed links whose anchor survives in the target still recover', () => {
    expect(reconcile(F.anchorLink).report).toMatchObject({ recovered: { link: 1 }, skipped: {} });
    expect(reconcile(F.pageLink).report).toMatchObject({ recovered: { link: 1 }, skipped: {} });
    expect(reconcile(F.attachmentOwned).report).toMatchObject({ recovered: { link: 1 }, skipped: {} });
  });
});
