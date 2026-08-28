# Page-icon audit ordering fix report

Starting point: required HEAD `5fe157f58f11c944e1d12ba546a8d155625d394c` was verified before edits. No push or remote action was performed.

## Correction

The page-icon PATCH and image POST mutation callbacks now contain only the filesystem mutation and the related `pages.icon_kind` / `pages.icon_value` update through the barrier-owning `PoolClient`. Cache invalidation and `PAGE_UPDATED` audit logging run only after `withLocalAttachmentMutationLock` has returned, so the barrier client and shared snapshot lock have been released before `logAuditEvent` checks out from the global PostgreSQL pool.

Mutation failures still leave post-mutation work unreachable, so failed filesystem or row mutations do not emit an audit event. The existing best-effort `logAuditEvent` contract remains unchanged: audit query failures are swallowed by the audit service and cannot roll back the already-committed icon mutation.

## Strict TDD evidence

The regression models `PG_POOL_MAX=1`: the barrier callback occupies the sole client, while the audit mock performs a best-effort global checkout. It covers both image upload/replace (`POST /pages/:id/icon-image`) and deletion (`PATCH /pages/:id/icon` with `icon: null`), and requires the observed order to be filesystem mutation, `pages` update, barrier release, cache invalidation, then audit checkout/query. Separate cases assert both routes emit no audit when their filesystem mutation fails.

**RED:**

```text
npm test -w backend -- src/routes/knowledge/pages-icon.test.ts
Test Files 1 failed (1)
Tests 2 failed, 9 passed
- upload/replace audited while the one barrier client was still checked out, dropping the audit as pool-saturated
- delete audited while the one barrier client was still checked out, dropping the audit as pool-saturated
```

**GREEN:** the same command passed `1` file and `11` tests.

## Final focused evidence

```text
npm test -w backend -- \
  src/routes/knowledge/pages-icon.test.ts \
  src/core/services/attachment-snapshot-lock.test.ts \
  src/core/services/attachment-snapshot-lock.error.test.ts
Test Files 3 passed (3)
Tests 25 passed (25)
```

`attachment-snapshot-lock.test.ts` includes the direct page-icon-store deletion/barrier coverage; there is no separate `page-icon-store.test.ts` in this worktree.

```text
cd backend
npx eslint src/routes/knowledge/pages-icon.ts src/routes/knowledge/pages-icon.test.ts
exit 0
```

```text
npm run typecheck -w backend
tsc --noEmit && tsc --noEmit -p tsconfig.scripts.json
exit 0
```

## Concerns

No remaining implementation concern was observed in this bounded correction.
