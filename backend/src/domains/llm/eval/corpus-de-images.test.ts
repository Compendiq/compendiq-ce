/**
 * #1115 P5a — the guard over the vendored German image corpus.
 *
 * Filesystem-only, and deliberately NOT gated on a database or a network the
 * way `runner.integration.test.ts` is (the `migration-filenames.test.ts`
 * precedent): everything it checks is a property of committed bytes, and a
 * guard that skips wherever the corpus is most likely to be edited by hand is
 * not a guard.
 *
 * What it exists to stop, in the order the failures actually happen:
 *
 * 1. **A hand-edit to `MANIFEST.json`.** The builder regenerates the whole
 *    directory, so an edit made here is deleted without a word on the next
 *    rebuild — and until then the fixture's labeller reads captions that no
 *    longer describe the bytes. Both directions are checked, so a page added
 *    on disk without a manifest entry fails too.
 * 2. **A caption or an alt text leaking into the page body.** The whole point
 *    of this corpus is a page whose visual content is *not* restated in prose
 *    (the design's Confluence-shaped case). If the stripping regresses, every
 *    image query becomes answerable from text alone and the image leg measures
 *    nothing — silently, and in the direction that flatters the feature.
 * 3. **An image that the product would refuse.** The bytes are re-checked with
 *    `sniffImageFormat` / `readImageDimensions` from `core/services/
 *    image-validator.ts` — the same code the intake path runs — rather than
 *    trusting what the builder wrote into the manifest.
 * 4. **A licence the repo may not carry.** CC0 / public domain / CC BY x /
 *    CC BY-SA x only, each with a named author, because the attribution file
 *    is an obligation and not a courtesy. "Named" is checked, not merely
 *    "non-empty": de.wikipedia renders the unknown-author templates localised
 *    ("Autor/-in unbekannt Unknown author"), Commons' `Credit` is the *Source*
 *    field rather than an author, and a hard character cap on a long credit
 *    cuts a surname in half and drops the contributors behind it. All three
 *    put a sentence into `LICENSE-ATTRIBUTION.md` that is not a fact, on the
 *    one artifact here whose entire purpose is being accurate.
 * 5. **Wiring it into the eval runner by accident.** See the last two tests —
 *    including the one language string that resolves onto this directory.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  IMAGE_CORPUS_DIR,
  IMAGE_CORPUS_CATEGORIES,
  MAX_IMAGE_EDGE_PX,
  MAX_IMAGE_FILE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  MIN_PAGES_PER_CATEGORY,
  MAX_AUTHOR_CHARS,
  AUTHOR_ABBREVIATED_MARK,
  IMAGE_FILE_NAME,
  isAllowedImageLicense,
  namesAnAuthor,
  loadImageCorpusManifest,
} from './corpus-images.js';
import { CORPUS_DIRS, corpusDirsForLanguage, translatedCorpusDirs } from './fixture.js';
import { sniffImageFormat, readImageDimensions } from '../../../core/services/image-validator.js';

const manifest = loadImageCorpusManifest();
const pages = manifest.pages;
const allImages = pages.flatMap((page) => page.images.map((image) => ({ page, image })));

/** Non-corpus markdown, exactly as `corpusFilesOnDisk` treats it. */
const NON_CORPUS = new Set(['LICENSE-ATTRIBUTION.md', 'README.md']);

function pageBody(file: string): string {
  return readFileSync(join(IMAGE_CORPUS_DIR, file), 'utf8');
}

/** Every markdown image reference in a page, alt text included. */
function imageRefs(markdown: string): Array<{ alt: string; target: string }> {
  return [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => ({
    alt: m[1] ?? '',
    target: m[2] ?? '',
  }));
}

