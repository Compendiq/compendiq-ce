# Runbook — retiring the legacy image embedding space

**Audience:** the operator who applies ADR-027's stage-2 migration, and the one
who has to undo it.

**Status:** the migration described here is **applied**. Its text is
`backend/src/core/db/migrations/118_retire_image_embedding_space.sql`, shipped
in the same release as the stage-2 code removals (#1618), and it is migration
**118** — a fresh database ends `_migrations` at 118. Stage 1 (#1618's
preparation half) shipped this procedure and exercised it on disposable data
(§5.1); stage 2 re-exercised it, two arms, against the APPLIED migration (§5). It was held outside the
runner's directory in `docs/held-migrations/` until stage 2; that directory is
deleted.

> **There is no in-product rollback mode, and none is being added**
> (ADR-027 `:5299`). Rollback is: restore a dump into a deployment of the
> pre-stage-2 release. The product never runs both image designs at once behind
> a switch.

---

## 0. The destructive boundary

Tick every box, in order, before the migration runs against anything an
operator cares about. The order is the point: each item is worthless once the
next one has happened.

- [ ] **Dump taken** — the four-table set in §1, with its `pg_dump` major
      version and checksum recorded.
- [ ] **Dump verified restorable** — replayed into a scratch database and the
      row counts checked (§1.3). An unverified dump is not a backup.
- [ ] **The authorisation recorded** — an explicit owner decision, in writing,
      on the issue (ADR-027 D16 `:4556-4561`, O14 `:5249`). For this cutover it
      was **"Remove it, nobody was using it in production."** — unused in
      production plus maintenance burden, and explicitly **not** a measurement
      (ADR-027 A-5). AC-4's "a passing #1619 verdict" route is superseded in
      writing by A-5 plus that go: the pre-registered primary was never
      measured, because arm A needs a VL embedding endpoint the owner declined
      to stand up.
- [x] **Migration applied**, together with the stage-2 code removals in the same
      release — done in #1618 stage 2. Everything above this line is what a
      future operator re-ticks before restoring; everything below is how.

## What the migration does and does not touch

**Removes:** `page_image_embeddings` (the legacy image vector index, its
per-page index and its probe-built HNSW index); `pages.image_embedding_dirty`
and its partial index; the `image_embedding` member of
`llm_usecase_assignments_usecase_check` and that use case's assignment row; and
six `admin_settings` rows — `image_embedding_probe`,
`image_embedding_dimensions`, `image_embedding_index_model`,
`image_embedding_target_dimensions`, `rag_image_leg_enabled` and
`image_index_last_run`.

**Never removes:** original page content, `body_html`, `body_text`, or a single
attachment byte on disk. Nor `page_image_analyses`, nor anything migration 116
added, nor `admin_settings.image_analysis_*`, nor `rag_answer_max_images` /
`rag_images_per_page_max` (ADR-025 D8/D8b survive the cutover for the optional
chat attachment, ADR-027 D11). That is a statement about the MIGRATION. A
RESTORE is a different matter: it replaces two of these tables wholesale and
will rewind the `image_analysis_*` rows and the vision assignment unless §4
steps 3 and 5 are run — see §3.1.

`image_index_last_run` is an **erratum** to ADR-027 `:5275`, which enumerates
`admin_settings.image_embedding_*` and `rag_image_leg_enabled` and does not name
it. It is the last legacy scan's audit trail and it describes a worker that no
longer exists, so it goes with the rest — and it is the one row whose deletion
loses operator-visible history, which is why the dump set below is the whole
`admin_settings` table rather than a filtered subset.

---

## 1. Backup prerequisites

Record the server and client versions with the artifact. A dump taken by a
`pg_dump` older than the server is not guaranteed to replay.

```bash
psql    --version   # client
pg_dump --version   # MUST be >= the server's major
psql -c 'SHOW server_version'
```

### 1.1 The database set

Four tables. `page_image_embeddings` is the index itself;
`llm_usecase_assignments` and `admin_settings` carry the configuration the
migration deletes; the schema-migrations table (`_migrations`, created by
`backend/src/core/db/postgres.ts`) is what tells a restored deployment which
migrations it has already run.

```bash
pg_dump \
  --dbname="$POSTGRES_URL" \
  --clean --if-exists --no-owner --no-privileges \
  -t page_image_embeddings \
  -t llm_usecase_assignments \
  -t admin_settings \
  -t _migrations \
  > image-leg-rollback.sql

shasum -a 256 image-leg-rollback.sql   # record this with the artifact
```

`--clean --if-exists` is not optional. Three of those four tables still exist
after the migration, so a dump without it fails on the first `CREATE TABLE` of
a restore. With it, the restore **drops and recreates all four** — which is
also what makes §3's data-loss statement true, and why §4 captures the
replacement's own configuration rows *before* the restore and puts them back
*after* it (steps 3 and 5). `admin_settings` and `llm_usecase_assignments` are
dumped and restored WHOLE: a row written after the dump is deleted by the
restore, and a row that existed at dump time reverts to its dump-time value.
There is no merge and no `--exclude-table-data` shape that helps — the legacy
`image_embedding_*` keys the migration DELETES are in the same table as the
replacement's, so the restore has to reload that table's data to do its job.

### 1.2 The attachment directories

The migration removes no bytes, so this is belt and braces against an operator
error during the same maintenance window — not a prerequisite the migration
creates.

```bash
tar -czf attachments-rollback.tgz -C "$ATTACHMENTS_DIR" .
shasum -a 256 attachments-rollback.tgz
```

### 1.3 Verify the dump before you trust it

```bash
createdb rollback_verify
psql -d rollback_verify -c 'CREATE EXTENSION IF NOT EXISTS vector'
psql -d rollback_verify -f image-leg-rollback.sql
psql -d rollback_verify -c 'SELECT count(*) FROM page_image_embeddings'
dropdb rollback_verify
```

Expect the row count to match production's. **Expect two `ERROR: relation
"public.pages" / "public.llm_providers" does not exist` lines as well**: the
dump carries the two tables' foreign keys but not their targets, and a
scratch database has neither. They are not restore failures — the data lands,
the constraints do not. The check being made here is "the dump replays and
carries its rows", nothing more.

---

## 2. Version and data boundary

The dump restores only into a deployment of the **pre-stage-2 release** — the
last release before #1618's stage-2 commit. Record the exact image tag or
commit before the upgrade:

```bash
docker compose -f docker/docker-compose.yml images backend frontend
git rev-parse HEAD   # on a source deployment
```

Restoring it into a **post-118 build is unsupported**, for two independent
reasons:

1. That build has no legacy image leg left to read the restored rows —
   `image-leg-search.ts` and every module ADR-027 `:5276-5285` lists are gone,
   so the index would sit there unread.
2. `_migrations` is in the dump set, so a restore rewinds that table to dump
   time and the post-118 build's own migration row disappears with it. On the
   next boot the runner would try to re-apply every migration after the dump —
   including the one that was just rewound.

## 3. What rolling back loses

Everything written between the dump and the restore. Concretely:

- **Every `page_image_analyses` row written after the dump.** The analyses
  table is *not* in the dump set — it is the replacement, and dumping it would
  make the rollback artifact a copy of the new index. A restore does not delete
  those rows; it simply does not restore ones that were lost with the database
  they were in. Where the payloads survive, D7's `reused` path re-adopts them
  with no vision call; where they do not, the next batch re-analyzes.
- **The derived `page_embeddings` rows** composed from those analyses, on the
  same terms.
- **Every page's legacy `image_embedding_dirty` flag.** The column lives on
  `pages`, which is *not* in the dump set — dumping it would mean dumping the
  whole corpus. §4 re-adds the column, and it comes back at its `DEFAULT
  FALSE`: the restored deployment does not know which pages were edited since
  the dump. Remedy after the restore: **Re-scan all** on Settings → AI Models →
  Embeddings, or `UPDATE pages SET image_embedding_dirty = TRUE`.
- **Any `admin_settings` or `llm_usecase_assignments` change made after the
  dump**, for every key and every use case — those two tables are restored
  wholesale, not merged (§1.1).

Nothing here loses original page content or attachment bytes.

### 3.1 The one that bites: the REPLACEMENT's own configuration

`page_image_analyses` is genuinely outside the dump set, so the descriptions
themselves are safe. Their **configuration is not**: it lives in the two
tables the restore replaces wholesale, so a rollback of the legacy leg drags
the replacement's settings back to dump time unless §4 steps 3 and 5 are run.

| Row | Where | What a wholesale restore does to it |
|---|---|---|
| `admin_settings.image_analysis_identity` | the retained inference identity (ADR-027 D7) | reverts to its dump-time value, or is **deleted** if the dump predates the first assignment — migration 115 does not seed this key |
| `llm_usecase_assignments` row `usecase = 'image_analysis'` | the vision assignment | reverts. **Never deleted:** migration 115 seeds the row `(image_analysis, NULL, NULL)` on every database, so a pre-assignment dump restores it with NULL provider and model. The operator-visible outcome is the same `Not assigned` (D7's pause) |
| `admin_settings.image_analysis_max_output_tokens` | the output-token ceiling (D8) | reverts; a lower ceiling changes every following request |
| `admin_settings.image_analysis_batch_size` | images per batch | reverts |
| `admin_settings.image_analysis_last_run` | the last batch's audit line | deleted outright if it was written after the dump (§5, arm A), otherwise reverts; the next batch overwrites it |

The capability verdict is **not** affected — it lives in
`llm_model_capabilities`, which is not in the dump set.

Two outcomes follow from the first two rows, and the operator sees one of
them on the Image analysis card:

1. **The replacement pauses.** Assignment gone → `Not assigned` (D7's pause).
   Assignment restored but the identity reverted to a different pair →
   D13's **`identity_drift`**: the sweep and the reconcile keep running, but
   no image is analyzed until the identity is adopted again.
2. **Worse than a pause: a corpus-wide re-analysis under a stale identity.**
   If the dump carries an OLDER assignment *and* its matching identity, the
   pair resolves and the gate opens — against the model that was live at dump
   time. Every row written under the newer identity now fails D5's validity
   predicate, the next sweep re-pends them corpus-wide (payloads kept) and the
   worker re-analyzes them, one vision call each.

Both are avoidable, and both are cheap to avoid: §4 step 3 writes those rows
to a file before the restore and step 5 replays it. If a restore has already
happened without it, the remedy is the same one the card names —
re-save the `image_analysis` assignment, or press **Re-check**, on
Settings → AI Models → LLM providers, which re-adopts the identity through D7
with the re-analysis scope disclosed first — plus re-entering the ceiling and
the batch size. Payloads are kept across a sweep, so rows the worker has not
already re-analyzed under the stale identity come back as `reused`, with no
call.

---

## 4. Restore, in order

```bash
# `-v ON_ERROR_STOP=1` on every step here. Without it this block is a listing
# rather than a script: a restore that fails halfway would be followed by
# step 5's replay and step 6's DELETE regardless (review r2 INFO 5). §1.3's
# dump verification is the one place it must NOT be set — that check
# deliberately expects two foreign-key errors.

# 1. Stop every backend replica. A running replica writes to the tables being
#    replaced, and one booting mid-restore re-applies migrations over the top.
docker compose -f docker/docker-compose.yml stop backend

# 2. Re-add the column the dump set cannot carry (migration 093's own text).
#    Migration 093 is still listed in _migrations, so the pre-stage-2 release
#    will NOT re-add it on boot.
psql -v ON_ERROR_STOP=1 --dbname="$POSTGRES_URL" <<'SQL'
ALTER TABLE pages ADD COLUMN IF NOT EXISTS image_embedding_dirty BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS pages_image_embedding_dirty_idx ON pages (id) WHERE image_embedding_dirty;
SQL

# 3. Capture the REPLACEMENT's own configuration, which the restore would
#    otherwise take back to dump time (§3.1). Reads the live database, so it
#    must run after step 1 and before step 4. `%L` renders NULL unquoted, so
#    an assignment with no explicit model replays as NULL, not as 'NULL'.
#
#    SCOPED to `image_analysis\_%` plus the one assignment, because the legacy
#    `image_embedding_*` keys MUST come back from the dump. Every OTHER
#    post-dump setting and use-case assignment is therefore still rewound
#    wholesale (§3's last bullet) — a `chat` or `embedding` reassignment made
#    after the dump reverts silently. If you know of one, widen the WHERE
#    here and nowhere else:
#      WHERE setting_key LIKE 'image\_analysis\_%' OR setting_key IN ('…')
#      WHERE usecase IN ('image_analysis', '…')
psql -v ON_ERROR_STOP=1 --dbname="$POSTGRES_URL" -Atq -o image-analysis-preserve.sql <<'SQL'
SELECT format(
         'INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES (%L, %L, %L)'
         ' ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value,'
         ' updated_at = EXCLUDED.updated_at;',
         setting_key, setting_value, updated_at)
  FROM admin_settings
 WHERE setting_key LIKE 'image\_analysis\_%'
UNION ALL
SELECT format(
         'INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)'
         ' VALUES (%L, %L::uuid, %L, %L)'
         ' ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id,'
         ' model = EXCLUDED.model, updated_at = EXCLUDED.updated_at;',
         usecase, provider_id, model, updated_at)
  FROM llm_usecase_assignments
 WHERE usecase = 'image_analysis';
SQL

# Read it before you rely on it. On any MIGRATED database this file is never
# empty: migration 115 seeds `image_analysis_max_output_tokens`,
# `image_analysis_batch_size` and the `image_analysis` assignment row, so a
# pristine 116-migration database with no vision model ever assigned still
# captures 3 statements. **An empty file can therefore only mean the capture
# failed** — do not wave it through as "this instance never assigned a vision
# model" (review r2 INFO 1). `wc -l` counts LINES, not statements: setting
# values are admin-authored text, so one containing a newline puts a real
# newline inside the quoted literal and the count exceeds the number of
# upserts. The `cat` beside it is the truth.
wc -l image-analysis-preserve.sql && cat image-analysis-preserve.sql

# 4. Restore the dump. Drops and recreates the four tables (see §3).
psql -v ON_ERROR_STOP=1 --dbname="$POSTGRES_URL" -f image-leg-rollback.sql

# 5. Put the replacement's configuration back, on top of the restored tables.
#    Without this the retained identity, the vision assignment, the ceiling
#    and the batch size are all at dump-time values (§3.1) — and the
#    replacement index either pauses on identity_drift or re-analyzes the
#    whole corpus against a stale model.
psql -v ON_ERROR_STOP=1 --dbname="$POSTGRES_URL" -f image-analysis-preserve.sql

# 6. Make sure the migration is not recorded as applied. Usually already true:
#    _migrations is in the dump, so step 4 rewound it past the migration. Run it
#    anyway — a partial restore, or a dump set without _migrations, needs it.
psql -v ON_ERROR_STOP=1 --dbname="$POSTGRES_URL" \
  -c "DELETE FROM _migrations WHERE name LIKE '%retire_image_embedding_space.sql'"

# 7. Start the PRE-STAGE-2 release (§2's recorded tag), not the current one.
COMPENDIQ_VERSION=<pre-stage-2 tag> \
  docker compose -f docker/docker-compose.yml up -d backend
```

### 4.1 Confirm the leg answers again

```bash
# The legacy card's whole data source. `assigned: true` and a non-null
# `identity` mean the use case resolves and the CHECK admits it again.
curl -fsS -H "Authorization: Bearer $ADMIN_JWT" \
  "$BASE_URL/api/admin/embedding/image-index" | jq '{assigned, identity, rows, pagesDirty}'
```

```sql
-- The table, the column, the CHECK member and the probe-built HNSW index.
SELECT to_regclass('public.page_image_embeddings')                        AS leg_table,
       (SELECT count(*) FROM page_image_embeddings)                       AS leg_rows,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_name = 'pages' AND column_name = 'image_embedding_dirty') AS dirty_col,
       (SELECT count(*) FROM pg_indexes
         WHERE indexname = 'page_image_embeddings_embedding_hnsw_idx')     AS hnsw_idx,
       (SELECT count(*) FROM llm_usecase_assignments
         WHERE usecase = 'image_embedding')                               AS leg_assignment;
