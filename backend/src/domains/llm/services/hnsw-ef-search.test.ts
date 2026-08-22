import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * #1285 — the one `hnsw.ef_search` resolver every pgvector kNN probe shares.
 *
 * The floor used to be a module-load read of `process.env.RAG_EF_SEARCH`, so
 * it could not change without a restart and did not appear on the panel that
 * owns everything around it. It is now `admin_settings.rag_ef_search`, read
 * through the same cached getter as its Retrieval-panel siblings — which is
 * what makes the arithmetic below worth pinning separately from the getter:
 * the 2x headroom and pgvector's 1000 ceiling are the two rules a callsite
 * cannot restate for itself.
 */

const mockGetRagEfSearch = vi.fn<() => Promise<number>>();
vi.mock('../../../core/services/admin-settings-service.js', () => ({
  getRagEfSearch: () => mockGetRagEfSearch(),
}));

const { efSearchFor, clampEfSearch, HNSW_EF_SEARCH_MAX } = await import('./hnsw-ef-search.js');

beforeEach(() => {
  mockGetRagEfSearch.mockReset();
  mockGetRagEfSearch.mockResolvedValue(100);
});

describe('clampEfSearch — the arithmetic, with the floor handed in', () => {
  it('keeps the configured floor when the probe is small', () => {
    expect(clampEfSearch(10, 100)).toBe(100);
    expect(clampEfSearch(49, 100)).toBe(100);
  });

  it('gives a large probe 2x headroom, never 1x', () => {
    // `ef_search == k` is HNSW's worst recall setting: the graph walk has no
    // room to explore beyond the rows it must return.
    expect(clampEfSearch(100, 100)).toBe(200);
    expect(clampEfSearch(150, 100)).toBe(300);
  });

  it("clamps to pgvector's own ceiling", () => {
    expect(HNSW_EF_SEARCH_MAX).toBe(1000);
    expect(clampEfSearch(900, 100)).toBe(1000);
    expect(clampEfSearch(10, 1000)).toBe(1000);
  });

  it('honours a floor other than the default — the whole point of the knob', () => {
    expect(clampEfSearch(10, 40)).toBe(40);
    expect(clampEfSearch(10, 400)).toBe(400);
    expect(clampEfSearch(300, 40)).toBe(600);
  });
});

describe('efSearchFor — the callsite form', () => {
  it('reads the floor from the admin_settings knob, not from the environment', async () => {
    process.env.RAG_EF_SEARCH = '900';
    try {
      mockGetRagEfSearch.mockResolvedValue(250);
      await expect(efSearchFor(10)).resolves.toBe(250);
      expect(mockGetRagEfSearch).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.RAG_EF_SEARCH;
    }
  });

  it('applies the same 2x headroom and 1000 ceiling as the pure form', async () => {
    mockGetRagEfSearch.mockResolvedValue(40);
    await expect(efSearchFor(10)).resolves.toBe(40);
    await expect(efSearchFor(300)).resolves.toBe(600);
    await expect(efSearchFor(900)).resolves.toBe(1000);
  });

  it('resolves to a plain integer safe to interpolate into `SET LOCAL`', async () => {
    // Every callsite writes this into SQL text — pgvector's `ef_search` has no
    // bind-parameter form — so a non-integer here would be a syntax error on a
    // hot path rather than a bad number.
    mockGetRagEfSearch.mockResolvedValue(137);
    const ef = await efSearchFor(11);
    expect(Number.isInteger(ef)).toBe(true);
    expect(String(ef)).toMatch(/^\d+$/);
  });
});

/**
 * Review r2 — the "resolve the floor BEFORE checking a client out" rule
 * (review r1's own fix, stated in this module's JSDoc, in all four callsite
 * comments, in CLAUDE.md and in `docs/architecture/09-flow-rag-chat.md`) had
 * nothing enforcing it: moving `await efSearchFor(…)` back inside the open
 * transaction left every suite in the repo green, and #1260 adds a fifth
 * probe coded against this head.
 *
 * The regression it admits is invisible outside production saturation — a
 * probe holding a client asks its own pool for a second one, waits out
 * `connectionTimeoutMillis`, soft-fails to the default floor and caches THAT
 * for a TTL — so no result assertion can see it. What CAN be seen is where
 * the checkout sits: between the resolve and the `SET LOCAL` that consumes
 * it. A runtime companion pins the same rule at the vector leg
 * (`rag-service.test.ts`), the callsite #1260 edits; this one is what reaches
 * `image-leg-search.ts`, whose only coverage is a real-Postgres integration
 * test with no pool to instrument.
 *
 * Review r3 — the first cut of this guard checked each listed file's FIRST
 * probe only, and read its file list off a hand-maintained array, so both
 * shapes a new probe can take were silent: a SECOND probe added below a
 * correct one in a listed file, and a probe in a file nobody remembered to
 * list. Both are closed below — every probe in a file is checked, and the
 * list is cross-checked against a walk of `backend/src`, so a probe in a new
 * file fails this suite until it is registered here (which is also where its
 * author is told it needs a runtime companion).
 *
 * SCOPE, stated so the next author can see what it does and does not buy.
 * This is a TEXT guard: it reads every non-test `.ts` file under
 * `backend/src` and reasons about character offsets, so it proves an
 * ORDERING within one function body and nothing about runtime values. Two
 * walks discover the files it must cover, and they key on different things
 * on purpose — one on `await efSearchFor(` (a probe that goes through the
 * knob), one on `SET LOCAL hnsw.ef_search` (a kNN that sets the depth by any
 * means, including a literal) — and both must equal `CALLSITES` exactly. The
 * rules a new probe inherits: a file that gains a SECOND probe has it checked
 * like the first, with no ordering borrowed from its neighbour above; a probe
 * in a NEW file must be added to `CALLSITES`; and a file that sets the depth
 * without resolving it fails the second walk rather than passing unseen.
 */
