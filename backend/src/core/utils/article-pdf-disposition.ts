const MAX_STEM_BYTES = 150;

function boundedStem(text: string, fallback: string): string {
  const stem = text.replace(/^[.\s]+|[.\s]+$/gu, '').replace(/\s+/gu, '-');
  let bytes = 0;
  let end = 0;
  for (const char of stem) {
    bytes += Buffer.byteLength(char);
    if (bytes > MAX_STEM_BYTES) break;
    end += char.length;
  }
  return stem.slice(0, end).replace(/\.+$/, '') || fallback;
}

/** The id is the validated primary key, never raw route input. */
export function articlePdfDisposition(title: string, pageId: number): string {
  const fallback = `article-${pageId}`;
  const text = title.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}\p{Z}._-]/gu, '');
  const unicode = boundedStem(text, fallback);
  const ascii = boundedStem(text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9\p{Z}._-]/gu, ''), fallback);
  // Among the allowed characters only non-ASCII needs RFC 5987 escaping.
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(unicode)}.pdf`;
}
