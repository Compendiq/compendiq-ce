import { describe, it, expect, vi } from 'vitest';
import {
  buildPreview,
  claimedFormatFromFilename,
  DocumentExtractionError,
  extractDocumentText,
  PREVIEW_LENGTH,
  resolveDocumentFormat,
  rtfToText,
  sniffDocumentFormat,
  unzipWithinLimits,
  ZIP_LIMITS,
} from './document-extractor.js';
import {
  buildDocx,
  buildOdt,
  buildPdf,
  buildRtf,
  buildZip,
  compressibleEntry,
  forgeUncompressedSizes,
  incompressibleEntry,
} from './test-document-fixtures.js';

/**
 * No extractor dependency is mocked. Every fixture is real bytes, so `unpdf`,
 * `mammoth` and `fflate` all run for real — a sniffing or zip-bomb assertion
 * against a mocked extractor would prove nothing. The one stub is the
 * `TextDecoder` global in a single rtf test, standing in for a Node built
 * without full ICU.
 */

async function expectRejection(
  run: () => Promise<unknown>,
  kind: 'mediaType' | 'unprocessable',
): Promise<DocumentExtractionError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(DocumentExtractionError);
    const error = err as DocumentExtractionError;
    expect(error.kind).toBe(kind);
    return error;
  }
  throw new Error('Expected extraction to be rejected');
}

// =============================================================================
// claimedFormatFromFilename
// =============================================================================

describe('claimedFormatFromFilename', () => {
  it.each([
    ['report.pdf', 'pdf'],
    ['Report.PDF', 'pdf'],
    ['notes.docx', 'docx'],
    ['readme.md', 'md'],
    ['readme.markdown', 'md'],
    ['notes.txt', 'txt'],
    ['legacy.rtf', 'rtf'],
    ['plan.odt', 'odt'],
    ['config.yml', 'yaml'],
    ['config.YAML', 'yaml'],
    ['archive.tar.gz.pdf', 'pdf'],
  ])('maps %s to %s', (filename, expected) => {
    expect(claimedFormatFromFilename(filename)).toBe(expected);
  });

  it.each(['image.png', 'archive.zip', 'macro.docm', 'noextension', '', undefined])(
    'refuses to guess for %s',
    (filename) => {
      expect(claimedFormatFromFilename(filename)).toBeNull();
    },
  );
});

// =============================================================================
// Content sniffing
// =============================================================================

describe('sniffDocumentFormat', () => {
  it('recognises a real PDF by its magic bytes', async () => {
    expect(sniffDocumentFormat(await buildPdf(['Hello.']))).toBe('pdf');
  });

  it('recognises a docx by the word/document.xml entry, not by the zip magic alone', () => {
    expect(sniffDocumentFormat(buildDocx([{ text: 'Body.' }]))).toBe('docx');
  });

  it('recognises an odt by its mimetype entry', () => {
    expect(sniffDocumentFormat(buildOdt('<text:p>Body.</text:p>'))).toBe('odt');
  });

  it('rejects a zip that is neither docx nor odt', () => {
    expect(sniffDocumentFormat(buildZip({ 'notes.txt': new Uint8Array([1, 2, 3]) }))).toBeNull();
  });

  it('rejects a zip whose mimetype entry names a different ODF type', () => {
    const spreadsheet = buildZip({
      mimetype: new TextEncoder().encode('application/vnd.oasis.opendocument.spreadsheet'),
      'content.xml': new TextEncoder().encode('<x/>'),
    });
    expect(sniffDocumentFormat(spreadsheet)).toBeNull();
  });

  it('recognises rtf ahead of the generic text test', () => {
    expect(sniffDocumentFormat(buildRtf('Hello.'))).toBe('rtf');
  });

  it('classifies plain UTF-8 as text', () => {
    expect(sniffDocumentFormat(Buffer.from('# Heading\n\nBody with émoji 🎉', 'utf8'))).toBe('text');
  });

  it('rejects bytes carrying an embedded NUL', () => {
    expect(sniffDocumentFormat(Buffer.from('valid text\u0000then binary', 'utf8'))).toBeNull();
  });

  it('rejects invalid UTF-8', () => {
    expect(sniffDocumentFormat(Buffer.from([0xff, 0xfe, 0x41, 0x42]))).toBeNull();
  });

  it('rejects an empty buffer', () => {
    expect(sniffDocumentFormat(Buffer.alloc(0))).toBeNull();
  });
});

// =============================================================================
// Claimed-vs-actual reconciliation
// =============================================================================