```

The HNSW index is **probe-time DDL**, built by `ensureImageEmbeddingColumn` and
never by a migration — so a `--clean` dump of the table carries it and it comes
back with the restore. If it does not (a filtered dump, a manual restore), press
**Re-check** on the Image embedding row under Settings → AI Models → LLM
providers and the pre-stage-2 release rebuilds it.

Finally, confirm the replacement came through. `page_image_analyses` is
outside the dump set and outside the migration, so its rows stand on their
own. **The `admin_settings.image_analysis_*` rows and the `image_analysis`
assignment are not** — they live in two tables the restore replaces wholesale
(§3.1), so they are intact only because step 3 captured them and step 5
replayed them. Check that, rather than assuming it:

```sql
-- Expect: analyses ≥ what was there before; identity present; the assignment
-- present with its model; the ceiling and the batch size at the values that
-- were live BEFORE the restore, not the dump's.
SELECT (SELECT count(*) FROM page_image_analyses)                          AS analyses,
       (SELECT count(*) FROM admin_settings
         WHERE setting_key = 'image_analysis_identity')                     AS identity_row,
       (SELECT setting_value FROM admin_settings
         WHERE setting_key = 'image_analysis_max_output_tokens')            AS ceiling,
       (SELECT provider_id || ' / ' || COALESCE(model, '(provider default)')
          FROM llm_usecase_assignments WHERE usecase = 'image_analysis')    AS vision_assignment;
