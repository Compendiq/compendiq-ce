import mammoth from 'mammoth';
import { unzipSync, zipSync, strFromU8, type Unzipped, type Zippable } from 'fflate';
import { getDocumentProxy, extractText } from 'unpdf';
import { SUPPORTED_DOCUMENT_FORMATS, type DocumentFormat } from '@compendiq/contracts';
import { htmlToMarkdown } from './content-converter.js';

/**
 * Shared multi-format document text extraction (#1131 / #1132).
 *
 * Consumed by `routes/llm/extract-document.ts` today; the AI-Improve and
 * AI-Generate upload zones both reach it through that one route, so the
 * per-format rules live here rather than in the handler.
 *
 * Two rules govern everything below:
 *
 * 1. **The bytes decide the format, never the client.** `Content-Type` and the
 *    filename extension are both attacker-controlled. The extension is used
 *    only to state what the caller *claims* (and to separate `md` from `txt`,
 *    which are byte-identical); the sniffer decides what the file *is*, and a
 *    disagreement is rejected rather than resolved in the caller's favour.
 * 2. **Nothing unbounded gets decompressed.** `docx` and `odt` are zip
 *    containers, so the archive is measured against explicit caps and then
 *    inflated through fixed-size buffers before any library touches it.
 */

/** Preview excerpt length used by the route. */
export const PREVIEW_LENGTH = 500;

// ---------------------------------------------------------------------------
// Zip-bomb bounds (docx + odt)
// ---------------------------------------------------------------------------

/**
 * Caps applied to every zip container before a single byte is inflated.
 *
 * The uploaded archive is already capped at 20 MB by the route's multipart
 * limit; these bound what that 20 MB is allowed to *become*. A legitimate 20 MB
 * .docx is mostly already-compressed images (expansion around 1x) with small
 * XML parts, so it lands far inside every limit — the caps only bite on
 * archives engineered to expand.
 */
