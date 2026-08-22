import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

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
 */
describe('every kNN callsite resolves the floor before it checks a client out', () => {
  const CALLSITES: ReadonlyArray<readonly [string, string]> = [
    ['rag-service.ts (vector leg)', './rag-service.ts'],
    ['image-leg-search.ts (image leg)', './image-leg-search.ts'],
    ['embedding-service.ts (page relationships)', './embedding-service.ts'],
    ['duplicate-detector.ts', '../../knowledge/services/duplicate-detector.ts'],
  ];

  it.each(CALLSITES)('%s', (_label, relative) => {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');

    const resolved = source.indexOf('await efSearchFor(');
    expect(resolved, `${relative} must call efSearchFor`).toBeGreaterThanOrEqual(0);
    const setLocal = source.indexOf('SET LOCAL hnsw.ef_search', resolved);
    expect(setLocal, `${relative} must interpolate it into SET LOCAL`).toBeGreaterThan(resolved);

    // The checkout is what must sit BETWEEN them. Move the await below
    // `connect()` / `BEGIN` and this window no longer contains one.
    const between = source.slice(resolved, setLocal);
    expect(
      between,
      `${relative}: resolve the ef_search floor before .connect(), never between BEGIN and the ` +
        'SET LOCAL — awaiting an admin_settings read while holding a client is a nested acquire ' +
        'on a pool that may be saturated',
    ).toMatch(/\.connect\(\)/);
  });
});