```

```bash
# The replacement's own card, which reports the gate rather than leaving it to
# be deduced: `assigned: true` with `identityMatchesAssignment: true` is the
# state step 5 preserves. `false` is D13's identity_drift — the remedy is a
# re-save of the assignment or Re-check (§3.1).
curl -fsS -H "Authorization: Bearer $ADMIN_JWT" \
  "$BASE_URL/api/admin/embedding/image-analysis" \
  | jq '{assigned, identityMatchesAssignment, retained: .retainedIdentity.model, rows}'
```

---

## 5. Exercise record — 2026-09-17, stage 2 (the applied migration)

The stage-1 record below (§5.1) was measured while `118` was still held in
`docs/held-migrations/`. Stage 2 MOVED the migration into the runner's
directory, so the whole procedure was re-driven rather than carried over — the
diff moved the file the rollback is about.

Rehearsed on disposable databases, never on real data, from a throwaway driver
deleted with them: nothing about the rehearsal is shipped except this record.

**Environment.** `pgvector/pgvector:pg17`, container `s2c-pg` on a private
port, server **PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2)**, client
`psql`/`pg_dump` **18.6** (§1's rule: the client must be ≥ the server's major).
A template database with migrations **001–117** applied by the release's own
runner (`runMigrations()` from `backend/src/core/db/postgres.ts` on the built
`dist`, with 118 withheld so the template IS the pre-stage-2 schema:
`migrations_applied = 117`, newest `117_image_analysis_lexical_index.sql`).
Both arms created from it with `CREATE DATABASE … TEMPLATE`, so the two runs
start byte-identical and the procedure is the only difference. Migration 118
applied from `backend/src/core/db/migrations/118_retire_image_embedding_space.sql`
— the shipped file, not a copy.

**Fixture (the state at dump time).** One page carrying
`image_embedding_dirty`, one `page_image_embeddings` row (`vector(3)`, with an
HNSW index built as the probe builds it), the `image_embedding` assignment, the
six settings rows the migration deletes — and the replacement configured
against **provider A / `vision-a-8b`**: its retained identity, the ceiling at
`8192`, the batch size at `50`, no `image_analysis_last_run` row yet, and one
`analyzed` `page_image_analyses` row (`diagram.png`) written under identity A.

**What the operator does after the dump** (and after 118 is applied):
re-assigns the vision use case to **provider B / `vision-b-8b`** and adopts its
identity, raises the ceiling to `12288`, lowers the batch size to `25`, the
worker records an `image_analysis_last_run` line, and a second image
(`chart.png`) is analyzed under identity B.

| stage | leg table | leg rows | dirty col/idx | hnsw | leg assign | leg settings | analyses | retained | assigned | ceiling | batch | last-run | D13 gate | stale row (D5) | dirty pages | `_migrations` | 118 row |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before the dump | present | 1 | 1 / 1 | 1 | 1 | 6 | 1 | A | `vision-a-8b` | 8192 | 50 | 0 | agrees | — | 1 | 117 | 0 |
| after 118 + the operator's work | **absent** | — | 0 / 0 | 0 | 0 | 0 | 2 | **B** | **`vision-b-8b`** | **12288** | **25** | **1** | agrees | `diagram.png` | — | **118** | **1** |
| **arm A** — restore only (no steps 3/5) | present | 1 | 1 / 1 | 1 | 1 | 6 | 2 | **A** | **`vision-a-8b`** | **8192** | **50** | **0** | agrees | **`chart.png`** | 0 | 117 | 0 |
| **arm B** — the documented §4 | present | 1 | 1 / 1 | 1 | 1 | 6 | 2 | **B** | **`vision-b-8b`** | **12288** | **25** | **1** | agrees | `diagram.png` | 0 | 117 | 0 |

**Arm A is the finding, and it reproduces.** The rollback of the legacy leg
took the replacement's configuration with it: the retained identity and the
vision assignment both back to provider A, the ceiling back to `8192`, the
batch size back to `50`, and the `image_analysis_last_run` row **deleted
outright** — it was written after the dump, and `admin_settings` is restored
wholesale. Both `page_image_analyses` rows survive (they are outside the dump
set), and the gate still **agrees** — against the OLD model. The sharpest
reading is *which* row is stale under D5's validity predicate: in arm A it is
**`chart.png`**, the newer work, which the next sweep would re-pend and the
worker re-analyze against `vision-a-8b`, one vision call each. In arm B it is
`diagram.png`, the row that was already stale before the rollback.

**Steps 3 and 5 cost the legacy rollback nothing.** Both arms restored the
table with its row **byte-identically** (`9001|confluence|diagram.png|
[0.1,0.2,0.3]|vision-a-8b`), the column, both indexes, the `image_embedding`
assignment, all six settings rows and the dump-time nine-member CHECK
(`… 'image_embedding', 'inline_completion', 'image_analysis'`).

**The CHECK really narrowed.** On the post-118 database,
`INSERT INTO llm_usecase_assignments (usecase) VALUES ('image_embedding')` →
`ERROR: new row for relation "llm_usecase_assignments" violates check
constraint "llm_usecase_assignments_usecase_check"`.

**Dump.** `pg_dump (PostgreSQL) 18.6`, four tables, `--clean --if-exists`,
**436 lines**, `sha256 18956216245dc0edeb109b1fe39db3610a444f5c7b5bc71d09801e3645c7547f`
— **one artifact feeding both arms**, so neither the start state nor the dump
is a variable. Verified by §1.3's replay into a scratch database:
`restored_leg_rows = 1`, with **exactly the two expected foreign-key errors**
(`public.llm_providers`, `public.pages`) and no others.

**Step 3's capture, as it came out.** Five statements — four `image_analysis_*`
settings rows and the `image_analysis` assignment — produced by running the
block **verbatim** in a session with
`PGOPTIONS='-c default_transaction_read_only=on'`: the capture is a `SELECT`
and cannot write. Replayed by step 5 and then replayed a **second** time: the
rows are unchanged, so it is idempotent.

**The capture is injection-proof, and correct for a NULL model.** Re-proved on
this revision rather than carried over. Three hostile values were written as an
admin — `'); DROP TABLE page_image_analyses; SELECT 'x`, a value carrying a
backslash, a doubled quote, a real newline and `; DELETE FROM pages;`, and
`$$ nested dollar $$ and %L %s` — then captured, the rows wiped, and the
capture replayed twice. All three compare **byte-identical** to the originals
(md5 `80b5a9be…` before and after), `page_image_analyses` is intact, and
`format(…%L…)` switched to `E'…'` for the backslash value. An assignment with a
NULL model replays as SQL `NULL`, never `'NULL'`, and its `provider_id` comes
back. That run also demonstrates §4's `wc -l` note: the capture read **5 lines
for 4 statements**, because one setting value contained a newline.

**Step 6's `DELETE`** reported `DELETE 0` in both arms, confirming §4's note
that step 4 had already rewound `_migrations` past the migration — measured
here as `_migrations` going 118 → **117** with **zero** `118%` rows in both
arms.

**The documented loss, observed.** `dirty_pages = 0` after the restore in both
arms, against 1 before the dump. `pages.image_embedding_dirty` is not in the
dump set, so it returns at its `DEFAULT FALSE` and the corpus must be re-marked
(§3).

**What stage 2 still cannot exercise:** §4 step 1's replica stop and §7's
"start the pre-stage-2 release", because no backend was attached to the
disposable databases and the rehearsal restored into the pre-stage-2 schema the
template holds — which is what §1.3 and §4.1's SQL verify. A real upgraded
deployment is the only place those two are provable, and the Docker smoke on
this release covers the forward direction (a fresh database migrating clean to
118) rather than the rollback.

**Re-driven independently before the PR was opened (2026-09-17, second
operator, same revision).** A fresh template at migrations **001–117**
(118 withheld, so the template is the pre-stage-2 schema), a different fixture
— two pages, one `image_embedding_dirty`, one `page_image_embeddings` row at
the migration's declared `vector(2048)`, two `analyzed` `page_image_analyses`
rows — and its own dump artifact (**427 lines**,
`sha256 0f6013597a86c123e91d6af2c9ad774b6fd5dbc25415f32922c714c9fb43f56d`),
one artifact feeding both arms. Every result above reproduced: **arm A rewound**
the retained identity, the vision assignment (`provider-B-vision` →
`provider-A-vision`), the ceiling (`16384` → `8192`) and the batch size
(`120` → `50`), and **deleted** `image_analysis_last_run`, leaving
**`chart.png`** — the newer work — stale under D5, while **arm B preserved all
five** and leaves `diagram.png` stale. The legacy leg came back identical in
both arms (row md5 `435bb9af…` on both sides, both indexes, six settings rows,
the nine-member CHECK, the `image_embedding` assignment), `_migrations` went
**118 → 117** with **0** `118%` rows, step 6 reported `DELETE 0` in both arms,
and `dirty_pages` was **0** after the restore against **1** before the dump.
The capture ran verbatim under `PGOPTIONS='-c default_transaction_read_only=on'`
(5 lines, 5 statements), was byte-identical on a second read, and was
re-proved injection-proof on this revision: three hostile values — a
`'); DROP TABLE pages; --`, one carrying a real newline and a doubled quote,
and one carrying a backslash — round-trip **byte-identical** (md5
`9049c8da…` before and after) with `pages` and `page_image_analyses` intact
and `format(…%L…)` switching to `E'…'`; a NULL model replays as SQL `NULL`.
The driver and its databases were deleted with the container.

