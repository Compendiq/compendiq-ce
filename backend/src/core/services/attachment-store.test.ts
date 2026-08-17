import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fsReal from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * #1115 P0 — the hoisted attachment reader.
 *
 * Two things are under test here and they are different in kind:
 *
 *  1. `resolveAttachmentBytes`, the one NEW function: it resolves BOTH
 *     attachment trees from a page's identity and answers with the bytes plus
 *     the sniffed format, or null. Everything else in the module was MOVED out
 *     of `domains/confluence/services/attachment-handler.ts` unchanged, and
 *     its regression guard is that file's own untouched test suite.
 *
 *  2. The boundary that makes the new function safe. It is a SYSTEM read with
 *     no user ACL, so a route that reaches it is a page-visibility bypass. The
 *     last block walks `src/routes` and fails if any file there mentions it.
 */

const TMP_PREFIX = path.join(os.tmpdir(), 'attachment-store-test-');

/** PNG magic bytes + enough header for the dimension read. */
function pngBytes(): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(800, 16);
  buf.writeUInt32BE(600, 20);
  return buf;
}

/** RIFF….WEBP */
function webpBytes(): Buffer {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  return buf;
}

let tmpDir: string;
let store: typeof import('./attachment-store.js');

beforeAll(async () => {
  tmpDir = await fsReal.mkdtemp(TMP_PREFIX);
  process.env.ATTACHMENTS_DIR = tmpDir;
  store = await import('./attachment-store.js');
});

afterAll(async () => {
  delete process.env.ATTACHMENTS_DIR;
  await fsReal.rm(tmpDir, { recursive: true, force: true });
});

async function writeFileAt(relative: string, data: Buffer | string): Promise<string> {
  const full = path.join(tmpDir, relative);
  await fsReal.mkdir(path.dirname(full), { recursive: true });
  await fsReal.writeFile(full, data);
  return full;
}

