/**
 * #1349 — pure halves of the orphan sweep: the raw-string URL reference
 * collector that feeds the keep-set, the image-like candidate predicate,
 * and the keep-set event-loop yield. No DB, no filesystem. The walk itself
 * is covered against real Postgres and a temp tree in
 * attachment-sweep-service.integration.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildAttachmentKeepSets,
  collectAttachmentUrlReferences,
  isImageLikeCandidate,
  KEEP_SET_YIELD_EVERY,
  forEachRowYielding,
  type AttachmentKeepSets,
} from './attachment-sweep-service.js';

/**
 * The two keep-set guards at the bottom drive the REAL
 * `buildAttachmentKeepSets` with the two boundaries it reads replaced: the
 * pages `SELECT` hands out one synthetic batch and every other keep-set
 * `SELECT` comes back empty, and `getExpectedAttachmentFilenames` records
 * which body it was handed instead of parsing it (and, for the fail-closed
 * guard, throws for one nominated body — see `throwFor`). Both mocks spread
 * the real module, so nothing else in the graph is stubbed and no other test
 * in this file changes meaning: the pure collectors below never reach either
 * boundary.
 */
const keepSetProbe = vi.hoisted(() => ({
  /** Rows the mocked pages `SELECT` returns, set by the test. */
  pageRows: [] as Record<string, unknown>[],
  /** Enumerator bodies and `tick` markers, in the order they happened. */
  timeline: [] as string[],
  /**
   * Body the mocked enumerator THROWS on, standing in for the one content
   * failure the real parser has: a pathological nesting depth blowing the
   * JSDOM recursion (`RangeError`, probed in review r2). `null` = never throw.
   */
  throwFor: null as string | null,
}));

vi.mock('../../../core/db/postgres.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/db/postgres.js')>()),
  query: async (sql: string) => ({
    rows: sql.includes('FROM pages WHERE id >') ? keepSetProbe.pageRows : [],
    rowCount: 0,
  }),
}));

vi.mock('./attachment-handler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attachment-handler.js')>()),
  getExpectedAttachmentFilenames: (body: string) => {
    keepSetProbe.timeline.push(body);
    if (keepSetProbe.throwFor !== null && body === keepSetProbe.throwFor) {
      throw new RangeError('Maximum call stack size exceeded');
    }
    return [] as string[];
  },
}));

function emptySets(): AttachmentKeepSets {
  return { confluence: new Set<string>(), local: new Set<string>() };
}