---

## 5.1 Exercise record — 2026-09-16, stage 1 (the held migration)

Rehearsed on disposable databases, never on real data, by driving the commands
of §1, §4 and §4.1 in order from a throwaway script (deleted with the
databases — nothing about the rehearsal is shipped except this record).

The first rehearsal restored a table nobody had touched since the dump, so its
"analysis settings 2 → 2 → 2" column could not tell **preserved** from
**restored wholesale, unmodified** — which is exactly how §4.1 came to claim
that the `image_analysis_*` rows survive a rollback by themselves (review
round 1, finding #1). This record is the re-run that can tell them apart: the
replacement's configuration is CHANGED after the dump, and the same rollback
is driven **twice**, once without §4 steps 3 and 5 and once with them.

**Environment.** `pgvector/pgvector:pg17`, container `fix1632-pg`, server and
client both **PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2)**. A template
database with migrations 001–116 applied by the release's own runner
(`migrations_applied = 116`, newest `116_image_analysis_index.sql`) and both
arms created from it with `CREATE DATABASE … TEMPLATE`, so the two runs start
byte-identical and the procedure is the only difference.

**Fixture (the state at dump time).** One page carrying
`image_embedding_dirty`, one `page_image_embeddings` row (`vector(3)`, with an
HNSW index built as the probe builds it), the `image_embedding` assignment, the
six settings rows the migration deletes — and the replacement configured
against **provider A / `vision-a-8b`**: its retained identity, the ceiling at
`8192`, the batch size at `50`, no `image_analysis_last_run` row yet, and one
`analyzed` `page_image_analyses` row written under identity A.

