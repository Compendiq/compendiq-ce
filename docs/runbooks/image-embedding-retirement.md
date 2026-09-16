# Runbook — retiring the legacy image embedding space

**Audience:** the operator who applies ADR-027's stage-2 migration, and the one
who has to undo it.

**Status:** the migration described here is **held, not merged**. Its text lives
in `docs/held-migrations/118_retire_image_embedding_space.sql`; the README beside
it explains why it is not in `backend/src/core/db/migrations/` and how stage 2
copies it there. Stage 1 (#1618's preparation half) ships this procedure and
exercises it on disposable data; #1619 re-exercises it before authorisation
(ADR-027 `:5294-5299`).

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
- [ ] **#1619 verdict linked** — a **passing** pre-registered quality/safety/cost
      verdict, plus #1614's fresh legacy baseline (issue #1618 AC 4). Failed or
      inconclusive stops the cutover.
- [ ] **Owner go recorded** — an explicit decision, in writing, on the issue
      (ADR-027 D16 `:4556-4561`, O14 `:5249`).
- [ ] **Migration applied**, together with the stage-2 code removals in the same
      release.

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
chat attachment, ADR-027 D11).

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
also what makes §3's data-loss statement true.

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

The dump restores only into a deployment of the **pre-stage-2 release**. Record
the exact image tag or commit before the upgrade:

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
  wholesale, not merged.

Nothing here loses original page content or attachment bytes.

---

## 4. Restore, in order

```bash
# 1. Stop every backend replica. A running replica writes to the tables being
#    replaced, and one booting mid-restore re-applies migrations over the top.
docker compose -f docker/docker-compose.yml stop backend

# 2. Re-add the column the dump set cannot carry (migration 093's own text).
#    Migration 093 is still listed in _migrations, so the pre-stage-2 release
#    will NOT re-add it on boot.
psql --dbname="$POSTGRES_URL" <<'SQL'
ALTER TABLE pages ADD COLUMN IF NOT EXISTS image_embedding_dirty BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS pages_image_embedding_dirty_idx ON pages (id) WHERE image_embedding_dirty;
SQL

# 3. Restore the dump. Drops and recreates the four tables (see §3).
psql --dbname="$POSTGRES_URL" -f image-leg-rollback.sql

# 4. Make sure the migration is not recorded as applied. Usually already true:
#    _migrations is in the dump, so step 3 rewound it past the migration. Run it
#    anyway — a partial restore, or a dump set without _migrations, needs it.
psql --dbname="$POSTGRES_URL" \
  -c "DELETE FROM _migrations WHERE name LIKE '%retire_image_embedding_space.sql'"

# 5. Start the PRE-STAGE-2 release (§2's recorded tag), not the current one.
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

Finally, confirm the replacement is intact: `page_image_analyses` and every
`admin_settings.image_analysis_*` row are outside the dump set and outside the
migration, so a rollback must leave them exactly as they were.

---

## 5. Exercise record — 2026-09-16, stage 1

Rehearsed on a disposable database, not on any real data, by driving the
commands of §1, §4 and §4.1 in order from a throwaway script (deleted with the
database — nothing about the rehearsal is shipped except this record). Results
in condensed form:

**Environment.** `pgvector/pgvector:pg17`, container `impl1618-pg`, server and
client both **PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2)**, disposable database
`retire_rehearsal`, migrations 001–116 applied (`migrations_applied = 116`).

**Fixture.** One page carrying `image_embedding_dirty`, one
`page_image_embeddings` row (`vector(3)`, with an HNSW index built as the probe
builds it), an `image_embedding` assignment row, the six settings rows, and one
`analyzed` `page_image_analyses` row that must survive untouched.

| stage | leg&nbsp;table | dirty col | dirty idx | hnsw idx | assignment | settings | analysis rows | analysis settings |
|---|---|---|---|---|---|---|---|---|
| before the dump | present | 1 | 1 | 1 | 1 | 6 | 1 | 2 |
| after 118 | **absent** | 0 | 0 | 0 | 0 | 0 | **1** | **2** |
| after the restore | present | 1 | 1 | 1 | 1 | 6 | 1 | 2 |

**Dump.** `pg_dump (PostgreSQL) 17.11`, four tables, `--clean --if-exists`,
433 lines,
`sha256 df2a274f3a02134f261c58bd9f3609c256bcd67ddb9245beaa889a29b6549a05`.
Verified by replay into a scratch database: `restored_leg_rows = 1`, with the
two expected foreign-key errors of §1.3.

**The CHECK, after 118.** `INSERT … VALUES ('image_embedding')` →
`ERROR: new row for relation "llm_usecase_assignments" violates check
constraint "llm_usecase_assignments_usecase_check"`. The other eight members
all insert (`admitted = 8`).

**The restore.** The embedding row came back byte-identical
(`page_id 1, local, diagram.png, [0.1,0.2,0.3]`), all six settings keys are
back, the `image_embedding` assignment is back with its model, and
`_migrations` carries no `118%` row. Step 4's `DELETE` reported `DELETE 0`,
confirming §4's note that step 3 had already rewound the table past it. Step 2's
`CREATE INDEX` and the manual HNSW rebuild both reported `already exists,
skipping` — the dump carried both indexes.

**The documented loss, observed.** `dirty_pages = 0` after the restore, against
1 before the dump. `pages.image_embedding_dirty` is not in the dump set, so it
returns at its default and the corpus must be re-marked (§3).

**Total elapsed:** 21 s for the whole cycle on a laptop-scale fixture — not a
timing estimate for a real corpus, where the dump dominates and scales with
`page_image_embeddings`.

**No prerequisite was skipped.** Every step of §1, §4 and §4.1's SQL checks ran;
the one item that cannot be exercised in stage 1 is §2's "start the pre-stage-2
release", because there is no post-stage-2 release yet — the rehearsal restored
into the same (pre-stage-2) schema, which is what §1.3 and §4.1 verify. #1619
exercises the version boundary against a real upgraded deployment.

---

## 6. Non-goals

- A permanent dual-mode or in-product rollback switch (ADR-027 `:5299`).
- Decoding legacy VL vectors into descriptions, or carrying an ADR-025
  checkpoint over as a generative vision assignment. The replacement requires an
  explicit vision assignment and produces text, not vectors.
- Removing original page content or attachment bytes, ever.

## Related

- `docs/held-migrations/README.md` — the held migration and how stage 2 applies it.
- `docs/runbooks/image-index.md` — the legacy leg's own runbook, including §5b on
  the image-analysis worker.
- `docs/ARCHITECTURE-DECISIONS.md`, ADR-027 "Retirement plan" — the two halves,
  the gate and the recovery boundary.
