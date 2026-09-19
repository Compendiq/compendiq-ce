import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PageBaselineManifestError,
  baselineAttachmentByIdentity,
  encodeBaselineManifest,
  renderBaselineBodyHtml,
  type BaselineAttachment,
} from './page-baseline-manifest.js';

const BASELINE_ID = '018f47a8-4a19-7cc2-a747-8f4ef65d9a22';

function digest(value: unknown[]): string {
  return createHash('sha256').update(encodeBaselineManifest(value)).digest('hex');
}

function attachment(
  store: BaselineAttachment['store'],
  pageKey: string,
  filename: string,
): BaselineAttachment {
  const identity = createHash('sha256')
    .update(encodeBaselineManifest([store, pageKey, filename]))
    .digest('hex');
  const mediaId = createHash('sha256').update(`retained:${identity}`).digest('hex');
  return {
    identity,
    store,
    pageKey,
    filename,
    size: 3,
    mediaType: 'application/octet-stream',
    sha256: createHash('sha256').update(filename).digest('hex'),
    retainedPath: `page-baselines/${BASELINE_ID}/${BASELINE_ID}/media/${mediaId}`,
  };
}

describe('baseline manifest v1 canonical encoding', () => {
  it('uses the exact fixed nested arrays and UTF-8 JSON bytes without a BOM or newline', () => {
    const manifest = [
      'compendiq.article-baseline',
      1,
      BASELINE_ID,
      ['page', 'confluence', '42', '9001'],
      7,
      '19',
      'Überblick',
      '<p>漢字🙂</p>',
      '',
      null,
      ['z', 'ä', 'é'],
      ['parent', 'standalone', '12', null, '12'],
      ['icon', 'lucide', 'file-text', '#3b82f6', true],
      [['abc', 'local', '42', 'plan.pdf', 3, 'application/pdf', 'def']],
    ];

    const encoded = encodeBaselineManifest(manifest);
    expect(encoded.equals(Buffer.from(JSON.stringify(manifest), 'utf8'))).toBe(true);
    expect(encoded.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(encoded.at(-1)).not.toBe(0x0a);
    expect(encoded.toString('utf8')).toContain('漢字🙂');
  });

  it('frames values so the historical concatenation counterexample has distinct bytes and digests', () => {
    const first = ['compendiq.article-baseline', 1, BASELINE_ID, '<p>Approved</p>', 'AB', 7];
    const second = ['compendiq.article-baseline', 1, BASELINE_ID, '<p>Approved</p>A', 'B', 7];

    expect(encodeBaselineManifest(first).equals(encodeBaselineManifest(second))).toBe(false);
    expect(digest(first)).not.toBe(digest(second));
  });

  it('preserves null versus empty string and composed versus decomposed Unicode', () => {
    const composed = ['é', null, ''];
    const decomposed = ['e\u0301', '', null];

    expect(encodeBaselineManifest(composed).toString('utf8')).toBe('["é",null,""]');
    expect(encodeBaselineManifest(decomposed).toString('utf8')).toBe('["é","",null]');
    expect(digest(composed)).not.toBe(digest(decomposed));
  });

  it('refuses unpaired surrogates instead of letting UTF-8 replace them', () => {
    for (const malformed of ['\ud800', '\udc00', `before\ud800after`, `trailing\ud800`]) {
      expect(() => encodeBaselineManifest([malformed])).toThrowError(
        expect.objectContaining<PageBaselineManifestError>({
          reason: 'baseline_manifest_invalid',
          statusCode: 409,
        }),
      );
    }
  });

  it('refuses object iteration, unsafe numbers and cycles', () => {
    expect(() => encodeBaselineManifest([{ key: 'value' }])).toThrowError(PageBaselineManifestError);
    expect(() => encodeBaselineManifest([1.5])).toThrowError(PageBaselineManifestError);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => encodeBaselineManifest(cyclic)).toThrowError(PageBaselineManifestError);
  });
});

describe('baseline rendering-only media projection', () => {
  it('rewrites every captured URL shape through page-scoped inventory identities', () => {
    const inventory = [
      attachment('local', '42', 'local.png'),
      attachment('confluence', '9001', 'diagram.png'),
      attachment('confluence', '9001', 'diagram.drawio'),
      attachment('confluence', '9001', 'manual.pdf'),
      attachment('confluence', '9001', 'legacy.png'),
    ];
    const html =
      '<div class="confluence-drawio" data-drawio-xml="/api/attachments/9001/diagram.drawio">'
      + '<img src="/api/attachments/9001/diagram.png"></div>'
      + '<source srcset="/api/local-attachments/42/local.png 1x, /api/attachments/9001/diagram.png 2x">'
      + '<a href="/api/attachments/9001/manual.pdf">manual</a>'
      + '<img src="#confluence-attachment:legacy.png">';

    const rendered = renderBaselineBodyHtml(html, 42, BASELINE_ID, inventory, '9001');
    for (const item of inventory) {
      expect(rendered).toContain(`/api/pages/42/baselines/${BASELINE_ID}/media/${item.identity}`);
    }
    expect(rendered).not.toContain('/api/attachments/');
    expect(rendered).not.toContain('/api/local-attachments/');
    expect(html).toContain('/api/attachments/9001/diagram.png');
  });

  it('refuses rendering a recognized live reference absent from the retained inventory', () => {
    expect(() =>
      renderBaselineBodyHtml(
        '<img src="/api/attachments/9001/missing.png">',
        42,
        BASELINE_ID,
        [],
        '9001',
      )).toThrowError(expect.objectContaining({ reason: 'baseline_storage_unavailable' }));
  });

  it('binds legacy hash references to the persisted page namespace despite same-named foreign media', () => {
    const own = attachment('confluence', '9001', 'legacy.png');
    const foreign = attachment('confluence', 'foreign-page', 'legacy.png');
    const rendered = renderBaselineBodyHtml(
      '<img src="#confluence-attachment:legacy.png">',
      42,
      BASELINE_ID,
      [foreign, own],
      '9001',
    );

    expect(rendered).toContain(`/api/pages/42/baselines/${BASELINE_ID}/media/${own.identity}`);
    expect(rendered).not.toContain(foreign.identity);
    expect(() =>
      renderBaselineBodyHtml(
        '<img src="#confluence-attachment:legacy.png">',
        42,
        BASELINE_ID,
        [foreign],
        '9001',
      )).toThrowError(expect.objectContaining({ reason: 'baseline_storage_unavailable' }));
  });

  it('keeps comma-bearing inline srcset URLs intact while rewriting only retained candidates', () => {
    const retained = attachment('confluence', '9001', 'diagram.png');
    const srcset = 'data:image/png;base64,AA,BB 1x,  /api/attachments/9001/diagram.png 2x';
    const rendered = renderBaselineBodyHtml(
      `<source srcset="${srcset}">`,
      42,
      BASELINE_ID,
      [retained],
      '9001',
    );

    expect(rendered).toContain(
      `srcset="data:image/png;base64,AA,BB 1x,  /api/pages/42/baselines/${BASELINE_ID}/media/${retained.identity} 2x"`,
    );
  });

  it('resolves route identities from validated persisted inventory only', () => {
    const item = attachment('local', '42', 'local.png');
    expect(baselineAttachmentByIdentity(BASELINE_ID, [item], item.identity)).toEqual(item);
    expect(baselineAttachmentByIdentity(BASELINE_ID, [item], 'f'.repeat(64))).toBeNull();
    expect(baselineAttachmentByIdentity(BASELINE_ID, [item], '../escape')).toBeNull();
  });
});
