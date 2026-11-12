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

  it('decodes \\ansicpg949 only as far as Node\'s strict EUC-KR reaches', () => {
    // A KS X 1001 syllable decodes; one from cp949's UHC extension (힣) does
    // not. This pins the documented limit, so a runtime that gains UHC shows up.
    expect(rtfToText("{\\rtf1\\ansi\\ansicpg949 \\'b0\\'a1 \\'c6\\'52}")).toBe('가 \uFFFDR');
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
    expect(rtfToText('{\\rtf1 a\uE000b}')).toBe('a\uE000b');
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