export const ZIP_LIMITS = {
  /** Entries in the archive. Office packages carry tens; 512 is generous. */
  maxEntries: 512,
  /** Uncompressed bytes for any single entry — same as the upload cap. */
  maxEntryBytes: 20 * 1024 * 1024,
  /** Uncompressed bytes across all entries — 2x the upload cap. */
  maxTotalBytes: 40 * 1024 * 1024,
  /**
   * Total-uncompressed divided by archive-size. XML compresses roughly 20-50x,
   * so 200x sits well above anything legitimate and well below a 1000x+ bomb.
   */
  maxExpansionRatio: 200,
  /**
   * The ratio check is skipped below this size. Small archives have a large
   * fixed-overhead ratio that says nothing about intent, and a 1 MB expansion
   * cannot exhaust anything.
   */
  ratioFloorBytes: 1024 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `mediaType` maps to HTTP 415 (we refuse to treat these bytes as this format),
 * `unprocessable` to HTTP 422 (the format was right, the content was not
 * usable). The route does that mapping; this module stays transport-agnostic
 * so the extractor can be reused off a route.
 */
export type DocumentExtractionErrorKind = 'mediaType' | 'unprocessable';

export class DocumentExtractionError extends Error {
  readonly kind: DocumentExtractionErrorKind;

  constructor(kind: DocumentExtractionErrorKind, message: string) {
    super(message);
    this.name = 'DocumentExtractionError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Format sniffing
// ---------------------------------------------------------------------------

/**
 * What the *bytes* look like. `text` is deliberately coarse: text-based
 * formats such as `.md`, `.txt` and `.yaml` are the same bytes, so only the
 * claimed extension can separate them.
 */
export type SniffedFormat = 'pdf' | 'docx' | 'odt' | 'rtf' | 'text';

/** `%PDF-` */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
/** `PK\x03\x04` — local file header of a non-empty zip. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** `{\rtf` */
const RTF_MAGIC = Buffer.from('{\\rtf', 'ascii');

/** The one entry whose presence makes a zip a Word document. */
const DOCX_MARKER_ENTRY = 'word/document.xml';
/** ODF stores its type in an uncompressed `mimetype` entry, by spec. */
const ODT_MIMETYPE_ENTRY = 'mimetype';
const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text';

const EXTENSION_TO_FORMAT: Record<string, DocumentFormat> = {
  pdf: 'pdf',
  docx: 'docx',
  md: 'md',
  markdown: 'md',
  txt: 'txt',
  text: 'txt',
  rtf: 'rtf',
  odt: 'odt',
  yml: 'yaml',
  yaml: 'yaml',
};

/**
 * The format the caller *claims*, taken from the filename extension. Returns
 * `null` for anything outside the supported formats — including a bare filename
 * with no extension, which we refuse rather than guess at.
 */
export function claimedFormatFromFilename(filename: string | undefined): DocumentFormat | null {
  if (!filename) return null;
  const match = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  if (!match?.[1]) return null;
  return EXTENSION_TO_FORMAT[match[1].toLowerCase()] ?? null;
}

/** Human-readable list for error messages, e.g. `PDF, DOCX, MD, TXT, RTF, ODT, YAML`. */
const SUPPORTED_FORMATS_LABEL = SUPPORTED_DOCUMENT_FORMATS
  .map((format) => format.toUpperCase())
  .join(', ');

function startsWith(buffer: Buffer, magic: Buffer): boolean {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

/**
 * True when the buffer decodes as UTF-8 without loss and carries no NUL byte.
 *
 * The NUL check is the load-bearing half: it is what stops arbitrary binary
 * (an image, an ELF, a truncated archive) from being waved through as "text".
 */
function looksLikeUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0x00)) return false;
  // Node substitutes U+FFFD for invalid sequences, so a faithful round-trip
  // back to the original byte length means the input really was UTF-8.
  return Buffer.byteLength(buffer.toString('utf8'), 'utf8') === buffer.length;
}

/**
 * Classifies a buffer by content alone. Returns `null` when the bytes match
 * none of the supported families.
 */
export function sniffDocumentFormat(buffer: Buffer): SniffedFormat | null {
  if (startsWith(buffer, PDF_MAGIC)) return 'pdf';

  if (startsWith(buffer, ZIP_MAGIC)) {
    // A zip alone is not a format. Look inside for the marker that names it.
    const entries = readZipManifest(buffer);
    if (entries === null) return null;
    if (entries.some((entry) => entry.name === DOCX_MARKER_ENTRY)) return 'docx';
    if (isOdtPackage(buffer, entries)) return 'odt';
    return null;
  }

  // RTF is checked before the generic text test: `{\rtf` is also valid UTF-8,
  // and the more specific answer is the right one.
  if (startsWith(buffer, RTF_MAGIC)) return 'rtf';

  if (buffer.length > 0 && looksLikeUtf8Text(buffer)) return 'text';

  return null;
}

/**
 * Resolves the format to extract with, rejecting any disagreement between what
 * the caller claimed and what the bytes are.
 *
 * text-based formats are interchangeable at the byte level: plain-text bytes
 * satisfy an `md`, `txt` or `yaml` claim, but a `.txt` claim over RTF or zip
 * bytes is still a
 * mismatch. Renaming a `.pdf` to `.docx` — the exact evasion the old PDF-only
 * route already guarded against — lands here as a 415.
 */
export function resolveDocumentFormat(buffer: Buffer, filename: string | undefined): DocumentFormat {
  const claimed = claimedFormatFromFilename(filename);
  if (claimed === null) {
    throw new DocumentExtractionError(
      'mediaType',
      `Unsupported file type. Supported formats: ${SUPPORTED_FORMATS_LABEL}`,
    );
  }

  const sniffed = sniffDocumentFormat(buffer);
  const mismatch = new DocumentExtractionError(
    'mediaType',
    `File is not a valid ${claimed.toUpperCase()}`,
  );

  if (sniffed === null) throw mismatch;

  if (sniffed === 'text') {
    if (claimed !== 'md' && claimed !== 'txt' && claimed !== 'yaml') throw mismatch;
    return claimed;
  }

  if (sniffed !== claimed) throw mismatch;
  return claimed;
}

// ---------------------------------------------------------------------------
// Zip handling
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  /** Compressed size, from the archive's own directory. */
  size: number;
  /** Uncompressed size the archive *declares*. Attacker-controlled. */
  originalSize: number;
  compression: number;
}

