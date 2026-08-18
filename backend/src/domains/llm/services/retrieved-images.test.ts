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
import { MAX_IMAGE_BYTES } from '../../../core/services/image-validator.js';
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

/**
 * A valid PNG whose bytes are unique to `tag`, at a length that does not
 * depend on it.
 *
 * Selection-order and budget cases need DISTINCT pictures: identical bytes
 * are one piece of evidence however many pages carry them, and the pick
 * deliberately attaches such a set once (see the dedupe block below). The
 * padding rides after `IEND`, which the validator's fixed-offset PNG header
 * read ignores.
 */
function distinctPng(tag: string): Buffer {
  return Buffer.concat([buildPng(4, 4), Buffer.from(tag.padEnd(8, '.'), 'ascii')]);
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
    await writeConfluenceFile('c1', 'a1.png', distinctPng('a1'));
    await writeConfluenceFile('c1', 'a2.png', distinctPng('a2'));
    await writeConfluenceFile('c1', 'a3.png', distinctPng('a3'));
    await writeConfluenceFile('c2', 'b1.png', distinctPng('b1'));

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
    await writeConfluenceFile('c1', 'a1.png', distinctPng('a1'));
    await writeConfluenceFile('c2', 'b1.png', distinctPng('b1'));

    const picked = await pickRetrievedImages(
      [page(1, [hit('a1.png', 0.40)]), page(2, [hit('b1.png', 0.92)])],
      { max: 2 },
    );

    expect(picked.used.map((u) => u.attachmentKey)).toEqual(['b1.png', 'a1.png']);
  });

  it('takes a page’s BEST image even when its hits arrive out of order', async () => {
    // The per-page re-sort in `orderRetrievedImageCandidates` is defensive —
    // P3 already emits `imageHits` best-first — and nothing exercised it, so
    // deleting it left the suite green while the contract silently became
    // "the FIRST image per page" instead of "the best". At `max: 1` the two
    // read differently for the first time: with the sort the model is shown
    // the 0.93 picture, without it the 0.41 one that happens to be listed
    // first, and D8 forbids any signal that the wrong picture was chosen.
    pageRows([{ id: 1, confluence_id: 'c1', source: 'confluence' }]);
    await writeConfluenceFile('c1', 'weak.png', distinctPng('weak'));
    await writeConfluenceFile('c1', 'best.png', distinctPng('best'));

    const picked = await pickRetrievedImages(
      [page(1, [hit('weak.png', 0.41), hit('best.png', 0.93)])],
      { max: 1 },
    );

    expect(picked.used.map((u) => u.attachmentKey)).toEqual(['best.png']);
  });

  it('comes back to a page for its second image once every page has had one', async () => {
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
    ]);
    await writeConfluenceFile('c1', 'a1.png', distinctPng('a1'));
    await writeConfluenceFile('c1', 'a2.png', distinctPng('a2'));
    await writeConfluenceFile('c2', 'b1.png', distinctPng('b1'));

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
    expect(picked.skipped).toEqual({ missing: 0, invalid: 0, overBudget: 0, duplicate: 0 });
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

  it('answers empty when the identity lookup itself FAILS, rather than throwing', async () => {
    // Review r2. The docstring promises "never throws: an answer must not
    // fail because a picture could not be read", and this is the one path in
    // the function that can — every other failure is already a value (`null`
    // bytes, a `validateImage` throw caught beside it). Nothing made
    // `mockQuery` reject, so turning the soft-fail into a rethrow left this
    // file and `llm-ask.test.ts` green, and the blast radius is not a missing
    // picture: the pick runs before the SSE headers are written, so the
    // rejection leaves the handler and Fastify answers 500 — a transient DB
    // error would fail the whole ask instead of degrading it to text-only.
    mockQuery.mockRejectedValue(new Error('connection terminated'));

    await expect(
      pickRetrievedImages([page(1, [hit('a.png', 0.9)])], { max: 2 }),
    ).resolves.toEqual({
      parts: [],
      used: [],
      skipped: { missing: 0, invalid: 0, overBudget: 0, duplicate: 0 },
    });
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

  it('refuses a file past MAX_IMAGE_BYTES WITHOUT reading it', async () => {
    // Review r3. The byte budget bounds what is SENT and `validateImage`
    // bounds what is ACCEPTED — but before this, nothing bounded what was
    // READ: `resolveAttachmentBytes` calls `fs.readFile` with no ceiling and
    // the length check runs after the whole buffer exists. The reachable state
    // is the one `skipped.invalid` already names — the bytes on disk are no
    // longer the bytes the intake indexed under the same 5 MB gate — and
    // unlike the intake worker this loop runs on the REQUEST path.
    //
    // The assertion is on the READ, not on the verdict: the verdict was
    // already right (`validateImage` throws on the length), so a test that
    // only checked `skipped.invalid` passes with or without the stat.
    const readFile = vi.spyOn(fs, 'readFile');
    try {
      pageRows([{ id: 1, confluence_id: 'c1', source: 'confluence' }]);
      // A real PNG header so nothing else can be what refuses it, padded past
      // the ceiling.
      const bloated = Buffer.concat([buildPng(4, 4), Buffer.alloc(MAX_IMAGE_BYTES + 1)]);
      await writeConfluenceFile('c1', 'replaced.png', bloated);

      const picked = await pickRetrievedImages([page(1, [hit('replaced.png', 0.9)])], { max: 2 });

      expect(picked.used).toEqual([]);
      expect(picked.skipped.invalid).toBe(1);
      expect(
        readFile.mock.calls.some(([p]) => String(p).endsWith('replaced.png')),
      ).toBe(false);
    } finally {
      // `finally`, not a trailing call: a failing assertion above would
      // otherwise leave the spy installed for every test after this one in
      // the file, turning one red into eight.
      readFile.mockRestore();
    }
  });

  it('reads on anyway when the size cannot be established — the stat fails OPEN', async () => {
    // A stat a hardened filesystem refuses is not evidence that the file is
    // too big, and turning "unknown" into a skip would delete a perfectly
    // readable picture. The read behind it is still bounded by the checks the
    // test above leaves in place. (The absent-file case reaches the same
    // `null` and is pinned by "counts a file that is not on disk" above, which
    // still reports `missing` rather than `invalid`.)
    const stat = vi.spyOn(fs, 'stat').mockRejectedValue(new Error('EACCES'));
    try {
      pageRows([{ id: 1, confluence_id: 'c1', source: 'confluence' }]);
      await writeConfluenceFile('c1', 'fine.png', buildPng(4, 4));

      const picked = await pickRetrievedImages([page(1, [hit('fine.png', 0.9)])], { max: 2 });

      expect(picked.used.map((u) => u.attachmentKey)).toEqual(['fine.png']);
    } finally {
      stat.mockRestore();
    }
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
    // Distinct bytes at an identical length, so the budget arithmetic is
    // clean and the dedupe below is not what is being measured.
    await writeConfluenceFile('c1', 'a1.png', distinctPng('a1'));
    await writeConfluenceFile('c2', 'b1.png', distinctPng('b1'));

    // Room for exactly one: base64 of one file, plus a byte.
    const oneFits = distinctPng('a1').toString('base64').length + 1;
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

  it('keeps going past an image that did not fit, and takes a smaller one that does', async () => {
    // Review r1. The loop used to `break` here, on the reasoning that every
    // further candidate would cost a disk read to reach the same verdict —
    // which is only true if every remaining candidate is at least as large.
    // Candidates come from different pages and differ arbitrarily in size, so
    // a big picture ranked first silently deleted a small one on the NEXT
    // page that fits with room to spare. On an all-`imageTextSynthesized`
    // set that is the difference between an answered turn and an
    // `image_only_context` refusal, on a deployment where a usable picture
    // was one candidate away.
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
    ]);
    const small = buildPng(4, 4);
    const big = Buffer.concat([buildPng(8, 8), Buffer.alloc(40_000)]);
    await writeConfluenceFile('c1', 'big.png', big);
    await writeConfluenceFile('c2', 'small.png', small);

    const picked = await pickRetrievedImages(
      [page(1, [hit('big.png', 0.9)]), page(2, [hit('small.png', 0.5)])],
      { max: 4, byteBudget: small.toString('base64').length + 10 },
    );

    expect(picked.used.map((u) => u.attachmentKey)).toEqual(['small.png']);
    expect(picked.skipped.overBudget).toBe(1);
  });

  it('counts EVERY candidate that did not fit, not just the first', async () => {
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
    ]);
    await writeConfluenceFile('c1', 'a.png', Buffer.concat([buildPng(4, 4), Buffer.alloc(40_000)]));
    await writeConfluenceFile('c2', 'b.png', Buffer.concat([buildPng(5, 5), Buffer.alloc(40_000)]));

    const picked = await pickRetrievedImages(
      [page(1, [hit('a.png', 0.9)]), page(2, [hit('b.png', 0.5)])],
      { max: 4, byteBudget: 8 },
    );

    expect(picked.used).toEqual([]);
    expect(picked.skipped.overBudget).toBe(2);
  });

  it('APPLIES the default budget — the only bound the production call path has', async () => {
    // `llm-ask.ts` never passes `byteBudget`, so production rides entirely on
    // the `?? RETRIEVED_IMAGES_BYTE_BUDGET` fallback. Review r1 mutated that
    // to `Number.MAX_SAFE_INTEGER` and the whole suite stayed green: the two
    // behavioural budget cases above each pass an explicit budget, and the
    // constant's own assertion below reads the value without ever applying
    // it. This is the case that fails under that mutation.
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
    ]);
    // Two images that are each comfortably under `MAX_IMAGE_BYTES` and whose
    // base64 together is comfortably over the budget.
    const fat = (tag: string) => Buffer.concat([distinctPng(tag), Buffer.alloc(4_000_000)]);
    await writeConfluenceFile('c1', 'a.png', fat('a'));
    await writeConfluenceFile('c2', 'b.png', fat('b'));

    const picked = await pickRetrievedImages(
      [page(1, [hit('a.png', 0.9)]), page(2, [hit('b.png', 0.8)])],
      { max: 4 },
    );

    expect(picked.used).toHaveLength(1);
    expect(picked.skipped.overBudget).toBe(1);
  });

  it('is the base64 of exactly one MAX_IMAGE_BYTES image — derived, so the two cannot drift', async () => {
    // Deliberately not an admin setting: it is the backpressure bound for a
    // path that bypasses the LLM queue's own sizing, and an operator has no
    // way to measure the right value. The cap they DO get
    // (`rag_answer_max_images`) is a count, which is the thing they can
    // reason about. See the module docstring.
    //
    // Review r1: it used to be a literal 6 MiB, described as "roughly one
    // `MAX_IMAGE_BYTES` image at ~1.37x inflation" — which is 14% short, so
    // the largest images P2's intake admits were indexed, ranked and shown as
    // sources while being categorically unattachable. The assertion is on the
    // PROPERTY rather than on a number, because the number is the part that
    // drifted.
    expect(RETRIEVED_IMAGES_BYTE_BUDGET).toBeGreaterThanOrEqual(
      Buffer.alloc(MAX_IMAGE_BYTES).toString('base64').length,
    );
  });
});