describe('resolveDocumentFormat', () => {
  it('accepts plain text under either a .md or a .txt claim', () => {
    const text = Buffer.from('Just words.', 'utf8');
    expect(resolveDocumentFormat(text, 'notes.md')).toBe('md');
    expect(resolveDocumentFormat(text, 'notes.txt')).toBe('txt');
  });

  it('rejects a PDF body sent under a .docx name', async () => {
    const pdf = await buildPdf(['Hello.']);
    const error = await expectRejection(
      async () => resolveDocumentFormat(pdf, 'disguised.docx'),
      'mediaType',
    );
    expect(error.message).toBe('File is not a valid DOCX');
  });

  it('rejects a docx body sent under a .odt name', async () => {
    await expectRejection(
      async () => resolveDocumentFormat(buildDocx([{ text: 'Body.' }]), 'disguised.odt'),
      'mediaType',
    );
  });

  it('rejects an unsupported extension before looking at the bytes', async () => {
    const error = await expectRejection(
      async () => resolveDocumentFormat(Buffer.from('plain', 'utf8'), 'notes.png'),
      'mediaType',
    );
    expect(error.message).toContain('Supported formats');
  });

  it('rejects rtf bytes sent under a .txt name', async () => {
    await expectRejection(
      async () => resolveDocumentFormat(buildRtf('Hello.'), 'notes.txt'),
      'mediaType',
    );
  });
});

// =============================================================================
// Per-format extraction
// =============================================================================