describe('resolveAttachmentBytes (#1115)', () => {
  it('reads the Confluence cache tree keyed by confluence_id', async () => {
    await writeFileAt(path.join('44556677', 'diagram.png'), pngBytes());

    const found = await store.resolveAttachmentBytes({
      pageId: 12,
      confluenceId: '44556677',
      pageSource: 'confluence',
      source: 'confluence',
      key: 'diagram.png',
    });

    expect(found).not.toBeNull();
    expect(found!.bytes.equals(pngBytes())).toBe(true);
    expect(found!.sniffedFormat).toBe('png');
  });

  it('falls back to the numeric page id for a standalone page', async () => {
    // Pasted images on standalone pages live in the Confluence-style tree keyed
    // by the numeric PK — `confluence_id` is NULL there, and the paste/import
    // routes write the bytes under that PK and hand the editor
    // `/api/attachments/<numeric id>/<file>` (`pages-crud.ts:2723-2730`), which
    // is what lands in `body_html`. Getting this branch wrong makes every
    // pasted image invisible to the index.
    await writeFileAt(path.join('12', 'pasted-1.png'), pngBytes());

    const found = await store.resolveAttachmentBytes({
      pageId: 12,
      confluenceId: null,
      pageSource: 'standalone',
      source: 'confluence',
      key: 'pasted-1.png',
    });

    expect(found!.sniffedFormat).toBe('png');
  });

  it('keys the Confluence tree off pages.source, not off "is confluence_id null"', async () => {
    // Review r3. Two places already own this derivation and BOTH branch on
    // `pages.source`: `pages-crud.ts:2723-2728` (the paste/import writer) and
    // `parentKeyFor` (`page-relocate-service.ts:140-142`). `confluenceId ??
    // pageId` is a THIRD predicate, and it disagrees with them on exactly one
    // row shape — `source = 'standalone'` with a non-null `confluence_id`.
    //
    // No writer produces that shape today (both relocate directions set the
    // two columns in one UPDATE), so this is latent rather than live. It is
    // pinned anyway because the failure is the bad kind: the reader lands in
    // ANOTHER page's directory, and a same-named file there returns the wrong
    // bytes under the right key rather than an honest miss. The two files
    // below share a name for that reason.
    await writeFileAt(path.join('30303030', 'shared-name.png'), pngBytes());
    await writeFileAt(path.join('61', 'shared-name.png'), webpBytes());

    const found = await store.resolveAttachmentBytes({
      pageId: 61,
      confluenceId: '30303030',
      pageSource: 'standalone',
      source: 'confluence',
      key: 'shared-name.png',
    });

    // The numeric PK's file (webp), never the confluence_id's (png).
    expect(found!.sniffedFormat).toBe('webp');
  });

  it('reads the key EXACTLY: a percent-encoded name resolves nothing, and a literal one still does', async () => {
    // The trap P2's enumerator walks into. Every `<img src>` carries
    // `encodeURIComponent(filename)` (`content-converter.ts:366`, `:386`,
    // `:410`; `pages-crud.ts:2730`) while the bytes are written under the RAW
    // name, so `attachment_key` is `decodeURIComponent(basename(src))`. Take
    // the basename literally and every filename with a space or a non-ASCII
    // character misses — and misses SILENTLY, answering the same `null` as an
    // absent file, which is why this is pinned rather than commented.
    await writeFileAt(path.join('44556677', 'Screen shot.png'), pngBytes());
    // A `%` is a legal filename character (`isStorableAttachmentFilename`
    // rejects only NUL, dotfiles and path separators), so a file really can be
    // named `a%20b.png`. That is why the decode belongs in the enumerator and
    // NOT in this function: decoding here would serve `a b.png`'s bytes under
    // this file's key.
    await writeFileAt(path.join('44556677', 'a%20b.png'), webpBytes());

    const identity = {
      pageId: 12,
      confluenceId: '44556677',
      pageSource: 'confluence' as const,
      source: 'confluence' as const,
    };

    expect(await store.resolveAttachmentBytes({ ...identity, key: 'Screen%20shot.png' })).toBeNull();

    const decoded = await store.resolveAttachmentBytes({ ...identity, key: 'Screen shot.png' });
    expect(decoded!.sniffedFormat).toBe('png');

    const literal = await store.resolveAttachmentBytes({ ...identity, key: 'a%20b.png' });
    expect(literal!.sniffedFormat).toBe('webp');
  });

  it('reads the local store at local/<page_id>/<filename>', async () => {
    await writeFileAt(path.join('local', '31', 'photo.webp'), webpBytes());

    const found = await store.resolveAttachmentBytes({
      pageId: 31,
      confluenceId: null,
      pageSource: 'standalone',
      source: 'local',
      key: 'photo.webp',
    });

    expect(found!.sniffedFormat).toBe('webp');
  });

  it('does not consult local_attachments — it is a filesystem read, by design', async () => {
    // No DB row is inserted anywhere in this file, and the local file above
    // resolves anyway. That is the contract: `getLocalAttachment` is the
    // ACL-checked, DB-backed reader for routes; this one is for the embedding
    // worker and for the answer path AFTER retrieval has applied the
    // visibility predicate. The guard for the difference is the routes walk
    // at the bottom of this file.
    await writeFileAt(path.join('local', '99', 'no-row.png'), pngBytes());

    const found = await store.resolveAttachmentBytes({
      pageId: 99,
      confluenceId: null,
      pageSource: 'standalone',
      source: 'local',
      key: 'no-row.png',
    });

    expect(found!.bytes.length).toBeGreaterThan(0);
  });

  it('reports a draw.io XML-in-.png as unsniffable rather than guessing from the extension', async () => {
    // Confluence's draw.io macro exports a `.png` that is sometimes the raw
    // `<mxfile>` XML. `sniffImageFormat` returns null for it (#1154 never
    // trusts an extension), and the caller must be able to SEE that so it can
    // skip and count the file — returning null for the whole call would be
    // indistinguishable from "no such attachment".
    await writeFileAt(path.join('44556677', 'flow.png'), '<mxfile host="Electron"><diagram/></mxfile>');

    const found = await store.resolveAttachmentBytes({
      pageId: 12,
      confluenceId: '44556677',
      pageSource: 'confluence',
      source: 'confluence',
      key: 'flow.png',
    });

    expect(found).not.toBeNull();
    expect(found!.sniffedFormat).toBeNull();
    expect(found!.bytes.toString('utf8')).toContain('mxfile');
  });

  it('refuses a traversing key instead of collapsing it to a basename', async () => {
    // `path.basename('../secret.png')` is `secret.png`, so a basename-and-read
    // implementation would quietly return a DIFFERENT file that happens to
    // share the name — the wrong bytes in the index, under the right key.
    await writeFileAt('secret.png', pngBytes());
    await writeFileAt(path.join('44556677', 'secret.png'), webpBytes());

    for (const key of ['../secret.png', '../../secret.png', 'sub/secret.png', '/etc/passwd']) {
      const found = await store.resolveAttachmentBytes({
        pageId: 12,
        confluenceId: '44556677',
        pageSource: 'confluence',
        source: 'confluence',
        key,
      });
      expect(found, key).toBeNull();
    }
  });

  it('refuses a traversing key in the local store too', async () => {
    await writeFileAt(path.join('local', 'other.png'), pngBytes());

    const found = await store.resolveAttachmentBytes({
      pageId: 31,
      confluenceId: null,
      pageSource: 'standalone',
      source: 'local',
      key: '../other.png',
    });

    expect(found).toBeNull();
  });

  it('refuses a page identity that could not name a directory', async () => {
    const found = await store.resolveAttachmentBytes({
      pageId: 12,
      confluenceId: '../../etc',
      pageSource: 'confluence',
      source: 'confluence',
      key: 'passwd',
    });
    expect(found).toBeNull();
  });

  it('answers null for a missing file and a missing directory', async () => {
    expect(await store.resolveAttachmentBytes({
      pageId: 12, confluenceId: '44556677', pageSource: 'confluence', source: 'confluence', key: 'absent.png',
    })).toBeNull();

    expect(await store.resolveAttachmentBytes({
      pageId: 777, confluenceId: '99887766', pageSource: 'confluence', source: 'confluence', key: 'absent.png',
    })).toBeNull();

    expect(await store.resolveAttachmentBytes({
      pageId: 777, confluenceId: null, pageSource: 'standalone', source: 'local', key: 'absent.png',
    })).toBeNull();
  });
});