/**
 * Lists the archive's entries without inflating any of them — fflate invokes
 * the filter for every entry and only decompresses the ones it approves, so
 * returning `false` throughout yields a manifest for free.
 *
 * Returns `null` when the bytes are not a readable zip.
 */
function readZipManifest(buffer: Buffer): ZipEntry[] | null {
  const entries: ZipEntry[] = [];
  try {
    unzipSync(new Uint8Array(buffer), {
      filter: (file) => {
        entries.push({
          name: file.name,
          size: file.size,
          originalSize: file.originalSize,
          compression: file.compression,
        });
        return false;
      },
    });
  } catch {
    return null;
  }
  return entries;
}

/** ODF packages declare their type in a `mimetype` entry (ODF 1.3 section 3.3). */
function isOdtPackage(buffer: Buffer, entries: ZipEntry[]): boolean {
  const entry = entries.find((candidate) => candidate.name === ODT_MIMETYPE_ENTRY);
  // The declared length is a cheap pre-filter: the real value is a fixed 39
  // bytes, so anything larger cannot be it and need not be inflated.
  if (!entry || entry.originalSize > 256) return false;
  const extracted = extractZipEntry(buffer, ODT_MIMETYPE_ENTRY);
  return extracted !== null && strFromU8(extracted).trim() === ODT_MIMETYPE;
}

/** Inflates exactly one entry, or `null` if it is absent or undecodable. */
function extractZipEntry(buffer: Buffer, name: string): Uint8Array | null {
  try {
    const out = unzipSync(new Uint8Array(buffer), { filter: (file) => file.name === name });
    return out[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * Decompresses a zip container within {@link ZIP_LIMITS}, returning its entries.
 *
 * The manifest sizes checked first come from the archive itself, so a bomb can
 * understate them. What makes the bound real is fflate's behaviour on the second
 * pass: it sizes each output buffer from the declared length and never grows it,
 * so an entry that lies about its size comes back truncated to the lie rather
 * than ballooning. Peak memory is therefore capped by the declared totals we
 * just validated, whatever the archive actually contains.
 */
export function unzipWithinLimits(buffer: Buffer): Unzipped {
  const entries = readZipManifest(buffer);
  if (entries === null) {
    throw new DocumentExtractionError('unprocessable', 'File is not a readable archive');
  }

  if (entries.length > ZIP_LIMITS.maxEntries) {
    throw new DocumentExtractionError(
      'unprocessable',
      `Archive has too many entries (limit ${ZIP_LIMITS.maxEntries})`,
    );
  }

  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.originalSize > ZIP_LIMITS.maxEntryBytes) {
      throw new DocumentExtractionError(
        'unprocessable',
        'Archive contains an entry that exceeds the decompression limit',
      );
    }
    declaredTotal += entry.originalSize;
  }

  if (declaredTotal > ZIP_LIMITS.maxTotalBytes) {
    throw new DocumentExtractionError(
      'unprocessable',
      'Archive exceeds the total decompression limit',
    );
  }

  if (
    declaredTotal > ZIP_LIMITS.ratioFloorBytes &&
    declaredTotal / buffer.length > ZIP_LIMITS.maxExpansionRatio
  ) {
    throw new DocumentExtractionError(
      'unprocessable',
      'Archive compression ratio exceeds the allowed limit',
    );
  }

  try {
    return unzipSync(new Uint8Array(buffer));
  } catch {
    throw new DocumentExtractionError('unprocessable', 'Archive could not be decompressed');
  }
}

/**
 * Repacks already-decompressed entries into a stored (level 0) archive.
 *
 * This is what keeps {@link ZIP_LIMITS} meaningful for docx: mammoth runs its
 * own unbounded pako inflater, which our caps cannot reach. Handing it a stored
 * archive built from bytes we already decompressed leaves it nothing to inflate,
 * so an entry that understated its size reaches mammoth truncated (and fails to
 * parse) instead of expanding to gigabytes inside a library we do not control.
 * Level 0 also makes the repack a copy rather than a second compression pass.
 */
function repackStored(entries: Unzipped): Buffer {
  const files: Zippable = {};
  for (const [name, content] of Object.entries(entries)) {
    // Directory markers carry no content and confuse a rebuilt package.
    if (name.endsWith('/')) continue;
    files[name] = content;
  }
  return Buffer.from(zipSync(files, { level: 0 }));
}

// ---------------------------------------------------------------------------
// Per-format extraction
// ---------------------------------------------------------------------------

export interface ExtractedDocument {
  /** The sniffed format — authoritative, not the caller's claim. */
  format: DocumentFormat;
  /** Extracted text: Markdown for docx/md, plain text otherwise. */
  text: string;
  /** PDF only; `undefined` for formats that have no notion of a page. */
  totalPages?: number;
}

async function extractPdf(buffer: Buffer): Promise<ExtractedDocument> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });
    return { format: 'pdf', text: result.text as string, totalPages: result.totalPages };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes('password') ||
      message.includes('encrypted') ||
      message.includes('PasswordException')
    ) {
      throw new DocumentExtractionError(
        'unprocessable',
        'Password-protected PDFs are not supported',
      );
    }
    throw new DocumentExtractionError('unprocessable', 'Failed to extract text from PDF');
  }
}

