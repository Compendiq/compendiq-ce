import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const mockQuery = vi.fn();
vi.mock('../../../core/db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  pickRetrievedImages,
  retrievedImagesCacheComponent,
  RETRIEVED_IMAGES_BYTE_BUDGET,
  type RetrievedImagePage,
} from './retrieved-images.js';
import { buildPng, buildJpeg, SVG_BYTES } from '../../../core/services/test-image-fixtures.js';
import type { ImageHit } from './image-leg-search.js';

/**
 * #1115 P4 — the pick step, against REAL bytes on a real temp
 * `ATTACHMENTS_DIR`.
 *
 * The whole subject of this module is "which file on disk, is it readable,
 * is it an image, does it fit" — every one of those questions is answered by
 * inspecting bytes, so a fixture that only looked right would make every
 * assertion here vacuous. Same principle as `image-validator.test.ts`, and
 * the same fixture builders.
 *
 * Only the database is mocked, at its own boundary: the page-identity lookup
 * is the one thing this service cannot get off disk.
 */

let tmpRoot: string;
const originalAttachmentsDir = process.env.ATTACHMENTS_DIR;

beforeEach(async () => {
  mockQuery.mockReset();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'retrieved-images-'));
  process.env.ATTACHMENTS_DIR = tmpRoot;
  // Default: every page is a Confluence page whose directory key is its
  // `confluence_id`.
  mockQuery.mockResolvedValue({ rows: [] });
});

afterAll(() => {
  if (originalAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
  else process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
});

/** Answer the page-identity lookup with these rows, by id. */
function pageRows(rows: Array<{ id: number; confluence_id: string | null; source: string }>) {
  mockQuery.mockResolvedValue({ rows });
}

/** Write bytes into the Confluence cache tree under `<dirKey>/<name>`. */
async function writeConfluenceFile(dirKey: string, name: string, bytes: Buffer) {
  await fs.mkdir(path.join(tmpRoot, dirKey), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, dirKey, name), bytes);
}

/** Write bytes into the local store under `local/<pageId>/<name>`. */
async function writeLocalFile(pageId: number, name: string, bytes: Buffer) {
  await fs.mkdir(path.join(tmpRoot, 'local', String(pageId)), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'local', String(pageId), name), bytes);
}

function hit(key: string, similarity: number, source: 'confluence' | 'local' = 'confluence'): ImageHit {
  return { source, key, similarity, attachmentUrl: `/api/attachments/x/${key}` };
}

function page(pageId: number, hits: ImageHit[]): RetrievedImagePage {
  return { pageId, imageHits: hits };
}

describe('pickRetrievedImages — the gate costs nothing when there is nothing to pick', () => {
  it('reads no page row and no byte when max is 0', async () => {
    // The knob's off switch. `rag_answer_max_images = 0` must not merely
    // discard the parts at the end — it must never touch the disk, which is
    // what makes "turn it off" a cost decision rather than a display one.
    const picked = await pickRetrievedImages([page(1, [hit('a.png', 0.9)])], { max: 0 });

    expect(picked.parts).toEqual([]);
    expect(picked.used).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('reads no page row when no result carries an image hit', async () => {
    const picked = await pickRetrievedImages(
      [{ pageId: 1 }, { pageId: 2, imageHits: [] }],
      { max: 4 },
    );

    expect(picked.parts).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('pickRetrievedImages — selection order', () => {
  it('is round-robin: every page contributes its best image before any page contributes a second', async () => {
    // The rule this function exists to enforce. A plain best-first sort over
    // the flattened hits would hand a gallery page all four slots and never
    // show the model the second page at all — image COUNT beating image
    // BREADTH, the same head dilution `MAX_IMAGE_HITS_PER_PAGE` and
    // best-chunk-only fusion each guard at their own layer.
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
    ]);
    await writeConfluenceFile('c1', 'a1.png', buildPng(4, 4));
    await writeConfluenceFile('c1', 'a2.png', buildPng(4, 4));
    await writeConfluenceFile('c1', 'a3.png', buildPng(4, 4));
    await writeConfluenceFile('c2', 'b1.png', buildPng(4, 4));

    const picked = await pickRetrievedImages(
      [
        page(1, [hit('a1.png', 0.91), hit('a2.png', 0.88), hit('a3.png', 0.87)]),
        page(2, [hit('b1.png', 0.55)]),
      ],
      { max: 2 },
    );

    expect(picked.used.map((u) => u.attachmentKey)).toEqual(['a1.png', 'b1.png']);
  });

  it('orders within a round by the hit similarity, not by the page rank', async () => {
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
    ]);
    await writeConfluenceFile('c1', 'a1.png', buildPng(4, 4));
    await writeConfluenceFile('c2', 'b1.png', buildPng(4, 4));

    const picked = await pickRetrievedImages(
      [page(1, [hit('a1.png', 0.40)]), page(2, [hit('b1.png', 0.92)])],
      { max: 2 },
    );

    expect(picked.used.map((u) => u.attachmentKey)).toEqual(['b1.png', 'a1.png']);
  });

  it('comes back to a page for its second image once every page has had one', async () => {
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
    ]);
    await writeConfluenceFile('c1', 'a1.png', buildPng(4, 4));
    await writeConfluenceFile('c1', 'a2.png', buildPng(4, 4));
    await writeConfluenceFile('c2', 'b1.png', buildPng(4, 4));

    const picked = await pickRetrievedImages(
      [page(1, [hit('a1.png', 0.91), hit('a2.png', 0.90)]), page(2, [hit('b1.png', 0.55)])],
      { max: 3 },
    );

    expect(picked.used.map((u) => u.attachmentKey)).toEqual(['a1.png', 'b1.png', 'a2.png']);
  });
});

