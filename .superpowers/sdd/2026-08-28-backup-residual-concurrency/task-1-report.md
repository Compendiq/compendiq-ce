# Task 1 Report — Coordinate Attachment Mutation and Backup Snapshot

## Status

Complete. Implementation and regression tests are committed locally.

## Commit

- `c2acfe9d184a8a629ad6eaa6131072772d1a6c5a` — `fix(backup): coordinate attachment snapshots`

## RED

Focused command used throughout:

```bash
cd backend && npx vitest run src/core/services/attachment-snapshot-lock.test.ts src/core/services/local-attachment-service.test.ts src/core/services/backup-service.test.ts
```

Initial RED after all requested regression tests were added, before implementation:

- Exit code: `1`
- Test files: `3 failed (3)`
- Failed suites: `1` — the new lock helper module did not yet exist
- Failed tests: `8`
  - backup snapshot did not expose/acquire the exclusive barrier
  - snapshot close rejection skipped `releaseWorkerLock`
  - same-name overwrite completed before archive-byte capture
  - same-client SQL contract was absent
  - relocate write/remove, sweep removal, and directory removal did not wait behind the exclusive snapshot

A self-review extension made the image-dirty UPDATE part of the same-client contract. Its RED was also observed before that implementation:

- Exit code: `1`
- Test files: `1 failed | 2 passed (3)`
- Failed tests: `1`
- Exact failure: `expected false to be true` for `pages.image_embedding_dirty`, because the UPDATE used a separate pooled client rather than the shared-lock-owning client.

## GREEN

Final focused run:

- Exit code: `0`
- Test files: `3 passed (3)`
- Tests: `33 passed (33)`
- Duration: `1.26s`

`git diff --check` also exited `0` before commit.

## Implementation

- Added `ATTACHMENT_SNAPSHOT_LOCK_ID = 1_420_001`.
- Added `withLocalAttachmentMutationLock`, using a dedicated `PoolClient`, timeout-free shared-lock waiting, and nested unlock/reset/release cleanup.
- Routed `putLocalAttachment`, relocate write/remove, sweep removal, and directory removal through the shared barrier.
- Routed the local-attachment upsert, access check, and image-dirty UPDATE through the lock-owning client. `image-embedding-dirty.ts` gained an optional query client so existing callers retain their behavior while this mutation avoids a second pool checkout.
- Changed exported backup snapshots to expose their dedicated client and `snapshotId`, acquire the exclusive session lock before `BEGIN`, and release transaction, advisory lock, timeout override, and client in order.
- Made Redis backup-lock release the outermost unconditional cleanup step, including when snapshot close rejects.
- Added real PostgreSQL contention tests tied to the specific blocking backend PID, preventing cross-file advisory-lock activity from producing false positives.

## Self-review

- Confirmed the exclusive lock is acquired before repeatable-read snapshot creation and remains owned by the exported-snapshot client until close.
- Confirmed mutation callbacks receive and use the shared-lock-owning client for file-adjacent SQL.
- Confirmed every authoritative mutation named in the brief is covered by runtime waiting assertions.
- Confirmed the overwrite test observes old archived bytes while blocked, then new filesystem bytes and matching database SHA after release.
- Confirmed cleanup nesting attempts later steps after earlier failures and returns/discards pool clients with session timeout restored.
- Confirmed reads remain outside the barrier and existing stream/snapshot tests remain green.

## Concerns

- No known implementation concerns.
- Per assignment, validation was limited to the focused Vitest command; no project-wide typecheck, lint, build, or broader test suite was run.

---

## Residual Fix — Round 1/5

### Status

Complete. Residual caller-level barrier gaps are fixed and committed locally.

### Commit

- `3d07cfe4bf02a047e3d2016e47389da1fc8845aa` — `fix(backup): close residual attachment barrier gaps`

### RED

The first focused caller run exited `1` with five failing files and eight
failures. It showed the sweep filesystem delete running outside the barrier,
hard delete and retention cleanup receiving no barrier-owning client, relocate
cleanup lock acquisition escaping the best-effort contract, and both relocation
directions exposing their split filesystem/database window.

After correcting the deterministic row-block signal in the relocation
concurrency harness, mutation verification explicitly released the shared
advisory lock at the two old boundaries. The two focused relocation tests both
failed with `expected true to be false`: an exclusive snapshot session acquired
between staging and commit, and again between commit and source-directory
cleanup.

### GREEN

Final affected caller suites:

