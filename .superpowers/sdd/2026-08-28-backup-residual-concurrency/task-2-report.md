# Task 2 report — serialize same-page Notion imports

## Status

Complete. Same normalized Notion page IDs now serialize on a dedicated PostgreSQL session advisory-lock client; different IDs remain independent. A waiter re-reads the imported page after acquiring the lock and reuses a completed winner. Cleanup is creator-owned and re-checks that the creator's exact placeholder is still incomplete before deletion.

## TDD evidence

### RED — behavior-level failures

Command (exit 1):

```bash
cd backend && npx vitest run src/domains/knowledge/services/notion-import-lock.test.ts src/domains/knowledge/services/notion-import-service.test.ts
```

Observed after the wished-for API existed with no normalization or serialization:

```text
src/domains/knowledge/services/notion-import-lock.test.ts (3 tests | 2 failed)
  × maps dashed, undashed, and differently-cased forms of one Notion page ID to the same key
    expected 36 to be 32
  × serializes operations for normalized forms of the same page ID
    expected true to be false
src/domains/knowledge/services/notion-import-service.test.ts (21 tests | 1 failed)
  × keeps the winner page and files when a same-page waiter has a media failure
    expected false to be true
Test Files  2 failed (2)
```

The different-ID independence test passed in this RED run, while normalized-key equality, same-ID serialization, and the two-import waiter behavior each failed for their intended missing behavior.

An earlier API-first RED run also exited 1 with both suites failing to load because `notion-import-lock.ts` did not yet exist; production behavior was not implemented before the behavior-level RED run above.

### GREEN — focused verification

Fresh command after implementation and cleanup (exit 0):

```bash
cd backend && npx vitest run src/domains/knowledge/services/notion-import-lock.test.ts src/domains/knowledge/services/notion-import-service.test.ts
```

Exact result:

```text
Test Files  2 passed (2)
Tests       24 passed (24)
Duration    2.01s
```

The emitted Notion 500/404 and attachment-download warning logs are exercised error-path fixtures in the passing import-service suite; there were no failed tests.

## Behavioral coverage

- Dashed, undashed, and differently-cased forms of one Notion page ID produce one lock ID.
- Two different page IDs enter independently while one operation remains held.
- Normalized forms of the same page ID serialize.
- The two-import test observes the waiter as an ungranted PostgreSQL advisory lock before releasing the winner.
- The winner writes an attachment while held; the waiter has a distinct injected missing-media response.
- After release, the winner reports `success`, the waiter reports `already_imported` with the winner's local page ID, exactly one page remains, its HTML references the attachment, one `local_attachments` row remains, and the on-disk bytes equal the fixture PNG.

## Implementation

- Added `NOTION_IMPORT_LOCK_KEY = 1_420_002`.
- Added a normalized SHA-256-derived signed 32-bit second key.
- Added timeout-free session `pg_advisory_lock($1, $2)` acquisition/release on a dedicated pool client, restoring session timeouts before release.
- Added an authoritative `findImportedPage` re-read inside the page lock.
- Removed stale pre-lock placeholder deletion paths.
- Set `createdPlaceholder` only after this invocation successfully inserts its placeholder.
- On failure, deletion occurs only when a fresh lookup identifies that exact creator-owned page and it is still incomplete.

## Commit

```text
1ad379c0611e0ade4d7b05a921e7277d2030794c fix(notion): serialize page imports
```

The worktree was clean immediately after the implementation commit. Only the two requested focused test files were run.

## Concerns

None identified within Task 2 scope. The advisory lock deliberately disables both statement and lock timeouts on its dedicated waiting session, then restores them before returning the client to the pool; this favors correctness for a potentially long media import as required by the task ruling.
