# Held migrations

SQL that is **written, reviewed and deliberately not applied**. Nothing in this
directory ever runs by itself.

## Why this directory exists

`backend/src/core/db/postgres.ts` reads *every* `*.sql` file in
`backend/src/core/db/migrations/` and applies the ones missing from
`_migrations`, on every boot. A staged migration parked there therefore executes
on the next boot of any environment that pulls `dev` — including every
developer's test database and every CI job — long before the decision that was
supposed to gate it. A different extension would be filtered out, but the file
would still sit in the runner's own directory inviting a rename.

So a migration whose merge is gated on a decision that has not been taken lives
here, as reviewable text, until the gate opens.

## Contents

| File | Issue | Gate |
|---|---|---|
| `118_retire_image_embedding_space.sql` | #1618 stage 2 | #1619 publishes a **passing** verdict **and** the owner records an explicit go (ADR-027 D16, O14; issue #1618 "Native tracking") |

## Applying `118_retire_image_embedding_space.sql`

Stage 2's PR does this; stage 1 (this file's PR) does not.

1. **Re-derive the number.** `ls backend/src/core/db/migrations/` and take the
   next free one. As of 2026-09-16, **117 is taken by #1617's partial GIN index
   on `page_embeddings.chunk_tsv` (PR #1631)**; re-derive at stage-2 time
   anyway, because the runner sorts by filename and a gap is harmless but a
   collision is not. Rename the copy accordingly.
2. `cp docs/held-migrations/118_retire_image_embedding_space.sql
   backend/src/core/db/migrations/<n>_retire_image_embedding_space.sql`
   and delete it from here — it stops being held the moment it is applied.
3. Land it **in the same PR** as the code removals ADR-027 `:5271-5292`
   enumerates. Step 1 without the code is what breaks the suite hardest:
   `backend/src/test-db-helper.ts` re-types and `TRUNCATE`s
   `page_image_embeddings` for **every** DB-backed suite, so a dropped table
   fails the whole backend integration run at setup, on every branch.
4. Add `backend/src/core/db/migrations/__tests__/<n>_retire_image_embedding_space.test.ts`:
   the table and column are gone, the CHECK refuses `image_embedding` and still
   admits the other eight, the assignment row and the six settings rows are
   gone, and `page_image_analyses` is untouched.
5. Link #1619's verdict and #1614's fresh legacy baseline in the PR body, per
   issue #1618 AC 4.

## Before it runs anywhere that matters

`docs/runbooks/image-embedding-retirement.md` is the recovery procedure and the
destructive-boundary checklist: dump taken → dump verified restorable → #1619
verdict linked → owner go recorded → migration applied. It was exercised on a
disposable database in stage 1 and #1619 re-exercises it before authorisation
(ADR-027 `:5294-5299`).