describe('every kNN callsite resolves the floor before it checks a client out', () => {
  const CALLSITES: ReadonlyArray<readonly [string, string]> = [
    ['rag-service.ts (vector leg)', './rag-service.ts'],
    ['image-leg-search.ts (image leg)', './image-leg-search.ts'],
    ['embedding-service.ts (page relationships)', './embedding-service.ts'],
    ['duplicate-detector.ts', '../../knowledge/services/duplicate-detector.ts'],
  ];

  const PROBE = 'await efSearchFor(';
  const SET_LOCAL = 'SET LOCAL hnsw.ef_search';

  /**
   * Character offset of every occurrence of `needle` that is REAL code.
   *
   * A comment is not code: this module's own JSDoc names both the callsite
   * form and the `SET LOCAL` verbatim, and a callsite's comment may quote
   * either (`duplicate-detector.ts` explains where it deliberately issues no
   * `SET LOCAL` at all), so a bare `indexOf` would discover the resolver as
   * one of its own callers and a file's prose as a kNN probe.
   */
  function codeOffsets(source: string, needle: string): number[] {
    const found: number[] = [];
    for (let cursor = 0; ; ) {
      const at = source.indexOf(needle, cursor);
      if (at < 0) return found;
      cursor = at + needle.length;
      const prefix = source.slice(source.lastIndexOf('\n', at) + 1, at).trimStart();
      if (prefix.startsWith('*') || prefix.startsWith('//') || prefix.startsWith('/*')) continue;
      found.push(at);
    }
  }

  const probeOffsets = (source: string) => codeOffsets(source, PROBE);

  function sourceFilesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFilesUnder(full);
      return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.')
        ? [full]
        : [];
    });
  }

  it('lists every file under backend/src that resolves the floor', () => {
    // The array above is a hand-written claim about the tree, and on its own
    // it is only ever as complete as the last person to add a probe
    // remembered to make it — a probe in a NEW file would be covered by
    // nothing at all, with no test turning red to say so.
    // A directory URL ends in a slash; `${dir}/${name}` would then double it
    // and no path in the walk would ever equal a resolved CALLSITES entry.
    const src = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/+$/, '');
    const discovered = sourceFilesUnder(src)
      .filter((file) => probeOffsets(readFileSync(file, 'utf8')).length > 0)
      .sort();
    const listed = CALLSITES.map(([, relative]) =>
      fileURLToPath(new URL(relative, import.meta.url)),
    ).sort();

    expect(
      discovered,
      'register a new kNN probe in CALLSITES above — and, where this text guard is the only ' +
        'coverage its pool has, give it a runtime ordering assertion beside its own tests',
    ).toEqual(listed);
  });

  it('lists every file under backend/src that sets `hnsw.ef_search` at all', () => {
    // The walk above discovers a file by its RESOLVER CALL, so it can only
    // see a probe that already goes through the knob. The regression #1285
    // exists to prevent takes the other shape: a new kNN writing
    // `SET LOCAL hnsw.ef_search = 200` — or re-reading `process.env` — with
    // no `efSearchFor` anywhere in it. That file resolves nothing, so it is
    // invisible to every assertion in this describe, and the ADR-021 ruling
    // that the depth is `admin_settings.rag_ef_search` quietly stops being
    // true of one query. Keying a second walk on the STATEMENT closes it: the
    // two sets must name exactly the same files.
    const src = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/+$/, '');
    const setters = sourceFilesUnder(src)
      .filter((file) => codeOffsets(readFileSync(file, 'utf8'), SET_LOCAL).length > 0)
      .sort();
    const listed = CALLSITES.map(([, relative]) =>
      fileURLToPath(new URL(relative, import.meta.url)),
    ).sort();

    expect(
      setters,
      'a kNN that sets `hnsw.ef_search` must take the depth from `efSearchFor` — never a literal ' +
        'and never `process.env.RAG_EF_SEARCH` — and must then be registered in CALLSITES above',
    ).toEqual(listed);
  });

  it.each(CALLSITES)('%s', (_label, relative) => {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');

    const probes = probeOffsets(source);
    expect(probes.length, `${relative} must call efSearchFor`).toBeGreaterThan(0);

    // EVERY probe, not only the first: a file that gains a second one below a
    // correct one is exactly the regression this guard exists to catch, and
    // anchoring on a single `indexOf` inspected probe #1's window forever.
    probes.forEach((resolved, index) => {
      const setLocal = source.indexOf('SET LOCAL hnsw.ef_search', resolved);
      expect(
        setLocal,
        `${relative}: probe #${index + 1} must interpolate the floor into SET LOCAL`,
      ).toBeGreaterThan(resolved);

      // The checkout is what must sit BETWEEN them. Move the await below
      // `connect()` / `BEGIN` and this window no longer contains one.
      const between = source.slice(resolved, setLocal);
      expect(
        between,
        `${relative} (probe #${index + 1}): resolve the ef_search floor before .connect(), never ` +
          'between BEGIN and the SET LOCAL — awaiting an admin_settings read while holding a ' +
          'client is a nested acquire on a pool that may be saturated',
      ).toMatch(/\.connect\(\)/);
    });
  });
});
