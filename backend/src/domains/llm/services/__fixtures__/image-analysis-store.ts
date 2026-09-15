import { readFileSync } from 'node:fs';
import { query } from '../../../../core/db/postgres.js';
import { _resetImageAnalysisStorePresenceForTests } from '../image-analysis-validity.js';

/**
 * Test-only provisioning of `page_image_analyses` (ADR-027 migration 115,
 * #1615) for the #1616 suites while the two packages are on separate
 * branches. Lives under `__fixtures__` so `tsconfig.build.json` keeps it out
 * of `dist/`.
 *
 * The ingestion side's tests need the store to exist; migration 116
 * deliberately does not create it (the ADR gives 115 to #1615 and the two
 * must merge in either order). So a suite calls `ensureImageAnalysisStore()`
 * once: when the table is already there (115 has landed and `setupTestDb`
 * ran it), nothing happens; when it is absent, the table DDL is applied and
 * `dropImageAnalysisStoreIfProvisioned()` removes it again at the end of the
 * file, so no later suite — least of all 115's own — sees a table its
 * migration did not create. The `_migrations` ledger is never touched.
 *
 * The DDL is not a copy: it is read from ADR-027's "Migration 115" SQL block
 * in `docs/ARCHITECTURE-DECISIONS.md`, which migration 115 reproduces
 * verbatim, cut to the table and its two indexes (the use-case CHECK widening
 * and the settings seed in the same block belong to #1615's migration, not
 * to the store). Delete this file in the PR that lands 115.
 */
let provisioned = false;

const ADR_PATH = new URL('../../../../../../docs/ARCHITECTURE-DECISIONS.md', import.meta.url);

function storeDdlFromAdr(): string {
  const adr = readFileSync(ADR_PATH, 'utf8');
  const heading = adr.indexOf('**Migration 115 — `115_page_image_analyses.sql` (#1615):**');
  if (heading < 0) throw new Error('ADR-027 migration 115 block not found');
  const open = adr.indexOf('```sql', heading);
  const close = adr.indexOf('```', open + 6);
  if (open < 0 || close < 0) throw new Error('ADR-027 migration 115 SQL fence not found');
  const block = adr.slice(open + 6, close);
  const table = block.indexOf('CREATE TABLE IF NOT EXISTS page_image_analyses');
  const rest = block.indexOf('ALTER TABLE llm_usecase_assignments', table);
  // The slice ends on the comment lines introducing the next statement.
  const lines = block.slice(table, rest).trimEnd().split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.startsWith('--')) lines.pop();
  return lines.join('\n');
}

/** Whether migration 115's table is present, provisioned or not. */
export async function imageAnalysisStoreExists(): Promise<boolean> {
  const r = await query<{ present: string | null }>(
    `SELECT to_regclass('public.page_image_analyses')::text AS present`,
  );
  return r.rows[0]?.present != null;
}

export async function ensureImageAnalysisStore(): Promise<void> {
  if (await imageAnalysisStoreExists()) return;
  await query(storeDdlFromAdr());
  provisioned = true;
  // Readers cache a negative presence check for a minute; a suite that
  // embedded before provisioning must see the table now.
  _resetImageAnalysisStorePresenceForTests();
}

export async function dropImageAnalysisStoreIfProvisioned(): Promise<void> {
  if (!provisioned) return;
  await query(`DROP TABLE IF EXISTS page_image_analyses`);
  provisioned = false;
  _resetImageAnalysisStorePresenceForTests();
}
