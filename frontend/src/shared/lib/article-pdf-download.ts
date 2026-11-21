export interface ArticlePdfDownload {
  blob: Blob;
  filename: string | null;
}

// RFC 5646 §2.1. The regular grandfathered tags already match langtag;
// the irregular ones and private-use-only tags are separate alternatives.
const irregularTag = /^(?:en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)|sgn-(?:be-fr|be-nl|ch-de))$/;
const langtag = new RegExp(
  '^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})' + // language and optional extlangs
  '(?:-[a-z]{4})?(?:-[a-z]{2}|-[0-9]{3})?' +         // script, region
  '((?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)' +     // variants
  '((?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*)' +          // extensions
  '(?:-x(?:-[a-z0-9]{1,8})+)?$',                       // private use
);

function isLanguageTag(tag: string): boolean {
  const lower = tag.toLowerCase();
  if (irregularTag.test(lower) || /^x(?:-[a-z0-9]{1,8})+$/.test(lower)) return true;
  const match = langtag.exec(lower);
  if (!match) return false;
  // Well-formedness also forbids repeated variants and extension singletons.
  const variants = match[1]!.split('-');
  const singletons = match[2]!.match(/-[a-z0-9](?=-)/g) ?? [];
  return new Set(variants).size === variants.length && new Set(singletons).size === singletons.length;
}

/** Read one complete attachment header; never recover a name from ambiguous syntax. */
export function parseArticlePdfFilename(header: string | null): string | null {
  if (!header) return null;
  const disposition = /^[ \t]*attachment[ \t]*/i.exec(header);
  if (!disposition) return null;

  // HTTP token or quoted-string (including escaped quotes and embedded semicolons).
  // Sticky matching ensures no unparsed input is skipped between parameters.
  const parameter = /;[ \t]*([!#$%&'*+.^_`|~a-zA-Z0-9-]+)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([!#$%&'*+.^_`|~a-zA-Z0-9-]+))[ \t]*/y;
  parameter.lastIndex = disposition[0].length;
  const seen = new Set<string>();
  let plain: string | undefined;
  let extended: string | undefined;
  while (parameter.lastIndex < header.length) {
    const part = parameter.exec(header);
    if (!part) return null;
    const key = part[1]!.toLowerCase();
    if (seen.has(key) || /^filename\*\d/.test(key)) return null;
    seen.add(key);
    if (key === 'filename') plain = part[2]?.replace(/\\(.)/gs, '$1') ?? part[3];
    if (key === 'filename*') {
      // RFC 5987 ext-value is not a quoted string. A bad one invalidates the
      // header even when it also carries a syntactically valid ASCII fallback.
      const value = /^utf-8'([a-z0-9-]*)'((?:[a-z0-9!#$&+.^_`|~-]|%[a-f0-9]{2})+)$/i.exec(part[3] ?? '');
      if (!value || (value[1] && !isLanguageTag(value[1]))) return null;
      try {
        extended = decodeURIComponent(value[2]!);
      } catch {
        return null; // Valid percent triplets, invalid UTF-8.
      }
    }
  }
  const name = (extended ?? plain)?.replace(/[/\\\p{Cc}\p{Cf}]/gu, '').trim().replace(/^[.\s]+/u, '');
  return name && /\.pdf$/i.test(name) ? name : null;
}

export function downloadArticlePdf({ blob, filename }: ArticlePdfDownload, title?: string | null): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename ?? `${title?.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase() ?? 'page'}.pdf`;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
