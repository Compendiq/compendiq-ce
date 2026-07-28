import { describe, it, expect } from 'vitest';
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
 * Nothing here is mocked. Every fixture is real bytes, so `unpdf`, `mammoth`
 * and `fflate` all run for real — a sniffing or zip-bomb assertion against a
 * mocked extractor would prove nothing.
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

  it('strips rtf control words down to the body text', async () => {
    const result = await extractDocumentText(buildRtf('Deploy on Monday.'), 'memo.rtf');

    expect(result.format).toBe('rtf');
    expect(result.text).toBe('Deploy on Monday.');
    // The font and colour tables must not leak into the text.
    expect(result.text).not.toContain('Calibri');
    expect(result.text).not.toContain('Riched20');
  });

  it('reads md and txt through untouched', async () => {
    const markdown = '# Title\n\n- one\n- two\n';
    const md = await extractDocumentText(Buffer.from(markdown, 'utf8'), 'notes.md');
    expect(md).toEqual({ format: 'md', text: markdown });

    const plain = 'Line one.\nLine two.\n';
    const txt = await extractDocumentText(Buffer.from(plain, 'utf8'), 'notes.txt');
    expect(txt).toEqual({ format: 'txt', text: plain });
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
