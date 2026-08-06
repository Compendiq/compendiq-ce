import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Filename discipline for the migrations directory.
 *
 * `runMigrations` (core/db/postgres.ts) reads the directory and applies files in
 * plain lexicographic `.sort()` order, so the numeric prefix *is* the execution
 * order. Two migrations sharing a prefix therefore run in an order decided by
 * the rest of the filename — which nobody chose, and which neither PR author saw
 * while their branches were separate.
 *
 * This is a repeat failure in this repo, not a hypothetical: independent branches
 * each pick "the next number" against `dev`, and both land. `040` below is the
 * scar. It cannot be renamed — both files have been applied on real deployments
 * and are recorded by name in `_migrations`, so renaming one would make it run a
 * second time.
 *
 * The trailing-letter form (`017b_…`) is NOT a collision and is the sanctioned
 * way to wedge a repair in after an already-applied migration: it sorts directly
 * after its base, which is exactly the intent. So the prefix that must be unique
 * is the whole `NNN[letter]` token, not the first three characters.
 *
 * Deliberately NOT gated on `isDbAvailable()`: this reads the filesystem only,
 * and the environment most likely to open a colliding PR is the one without a
 * local Postgres. A guard that skips exactly there is not a guard.
 */

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Prefixes that predate this rule and cannot be renamed. Do not extend. */
const LEGACY_DUPLICATE_PREFIXES = new Set(['040']);

const CONVENTION = /^\d{3}[a-z]?_[a-z0-9_]+\.sql$/;

function migrationFiles(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('migration filenames', () => {
  it('finds the migrations directory', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });

  it('has no two migrations sharing a numeric prefix', () => {
    const byPrefix = new Map<string, string[]>();
    for (const file of migrationFiles()) {
      const prefix = /^(\d{3}[a-z]?)_/.exec(file)?.[1] ?? file;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
    }

    const collisions = [...byPrefix.entries()]
      .filter(([prefix, files]) => files.length > 1 && !LEGACY_DUPLICATE_PREFIXES.has(prefix))
      .map(([prefix, files]) => `${prefix}: ${files.join(', ')}`);

    expect(
      collisions,
      `Two migrations claim the same number. They run in lexicographic order, ` +
        `which is not the order either author intended. Renumber the newer one to ` +
        `the next free slot before merging.\n${collisions.join('\n')}`,
    ).toEqual([]);
  });

  it('names every migration NNN_snake_case.sql', () => {
    const offenders = migrationFiles().filter((f) => !CONVENTION.test(f));

    expect(
      offenders,
      `Migration filenames must be NNN_snake_case.sql (or NNNb_… to wedge a repair ` +
        `in after NNN) — the prefix is what orders execution.\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the legacy exception exactly as recorded', () => {
    // If someone renames or removes one of these, the allowlist must shrink with
    // it — a stale exemption silently re-opens the hole it was carved for.
    const files = migrationFiles();
    for (const prefix of LEGACY_DUPLICATE_PREFIXES) {
      expect(
        files.filter((f) => f.startsWith(prefix)).length,
        `Prefix ${prefix} is allowlisted as a legacy duplicate but no longer has ` +
          `two files. Remove it from LEGACY_DUPLICATE_PREFIXES.`,
      ).toBeGreaterThan(1);
    }
  });
});