describe('pickRetrievedImages — the parts it builds', () => {
  it('builds an image_url data URL from the SNIFFED format, and reports what it sent', async () => {
    // The format comes off the bytes, never off the name — the same rule
    // `prepare-image.ts` applies to an upload, for the same reason: a `.png`
    // holding JPEG bytes must be announced to the provider as JPEG or the
    // decoder on the other side is handed a lie.
    pageRows([{ id: 7, confluence_id: 'c7', source: 'confluence' }]);
    const jpeg = buildJpeg(20, 10);
    await writeConfluenceFile('c7', 'shot.png', jpeg);

    const picked = await pickRetrievedImages([page(7, [hit('shot.png', 0.7)])], { max: 2 });

    expect(picked.parts).toEqual([
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
    ]);
    expect(picked.used).toEqual([
      { pageId: 7, source: 'confluence', attachmentKey: 'shot.png', bytes: jpeg.length },
    ]);
    expect(picked.skipped).toEqual({ missing: 0, invalid: 0, overBudget: 0 });
  });

  it('reads the LOCAL store when the hit names it', async () => {
    pageRows([{ id: 9, confluence_id: null, source: 'standalone' }]);
    const png = buildPng(6, 6);
    await writeLocalFile(9, 'pasted.png', png);

    const picked = await pickRetrievedImages(
      [page(9, [hit('pasted.png', 0.8, 'local')])],
      { max: 2 },
    );

    expect(picked.used).toEqual([
      { pageId: 9, source: 'local', attachmentKey: 'pasted.png', bytes: png.length },
    ]);
  });

  it('keys the Confluence tree on pages.source, not on a non-null confluence_id', async () => {
    // `attachment-store.ts` documents this as the one derivation that must
    // never be inferred: a `source = 'standalone'` row with a non-null
    // `confluence_id` keys on the numeric id, and guessing `confluenceId ??
    // pageId` would read a DIFFERENT page's directory. The bytes live under
    // the numeric key here and nowhere else, so an inferring implementation
    // finds nothing.
    pageRows([{ id: 11, confluence_id: 'not-the-key', source: 'standalone' }]);
    await writeConfluenceFile('11', 'diagram.png', buildPng(5, 5));

    const picked = await pickRetrievedImages([page(11, [hit('diagram.png', 0.7)])], { max: 2 });

    expect(picked.used.map((u) => u.attachmentKey)).toEqual(['diagram.png']);
  });
});

describe('pickRetrievedImages — skip and count', () => {
  it('counts a file that is not on disk and keeps going', async () => {
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
    ]);
    await writeConfluenceFile('c2', 'b1.png', buildPng(4, 4));

    const picked = await pickRetrievedImages(
      [page(1, [hit('gone.png', 0.99)]), page(2, [hit('b1.png', 0.5)])],
      { max: 2 },
    );

    expect(picked.used.map((u) => u.attachmentKey)).toEqual(['b1.png']);
    expect(picked.skipped.missing).toBe(1);
  });

  it('counts a page the identity lookup did not answer for', async () => {
    // Deleted between retrieval and the pick, or a row retrieval saw that
    // this transaction does not. Without an identity there is no directory
    // to read, and reading the numeric id on spec would be the inference the
    // test above forbids.
    pageRows([]);

    const picked = await pickRetrievedImages([page(4, [hit('a.png', 0.9)])], { max: 2 });

    expect(picked.used).toEqual([]);
    expect(picked.skipped.missing).toBe(1);
  });

  it('counts bytes a vision encoder cannot read — SVG, or draw.io XML behind a .png', async () => {
    pageRows([{ id: 1, confluence_id: 'c1', source: 'confluence' }]);
    await writeConfluenceFile('c1', 'chart.png', Buffer.from('<mxfile host="app"></mxfile>'));
    await writeConfluenceFile('c1', 'logo.svg', SVG_BYTES);

    const picked = await pickRetrievedImages(
      [page(1, [hit('chart.png', 0.9), hit('logo.svg', 0.8)])],
      { max: 4 },
    );

    expect(picked.used).toEqual([]);
    expect(picked.skipped.invalid).toBe(2);
  });

  it('counts an image past MAX_IMAGE_DIMENSION rather than sending it', async () => {
    // The same ceiling a user-attached image clears, applied through the same
    // function. A corpus image is not a more trusted input than an upload —
    // it is a less trusted one, since nobody chose to send it.
    pageRows([{ id: 1, confluence_id: 'c1', source: 'confluence' }]);
    await writeConfluenceFile('c1', 'huge.png', buildPng(5000, 2));

    const picked = await pickRetrievedImages([page(1, [hit('huge.png', 0.9)])], { max: 2 });

    expect(picked.used).toEqual([]);
    expect(picked.skipped.invalid).toBe(1);
  });
});