describe('collectAttachmentUrlReferences (#1349 keep-set feeder)', () => {
  it('collects img src references into the store the URL prefix names', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(
      '<img src="/api/attachments/90001/keep.png"><img src="/api/local-attachments/7/diagram.png">',
      sets,
    );
    expect(sets.confluence.has('keep.png')).toBe(true);
    expect(sets.local.has('diagram.png')).toBe(true);
    expect(sets.local.has('keep.png')).toBe(false);
  });

  it('collects anchor href references too (#1169: Markdown import produces <a> refs)', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(
      '<a href="/api/attachments/90001/manual.pdf">the manual</a>',
      sets,
    );
    expect(sets.confluence.has('manual.pdf')).toBe(true);
  });

  it('decodes the filename segment and keeps the raw spelling as well', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('<img src="/api/attachments/1/Screen%20shot.png">', sets);
    // The bytes sit on disk under the DECODED name; a file literally named
    // with % sequences is also kept, because the collector cannot know which.
    expect(sets.confluence.has('Screen shot.png')).toBe(true);
    expect(sets.confluence.has('Screen%20shot.png')).toBe(true);
  });

  it('strips query strings and fragments before keying', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('<img src="/api/attachments/1/a.png?v=2#frag">', sets);
    expect(sets.confluence.has('a.png')).toBe(true);
    expect(sets.confluence.has('a.png?v=2')).toBe(false);
  });

  it('works on raw text without any HTML structure (body_storage, plain text)', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(
      'see /api/attachments/42/pasted.png and /api/local-attachments/42/x.webp for details',
      sets,
    );
    expect(sets.confluence.has('pasted.png')).toBe(true);
    expect(sets.local.has('x.webp')).toBe(true);
  });

  it('tolerates null/undefined bodies and a lone % in the name', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(null, sets);
    collectAttachmentUrlReferences(undefined, sets);
    collectAttachmentUrlReferences('<img src="/api/attachments/1/100%.png">', sets);
    expect(sets.confluence.has('100%.png')).toBe(true);
  });

  it('keeps the full decoded name for every character encodeURIComponent leaves literal (review r2)', () => {
    // Every URL writer in the product goes through encodeURIComponent, which
    // leaves ! ' ( ) * ~ (and - _ .) UNENCODED — so these characters appear
    // literally in the URL. A filename class that terminates at any of them
    // records a truncated prefix, the on-disk file misses the keep-set, and
    // a live sweep deletes a referenced file. The apostrophe was the one the
    // original class excluded.
    for (const name of ["John's notes.png", 'shot!.png', 'fig (1).png', 'star*max.png', 'wave~2.png']) {
      const sets = emptySets();
      collectAttachmentUrlReferences(
        `<img src="/api/attachments/90001/${encodeURIComponent(name)}">`,
        sets,
      );
      expect(sets.confluence.has(name), `keep-set must hold ${JSON.stringify(name)}`).toBe(true);
    }
  });

  it('a single-quoted attribute spelling still lands the trimmed name (over-keeping is safe)', () => {
    // With ' inside the filename class, a single-quoted attribute drags the
    // closing quote into the match; the punctuation trim adds the clean
    // variant, and keeping the quoted spelling as well only over-keeps.
    const sets = emptySets();
    collectAttachmentUrlReferences("<img src='/api/attachments/90001/plain.png'>", sets);
    expect(sets.confluence.has('plain.png')).toBe(true);
  });

  // #1524 — the punctuation trim was the one conservatism widening in this
  // collector that no cell could falsify: replacing the loop body with
  // `void name;` left all 71 sweep tests green. The single-quoted spellings
  // above cannot falsify it, because the apostrophe-truncated-prefix loop
  // below produces the same clean name for them. The trim is the SOLE
  // producer of the clean name for a PLAIN-TEXT spelling that drags trailing
  // punctuation into the match — prose or a Markdown-imported body writing
  // `see /api/attachments/90001/a.png).` — because `)` and `.` are both
  // inside the filename class, the match sits outside any quoted attribute
  // (so there is no continuation and no closing delimiter), and nothing else
  // in the pipeline strips a trailing character. Without it the keep-set
  // holds only `a.png).`, the on-disk `a.png` is judged an orphan and a live
  // run deletes a referenced file.
  it('trims trailing punctuation off a PLAIN-TEXT spelling — the only producer of the clean name there (#1524)', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('see /api/attachments/90001/a.png). Also /api/local-attachments/7/b.webp,', sets);
    expect(sets.confluence.has('a.png')).toBe(true);
    expect(sets.local.has('b.webp')).toBe(true);
    // The untrimmed spellings stay too — over-keeping is the safe direction.
    expect(sets.confluence.has('a.png).')).toBe(true);
  });

  it('a single-quoted attribute with no space before the self-closing slash still lands the name (review r3)', () => {
    // `src='…/a.png'/>` drags `'/` into the match: `/` is not in the trim set,
    // so the trimmed variant still ends in a slash and the basename filter
    // drops the whole spelling — the pre-r2 regex terminated at the quote and
    // kept `a.png`, so r2's widening was a substitution here, not an addition.
    // The apostrophe-truncated prefix is re-added as one more variant, which
    // restores the keep-set as a superset of both regimes.
    const sets = emptySets();
    collectAttachmentUrlReferences("<img src='/api/attachments/90001/a.png'/>", sets);
    expect(sets.confluence.has('a.png')).toBe(true);
    collectAttachmentUrlReferences("[link](/api/local-attachments/7/b.png'/extra)", sets);
    expect(sets.local.has('b.png')).toBe(true);
  });

  it("the truncated prefix is ADDED, never substituted — a real apostrophe-named file keeps its full name (review r2's case)", () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('<img src="/api/attachments/1/John\'s%20notes.png">', sets);
    expect(sets.confluence.has("John's notes.png")).toBe(true);
  });

  it('adds the entity-decoded spelling — a decoded URL pasted as text is serialised with & as &amp; (review r1)', () => {
    // body_html is HTML: pasting a DECODED attachment URL as plain text makes
    // the serializer store `&` as `&amp;`, while the disk holds `a&b.png`.
    // Product-written URLs are unaffected (encodeURIComponent turns & into
    // %26), so this spelling can be the ONLY reference — under-keeping it
    // deletes a referenced file.
    const sets = emptySets();
    collectAttachmentUrlReferences('see /api/attachments/123/a&amp;b.png here', sets);
    expect(sets.confluence.has('a&b.png')).toBe(true);
    expect(sets.confluence.has('a&amp;b.png')).toBe(true);
  });

  it('decodes numeric and hex entity spellings too — # is admitted only as part of an &# entity', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(
      'see /api/attachments/1/a&#38;b.png and /api/local-attachments/2/c&#x26;d.png',
      sets,
    );
    expect(sets.confluence.has('a&b.png')).toBe(true);
    expect(sets.local.has('c&d.png')).toBe(true);
    // The fragment rule is untouched: a bare # still terminates the match.
    collectAttachmentUrlReferences('<img src="/api/attachments/1/plain.png#frag">', sets);
    expect(sets.confluence.has('plain.png')).toBe(true);
    expect(sets.confluence.has('plain.png#frag')).toBe(false);
  });

  it('a double-escaped ampersand decodes stepwise, keeping every intermediate spelling', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('see /api/attachments/1/a&amp;amp;b.png', sets);
    expect(sets.confluence.has('a&amp;b.png')).toBe(true);
    expect(sets.confluence.has('a&b.png')).toBe(true);
  });

  it('entity decoding composes with percent decoding and the apostrophe machinery', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('see /api/attachments/1/O&#39;Brien%20notes.png here', sets);
    expect(sets.confluence.has("O'Brien notes.png")).toBe(true);
  });

  it('extends a quoted attribute value across a literal space (fixer r1)', () => {
    // A literal space is legal inside a quoted HTML attribute and the
    // reference WORKS — the browser percent-encodes it on request and the
    // route decodes it back — but \s is outside the regex's filename class,
    // so only the pre-space prefix ever reached the keep-set and a live run
    // deleted a referenced file. When the match starts right after a quote,
    // the candidate is extended to the closing quote.
    const dq = emptySets();
    collectAttachmentUrlReferences('<img src="/api/attachments/123/my file.png">', dq);
    expect(dq.confluence.has('my file.png')).toBe(true);

    const sq = emptySets();
    collectAttachmentUrlReferences("<img src='/api/local-attachments/7/my file.png'>", sq);
    expect(sq.local.has('my file.png')).toBe(true);
  });

  it('extends an ABSOLUTE quoted spelling too — the quote is not the previous character (fixer, external round)', () => {
    // `text[match.index - 1]` is `m` from `.com` here, so the r1 continuation
    // never fired and the keep-set held only `my`; the on-disk `my file.png`
    // then missed the keep-set and a live run deleted a referenced file.
    // Absolute attachment URLs really occur in bodies (an editor that
    // resolves against document.baseURI, a paste from a rendered page).
    const abs = emptySets();
    collectAttachmentUrlReferences(
      '<img src="https://kb.example.com/api/attachments/123/my file.png">',
      abs,
    );
    expect(abs.confluence.has('my file.png')).toBe(true);

    // Same through a proxy path prefix, and on the single-quoted spelling.
    const prefixed = emptySets();
    collectAttachmentUrlReferences(
      "<a href='https://kb.example.com:8443/wiki/api/local-attachments/7/two words.png'>x</a>",
      prefixed,
    );
    expect(prefixed.local.has('two words.png')).toBe(true);
  });

  it('the enclosing-quote scan stops at whitespace and tag boundaries — a plain-text spelling after a quoted attribute is not extended', () => {
    // The scan must not reach BACKWARDS past the text that separates a bare
    // URL from an earlier attribute's closing quote, or it would swallow
    // everything up to the next quote in the document as the "filename".
    const sets = emptySets();
    collectAttachmentUrlReferences(
      '<p title="t">see /api/attachments/1/my file.png here</p><b class="x">',
      sets,
    );
    expect(sets.confluence.has('my')).toBe(true);
    for (const name of sets.confluence) {
      expect(name.includes(' here')).toBe(false);
    }
  });

  it('the quoted extension still drops query and fragment, and composes with entity decoding', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('<img src="/api/attachments/1/a b.png?v=2">', sets);
    expect(sets.confluence.has('a b.png')).toBe(true);

    collectAttachmentUrlReferences('<img src="/api/attachments/1/c d.png#frag">', sets);
    expect(sets.confluence.has('c d.png')).toBe(true);

    collectAttachmentUrlReferences('<img src="/api/attachments/1/a b&amp;c.png">', sets);
    expect(sets.confluence.has('a b&c.png')).toBe(true);
  });

  it('a plain-text spelling with a space is NOT extended — the space genuinely terminates a bare URL', () => {
    // Outside a quoted attribute there is no closing delimiter to extend to,
    // and a bare URL with a literal space does not function as a reference.
    const sets = emptySets();
    collectAttachmentUrlReferences('see /api/attachments/1/my file.png here', sets);
    expect(sets.confluence.has('my')).toBe(true);
    expect(sets.confluence.has('my file.png here')).toBe(false);
  });

  // Review r1: the two cases above name whitespace in their titles but are
  // each satisfied by the `<`/`>` branch or by running off the lookback
  // floor, so the whitespace half of the stop set passed with it deleted.
  // Here the backward scan meets ONLY word characters before the space, so
  // whitespace is the sole thing that can stop it short of the earlier quote.
  it('whitespace alone stops the enclosing-quote scan — an earlier quote does not reach across it', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(
      '<p>alt="x" /api/attachments/1/my file.png here" tail</p>',
      sets,
    );
    expect(sets.confluence.has('my')).toBe(true);
    // Without the whitespace branch the scan skips `x"`'s tail, finds the `"`
    // opening `alt="x"`, and extends the name to the next quote.
    expect(sets.confluence.has('my file.png here')).toBe(false);
  });

  it('never emits a name that is not a plain basename', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('<img src="/api/attachments/1/..%2Fescape.png">', sets);
    for (const name of sets.confluence) {
      expect(name.includes('/')).toBe(false);
      expect(name.startsWith('.')).toBe(false);
    }
  });
});

