import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { getDocumentProxy } from 'unpdf';
import { drawText, embedFonts, measureText, normalizeText } from './pdf-fonts.js';

const FONT_DIR = join(import.meta.dirname, 'fonts');

describe('pdf-fonts (#1729)', () => {
  it('lays out text composed, a tab as four spaces and a line or paragraph break as a space', () => {
    expect(normalizeText('a\tb\nc\r\nd\fe\vf\u0085g\u2028h\u2029i')).toBe('a    b c  d e f g h i');
    // NFC: decomposed Latin (macOS) and conjoining jamo become the precomposed characters the fonts draw.
    expect(normalizeText('e\u0301 \u1112\u1161\u11AB')).toBe('é 한');
    // Everything else is left for drawing: invisible characters draw as nothing, the rest as glyphs.
    expect(normalizeText('Установка 手順 \u00A0\u200B\u00AD😀')).toBe('Установка 手順 \u00A0\u200B\u00AD😀');
  });

  it('measures every face and fallback as wide as pdf.js reports it drawn', async () => {
    const doc = await PDFDocument.create();
    const line = 'AVA office fi Установка 手順 한국어 → ✓ ع 😀';
    const fonts = await embedFonts(doc, line);
    const page = doc.addPage([595.28, 841.89]);
    const faces = [fonts.font, fonts.fontBold, fonts.fontItalic, fonts.fontMono];
    faces.forEach((font, i) => drawText(page, line, { x: 50, y: 700 - 40 * i, size: 11, font, color: rgb(0, 0, 0) }));
    const pdf = await getDocumentProxy(await doc.save());
    const items = (await (await pdf.getPage(1)).getTextContent()).items.filter((item) => 'str' in item && item.str);
    faces.forEach((font, i) => {
      // The line's runs end where measureText says the line ends.
      const onLine = items.filter((item) => 'str' in item && Math.round(item.transform[5] as number) === 700 - 40 * i);
      const end = Math.max(...onLine.map((item) => (item.transform[4] as number) + ('width' in item ? item.width : 0)));
      expect(end, `face ${i}`).toBeCloseTo(50 + measureText(line, font, 11), 2);
    });
  });

  it('vendors six prepared Noto faces: no OpenType layout tables, even glyph records, OFL licences', () => {
    const files = existsSync(FONT_DIR) ? readdirSync(FONT_DIR).sort() : [];
    expect(files).toEqual([
      'NotoSans-Bold.ttf', 'NotoSans-Italic.ttf', 'NotoSans-Regular.ttf', 'NotoSansKR-Regular.ttf',
      'NotoSansMono-Regular.ttf', 'NotoSansSC-Regular.ttf', 'OFL-NotoSans.txt', 'OFL-NotoSansCJK.txt',
    ]);
    for (const file of files.filter((name) => name.endsWith('.ttf'))) {
      const bytes = readFileSync(join(FONT_DIR, file));
      const font = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const tables = new Map<string, number>();
      for (let i = 0; i < font.getUint16(4); i++) {
        const record = 12 + 16 * i;
        const tag = String.fromCharCode(...[0, 1, 2, 3].map((k) => font.getUint8(record + k)));
        tables.set(tag, font.getUint32(record + 8));
      }
      // tools/pdf-fonts/prepare.py: pdf-lib applies no positioning, and substitutions would make
      // the drawn width differ from the measured one, so the layout tables are dropped …
      expect(['GSUB', 'GPOS', 'GDEF'].filter((tag) => tables.has(tag)), file).toEqual([]);
      // … and @pdf-lib/fontkit 1.1.1 misreads subsets whose glyph records have odd lengths.
      const longOffsets = font.getInt16(tables.get('head')! + 50) === 1;
      const glyphCount = font.getUint16(tables.get('maxp')! + 4);
      const loca = tables.get('loca')!;
      const offsets = Array.from({ length: glyphCount + 1 }, (_, g) =>
        longOffsets ? font.getUint32(loca + 4 * g) : 2 * font.getUint16(loca + 2 * g));
      expect(offsets.filter((offset) => offset % 2), file).toEqual([]);
    }
  });

  it('fails every export with a clear error when a font file is missing', async () => {
    // A runtime image built without `npm run build -w backend` has no dist/core/services/fonts:
    // exports must fail loudly instead of falling back to deleting text.
    await expect(embedFonts(await PDFDocument.create(), 'x', '/nonexistent/fonts')).rejects.toThrow(
      'PDF export font missing: /nonexistent/fonts/NotoSans-Regular.ttf',
    );
  });
});