```bash
cd backend
npx vitest run --maxWorkers=1 --no-file-parallelism \
  src/core/services/attachment-snapshot-lock.test.ts \
  src/core/services/local-attachment-service.test.ts \
  src/routes/knowledge/pages-relocate.integration.test.ts \
  src/domains/confluence/services/attachment-sweep-service.dirty-contract.test.ts \
  src/routes/knowledge/pages-crud-hard-delete-attachments.test.ts \
  src/routes/knowledge/pages-crud-delete-atomicity.integration.test.ts \
  src/core/services/data-retention-service.test.ts \
  src/core/services/data-retention-service.integration.test.ts \
  src/core/services/standalone-attachment-cleanup.integration.test.ts
```

- Exit code: `0`
- Test files: `9 passed (9)`
- Tests: `128 passed (128)`
- Duration: `8.27s`

Sweep orchestration companions:

```bash
npx vitest run --maxWorkers=1 --no-file-parallelism \
  src/domains/confluence/services/attachment-sweep-service.test.ts \
  src/domains/confluence/services/attachment-sweep-service.lock-order.test.ts
```

- Exit code: `0`
- Test files: `2 passed (2)`
- Tests: `30 passed (30)`

The final deterministic relocation contention subset also passed: `2 passed`,
`44 skipped`. `git diff --check` exited `0`.

### Fixes

- Added already-locked `PoolClient` reuse to
  `withLocalAttachmentMutationLock`, preventing nested mutation helpers from
  taking a second session/lock.
- Kept Confluence-to-local staging, metadata transaction, compensation, and
  cleanup on one shared-lock client.
- Kept local-to-Confluence database mutation and post-commit source-directory
  cleanup under the same shared barrier; removed the private direct `fs.rm`
  cleanup path.
- Wrapped sweep deletion, `page_image_embeddings` pruning, and page dirty
  marking in one callback and routed every related query through its client.
- Made relocate unwind cleanup catch connection/acquire/unlock/reset failures,
  preserving the original relocation error.
- Kept permanent standalone page DELETE and retention-purge DELETE operations
  behind the shared barrier until all related attachment directories have been
  cleaned.
- Added real PostgreSQL contention tests for both relocation directions, hard
  delete, and retention purge, plus runtime same-callback/client assertions for
  sweep SQL and error-path coverage for best-effort cleanup.

### Concerns

- No known implementation concerns.
- The full `attachment-sweep-service.integration.test.ts` file was not used as
  completion evidence because its module-level Redis client retries
  indefinitely when the expected Redis test service is unavailable. The
  affected sweep mutation contract and orchestration suites above passed.
- Per assignment, no project-wide typecheck, lint, build, or full test suite was
  run.

---

## Residual Fix — Round 2/5

### Status

Complete. The remaining relocation client-reuse and post-commit compensation
hazards are fixed and committed locally.

### Commit

- `85d9297390786926f5b1fa225db72a69b8921b45` — `fix(backup): harden relocation barrier cleanup`

### RED

Caller-level relocation command before the implementation change:

```bash
cd backend
npx vitest run --maxWorkers=1 --no-file-parallelism \
  src/routes/knowledge/pages-relocate.integration.test.ts
```

- Exit code: `1`
- Test files: `1 failed (1)`
- Tests: `3 failed | 46 passed (49)`
- Duration: `3.67s`
- Both injected cleanup cases failed because `deletePage('900100')` ran once
  after the local transaction had committed: one case rejected
  `pg_advisory_unlock_shared`, and the other rejected
  `RESET statement_timeout`.
- The saturated-pool case failed with
  `expected 'second-checkout' to be 'completed'`, proving the two initial
  identifier checks attempted a pooled query while the shared-lock client was
  already held.

### GREEN

Final focused relocation/barrier command:

```bash
cd backend
npx vitest run --maxWorkers=1 --no-file-parallelism \
  src/core/services/attachment-snapshot-lock.test.ts \
  src/routes/knowledge/pages-relocate.integration.test.ts
```

- Exit code: `0`
- Test files: `2 passed (2)`
- Tests: `51 passed (51)`
- Duration: `4.20s`
- `git diff --check` exited `0` before the implementation commit.

### Fixes

- Passed the shared-lock-owning `PoolClient` into both Confluence-to-local
  identifier prechecks, keeping their SQL off the general pool.
- Added a caller-level real PostgreSQL saturation seam that fills every
  remaining main-pool slot while the mutation client owns the shared barrier;
  relocation completes without a second checkout or pooled query.
- Recorded the successful local-to-Confluence commit boundary before barrier
  teardown. Unlock or timeout-reset failures still surface, but can no longer
  delete the upstream page or its new attachment cache after the local row
  commits its `confluence_id`.
- Added caller-level injected failures for both advisory unlock and
  statement-timeout reset, asserting the committed row continues to point at
  the upstream page and destructive compensation is not invoked.

### Concerns

- No known implementation concerns.
- Per assignment, validation was limited to the focused relocation and
  attachment-barrier suites; no project-wide typecheck, lint, build, or full
  test suite was run.
