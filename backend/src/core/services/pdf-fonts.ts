import fontkit from '@pdf-lib/fontkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Color, PDFDocument, PDFFont, PDFPage } from 'pdf-lib';

/**
 * Article PDF fonts (#1729), vendored with their SIL OFL 1.1 licences by
 * tools/pdf-fonts/prepare.py (sources, versions and why each file is changed:
 * tools/pdf-fonts/README.md). tsc emits no assets: `npm run build -w backend`
 * copies this directory into dist, beside the compiled module.
 */
const FONT_DIR = join(import.meta.dirname, 'fonts');

type FontName =
  | 'NotoSans-Regular' | 'NotoSans-Bold' | 'NotoSans-Italic' | 'NotoSansMono-Regular'
  | 'NotoSansSC-Regular' | 'NotoSansKR-Regular';

interface FontFile { bytes: Uint8Array; coverage: Set<number> }

/**
 * Each font file's bytes and covered code points, read once per process.
 * Never a parsed font: pdf-lib parses its own per document, because a fontkit
 * font shared between documents corrupts their ToUnicode maps.
 */
const files = new Map<string, FontFile>();

function fontFile(dir: string, name: FontName): FontFile {
  const path = join(dir, `${name}.ttf`);
  let file = files.get(path);
  if (!file) {
    if (!existsSync(path)) {
      throw new Error(`PDF export font missing: ${path} (npm run build -w backend copies src/core/services/fonts into dist)`);
    }
    const bytes = readFileSync(path);
    file = { bytes, coverage: new Set(fontkit.create(bytes).characterSet) };
    files.set(path, file);
  }
  return file;
}

interface Face { font: PDFFont; coverage: Set<number> }

/** What draws one code point: the face, the text it draws, its advance in 1/1000 em; null for an invisible one. */
interface Glyph { font: PDFFont; text: string; units: number }

/** Per embedded style font: the faces that may draw a code point, in order, and the code points resolved so far. */
const styles = new WeakMap<PDFFont, { chain: Face[]; glyphs: Map<string, Glyph | null> }>();

/** Drawn for a code point no bundled font covers. */
const PLACEHOLDER = '\uFFFD';

/**
 * Code points with no visible form: controls, line and paragraph separators,
 * and default-ignorables (ZWSP, ZWJ, soft hyphen, variation selectors, BOM).
 * They draw as nothing; pdf-lib would turn some into spaces or line breaks.
 */
const INVISIBLE = /^[\p{Cc}\p{Default_Ignorable_Code_Point}\u2028\u2029]$/u;

export interface PdfFonts { font: PDFFont; fontBold: PDFFont; fontItalic: PDFFont; fontMono: PDFFont }

/**
 * Embeds the four text faces, each subset to the glyphs drawn, and Noto Sans
 * SC and KR only when a character of `text` (everything the document will
 * draw) needs them. A face falls back, per code point, to Noto Sans Mono (the
 * sans faces) or Noto Sans Regular (mono), then SC, then KR; a code point none
 * of them covers is drawn as U+FFFD in the face itself. A missing font file
 * fails the export. `fontDir` (the vendored fonts by default) is a test seam.
 */
export async function embedFonts(doc: PDFDocument, text: string, fontDir = FONT_DIR): Promise<PdfFonts> {
  doc.registerFontkit(fontkit);
  const embed = async (name: FontName): Promise<Face> => {
    const { bytes, coverage } = fontFile(fontDir, name);
    return { font: await doc.embedFont(bytes, { subset: true }), coverage };
  };
  const regular = await embed('NotoSans-Regular');
  const bold = await embed('NotoSans-Bold');
  const italic = await embed('NotoSans-Italic');
  const mono = await embed('NotoSansMono-Regular');
  // A code point reaches SC or KR only when Mono lacks it and so does a sans face.
  let needsSc = false;
  let needsKr = false;
  for (const char of new Set(text)) {
    const cp = char.codePointAt(0)!;
    if (mono.coverage.has(cp) || [regular, bold, italic].every((face) => face.coverage.has(cp))) continue;
    if (fontFile(fontDir, 'NotoSansSC-Regular').coverage.has(cp)) needsSc = true;
    else if (fontFile(fontDir, 'NotoSansKR-Regular').coverage.has(cp)) needsKr = true;
  }
  const cjk = [
    ...(needsSc ? [await embed('NotoSansSC-Regular')] : []),
    ...(needsKr ? [await embed('NotoSansKR-Regular')] : []),
  ];
  styles.set(regular.font, { chain: [regular, mono, ...cjk], glyphs: new Map() });
  styles.set(bold.font, { chain: [bold, mono, ...cjk], glyphs: new Map() });
  styles.set(italic.font, { chain: [italic, mono, ...cjk], glyphs: new Map() });
  styles.set(mono.font, { chain: [mono, regular, ...cjk], glyphs: new Map() });
  return { font: regular.font, fontBold: bold.font, fontItalic: italic.font, fontMono: mono.font };
}

/**
 * Text as the renderer lays it out: composed (NFC), so decomposed accents and
 * conjoining Hangul jamo become the precomposed glyphs the fonts have (pdf-lib
 * positions no marks); a tab is four spaces; a line or paragraph break is a
 * space, as in HTML, so words split only by a newline stay two words. Wrap and
 * measure after this.
 */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\t/g, '    ').replace(/[\n\v\f\r\u0085\u2028\u2029]/g, ' ');
}

function glyphFor(char: string, font: PDFFont): Glyph | null {
  const style = styles.get(font);
  if (!style) throw new Error('pdf-fonts: the font was not embedded by embedFonts');
  let glyph = style.glyphs.get(char);
  if (glyph === undefined) {
    if (INVISIBLE.test(char)) {
      glyph = null;
    } else {
      const cp = char.codePointAt(0)!;
      const face = style.chain.find((f) => f.coverage.has(cp));
      // Each text face has U+FFFD, so the style's own face draws the placeholder.
      const drawnBy = face ?? style.chain[0]!;
      const text = face ? char : PLACEHOLDER;
      glyph = { font: drawnBy.font, text, units: drawnBy.font.widthOfTextAtSize(text, 1000) };
    }
    style.glyphs.set(char, glyph);
  }
  return glyph;
}

/**
 * The width `drawText` advances: each code point's advance in the face that
 * draws it, summed, times fontSize / 1000. pdf-lib draws no kerning and the
 * vendored fonts substitute no glyphs, so widths add up: a line is as wide as
 * its words and spaces. Never throws for a font from embedFonts.
 */
export function measureText(text: string, font: PDFFont, fontSize: number): number {
  let units = 0;
  for (const char of text) units += glyphFor(char, font)?.units ?? 0;
  return units * (fontSize / 1000);
}

export interface DrawTextOptions { x: number; y: number; size: number; font: PDFFont; color: Color }

/**
 * Draws `text` from x as runs of consecutive code points that share a face,
 * each run starting where the last ended, so the line is as wide as
 * `measureText` says.
 */
export function drawText(page: PDFPage, text: string, options: DrawTextOptions): void {
  let x = options.x;
  let run = '';
  let runFont: PDFFont | undefined;
  let runUnits = 0;
  const flush = (): void => {
    if (!run || !runFont) return;
    page.drawText(run, { ...options, x, font: runFont });
    x += runUnits * (options.size / 1000);
    run = '';
    runUnits = 0;
  };
  for (const char of text) {
    const glyph = glyphFor(char, options.font);
    if (!glyph) continue;
    if (glyph.font !== runFont) {
      flush();
      runFont = glyph.font;
    }
    run += glyph.text;
    runUnits += glyph.units;
  }
  flush();
}