async function extractDocx(buffer: Buffer): Promise<ExtractedDocument> {
  const bounded = repackStored(unzipWithinLimits(buffer));
  try {
    const result = await mammoth.convertToHtml(
      { buffer: bounded },
      {
        // Drop images instead of inlining them: this converter never reads the
        // image bytes, which keeps a picture-heavy .docx from base64-inflating
        // into the response. Only text is wanted here anyway.
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      },
    );
    // Markdown, not raw text, so headings/lists/tables survive into the prompt
    // — the same LLM-facing representation the rest of the pipeline uses
    // (ADR-003).
    return { format: 'docx', text: htmlToMarkdown(result.value) };
  } catch {
    throw new DocumentExtractionError('unprocessable', 'Failed to extract text from DOCX');
  }
}

/** What each predefined XML entity stands for. */
const XML_PREDEFINED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
};

/** XML 1.0 `Char`: the code points a character reference may name. */
function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/**
 * ODF entities are the XML five plus numeric references, decoded in one pass so
 * a decoded `&` never starts another reference (`&#38;lt;` is the text `&lt;`).
 * A reference to a code point XML does not allow — NUL, a surrogate, anything
 * past U+10FFFF — becomes U+FFFD instead of failing the extraction.
 */
function decodeXmlEntities(input: string): string {
  return input.replace(
    /&(?:#x([0-9A-Fa-f]+)|#(\d+)|(lt|gt|quot|apos|amp));/g,
    (reference: string, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (name !== undefined) return XML_PREDEFINED_ENTITIES[name] ?? reference;
      const code = hex !== undefined ? parseInt(hex, 16) : Number(decimal);
      return isXmlChar(code) ? String.fromCodePoint(code) : '\uFFFD';
    },
  );
}

/** One piece of an XML document as {@link xmlTokens} reads it. */
type XmlToken =
  /** Character data, still entity-encoded. */
  | { type: 'text'; raw: string }
  /** The content of a CDATA section: literal text. */
  | { type: 'cdata'; text: string }
  | { type: 'start'; name: string; attrs: string; selfClosing: boolean }
  | { type: 'end' };

/**
 * The index of the `>` that closes the tag opened at `lt`, of a `<` showing it
 * was no tag, or -1 when the input ends inside the tag. A `>` inside a quoted
 * value does not close a tag. XML allows `<` nowhere inside one, so meeting `<`
 * means the tag is malformed: it then closes at its first `>`, quoted or not
 * (what a plain `[^>]*` scan does), or, with no `>` at all, the `<` was stray
 * text. Input that ends inside an open quoted value is read the same way: the
 * tag closes at that value's first `>` when it holds one.
 */
function tagEnd(xml: string, lt: number): number {
  let quote = '';
  let firstGt = -1;
  for (let i = lt + 1; i < xml.length; i += 1) {
    const char = xml.charAt(i);
    if (char === '<') return firstGt === -1 ? i : firstGt;
    if (char === '>') {
      if (quote === '') return i;
      if (firstGt === -1) firstGt = i;
    } else if (quote === '') {
      if (char === '"' || char === "'") quote = char;
    } else if (char === quote) {
      quote = '';
    }
  }
  return firstGt;
}

/**
 * Splits XML into character data and tags in one forward pass, with no regex
 * spanning a tag, so time stays linear and nothing can overflow whatever the
 * input's shape. Comments and processing instructions are skipped. A
 * declaration (`<!DOCTYPE …>`, `<!ENTITY …>`) is passed over as markup that
 * ends at its first `>` outside quotes or at a `<`, so markup quoted inside it
 * can still be read as markup; nothing it declares is ever expanded, since only
 * {@link decodeXmlEntities}' fixed set is decoded, and no DTD is ever loaded.
 * Input that ends inside a tag, comment, processing instruction or CDATA
 * section ends the walk (unless {@link tagEnd} can still close the tag at a
 * quoted `>`), so a truncated document yields what precedes the cut.
 */
function* xmlTokens(xml: string): Generator<XmlToken> {
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd > pos) yield { type: 'text', raw: xml.slice(pos, textEnd) };
    if (lt === -1) return;

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) return;
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) return;
      pos = end + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) return;
      yield { type: 'cdata', text: xml.slice(lt + 9, end) };
      pos = end + 3;
      continue;
    }

    const end = tagEnd(xml, lt);
    if (end === -1) return;
    if (xml.charAt(end) === '<') {
      // A `<` that opens no tag is text, unless it began a declaration.
      if (xml.charAt(lt + 1) !== '!') yield { type: 'text', raw: xml.slice(lt, end) };
      pos = end;
      continue;
    }
    pos = end + 1;
    const tag = xml.slice(lt + 1, end);
    const closing = tag.startsWith('/');
    const name = /^[^\s/]*/.exec(closing ? tag.slice(1) : tag)?.[0] ?? '';
    // `<!DOCTYPE …>` and the declarations inside it are never interpreted.
    if (name === '' || name.startsWith('!')) continue;
    yield closing
      ? { type: 'end' }
      : { type: 'start', name, attrs: tag.slice(name.length), selfClosing: tag.endsWith('/') };
  }
}

