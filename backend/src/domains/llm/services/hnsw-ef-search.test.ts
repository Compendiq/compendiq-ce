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
 * `backend/src`, matches literal strings and reasons about character
 * offsets, so it proves an ORDERING within one function body and nothing
 * about runtime values. Two walks discover the files it must cover, and they
 * key on different things on purpose — one on `await efSearchFor(` (a probe
 * that goes through the knob), one on the bare GUC name `hnsw.ef_search`
 * anywhere in code (a kNN that touches the depth at all, whatever statement
 * it wraps it in) — and both must equal `CALLSITES` exactly. The rules a new
 * probe inherits: a file that gains a SECOND probe has it checked like the
 * first, with no ordering borrowed from its neighbour above; a probe in a NEW
 * file must be added to `CALLSITES`; a file that touches the depth without
 * resolving it fails the second walk rather than passing unseen; and every
 * line that names the GUC must spell `SET LOCAL`, so a session-level `SET`
 * fails on its own message rather than on an ordering assertion that cannot
 * explain itself.
 *
 * Review r1 of the verification round closed the hole those two walks left
 * BETWEEN them. Both compare sets of file PATHS, so a second, unresolved depth
 * statement added inside an already-listed file satisfied every one of them:
 * the GUC walk still matched the same file set, the `SET LOCAL` assertion still
 * passed, and the ordering test iterates probes, of which the mutant added
 * none. So the per-callsite check now counts the file's depth statements
 * against the file's own probe count and insists each one interpolates
 * (`hnsw.ef_search = ${…}`) rather than naming a literal — a per-LINE rule
 * where the walks are per-FILE.
 *
 * What it does NOT buy, so nobody reads more into a green run than is there:
 * the match is on the GUC name as written. A statement assembled from
 * fragments or built out of a constant, an `ALTER {SYSTEM,DATABASE,ROLE} …
 * SET`, an `options=-c hnsw.ef_search=…` connection parameter, or a depth set
 * from outside this repo all evade it. Those are not worth chasing here — the
 * regression this guard exists for is an ordinary new kNN written the
 * ordinary way — and a guard that tried would trade its one clear failure
 * message for false positives.
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
   * The GUC name alone — deliberately NOT `SET LOCAL hnsw.ef_search`.
   *
   * Keying the discovery walk on the full statement made the one spelling
   * this module most needs to catch invisible to BOTH walks: a new kNN
   * writing `SET hnsw.ef_search = 200` resolves nothing (so the probe walk
   * cannot see it) and never types `SET LOCAL` (so a statement-keyed walk
   * cannot either) — while being strictly worse than the literal the old
   * comment worried about, because a session-level `SET` outlives the
   * transaction and leaks the depth to the next borrower of that pooled
   * connection. The name is what every such statement has in common, so the
   * walk keys on it and a separate assertion below insists on `SET LOCAL`.
   */
  const GUC = 'hnsw.ef_search';

  /**
   * Character offset of every occurrence of `needle` that is REAL code.
   *
   * A comment is not code: this module's own JSDoc names both the callsite
   * form and the `SET LOCAL` verbatim, and a callsite's comment may quote
   * either (`duplicate-detector.ts` explains where it deliberately issues no
   * `SET LOCAL` at all), so a bare `indexOf` would discover the resolver as
   * one of its own callers and a file's prose as a kNN probe.
   *
   * `caseInsensitive` exists for the GUC walk: SQL keywords and identifiers
   * are case-insensitive, so `set local HNSW.EF_SEARCH` is the same statement
   * and must not slip past a case-sensitive `indexOf`. Lowercasing is safe to
   * do offset-for-offset here because the needles and the comment markers are
   * ASCII.
   */
  function codeOffsets(source: string, needle: string, caseInsensitive = false): number[] {
    const haystack = caseInsensitive ? source.toLowerCase() : source;
    const target = caseInsensitive ? needle.toLowerCase() : needle;
    const found: number[] = [];
    for (let cursor = 0; ; ) {
      const at = haystack.indexOf(target, cursor);
      if (at < 0) return found;
      cursor = at + target.length;
      const prefix = haystack.slice(haystack.lastIndexOf('\n', at) + 1, at).trimStart();
      if (prefix.startsWith('*') || prefix.startsWith('//') || prefix.startsWith('/*')) continue;
      found.push(at);
    }
  }

  const probeOffsets = (source: string) => codeOffsets(source, PROBE);

  /** The whole source line carrying each code occurrence of the GUC name. */
  function gucLines(source: string): string[] {
    return codeOffsets(source, GUC, true).map((at) => {
      const end = source.indexOf('\n', at);
      return source.slice(source.lastIndexOf('\n', at) + 1, end < 0 ? undefined : end).trim();
    });
  }

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

  it('lists every file under backend/src that touches `hnsw.ef_search` at all', () => {
    // The walk above discovers a file by its RESOLVER CALL, so it can only
    // see a probe that already goes through the knob. The regression #1285
    // exists to prevent takes the other shape: a new kNN writing
    // `SET LOCAL hnsw.ef_search = 200` — or re-reading `process.env` — with
    // no `efSearchFor` anywhere in it. That file resolves nothing, so it is
    // invisible to every assertion in this describe, and the ADR-021 ruling
    // that the depth is `admin_settings.rag_ef_search` quietly stops being
    // true of one query. Keying a second walk on the GUC NAME closes it: the
    // two sets must name exactly the same files. The name, not the statement
    // — see `GUC` above for why `SET hnsw.ef_search` is the spelling a
    // statement-keyed walk could not see and the one that hurts most.
    const src = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/+$/, '');
    const setters = sourceFilesUnder(src)
      .filter((file) => gucLines(readFileSync(file, 'utf8')).length > 0)
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

  it.each(CALLSITES)('%s sets the depth with SET LOCAL, never session-level', (_l, relative) => {
    // `SET` without `LOCAL` survives COMMIT, so the next request to borrow
    // that pooled connection inherits a depth nothing on its path chose —
    // the hazard CLAUDE.md, this module's JSDoc and 09-flow-rag-chat.md all
    // name, and the reason the walk above keys on the GUC rather than on the
    // statement. Asserted per LINE so the failure names the statement.
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    const lines = gucLines(source);
    expect(lines.length, `${relative} must set hnsw.ef_search`).toBeGreaterThan(0);

    // Review r1 (verification round) — both discovery walks above compare SETS
    // OF FILE PATHS, so neither can see a SECOND depth statement added inside
    // an ALREADY-LISTED file. That is not a hypothetical: `rag-service.ts` is
    // the file #1260 is told to edit against this head, and a new kNN written
    // there as `SET LOCAL hnsw.ef_search = 200` resolves nothing, is in a
    // listed file (so the GUC walk still matches), spells SET LOCAL (so the
    // assertion below still passes) and adds no probe (so the ordering test
    // below never looks at it) — verified green at 587404a3 before this
    // counting assertion existed. Counting the depth statements against the
    // file's OWN probe count is what makes the per-file walks reach inside a
    // file: one resolved floor per statement, or one of them came from
    // somewhere the knob does not govern.
    expect(
      lines.length,
      `${relative}: every line naming hnsw.ef_search must come from its own \`${PROBE}\` probe — ` +
        `found ${lines.length} depth statement(s) against ${probeOffsets(source).length} probe(s), ` +
        'so at least one takes its depth from something other than `admin_settings.rag_ef_search`',
    ).toBe(probeOffsets(source).length);

    lines.forEach((line) => {
      expect(
        line,
        `${relative}: \`${line}\` must be a SET LOCAL inside the transaction it already owns — a ` +
          'session-level SET outlives COMMIT and leaks the depth to the next borrower of this ' +
          'pooled connection',
      ).toMatch(/\bset\s+local\s+hnsw\.ef_search\b/i);

      // Counting alone is necessary but not sufficient: a file could carry two
      // probes and two statements while one of them interpolates a literal.
      // The depth is always written as a template substitution because
      // pgvector's `ef_search` has no bind-parameter form.
      expect(
        line,
        `${relative}: \`${line}\` must interpolate a resolved floor (\`\${…}\`), never a literal — ` +
          'a hardcoded depth is exactly the env-era constant #1285 removed, one layer down',
      ).toMatch(/hnsw\.ef_search\s*=\s*\$\{/);
    });
  });

  it.each(CALLSITES)('%s', (_label, relative) => {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');

    const probes = probeOffsets(source);
    expect(probes.length, `${relative} must call efSearchFor`).toBeGreaterThan(0);

    // EVERY probe, not only the first: a file that gains a second one below a
    // correct one is exactly the regression this guard exists to catch, and
    // anchoring on a single `indexOf` inspected probe #1's window forever.
    probes.forEach((resolved, index) => {
      const setLocal = source.indexOf(SET_LOCAL, resolved);
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
