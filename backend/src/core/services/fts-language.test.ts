/**
 * #1114 — the keyword-index language is configured in Settings, and the
 * `FTS_LANGUAGE` environment variable is retired.
 *
 * The env var was inert on every migrated instance and it always had been:
 * migration 049 seeds `admin_settings.fts_language` with `'simple'` via
 * `ON CONFLICT DO NOTHING`, and it runs before the first request, so the
 * `?? process.env.FTS_LANGUAGE` arm of the read could only ever be reached on
 * an instance whose row someone had deleted by hand. Setting
 * `FTS_LANGUAGE=german` therefore did nothing at all — which is exactly how a
 * German corpus ends up indexed with `simple` (no stemming, no stop words)
 * while its operator believes otherwise.
 *
 * These tests pin the two halves of the consolidation:
 *   - the read consults the row and nothing else, so a stale env var can
 *     never disagree with the panel;
 *   - a set `FTS_LANGUAGE` is reported at startup as ignored, naming the
 *     setting that replaced it.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { FTS_LANGUAGES } from '@compendiq/contracts';
import {
  getFtsLanguage,
  ALLOWED_FTS_LANGUAGES,
  warnIfFtsLanguageEnvSet,
} from './fts-language.js';
import { logger } from '../utils/logger.js';

/** One `admin_settings` row, or none. */
function rowIs(value: string | null) {
  mockQuery.mockResolvedValue({ rows: value === null ? [] : [{ setting_value: value }] });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getFtsLanguage — the row is the only source (#1114)', () => {
  it('returns the configured row', async () => {
    rowIs('german');
    await expect(getFtsLanguage()).resolves.toBe('german');
  });

  it('falls back to simple when the row is absent — even when FTS_LANGUAGE says otherwise', async () => {
    // The retired env var. It used to win here, which made the fallback a
    // second, invisible source of truth that the Settings panel could not see.
    vi.stubEnv('FTS_LANGUAGE', 'german');
    rowIs(null);
    await expect(getFtsLanguage()).resolves.toBe('simple');
  });

  it('keeps the row when FTS_LANGUAGE disagrees with it', async () => {
    vi.stubEnv('FTS_LANGUAGE', 'french');
    rowIs('german');
    await expect(getFtsLanguage()).resolves.toBe('german');
  });

  it('falls back to simple for a row holding a value outside the allow-list', async () => {
    // Defence in depth: the value is interpolated into SQL as a regconfig, so
    // a row written by psql or restored from a dump must never reach it.
    rowIs("english'); DROP TABLE pages; --");
    await expect(getFtsLanguage()).resolves.toBe('simple');
  });
});

describe('ALLOWED_FTS_LANGUAGES is derived, not restated (#1114)', () => {
  it('is exactly the contracts list', () => {
    expect([...ALLOWED_FTS_LANGUAGES].sort()).toEqual([...FTS_LANGUAGES].sort());
  });

  it('accepts every configuration the write schema accepts', async () => {
    for (const lang of FTS_LANGUAGES) {
      rowIs(lang);
      await expect(getFtsLanguage(), `${lang} was discarded by the reader`).resolves.toBe(lang);
    }
  });
});

describe('warnIfFtsLanguageEnvSet (#1114)', () => {
  it('warns, naming the setting that replaced it, when FTS_LANGUAGE is set', () => {
    vi.stubEnv('FTS_LANGUAGE', 'german');
    warnIfFtsLanguageEnvSet();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [context, message] = vi.mocked(logger.warn).mock.calls[0]! as [
      Record<string, unknown>,
      string,
    ];
    expect(context).toMatchObject({ envVar: 'FTS_LANGUAGE' });
    // A warning that only says "ignored" leaves the operator with a German
    // corpus and no idea where the real knob is.
    expect(message).toContain('admin_settings.fts_language');
    expect(message).toMatch(/Settings → AI Models → Retrieval/);
  });

  it('says nothing when FTS_LANGUAGE is unset', () => {
    vi.stubEnv('FTS_LANGUAGE', undefined);
    warnIfFtsLanguageEnvSet();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says nothing for an empty FTS_LANGUAGE (compose passes empty strings through)', () => {
    vi.stubEnv('FTS_LANGUAGE', '');
    warnIfFtsLanguageEnvSet();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  /**
   * The tests above prove the function warns. They cannot prove anything
   * CALLS it: `index.ts` boots a server and no suite imports it, so deleting
   * the call site leaves every backend test green — and with it the only
   * thing that tells an upgrading operator their `FTS_LANGUAGE=german` never
   * worked. Read the source instead, the way
   * `docker-compose-invariants.test.ts` reads compose and
   * `frontend/src/ai-scroll-chain.test.ts` reads a class list: an assertion
   * that fails BY NAME is worth more than no assertion at all.
   */
  describe('the startup call site', () => {
    const source = readFileSync(
      new URL('../../index.ts', import.meta.url),
      'utf8',
    );

    it('is wired into index.ts', () => {
      expect(
        source,
        'backend/src/index.ts must call warnIfFtsLanguageEnvSet() at startup',
      ).toContain('warnIfFtsLanguageEnvSet();');
    });

    it('runs after migrations, so the row it points at exists', () => {
      // The message tells the operator to go and set `fts_language` in
      // Settings. On a fresh install migration 049 is what creates that row.
      const migrations = source.indexOf('await runMigrations()');
      const warn = source.indexOf('warnIfFtsLanguageEnvSet();');
      expect(migrations).toBeGreaterThanOrEqual(0);
      expect(warn).toBeGreaterThan(migrations);
    });
  });
});
