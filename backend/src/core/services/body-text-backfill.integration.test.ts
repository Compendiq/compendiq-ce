/**
 * #1965 body_text backfill against real PostgreSQL (design r12 §10).
 *
 * Every race runs through the job's hooks with barriers; nothing sleeps.
 * Untouched columns are asserted by full-row comparison. Test names carry
 * the acceptance bullet (AC) or maintainer decision (D1–D13) they prove.
 */
import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { closePool, getPool, query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import {
  BODY_TEXT_BACKFILL_STATE_KEY,
  armBodyTextBackfill,
  runBodyTextBackfill,
  stopBodyTextBackfill,
  type BodyTextBackfillHooks,
  type BodyTextBackfillLimits,
  type BodyTextBackfillOptions,
  type BodyTextBackfillState,
  type BodyTextBackfillSummary,
} from './body-text-backfill.js';
import { htmlToText } from './content-converter.js';

const dbAvailable = await isDbAvailable();

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A pre-#1735 pair: html shows `&lt;br&gt;`, stored text was decoded twice to `<br>`. */
function preFix(word = 'br', prefix = 'Use'): { html: string; text: string; fixed: string } {
  return {
    html: `<p>${prefix} &amp;lt;${word}&amp;gt; here</p>`,
    text: `${prefix} <${word}> here`,
    fixed: `${prefix} &lt;${word}&gt; here`,
  };
}

let sequence = 0;
async function insertUser(role: 'user' | 'admin' = 'user'): Promise<string> {
  sequence += 1;
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
    [`backfill-${sequence}-${randomUUID().slice(0, 8)}`, `backfill-${sequence}-${randomUUID().slice(0, 8)}@test.invalid`, role],
  );
  return result.rows[0]!.id;
}

interface PageSeed {
  title?: string;
  html?: string | null;
  text?: string | null;
  draftHtml?: string | null;
  draftText?: string | null;
  source?: 'standalone' | 'confluence';
  version?: number;
  remoteVersion?: number | null;
  localModifiedBy?: string | null;
  localModifiedAt?: Date | null;
  deletedAt?: Date | null;
  createdBy?: string | null;
  spaceKey?: string | null;
}

async function insertPage(seed: PageSeed = {}): Promise<number> {
  const source = seed.source ?? 'standalone';
  const result = await query<{ id: number }>(
    `INSERT INTO pages
       (title, body_html, body_storage, body_text, draft_body_html, draft_body_text, source, version,
        remote_version, confluence_id, local_modified_by, local_modified_at, deleted_at, created_by_user_id,
        visibility, space_key, embedding_dirty, embedding_status, labels)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'shared', $14, FALSE, 'not_embedded',
             ARRAY['keep'])
     RETURNING id`,
    [
      seed.title ?? 'Neutral title', seed.html === undefined ? preFix().html : seed.html,
      seed.text === undefined ? preFix().text : seed.text, seed.draftHtml ?? null, seed.draftText ?? null, source,
      seed.version ?? 7, seed.remoteVersion ?? null, source === 'confluence' ? `c-${randomUUID()}` : null,
      seed.localModifiedBy ?? null, seed.localModifiedAt ?? null, seed.deletedAt ?? null, seed.createdBy ?? null,
      seed.spaceKey ?? null,
    ],
  );
  return result.rows[0]!.id;
}

interface VersionSeed {
  source?: 'local' | 'confluence';
  version: number;
  title?: string;
  html: string | null;
  text: string | null;
}

async function insertVersion(pageId: number, seed: VersionSeed): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO page_versions (page_id, source, version_number, title, body_html, body_text)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [pageId, seed.source ?? 'local', seed.version, seed.title ?? `Snapshot ${seed.version}`, seed.html, seed.text],
  );
  return result.rows[0]!.id;
}

async function pageRow(pageId: number): Promise<Record<string, unknown>> {
  return (await query('SELECT * FROM pages WHERE id = $1', [pageId])).rows[0]!;
}

async function versionRow(id: string): Promise<Record<string, unknown> | undefined> {
  return (await query('SELECT * FROM page_versions WHERE id = $1', [id])).rows[0];
}

/** Full-row comparison: every column except `changed` is byte-identical. */
function expectUnchangedExcept(before: Record<string, unknown>, after: Record<string, unknown>, changed: string[]): void {
  const strip = (row: Record<string, unknown>) => Object.fromEntries(
    Object.entries(row).filter(([key]) => !changed.includes(key)),
  );
  expect(strip(after)).toEqual(strip(before));
}