describe('pickRetrievedImages — byte-identical pictures', () => {
  it('takes a shared image once, however many pages carry it', async () => {
    // Review r1. P2 indexes every referenced image per PAGE, so a diagram
    // reused across three pages is three rows with identical bytes — and
    // therefore an identical embedding and an identical similarity, which
    // sorts them adjacent in round 0. At the default cap of 2 the model got
    // the same picture twice: two slots and double the byte budget for one
    // piece of evidence, which is exactly the image-COUNT-beats-image-BREADTH
    // failure the round-robin above exists to prevent, reached from inside a
    // single round.
    pageRows([
      { id: 1, confluence_id: 'c1', source: 'confluence' },
      { id: 2, confluence_id: 'c2', source: 'confluence' },
      { id: 3, confluence_id: 'c3', source: 'confluence' },
    ]);
    const shared = buildPng(6, 6);
    const other = buildPng(7, 7);
    await writeConfluenceFile('c1', 'diagram.png', shared);
    await writeConfluenceFile('c2', 'diagram.png', shared);
    await writeConfluenceFile('c3', 'other.png', other);

    const picked = await pickRetrievedImages(
      [
        page(1, [hit('diagram.png', 0.90)]),
        page(2, [hit('diagram.png', 0.90)]),
        page(3, [hit('other.png', 0.55)]),
      ],
      { max: 2 },
    );

    expect(picked.used.map((u) => u.pageId)).toEqual([1, 3]);
    expect(picked.skipped.duplicate).toBe(1);
  });
});

describe('retrievedImagesCacheComponent', () => {
  const use = (pageId: number, attachmentKey: string, bytes = 100) =>
    ({ pageId, source: 'confluence' as const, attachmentKey, bytes });

  it('is undefined when nothing was sent — the absence of images is not a 0-length set', () => {
    // Every deployment without a vision model is in this branch on every ask.
    //
    // Review r1 corrected what this buys: it is NOT key stability.
    // `hashLlmInputs` writes a `\x00` separator per component, so passing a
    // 15th component at all moves every pre-P4 key whether or not it is
    // empty, and every deployment cold-starts its answer cache once for one
    // `LLM_CACHE_TTL`. What `undefined` buys is that "no images" cannot be
    // spelled the same way as some future "0 images, deliberately", and that
    // the component stays absent from the key derivation's own reading.
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
    await writeConfluenceFile('c1', 'a.png', distinctPng('a'));
    await writeConfluenceFile('c2', 'b.png', distinctPng('b'));
    await writeConfluenceFile('c3', 'c.png', distinctPng('c'));

    await pickRetrievedImages(
      [page(1, [hit('a.png', 0.9)]), page(2, [hit('b.png', 0.8)]), page(3, [hit('c.png', 0.7)])],
      { max: 3 },
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