describe('extractDocumentText', () => {
  it('extracts text and a page count from a real PDF', async () => {
    const pdf = await buildPdf(['Hello from page one.', 'Second page text.']);
    const result = await extractDocumentText(pdf, 'report.pdf');

    expect(result.format).toBe('pdf');
    expect(result.totalPages).toBe(2);
    expect(result.text).toContain('Hello from page one.');
    expect(result.text).toContain('Second page text.');
  });

  it('extracts docx as Markdown so headings survive into the prompt', async () => {
    const docx = buildDocx([
      { text: 'Quarterly Report', style: 'Heading1' },
      { text: 'Revenue grew by 12 percent.' },
    ]);
    const result = await extractDocumentText(docx, 'q3.docx');

    expect(result.format).toBe('docx');
    expect(result.text).toContain('# Quarterly Report');
    expect(result.text).toContain('Revenue grew by 12 percent.');
    expect(result.totalPages).toBeUndefined();
  });

  it('extracts odt headings, paragraphs and list items', async () => {
    const odt = buildOdt(
      '<text:h text:outline-level="1">Migration Plan</text:h>' +
      '<text:p>Cut over on <text:span>Friday</text:span> &amp; verify.</text:p>' +
      '<text:list>' +
      '<text:list-item><text:p>Back up the database</text:p></text:list-item>' +
      '<text:list-item><text:p>Drain the queue</text:p></text:list-item>' +
      '</text:list>',
    );
    const result = await extractDocumentText(odt, 'plan.odt');

    expect(result.format).toBe('odt');
    expect(result.text).toContain('# Migration Plan');
    expect(result.text).toContain('Cut over on Friday & verify.');
    expect(result.text).toContain('- Back up the database');
    expect(result.text).toContain('- Drain the queue');
    expect(result.totalPages).toBeUndefined();
  });

  it('preserves ODT repeated and default spaces alongside tabs and breaks', async () => {
    const odt = buildOdt('<text:p>A<text:s text:c="4"/>B<text:s/>C<text:tab/>D<text:line-break/>E<text:s text:c=\'2\'/>F</text:p>');
    expect((await extractDocumentText(odt, 'spaces.odt')).text).toBe('A    B C\tD\nE  F');
    const zero = buildOdt('<text:p>A<text:s text:c="0"/>B</text:p>');
    expect((await extractDocumentText(zero, 'zero.odt')).text).toBe('AB');
  });

  describe('odt structural walk (#1734)', () => {
    /** A footnote as LibreOffice writes it: the citation mark, then the note body. */
    const footnote = (mark: string, bodyXml: string): string =>
      `<text:note text:id="ftn${mark}" text:note-class="footnote">` +
      `<text:note-citation>${mark}</text:note-citation>` +
      `<text:note-body><text:p>${bodyXml}</text:p></text:note-body></text:note>`;

    /** The text extracted from an .odt whose `office:text` holds `bodyXml`. */
    const odtText = async (bodyXml: string, options?: Parameters<typeof buildOdt>[2]): Promise<string> =>
      (await extractDocumentText(buildOdt(bodyXml, {}, options), 'test.odt')).text;

    it('keeps the text after an embedded footnote, in document order', async () => {
      const odt = buildOdt(
        '<text:p>Before<text:note text:id="ftn1" text:note-class="footnote">' +
        '<text:note-citation>1</text:note-citation>' +
        '<text:note-body><text:p>Footnote</text:p></text:note-body>' +
        '</text:note>AFTER_SENTINEL</text:p>',
      );
      // The note body splits its paragraph where the note sits; the rendered
      // citation mark ("1") is not text and is dropped.
      expect(await extractDocumentText(odt, 'notes.odt')).toEqual({
        format: 'odt',
        text: 'Before\nFootnote\nAFTER_SENTINEL',
      });
    });

    it('splits a paragraph around each of two footnotes', async () => {
      expect(await odtText(`<text:p>Alpha${footnote('1', 'One')} Beta${footnote('2', 'Two')} Gamma</text:p>`))
        .toBe('Alpha\nOne\nBeta\nTwo\nGamma');
    });

    it('keeps list bullets and table cells intact around a footnote', async () => {
      const text = await odtText(
        '<text:list>' +
        `<text:list-item><text:p>Install${footnote('1', 'Needs admin rights.')} the agent</text:p></text:list-item>` +
        '<text:list-item><text:p>Restart</text:p></text:list-item>' +
        '</text:list>' +
        '<table:table><table:table-row>' +
        `<table:table-cell><text:p>Port${footnote('2', 'TCP only.')} 8443</text:p></table:table-cell>` +
        '<table:table-cell><text:p>Open</text:p></table:table-cell>' +
        '</table:table-row></table:table>',
      );
      // The bullet marks the item's first line only; the note and the rest of
      // the item follow as plain lines.
      expect(text).toBe('- Install\nNeeds admin rights.\nthe agent\n- Restart\nPort\nTCP only.\n8443\nOpen');
    });

    it('bullets every paragraph of a list item, also after a nested list', async () => {
      const text = await odtText(
        '<text:list><text:list-item>' +
        '<text:p>Prepare</text:p>' +
        '<text:list><text:list-item><text:p>Back up</text:p></text:list-item></text:list>' +
        '<text:p>then confirm</text:p>' +
        '</text:list-item></text:list>',
      );
      expect(text).toBe('- Prepare\n- Back up\n- then confirm');
    });

    it('bullets only the paragraphs a list item holds directly', async () => {
      // A paragraph inside a table cell inside a list item belongs to the cell.
      const text = await odtText(
        '<text:list>' +
        '<text:list-item><text:p>First</text:p><text:p>still first</text:p></text:list-item>' +
        '<text:list-item><table:table><table:table-row><table:table-cell>' +
        '<text:p>In a cell</text:p>' +
        '</table:table-cell></table:table-row></table:table></text:list-item>' +
        '</text:list>',
      );
      expect(text).toBe('- First\n- still first\nIn a cell');
    });

    it('reads a frame text box in place, keeping its heading and list', async () => {
      const text = await odtText(
        '<text:p>See<draw:frame draw:name="Checklist"><draw:text-box>' +
        '<text:h text:outline-level="2">Checklist</text:h>' +
        '<text:list><text:list-item><text:p>Back up<text:tab/>daily</text:p></text:list-item></text:list>' +
        '</draw:text-box></draw:frame>below.</text:p>',
      );
      expect(text).toBe('See\n## Checklist\n- Back up\tdaily\nbelow.');
    });

    it('splits a heading around its note and keeps an endnote where it sits', async () => {
      const text = await odtText(
        `<text:h text:outline-level="2">Scope${footnote('1', 'Draft.')} and limits</text:h>` +
        '<text:p><text:note text:id="edn1" text:note-class="endnote">' +
        '<text:note-citation text:label="*"/>' +
        '<text:note-body><text:p>Lead note.</text:p></text:note-body></text:note>Body text</text:p>',
      );
      // The heading marker stays on the heading's first line; a note that opens
      // its paragraph comes before the paragraph's own text.
      expect(text).toBe('## Scope\nDraft.\nand limits\nLead note.\nBody text');
    });

    it('writes a note that opens a heading or list item before its marker', async () => {
      // Document order: the note comes first, so the item's marker follows it.
      // In Markdown the note line then reads as part of the previous item.
      const text = await odtText(
        '<text:list>' +
        '<text:list-item><text:p>Prev</text:p></text:list-item>' +
        `<text:list-item><text:p>${footnote('1', 'Item note')}Item</text:p></text:list-item>` +
        '</text:list>' +
        `<text:h text:outline-level="2">${footnote('2', 'Heading note')}Title</text:h>`,
      );
      expect(text).toBe('- Prev\nItem note\n- Item\nHeading note\n## Title');
    });

    it('reads heading levels written with single quotes or spaces', async () => {
      expect(await odtText("<text:h text:outline-level='3'>Deep</text:h>")).toBe('### Deep');
      expect(await odtText('<text:h text:outline-level = "4">Spaced</text:h>')).toBe('#### Spaced');
    });

    it('drops comments but keeps the text between ranged comments', async () => {
      const text = await odtText(
        '<text:p>Deploy <office:annotation office:name="c1"><dc:creator>Ann</dc:creator>' +
        '<text:p>Which agent?</text:p></office:annotation>the agent' +
        '<office:annotation-end office:name="c1"/> after ' +
        '<office:annotation><dc:creator>Bob</dc:creator><text:p>Who reviews?</text:p></office:annotation>' +
        'review.</text:p>',
      );
      expect(text).toBe('Deploy the agent after review.');
    });

    it('drops an unclosed comment up to the end of its paragraph', async () => {
      // An empty comment is just an anchor. One that never closes loses its
      // content up to the end tag at its depth (here its paragraph's), and the
      // paragraphs after it are read as usual.
      const text = await odtText(
        '<text:p>A<office:annotation office:name="empty"/>B</text:p>' +
        '<text:p>Kept<office:annotation><dc:creator>Ann</dc:creator><text:p>never closed</text:p></text:p>' +
        '<text:p>Next</text:p>',
      );
      expect(text).toBe('AB\nKept\nNext');
    });

    it('reads a self-closing paragraph as an empty line', async () => {
      expect(await odtText('<text:p>One</text:p><text:p text:style-name="Empty"/><text:p>Two</text:p>'))
        .toBe('One\n\nTwo');
    });

    it('reads paragraphs placed directly in office:body', async () => {
      expect(await odtText('<text:p>Direct body text</text:p>', { officeText: false })).toBe('Direct body text');
    });

    it('never expands entities declared in a DTD', async () => {
      const doctype = '<!DOCTYPE office:document-content [' +
        '<!ENTITY lol "LOL"><!ENTITY xxe SYSTEM "file:///etc/passwd">]>';
      expect(await odtText('<text:p>&lol; &xxe; &amp; done</text:p>', { doctype })).toBe('&lol; &xxe; & done');
    });

    it('decodes each character reference once', async () => {
      // `&#38;` is "&", so `&#38;lt;b&#38;gt;` is the text `&lt;b&gt;`, not a tag.
      expect(await odtText('<text:p>&#38;lt;b&#38;gt; and &amp;lt;i&amp;gt; and &#x26;amp;</text:p>'))
        .toBe('&lt;b&gt; and &lt;i&gt; and &amp;');
    });

    it('replaces references to code points XML does not allow instead of failing', async () => {
      expect(await odtText('<text:p>a&#99999999;b&#xD800;c&#0;d&#x1F600;e&#233;</text:p>'))
        .toBe('a\uFFFDb\uFFFDc\uFFFDd\u{1F600}e\u00E9');
    });

    it('reads CDATA literally and skips comments, processing instructions and quoted >', async () => {
      expect(await odtText('<text:p text:style-name="a>b">a<![CDATA[<b> & c]]>d<!-- don\'t > -->e<?pi x?>f</text:p>'))
        .toBe('a<b> & cdef');
    });

    it.each([
      ['a tag cut short', '<text:p>Kept</text:p><text:p text:style-na', 'Kept'],
      ['a paragraph never closed', '<text:p>Kept</text:p><text:p>Cut off', 'Kept\nCut off'],
      ['a comment never closed', '<text:p>Kept</text:p><!-- never closed <text:p>Lost</text:p>', 'Kept'],
      ['an instruction never closed', '<text:p>Kept</text:p><?pi never closed <text:p>Lost</text:p>', 'Kept'],
      ['a CDATA section never closed', '<text:p>Kept</text:p><text:p>Cut<![CDATA[ lost', 'Kept\nCut'],
      ['an unbalanced quote', '<text:p>Kept</text:p><text:p text:style-name="P1>Still read</text:p>', 'Kept\nStill read'],
      ['a stray <', '<text:p>a < b</text:p><text:p>Next</text:p>', 'a < b\nNext'],
      ['stray end tags', '</x></y><text:p>a</text:p>', 'a'],
      ['a mismatched end tag', '<text:p>a<text:span>b</text:p><text:p>c</text:p>', 'ab\nc'],
      ['an input cut inside a quoted value holding >', '<text:p>Kept</text:p><text:p text:style-name="x>tail', 'Kept\ntail'],
      ['declarations inside a paragraph', '<text:p>a<!x>b</text:p>c<text:p>d<!y <text:span>e</text:span></text:p>', 'ab\nde'],
    ])('never fails on %s and keeps the text it can read', async (_shape, bodyXml, expected) => {
      // `closed: false` ends content.xml right after the body, as a cut-off entry does.
      expect(await odtText(bodyXml, { closed: false })).toBe(expected);
    });

    it('reads a tag with millions of attributes without failing', async () => {
      // 18 MB of attributes in one start tag; the noise entry keeps the archive
      // under the expansion-ratio cap so the bytes reach the reader.
      const odt = buildOdt(
        `<text:h ${'a="b" '.repeat(3_000_000)}text:outline-level="2">Title</text:h>`,
        { 'Pictures/noise.bin': incompressibleEntry(256 * 1024) },
      );
      expect((await extractDocumentText(odt, 'attributes.odt')).text).toBe('## Title');
    });

    it('tracks at most 64 open paragraphs, reading deeper ones into the innermost', async () => {
      const lines = (await odtText('<text:p>a'.repeat(10_000))).split('\n');
      // Each of the first 63 is ended by the next one opening; the 64th takes
      // the text of every paragraph opened inside it. Nothing is lost.
      expect(lines).toHaveLength(64);
      expect(lines.slice(0, 63)).toEqual(Array.from({ length: 63 }, () => 'a'));
      expect(lines[63]).toBe('a'.repeat(10_000 - 63));
    });

    it('reads unclosed markup in linear time', async () => {
      // 0.9 MB, under the ratio floor. Re-scanning to the end of the document
      // for every unclosed tag takes seconds here; one forward pass, milliseconds.
      const text = await odtText('<text:p>a'.repeat(100_000));
      expect(text.replaceAll('\n', '')).toBe('a'.repeat(100_000));
    }, 5_000);

    it('charges repeated spaces in separate and nested paragraphs to one budget', async () => {
      // Either run fits the limit alone; together they exceed it.
      const odt = buildOdt(
        '<text:p>A<text:s text:c="11000000"/></text:p>' +
        `<text:p>B${footnote('1', 'C<text:s text:c="11000000"/>')}</text:p>`,
      );
      await expectRejection(() => extractDocumentText(odt, 'spaces.odt'), 'unprocessable');
    });
  });

  it('rejects ODT repeated-space expansion beyond the combined document limit', async () => {
    const odt = buildOdt('<text:p>A<text:s text:c="11000000"/><text:s text:c="11000000"/>B</text:p>');
    await expectRejection(() => extractDocumentText(odt, 'spaces.odt'), 'unprocessable');
    const huge = buildOdt('<text:p>A<text:s text:c="999999999999999999999999"/>B</text:p>');
    await expectRejection(() => extractDocumentText(huge, 'spaces.odt'), 'unprocessable');
  });

  it('strips rtf control words down to the body text', async () => {
    const result = await extractDocumentText(buildRtf('Deploy on Monday.'), 'memo.rtf');

    expect(result.format).toBe('rtf');
    expect(result.text).toBe('Deploy on Monday.');
    // The font and colour tables must not leak into the text.
    expect(result.text).not.toContain('Calibri');
    expect(result.text).not.toContain('Riched20');
  });

  it('reads markdown, text and YAML through untouched', async () => {
    const markdown = '# Title\n\n- one\n- two\n';
    const md = await extractDocumentText(Buffer.from(markdown, 'utf8'), 'notes.md');
    expect(md).toEqual({ format: 'md', text: markdown });

    const plain = 'Line one.\nLine two.\n';
    const txt = await extractDocumentText(Buffer.from(plain, 'utf8'), 'notes.txt');
    expect(txt).toEqual({ format: 'txt', text: plain });

    const yaml = 'services:\n  - api\n';
    const yml = await extractDocumentText(Buffer.from(yaml, 'utf8'), 'config.yml');
    expect(yml).toEqual({ format: 'yaml', text: yaml });
  });

  it('rejects a text file carrying an embedded NUL', async () => {
    await expectRejection(
      () => extractDocumentText(Buffer.from('text\u0000binary', 'utf8'), 'notes.txt'),
      'mediaType',
    );
  });

  it('reports a corrupt PDF as unprocessable rather than unsupported', async () => {
    const corrupt = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), Buffer.from('garbage')]);
    const error = await expectRejection(
      () => extractDocumentText(corrupt, 'broken.pdf'),
      'unprocessable',
    );
    expect(error.message).toContain('Failed to extract text from PDF');
  });
});