async function state(): Promise<BodyTextBackfillState & { updated_at?: Date }> {
  const row = (await query<{ setting_value: string }>(
    'SELECT setting_value FROM admin_settings WHERE setting_key = $1', [BODY_TEXT_BACKFILL_STATE_KEY],
  )).rows[0];
  return JSON.parse(row!.setting_value) as BodyTextBackfillState;
}

async function patchState(patch: Partial<BodyTextBackfillState>, updatedAgo?: string): Promise<void> {
  const current = await state();
  await query(
    `UPDATE admin_settings SET setting_value = $2, updated_at = ${updatedAgo ? `NOW() - $3::interval` : 'updated_at'}
      WHERE setting_key = $1`,
    updatedAgo
      ? [BODY_TEXT_BACKFILL_STATE_KEY, JSON.stringify({ ...current, ...patch }), updatedAgo]
      : [BODY_TEXT_BACKFILL_STATE_KEY, JSON.stringify({ ...current, ...patch })],
  );
}

const run = (options: BodyTextBackfillOptions = {}): Promise<BodyTextBackfillSummary> => runBodyTextBackfill(options);

/** A promise the test resolves; the job awaits it inside a hook. */
function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

/** Resolves when the job reached a hook; the job then waits on `release`. */
function pause(): { reached: Promise<void>; release: () => void; hook: () => Promise<void> } {
  const reached = barrier();
  const release = barrier();
  let used = false;
  return {
    reached: reached.wait,
    release: release.open,
    hook: async () => {
      if (used) return;
      used = true;
      reached.open();
      await release.wait;
    },
  };
}

async function withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

const SMALL: Partial<BodyTextBackfillLimits> = {};