describe('isImageLikeCandidate (#1349 — the only per-file candidate class)', () => {
  it('accepts the supported raster/vector extensions and draw.io PNG exports', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.svg', 'f.webp', 'diagram.png']) {
      expect(isImageLikeCandidate(name)).toBe(true);
    }
  });

  it('accepts external-image cache keys with or without an extension', () => {
    expect(isImageLikeCandidate('external-0123456789ab.png')).toBe(true);
    expect(isImageLikeCandidate('external-0123456789ab')).toBe(true);
  });

  it('refuses everything else — non-image cached attachments are never candidates', () => {
    for (const name of ['manual.pdf', 'diagram.drawio', 'notes.docx', 'archive.zip', 'x.xml', 'README']) {
      expect(isImageLikeCandidate(name)).toBe(false);
    }
  });
});

describe('keep-set event-loop yield', () => {
  /**
   * `forEachRowYielding` returns at its first `await`, so the first
   * KEEP_SET_YIELD_EVERY rows run before the caller gets a Promise.
   * Without that await the whole batch drains synchronously — the
   * regression the wall-clock ticker in the integration file used to
   * catch, before fileParallelism made those gaps unusable.
   */
  it('yields to the event loop inside a batch instead of blocking it for the whole batch', async () => {
    expect(KEEP_SET_YIELD_EVERY).toBe(10);
    const rows = Array.from({ length: KEEP_SET_YIELD_EVERY * 2 + 1 }, (_, i) => i);
    let seen = 0;
    const pending = forEachRowYielding(rows, () => {
      seen += 1;
    });
    expect(seen).toBe(KEEP_SET_YIELD_EVERY);
    await pending;
    expect(seen).toBe(rows.length);
  });

  /**
   * Both JSDOM-parsed page columns — `body_storage` and, since #1525,
   * `draft_body_storage` — must be enumerated for every row, and no
   * uninterrupted event-loop tick may carry more than one yield window's
   * worth of those parses. That is a scheduling property, not a source shape.
   *
   * Two earlier rounds asserted it as a regex over this service's source
   * (`forEachRowYielding(rows, (row) => {` … `getExpectedAttachmentFilenames(
   * row.<column>`, with a negative lookahead on `forEachBatch<`). Such a
   * match does not prove lexical containment: moving the draft walk out of
   * the yielding callback into a plain blocking loop over the whole 200-row
   * batch, in the SAME per-batch callback, interposes no `forEachBatch<` and
   * left every assertion green — a ~1.6 s uninterrupted tick that the guard
   * claimed to make impossible (reproduced by three r2 reviewers and again
   * here before this test replaced it).
   *
   * So drive the real function. `yieldToLoop` IS
   * `timers/promises.setImmediate`, so a self-rescheduling `setImmediate`
   * ticker interleaves with the walk's yields by ORDERING — never by wall
   * clock, which is what fileParallelism made unusable for the integration
   * file's timing gaps. A `tick` marker between two parses means the loop got
   * a turn there; a stretch of parse markers with no `tick` is one
   * uninterrupted tick, and the bound is the cost the `KEEP_SET_YIELD_EVERY`
   * rationale is written against: `KEEP_SET_YIELD_EVERY` rows × the two
   * storage columns of a page row. Every blocking shape measured here reds on
   * it — the same-callback hoist and the own-`forEachBatch` hoist at 22 parses
   * in one tick, a whole-batch blocking loop at 42 — while a second
   * *yielding* pass over the same rows stays green, because that shape is not
   * the regression.
   */
  it('never parses more than one yield window of page storage columns in a single event-loop tick (#1525)', async () => {
    const rowCount = KEEP_SET_YIELD_EVERY * 2 + 1;
    keepSetProbe.pageRows = Array.from({ length: rowCount }, (_, i) => ({
      __cursor: i + 1,
      body_html: null,
      draft_body_html: null,
      body_storage: `body:${i}`,
      draft_body_storage: `draft:${i}`,
      space_key: 'SPACE',
    }));
    keepSetProbe.timeline = [];

    let ticking = true;
    const tick = (): void => {
      if (!ticking) return;
      keepSetProbe.timeline.push('tick');
      setImmediate(tick);
    };
    setImmediate(tick);
    try {
      await buildAttachmentKeepSets();
    } finally {
      ticking = false;
    }

    const parsed = keepSetProbe.timeline.filter((marker) => marker !== 'tick');
    const expected = Array.from({ length: rowCount }, (_, i) => [`body:${i}`, `draft:${i}`]).flat();
    // Every storage column of every row reached the enumerator, exactly once.
    expect([...parsed].sort()).toEqual([...expected].sort());
    expect(parsed).toHaveLength(expected.length);

    const STORAGE_COLUMNS_PER_PAGE_ROW = 2;
    let worstParsesPerTick = 0;
    let parsesThisTick = 0;
    for (const marker of keepSetProbe.timeline) {
      if (marker === 'tick') {
        worstParsesPerTick = Math.max(worstParsesPerTick, parsesThisTick);
        parsesThisTick = 0;
        continue;
      }
      parsesThisTick += 1;
    }
    worstParsesPerTick = Math.max(worstParsesPerTick, parsesThisTick);
    expect(worstParsesPerTick).toBeGreaterThan(0);
    expect(worstParsesPerTick).toBeLessThanOrEqual(KEEP_SET_YIELD_EVERY * STORAGE_COLUMNS_PER_PAGE_ROW);
  });
});

