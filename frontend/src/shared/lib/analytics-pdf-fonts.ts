import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import coverage from './analytics-font-coverage.json';
import { normalized, type ReportText } from './analytics-pdf-text';

type Face = keyof typeof coverage;
const SC = 'NotoSansSC-Regular';
const KR = 'NotoSansKR-Regular';
const SHARD = 'NotoSansSC-Regular-nonCJK';
const files = new Map<Face, Promise<ArrayBuffer>>();

function covers(face: Face, cp: number): boolean {
  const { ranges } = coverage[face];
  let low = 0, high = ranges.length / 2;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (cp < ranges[2 * mid]!) high = mid;
    else if (cp > ranges[2 * mid + 1]!) low = mid + 1;
    else return true;
  }
  return false;
}

function load(face: Face): Promise<ArrayBuffer> {
  const cached = files.get(face);
  if (cached) return cached;
  const pending = (async () => {
    // nginx serves TTFs as immutable. A new preparation must get a new cache key.
    const response = await fetch(`/fonts/pdf/${face}.ttf?v=${coverage[face].sha256}`, { mode: 'same-origin' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    // Also catches a misconfigured static host returning its index.html (200).
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (Array.from(digest, n => n.toString(16).padStart(2, '0')).join('') !== coverage[face].sha256) {
      throw new Error('unexpected font file');
    }
    return bytes;
  })().catch((cause: unknown) => {
    files.delete(face);
    throw new Error(`Could not load PDF font ${face}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  });
  files.set(face, pending);
  return pending;
}

/** Only the immutable download is shared. Each document owns its subsets and ToUnicode maps. */
export async function unicodeText(doc: PDFDocument, styles: [PDFFont, PDFFont], missing: Set<number>[]): Promise<ReportText> {
  const needed = new Set<Face>();
  const selections = missing.map((points, index) => {
    const primary = index ? 'NotoSans-Bold' : 'NotoSans-Regular';
    const selected = new Map<number, Face | null>();
    for (const cp of points) {
      // Whitespace was normalized before preflight. Remaining control/format
      // characters (e.g. NUL, bidi overrides and joiners) have no drawable
      // representation here, even when a Noto cmap assigns them a glyph.
      if (/[\p{Cc}\p{Cf}]/u.test(String.fromCodePoint(cp))) {
        selected.set(cp, null);
        continue;
      }
      const face = covers(primary, cp) ? primary : covers(SHARD, cp) ? SHARD
        : covers(SC, cp) ? SC : covers(KR, cp) ? KR : null;
      selected.set(cp, face);
      if (face) needed.add(face);
    }
    return selected;
  });
  if (needed.has(SC)) needed.delete(SHARD); // The full face already includes its shard.
  doc.registerFontkit(fontkit);
  const embedded = new Map<Face, PDFFont>(await Promise.all([...needed].map(async face =>
    [face, await doc.embedFont(await load(face), { subset: true })] as const)));

  type Glyph = { face: PDFFont; text: string; advance: number };
  const glyphs = styles.map(() => new Map<string, Glyph>());
  function glyph(ch: string, font: PDFFont): Glyph {
    const i = font === styles[1] ? 1 : 0;
    let g = glyphs[i]!.get(ch);
    if (!g) {
      const selection = selections[i]!.get(ch.codePointAt(0)!);
      const face = selection ? embedded.get(selection === SHARD && needed.has(SC) ? SC : selection)! : font;
      const text = selection === null ? '?' : ch;
      // Single-glyph advances, including Helvetica: pdf-lib emits Tj with no kerning offsets.
      g = { face, text, advance: face.widthOfTextAtSize(text, 1000) };
      glyphs[i]!.set(ch, g);
    }
    return g;
  }

  let replaced = false;
  return {
    get replaced() { return replaced; },
    width(font, value, size) {
      let units = 0;
      for (const ch of normalized(value)) units += glyph(ch, font).advance;
      return units * size / 1000;
    },
    draw(page, value, opts, maxWidth) {
      let text = normalized(value);
      if (maxWidth !== undefined) {
        // Track the last prefix that leaves room for an ellipsis, without splitting surrogate pairs.
        const limit = maxWidth * 1000 / opts.size, ellipsis = glyph('…', opts.font).advance;
        let width = 0, end = 0, fits = 0;
        for (const ch of text) {
          width += glyph(ch, opts.font).advance;
          end += ch.length;
          if (width + ellipsis <= limit) fits = end;
          if (width > limit) { text = ellipsis <= limit ? text.slice(0, fits) + '…' : ''; break; }
        }
      }
      let run = '', units = 0, x = opts.x, face = opts.font;
      const flush = () => {
        if (run) page.drawText(run, { ...opts, x, font: face });
        x += units * opts.size / 1000;
        run = ''; units = 0;
      };
      for (const ch of text) {
        const g = glyph(ch, opts.font);
        if (face !== g.face) { flush(); face = g.face; }
        run += g.text; units += g.advance;
        if (g.text !== ch) replaced = true;
      }
      flush();
    },
  };
}
