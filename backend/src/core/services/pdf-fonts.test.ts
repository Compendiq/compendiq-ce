import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FONT_DIR = join(import.meta.dirname, 'fonts');

describe('pdf-fonts (#1729)', () => {
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
});