**What the operator does after the dump** (and after 118 is applied): re-assigns
the vision use case to **provider B / `vision-b-8b`** and adopts its identity,
raises the ceiling to `12288`, lowers the batch size to `25`, the worker records
a `image_analysis_last_run` line, and a second image is analyzed under
identity B.

| stage | leg table | dirty col/idx | hnsw | leg assignment | leg settings | analyses | retained | assigned | ceiling | batch | last-run row | gate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before the dump | present | 1 / 1 | 1 | 1 | 6 | 1 | A | A | 8192 | 50 | 0 | `gate_open` |
| after 118 + the operator's work | **absent** | 0 / 0 | 0 | 0 | 0 | **2** | **B** | **B** | **12288** | **25** | **1** | `gate_open` |
| **arm A** — restore only (no steps 3/5) | present | 1 / 1 | 1 | 1 | 6 | 2 | **A** | **A** | **8192** | **50** | **0** | `gate_open` |
| **arm B** — the procedure above | present | 1 / 1 | 1 | 1 | 6 | 2 | **B** | **B** | **12288** | **25** | **1** | `gate_open` |

**Arm A is the finding, measured.** The rollback of the legacy leg took the
replacement's configuration with it: the retained identity and the vision
assignment both back to provider A, the ceiling back to `8192`, the batch size
back to `50`, and the `image_analysis_last_run` row **deleted outright** —
it was written after the dump, and `admin_settings` is restored wholesale.
Both `page_image_analyses` rows survive (they are outside the dump set), and
the gate still reads `gate_open` — against the OLD model. The sharpest reading
is *which* row is stale under D5's validity predicate:

| after the restore | the stale analyzed row |
|---|---|
| arm A | **`chart.png` (written under `vision-b-8b`)** — the newer work is now invalid, and the next batch would re-analyze it against `vision-a-8b`, one vision call each |
| arm B | `diagram.png` (written under `vision-a-8b`) — the row that was already stale before the rollback; nothing the rollback did changed the replacement's state |

That is the difference the first rehearsal could not see. Nothing about the
legacy leg differs between the arms: both restored the table with its row
(`page_id 9001, local, diagram.png, [0.1,0.2,0.3]`), the column, both indexes,
the `image_embedding` assignment, all six settings rows and the dump-time CHECK
list (`… 'image_embedding', 'inline_completion', 'image_analysis'`) — so §4
steps 3 and 5 cost nothing the rollback needed.

**Dump.** `pg_dump (PostgreSQL) 17.11`, four tables, `--clean --if-exists`,
434 lines, arm B's artifact
`sha256 1598e1f0c860c0e7e82572581bc8d19d94dd581a5ea3c024c12169fa005c6d94`
(arm A's is a second dump of its own database, so its hash differs in the
`updated_at` and `applied_at` columns alone). Verified by replay into a scratch
database: `restored_leg_rows = 1`, with exactly the two expected foreign-key
errors of §1.3 (`public.llm_providers`, `public.pages`).

