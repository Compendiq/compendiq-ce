import fontkit from '@pdf-lib/fontkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Color, PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import { FALLBACK_RANGES } from './pdf-fallback-ranges.js';

/**
 * Article PDF fonts (#1729), vendored with their SIL OFL 1.1 licences by
 * tools/pdf-fonts/prepare.py (sources, versions and why each file is changed:
 * tools/pdf-fonts/README.md). tsc emits no assets: `npm run build -w backend`
 * copies this directory into dist, beside the compiled module.
 */
const FONT_DIR = join(import.meta.dirname, 'fonts');

type FontName =
  | 'NotoSans-Regular' | 'NotoSans-Bold' | 'NotoSans-Italic' | 'NotoSansMono-Regular'
  | (typeof FALLBACK_RANGES)[number][0];

interface FontFile { bytes: Uint8Array; covers: (char: string) => boolean }

/**
 * Each font file's bytes and covered code points, read once per process.
 * Never a parsed font: pdf-lib parses its own per document, because a fontkit
 * font shared between documents corrupts their ToUnicode maps.
 */
const files = new Map<string, FontFile>();

function fontFile(dir: string, name: FontName, fallbackCoverage?: RegExp): FontFile {
  const path = join(dir, `${name}.ttf`);
  let file = files.get(path);
  if (!file) {
    if (!existsSync(path)) {
      throw new Error(`PDF export font missing: ${path} (npm run build -w backend copies src/core/services/fonts into dist)`);
    }
    const bytes = readFileSync(path);
    if (fallbackCoverage) {
      file = { bytes, covers: (char) => fallbackCoverage.test(char) };
    } else {
      const coverage = new Set(fontkit.create(bytes).characterSet);
      file = { bytes, covers: (char) => coverage.has(char.codePointAt(0)!) };
    }
    files.set(path, file);
  }
  return file;
}

interface Face { font: PDFFont; covers: (char: string) => boolean }

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
const INVISIBLE = /[\p{Cc}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;

// The prepared cmaps exclude everything guaranteed by an earlier face. The
// same predicate selects a file and its drawn glyphs: seeing ✔ elsewhere in
// the article must not make a deferred emoji start printing in Symbols 2.
const optionalFonts = FALLBACK_RANGES.map(([name, ranges]) => {
  const cjk = name === 'NotoSansSC-Regular' || name === 'NotoSansKR-Regular';
  const excluded = cjk ? INVISIBLE.source : `[${INVISIBLE.source}\\p{Emoji_Presentation}]`;
  return { name, coverage: new RegExp(`[[${ranges}]--${excluded}]`, 'v') };
});

export interface PdfFonts { font: PDFFont; fontBold: PDFFont; fontItalic: PDFFont; fontMono: PDFFont }

/**
 * Embeds the four text faces; additional subsets follow only when the text
 * needs them. Missing required files fail the export. `fontDir` is a test seam.
 */
export async function embedFonts(doc: PDFDocument, text: string, fontDir = FONT_DIR): Promise<PdfFonts> {
  doc.registerFontkit(fontkit);
  const embed = async (name: FontName, coverage?: RegExp): Promise<Face> => {
    const { bytes, covers } = fontFile(fontDir, name, coverage);
    return { font: await doc.embedFont(bytes, { subset: true }), covers };
  };
  const regular = await embed('NotoSans-Regular');
  const bold = await embed('NotoSans-Bold');
  const italic = await embed('NotoSans-Italic');
  const mono = await embed('NotoSansMono-Regular');
  const normalized = text.normalize('NFC');
  const fallback: Face[] = [];
  for (const { name, coverage } of optionalFonts) {
    if (coverage.test(normalized)) fallback.push(await embed(name, coverage));
  }
  styles.set(regular.font, { chain: [regular, mono, ...fallback], glyphs: new Map() });
  styles.set(bold.font, { chain: [bold, mono, ...fallback], glyphs: new Map() });
  styles.set(italic.font, { chain: [italic, mono, ...fallback], glyphs: new Map() });
  styles.set(mono.font, { chain: [mono, regular, ...fallback], glyphs: new Map() });
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
      const face = style.chain.find((f) => f.covers(char));
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