// =============================================================================
// rtfToText
// =============================================================================

describe('rtfToText', () => {
  it('turns \\par into line breaks', () => {
    expect(rtfToText('{\\rtf1 First line.\\par Second line.}')).toBe('First line.\nSecond line.');
  });

  it('decodes escaped literals and unicode escapes', () => {
    expect(rtfToText("{\\rtf1 A \\{brace\\} pair, a \\\\ backslash and \\u233?.}"))
      .toBe('A {brace} pair, a \\ backslash and é.');
  });

  it('turns the non-breaking space control symbol into a space', () => {
    expect(rtfToText('{\\rtf1 Section\\~4 follows.}')).toBe('Section 4 follows.');
  });

  it('decodes \\\' hex bytes', () => {
    expect(rtfToText("{\\rtf1 caf\\'e9}")).toBe('café');
  });

  it('drops nested destination groups whole', () => {
    const rtf = '{\\rtf1{\\fonttbl{\\f0\\fnil Calibri;}{\\f1\\fnil Arial;}}Body text.}';
    expect(rtfToText(rtf)).toBe('Body text.');
  });

  it('emits a Word-style \\u character once, skipping its \\\' hex fallback (#1733)', () => {
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg1251\\uc1 \\u1055\\'cf\\u1088\\'f0}")).toBe('Пр');
  });

  it('decodes \\\'80 as the euro sign under \\ansicpg1252', () => {
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg1252 Price: 5\\'80}")).toBe('Price: 5€');
  });

  it('reads \\\' hex bytes as windows-1252 unless a supported \\ansicpg is in force', () => {
    // LibreOffice writes no \ansicpg at all.
    expect(rtfToText("{\\rtf1\\ansi \\'93quoted\\'94 \\'96 caf\\'e9}")).toBe('“quoted” – café');
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg99999 \\'80}")).toBe('€');
    // A code page applies from where it is declared.
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg1251 \\'cf\\ansicpg1252 \\'cf}")).toBe('ПÏ');
  });

  it.each([
    [866, "\\'8f", 'П'],
    [874, "\\'a1", 'ก'],
    // Double-byte pages: a trail byte may be escaped or written raw (`\'81B`).
    [932, "\\'82\\'a0\\'81B\\'83\\'5c", 'あ。ソ'],
    [936, "\\'c4\\'e3", '你'],
    [949, "\\'b0\\'a1", '가'],
    [950, "\\'a7A\\'a4\\'a4", '你中'],
    [1250, "\\'8a", 'Š'],
    [1251, "\\'cf", 'П'],
    [1252, "\\'80", '€'],
    [1253, "\\'c1", 'Α'],
    [1254, "\\'d0", 'Ğ'],
    [1255, "\\'e0", 'א'],
    [1256, "\\'c7", 'ا'],
    [1257, "\\'c0", 'Ą'],
    [1258, "\\'d5", 'Ơ'],
    [10000, "\\'8e", 'é'],
    [10007, "\\'8f", 'П'],
    [65001, "\\'c3\\'a9\\'e2\\'82\\'ac", 'é€'],
  ])('decodes \\ansicpg%i bytes', (codePage, bytes, expected) => {
    expect(rtfToText(`{\\rtf1\\ansi\\ansicpg${codePage} ${bytes}}`)).toBe(expected);
  });

  it('decodes \\ansicpg949 as Windows cp949, UHC syllables included', () => {
    // 됬 and 뷁 are in cp949's UHC extension; strict EUC-KR misreads them and
    // the characters after them.
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg949 \\'89\\'e7\\'b0\\'a1\\'b3\\'aa\\'b4\\'d9 \\'94\\'ee\\'b0\\'a1}"))
      .toBe('됬가나다 뷁가');
    // The first and last UHC syllables, and the two signs Windows added.
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg949 \\'81\\'41\\'c6\\'52\\'a2\\'e6\\'a2\\'e7}")).toBe('갂힣€®');
    // An unmapped pair is U+FFFD, and an ASCII trail byte is read again.
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg949 \\'c7\\'41\\'80x}")).toBe('\uFFFDA\uFFFDx');
  });

  it('keeps a double-byte character whole across a wrapped source line', () => {
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg932 \\'82\r\n\\'a0\\'81\r\nB}")).toBe('あ。');
  });

  it('falls back to windows-1252, then Latin-1, when TextDecoder lacks a code page', () => {
    const RealTextDecoder = globalThis.TextDecoder;
    class OnlyWindows1252 extends RealTextDecoder {
      constructor(...args: ConstructorParameters<typeof RealTextDecoder>) {
        if (args[0] !== 'windows-1252') throw new RangeError(`Unsupported encoding: ${String(args[0])}`);
        super(...args);
      }
    }
    class NoLegacyEncodings {
      constructor() {
        throw new RangeError('No legacy encodings in this build');
      }
    }
    const decodeWith = (decoder: unknown, rtf: string): string => {
      vi.stubGlobal('TextDecoder', decoder);
      try {
        return rtfToText(rtf);
      } finally {
        vi.unstubAllGlobals();
      }
    };

    expect(decodeWith(OnlyWindows1252, "{\\rtf1\\ansicpg1251 \\'cf\\'80}")).toBe('Ï€');
    expect(decodeWith(NoLegacyEncodings, "{\\rtf1\\ansicpg1251 caf\\'e9 \\'80}")).toBe('café \u0080');
  });

  it('skips \\uc fallback units, across a wrapped line, until a brace ends them', () => {
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg932\\uc2 \\u12354\\'82\\'a0\\u12356\\'82\\'a2}")).toBe('あい');
    expect(rtfToText('{\\rtf1\\uc3 \\u1055abcd}')).toBe('Пd');
    // A source line break is not a fallback unit.
    expect(rtfToText('{\\rtf1\\uc2 \\u1055\r\nabc}')).toBe('П\nc');
    expect(rtfToText('{\\rtf1\\uc2 {\\u1055}x}')).toBe('Пx');
  });

  it('skips no fallback under \\uc0', () => {
    // TextEdit's form: no fallback, so the trailing `?` is real text.
    expect(rtfToText('{\\rtf1\\ansi\\uc0\\u1055 \\u1088 ?}')).toBe('Пр?');
  });

  it('counts a formatting control word or a control symbol as one fallback unit', () => {
    expect(rtfToText('{\\rtf1\\ansi A\\u160\\~B}')).toBe('A\u00a0B');
    expect(rtfToText('{\\rtf1\\ansi A\\u1055\\b B}')).toBe('AПB');
  });

  it('ends a pending fallback at a control word the reader acts on', () => {
    // None of these can be an ANSI fallback, so a writer that left one out
    // keeps its next character, paragraph mark, tab or \uc change.
    expect(rtfToText("{\\rtf1 \\u1055\\u1088\\'f0}")).toBe('Пр');
    expect(rtfToText('{\\rtf1 \\u-10179\\u-8704?}')).toBe('😀');
    expect(rtfToText("{\\rtf1 \\u1055\\'cf\\par \\u1088\\par x\\u1080\\line y\\u1074\\tab z}"))
      .toBe('П\nр\nxи\nyв\tz');
    expect(rtfToText('{\\rtf1 \\u1055\\uc0\\u1088 x}')).toBe('Прx');
  });

  it('restores the enclosing \\uc count when a group closes', () => {
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg1251{\\uc0 \\u1055?}\\u1088\\'f0}")).toBe('П?р');
    expect(
      rtfToText("{\\rtf1\\ansi\\ansicpg1251{\\uc0 \\u1055?{\\uc2 \\u1088\\'f0\\'f0}\\u1080?}\\u1074\\'e2}"),
    ).toBe('П?ри?в');
    expect(rtfToText('{\\rtf1{\\uc0 \\u1055}\\u1088?}')).toBe('Пр');
  });

  it('reads negative \\u values as code points above 32767', () => {
    // LibreOffice's form for 한국어, with an escaped `?` fallback.
    expect(rtfToText("{\\rtf1\\ansi \\u-10916\\'3f\\u-21139\\'3f\\u-14924\\'3f}")).toBe('한국어');
  });

  it('joins a surrogate pair written as two \\u escapes', () => {
    // LibreOffice's form, then Word's.
    expect(rtfToText("{\\rtf1\\ansi Emoji \\uc0 \\u-10179\\uc1 \\u-8704\\'3f done}")).toBe('Emoji 😀 done');
    expect(rtfToText('{\\rtf1\\ansi \\u-10179?\\u-8704?}')).toBe('😀');
  });

  it('keeps decoded bytes and private-use characters as literal text', () => {
    expect(rtfToText("{\\rtf1\\ansi \\'5cpar \\'7bx\\'7d}")).toBe('\\par {x}');
    // rtfToText reads the file's bytes, one per character.
    expect(rtfToText(Buffer.from('{\\rtf1 a\uE000b}', 'utf8').toString('latin1'))).toBe('a\uE000b');
  });

  it('skips the bytes of a \\binN payload, braces included', () => {
    expect(rtfToText('{\\rtf1 Before{\\pict\\wmetafile8\\bin4 {{{{}After text.}')).toBe('BeforeAfter text.');
    // \binN and its data are one fallback unit.
    expect(rtfToText('{\\rtf1 \\u1055\\bin2 xyz}')).toBe('Пz');
    // A length past the end of the input stops there.
    expect(rtfToText('{\\rtf1 a\\bin99999999 bc')).toBe('a');
  });

  it('keeps text in order across many small output pieces', () => {
    // Two pieces per unit cross several output batches.
    expect(rtfToText(`{\\rtf1 ${'a\\~'.repeat(10_000)}}`)).toBe('a '.repeat(10_000).trim());
  });

  it('never throws on unbalanced braces or other malformed input', () => {
    expect(rtfToText("}}{\\rtf1\\ansi\\ansicpg1251 \\u1055\\'cf}}}\\u1088\\'f0{{{")).toBe('Пр');
    expect(rtfToText('{\\rtf1{\\uc0 }}}\\u1055?')).toBe('П');
    expect(rtfToText('{\\rtf1\\uc-1 \\u1055?}')).toBe('П?');
    // A huge \uc drops text only until its group ends.
    expect(rtfToText('{\\rtf1{\\uc99999999 \\u1055 eaten}kept}')).toBe('Пkept');
    // A lead byte without its trail decodes to U+FFFD.
    expect(rtfToText("{\\rtf1\\ansicpg932 \\'82}")).toBe('\uFFFD');
    expect(rtfToText("{\\rtf1\\ansicpg932 x\\'82")).toBe('x\uFFFD');
    expect(rtfToText('{\\rtf1 a\\constructor\\toString b\\')).toBe('ab');
    expect(rtfToText(`${'{'.repeat(100_000)}x${'}'.repeat(100_000)}`)).toBe('x');
  });

  it('drops a listed destination group whole, with everything nested inside it', () => {
    // Word nests \*\panose in each font and \*\picprop in each picture.
    expect(rtfToText('{\\rtf1{\\fonttbl{\\f0\\froman{\\*\\panose 02020603050405020304}Times New Roman;}}Body}'))
      .toBe('Body');
    expect(rtfToText(
      '{\\rtf1 Before{\\*\\shppict{\\pict{\\*\\picprop{\\sp{\\sn shapeType}{\\sv 75}}}\\pngblip 89504e47}} after}',
    )).toBe('Before after');
    // Escaped braces inside the group are text, not group boundaries.
    expect(rtfToText("{\\rtf1{\\info{\\title a\\}b\\'7dc\\{d}}Body}")).toBe('Body');
  });

  it('skips a destination group of any size without throwing', () => {
    const fonts = '{a}'.repeat(4_000_000);
    expect(rtfToText(`{\\rtf1{\\fonttbl${fonts}}Body}`)).toBe('Body');
    expect(rtfToText(`{\\rtf1{\\fonttbl${fonts}`)).toBe('');
  });

  it('extractDocumentText decodes a cp1251 Word document end to end (#1733)', async () => {
    const cyrillic = buildRtf("\\uc1\\u1055\\'cf\\u1088\\'f0\\'e8\\'e2\\'e5\\'f2", 1251);
    expect(await extractDocumentText(cyrillic, 'memo.rtf')).toEqual({ format: 'rtf', text: 'Привет' });
    expect((await extractDocumentText(buildRtf("Total: 5\\'80"), 'memo.rtf')).text).toBe('Total: 5€');
  });

  it('extractDocumentText skips raw \\bin bytes exactly and still reads raw UTF-8 text', async () => {
    // A binary payload with braces, a backslash and bytes that are not UTF-8.
    const payload = Buffer.from([0x7b, 0xff, 0x5c, 0x7d, 0xc3, 0x28, 0x7b, 0x80]);
    const rtf = Buffer.concat([
      Buffer.from('{\\rtf1\\ansi Before{\\pict\\pngblip\\bin8 ', 'latin1'),
      payload,
      Buffer.from('}After café 日本}', 'utf8'),
    ]);
    expect(await extractDocumentText(rtf, 'image.rtf')).toEqual({ format: 'rtf', text: 'BeforeAfter café 日本' });
  });
});