describe.skipIf(!dbAvailable)('body_text backfill (#1965) — real PostgreSQL', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    armBodyTextBackfill();
    await truncateAllTables();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  // ─── 1. Repair ────────────────────────────────────────────────────────────

  describe('1. repair', () => {
    async function seedSentinels(pageId: number): Promise<void> {
      await query(
        `UPDATE pages SET summary_ai_operation_id = gen_random_uuid(), summary_ai_attempt = 3,
                          quality_ai_operation_id = gen_random_uuid(), quality_ai_attempt = 2
          WHERE id = $1`,
        [pageId],
      );
      await query(
        `INSERT INTO embedding_ai_operations (page_id, content_revision, image_revision)
         SELECT id, content_revision, image_analysis_revision FROM pages WHERE id = $1`,
        [pageId],
      );
      await query('DELETE FROM deterministic_relationship_dirty');
    }

    async function consequences(pageId: number) {
      const page = (await query<{
        content_revision: string; summary_ai_operation_id: string | null; summary_ai_attempt: number;
        quality_ai_operation_id: string | null; quality_ai_attempt: number; tsv_br: boolean;
      }>(
        `SELECT content_revision::text, summary_ai_operation_id, summary_ai_attempt, quality_ai_operation_id,
                quality_ai_attempt, tsv @@ to_tsquery('simple', 'br') AS tsv_br
           FROM pages WHERE id = $1`, [pageId],
      )).rows[0]!;
      const embeddingOperation = (await query('SELECT 1 FROM embedding_ai_operations WHERE page_id = $1', [pageId])).rows.length;
      const relationshipDirty = (await query('SELECT 1 FROM deterministic_relationship_dirty WHERE page_id = $1', [pageId])).rows.length;
      return { ...page, embeddingOperation, relationshipDirty };
    }

    it('AC1/AC5: corrects published body_text with content_revision +1, tsv rebuilt, relationship-dirty, summary/quality/embedding operation resets; untouched columns unchanged', async () => {
      const pair = preFix();
      const pageId = await insertPage({ html: pair.html, text: pair.text });
      await seedSentinels(pageId);
      const before = await pageRow(pageId);
      expect((await consequences(pageId)).tsv_br).toBe(false);

      const summary = await run();

      expect(summary.outcome).toBe('done');
      const after = await pageRow(pageId);
      expect(after.body_text).toBe(pair.fixed);
      const effect = await consequences(pageId);
      expect(Number(effect.content_revision)).toBe(Number(before.content_revision) + 1);
      expect(effect.tsv_br).toBe(true);
      expect(effect.relationshipDirty).toBe(1);
      expect(effect.summary_ai_operation_id).toBeNull();
      expect(effect.summary_ai_attempt).toBe(0);
      expect(effect.quality_ai_operation_id).toBeNull();
      expect(effect.quality_ai_attempt).toBe(0);
      expect(effect.embeddingOperation).toBe(0);
      expectUnchangedExcept(before, after, [
        'body_text', 'content_revision', 'tsv', 'summary_ai_operation_id', 'summary_ai_attempt',
        'quality_ai_operation_id', 'quality_ai_attempt',
      ]);
      expect(after.local_modified_at).toBeNull();
      expect(summary.counts.repaired).toBe(1);
    });

    it('AC1: corrects a draft only — one statement, content_revision +1, operation resets; tsv, relationship marker and local_modified_at untouched', async () => {
      const pair = preFix('em');
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain', draftHtml: pair.html, draftText: pair.text });
      await seedSentinels(pageId);
      const before = await pageRow(pageId);
      const statements: string[] = [];
      await run({ hooks: { onStatement: (info) => statements.push(info.kind) } });
      const after = await pageRow(pageId);
      expect(after.draft_body_text).toBe(pair.fixed);
      const effect = await consequences(pageId);
      expect(Number(effect.content_revision)).toBe(Number(before.content_revision) + 1);
      expect(effect.relationshipDirty).toBe(0);
      expect(effect.summary_ai_operation_id).toBeNull();
      expect(effect.quality_ai_operation_id).toBeNull();
      expect(effect.embeddingOperation).toBe(0);
      expect(statements.filter((kind) => kind === 'write_page')).toHaveLength(1);
      expectUnchangedExcept(before, after, [
        'draft_body_text', 'content_revision', 'summary_ai_operation_id', 'summary_ai_attempt',
        'quality_ai_operation_id', 'quality_ai_attempt',
      ]);
    });

    it('AC1: corrects published and draft in one statement (content_revision +1 exactly)', async () => {
      const published = preFix('br');
      const draft = preFix('em', 'Draft');
      const pageId = await insertPage({ html: published.html, text: published.text, draftHtml: draft.html, draftText: draft.text });
      const before = await pageRow(pageId);
      const statements: string[] = [];
      await run({ hooks: { onStatement: (info) => statements.push(info.kind) } });
      const after = await pageRow(pageId);
      expect(after.body_text).toBe(published.fixed);
      expect(after.draft_body_text).toBe(draft.fixed);
      expect(Number(after.content_revision)).toBe(Number(before.content_revision) + 1);
      expect(statements.filter((kind) => kind === 'write_page')).toHaveLength(1);
    });

    it('AC1: corrects a page_versions row only — no page update, revision unchanged, page row identical', async () => {
      const pair = preFix('code');
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      const versionId = await insertVersion(pageId, { version: 3, html: pair.html, text: pair.text });
      const before = await pageRow(pageId);
      const versionBefore = await versionRow(versionId);
      await run();
      expect(await pageRow(pageId)).toEqual(before);
      const versionAfter = await versionRow(versionId);
      expect(versionAfter!.body_text).toBe(pair.fixed);
      expectUnchangedExcept(versionBefore!, versionAfter!, ['body_text']);
    });

    it('AC1/D11: corrects published, draft and history together in one transaction', async () => {
      const published = preFix('br');
      const draft = preFix('em', 'Draft');
      const history = preFix('code', 'Old');
      const pageId = await insertPage({ html: published.html, text: published.text, draftHtml: draft.html, draftText: draft.text });
      const versionId = await insertVersion(pageId, { version: 2, html: history.html, text: history.text });
      const before = await pageRow(pageId);
      const summary = await run();
      const after = await pageRow(pageId);
      expect(after.body_text).toBe(published.fixed);
      expect(after.draft_body_text).toBe(draft.fixed);
      expect((await versionRow(versionId))!.body_text).toBe(history.fixed);
      expect(Number(after.content_revision)).toBe(Number(before.content_revision) + 1);
      expect(summary.counts.repaired).toBe(3);
    });

    it('D2: advances local_modified_at on a row with a local edit, sets it for local_modified_by without a timestamp, leaves it NULL without a local edit', async () => {
      const actor = await insertUser();
      const pair = preFix();
      const edited = await insertPage({ html: pair.html, text: pair.text, localModifiedBy: actor, localModifiedAt: new Date('2020-01-01T00:00:00Z') });
      const markerOnly = await insertPage({ html: pair.html, text: pair.text, localModifiedBy: actor, localModifiedAt: null });
      const clean = await insertPage({ html: pair.html, text: pair.text });
      await run();
      const editedAfter = await pageRow(edited);
      expect(editedAfter.body_text).toBe(pair.fixed);
      expect((editedAfter.local_modified_at as Date).getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00Z').getTime());
      expect(editedAfter.local_modified_by).toBe(actor);
      const markerAfter = await pageRow(markerOnly);
      expect(markerAfter.local_modified_at).not.toBeNull();
      expect(markerAfter.local_modified_by).toBe(actor);
      const cleanAfter = await pageRow(clean);
      expect(cleanAfter.local_modified_at).toBeNull();
      expect(cleanAfter.local_modified_by).toBeNull();
    });

    it('AC4: corrects a trashed page', async () => {
      const pair = preFix();
      const pageId = await insertPage({ html: pair.html, text: pair.text, deletedAt: new Date() });
      await run();
      expect((await pageRow(pageId)).body_text).toBe(pair.fixed);
    });
  });

  // ─── 7. Page-update combinations and D9 ──────────────────────────────────

  describe('7. page-update combinations and D9', () => {
    /** Old text: 90,000 tags (no lexemes). Corrected: 90,000 words, beyond the 1 MB tsvector limit. */
    function unindexablePair(): { html: string; text: string } {
      const terms = Array.from({ length: 90_000 }, (_, i) => `w${i.toString(36)}xxxxxxxx`);
      return {
        html: `<p>${terms.map((term) => `&amp;lt;${term}&amp;gt;`).join(' ')}</p>`,
        text: terms.map((term) => `<${term}>`).join(' '),
      };
    }

    it('D9: the seeded 90,000-term published value beside an affected draft and history → nothing of the page written, unindexable; pass reaches done; a later good owner is repaired', async () => {
      const huge = unindexablePair();
      const draft = preFix('em', 'Draft');
      const history = preFix('code', 'Old');
      const bigId = await insertPage({ html: huge.html, text: huge.text, draftHtml: draft.html, draftText: draft.text });
      const versionId = await insertVersion(bigId, { version: 1, html: history.html, text: history.text });
      const good = preFix();
      const goodId = await insertPage({ html: good.html, text: good.text });
      const before = await pageRow(bigId);
      const versionBefore = await versionRow(versionId);
      const summary = await run();
      expect(summary.outcome).toBe('done');
      expect(await pageRow(bigId)).toEqual(before);
      expect(await versionRow(versionId)).toEqual(versionBefore);
      expect((await pageRow(goodId)).body_text).toBe(good.fixed);
      expect(summary.counts.unindexable).toBe(3);
      expect((await state()).status).toBe('done');
    });

    it('D9: another 54000 error during the page update is not treated as unindexable — the run ends and nothing is written', async () => {
      const pair = preFix();
      const pageId = await insertPage({ html: pair.html, text: pair.text });
      const before = await pageRow(pageId);
      await query(`CREATE OR REPLACE FUNCTION zz_backfill_test_54000() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'other program limit'; END $$ LANGUAGE plpgsql`);
      await query(`CREATE TRIGGER zz_backfill_test_54000 BEFORE UPDATE OF body_text ON pages
        FOR EACH ROW EXECUTE FUNCTION zz_backfill_test_54000()`);
      try {
        await expect(run()).rejects.toMatchObject({ code: 'sql_54000' });
      } finally {
        await query('DROP TRIGGER zz_backfill_test_54000 ON pages');
        await query('DROP FUNCTION zz_backfill_test_54000()');
      }
      expect(await pageRow(pageId)).toEqual(before);
      expect((await state()).status).toBe('idle');
    });

    it('history only: no page update and the page revision is unchanged', async () => {
      const pair = preFix('code');
      const pageId = await insertPage({ html: '<p>plain</p>', text: 'plain' });
      await insertVersion(pageId, { version: 3, html: pair.html, text: pair.text });
      const statements: string[] = [];
      const before = await pageRow(pageId);
      await run({ hooks: { onStatement: (info) => statements.push(info.kind) } });
      expect(statements).not.toContain('write_page');
      expect((await pageRow(pageId)).content_revision).toBe(before.content_revision);
    });
  });

  // keep helpers referenced while sections grow
  it.skip('placeholder', () => {
    void SMALL; void htmlToText; void logger; void vi; void closePool; void createConnection; void createServer; void patchState;
    void stopBodyTextBackfill; void pause; void withClient;
    const unused: (AddressInfo | Socket | BodyTextBackfillHooks)[] = [];
    void unused;
  });
});
