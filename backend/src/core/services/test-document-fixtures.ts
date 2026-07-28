import { zipSync, strToU8, type Zippable } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * Real bytes for every format the document extractor accepts (#1131).
 *
 * These build genuine files — a pdf-lib PDF that `unpdf` really parses, a zip
 * that `mammoth` really opens — so the extractor tests exercise the actual
 * libraries instead of a mock's idea of them. Only then does a magic-byte or
 * zip-bomb test prove anything.
 */

/** A PDF whose pages carry the given lines, built with pdf-lib. */
export async function buildPdf(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of pages) {
    const page = doc.addPage([320, 320]);
    page.drawText(line, { x: 20, y: 260, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const DOCX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** One WordprocessingML paragraph; `style` maps to a `w:pStyle` such as `Heading1`. */
export interface DocxParagraph {
  text: string;
  style?: string;
}

function docxParagraphXml({ text, style }: DocxParagraph): string {
  const props = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${props}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/**
 * A minimal but genuine .docx. `extraEntries` lets a caller bolt on padding
 * entries to drive the zip-bomb bounds while keeping the package valid.
 */
export function buildDocx(
  paragraphs: DocxParagraph[],
  extraEntries: Zippable = {},
): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
    paragraphs.map(docxParagraphXml).join('')
  }</w:body></w:document>`;

  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(DOCX_CONTENT_TYPES),
    '_rels/.rels': strToU8(DOCX_ROOT_RELS),
    'word/document.xml': strToU8(document),
    ...extraEntries,
  }));
}

const ODT_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

/**
 * A minimal but genuine .odt. `bodyXml` is the inner content of
 * `<office:text>`; the `mimetype` entry is stored uncompressed as ODF requires.
 */
export function buildOdt(bodyXml: string, extraEntries: Zippable = {}): Buffer {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
<office:body><office:text>${bodyXml}</office:text></office:body></office:document-content>`;

  return Buffer.from(zipSync({
    mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
    'META-INF/manifest.xml': strToU8(ODT_MANIFEST),
    'content.xml': strToU8(content),
    ...extraEntries,
  }));
}

/** An arbitrary zip — used for the "valid archive, neither docx nor odt" case. */
export function buildZip(entries: Zippable): Buffer {
  return Buffer.from(zipSync(entries));
}

/**
 * A highly compressible entry of the given uncompressed size. Zeroes deflate to
 * roughly nothing, which is exactly what a zip bomb relies on.
 */
export function compressibleEntry(uncompressedBytes: number): Uint8Array {
  return new Uint8Array(uncompressedBytes);
}

/**
 * Rewrites every declared uncompressed size in a zip — the shape of a bomb that
 * understates its payload so a size check waves it through.
 *
 * Both copies of the field are patched: the local file header (`PK\x03\x04`,
 * offset +22) and the central directory (`PK\x01\x02`, offset +24).
 */
export function forgeUncompressedSizes(zip: Buffer, declared: number): Buffer {
  const forged = Buffer.from(zip);
  for (let i = 0; i + 30 <= forged.length; i += 1) {
    if (forged[i] !== 0x50 || forged[i + 1] !== 0x4b) continue;
    if (forged[i + 2] === 0x03 && forged[i + 3] === 0x04) forged.writeUInt32LE(declared, i + 22);
    if (forged[i + 2] === 0x01 && forged[i + 3] === 0x02) forged.writeUInt32LE(declared, i + 24);
  }
  return forged;
}

/** An RTF document body wrapped in the header a real writer emits. */
export function buildRtf(body: string): Buffer {
  return Buffer.from(
    '{\\rtf1\\ansi\\ansicpg1252\\deff0' +
    '{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}' +
    '{\\colortbl ;\\red0\\green0\\blue0;}' +
    '{\\*\\generator Riched20 10.0.0;}' +
    `\\pard\\f0\\fs22 ${body}\\par}`,
    'utf8',
  );
}

/** Multipart request body for a single `file` field, as the browser would send it. */
export function createMultipartPayload(
  filename: string,
  content: Buffer,
  contentType = 'application/octet-stream',
): { body: Buffer; boundary: string } {
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