describe('the hoist is a move, not a copy', () => {
  it('re-exports the same function objects from attachment-handler', async () => {
    // The five importers of `attachment-handler.ts` do not move in P0, so the
    // confluence module must keep exporting the reader half. Identity — not
    // "both exist" — is what proves there is one implementation: a copy would
    // pass a behavioural test on both sides and then drift.
    const handler = await import('../../domains/confluence/services/attachment-handler.js');

    expect(handler.readAttachment).toBe(store.readAttachment);
    expect(handler.listCachedAttachments).toBe(store.listCachedAttachments);
    expect(handler.readCachedAttachmentFile).toBe(store.readCachedAttachmentFile);
    expect(handler.getMimeType).toBe(store.getMimeType);
    expect(handler.attachmentCacheDir).toBe(store.attachmentCacheDir);
    expect(handler.isStorableAttachmentFilename).toBe(store.isStorableAttachmentFilename);
  });
});

describe('the record agrees with the code about where the bytes are', () => {
  /**
   * Review r3, and the same class of defect as the round-2 `attachment_key`
   * encoding fix one level up: this PR ships no behaviour, so its record IS the
   * deliverable, and P2 builds its enumerator from it. Three shipped statements
   * claimed the `/api/local-attachments` prefix was "a render-time rewrite that
   * never appears in `body_html`" and concluded that a backend consumer should
   * branch on `pages.confluence_id IS NULL`.
   *
   * `relocateToLocal` does the opposite: it copies the cached Confluence
   * attachments into the LOCAL store, rewrites the body to
   * `/api/local-attachments/<page.id>/` and persists that body in the same
   * UPDATE that nulls `confluence_id`. So the `confluence_id IS NULL` rule
   * sends the read at the Confluence tree for exactly the pages whose bytes
   * were moved out of it — a silent miss, since a wrong key and an absent file
   * both answer `null`.
   *
   * Two anchors, so this fails from either side: the code half (the destination
   * prefix `relocateToLocal` writes, whose output shape
   * `page-relocate-refs.test.ts` pins) and the record half (the retired claim).
   */
  const repoRoot = path.join(__dirname, '..', '..', '..', '..');
  const recordFiles = [
    'backend/src/core/services/attachment-store.ts',
    'backend/src/core/db/migrations/093_page_image_embeddings.sql',
    'docs/ARCHITECTURE-DECISIONS.md',
    'docs/architecture/03-backend-domains.md',
    'docs/superpowers/specs/2026-08-16-multimodal-image-retrieval-design.md',
  ];

  /** The two phrasings the retired claim shipped in, and nothing broader. */
  const RETIRED_CLAIM = /never appears in|render-?time (only|rewrite)/;

  it('relocateToLocal still writes the local prefix into the body it persists', () => {
    const src = readFileSync(
      path.join(repoRoot, 'backend/src/domains/knowledge/services/page-relocate-service.ts'),
      'utf8',
    );
    expect(src).toContain('`/api/local-attachments/${page.id}/`');
  });

  it('no shipped record calls the local prefix render-time or absent from body_html', () => {
    for (const rel of recordFiles) {
      const text = readFileSync(path.join(repoRoot, rel), 'utf8');
      // Sentence-scoped, so an unrelated "render-time" elsewhere in a 2000-line
      // ADR file cannot trip it.
      for (const sentence of text.split(/(?<=[.;])\s+/)) {
        if (!/local-attachments/.test(sentence)) continue;
        expect(
          RETIRED_CLAIM.test(sentence),
          `${rel}: "${sentence.trim().slice(0, 160)}" — ` +
            'relocateToLocal persists `/api/local-attachments/<page_id>/` into ' +
            'pages.body_html (page-relocate-service.ts:692-696, :729-752). The ' +
            'store follows the URL PREFIX, never `confluence_id IS NULL`.',
        ).toBe(false);
      }
    }
  });
});