/** The content of `office:body`, or the whole document when it has none. */
function odfBody(xml: string): string {
  const open = xml.indexOf('<office:body');
  const start = open === -1 ? 0 : xml.indexOf('>', open) + 1;
  const end = xml.lastIndexOf('</office:body>');
  return start > 0 && start <= end ? xml.slice(start, end) : xml;
}

/**
 * Open paragraphs, and separately open list items, that the walk tracks at
 * once. Real documents nest a few (a footnote's paragraph inside a paragraph is
 * two); deeper ones are read as part of the innermost tracked one, which bounds
 * the walk's memory however a hostile document nests.
 */
const ODF_MAX_NESTING = 64;

/** A `text:p` / `text:h` that is open while {@link odfContentToText} walks. */
interface OdfBlock {
  /** Element depth of the block; the end tag at this depth closes it. */
  depth: number;
  /** `#`… for a heading, `- ` for a list item's paragraph: before its first line only. */
  prefix: string;
  /** Text gathered since the block's last line. */
  text: string;
  /** The block has written a line of its own. */
  wroteLine: boolean;
  /** A block nested inside has split this one. */
  split: boolean;
}

/**
 * Reads ODF text content out of `content.xml` as Markdown-ish lines.
 *
 * A walk over the element structure, not a regex per element: a paragraph
 * nested in another (a footnote or endnote body, a frame's text box) would
 * otherwise end the outer paragraph at the nested `</text:p>` and lose the rest
 * of it (#1734). Element depth decides what closes what, so one pass handles
 * any nesting:
 *
 * - Each `text:p` / `text:h` is a block: its character data, with `text:tab`,
 *   `text:line-break` and `text:s` expanded, trimmed into a line. Headings get
 *   `#` per outline level and paragraphs whose parent is a `text:list-item` get
 *   `- `; an empty block is an empty line.
 * - A block opening inside another splits it in document order: the outer text
 *   so far becomes a line, the nested block's lines follow, and the outer text
 *   after it starts a new line. The outer's marker goes on its first line only.
 * - Comments, forms, binary data and the rendered footnote mark
 *   (`text:note-citation`) are dropped with their content. Character data
 *   outside every block (declarations, metadata) is not text. Text deleted
 *   under change tracking (`text:tracked-changes`) is not filtered out.
 */