// =============================================================================
// Zip-bomb bounds
// =============================================================================

describe('zip decompression bounds', () => {
  it('rejects an archive with too many entries', async () => {
    const padding: Record<string, Uint8Array> = {};
    for (let i = 0; i <= ZIP_LIMITS.maxEntries; i += 1) {
      padding[`extra/${i}.bin`] = new Uint8Array([i % 256]);
    }
    const error = await expectRejection(
      () => extractDocumentText(buildDocx([{ text: 'Body.' }], padding), 'padded.docx'),
      'unprocessable',
    );
    expect(error.message).toContain('too many entries');
  });

  it('rejects an entry that would inflate past the per-entry cap', async () => {
    const bomb = buildDocx([{ text: 'Body.' }], {
      'word/media/bomb.bin': compressibleEntry(ZIP_LIMITS.maxEntryBytes + 1),
    });
    // The archive itself stays tiny — that is exactly the bomb's shape.
    expect(bomb.length).toBeLessThan(1024 * 1024);

    const error = await expectRejection(
      () => extractDocumentText(bomb, 'bomb.docx'),
      'unprocessable',
    );
    expect(error.message).toContain('decompression limit');
  });

  it('rejects an archive whose entries together exceed the total cap', async () => {
    const chunk = Math.floor(ZIP_LIMITS.maxEntryBytes / 2);
    const padding: Record<string, Uint8Array> = {};
    for (let i = 0; i < Math.ceil(ZIP_LIMITS.maxTotalBytes / chunk) + 1; i += 1) {
      padding[`word/media/pad-${i}.bin`] = compressibleEntry(chunk);
    }
    const error = await expectRejection(
      () => extractDocumentText(buildOdt('<text:p>Body.</text:p>', padding), 'bomb.odt'),
      'unprocessable',
    );
    expect(error.message).toContain('total decompression limit');
  });

  it('rejects an archive whose expansion ratio is implausible', async () => {
    // Under every absolute cap, but 15 MB out of a ~15 KB archive.
    const padding: Record<string, Uint8Array> = {};
    for (let i = 0; i < 10; i += 1) {
      padding[`word/media/pad-${i}.bin`] = compressibleEntry(1_500_000);
    }
    const bomb = buildDocx([{ text: 'Body.' }], padding);
    expect(bomb.length * ZIP_LIMITS.maxExpansionRatio).toBeLessThan(15_000_000);

    const error = await expectRejection(
      () => extractDocumentText(bomb, 'ratio.docx'),
      'unprocessable',
    );
    expect(error.message).toContain('compression ratio');
  });

  it('truncates entries that understate their size instead of inflating them', () => {
    // The caps read declared sizes, and this archive lies about every one of
    // them — so the caps pass and the real defence has to hold on its own.
    const forged = forgeUncompressedSizes(
      buildDocx([{ text: 'Body.' }], {
        'word/media/pad.bin': compressibleEntry(30 * 1024 * 1024),
      }),
      1024,
    );

    for (const content of Object.values(unzipWithinLimits(forged))) {
      expect(content.length).toBeLessThanOrEqual(1024);
    }
  });

  it('neutralises a forged-header docx without failing the extraction', async () => {
    const forged = forgeUncompressedSizes(
      buildDocx([{ text: 'Body text survives.' }], {
        'word/media/pad.bin': compressibleEntry(30 * 1024 * 1024),
      }),
      1024,
    );

    // The 30 MB payload is capped at the 1024 bytes it declared, and because
    // mammoth is handed a repack of those already-bounded bytes it never sees
    // the real stream. The parts that were honestly under the declared size are
    // untouched, so the document still extracts.
    const result = await extractDocumentText(forged, 'lying.docx');
    expect(result.text).toContain('Body text survives.');
  });

  it('lets an ordinary document through untouched by the bounds', async () => {
    const docx = buildDocx([{ text: 'Ordinary body text.' }], {
      // A "photo": incompressible, so the ratio stays near 1.
      'word/media/image1.bin': Uint8Array.from(
        { length: 300_000 },
        (_v, i) => (i * 2654435761) % 256,
      ),
    });
    const result = await extractDocumentText(docx, 'ordinary.docx');
    expect(result.text).toContain('Ordinary body text.');
  });
});

// =============================================================================
// buildPreview
// =============================================================================

describe('buildPreview', () => {
  it('returns short text unchanged', () => {
    expect(buildPreview('short')).toBe('short');
  });

  it('truncates long text and marks the cut', () => {
    const preview = buildPreview('A'.repeat(PREVIEW_LENGTH + 100));
    expect(preview).toHaveLength(PREVIEW_LENGTH + 3);
    expect(preview.endsWith('...')).toBe(true);
  });
});