**The CHECK, after 118.** `INSERT … VALUES ('image_embedding')` →
`ERROR: new row for relation "llm_usecase_assignments" violates check
constraint "llm_usecase_assignments_usecase_check"`.

**Step 3's capture, as it came out.** Five statements: four `image_analysis_*`
settings rows and the `image_analysis` assignment, each an `INSERT … ON
CONFLICT DO UPDATE`, replayed by step 5 as `INSERT 0 1` five times. The
capture is read-only and the reapply is idempotent — running it twice leaves
the same five rows.

**Step 6's `DELETE`** reported `DELETE 0` in both arms, confirming §4's note
that step 4 had already rewound `_migrations` past the migration.

**The documented loss, observed.** `dirty_pages = 0` after the restore in both
arms, against 1 before the dump. `pages.image_embedding_dirty` is not in the
dump set, so it returns at its default and the corpus must be re-marked (§3).

**Total elapsed:** under 2 s per arm on a laptop-scale fixture — not a timing
estimate for a real corpus, where the dump dominates and scales with
`page_image_embeddings`.

**No prerequisite was skipped.** Every step of §1, §4 and §4.1's SQL checks ran
in both arms. Two things stage 1 cannot exercise: §2's "start the pre-stage-2
release", because there is no post-stage-2 release yet (the rehearsal restored
into the same pre-stage-2 schema, which is what §1.3 and §4.1 verify), and §4
step 1's replica stop, because no backend was attached to the disposable
databases. #1619 exercises the version boundary against a real upgraded
deployment. One read-only helper function (`probe_leg_rows()`) existed in the
rehearsal databases to count rows of a table that is dropped mid-procedure; a
table-scoped `pg_dump -t` set never carries a function, so it is not in the
artifact.

---

## 6. Non-goals

- A permanent dual-mode or in-product rollback switch (ADR-027 `:5299`).
- Decoding legacy VL vectors into descriptions, or carrying an ADR-025
  checkpoint over as a generative vision assignment. The replacement requires an
  explicit vision assignment and produces text, not vectors.
- Removing original page content or attachment bytes, ever.

## Related

- `backend/src/core/db/migrations/118_retire_image_embedding_space.sql` and its
  migration test — the applied migration.
- `docs/runbooks/image-analysis.md` — the replacement's own runbook (the
  `image_analysis` use case, its worker, its card and the answer path).
- `docs/ARCHITECTURE-DECISIONS.md`, ADR-027 "Retirement plan" — the two halves,
  the gate and the recovery boundary.