describe('keep-set fail-closed on an unreadable body (#1525)', () => {
  /**
   * `buildAttachmentKeepSets` documents the direction it must fail in, and
   * that direction is the whole safety argument of the sweep: a body whose
   * references could not be READ is a body whose references are UNKNOWN, so
   * the run must abort rather than continue with a keep-set silently missing
   * that row's names — the sweep DELETES files, and a too-small keep-set
   * deletes referenced bytes.
   *
   * The claim is reachable: the enumerator is the only JSDOM consumer of a
   * storage column, HTML parsing is error-recovering for ordinary bad content
   * (truncated storage, raw garbage and a 500-deep nesting all came back as a
   * list when probed at this head), but a ~20k-deep nesting throws
   * `RangeError: Maximum call stack size exceeded` out of the parser. Probed
   * for real; asserted here through `keepSetProbe.throwFor` instead of a 20k
   * body, because the actual recursion limit is an engine property and a test
   * that depends on it would be flaky, not a guard.
   *
   * What this pins is the absence of a `try`/`catch` around the enumerator
   * calls: wrap either storage column's `getExpectedAttachmentFilenames` in
   * one and this reds.
   */
  it('rejects instead of returning a keep-set that lost the row it could not parse', async () => {
    keepSetProbe.pageRows = [
      {
        __cursor: 1,
        body_html: null,
        draft_body_html: null,
        body_storage: null,
        draft_body_storage: 'draft:unparseable',
        space_key: 'SPACE',
      },
    ];
    keepSetProbe.timeline = [];
    keepSetProbe.throwFor = 'draft:unparseable';
    try {
      await expect(buildAttachmentKeepSets()).rejects.toThrow(/Maximum call stack size exceeded/);
    } finally {
      keepSetProbe.throwFor = null;
    }
    // The enumerator really was reached — the rejection is the throw the
    // parser raised, not a mock that never ran.
    expect(keepSetProbe.timeline).toContain('draft:unparseable');
  });

  /** Same shape, published column: both storage passes are uncaught. */
  it('rejects for the published body_storage column too', async () => {
    keepSetProbe.pageRows = [
      {
        __cursor: 1,
        body_html: null,
        draft_body_html: null,
        body_storage: 'body:unparseable',
        draft_body_storage: null,
        space_key: 'SPACE',
      },
    ];
    keepSetProbe.timeline = [];
    keepSetProbe.throwFor = 'body:unparseable';
    try {
      await expect(buildAttachmentKeepSets()).rejects.toThrow(/Maximum call stack size exceeded/);
    } finally {
      keepSetProbe.throwFor = null;
    }
    expect(keepSetProbe.timeline).toContain('body:unparseable');
  });
});
