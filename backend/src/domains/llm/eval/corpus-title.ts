/**
 * #1102 — how a vendored corpus page gets its TITLE.
 *
 * The corpus stands in for a Confluence knowledge base, and a Confluence page
 * has a human title. The first version of `scripts/vendor-eval-corpus.ts`
 * derived one as `frontMatter.title ?? /^#\s+(.+)$/m ?? relativePath`, and all
 * three legs leaked non-titles into the manifest:
 *
 * - 29 pages fell through to the **file path** (`docs/Guides/Benchmarking.md`).
 *   Fastify's docs put their page heading in an HTML `<h1 align="center">` and
 *   open the prose at `##`, so the `#`-only regex never matched. A path is one
 *   `simple`-configuration lexeme in `pages.tsv`, which makes the page
 *   structurally invisible to the keyword leg of hybrid search — and it is not
 *   what the product stores.
 * - 3 pages took a **comment from inside a fenced code block** — a page titled
 *   `The global section defines base HAProxy (engine) instance configuration.`
 *   and another titled `{"answer":42}`. The `m` flag matches `#` anywhere,
 *   including inside ``` fences, which is the same defect `chunkText`'s
 *   fence-aware section splitter exists to avoid.
 * - 13 pages carried **VitePress markup** into the title: Vue components
 *   (`Task Metadata <Badge type="danger">advanced</Badge>`), explicit anchors
 *   (`{#custom-pool}`) and inline code backticks.
 *
 * The derivation below is deliberately pure and total so the vendor script and
 * `corpus-title.test.ts` can run the identical function over the identical
 * bytes: the committed manifest is then reproducible from the vendored files
 * themselves, not only from a re-clone of the three upstream repositories.
 */

/**
 * Strip presentation out of a title string.
 *
 * VitePress renders Vue components inside headings and front matter, so the
 * raw string carries markup a Confluence title never would. Paired components
 * are removed WITH their content: `<Badge …>advanced</Badge>` and
 * `<Version>5.0.0</Version>` are decoration, and keeping the inner text would
 * title a page `Custom Pool advanced`. Capitalised tag names only — that is
 * the Vue component convention, and it keeps a lowercase HTML tag (should one
 * ever appear in a heading) out of scope rather than silently eating its text.
 */
export function cleanTitle(raw: string): string {
  return raw
    // Paired Vue component, content included.
    .replace(/<([A-Z][A-Za-z0-9]*)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    // Self-closing or unpaired component tag: `<Experimental />`, `</Badge>`.
    .replace(/<\/?[A-Z][A-Za-z0-9]*\b[^>]*\/?>/g, '')
    // VitePress explicit heading anchor: `{#custom-pool}`.
    .replace(/\{#[^}]*\}/g, '')
    // Inline code markers: a title is text, not Markdown.
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first ATX heading at or above `maxDepth`, ignoring fenced code.
 *
 * Fence tracking is by marker CHARACTER (``` vs ~~~) so a ```-fenced block
 * containing ~~~ does not close early, and mirrors the fence handling in
 * `embedding-service.ts`'s splitter rather than inventing a second dialect.
 */
export function firstMarkdownHeading(body: string, maxDepth: number): string | null {
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = new RegExp(`^\\s{0,3}#{1,${maxDepth}}\\s+(.+)$`).exec(line);
    if (heading) return heading[1]!.trim();
  }
  return null;
}

/**
 * Words that stay lowercase inside a filename-derived title, so
 * `Validation-and-Serialization.md` reads `Validation and Serialization`
 * rather than `Validation And Serialization` — which is not a title anyone
 * writes. Never applied to the first word.
 */
const LOWERCASE_IN_TITLE = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * `Fluent-Schema.md` → `Fluent Schema`. Only the FIRST letter of each word is
 * touched: `HTTP2`, `TypeScript` and `ContentTypeParser` are how upstream
 * spells them, and lowercasing the tail would be a worse title than the one
 * being replaced.
 */
export function deslugifyFilename(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop()!.replace(/\.md$/i, '');
  return base
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word, index) =>
      index > 0 && LOWERCASE_IN_TITLE.has(word.toLowerCase()) ? word.toLowerCase() : `${word[0]!.toUpperCase()}${word.slice(1)}`,
    )
    .join(' ');
}

/**
 * Filenames that name a POSITION in the tree rather than a subject. `Index.md`
 * would give three different pages the same meaningless title, so those take
 * their first heading at any depth instead.
 */
const POSITIONAL_FILENAMES = new Set(['index', 'readme']);

/**
 * Which leg of `deriveCorpusTitle` produced a title. Recorded per page in
 * `corpus/MANIFEST.json` — the vendored `.md` files have their front matter
 * stripped, so without it a test cannot tell a title the script derived from
 * the body from one somebody typed in by hand. With it, every `heading` and
 * `filename` title is re-derivable from the committed bytes.
 */
export type CorpusTitleSource = 'front-matter' | 'heading' | 'filename';

/**
 * The one derivation, in priority order:
 *
 * 1. the front-matter `title`, which is the site's own answer;
 * 2. the first `#` heading — a document that states its own title wins;
 * 3. the de-slugified filename, unless the filename is positional;
 * 4. the first heading at any depth (the positional case, and any page whose
 *    filename de-slugifies to nothing);
 * 5. the de-slugified filename as a last resort.
 *
 * Rule 3 sits ABOVE the deeper headings on purpose. A page with no `#` opens
 * at some `##` that is its first *section*, not its subject:
 * `docs/Guides/Serverless.md` would be titled `AWS` and
 * `docs/Reference/Server.md` would be titled `Factory`. The filename is the
 * more faithful title there, and short noun phrases are what a knowledge base
 * actually holds.
 */
export function deriveCorpusTitle(input: {
  frontMatterTitle: string | null;
  body: string;
  filePath: string;
}): { title: string; source: CorpusTitleSource } {
  const fromFrontMatter = input.frontMatterTitle === null ? '' : cleanTitle(input.frontMatterTitle);
  if (fromFrontMatter) return { title: fromFrontMatter, source: 'front-matter' };

  const h1 = firstMarkdownHeading(input.body, 1);
  const fromH1 = h1 === null ? '' : cleanTitle(h1);
  if (fromH1) return { title: fromH1, source: 'heading' };

  const base = input.filePath.split(/[/\\]/).pop()!.replace(/\.md$/i, '').toLowerCase();
  const fromFilename = deslugifyFilename(input.filePath);
  if (!POSITIONAL_FILENAMES.has(base) && fromFilename) return { title: fromFilename, source: 'filename' };

  const anyHeading = firstMarkdownHeading(input.body, 6);
  const fromAnyHeading = anyHeading === null ? '' : cleanTitle(anyHeading);
  return fromAnyHeading
    ? { title: fromAnyHeading, source: 'heading' }
    : { title: fromFilename, source: 'filename' };
}