describe('the system reader stays out of the request path', () => {
  /**
   * `resolveAttachmentBytes` applies NO authorisation. Everything that serves
   * attachment bytes to a user today goes through a gate — `getLocalAttachment`
   * calls `assertLocalPageAccess`, and `routes/confluence/attachments.ts`
   * checks page access before `readAttachment` — so a route reaching this
   * function directly would be a page-visibility bypass with no error to show
   * for it.
   *
   * Discovered rather than enumerated, in the shape `query-instruction.test.ts`
   * settled on: a hardcoded list of route files cannot fail for a file that
   * does not exist yet, which is exactly the regression worth catching.
   */
  function routeFilesMentioning(needle: string): string[] {
    const routesRoot = path.join(__dirname, '..', '..', 'routes');
    const hits: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(full, relPath);
          continue;
        }
        if (!/\.m?ts$/.test(entry.name)) continue;
        if (readFileSync(full, 'utf8').includes(needle)) hits.push(relPath);
      }
    };
    walk(routesRoot, '');
    return hits.sort();
  }

  it('finds the routes tree', () => {
    // A walk that silently found nothing would pass every assertion below.
    expect(routeFilesMentioning('fastify').length).toBeGreaterThan(10);
  });

  it('is not reachable from any file under src/routes', () => {
    expect(
      routeFilesMentioning('resolveAttachmentBytes'),
      'resolveAttachmentBytes performs no ACL check. A route needs the ' +
        'gated readers instead: getLocalAttachment (local pages) or ' +
        'readAttachment behind the route\'s own page-access check.',
    ).toEqual([]);
  });

  it('is not imported from any file under src/routes, under any local name', () => {
    expect(routeFilesMentioning('attachment-store.js')).toEqual([]);
  });
});