describe('pickRetrievedImages — the byte budget', () => {
  it('stops at the budget and counts the image that did not fit', async () => {
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
    ]);
    const png = buildPng(4, 4);
    await writeConfluenceFile('c1', 'a1.png', png);
    await writeConfluenceFile('c2', 'b1.png', png);

    // Room for exactly one: base64 of one file, plus a byte.
    const oneFits = Buffer.from(png).toString('base64').length + 1;
    const picked = await pickRetrievedImages(
      [page(1, [hit('a1.png', 0.9)]), page(2, [hit('b1.png', 0.8)])],
      { max: 4, byteBudget: oneFits },
    );

    expect(picked.used.map((u) => u.attachmentKey)).toEqual(['a1.png']);
    expect(picked.skipped.overBudget).toBe(1);
  });

  it('sends nothing at all when the first image alone is over the budget', async () => {
    pageRows([{ id: 1, confluence_id: 'c1', source: 'confluence' }]);
    await writeConfluenceFile('c1', 'a1.png', buildPng(4, 4));

    const picked = await pickRetrievedImages([page(1, [hit('a1.png', 0.9)])], {
      max: 4,
      byteBudget: 4,
    });

    expect(picked.parts).toEqual([]);
    expect(picked.skipped.overBudget).toBe(1);
  });

  it('defaults to 6 MB of base64 — a constant, not a knob', async () => {
    // Deliberately not an admin setting: it is the backpressure bound for a
    // path that bypasses the LLM queue's own sizing, and an operator has no
    // way to measure the right value. The cap they DO get
    // (`rag_answer_max_images`) is a count, which is the thing they can
    // reason about. See the module docstring.
    expect(RETRIEVED_IMAGES_BYTE_BUDGET).toBe(6 * 1024 * 1024);
  });
});

describe('retrievedImagesCacheComponent', () => {
  const use = (pageId: number, attachmentKey: string, bytes = 100) =>
    ({ pageId, source: 'confluence' as const, attachmentKey, bytes });

  it('is undefined when nothing was sent, so a text-only answer keeps today’s key', () => {
    // Every deployment without a vision model is in this branch on every ask.
    // A component that was present-but-empty would move every existing key
    // and cold-start the answer cache for a change none of them took part in.
    expect(retrievedImagesCacheComponent([])).toBeUndefined();
  });

  it('separates a different set, a different order and a different count', () => {
    const a = retrievedImagesCacheComponent([use(1, 'a.png')]);
    expect(a).toBe(retrievedImagesCacheComponent([use(1, 'a.png')]));
    expect(a).not.toBe(retrievedImagesCacheComponent([use(1, 'b.png')]));
    expect(a).not.toBe(retrievedImagesCacheComponent([use(2, 'a.png')]));
    expect(a).not.toBe(retrievedImagesCacheComponent([use(1, 'a.png'), use(2, 'b.png')]));
    expect(retrievedImagesCacheComponent([use(1, 'a.png'), use(2, 'b.png')])).not.toBe(
      retrievedImagesCacheComponent([use(2, 'b.png'), use(1, 'a.png')]),
    );
  });

  it('separates the same file at a different size — an edited picture is different evidence', () => {
    expect(retrievedImagesCacheComponent([use(1, 'a.png', 100)])).not.toBe(
      retrievedImagesCacheComponent([use(1, 'a.png', 200)]),
    );
  });

  it('hashes the filenames rather than concatenating them into a Redis key', () => {
    // An attachment filename is free-form user content and the cache key is a
    // Redis key: spaces, newlines and colons all occur in real Confluence
    // attachment names.
    expect(retrievedImagesCacheComponent([use(1, 'a b:c\n.png')])).toMatch(/^1-[a-f0-9]{16}$/);
  });
});

describe('pickRetrievedImages — one lookup, whatever the page count', () => {
  it('resolves every candidate page identity in a single query', async () => {
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
      { id: 3, confluence_id: 'c3', source: 'confluence' },
    ]);
    await writeConfluenceFile('c1', 'a.png', buildPng(4, 4));
    await writeConfluenceFile('c2', 'b.png', buildPng(4, 4));
    await writeConfluenceFile('c3', 'c.png', buildPng(4, 4));

    await pickRetrievedImages(
      [page(1, [hit('a.png', 0.9)]), page(2, [hit('b.png', 0.8)]), page(3, [hit('c.png', 0.7)])],
      { max: 3 },
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