describe('corpus-de-images — manifest and disk agree', () => {
  it('lists at least one page', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it('has a file on disk for every manifest page, and a manifest entry for every file', () => {
    const onDisk = new Set(
      readdirSync(IMAGE_CORPUS_DIR).filter((f) => f.endsWith('.md') && !NON_CORPUS.has(f)),
    );
    const inManifest = new Set(pages.map((p) => p.file));

    expect(
      [...inManifest].filter((f) => !onDisk.has(f)),
      'MANIFEST.json names pages that are not on disk. Re-run tools/eval-corpus-images/build.py.',
    ).toEqual([]);
    expect(
      [...onDisk].filter((f) => !inManifest.has(f)),
      'Pages exist on disk that MANIFEST.json does not list. A page invisible to the manifest is ' +
        'invisible to the seeder and to the labeller, so it silently leaves the corpus.',
    ).toEqual([]);
  });

  it('gives every page a unique file, slug-shaped name', () => {
    const files = pages.map((p) => p.file);
    expect(new Set(files).size, 'duplicate page file in MANIFEST.json').toBe(files.length);
    expect(files.filter((f) => !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(f))).toEqual([]);
  });

  it('gives every page at least one image', () => {
    const bare = pages.filter((p) => p.images.length === 0).map((p) => p.file);
    expect(
      bare,
      'A page with no image is an ordinary text page. It cannot answer an image query and it ' +
        'cannot be an image-negative distractor either, so it only dilutes N.',
    ).toEqual([]);
  });

  it('covers every content shape', () => {
    const counts = Object.fromEntries(
      IMAGE_CORPUS_CATEGORIES.map((c) => [c, pages.filter((p) => p.category === c).length]),
    );
    for (const category of IMAGE_CORPUS_CATEGORIES) {
      expect(
        counts[category],
        `Only ${counts[category]} ${category} pages. The four shapes are measured separately — ` +
          `a shape thinner than ${MIN_PAGES_PER_CATEGORY} pages cannot carry its own slice of the ` +
          `fixture.\n${JSON.stringify(counts)}`,
      ).toBeGreaterThanOrEqual(MIN_PAGES_PER_CATEGORY);
    }
  });
});

describe('corpus-de-images — images', () => {
  it('references every manifest image from exactly one page, and every file from exactly one reference', () => {
    const referenced = new Map<string, string[]>();
    for (const page of pages) {
      for (const ref of imageRefs(pageBody(page.file))) {
        referenced.set(ref.target, [...(referenced.get(ref.target) ?? []), page.file]);
      }
    }

    const declared = allImages.map(({ image }) => image.file);
    expect(new Set(declared).size, 'the same image file is declared by two manifest entries').toBe(
      declared.length,
    );

    const shared = [...referenced.entries()].filter(([, from]) => from.length > 1);
    expect(
      shared.map(([file, from]) => `${file} <- ${from.join(', ')}`),
      'An image referenced from two pages makes the labels ambiguous: a query answered by that ' +
        'image has two correct pages, and neither the fixture nor imageHit@K models that.',
    ).toEqual([]);

    expect(
      declared.filter((f) => !referenced.has(f)).sort(),
      'MANIFEST.json declares images no page references.',
    ).toEqual([]);
    expect(
      [...referenced.keys()].filter((f) => !declared.includes(f)).sort(),
      'A page references an image MANIFEST.json does not declare, so it carries no attribution.',
    ).toEqual([]);

    const filesOnDisk = readdirSync(join(IMAGE_CORPUS_DIR, 'images')).map((f) => `images/${f}`);
    expect(
      filesOnDisk.filter((f) => !declared.includes(f)).sort(),
      'Orphan image bytes on disk. The builder rewrites the directory, so these are leftovers ' +
        'from a previous run — they ship in the repo and are attributed nowhere.',
    ).toEqual([]);
  });

  it('keeps every page reference in manifest order', () => {
    for (const page of pages) {
      expect(
        imageRefs(pageBody(page.file)).map((r) => r.target),
        `${page.file}: the page's image references and its manifest entry disagree`,
      ).toEqual(page.images.map((i) => i.file));
    }
  });

  it('sniffs as a raster format the product accepts, at the declared size', () => {
    for (const { page, image } of allImages) {
      const bytes = readFileSync(join(IMAGE_CORPUS_DIR, image.file));
      const format = sniffImageFormat(bytes);
      expect(format, `${image.file} (${page.file}) does not sniff as a supported image`).not.toBeNull();
      expect(
        ['png', 'jpeg', 'webp'],
        `${image.file} sniffs as ${format}. SVG and GIF are out — the design vendors SVG figures ` +
          "as Wikimedia's PNG thumbnail rendering precisely so the bytes are raster, and the " +
          'product refuses SVG outright (script/XXE).',
      ).toContain(format);
      expect(
        format,
        `${image.file}: the manifest declares ${image.format} and the bytes are ${format}. ` +
          'The manifest is what the labeller and P5b read; the bytes are what a model sees.',
      ).toBe(image.format);

      const dims = readImageDimensions(bytes, format!);
      expect(dims, `${image.file}: dimensions unreadable`).not.toBeNull();
      expect({ ...dims }, `${image.file}: manifest dimensions disagree with the bytes`).toEqual({
        width: image.width,
        height: image.height,
      });
      expect(
        Math.max(dims!.width, dims!.height),
        `${image.file} is ${dims!.width}x${dims!.height}; the corpus caps the longest edge at ` +
          `${MAX_IMAGE_EDGE_PX}px so the whole thing stays committable.`,
      ).toBeLessThanOrEqual(MAX_IMAGE_EDGE_PX);

      expect(bytes.length, `${image.file}: manifest byte count disagrees with the file`).toBe(image.bytes);
      expect(
        bytes.length,
        `${image.file} is ${bytes.length} bytes; the hard cap is ${MAX_IMAGE_FILE_BYTES}.`,
      ).toBeLessThanOrEqual(MAX_IMAGE_FILE_BYTES);
    }
  });

  it('stays inside the repository budget', () => {
    const total = allImages.reduce(
      (sum, { image }) => sum + statSync(join(IMAGE_CORPUS_DIR, image.file)).size,
      0,
    );
    expect(
      total,
      `${(total / 1024 / 1024).toFixed(2)} MB of images. These are committed binaries in an ` +
        'otherwise text repository; the budget is what keeps a corpus refresh from being a clone-size event.',
    ).toBeLessThanOrEqual(MAX_TOTAL_IMAGE_BYTES);
  });

  it('carries a named author and a permitted licence for every image', () => {
    const offenders = allImages
      .filter(({ image }) => !isAllowedImageLicense(image.license) || !namesAnAuthor(image.author))
      .map(({ image }) => `${image.file}: author=${JSON.stringify(image.author)} license=${JSON.stringify(image.license)}`);
    expect(
      offenders,
      'Only CC0, public domain, CC BY x and CC BY-SA x are permitted, each with a NAMED author. ' +
        'Non-empty is not named: de.wikipedia renders the unknown-author templates localised ' +
        '("Autor/-in unbekannt Unknown author", "Anonym Unknown author"), and Commons\' `Credit` ' +
        'field is the *Source*, so reading it as an author credits a photograph to "Eigenes ' +
        'Werk". Each of those is a sentence in LICENSE-ATTRIBUTION.md that is not a fact.',
    ).toEqual([]);
  });

  it('never abbreviates a credit into a name nobody can look up', () => {
    const overCap = allImages
      .filter(({ image }) => image.author.length > MAX_AUTHOR_CHARS)
      .map(({ image }) => `${image.file}: ${image.author.length} chars`);
    expect(
      overCap,
      `A credit past ${MAX_AUTHOR_CHARS} characters must be abbreviated by the builder.`,
    ).toEqual([]);

    // The signature of a hard character cap is several credits ending at the
    // identical length. The first cut capped at a flat 180: five credits came
    // out at exactly 180 characters, two of them CC BY-SA, one cutting
    // `AxelScheithauer` mid-surname and dropping a third contributor entirely.
    // Below 120 characters an identical length is coincidence, so only long
    // credits are compared.
    const LONG_CREDIT_CHARS = 120;
    const byLength = new Map<number, string[]>();
    for (const { image } of allImages) {
      if (image.author.length < LONG_CREDIT_CHARS) continue;
      if (image.author.endsWith(AUTHOR_ABBREVIATED_MARK)) continue;
      byLength.set(image.author.length, [...(byLength.get(image.author.length) ?? []), image.file]);
    }
    expect(
      [...byLength.entries()].filter(([, files]) => files.length > 1).map(([len, files]) => `${len} chars: ${files.join(', ')}`),
      'Several long credits stop at exactly the same length, which is what a character cap looks ' +
        `like and not what authorship looks like. Abbreviate on a word boundary and mark it with ` +
        `"${AUTHOR_ABBREVIATED_MARK.trim()}" so a reader can tell the credit is partial and follow ` +
        'sourceUrl for the rest.',
    ).toEqual([]);
  });

  it('records the upstream content address of every image', () => {
    const offenders = allImages
      .filter(({ image }) => !/^[0-9a-f]{40}$/.test(image.sha1))
      .map(({ image }) => `${image.file}: sha1=${JSON.stringify(image.sha1)}`);
    expect(
      offenders,
      "The article revision pins the TEXT. Commons serves the current version of a file, so an " +
        'SVG re-drawn or a photograph re-cropped upstream changes a "pinned" rebuild with nothing ' +
        'to notice it — the sha1 is what turns that from a silent byte diff into a named failure.',
    ).toEqual([]);
  });

  it('points every image at the Commons file it came from', () => {
    for (const { image } of allImages) {
      // The canonical English namespace, not de.wikipedia's `Datei:` alias —
      // the alias does not resolve on Commons, so an attribution carrying it
      // links nowhere.
      expect(image.sourceTitle, `${image.file}`).toMatch(/^File:/);
      expect(image.sourceUrl, `${image.file}`).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    }
  });

  it('names every image after the page that carries it', () => {
    const offenders = allImages
      .filter(({ page, image }) => {
        // Shape AND ownership. The shape alone would let a manifest edit hang
        // `koelner-dom__1.jpg` off `scrum.md` — still referenced from exactly
        // one page, so every other check here passes.
        const slug = page.file.replace(/\.md$/, '');
        return !IMAGE_FILE_NAME.test(image.file) || !image.file.startsWith(`images/${slug}__`);
      })
      .map(({ page, image }) => `${image.file} on ${page.file}`);
    expect(
      offenders,
      'The name is what ties an image to exactly one page and makes the "referenced from one ' +
        'page" check mechanical rather than a lookup.',
    ).toEqual([]);
  });
});

describe('corpus-de-images — the attribution file covers what is committed', () => {
  const attribution = readFileSync(join(IMAGE_CORPUS_DIR, 'LICENSE-ATTRIBUTION.md'), 'utf8');

  it('names every page, its revision and its licence', () => {
    const missing = pages
      .filter((page) => !attribution.includes(page.title) || !attribution.includes(String(page.revid)))
      .map((page) => page.file);
    expect(
      missing,
      'CC BY-SA 4.0 obliges attribution to the article, and the revision is what makes the ' +
        '"adapted from" claim checkable. A page in the corpus but not in the notices file is an ' +
        'obligation the repository is not meeting.',
    ).toEqual([]);
  });

  it('names every image with its Commons file, author and licence', () => {
    const missing = allImages
      .filter(
        ({ image }) =>
          !attribution.includes(image.file) ||
          !attribution.includes(image.sourceTitle) ||
          !attribution.includes(image.author) ||
          !attribution.includes(image.license),
      )
      .map(({ image }) => image.file);
    expect(
      missing,
      'Every CC BY and CC BY-SA image requires its author credit to travel with it. This file is ' +
        'where that credit lives, and it is generated — a drift means the manifest and the ' +
        'notices came from different builds.',
    ).toEqual([]);
  });
});

describe('corpus-de-images — no caption or alt text reaches the page body', () => {
  it('renders every image with an empty alt and a relative path', () => {
    for (const page of pages) {
      const refs = imageRefs(pageBody(page.file));
      expect(
        refs.filter((r) => r.alt !== '').map((r) => `${page.file}: ![${r.alt}]`),
        'Alt text is a restatement of the picture in prose. The text leg would answer the image ' +
          'queries from it and the measurement would be of nothing.',
      ).toEqual([]);
      expect(refs.filter((r) => !r.target.startsWith('images/')).map((r) => r.target)).toEqual([]);
    }
  });

  it('leaves no figure markup behind', () => {
    for (const page of pages) {
      const body = pageBody(page.file);
      for (const marker of ['<figure', '<figcaption', 'class="thumb', 'mw-default-size', 'thumbcaption']) {
        expect(body.includes(marker), `${page.file} still contains ${marker}`).toBe(false);
      }
    }
  });

  it('does not restate a manifest caption verbatim in the prose', () => {
    // Only captions long enough that a verbatim occurrence is evidence rather
    // than coincidence: "Kölner Dom" is a caption AND a phrase the article
    // uses forty times, and failing on that would be a guard nobody could
    // satisfy. A leak reintroduces the whole caption, so the long ones catch it.
    const CAPTION_EVIDENCE_CHARS = 30;
    const leaks: string[] = [];
    for (const page of pages) {
      const body = pageBody(page.file);
      for (const image of page.images) {
        const caption = image.caption.trim();
        if (caption.length < CAPTION_EVIDENCE_CHARS) continue;
        if (body.includes(caption)) leaks.push(`${page.file}: "${caption}"`);
      }
    }
    expect(
      leaks,
      'A caption is in the manifest for the labeller and must not be in the page. The corpus ' +
        'mimics a Confluence page whose visual content is not restated in prose — that is the ' +
        'only reason an image leg has anything to add over the text leg here.',
    ).toEqual([]);
  });

  it('keeps the section a subsection belongs to', () => {
    // The builder drops headings with nothing under them, because a table
    // stripped out of a section leaves a subject line entering the index with
    // no text behind it. Its first cut stopped at the next heading of ANY
    // depth, which deletes something else entirely: a `##` whose subsections
    // are all populated has nothing between itself and its first `###`. That
    // cost a section title on 22 of 66 pages — `koelner-dom.md` ran its `#`
    // title straight into `### Römische und merowingische Bischofskirche` and
    // the parent's subject line was on the page nowhere. P5c labels against
    // this text, so a lost section title is lost retrieval signal for the text
    // leg the image leg is measured against.
    //
    // A skipped level is what that looks like from outside the builder.
    const jumps: string[] = [];
    for (const page of pages) {
      const levels = [...pageBody(page.file).matchAll(/^(#{1,6}) (.*)$/gm)].map((m) => ({
        depth: m[1]!.length,
        text: m[2]!,
      }));
      for (let i = 0; i < levels.length - 1; i += 1) {
        if (levels[i + 1]!.depth - levels[i]!.depth > 1) {
          jumps.push(`${page.file}: "${levels[i]!.text}" (h${levels[i]!.depth}) → "${levels[i + 1]!.text}" (h${levels[i + 1]!.depth})`);
        }
      }
    }
    expect(
      jumps,
      'A heading level was skipped, which means the parent section title was deleted while its ' +
        'subsections survived. Drop a heading only when the NEXT heading is at the same or a ' +
        'shallower level.',
    ).toEqual([]);
  });

  it('keeps real prose around the images', () => {
    for (const page of pages) {
      const prose = pageBody(page.file)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/^#.*$/gm, '')
        .trim();
      expect(
        prose.length,
        `${page.file} has almost no text. An image-only page cannot be a text distractor and ` +
          'would not survive the seeder\'s 20-character floor either.',
      ).toBeGreaterThan(400);
    }
  });
});

describe('corpus-de-images — not wired into the eval runner', () => {
  it('is absent from CORPUS_DIRS and from every language', () => {
    // P5b adds the `--images` axis and wires this in deliberately. Until then
    // it must not join a corpus any recorded baseline was measured against:
    // `computeCorpusManifestSha` covers every directory in the list, so adding
    // one invalidates every baseline at once — which is the sha's job, but not
    // a cost to pay by accident in the PR that only vendors the bytes.
    expect([...CORPUS_DIRS]).not.toContain(IMAGE_CORPUS_DIR);
    for (const lang of ['en', 'de', undefined]) {
      expect([...corpusDirsForLanguage(lang)]).not.toContain(IMAGE_CORPUS_DIR);
    }
  });

  it('refuses the one language string that resolves onto it', () => {
    // `translatedCorpusDirs` derives its directory from the language name, and
    // this corpus lives inside that namespace under a name that is not a
    // language: `corpus-de-images`. So `--lang de-images` handed the image
    // corpus back as a translated corpus, and the run only died a step later
    // on a missing `fixture-de-images.json`. That is luck, not a guard, and
    // the loop above proved nothing about it.
    expect(() => corpusDirsForLanguage('de-images')).toThrow(/image corpus/i);
    expect(() => translatedCorpusDirs('de-images')).toThrow(/image corpus/i);
    // Ordinary translated languages are untouched.
    expect([...translatedCorpusDirs('de')]).toHaveLength(1);
  });
});