function odfContentToText(xml: string): string {
  const body = odfBody(xml);
  // Bound the combined expansion, not just each text:s: a small XML entry can
  // encode many large runs. Count the walked body as part of the budget.
  let expandedBytes = Buffer.byteLength(body, 'utf8');
  const lines: string[] = [];
  const blocks: OdfBlock[] = [];
  const listItemDepths: number[] = [];
  let depth = 0;
  /** Depth of the element being dropped with its content; 0 when none. */
  let skipDepth = 0;

  const writeLine = (block: OdfBlock): void => {
    const text = block.text.trim();
    block.text = '';
    if (!text) return;
    lines.push(block.wroteLine ? text : block.prefix + text);
    block.wroteLine = true;
  };
  const closeBlock = (): void => {
    const block = blocks.pop();
    if (block === undefined) return;
    writeLine(block);
    if (!block.wroteLine && !block.split) lines.push('');
  };
  const append = (text: string): void => {
    const block = blocks.at(-1);
    if (block) block.text += text;
  };

  for (const token of xmlTokens(body)) {
    if (token.type === 'end') {
      if (depth === 0) continue;
      if (skipDepth === depth) {
        skipDepth = 0;
      } else if (skipDepth === 0) {
        if (blocks.at(-1)?.depth === depth) closeBlock();
        if (listItemDepths.at(-1) === depth) listItemDepths.pop();
      }
      depth -= 1;
      continue;
    }
    if (skipDepth !== 0) {
      if (token.type === 'start' && !token.selfClosing) depth += 1;
      continue;
    }
    if (token.type === 'text') {
      if (blocks.length > 0) append(decodeXmlEntities(token.raw));
      continue;
    }
    if (token.type === 'cdata') {
      append(token.text);
      continue;
    }

    const { name, attrs, selfClosing } = token;
    switch (name) {
      // Not document text: comments, form controls, embedded binaries and the
      // rendered footnote mark (the note body itself is kept).
      case 'office:annotation':
      case 'office:forms':
      case 'office:binary-data':
      case 'text:note-citation':
        if (!selfClosing) skipDepth = depth + 1;
        break;
      case 'text:p':
      case 'text:h': {
        if (blocks.length >= ODF_MAX_NESTING) break;
        const outer = blocks.at(-1);
        if (outer) {
          writeLine(outer);
          outer.split = true;
        }
        let prefix = '';
        if (name === 'text:h') {
          const level = Number(/(?:^|\s)text:outline-level\s*=\s*(['"])(\d+)\1/.exec(attrs)?.[2] ?? '1');
          prefix = `${'#'.repeat(Math.min(Math.max(level, 1), 6))} `;
        } else if (listItemDepths.at(-1) === depth) {
          prefix = '- ';
        }
        blocks.push({ depth: depth + 1, prefix, text: '', wroteLine: false, split: false });
        if (selfClosing) closeBlock();
        break;
      }
      case 'text:list-item':
        if (!selfClosing && listItemDepths.length < ODF_MAX_NESTING) listItemDepths.push(depth + 1);
        break;
      case 'text:tab':
        append('\t');
        break;
      case 'text:line-break':
        append('\n');
        break;
      case 'text:s': {
        const raw = /(?:^|\s)text:c\s*=\s*(['"])(\d+)\1/.exec(attrs)?.[2];
        const count = raw === undefined ? 1 : Number(raw);
        if (!Number.isSafeInteger(count) || count > ZIP_LIMITS.maxEntryBytes - expandedBytes) {
          throw new DocumentExtractionError('unprocessable', 'ODT repeated spaces exceed the document limit');
        }
        expandedBytes += count;
        append(' '.repeat(count));
        break;
      }
    }
    if (!selfClosing) depth += 1;
  }
  while (blocks.length > 0) closeBlock();

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractOdt(buffer: Buffer): ExtractedDocument {
  // No repack needed: nothing but our own reader ever sees these bytes.
  const content = unzipWithinLimits(buffer)['content.xml'];
  if (content === undefined) {
    throw new DocumentExtractionError('unprocessable', 'ODT file has no content.xml');
  }
  return { format: 'odt', text: odfContentToText(strFromU8(content)) };
}

/**
 * Placeholders used while stripping RTF. Private-use codepoints: no control
 * word can match them and no real document contains them.
 */
const RTF_ESCAPED_BACKSLASH = '\uE000';
const RTF_ESCAPED_BRACE_OPEN = '\uE001';
const RTF_ESCAPED_BRACE_CLOSE = '\uE002';

/**
 * RTF destination groups whose payload is markup, not body text. Everything
 * inside them is dropped whole rather than stripped word by word.
 */
const RTF_DESTINATIONS =
  'fonttbl|colortbl|stylesheet|info|pict|object|header[lrf]?|footer[lrf]?|footnote|' +
  'xmlnstbl|listtable|listoverridetable|rsidtbl|generator|datastore|themedata|' +
  'colorschememapping|latentstyles';

/**
 * Flattens RTF markup to text.
 *
 * RTF is a control-word syntax rather than a markup language, so this strips
 * rather than parses: non-text destination groups are removed whole, the few
 * control words that mean whitespace become whitespace, escapes are decoded,
 * and every other control word disappears.
 */
export function rtfToText(rtf: string): string {
  // `{\fonttbl ...}` and the ignorable form `{\*\generator ...}`. The inner
  // `(?:\{...\}...)*` swallows one level of nesting per pass; the loop below
  // unwinds any deeper nesting until the text stops shrinking.
  const destination = new RegExp(
    String.raw`\{\\(?:\*\\)?(?:` +
    RTF_DESTINATIONS +
    String.raw`)\b[^{}]*(?:\{[^{}]*\}[^{}]*)*\}`,
    'g',
  );
  // The sentinels below must be unforgeable, so any pre-existing occurrence
  // in the source is dropped first.
  let text = rtf.replace(/[\uE000-\uE002]/g, '');
  for (let pass = 0; pass < 5; pass += 1) {
    const next = text.replace(destination, '');
    if (next === text) break;
    text = next;
  }

  text = text
    // Escaped literals first, so the control-word sweep cannot eat them.
    .replace(/\\\\/g, RTF_ESCAPED_BACKSLASH)
    .replace(/\\\{/g, RTF_ESCAPED_BRACE_OPEN)
    .replace(/\\\}/g, RTF_ESCAPED_BRACE_CLOSE)
    // `\uN?` — the trailing `?` is the ANSI fallback character, discarded.
    .replace(/\\u(-?\d+)\s?\??/g, (_m, code: string) => {
      const point = Number(code);
      return String.fromCharCode(point < 0 ? point + 65536 : point);
    })
    // `\'hh` — a raw byte, read as Latin-1 (the common RTF default).
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    // Control symbols that stand for a character rather than a command.
    .replace(/\\~/g, ' ')
    .replace(/\\_/g, '-')
    // Paragraph and line breaks.
    .replace(/\\(?:par|line|pard)\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    // Everything else that is a control word or a control symbol.
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/\\[^a-zA-Z]/g, '')
    .replace(/[{}]/g, '')
    .split(RTF_ESCAPED_BACKSLASH).join('\\')
    .split(RTF_ESCAPED_BRACE_OPEN).join('{')
    .split(RTF_ESCAPED_BRACE_CLOSE).join('}');

  return text
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts text from an uploaded document.
 *
 * `filename` supplies the claimed format; the bytes decide the real one, and
 * the two must agree (see {@link resolveDocumentFormat}). Every failure is a
 * {@link DocumentExtractionError} carrying the status class the route should
 * return.
 */
export async function extractDocumentText(
  buffer: Buffer,
  filename: string | undefined,
): Promise<ExtractedDocument> {
  const format = resolveDocumentFormat(buffer, filename);

  switch (format) {
    case 'pdf':
      return extractPdf(buffer);
    case 'docx':
      return extractDocx(buffer);
    case 'odt':
      return extractOdt(buffer);
    case 'rtf':
      return { format: 'rtf', text: rtfToText(buffer.toString('utf8')) };
    case 'md':
    case 'txt':
    case 'yaml':
      // Already text — `resolveDocumentFormat` has confirmed it decodes as
      // UTF-8 and carries no NUL.
      return { format, text: buffer.toString('utf8') };
  }
}

/** Shortens extracted text for the UI's preview card. */
export function buildPreview(text: string): string {
  return text.slice(0, PREVIEW_LENGTH) + (text.length > PREVIEW_LENGTH ? '...' : '');
}
